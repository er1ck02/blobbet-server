// email-lookup — find public profiles associated with an email address.
//
// Zero external dependencies: runs on Node 18+ with `node server.js`.
//
// It aggregates ONLY sources that are public and consent-based:
//   1. Gravatar profile   — data the person explicitly published against their email hash.
//   2. GitHub email search — accounts whose owner made their commit email public.
//   3. Username candidates — profile handles derived from the email's local part,
//                            verified via each platform's public existence API.
//
// Username-derived hits are clearly marked as unverified: a matching handle does
// not prove it is the same person. Nothing here bypasses a login, a privacy
// setting, or a site's access controls.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const PORT = process.env.LOOKUP_PORT || 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const UA = 'email-lookup/1.0 (+https://github.com/)';

// Optional: raises GitHub's unauthenticated rate limit (60/hr) to 5000/hr and
// avoids datacenter-IP throttling. Set GITHUB_TOKEN to any personal access
// token with default (public, read-only) scope.
const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

// ---------- small helpers ----------
const md5 = (s) => createHash('md5').update(s).digest('hex');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function getJson(url, { timeout = 6000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return { ok: false, status: res.status };
    return { ok: true, status: res.status, body: await res.json() };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

// ---------- confirmed sources (tied to the email itself) ----------
async function gravatar(email) {
  const hash = md5(email.trim().toLowerCase());
  const r = await getJson(`https://en.gravatar.com/${hash}.json`);
  if (!r.ok || !r.body?.entry?.length) return null;
  const e = r.body.entry[0];
  return {
    displayName: e.displayName || e.preferredUsername || null,
    aboutMe: e.aboutMe || null,
    location: e.currentLocation || null,
    profileUrl: e.profileUrl || `https://gravatar.com/${hash}`,
    avatar: e.thumbnailUrl ? `${e.thumbnailUrl}?s=160` : null,
    accounts: (e.accounts || []).map((a) => ({
      platform: a.name || a.shortname || a.domain,
      url: a.url,
      username: a.username || null,
    })),
  };
}

async function githubByEmail(email) {
  const r = await getJson(
    `https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email`,
    { headers: GH_HEADERS }
  );
  const item = r.ok && r.body?.items?.[0];
  if (!item) return null;
  const d = await getJson(`https://api.github.com/users/${item.login}`, {
    headers: GH_HEADERS,
  });
  const u = d.ok ? d.body : {};
  return {
    login: item.login,
    url: item.html_url,
    avatar: item.avatar_url,
    name: u.name || null,
    company: u.company || null,
    blog: u.blog || null,
    location: u.location || null,
    bio: u.bio || null,
  };
}

// ---------- username candidates derived from the local part ----------
function candidates(email) {
  const local = email.split('@')[0].toLowerCase().split('+')[0];
  const set = new Set([local, local.replace(/[._-]/g, '')]);
  return [...set].filter((u) => /^[a-z0-9._-]{2,30}$/.test(u));
}

// Each checker resolves to true only for a clean, public "this handle exists" signal.
const PLATFORMS = [
  {
    name: 'GitHub',
    url: (u) => `https://github.com/${u}`,
    check: async (u) =>
      (await getJson(`https://api.github.com/users/${u}`, {
        headers: GH_HEADERS,
      })).ok,
  },
  {
    name: 'GitLab',
    url: (u) => `https://gitlab.com/${u}`,
    check: async (u) => {
      const r = await getJson(`https://gitlab.com/api/v4/users?username=${u}`);
      return r.ok && Array.isArray(r.body) && r.body.length > 0;
    },
  },
  {
    name: 'Reddit',
    url: (u) => `https://www.reddit.com/user/${u}`,
    check: async (u) =>
      (await getJson(`https://www.reddit.com/user/${u}/about.json`)).ok,
  },
  {
    name: 'Dev.to',
    url: (u) => `https://dev.to/${u}`,
    check: async (u) =>
      (await getJson(`https://dev.to/api/users/by_username?url=${u}`)).ok,
  },
  {
    name: 'npm',
    url: (u) => `https://www.npmjs.com/~${u}`,
    check: async (u) =>
      (await getJson(`https://registry.npmjs.org/-/user/org.couchdb.user:${u}`)).ok,
  },
  {
    name: 'Keybase',
    url: (u) => `https://keybase.io/${u}`,
    check: async (u) => {
      const r = await getJson(
        `https://keybase.io/_/api/1.0/user/lookup.json?username=${u}`
      );
      return r.ok && r.body?.status?.code === 0;
    },
  },
];

async function usernameHits(email) {
  const users = candidates(email);
  const jobs = [];
  for (const u of users) {
    for (const p of PLATFORMS) {
      jobs.push(
        p.check(u).then((exists) =>
          exists ? { platform: p.name, username: u, url: p.url(u) } : null
        )
      );
    }
  }
  return (await Promise.all(jobs)).filter(Boolean);
}

// ---------- lookup orchestration ----------
async function lookup(email) {
  const [grav, gh, handles] = await Promise.all([
    gravatar(email).catch(() => null),
    githubByEmail(email).catch(() => null),
    usernameHits(email).catch(() => []),
  ]);
  return {
    email,
    gravatar: grav,
    github: gh,
    usernameMatches: handles,
    checkedAt: new Date().toISOString(),
  };
}

// ---------- static file serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
async function serveStatic(req, res) {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  const full = normalize(join(PUBLIC_DIR, path));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(full);
    const ext = full.slice(full.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/lookup') {
    const email = (url.searchParams.get('email') || '').trim();
    if (!isEmail(email)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Provide a valid ?email=' }));
      return;
    }
    try {
      const result = await lookup(email);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Lookup failed', detail: String(err) }));
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () =>
  console.log(`email-lookup running at http://localhost:${PORT}`)
);

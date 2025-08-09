// server.js — BlobBet Modes v1.1 (Casual + Battle Royale) — Launch-ready polish
// Features:
// - Casual mode (always-on), Battle Royale (10 players, 3 min, shrink starts at 40s)
// - Even spawns for BR, fixed initial pellet layout (seeded) visible to everyone
// - 20 Hz snapshots, AOI culling, accurate ping echo, AFK warn/kick
// - Tab close = disconnect handled by Socket.IO
// - Leaderboard (top mass), minimap metadata, alive/required counts
// - Clean state transitions: BR waiting -> active -> waiting

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const PORT = process.env.PORT || 7777;

// --------- App ---------
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

// --------- World & Game Config ---------
const W = 3600, H = 3600;
const TICK = 1000/20;           // 20 Hz
const BASE_SPEED = 240;
const FRICTION = 0.90;
const START_MASS = 120;
const AOI_RADIUS = 1200;
const PELLET_COUNT = 700;
const BR_PLAYERS_REQUIRED = 10;
const BR_MATCH_SECONDS = 180;
const BR_SHRINK_START = 40;     // seconds after start
const BR_SAFE_MIN_R = 380;

// --------- Utils ---------
const now = () => Date.now();
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const rand = (a,b) => Math.random()*(b-a)+a;
const radius = (mass) => Math.sqrt(mass);

// Seeded RNG (xorshift-ish) for deterministic pellet layout
function makeRng(seed) {
  let s = 0;
  for (let i=0;i<seed.length;i++) s = (s*31 + seed.charCodeAt(i)) >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}
function genPellets(seed) {
  const rng = makeRng(seed);
  const arr = [];
  for (let i=0;i<PELLET_COUNT;i++) {
    arr.push({ id: `pe${i}`, x: Math.floor(rng()*(W-80)+40), y: Math.floor(rng()*(H-80)+40) });
  }
  return arr;
}
function evenSpawns(n) {
  const cx = W/2, cy = H/2, R = Math.min(W,H)/2 - 120;
  const pts = [];
  for (let i=0;i<n;i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.floor(cx + Math.cos(a)*R), y: Math.floor(cy + Math.sin(a)*R) });
  }
  return pts;
}

// --------- Rooms ---------
/*
Room: { id, mode: 'casual'|'br', state: 'active'|'waiting',
  players: Map<sid,Player>, pellets: Pellet[], seed,
  createdAt, startedAt, endsAt,
  safe: { cx, cy, r, startShrinkAt } }

Player: { id, name, x,y, vx,vy, mass, alive, lastInputAt, joinedAt }
*/
const rooms = new Map();

function makeCasualRoom() {
  const id = 'casual-1';
  const seed = id + '-seed';
  const room = {
    id, mode: 'casual', state: 'active',
    players: new Map(),
    pellets: genPellets(seed),
    seed,
    createdAt: now(), startedAt: now(), endsAt: 0,
    safe: { cx: W/2, cy: H/2, r: Math.min(W,H)/2, startShrinkAt: 0 }
  };
  rooms.set(id, room);
  return room;
}
function getCasualRoom() { return rooms.get('casual-1') || makeCasualRoom(); }

function makeBrRoom() {
  const id = `br-${Math.random().toString(36).slice(2,8)}`;
  const seed = id + '-seed';
  const room = {
    id, mode: 'br', state: 'waiting',
    players: new Map(),
    pellets: genPellets(seed),
    seed,
    createdAt: now(), startedAt: 0, endsAt: 0,
    safe: { cx: W/2, cy: H/2, r: Math.min(W,H)/2, startShrinkAt: 0 }
  };
  rooms.set(id, room);
  return room;
}
function getOrCreateWaitingBr() {
  for (const r of rooms.values()) {
    if (r.mode==='br' && r.state==='waiting') return r;
  }
  return makeBrRoom();
}

function kick(room, sid, reason='afk') {
  const p = room.players.get(sid);
  if (!p) return;
  room.players.delete(sid);
  io.to(sid).emit('kicked', { reason });
  io.sockets.sockets.get(sid)?.leave(room.id);
}

// --------- Socket.IO ---------
io.on('connection', (socket) => {
  let room = null;

  socket.on('join', ({ name, mode }) => {
    const m = (mode === 'br') ? 'br' : 'casual';
    room = (m === 'br') ? getOrCreateWaitingBr() : getCasualRoom();

    const p = {
      id: socket.id,
      name: (name || 'Blob').slice(0,12),
      x: Math.floor(rand(200, W-200)),
      y: Math.floor(rand(200, H-200)),
      vx:0, vy:0, mass: START_MASS,
      alive: true,
      lastInputAt: now(),
      joinedAt: now()
    };
    room.players.set(socket.id, p);
    socket.join(room.id);

    // If BR can start, initialize fair spawns
    if (room.mode==='br' && room.state==='waiting' && room.players.size >= 10) {
      room.state = 'active';
      room.startedAt = now();
      room.endsAt = room.startedAt + 1000*180;
      room.safe.r = Math.min(W,H)/2;
      room.safe.startShrinkAt = room.startedAt + 1000*40;
      const pts = evenSpawns(10);
      let i=0;
      for (const pp of room.players.values()) {
        const s = pts[i % pts.length];
        pp.x = s.x; pp.y = s.y; pp.vx=0; pp.vy=0; pp.mass = START_MASS; pp.alive = true;
        i++;
      }
    }
  });

  socket.on('input', (inp) => {
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    const vx = Number(inp.vx)||0, vy = Number(inp.vy)||0;
    const speed = (BASE_SPEED / Math.pow(p.mass/100, 0.25));
    p.vx = vx * speed;
    p.vy = vy * speed;
    p.lastInputAt = now();
    if (inp.t) socket.emit('pong2', { t: inp.t, server: now() });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(room.id);
  });
});

// --------- Game Loop ---------
setInterval(() => {
  for (const room of rooms.values()) {

    // BR timing & shrink
    if (room.mode==='br' && room.state==='active') {
      const t = now();
      if (t >= room.safe.startShrinkAt) {
        const total = (room.endsAt - room.safe.startShrinkAt) || 1;
        const p = Math.max(0, Math.min(1, (t - room.safe.startShrinkAt) / total));
        const maxR = Math.min(W,H)/2;
        room.safe.r = Math.max(BR_SAFE_MIN_R, maxR * (1 - 0.85*p));
      }
      const alive = [...room.players.values()].filter(pl=>pl.alive);
      if (alive.length <= 1 || t >= room.endsAt) {
        // Reset to waiting
        room.state = 'waiting';
        room.startedAt = 0;
        room.endsAt = 0;
        room.safe.r = Math.min(W,H)/2;
        for (const pl of room.players.values()) { pl.alive = true; pl.mass = START_MASS; }
      }
    }

    // Integrate physics
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      p.x += p.vx * (TICK/1000);
      p.y += p.vy * (TICK/1000);
      p.vx *= FRICTION; p.vy *= FRICTION;
      p.x = clamp(p.x, 10, W-10); p.y = clamp(p.y, 10, H-10);

      // BR safe circle
      if (room.mode==='br' && room.state==='active') {
        const dx = p.x - room.safe.cx, dy = p.y - room.safe.cy;
        if (dx*dx + dy*dy > room.safe.r*room.safe.r) {
          p.alive = false;
        }
      }
    }

    // Pellets: eat & refill
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      const rr = radius(p.mass);
      for (let i = room.pellets.length - 1; i >= 0; i--) {
        const pe = room.pellets[i];
        const dx = pe.x - p.x, dy = pe.y - p.y;
        if (dx*dx + dy*dy < (rr+6)*(rr+6)) {
          p.mass += 5;
          room.pellets.splice(i,1);
        }
      }
    }
    while (room.pellets.length < PELLET_COUNT) {
      room.pellets.push({ id: 'pe' + Math.random().toString(36).slice(2,8), x: Math.floor(rand(40, W-40)), y: Math.floor(rand(40, H-40)) });
    }

    // PvP eat
    const ids = Array.from(room.players.keys());
    for (let i=0;i<ids.length;i++) {
      const A = room.players.get(ids[i]); if (!A || !A.alive) continue;
      for (let j=i+1;j<ids.length;j++) {
        const B = room.players.get(ids[j]); if (!B || !B.alive) continue;
        if (A.mass === B.mass) continue;
        const big = A.mass > B.mass ? A : B;
        const small = A.mass > B.mass ? B : A;
        const rb = radius(big.mass), rs = radius(small.mass);
        const dx = small.x - big.x, dy = small.y - big.y;
        if (dx*dx + dy*dy < Math.pow(rb - rs*0.35, 2)) {
          big.mass += small.mass * 0.85;
          small.alive = false;
        }
      }
    }

    // AFK warn/kick
    const tnow = now();
    for (const [sid, p] of room.players) {
      if (!p.alive) continue;
      const idle = tnow - p.lastInputAt;
      if (idle > 15000 && idle < 18000) io.to(sid).emit('afk_warn', { seconds: Math.ceil((18000 - idle)/1000) });
      else if (idle >= 18000) kick(room, sid, 'afk');
    }

    // Leaderboard
    const board = [...room.players.values()].filter(pl=>pl.alive).sort((a,b)=>b.mass-a.mass).slice(0,5)
      .map(pl => ({ id: pl.id, name: pl.name, mass: Math.round(pl.mass) }));

    // Snapshots
    for (const [id, p] of room.players) {
      const you = p ? { id: p.id, name: p.name, x: p.x, y: p.y, mass: p.mass, r: radius(p.mass), alive: p.alive } : null;
      const nearbyPlayers = [];
      if (p) {
        for (const [oid, op] of room.players) {
          if (oid === id || !op.alive) continue;
          const dx = op.x - p.x, dy = op.y - p.y;
          if (dx*dx + dy*dy <= AOI_RADIUS*AOI_RADIUS) nearbyPlayers.push({ id: op.id, name: op.name, x: op.x, y: op.y, mass: op.mass, r: radius(op.mass) });
        }
      }
      const nearPellets = [];
      if (p) {
        let ctr = 0;
        for (const pe of room.pellets) {
          const dx = pe.x - p.x, dy = pe.y - p.y;
          if (dx*dx + dy*dy <= AOI_RADIUS*AOI_RADIUS) { if ((ctr++ % 2) === 0) nearPellets.push(pe); }
        }
      }
      const aliveCount = [...room.players.values()].filter(pl=>pl.alive).length;
      const meta = {
        mode: room.mode,
        state: room.state,
        alive: aliveCount,
        required: room.mode==='br' ? BR_PLAYERS_REQUIRED : 0,
        timeLeft: room.mode==='br' && room.state==='active' ? Math.max(0, Math.floor((room.endsAt - now())/1000)) : 0,
        safe: room.safe
      };
      io.to(id).emit('state', { you, players: nearbyPlayers, pellets: nearPellets, board, meta, serverTime: now() });
    }
  }
}, TICK);

// --------- HTTP ---------
app.get('/', (_req, res) => res.type('text/plain').end('BlobBet Modes v1.1 server is running.'));
app.get('/version', (_req, res) => res.json({ ok: true, server: 'modes-v1.1', time: Date.now() }));

server.listen(PORT, () => console.log('BlobBet server listening on', PORT));

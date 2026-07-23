# Email Lookup

Find public profiles associated with an email address. Enter an email; the app
aggregates matching public profiles from consent-based sources and shows them in
a simple web UI.

## Sources

| Source | What it returns | Confidence |
| --- | --- | --- |
| **Gravatar** | Display name, bio, location, avatar, and any accounts the person linked — all published by them against their email hash. | Confirmed (tied to the email) |
| **GitHub email search** | The GitHub account whose owner made this commit email public. | Confirmed (tied to the email) |
| **Username candidates** | Profiles on GitHub, GitLab, Reddit, Dev.to, npm, and Keybase whose handle matches the email's local part. | Unverified — a shared handle is not proof of the same person |

Everything comes from public endpoints. Nothing here bypasses a login, a privacy
setting, or a site's access controls, and there is no facial recognition or
photo-based identification.

## Run

Requires Node 18+ (uses built-in `fetch` and `crypto` — no dependencies to install).

```bash
npm start
# → http://localhost:8080
```

Set `LOOKUP_PORT` to change the port.

## API

```
GET /api/lookup?email=name@example.com
```

Returns JSON: `{ email, gravatar, github, usernameMatches, checkedAt }`.

## Responsible use

Aggregating public data is still subject to the law and to each platform's terms.
Use this for legitimate purposes (e.g. verifying leads or contacts you already
have a relationship with), respect data-protection rules that apply to you, and
don't use it to harass, stalk, or profile people.

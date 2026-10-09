# Igloo Server

Server‑based signing device and personal ephemeral relay for the FROSTR protocol. Igloo provides an always‑on signing node with an optional web UI for configuration and monitoring. Built on @frostr/igloo-core.

Looking to deploy quickly? Start with the one-click options in `docs/DEPLOY.md` (Umbrel App Store or Docker/Compose).

[▶ Watch the umbrel demo](https://plebdevs-bucket.nyc3.cdn.digitaloceanspaces.com/videos/random/igloo-server-umbrel-announcement.mp4)

## Cinderella Gateway (this fork)

This fork is the Gateway for [Cinderella](https://github.com/hasky00/cinderella): policy-aware threshold signing where every other share runs a Cinderella node that inspects the full event before contributing a partial signature.

- **Signs full events only.** Each request attaches the event (hex-encoded JSON) so share nodes can check it against the sighash. `POST /api/sign` with a bare `message` hash returns `400 BLIND_SIGN_UNSUPPORTED`; `event.pubkey` must be the group pubkey.
- **Refusals are silent.** A share node that refuses (kind not allowed, rate limit, delay gate) sends nothing back ([bifrost#13](https://github.com/FROSTR-ORG/bifrost/issues/13)), so `/api/sign` answers `504 SIGN_REFUSED_OR_UNREACHABLE` after `FROSTR_SIGN_TIMEOUT`, and NIP-46 returns the same message as an error.
- **Send-only.** The Gateway never co-signs or answers ECDH for other members (`GATEWAY_SEND_ONLY`, default `true`), so a stolen share can't use it to skip the Cinderella nodes.
- **bifrost 2.0.2, pinned.** igloo-core only supports bifrost 1, whose nodes can't talk to bifrost 2, so its helpers are ported in `src/frostr` (MIT). Existing bifrost 1 `bfgroup`/`bfshare` credentials still load, with the same group pubkey. Nonce pools are resynced after restarts ([bifrost#14](https://github.com/FROSTR-ORG/bifrost/issues/14)) by code in `src/cinderella` copied from the Cinderella repo.
- **Held events (profile, delete).** Share nodes delay these kinds and sign them only when the identical event is requested again after the delay. The Gateway does that: the first request goes to every share node (so each starts its clock) and is stored as held; after the delay it is requested again, signed, and published to your NIP-65 write relays (fallback `PUBLISH_RELAYS`, then `RELAYS`). `/api/sign` answers `202 SIGN_HELD`; NIP-46 clients get a "held until …" error. Held events are listed, and can be cancelled, under NIP-46 → Held. `HELD_KINDS` (hours per kind) says which kinds are held and gives the first guess of the unlock time; keep it equal to the share nodes' delay tiers (default `{"0":24,"10063":24,"5":48}`). Cinderella nodes tell the Gateway why they refuse and when they unlock (cinderella PR #19), so the Held card shows the node's own unlock time and reason ("still locked until …", "veto alert not delivered yet", "rate limit …"), and the Gateway re-requests at that time (+ `HELD_RETRY_MARGIN_MS`, default 5 min). When a node gives no time (delay not started yet, catching up, nonce trouble), it tries again every `HELD_RETRY_EVERY_MS` (default 15 min) and follows the node's unlock time as soon as it gives one (also when the node restarted the delay); it only gives up on a node that keeps answering after 7 days. Only when no node answers at all does it give up one delay length past the unlock. The Gateway ignores bifrost messages the relay replays to it (sent before it started or older than 30 s) and tells the share nodes when it (re)starts, so they drop the nonces they gave its previous run. Ordinary kinds a node refuses answer `403 SIGN_REFUSED` with the node's reason instead of a timeout. A share node that restarted tells the Gateway to drop its stale nonces, and a round that still hits one is resynced and retried once. Cancel is not a veto against a stolen share: that needs the share-node veto listener (roadmap).
- **Vetoes show up here.** When you veto a held event from your phone, the share node refuses it and sends this Gateway a notice (NIP-17 DM) to its **notice key**, shown at the top of the Held tab. Put that npub in each node's `veto.gateway_pubkey`, and the nodes' alert npubs in `NODE_ALERT_PUBKEYS`; the held event then shows `vetoed` and is no longer re-requested. Notices are listened for on `NOTICE_RELAYS` (default: `PUBLISH_RELAYS` + `RELAYS`) with Cinderella's relay feed (a catch-up point per relay, real EOSE only, heartbeat with a 60 s idle timeout, reconnect with backoff); only verified notices from `NODE_ALERT_PUBKEYS` are recorded. The Held tab shows which node reported the veto, and a vetoed event can be cancelled to clear it. Submitting a vetoed event again is refused: `/api/sign` answers `403 SIGN_VETOED`, NIP-46 clients get a "vetoed" error. The notice key's secret is encrypted like the credentials (with your login), so in database mode the listener starts when you log in and unlock the signer; notices sent meanwhile wait on the relays (2-day catch-up window). Headless mode reads it from `NOTICE_SECRET`. A notice-listener setup error is logged and only turns veto notices off. Display only: the node enforces the veto either way.
- **NIP-46 connection health.** The NIP-46 connection checks its own relays every 60 s (a tiny REQ that must be answered within 15 s), again when you log in or load the app, and right before a `nostrconnect://` connect; a dead or silent connection is restarted (it never recovers by itself, and a send on it fails silently). The connect reply goes only to the client's relays; if none of them accepts it, the Gateway restarts its connection once and resends, then shows a warning instead of "Awaiting approval" (pick other relays for the remote signer in the client app).
- **Startup echo goes to public relays.** Upstream behaviour: headless startup broadcasts the share echo to `RELAYS` plus the default echo relays (damus, primal). Set `SKIP_STARTUP_ECHO=true` to keep it to your own relays.

## What It Is
- Threshold Schnorr signing for Nostr using your FROSTR shares (k‑of‑n). The full private key is never reconstructed.
- Two modes: Database (multi‑user, encrypted creds, web UI) or Headless (env‑only, API‑first, no UI).
- Includes an in‑memory relay for dev/tests; use production relays in real deployments.

## Features
- Always‑on signer built on igloo‑core with multi‑relay support
- Web UI (React + Tailwind) for setup, monitoring, recovery
- Persisted UI event log (DB mode) with pagination and NDJSON export download
- REST + WebSocket APIs with API‑key, Basic, or session auth
- Health monitor + auto‑restart on repeated failures
- Works as a single node or part of a k‑of‑n signer group
- Ephemeral relay for testing and local development (not for production data)

## Documentation
- [docs/DEPLOY.md](docs/DEPLOY.md) — Umbrel, Docker/Compose, and cloud deployment steps
- [docs/SECURITY.md](docs/SECURITY.md) — hardening, CSP, headers, and rate limiting guidance
- [docs/CONFIG.md](docs/CONFIG.md) — environment variables and operational tuning (CORS vs WS Origin, timeouts, restart/circuit knobs)
- [docs/AUTH_MATRIX.md](docs/AUTH_MATRIX.md) — which endpoints exist in which mode + what bypasses the global auth gate
- [docs/PEER_POLICIES.md](docs/PEER_POLICIES.md) — peer policy schema, precedence, and persistence
- [docs/RELEASE.md](docs/RELEASE.md) — release workflow, automation, and emergency fixes
- [docs/openapi/openapi.yaml](docs/openapi/openapi.yaml) — OpenAPI spec (served at `/api/docs`)

## Quick Start

### Prerequisites
- Bun runtime (uses Bun APIs like `bun:sqlite`).
- FROSTR group/share credentials or add them later via UI/API.

### Start Locally (Database mode – default)
```bash
git clone https://github.com/FROSTR-ORG/igloo-server.git
cd igloo-server && bun install && bun run build
export ADMIN_SECRET=$(openssl rand -hex 32)
bun run start
# http://localhost:8002 → enter ADMIN_SECRET → create admin → Configure tab → add GROUP_CRED + SHARE_CRED
```

### Start Locally (Headless)
```bash
export HEADLESS=true
export GROUP_CRED="bfgroup1..." ; export SHARE_CRED="bfshare1..."
export RELAYS='["wss://relay.primal.net","wss://relay.damus.io"]'
export AUTH_ENABLED=false ; export API_KEY=dev-local-key  # /api/env still requires auth
bun run start
```

## Configure & Deploy Fast

### Pick a Mode
- Database (recommended): multi‑user, AES‑encrypted creds, admin onboarding via `ADMIN_SECRET`, SQLite at `./data/igloo.db` (override with `DB_PATH`).
- Headless: env‑only config, API‑first, UI disabled. Supports `PEER_POLICIES` blocks (see `docs/PEER_POLICIES.md`) and API key auth.

### Deployment Options

#### Umbrel (1.1.0+)
1. In Umbrel, open the App Store → click the `…` menu (top‑right) → **Community App Stores**.
2. Add `https://github.com/frostr-org/igloo-server-store` and save, then install **Igloo Server**.
3. First launch: Umbrel injects `ADMIN_SECRET` (its app password) and the package sets `SKIP_ADMIN_SECRET_VALIDATION=true`, so you go straight to creating the first admin user. Follow the instructions screen, create your admin, then add `GROUP_CRED` / `SHARE_CRED`.
4. If the install reports data-dir permission errors, fix volume ownership once (see Umbrel note in docs/DEPLOY.md) and restart from the Umbrel dashboard.
5. Updates arrive via the store; start/stop from the Umbrel dashboard.

#### Docker / Compose
```bash
# one‑off
docker build -t igloo-server .
docker run -p 8002:8002 \
  -e NODE_ENV=production -e HOST_NAME=0.0.0.0 \
  -e ADMIN_SECRET=... -e AUTH_ENABLED=true -e RATE_LIMIT_ENABLED=true \
  -v $(pwd)/data:/app/data igloo-server

# compose (see compose.yml)
docker compose up -d --build
```

Reverse proxy (nginx) and cloud steps are in docs/DEPLOY.md.

### Production Checklist
- `NODE_ENV=production`, persist `/app/data`, set strong `ADMIN_SECRET` (keep set after onboarding).
- Explicit `ALLOWED_ORIGINS` (WebSocket Origin checks support `@self` for “whatever host the user connects through”; host match, port-agnostic), `TRUST_PROXY=true` behind a proxy; forward WS upgrade headers.
- Auth on (`AUTH_ENABLED=true`), rate limit on (`RATE_LIMIT_ENABLED=true`); optional `SESSION_SECRET` (auto‑gen if absent).
- Timeouts: tune `FROSTR_SIGN_TIMEOUT` or `SIGN_TIMEOUT_MS` (1000–120000ms).

## API & Docs
- Swagger UI: http://localhost:8002/api/docs (self‑hosted; run `bun run docs:vendor` if assets missing).
- OpenAPI: docs/openapi/openapi.yaml or `/api/docs/openapi.{json|yaml}`.
- Auth: API Key, Basic, or session; WS `/api/events` supports subprotocol hints (`apikey.<TOKEN>`, `bearer.<TOKEN>`, `session.<ID>`).
- Validate spec: `bun run docs:validate`.

### API Keys
- Headless: set a single `API_KEY` in env; HTTP cannot rotate it.
- Database mode: manage multiple keys via the UI or admin endpoints. Admin APIs accept either `Authorization: Bearer <ADMIN_SECRET>` or an authenticated admin session.
  - CLI helpers: `bun run api:test:get`, `bun run api:test:ws`, `bun run api:test:nip` (see `scripts/api/README.md`).

## Operations
- Health monitor: periodic connectivity checks; auto‑recreate node on repeated failures; status at `/api/status`.
- Error circuit breaker: `ERROR_CIRCUIT_WINDOW_MS` (default 60000), `ERROR_CIRCUIT_THRESHOLD` (default 10), `ERROR_CIRCUIT_EXIT_CODE` (default 1).
- Headless env management requires auth even with `AUTH_ENABLED=false` (`/api/env*`).

## Security Quick Setup
Production defaults:
```bash
AUTH_ENABLED=true
RATE_LIMIT_ENABLED=true
ALLOWED_ORIGINS=https://yourdomain.example
TRUST_PROXY=true
# Provide ADMIN_SECRET; SESSION_SECRET auto‑generates if absent
```
Data directory hardening (example):
```bash
chmod 700 ./data
chmod 600 ./data/igloo.db ./data/.session-secret 2>/dev/null || true
```

See docs/SECURITY.md for hardening and CSP details.

## Troubleshooting
- UI assets missing/outdated: run `bun run build` to regenerate `static/app.js` and `static/styles.css`.
- UI not updating: prod caches assets; rebuild + restart. Dev disables cache.
- Cred/relay issues: verify `bfgroup1...` / `bfshare1...` and reachable relays.
- More: docs/SECURITY.md (hardening), docs/DEPLOY.md (proxy/cloud), docs/openapi/openapi.yaml (API).

## Development
```bash
bun run dev   # frontend watch
bun run start # server
bun test      # backend tests
```

## Contributing & License
MIT (see LICENSE). PRs welcome—use Conventional Commits and verify: `bun run build`, `bun test`, `bun run docs:validate`.

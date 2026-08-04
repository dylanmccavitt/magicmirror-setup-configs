# HTTP API Reference

Source-verified against `custom_modules/MMM-AgentSurface/node_helper.js`, `vercel/status-server.mjs`, and `lib/agent-snapshot.mjs`. Two servers expose HTTP:

- **Local MagicMirror server** — the MagicMirror express app (default `0.0.0.0:8080` per `mirror-config/config.js`); `MMM-AgentSurface`'s node helper registers all routes below under `/MMM-AgentSurface/`.
- **Cloud control plane** — `vercel/status-server.mjs`, a standalone Node HTTP server (Vercel deployment; `PORT` env, default 80).

## Authentication model

All token checks hash both sides with SHA-256 and compare via `crypto.timingSafeEqual`, so comparison work is independent of supplied token length/content. Empty configured or supplied tokens always fail.

| Endpoint group | Env token | Behavior when env unset |
|---|---|---|
| Local page control (`/api/control*`) | `MIRROR_CONTROL_TOKEN` | **503** `MIRROR_CONTROL_TOKEN is required for page control` — fails closed |
| Local snapshot upload (`POST /api/snapshot`) | `MIRROR_LOCAL_UPLOAD_TOKEN` (optional) | auth check skipped — endpoint is open on the LAN |
| Cloud ingest (`POST /api/agent-snapshot`) | `MIRROR_INGEST_TOKEN` | **401** `unauthorized` — fails closed |

Accepted credential header forms:

- **Local control routes** (`node_helper.readBearerToken`): `Authorization: Bearer <token>` checked first, then `X-Mirror-Control-Token: <token>`, then `X-Mirror-Ingest-Token: <token>`.
- **Local snapshot upload and cloud ingest** (`lib/agent-snapshot.readBearerToken`): `X-Mirror-Ingest-Token: <token>` checked first, then `Authorization: Bearer <token>`.

## Local: page control

### `POST /MMM-AgentSurface/api/control`

Auth: `MIRROR_CONTROL_TOKEN` (see above). Body: JSON, max 1 MiB.

Request:

```json
{ "command": "next" | "previous" | "show" | "pause" | "resume", "pageId": "weather", "source": "voice" }
```

- `command` is case-insensitive and trimmed; anything else → **400** `command must be one of: next, previous, show, pause, resume`.
- `pageId` is required for `show` only (also case-insensitive/trimmed) and is validated against the page set the display module actually reported — not the fallback order. Unknown page → **400** `pageId must be one of: <reported pages>`.
- `source` is optional (case-insensitive/trimmed) and must be one of `command`, `remote`, `voice` when present; anything else → **400** `source must be one of: command, remote, voice`. Omitted → `command`. The phone remote sends `remote`; the Siri Shortcuts voice adapter ([voice.md](voice.md)) sends `voice`. The accepted source flows through to `state.lastCommandSource` once the display applies the command.
- `show` before the display module has reported its registry → **503** `page registry not reported by display module yet`.

Success — **200**:

```json
{
  "ok": true,
  "accepted": { "command": "show", "pageId": "weather", "source": "voice", "requestId": "<base36 timestamp>-<random>" },
  "state": { "currentPageId": "home", "rotationPaused": false, "lastCommandSource": "system" }
}
```

`accepted` means the command was forwarded to the display module over the module socket. **`state` is the state at accept time, not after the command applies** — the display module executes asynchronously and re-reports; poll `GET .../state` to observe the result. Error responses (400/503 above) also carry the current `state`.

Errors: **401** `{ "ok": false, "errors": ["unauthorized"] }`; **503** (no configured token) `{ "ok": false, "errors": ["MIRROR_CONTROL_TOKEN is required for page control"] }`; malformed/empty/oversized JSON body → **400**/**413** — same body reader as the snapshot upload below, so the error strings say "snapshot body" even on this route.

### `GET /MMM-AgentSurface/api/control/state`

Auth: `MIRROR_CONTROL_TOKEN`. Success — **200**:

```json
{
  "ok": true,
  "state": { "currentPageId": "sports", "rotationPaused": true, "lastCommandSource": "command" },
  "pages": [ { "id": "home", "label": "Home" }, { "id": "agents", "label": "Agents" } ]
}
```

- `state.currentPageId` — one of the module's known page ids (`home`, `agents`, `calendar`, `weather`, `path`, `sports`); unknown values sanitize to `home`.
- `state.lastCommandSource` — free string from the display module (`system` default, `command`, `rotation`, or a control-POST `source`: `remote`, `voice`).
- `pages` — the registry the display module reported, in rotation order, with labels from `mirror-os-shell.js` `PAGE_LABELS`. **`null` until the display module has reported** (roughly the first 5–10 s after page load); clients must render fail-closed on `null`.

Errors: **401** / **503** as above.

### `GET /MMM-AgentSurface/remote`

Unauthenticated by design. Serves the static phone remote shell (`remote.html`, cached in memory after first read): no data, no token material. The page prompts for the control token on-device and drives everything through the two authenticated routes above. **500** `{ "ok": false, "errors": ["remote page unavailable"] }` if the file is unreadable. Reachable wherever the MagicMirror HTTP server is reachable (LAN by default) — do not port-forward it publicly.

## Local: agent snapshot

### `POST /MMM-AgentSurface/api/snapshot`

Auth: only enforced when `MIRROR_LOCAL_UPLOAD_TOKEN` is set. Body: JSON snapshot (schema below), max 1 MiB (`MAX_BODY_BYTES`).

Body handling (shared with control POST): empty body → **400** `snapshot body is required`; unparseable → **400** `snapshot body must be valid JSON`; over 1 MiB → **413** `snapshot payload too large`; stream error → **400** with the stream message.

Success — **200**:

```json
{ "ok": true, "summary": { "threadCount": 2, "activeCount": 1, "blockedCount": 0, "completedCount": 1, "tokenTotal": 1234, "generatedAt": "…", "source": { "kind": "…", "label": "…" } }, "digest": "<sha256 hex>" }
```

Validation failure → **400** `{ "ok": false, "errors": [ …validator messages… ] }`. Validator unavailable → **500** `{ "ok": false, "errors": ["snapshot validator unavailable"] }`.

The accepted snapshot is held **in memory only** — it is lost on server restart and must be re-posted.

### `GET /MMM-AgentSurface/api/snapshot/current`

Unauthenticated. **200** `{ "ok": true, "snapshot": <normalized snapshot> | null, "summary": <summary> | null }` — both `null` until a snapshot has been posted since the last restart. Note: unlike the upload route, reads are never token-checked; anyone on the LAN can read the current snapshot.

## Cloud control plane (`vercel/status-server.mjs`)

Error bodies here use `{ "error": "snake_case_code" }` — a **different shape** from the local `{ "ok": false, "errors": [...] }`.

### `GET /health`, `GET /healthz`

**204**, no body, `cache-control: no-store`.

### `GET /`, `GET /status`

**200**:

```json
{ "service": "magic-mirror-agent-control", "status": "ok", "startedAt": "…", "uptimeSeconds": 123, "ingestConfigured": true, "timestamp": "…" }
```

`ingestConfigured` is `Boolean(MIRROR_INGEST_TOKEN)` — when `false`, ingest below always 401s.

### `POST /api/agent-snapshot`

Auth: `MIRROR_INGEST_TOKEN`, fail-closed. Body: JSON snapshot, max **256 KiB** (smaller than the local 1 MiB limit). Empty body parses as `{}` (which then fails validation) — unlike the local route's explicit empty-body 400.

Success — **202** `{ "accepted": true, "digest": "<sha256 hex>", "receivedAt": "…", "summary": { …same summary shape as local… } }`.

Errors: **401** `{ "error": "unauthorized" }`; **413** `{ "error": "request_too_large" }`; **400** `{ "error": "invalid_json" }` / `{ "error": "request_error" }` / `{ "error": "invalid_snapshot", "errors": [ …validator messages… ] }`. Any other route/method → **404** `{ "error": "not_found" }`.

## Agent snapshot schema (v1)

Validated by `lib/agent-snapshot.mjs` (`validateAgentSnapshot` / `normalizeAgentSnapshot`). Required:

```json
{
  "schemaVersion": 1,
  "generatedAt": "<ISO timestamp>",
  "source": { "kind": "<non-empty>", "label": "<non-empty>" },
  "threads": [
    { "id": "…", "title": "…", "status": "…", "project": "…", "updatedAt": "<ISO timestamp>" }
  ]
}
```

Normalization rules:

- Strings are trimmed and truncated: 160 chars generally, 220 for `thread.lastMessage`.
- `thread.status` lowercases and must be one of `running | blocked | done | failed | idle | waiting | unknown`; anything else normalizes to `unknown`.
- Optional per-thread strings kept when non-empty: `agent`, `project`, `repo`, `branch`, `phase`, `issueId`, `prId`, `workstreamId`, `blocker`, `lastMessage`. Optional finite numbers: `tokens`, `inputTokens`, `outputTokens`, `costUsd`.
- `threads` is truncated to `maxThreads` (default 50). Both the local upload route and the cloud ingest call the normalizer without overriding it, so 50 applies everywhere; the module config's `maxThreads: 6` only limits what the display renders.
- `summary.activeCount/blockedCount/completedCount` default to counts derived from thread statuses (`running`/`blocked`/`done`); `summary.totalTokens` falls back to `stats.tokenTotal`, then to the sum of thread `tokens`. `stats.sessionCount` and `stats.costUsd` are kept when finite.
- `receivedAt` is stamped server-side; `digest` is the SHA-256 hex of the normalized snapshot (minus the digest field itself).

Validation quirk: `validateAgentSnapshot` requires `thread.project` on every thread, but normalization treats it as optional — a thread without `project` is rejected at the API boundary even though the normalizer would accept it.

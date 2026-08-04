# Voice Commands (Siri Shortcuts)

The mirror's voice adapter is **Siri Shortcuts**: speech recognition stays on your Apple device (iPhone, Apple Watch, or Mac), and each shortcut sends one fixed, pre-built JSON command to the authenticated page-control API. The mirror itself never listens, never receives audio or transcripts, and runs no extra service.

Why this design:

- **Fail-safe by construction.** Unrecognized or low-confidence speech simply never matches a shortcut — no request is emitted. If a malformed request does arrive, the server rejects unknown commands, pages, and sources with **400** and the page does not change (see [api.md](api.md)).
- **No new attack surface.** Commands use the existing `MIRROR_CONTROL_TOKEN` bearer auth; there is no separate voice endpoint and no bypass into module internals.
- **Privacy.** The only voice-related data the mirror ever sees is the literal string `"source": "voice"`. The Home page CONTROL panel shows `last cmd voice` — never any audio, transcript, or phrase content.

A hands-free wake-word daemon at the mirror itself is tracked separately (AGE-809) and reuses this same API contract.

## Prerequisites

- The MagicMirror server reachable on your LAN, e.g. `http://<mirror-host>:8080`.
- `MIRROR_CONTROL_TOKEN` set in the server environment (page control fails closed without it).
- iOS/iPadOS/watchOS/macOS Shortcuts app. Your phone must be on the same network as the mirror (the control API is LAN-only by default — do not port-forward it).

## Command payloads

All commands are `POST http://<mirror-host>:8080/MMM-AgentSurface/api/control` with headers:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <your MIRROR_CONTROL_TOKEN value>` |
| `Content-Type` | `application/json` |

Bodies (one shortcut per command you want):

| Spoken shortcut name (suggested) | JSON body |
|---|---|
| "Mirror home" | `{ "command": "show", "pageId": "home", "source": "voice" }` |
| "Mirror agents" | `{ "command": "show", "pageId": "agents", "source": "voice" }` |
| "Mirror calendar" | `{ "command": "show", "pageId": "calendar", "source": "voice" }` |
| "Mirror weather" | `{ "command": "show", "pageId": "weather", "source": "voice" }` |
| "Mirror path" | `{ "command": "show", "pageId": "path", "source": "voice" }` |
| "Mirror sports" | `{ "command": "show", "pageId": "sports", "source": "voice" }` |
| "Mirror next" | `{ "command": "next", "source": "voice" }` |
| "Mirror previous" | `{ "command": "previous", "source": "voice" }` |
| "Mirror pause" | `{ "command": "pause", "source": "voice" }` |
| "Mirror resume" | `{ "command": "resume", "source": "voice" }` |

`source: "voice"` is what makes the mirror's Home CONTROL panel report `last cmd voice`; the server validates it against a fixed allowlist.

## Building a shortcut

For each command:

1. Shortcuts app → **+** → name the shortcut with the phrase you want to speak (the name **is** the Siri trigger: "Hey Siri, mirror weather").
2. Add action **Get Contents of URL**.
3. URL: `http://<mirror-host>:8080/MMM-AgentSurface/api/control` (an mDNS name like `http://<hostname>.local:8080/...` also works on LAN).
4. Expand **Show More**: Method `POST`; add the two headers above; Request Body → `JSON` (or `File`/`Text` with the exact body string from the table).
5. Run it once by hand to confirm a `{"ok":true,...}` response, then trigger by voice.

Configuration lives entirely in the shortcut (host + token) — change either by editing the shortcut; nothing is stored in this repo. The token is on-device only, same trust level as the phone remote's saved token.

## Fail-safe semantics

| Input | Result |
|---|---|
| Speech that matches no shortcut name | Siri does nothing — zero requests to the mirror |
| Low-confidence recognition | Siri asks for confirmation or does nothing — zero requests |
| Wrong/missing token | **401**, page unchanged |
| Unknown `command` | **400** `command must be one of: ...`, page unchanged |
| Unknown `pageId` | **400** `pageId must be one of: <reported pages>`, page unchanged |
| Unknown `source` | **400** `source must be one of: command, remote, voice`, page unchanged |
| `show` before the display reports its registry (~first 5–10 s) | **503**, page unchanged |

## Troubleshooting

- `401 unauthorized` — token in the shortcut does not match the server's `MIRROR_CONTROL_TOKEN`.
- `503 MIRROR_CONTROL_TOKEN is required for page control` — server started without the env var.
- `503 page registry not reported by display module yet` — mirror browser page not loaded yet; retry after it renders.
- Shortcut hangs/fails to connect — phone not on the mirror's LAN, or wrong host/port.

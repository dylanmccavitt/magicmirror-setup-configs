# Magic Mirror Agent Surface

This repo keeps the editable MagicMirror config, local agent-snapshot tooling, and Vercel control plane for the mirror.

## Current state

- Pinned MagicMirror runtime (`v2.34.0`) bootstrapped into `runtime/MagicMirror`
- Mirror config includes built-in `clock` and the custom `MMM-AgentSurface` module
- Agent surface display config lives in `mirror-config/config.js`
- Scoped visual tweaks live in `mirror-config/custom.css`
- Sync scripts keep editable source in this repo and copy it into the runtime

## Preview on Mac

Desktop app preview:

```bash
./scripts/run-mac.sh
```

Browser preview:

```bash
./scripts/run-server.sh
```

Then open [http://localhost:8080](http://localhost:8080).

## Quick start

1. Install Node.js LTS, recommended `20.x` or newer.
2. Bootstrap the pinned MagicMirror runtime:

```bash
./scripts/bootstrap.sh
```

3. Start a preview:

```bash
./scripts/run-mac.sh
```

or:

```bash
./scripts/run-server.sh
```

## Agent snapshots, Mirror OS contracts, and Vercel

Config and page-contract validation:

```bash
npm run check:config
npm run check:contracts
npm run check:source-state
npm run check:provenance
npm run check:sanitizer
npm run check:shell
npm run check:control
npm run check:calendar
npm run check:sports
npm run check:path
```

Local snapshot validation:

```bash
npm run check:snapshot -- --file <snapshot.json>
```

Collect real OMP usage stats and recent session metadata as a snapshot:

```bash
npm run collect:omp-stats
```

Upload a snapshot to the local mirror and optional Vercel validator:

```bash
npm run upload:snapshot -- --file <snapshot.json> --cloud-url https://magicmirror-setup-configs.vercel.app
```


Snapshot uploads target the Vercel endpoint `POST /api/agent-snapshot`.

All HTTP endpoints (local module routes, cloud control plane, snapshot schema v1, auth model, exact request/response shapes and error codes) are documented in [docs/api.md](docs/api.md).

Environment/source names:

- `MIRROR_INGEST_TOKEN` — bearer token used by the upload client and Vercel ingest API
- `MIRROR_LOCAL_UPLOAD_TOKEN` — optional bearer token accepted by the local `MMM-AgentSurface` upload endpoint
- `MIRROR_AGENT_PROJECT` — optional project label for collected agent work; defaults to `Magic Mirror Agent Surface`
- `MIRROR_CONTROL_TOKEN` — bearer token required by the local page-control API, the phone remote at `GET /MMM-AgentSurface/remote` (a static shell with no data or token material baked in; the token is entered on the phone), and the Siri Shortcuts voice commands ([docs/voice.md](docs/voice.md)). Fails closed without it; endpoint details in [docs/api.md](docs/api.md). LAN-only by default — do not port-forward the mirror publicly.
- `mirrorOs.home.label` — optional household display label configured in `mirror-config/config.js`; display-only text for the Home page, not a secret or data source
- `MIRROR_CALENDAR_ICS_URL` — calendar ICS feed URL (Apple/Google shared or private ICS links work); calendar stays `unconfigured` until this is set. Optional: `MIRROR_CALENDAR_NAME` (display label), `MIRROR_CALENDAR_TIMEZONE` (IANA zone for event times). Feed URLs are never echoed in errors or on screen.
- `MIRROR_WEATHER_LATITUDE` and `MIRROR_WEATHER_LONGITUDE` — Open-Meteo coordinate source; weather stays `unconfigured` until both are set. Optional: `MIRROR_WEATHER_TIMEZONE` (IANA zone or Open-Meteo timezone value), `MIRROR_WEATHER_LOCATION_LABEL` (display/source label).
- `MIRROR_PATH_GTFS_RT_URL` and `MIRROR_PATH_STATION_ID` — PATH GTFS-realtime source; PATH stays `unconfigured` until both are set. Optional: `MIRROR_PATH_ROUTE_ID` (GTFS route_id), `MIRROR_PATH_DIRECTION` (`TO_NY` or `TO_NJ`). Research: PANYNJ publishes the static PATH GTFS IDs but does not publish an official public GTFS-realtime TripUpdates endpoint; the maintained community GTFS-RT wrapper at `https://path.transitdata.nyc/gtfsrt` uses PATH realtime APIs and matches the static GTFS station/route IDs, so use it as the configured feed URL unless you run your own proxy. The feed uses station-level stop IDs without direction suffixes; the provider exact-matches `MIRROR_PATH_STATION_ID` and also accepts `-`, `_`, or `:` suffixes if a compatible feed emits platform/direction-suffixed child stops. Grove Street -> World Trade Center example: `MIRROR_PATH_STATION_ID=26728`, `MIRROR_PATH_ROUTE_ID=862`, `MIRROR_PATH_DIRECTION=TO_NY`; World Trade Center station is `26734`.
- `MIRROR_SPORTS_LEAGUES` and `MIRROR_SPORTS_TEAMS` — ESPN scoreboard selectors; sports stays `unconfigured` until both are set. Supported leagues: `nfl`, `mlb`, `nba`. Team selectors match ESPN team abbreviation/display name case-insensitively. Optional: `MIRROR_SPORTS_SOURCE_URL` (base ESPN API URL override), `MIRROR_SPORTS_TIMEZONE` (IANA zone for start times).

Health checks:

- `GET /health`
- `GET /healthz`
- `GET /status`

## Files to customize next

- `mirror-config/config.js` — active MagicMirror modules and positions
- `mirror-config/custom.css` — scoped visual tweaks
- `custom_modules/MMM-AgentSurface/` — custom agent surface module path

## Ground-up direction

The next build should make the mirror an agent surface, not a generic dashboard:

- Agent threads: show live or recent agent/session threads, statuses, blockers, and outputs.
- Voice: page-navigation voice commands are wired through Siri Shortcuts against the page-control API ([docs/voice.md](docs/voice.md)); hands-free wake-word control at the mirror is tracked separately.
- Movement sensor: presence-aware wake/sleep, glance mode, and full detail mode.
- Agent bus: one local service should broker state between MagicMirror modules, agent/thread sources, voice, and sensors so UI modules stay dumb.

Do not add placeholder modules. Add each capability when the data source and runtime behavior are wired end to end.

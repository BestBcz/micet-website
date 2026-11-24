# MiCet.cc

Minecraft PvP website for player profiles, Elo leaderboards, personal match history and cosmetic Tag test checkout.

The default demo mode uses generated players and simulated receipts. Bridge mode serves responses from the separate MicetSiteBridge game plugin. Both modes use D1 for account links, orders and jobs. Mode-specific records are isolated. The checkout always simulates payment.

## Development

Use Node 24. Install, check and build the site, then apply the D1 migration once to the local database.

```sh
npm ci
npx tsc --noEmit
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_workable_the_leader.sql
npm start -- --port 8787 --var MICET_LOCAL_TEST:1
```

Open `http://127.0.0.1:8787/` for the server homepage. Use **战绩查询** to search for `KairoPvP`. The demo game binding under **我的对局** lets you explore example match inventories and switch players.

`tests/integration.mjs` verifies the demo at port 8787 and the bridge API at port 8788. Run each Worker against a separate local D1 state directory. Set `MICET_LOCAL_TEST=1` on both loopback Workers, and set `MICET_MODE=bridge` and `MICET_BRIDGE_SECRET=micet-integration-fixture-secret-local` on port 8788. Use a fresh bridge database for the offline check. Run `node tests/integration.mjs`.

## Native Minecraft server status

Both `npm run dev` and `npm start` launch a loopback Node service that sends a Minecraft Java Server List Ping directly to `micet.cc`. The homepage refreshes the native MOTD, server icon and player count while visible. Run `node --test tests/native-status.test.mjs` to test status packet handling locally.

For a hosted Worker, run `node scripts/minecraft-status.mjs` on a Node host with TCP access to `micet.cc`. Expose its `/status` route through HTTPS and set `MICET_STATUS_URL` to that route in the Worker runtime.

## Hosting

For a public showcase on a VPS, use the public launch flag after building.

```sh
npm start -- --port 8787 --var MICET_PUBLIC_LAUNCH:1
```

This serves the homepage, live MOTD and the Tag catalog. It disables account, stats, bridge and checkout endpoints in the application. Point Cloudflare Tunnel at `http://127.0.0.1:8787`. The public Tag selection is in `lib/micet-data.ts`.

### Self-hosted Practice stats and account binding

Start with a separate checkout, local D1 state and HTTPS hostname for staging. Build with Node 24 using `npm run build`. Apply `0000_workable_the_leader.sql` once for a fresh database, then apply the binding migration once.

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_website_binding.sql
```

On an existing VPS, use the same config and `--persist-to` path as the running website. If stats work but generating a code fails, check whether the binding tables exist in that database before applying `0001`.

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bridge_jobs','web_link_challenges','web_sessions') ORDER BY name"
```

If the output contains `bridge_jobs` and neither binding table, apply `0001` using the previous command. If both binding tables exist, the binding migration has already been applied.

Keep a private copy of these settings outside the checkout. After each build, install it as `dist/server/.dev.vars` with file mode `0600`, then run `npm start -- --port 8788`. Use a fresh random secret of at least 32 characters.

```dotenv
MICET_SELF_HOSTED=1
MICET_SITE_ORIGIN=https://staging.micet.cc.cd
MICET_BRIDGE_SECRET=<shared bridge secret>
```

Point the staging hostname's Tunnel route at `http://127.0.0.1:8788`. Allow these exact paths and methods in the Cloudflare rule for that hostname alongside the existing page and static assets.

| Method | Paths |
| --- | --- |
| GET | `/api/micet/server-status`, `/api/micet/leaderboard`, `/api/micet/player`, `/api/micet/status`, `/api/micet/result` |
| POST | `/api/micet/code`, `/api/micet/confirm`, `/api/micet/logout`, `/api/micet/stats`, `/api/bridge/link`, `/api/bridge/poll`, `/api/bridge/receipt` |

Install MicetSiteBridge 0.3.1 on the Bukkit Practice backend with MicetPvP and AquaCore. Its Elo leaderboard uses the same ranked and hidden kit flags as the public in-game queue menu. In the plugin's `config.yml`, use the same HTTPS origin and bridge secret as the website.

```yaml
enabled: true
self-hosted: true
site-url: "https://staging.micet.cc.cd"
bridge-secret: "<shared bridge secret>"
trust-forwarded-identity: false
```

For offline-mode Bukkit backends, enable `trust-forwarded-identity` only after confirming the backend is reachable exclusively through a proxy that authenticates every player and forwards their verified UUID.

Compare two players' Elo and wins with the in-game leaderboard. Generate a code on the site, run `/micetlink <code>` in Practice, then select **完成绑定** in the originating browser. Verify that a second account cannot read the first account's match. Public rankings and profiles use live bridge data with a short cache. The self-hosted mode disables checkout and delivery.

After building, run `node --test tests/self-hosted.mjs`. It starts an isolated local Worker, applies both migrations and simulates game bridge requests.

The production build targets a Sites-hosted Worker with a D1 `DB` binding. Register your own Sites project when deploying this checkout and store configuration values as runtime variables.

Sites provides verified visitor identity at its gateway. If deploying outside Sites, use an authenticated gateway that strips incoming identity headers and injects its own, or replace the identity adapter before exposing account and order routes. Keep `MICET_LOCAL_TEST` limited to local previews.

An enabled private bridge requires the MicetSiteBridge game plugin, the Site’s service credential and a runtime bridge secret. Use bridge version 0.2.0 or later for saved match inventories. The bridge checks the player’s existing match-history permissions before returning one participant’s snapshot.

Build the bridge with JDK 21 from this repository on Windows using PowerShell.

```powershell
./bridge/build.ps1 -Practice ../Micet-PotPvP -AquaCore ../AquaCore/release/AquaCore.jar
```

The JAR is written to `bridge/build/MicetSiteBridge.jar`. Its configuration is generated on first start.

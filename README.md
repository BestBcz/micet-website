# MiCet.cc

Minecraft PvP website for player profiles, Elo leaderboards, personal match history and a cosmetic Tag shop.

The self-hosted shop takes Xiaodou payments and delivers permanent AquaCore Tags through MicetSiteBridge. Demo and private preview checkouts use simulated receipts. Orders and jobs are isolated by mode. [小豆支付上线指南](SHOP.md) · [MicetSiteBridge repository](https://github.com/BestBcz/MicetSiteBridge)

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

For a public VPS, configure self-hosting as described below. When upgrading an old display-only installation, remove `MICET_PUBLIC_LAUNCH=1` from runtime variables and startup arguments after configuring self-hosting. Leaving the retired flag enabled returns HTTP 503 for pages and APIs.

### Self-hosted Practice stats and account binding

Use the existing checkout, D1 state and HTTPS hostname on the VPS. The staging hostname and port below are examples for a separate installation. Build with Node 24 using `npm run build`. Apply `0000_workable_the_leader.sql` once for a fresh database, then apply the binding migration once.

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

Install MicetSiteBridge 0.3.2 or newer on the Bukkit Practice backend with MicetPvP and AquaCore. Its Elo leaderboard uses the same ranked and hidden kit flags as the public in-game queue menu. Update the website first so it can accept the larger match-detail receipts that contain multiple inventory snapshots. In the plugin's `config.yml`, use the same HTTPS origin and bridge secret as the website. [Plugin releases](https://github.com/BestBcz/MicetSiteBridge/releases)

```yaml
enabled: true
self-hosted: true
site-url: "https://staging.micet.cc.cd"
bridge-secret: "<shared bridge secret>"
trust-forwarded-identity: false
```

For offline-mode Bukkit backends, enable `trust-forwarded-identity` only after confirming the backend is reachable exclusively through a proxy that authenticates every player and forwards their verified UUID.

Compare two players' Elo and wins with the in-game leaderboard. Generate a code on the site, run `/micetlink <code>` in Practice, then select **完成绑定** in the originating browser. Verify that a second account cannot read the first account's match. Public rankings and profiles use live bridge data with a short cache. For live checkout, apply migrations 0002 through 0005 and configure the shop and bridge using the [deployment guide](SHOP.md).

After building, run `node --test tests/self-hosted.mjs tests/shop.mjs`. The tests use isolated local Workers and D1 databases, signed payment fixtures and simulated game bridge requests.

The production build targets a Sites-hosted Worker with a D1 `DB` binding. Register your own Sites project when deploying this checkout and store configuration values as runtime variables.

Sites provides verified visitor identity at its gateway. If deploying outside Sites, use an authenticated gateway that strips incoming identity headers and injects its own, or replace the identity adapter before exposing account and order routes. Keep `MICET_LOCAL_TEST` limited to local previews.

An enabled private bridge requires the MicetSiteBridge game plugin, the Site’s service credential and a runtime bridge secret. Use bridge version 0.2.0 or later for saved match inventories. The bridge checks the player’s existing match-history permissions before returning snapshots. [Plugin build instructions](https://github.com/BestBcz/MicetSiteBridge#build)

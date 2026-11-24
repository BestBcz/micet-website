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

This serves the homepage, live MOTD and the Tag catalog. It disables account, stats, bridge and checkout endpoints in the application. Point Cloudflare Tunnel at `http://127.0.0.1:8787`. The catalog is a snapshot of the AquaCore `Tags` collection and can be updated in `lib/micet-data.ts`.

The production build targets a Sites-hosted Worker with a D1 `DB` binding. Register your own Sites project when deploying this checkout and store configuration values as runtime variables.

Sites provides verified visitor identity at its gateway. If deploying outside Sites, use an authenticated gateway that strips incoming identity headers and injects its own, or replace the identity adapter before exposing account and order routes. Keep `MICET_LOCAL_TEST` limited to local previews.

An enabled private bridge requires the MicetSiteBridge game plugin, the Site’s service credential and a runtime bridge secret. Use bridge version 0.2.0 or later for saved match inventories. The bridge checks the player’s existing match-history permissions before returning one participant’s snapshot.

Build the bridge with JDK 21 from this repository on Windows using PowerShell.

```powershell
./bridge/build.ps1 -Practice ../Micet-PotPvP -AquaCore ../AquaCore/release/AquaCore.jar
```

The JAR is written to `bridge/build/MicetSiteBridge.jar`. Its configuration is generated on first start.

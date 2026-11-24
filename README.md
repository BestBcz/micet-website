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

Open `http://127.0.0.1:8787/` and search for `KairoPvP` to try the demo.

`tests/integration.mjs` verifies the demo at port 8787 and the bridge API at port 8788. Run each Worker against a separate local D1 state directory. Set `MICET_LOCAL_TEST=1` on both loopback Workers, and set `MICET_MODE=bridge` and `MICET_BRIDGE_SECRET=micet-integration-fixture-secret-local` on port 8788. Use a fresh bridge database for the offline check. Run `node tests/integration.mjs`.

## Hosting

The production build targets a Sites-hosted Worker with a D1 `DB` binding. Register your own Sites project when deploying this checkout and store configuration values as runtime variables.

Sites provides verified visitor identity at its gateway. If deploying outside Sites, use an authenticated gateway that strips incoming identity headers and injects its own, or replace the identity adapter before exposing account and order routes. Keep `MICET_LOCAL_TEST` limited to local previews.

An enabled private bridge requires the separate MicetSiteBridge game plugin, the new Site’s service credential and a runtime bridge secret.

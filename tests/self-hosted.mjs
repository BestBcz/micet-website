import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { Miniflare } from "miniflare";

const siteOrigin = "https://micet-test.example.invalid";
const bridgeSecret = "micet-self-hosted-integration-fixture-secret";

test("self-hosted account binding and read-only bridge", async t => {
  const base = "http://localhost";
  const serverRoot = resolve("dist/server");
  const workerConfig = JSON.parse(await readFile(resolve(serverRoot, "wrangler.json"), "utf8"));
  const dependencies = (await readdir(serverRoot, { recursive: true })).filter(file => /\.m?js$/.test(file) && file !== workerConfig.main);
  const worker = new Miniflare({
    modulesRoot: serverRoot,
    modules: [workerConfig.main, ...dependencies].map(file => ({ type: "ESModule", path: resolve(serverRoot, file) })),
    compatibilityDate: workerConfig.compatibility_date,
    compatibilityFlags: workerConfig.compatibility_flags,
    d1Databases: { DB: "self-hosted-fixture" },
    bindings: {
      MICET_SELF_HOSTED: "1",
      MICET_SITE_ORIGIN: siteOrigin,
      MICET_BRIDGE_SECRET: bridgeSecret,
    },
  });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database("DB");
  async function applyMigration(migration) {
    const sql = await readFile("drizzle/" + migration, "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map(part => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  await applyMigration("0000_workable_the_leader.sql");

  async function request(path, status, { body, cookie, origin = siteOrigin, secret, headers = {} } = {}) {
    const response = await worker.dispatchFetch(base + "/api/" + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(secret ? { "X-Micet-Bridge": secret } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.text();
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/, path + ": " + payload);
    const json = JSON.parse(payload);
    assert.equal(response.status, status, path + ": " + JSON.stringify(json));
    return { json, cookies: response.headers.getSetCookie() };
  }

  const bridge = (action, body = {}, status = 200) => request("bridge/" + action, status, { body, secret: bridgeSecret });
  const browser = (action, status = 200, options) => request("micet/" + action, status, options);

  await request("bridge/poll", 401, { body: {}, secret: "invalid" });
  assert.equal((await bridge("poll")).json.job, null);
  assert.equal((await browser("status")).json.linked, null);
  const missingSchema = await browser("code", 503, { body: {} });
  assert.match(missingSchema.json.error, /数据库尚未初始化/);
  await applyMigration("0001_website_binding.sql");
  await browser("player?name=bad%20name", 400);
  await browser("checkout", 404, { body: { sku: "micet-test" } });
  await browser("code", 403, { body: {}, origin: "https://other.example.invalid" });
  await browser("stats", 401, { body: { kind: "matches" }, headers: {
    "oai-authenticated-user-id": "fake", "oai-authenticated-user-email": "fake@example.invalid",
  } });

  await Promise.all([browser("leaderboard", 202), browser("leaderboard", 202)]);
  const { job: leaderboard } = (await bridge("poll")).json;
  assert.equal(leaderboard.kind, "boards");
  assert.equal((await bridge("poll")).json.job, null);
  const exampleBoards = [{ id: "global", name: "综合", entries: [{ uuid: randomUUID(), player: "GameTester", elo: 1820 }] }];
  await bridge("receipt", { id: leaderboard.id, lease: leaderboard.lease, outcome: "ok", data: exampleBoards });
  assert.deepEqual((await browser("leaderboard")).json.data, exampleBoards);
  assert.equal((await bridge("poll")).json.job, null);
  await browser("player?name=GameTester", 202);
  await browser("player?name=gametester", 202);
  const { job: profile } = (await bridge("poll")).json;
  assert.equal(profile.kind, "profile");
  assert.equal(profile.payload.name, "GameTester");
  await bridge("receipt", { id: profile.id, lease: profile.lease, outcome: "ok", data: { player: "GameTester", scores: [] } });
  assert.equal((await browser("player?name=GAMETESTER")).json.data.player, "GameTester");

  async function link(player) {
    const uuid = randomUUID();
    const result = await browser("code", 200, { body: {}, headers: { "CF-Connecting-IP": "192.0.2.10" } });
    assert.match(result.cookies[0], /^__Host-micet-challenge=[0-9a-f]{64}; Path=\/; Max-Age=300; Secure; HttpOnly; SameSite=Strict$/);
    const challenge = result.cookies[0].split(";")[0];
    await browser("confirm", 409, { body: {}, cookie: challenge });
    await bridge("link", { code: result.json.code, uuid, player });
    await bridge("link", { code: result.json.code, uuid, player }, 404);
    await browser("confirm", 404, { body: {} });
    const confirmed = await browser("confirm", 200, { body: {}, cookie: challenge });
    assert.deepEqual(confirmed.json.linked, { uuid, player });
    assert.match(confirmed.cookies[0], /^__Host-micet-session=[0-9a-f]{64}; Path=\/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict$/);
    await browser("confirm", 409, { body: {}, cookie: challenge });
    return { uuid, session: confirmed.cookies[0].split(";")[0] };
  }

  const alice = await link("FixtureAlice");
  const bob = await link("FixtureBob");
  assert.equal((await browser("status", 200, { cookie: alice.session })).json.linked.uuid, alice.uuid);
  const matchId = randomUUID();
  const history = await browser("stats", 202, {
    body: { kind: "match-detail", matchId, uuid: bob.uuid },
    cookie: alice.session,
  });
  const { job } = (await bridge("poll")).json;
  assert.equal(job.id, history.json.pending);
  assert.equal(job.payload.uuid, alice.uuid);
  assert.equal(job.payload.matchId, matchId);
  const filledInventory = Array.from({ length: 36 }, () => ({ material: "DIAMOND_SWORD", lore: Array(7).fill("测试".repeat(50)) }));
  const detail = {
    id: matchId,
    snapshot: { uuid: alice.uuid, inventory: filledInventory },
    otherSnapshots: [{ uuid: bob.uuid, inventory: filledInventory }],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) > 100_000);
  await bridge("receipt", { id: job.id, lease: job.lease, outcome: "ok", data: detail });
  await browser("result?id=" + job.id, 401);
  await browser("result?id=" + job.id, 404, { cookie: bob.session });
  assert.deepEqual((await browser("result?id=" + job.id, 200, { cookie: alice.session })).json.data, detail);
  await browser("logout", 200, { body: {}, cookie: alice.session });
  await browser("result?id=" + job.id, 401, { cookie: alice.session });
  assert.equal((await browser("status", 200, { cookie: alice.session })).json.linked, null);
});

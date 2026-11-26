import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { buildWranglerArgs, resolveUpstreamProtocol } from "../scripts/run-local.mjs";

const siteOrigin = "https://micet-test.example.invalid";
const bridgeSecret = "micet-self-hosted-integration-fixture-secret";

async function startWorker(t, bindings) {
  const serverRoot = resolve("dist/server");
  const workerConfig = JSON.parse(await readFile(resolve(serverRoot, "wrangler.json"), "utf8"));
  const dependencies = (await readdir(serverRoot, { recursive: true })).filter(file => /\.m?js$/.test(file) && file !== workerConfig.main);
  const worker = new Miniflare(convertV4MiniflareOptions({
    modulesRoot: serverRoot,
    modules: [workerConfig.main, ...dependencies].map(file => ({ type: "ESModule", path: resolve(serverRoot, file) })),
    compatibilityDate: workerConfig.compatibility_date,
    compatibilityFlags: workerConfig.compatibility_flags,
    d1Databases: { DB: "self-hosted-fixture" },
    bindings,
  }));
  t.after(() => worker.dispose());
  return worker;
}

test("a retired display-only configuration cannot expose preview or live checkout", async t => {
  for (const bindings of [{ MICET_LOCAL_TEST: "1" }, { MICET_SELF_HOSTED: "1" }]) {
    const worker = await startWorker(t, { ...bindings, MICET_PUBLIC_LAUNCH: "1" });
    for (const [method, path] of [["GET", "/"], ["GET", "/api/micet/shop"], ["POST", "/api/micet/checkout"]]) {
      const response = await worker.dispatchFetch("http://localhost" + path, { method });
      assert.equal(response.status, 503, method + " " + path);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.match((await response.json()).error, /配置已过期/);
    }
  }
});

test("self-hosted account binding and read-only bridge", async t => {
  const base = "http://localhost";
  const worker = await startWorker(t, {
    MICET_SELF_HOSTED: "1",
    MICET_SITE_ORIGIN: siteOrigin,
    MICET_BRIDGE_SECRET: bridgeSecret,
  });
  const home = await worker.dispatchFetch(base + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  for (const view of ["stats", "ranking", "matches", "account", "shop"]) {
    assert.ok(html.includes('href="#' + view + '"'), "Missing navigation for " + view);
  }
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
  await browser("code", 403, { body: {}, headers: { "Sec-Fetch-Site": "cross-site" } });
  await browser("code", 403, { body: {}, headers: { "Sec-Fetch-Site": "same-site" } });
  await browser("code", 403, { body: {}, headers: { "Sec-Fetch-Site": "none" } });
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

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function sendHttp(port, method, path, headers = {}, body) {
  return new Promise((resolveResponse, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(payload === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        }),
        ...headers,
      },
    }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolveResponse({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test("local runner selects https upstream protocol for self-hosted deployments", async t => {
  const dir = await mkdtemp(join(tmpdir(), "micet-runner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "wrangler.json");
  await writeFile(configPath, "{}\n", "utf8");

  assert.equal(resolveUpstreamProtocol(["--config", configPath, "--var", "MICET_LOCAL_TEST:1"], {}), null);
  assert.equal(resolveUpstreamProtocol(["--config", configPath, "--var", "MICET_SELF_HOSTED:1"], {}), "https");
  assert.equal(
    resolveUpstreamProtocol(["--config", configPath, "--var", "MICET_SITE_ORIGIN:https://micet.cc.cd"], {}),
    "https",
  );
  assert.equal(
    resolveUpstreamProtocol(["--config", configPath, "--var", "MICET_SELF_HOSTED:1", "--upstream-protocol", "http"], {}),
    null,
  );

  await writeFile(join(dir, ".dev.vars"), "MICET_SELF_HOSTED=1\nMICET_SITE_ORIGIN=https://micet.cc.cd\n", "utf8");
  assert.equal(resolveUpstreamProtocol(["--config", configPath], {}), "https");
  assert.equal(resolveUpstreamProtocol(["--config", configPath, "--var", "MICET_SELF_HOSTED:0"], {}), null);
  const args = buildWranglerArgs(["--config", configPath, "--port", "8787"], {
    reconcileToken: "test-token",
    statusUrl: "http://127.0.0.1:9999/status",
    env: {},
  });
  const protoIdx = args.indexOf("--upstream-protocol");
  assert.ok(protoIdx > 0 && args[protoIdx + 1] === "https");
});

test("self-hosted wrangler proxy preserves HTTPS Origin behind Cloudflare Tunnel", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "micet-tunnel-"));
  const envFile = join(dir, "self-hosted.dev.vars");
  const stateDir = join(dir, "state");
  const publicHost = "micet-tunnel.example.invalid";
  const publicOrigin = "https://" + publicHost;
  await writeFile(
    envFile,
    `MICET_SELF_HOSTED=1\nMICET_SITE_ORIGIN=${publicOrigin}\nMICET_BRIDGE_SECRET=${bridgeSecret}\n`,
    "utf8",
  );

  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["scripts/run-local.mjs", "start", "--port", String(port), "--persist-to", stateDir, "--env-file", envFile],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MICET_STATUS_URL: "http://127.0.0.1:9/status" },
    },
  );
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  try {
    for (let i = 0; i < 80; i++) {
      if (output.includes("Ready on")) break;
      if (child.exitCode !== null) assert.fail("run-local exited early:\n" + output);
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(output.includes("Ready on"), "Wrangler did not become ready:\n" + output);

    const tunnelHeaders = {
      Host: publicHost,
      Origin: publicOrigin,
      "X-Forwarded-Proto": "https",
      "Sec-Fetch-Site": "same-origin",
    };

    // Valid HTTPS Origin arriving over local HTTP tunnel must not be downgraded to http:// and rejected with 403.
    const recipient = await sendHttp(port, "POST", "/api/micet/recipient", tunnelHeaders, { player: "TestPlayer" });
    assert.equal(recipient.status, 202, recipient.body);
    assert.deepEqual(JSON.parse(recipient.body), { checking: true });

    // Order lookup validates input (400) rather than failing origin check (403).
    const lookup = await sendHttp(port, "POST", "/api/micet/order-lookup", tunnelHeaders, { contact: "bad", password: "short" });
    assert.equal(lookup.status, 400, lookup.body);

    // Cross-origin, missing-origin, and cross-scheme requests must still be rejected with 403.
    const evilOrigin = await sendHttp(port, "POST", "/api/micet/recipient", {
      ...tunnelHeaders,
      Origin: "https://evil.example.invalid",
    }, { player: "TestPlayer" });
    assert.equal(evilOrigin.status, 403, evilOrigin.body);
    assert.equal(JSON.parse(evilOrigin.body).error, "请求来源无效。");

    const missingOrigin = await sendHttp(port, "POST", "/api/micet/recipient", {
      Host: publicHost,
      "X-Forwarded-Proto": "https",
    }, { player: "TestPlayer" });
    assert.equal(missingOrigin.status, 403, missingOrigin.body);

    const crossScheme = await sendHttp(port, "POST", "/api/micet/recipient", {
      Host: publicHost,
      Origin: "http://" + publicHost,
      "X-Forwarded-Proto": "https",
      "Sec-Fetch-Site": "cross-site",
    }, { player: "TestPlayer" });
    assert.equal(crossScheme.status, 403, crossScheme.body);

    // Relative redirects stay relative and are not rewritten to http://.
    const ret = await sendHttp(port, "GET", "/api/payments/return", {
      Host: publicHost,
      "X-Forwarded-Proto": "https",
    });
    assert.equal(ret.status, 303);
    assert.equal(ret.headers.location, "/#orders");
  } finally {
    if (child.exitCode === null) {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        child.kill("SIGINT");
      }
    }
    await new Promise(resolveExit => {
      if (child.exitCode !== null) return resolveExit();
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolveExit();
      }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
    child.stdout.destroy();
    child.stderr.destroy();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

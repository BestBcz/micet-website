import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const demo = "http://127.0.0.1:8787";
const bridge = "http://127.0.0.1:8788";
const fixtureSecret = "micet-integration-fixture-secret-local";

async function request(base, path, { body, owner, secret, origin = base, status = 200 } = {}) {
  const response = await fetch(base + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Connection: "close",
      ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
      ...(owner ? { "oai-authenticated-user-id": owner, "oai-authenticated-user-email": "local-fixture@example.invalid" } : {}),
      ...(secret ? { "X-Micet-Bridge": secret } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.text();
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/, path + ": " + payload);
  const data = JSON.parse(payload);
  assert.equal(response.status, status, path + ": " + JSON.stringify(data));
  return data;
}

const demoRequest = (action, options) => request(demo, "micet/" + action, options);
const stats = (kind, name) => demoRequest("stats", { body: { kind, name } });
const roster = await stats("boards");
assert.equal(roster.data[0].entries.length, 10);
assert.equal(roster.data[0].entries[0].player, "KairoPvP");
assert.notEqual(roster.data[0].entries[0].player, roster.data.find(board => board.id === "boxing").entries[0].player);
assert.equal((await stats("profile", "kAiRoPvP")).data.scores[0].elo, 2184);
assert.equal((await stats("profile", "NoSuchPlayer")).data, null);
await demoRequest("stats", { body: { kind: "profile", name: "<script>" }, status: 400 });
await demoRequest("code", { body: {}, origin: "https://example.invalid", status: 403 });
const { code } = await demoRequest("code", { body: {} });
const linked = await demoRequest("demo-link", { body: { code } });
assert.equal(linked.linked.player, "KairoPvP");
await demoRequest("demo-link", { body: { code }, status: 404 });
assert.equal((await stats("matches")).data.length, 4);
await demoRequest("stats", { owner: "unbound-local", body: { kind: "matches", uuid: linked.linked.uuid }, status: 403 });
await demoRequest("checkout", { body: { sku: "vip" }, status: 400 });

const demoOrder = await demoRequest("checkout", { body: { sku: "micet-test" } });
const sameDemoOrder = await demoRequest("checkout", { body: { sku: "micet-test" } });
assert.equal(demoOrder.order.id, sameDemoOrder.order.id);
await demoRequest("pay", { body: { id: demoOrder.order.id } });
await demoRequest("pay", { body: { id: demoOrder.order.id } });
await new Promise(resolve => setTimeout(resolve, 1550));
await demoRequest("demo-progress", { body: {} });
const { orders } = await demoRequest("orders");
assert.equal(orders.length, 1);
assert.equal(orders[0].status, "delivered");
assert.equal(orders[0].detail, "模拟回执");
console.log("Demo leaderboard, profile, private match history, binding, and idempotent checkout passed.");

const owner = "fixture-" + randomUUID();
const game = { uuid: randomUUID(), player: "GameTester" };
const browser = (action, options = {}) => request(bridge, "micet/" + action, { owner, ...options });
const service = (action, body, status = 200) => request(bridge, "bridge/" + action, { body, status, secret: fixtureSecret });
await request(bridge, "bridge/poll", { body: {}, status: 401 });
await browser("stats", { body: { kind: "boards" }, status: 503 });
const bridgeCode = await browser("code", { body: {} });
await service("link", { ...game, code: bridgeCode.code });
assert.deepEqual((await browser("status")).linked, game);
await service("link", { ...game, code: bridgeCode.code }, 404);

await service("poll", {});
const query = await browser("stats", { status: 202, body: { kind: "matches", uuid: randomUUID() } });
const queryWork = (await service("poll", {})).job;
assert.equal(queryWork.id, query.pending);
assert.equal(queryWork.payload.uuid, game.uuid);
await browser("result?id=" + query.pending, { owner: "other-owner", status: 404 });
await service("receipt", { id: queryWork.id, lease: queryWork.lease, outcome: "ok", data: [] });
assert.deepEqual(await browser("result?id=" + query.pending), { status: "done", data: [] });

const { order } = await browser("checkout", { body: { sku: "micet-test" } });
await browser("pay", { body: { id: order.id } });
await browser("pay", { body: { id: order.id } });
const initial = (await service("poll", {})).job;
assert.equal(initial.kind, "delivery");
assert.equal(initial.id, order.id);
assert.equal(initial.payload.uuid, game.uuid);
assert.equal((await browser("orders")).orders[0].status, "paid");
assert.equal((await service("poll", {})).job, null);
await new Promise(resolve => setTimeout(resolve, 20_200));
const retried = (await service("poll", {})).job;
assert.equal(retried.id, initial.id);
assert.notEqual(retried.lease, initial.lease);
assert.equal((await service("receipt", { ...initial, outcome: "ok" })).ignored, true);
await service("receipt", { ...retried, outcome: "ok" });
assert.equal((await service("receipt", { ...retried, outcome: "ok" })).ignored, true);
assert.equal((await browser("orders")).orders[0].status, "delivered");
assert.equal((await service("poll", {})).job, null);
console.log("Bridge authentication, scoped queries, offline handling, lease recovery, and duplicate receipts passed.");

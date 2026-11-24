import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { formatStatus, requestJavaStatus, startStatusServer } from "../scripts/minecraft-status.mjs";

test("native query reads a fragmented Java status frame with server formatting", async () => {
  const fixture = {
    description: { text: "MiCet ", color: "aqua", bold: true, extra: [{ text: "Practice\n", color: "#1feaff" }, { text: "Java", bold: false }] },
    players: { online: 10, max: 1314 },
  };
  const payload = Buffer.from(JSON.stringify(fixture), "utf-8");
  const varint = number => number < 128 ? Buffer.from([number]) : Buffer.from([number % 128 + 128, Math.floor(number / 128)]);
  const packet = Buffer.concat([Buffer.from([0]), varint(payload.length), payload]);
  const framed = Buffer.concat([varint(packet.length), packet]);
  let request;
  const server = createServer(socket => {
    socket.once("data", bytes => {
      request = bytes;
      socket.write(framed.subarray(0, 1));
      setImmediate(() => socket.end(framed.subarray(1)));
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const data = await requestJavaStatus({ host: "127.0.0.1", port: server.address().port, timeout: 1000 });
    assert.deepEqual(data, fixture);
    assert.equal(request.includes(Buffer.from("micet.cc")), true);
    const result = formatStatus(data);
    assert.equal(result.state, "online");
    assert.equal(result.onlinePlayers, 10);
    assert.equal(result.maxPlayers, 1314);
    assert.equal(result.motd.length, 2);
    assert.match(result.motd[0], /§b§lMiCet/);
    assert.match(result.motd[0], /§x§1§f§e§a§f§f§lPractice/);
    assert.match(result.motd[1], /§bJava/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("native status service coalesces simultaneous requests", async () => {
  let pings = 0;
  const server = await startStatusServer({ query: async () => {
    pings++;
    const data = formatStatus({ description: "§aOK", players: { online: 0, max: 10 } });
    return data;
  } });
  try {
    const url = "http://127.0.0.1:" + server.address().port + "/status";
    const responses = await Promise.all([fetch(url), fetch(url)]);
    assert.equal(pings, 1);
    assert.equal((await responses[0].json()).onlinePlayers, 0);
    assert.equal(responses[1].headers.get("cache-control"), "no-store");
    await responses[1].json();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

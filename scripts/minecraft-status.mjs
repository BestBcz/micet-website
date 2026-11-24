import { createServer } from "node:http";
import { createConnection } from "node:net";
import { Resolver } from "node:dns/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_ADDRESS } from "../lib/micet-server-status.ts";

const maxPacket = 128 * 1024;
const defaultPort = 25565;
const resolver = new Resolver({ timeout: 1200, tries: 1 });
const namedColors = [
  "black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold", "gray",
  "dark_gray", "blue", "green", "aqua", "red", "light_purple", "yellow", "white",
];

function encodeVarInt(value) {
  const bytes = [];
  value >>>= 0;
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function decodeVarInt(buffer, offset = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null;
    const byte = buffer[offset + i];
    value += (byte & 127) * 2 ** (7 * i);
    if (!(byte & 128)) return { value, next: offset + i + 1 };
  }
  throw new Error("Invalid status packet length");
}

const frame = data => Buffer.concat([encodeVarInt(data.length), data]);

function statusRequest(address, port) {
  const host = Buffer.from(address, "utf8");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  const handshake = Buffer.concat([
    encodeVarInt(0), encodeVarInt(47), encodeVarInt(host.length), host, portBytes, encodeVarInt(1),
  ]);
  return Buffer.concat([frame(handshake), frame(encodeVarInt(0))]);
}

async function resolveGameAddress() {
  try {
    const records = await resolver.resolveSrv("_minecraft._tcp." + SERVER_ADDRESS);
    const priority = Math.min(...records.map(record => record.priority));
    const choices = records.filter(record => record.priority === priority && record.name && record.port > 0);
    if (choices.length) {
      const total = choices.reduce((sum, record) => sum + Math.max(1, record.weight), 0);
      let threshold = Math.random() * total;
      for (const record of choices) {
        threshold -= Math.max(1, record.weight);
        if (threshold < 0) return { host: record.name, port: record.port };
      }
    }
  } catch {
    // Domains without SRV use the Java Edition default port.
  }
  return { host: SERVER_ADDRESS, port: defaultPort };
}

export function requestJavaStatus({ host, port, address = SERVER_ADDRESS, timeout = 3500 }) {
  return new Promise((resolveStatus, reject) => {
    const socket = createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    const finish = (error, result) => {
      socket.destroy();
      if (error) reject(error);
      else resolveStatus(result);
    };
    socket.setTimeout(timeout, () => finish(new Error("Minecraft status timed out")));
    socket.once("connect", () => socket.write(statusRequest(address, port)));
    socket.once("error", finish);
    socket.once("end", () => finish(new Error("Minecraft server ended the status request")));
    socket.on("data", chunk => {
      try {
        if (buffer.length + chunk.length > maxPacket + 5) throw new Error("Status message too large");
        buffer = Buffer.concat([buffer, chunk]);
        const length = decodeVarInt(buffer);
        if (!length) return;
        if (length.value < 2 || length.value > maxPacket) throw new Error("Invalid status message length");
        const end = length.next + length.value;
        if (buffer.length < end) return;
        const packet = buffer.subarray(length.next, end);
        const id = decodeVarInt(packet);
        const message = id && decodeVarInt(packet, id.next);
        if (id?.value !== 0 || !message || message.next + message.value !== packet.length) {
          throw new Error("Invalid Minecraft status response");
        }
        const status = JSON.parse(packet.toString("utf8", message.next));
        if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Invalid Minecraft status");
        finish(null, status);
      } catch (error) {
        finish(error);
      }
    });
  });
}

function prefix(style) {
  let result = "§r";
  if (typeof style.color === "string") {
    const index = namedColors.indexOf(style.color);
    if (index >= 0) result += "§" + index.toString(16);
    else if (/^#[a-f\d]{6}$/i.test(style.color)) result += "§x" + [...style.color.slice(1)].map(digit => "§" + digit).join("");
  }
  for (const [flag, code] of [["obfuscated", "k"], ["bold", "l"], ["strikethrough", "m"], ["underlined", "n"], ["italic", "o"]]) {
    if (style[flag]) result += "§" + code;
  }
  return result;
}

function formatDescription(component, inherited = {}, depth = 0) {
  if (depth > 16) return "";
  if (typeof component === "string") return prefix(inherited) + component;
  if (Array.isArray(component)) return component.slice(0, 64).map(child => formatDescription(child, inherited, depth + 1)).join("");
  if (!component || typeof component !== "object") return "";
  const style = { ...inherited };
  for (const key of ["color", "obfuscated", "bold", "strikethrough", "underlined", "italic"]) {
    if (Object.hasOwn(component, key)) style[key] = component[key];
  }
  const codes = prefix(style);
  const text = typeof component.text === "string" ? component.text
    : typeof component.fallback === "string" ? component.fallback
    : typeof component.translate === "string" ? component.translate : "";
  return codes + text.replaceAll("\n", "\n" + codes)
    + (Array.isArray(component.extra) ? component.extra.slice(0, 64).map(child => formatDescription(child, style, depth + 1)).join("") : "");
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const empty = { state: "unreachable", motd: [], onlinePlayers: null, maxPlayers: null, icon: null };

export function formatStatus(data) {
  const motd = formatDescription(data.description).split(/\r?\n/).slice(0, 2)
    .map(line => line.slice(0, 640).replace(/[\u0000-\u001f\u007f]/g, ""))
    .filter(line => line.replace(/§[a-z\d]/gi, "").trim());
  const icon = typeof data.favicon === "string" && data.favicon.length <= 50_000
    && /^data:image\/png;base64,[a-z\d+/]+=*$/i.test(data.favicon) ? data.favicon : null;
  return {
    state: "online", motd, icon,
    onlinePlayers: count(data.players?.online),
    maxPlayers: count(data.players?.max),
  };
}

export async function queryServer() {
  try {
    const endpoint = await resolveGameAddress();
    return formatStatus(await requestJavaStatus(endpoint));
  } catch {
    return empty;
  }
}

export async function startStatusServer({ port = 0, host = "127.0.0.1", query = queryServer } = {}) {
  let cached;
  let validUntil = 0;
  let pending;

  async function status() {
    if (cached && Date.now() < validUntil) return cached;
    if (!pending) pending = query().catch(() => empty).then(result => {
      cached = result;
      validUntil = Date.now() + (result.state === "online" ? 1000 : 3000);
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  }

  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/status") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(await status()));
  });

  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(port, host, ready);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MICET_STATUS_PORT ?? 8795);
  const server = await startStatusServer({ port });
  console.log("Native Minecraft status at http://127.0.0.1:" + server.address().port + "/status");
}

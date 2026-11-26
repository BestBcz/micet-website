import { env } from "cloudflare:workers";
import { RequestError } from "./micet-http";

export type XDChannel = "ALIPAY_H5" | "WECHAT_H5";
export type Fields = Record<string, unknown>;
const utf8 = new TextEncoder();
const rsa = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const base64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function hash(raw: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
function pem(value: string) {
  return bytes(value.replace(/-----[^-]+-----/g, "").replace(/\\n|\s/g, ""));
}
export function channels(): XDChannel[] {
  if (!env.XD_BASE_URL || !env.XD_APP_ID || !env.XD_KEY_ID || !env.XD_PRIVATE_KEY ||
      !env.XD_PLATFORM_KEYS) return [];
  const enabled = env.XD_CHANNELS?.split(",").map(x => x.trim());
  return (["ALIPAY_H5", "WECHAT_H5"] as const).filter(x => enabled?.includes(x));
}
function header(h: Headers, key: string) {
  const value = h.get(key);
  if (!value || value.length > 2048 || /[,\r\n]/.test(value)) throw new RequestError(400, "支付签名头无效。");
  return value;
}
async function verify(kid: string, ts: string, signature: string, lines: string[], raw: Uint8Array<ArrayBuffer>) {
  if (!/^\d{10}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new RequestError(401, "支付签名已过期。");
  const keys = JSON.parse(env.XD_PLATFORM_KEYS || "{}");
  if (!Object.hasOwn(keys, kid) || typeof keys[kid] !== "string") throw new RequestError(401, "未知平台密钥。");
  const key = await crypto.subtle.importKey("spki", pem(keys[kid]), rsa, false, ["verify"]);
  const message = utf8.encode([...lines, await hash(raw)].join("\n"));
  let valid = false;
  try { valid = await crypto.subtle.verify(rsa.name, key, bytes(signature), message); } catch { /* Invalid Base64. */ }
  if (!valid) throw new RequestError(401, "支付签名无效。");
}

export class GatewayRejection extends RequestError {
  constructor(readonly gatewayStatus: number, id: string, readonly code: unknown) {
    super(502, "支付平台暂未受理，请求编号 " + id);
  }
}

export async function xdRequest(path: string, body?: Fields, id: string = crypto.randomUUID()): Promise<Fields> {
  const method = body ? "POST" : "GET";
  const content = body ? "application/json" : "";
  const raw = utf8.encode(body ? JSON.stringify(body) : "");
  const url = new URL((env.XD_BASE_URL ?? "").replace(/\/$/, "") + path);
  if (url.protocol !== "https:" || url.search || url.hash) throw new RequestError(503, "支付网关配置无效。");
  const nonce = crypto.randomUUID(), ts = String(Math.floor(Date.now()/1000));
  const app = env.XD_APP_ID!, kid = env.XD_KEY_ID!;
  const signed = ["XD-Signature-v1", method, decodeURIComponent(url.pathname), "", ts, nonce, app, kid, id, content, await hash(raw)].join("\n");
  const key = await crypto.subtle.importKey("pkcs8", pem(env.XD_PRIVATE_KEY!), rsa, false, ["sign"]);
  const signature = base64(await crypto.subtle.sign(rsa.name, key, utf8.encode(signed)));
  const response = await fetch(url, { method, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8000),
    headers: { "X-XD-App-Id": app, "X-XD-Key-Id": kid, "X-XD-Timestamp": ts, "X-XD-Nonce": nonce,
      "X-XD-Request-Id": id, "X-XD-Sign": signature, ...(body ? {"Content-Type":content} : {}) }, body: body ? raw : undefined })
    .catch(() => { throw new RequestError(503,"支付平台连接中断，请稍后从原订单重试。"); });
  const data = new Uint8Array(await response.arrayBuffer());
  if (!response.headers.has("X-XD-Response-Sign")) throw new RequestError(502, "支付网关未确认请求，请联系管理员。请求编号 " + id);
  const h = response.headers, rk = header(h,"X-XD-Response-Key-Id"), rt = header(h,"X-XD-Response-Timestamp");
  await verify(rk, rt, header(h,"X-XD-Response-Sign"), ["XD-Response-v1", String(response.status),
    header(h,"Content-Type").split(";")[0].trim().toLowerCase(), id, rt, header(h,"X-XD-Response-Nonce"), rk], data);
  const payload = JSON.parse(new TextDecoder().decode(data));
  if (!response.ok) throw new GatewayRejection(response.status, id, payload?.code);
  return payload;
}

export async function readEvent(request: Request) {
  const h = request.headers, id = header(h,"X-XD-Webhook-Event-Id"), type = header(h,"X-XD-Webhook-Event-Type");
  const kid = header(h,"X-XD-Webhook-Key-Id"), ts = header(h,"X-XD-Webhook-Timestamp");
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400,"回调为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new RequestError(413,"回调过大。"); }
    chunks.push(value);
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { raw.set(c,offset); offset += c.length; }
  await verify(kid,ts,header(h,"X-XD-Webhook-Signature"),["XD-Webhook-v1",id,type,ts,header(h,"X-XD-Webhook-Nonce"),kid],raw);
  const event: Fields = JSON.parse(new TextDecoder().decode(raw));
  if (event.eventId !== id || event.eventType !== type || event.appId !== env.XD_APP_ID) throw new RequestError(400,"支付事件不匹配。");
  return event;
}

export function paymentUrl(value: unknown, origin: string | undefined) {
  if (typeof value !== "string" || !/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && (!origin || url.origin === origin)) return value;
  } catch { /* Missing or malformed payment material. */ }
  return null;
}

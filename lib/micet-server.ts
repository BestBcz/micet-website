import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { demoMatchPattern, getDemoMatchDetail, matchUuidPattern } from "./micet-match-detail";
import { getServerStatus } from "./micet-server-status";
import { DEMO_PLAYER, TEST_SKU, demoBoards, getDemoMatches, getDemoProfile, type Link, type Mode, type Order } from "./micet-data";

type Body = Record<string, unknown>;
type Job = {
  id: string; owner: string; kind: string; mode: Mode; payload: string; status: string;
  created_at: number; expires_at: number | null; lease: string | null; lease_until: number | null; result: string | null;
};

const playerPattern = /^[A-Za-z0-9_]{1,16}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jobKinds = ["boards", "profile", "matches", "match-detail"];
const codeLifetime = 5 * 60_000;
const queryLifetime = 45_000;
const leaseLifetime = 20_000;

class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function micetMode(): Mode {
  return env.MICET_MODE === "bridge" ? "bridge" : "demo";
}

export function isPublicLaunch(): boolean {
  return env.MICET_PUBLIC_LAUNCH === "1";
}

function database(): D1Database {
  if (!env.DB) throw new RequestError(503, "站点数据库暂不可用。");
  return env.DB;
}

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});

async function ownerId(request: Request) {
  const user = await getChatGPTUser();
  if (user) return user.userId;
  const host = new URL(request.url).hostname;
  if (env.MICET_LOCAL_TEST === "1" && ["localhost", "127.0.0.1"].includes(host)) return "micet-local";
  throw new RequestError(401, "请先登录站点。");
}

async function readBody(request: Request): Promise<Body> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "请求格式无效。");
  const decoder = new TextDecoder();
  let content = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 100_000) {
      await reader.cancel();
      throw new RequestError(413, "请求过大。");
    }
    content += decoder.decode(value, { stream: true });
  }
  content += decoder.decode();
  try {
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Body;
  } catch {
    throw new RequestError(400, "请求格式无效。");
  }
}

function stringField(body: Body, key: string) {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hashCode(code: string) {
  return Array.from(await digest(code.toUpperCase()), c => c.toString(16).padStart(2, "0")).join("");
}

async function requireBridge(request: Request) {
  const configured = env.MICET_BRIDGE_SECRET;
  const supplied = request.headers.get("X-Micet-Bridge") ?? "";
  if (micetMode() !== "bridge" || !configured || configured.length < 32 || supplied.length > 256) {
    throw new RequestError(401, "桥接未授权。");
  }
  const [a, b] = await Promise.all([digest(supplied), digest(configured)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  if (mismatch) throw new RequestError(401, "桥接未授权。");
}

function playerLink(db: D1Database, owner: string, mode: Mode) {
  return db.prepare("SELECT uuid, player FROM links WHERE owner=? AND mode=?").bind(owner, mode).first<Link>();
}

async function linkStatus(db: D1Database, mode: Mode) {
  if (mode === "demo") return true;
  const row = await db.prepare("SELECT seen_at FROM bridge_state WHERE id='game'").first<{ seen_at: number }>();
  return Boolean(row && row.seen_at > Date.now() - 35_000);
}

async function consumeCode(db: D1Database, code: string, mode: Mode, link: Link, owner?: string) {
  if (!/^[A-Z2-9]{10}$/i.test(code)) throw new RequestError(400, "验证码格式有误。");
  const hash = await hashCode(code);
  const now = Date.now();
  const source = "hash=? AND mode=? AND expires_at>? AND (? IS NULL OR owner=?)";
  try {
    const [insert] = await db.batch([
      db.prepare("INSERT INTO links (owner,mode,uuid,player) SELECT owner,mode,?,? FROM link_codes WHERE " + source
        + " ON CONFLICT(owner,mode) DO UPDATE SET uuid=excluded.uuid,player=excluded.player")
        .bind(link.uuid, link.player, hash, mode, now, owner ?? null, owner ?? null),
      db.prepare("DELETE FROM link_codes WHERE " + source).bind(hash, mode, now, owner ?? null, owner ?? null),
    ]);
    if (!insert.meta.changes) throw new RequestError(404, "验证码已失效，请在站点重新生成。");
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (String(error).includes("UNIQUE")) throw new RequestError(409, "这个游戏账号已绑定到其他站点账号。");
    throw error;
  }
}

async function browserGet(db: D1Database, action: string, request: Request, owner: string, mode: Mode) {
  if (action === "status") {
    const [linked, connected] = await Promise.all([playerLink(db, owner, mode), linkStatus(db, mode)]);
    return json({ mode, linked, connected });
  }
  if (action === "orders") {
    const { results } = await db.prepare("SELECT id,sku,player,status,mode,created_at,detail FROM micet_orders WHERE owner=? AND mode=? ORDER BY created_at DESC LIMIT 30")
      .bind(owner, mode).all<Order>();
    return json({ orders: results });
  }
  if (action === "result") {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    const job = await db.prepare("SELECT kind,payload,status,result FROM bridge_jobs WHERE id=? AND owner=? AND mode=? AND expires_at>?")
      .bind(id, owner, mode, Date.now()).first<Pick<Job, "kind" | "payload" | "status" | "result">>();
    if (!job) throw new RequestError(404, "查询已过期，请重新尝试。");
    if (job.kind === "match-detail" || job.kind === "matches") {
      const linked = await playerLink(db, owner, mode);
      if (linked?.uuid !== JSON.parse(job.payload).uuid) throw new RequestError(404, "查询已过期，请重新尝试。");
    }
    return json({ status: job.status, data: job.result ? JSON.parse(job.result) : null });
  }
  throw new RequestError(404, "找不到页面。");
}

async function stats(db: D1Database, body: Body, owner: string, mode: Mode) {
  const kind = stringField(body, "kind");
  if (!jobKinds.includes(kind)) throw new RequestError(400, "无效的查询类型。");
  const name = stringField(body, "name");
  if (kind === "profile" && !playerPattern.test(name)) throw new RequestError(400, "请输入有效的 Minecraft 玩家名。");
  const matchId = stringField(body, "matchId").toLowerCase();
  const target = stringField(body, "target").toLowerCase();
  if (kind === "match-detail") {
    const pattern = mode === "demo" ? demoMatchPattern : matchUuidPattern;
    if (!pattern.test(matchId) || (target && !matchUuidPattern.test(target))) {
      throw new RequestError(400, "对局或玩家编号无效。");
    }
  }
  const needsPlayer = kind === "matches" || kind === "match-detail";
  const link = needsPlayer ? await playerLink(db, owner, mode) : null;
  if (needsPlayer && !link) throw new RequestError(403, "绑定游戏账号后即可查看对局。");
  if (mode === "demo") {
    if (kind === "match-detail") return json({ data: getDemoMatchDetail(link!.uuid, matchId, target) });
    const data = kind === "boards" ? demoBoards : kind === "profile" ? getDemoProfile(name) : getDemoMatches(link!.uuid);
    return json({ data });
  }
  if (!await linkStatus(db, mode)) throw new RequestError(503, "测试服桥接离线，请稍后再试。");
  const now = Date.now();
  await db.prepare("DELETE FROM bridge_jobs WHERE expires_at IS NOT NULL AND expires_at<=?").bind(now).run();
  const pending = await db.prepare("SELECT COUNT(*) AS count FROM bridge_jobs WHERE owner=? AND expires_at>? AND status IN ('queued','leased')")
    .bind(owner, now).first<{ count: number }>();
  if ((pending?.count ?? 0) >= 6) throw new RequestError(429, "查询过多，请稍后再试。");
  const id = crypto.randomUUID();
  const payload = JSON.stringify(link ? { uuid: link.uuid, player: link.player, ...(kind === "match-detail" ? { matchId, target } : {}) } : { name });
  await db.prepare("INSERT INTO bridge_jobs (id,owner,kind,mode,payload,status,created_at,expires_at) VALUES (?,?,?,?,?,'queued',?,?)")
    .bind(id, owner, kind, mode, payload, now, now + queryLifetime).run();
  return json({ pending: id }, 202);
}

async function orderAction(db: D1Database, action: string, body: Body, owner: string, mode: Mode) {
  const now = Date.now();
  if (action === "checkout") {
    if (stringField(body, "sku") !== TEST_SKU) throw new RequestError(400, "该标签仅供展示。");
    const link = await playerLink(db, owner, mode);
    if (!link) throw new RequestError(403, "请先绑定接收标签的游戏账号。");
    const id = crypto.randomUUID();
    await db.prepare("INSERT OR IGNORE INTO micet_orders (id,owner,uuid,player,sku,mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)")
      .bind(id, owner, link.uuid, link.player, TEST_SKU, mode, now, now).run();
    const order = await db.prepare("SELECT id,sku,player,status,mode,created_at,detail FROM micet_orders WHERE owner=? AND uuid=? AND mode=? AND sku=?")
      .bind(owner, link.uuid, mode, TEST_SKU).first<Order>();
    return json({ order });
  }
  if (action === "pay") {
    const id = stringField(body, "id");
    const row = await db.prepare("SELECT id,uuid,player,sku FROM micet_orders WHERE id=? AND owner=? AND mode=?")
      .bind(id, owner, mode).first<{ id: string; uuid: string; player: string; sku: string }>();
    if (!row) throw new RequestError(404, "找不到该订单。");
    const payload = JSON.stringify({ uuid: row.uuid, player: row.player, sku: row.sku });
    await db.batch([
      db.prepare("UPDATE micet_orders SET status='paid',updated_at=? WHERE id=? AND owner=? AND mode=? AND status='pending'")
        .bind(now, id, owner, mode),
      db.prepare("INSERT OR IGNORE INTO bridge_jobs (id,owner,kind,mode,payload,status,created_at) "
        + "SELECT id,owner,'delivery',mode,?,'queued',? FROM micet_orders WHERE id=? AND owner=? AND mode=? AND status='paid'")
        .bind(payload, now, id, owner, mode),
    ]);
    return json({ ok: true });
  }
  if (action === "demo-progress" && mode === "demo") {
    await db.batch([
      db.prepare("UPDATE micet_orders SET status='delivered',detail='模拟回执',updated_at=? WHERE owner=? AND mode='demo' AND status='paid' "
        + "AND id IN (SELECT id FROM bridge_jobs WHERE owner=? AND mode='demo' AND kind='delivery' AND status='queued' AND created_at<=?)")
        .bind(now, owner, owner, now - 1400),
      db.prepare("UPDATE bridge_jobs SET status='done' WHERE owner=? AND mode='demo' AND kind='delivery' AND status='queued' "
        + "AND id IN (SELECT id FROM micet_orders WHERE owner=? AND mode='demo' AND status='delivered')")
        .bind(owner, owner),
    ]);
    return json({ ok: true });
  }
  throw new RequestError(404, "找不到页面。");
}

async function browserPost(db: D1Database, action: string, body: Body, owner: string, mode: Mode) {
  if (action === "code") {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), value => alphabet[value & 31]).join("");
    const expiresAt = Date.now() + codeLifetime;
    await db.prepare("INSERT INTO link_codes (hash,owner,mode,expires_at) VALUES (?,?,?,?) "
      + "ON CONFLICT(owner,mode) DO UPDATE SET hash=excluded.hash,expires_at=excluded.expires_at")
      .bind(await hashCode(code), owner, mode, expiresAt).run();
    return json({ code, expiresAt });
  }
  if (action === "demo-link" && mode === "demo") {
    const { uuid, player } = getDemoProfile(DEMO_PLAYER)!;
    await consumeCode(db, stringField(body, "code"), mode, { uuid, player }, owner);
    return json({ linked: { uuid, player } });
  }
  if (action === "stats") return stats(db, body, owner, mode);
  return orderAction(db, action, body, owner, mode);
}

async function bridgePost(db: D1Database, action: string, body: Body) {
  const now = Date.now();
  if (action === "link") {
    const uuid = stringField(body, "uuid");
    const player = stringField(body, "player");
    if (!uuidPattern.test(uuid) || !playerPattern.test(player)) throw new RequestError(400, "游戏账号无效。");
    await consumeCode(db, stringField(body, "code"), "bridge", { uuid: uuid.toLowerCase(), player });
    return json({ ok: true });
  }
  if (action === "poll") {
    const lease = crypto.randomUUID();
    const [, , result] = await db.batch<Job>([
      db.prepare("INSERT INTO bridge_state (id,seen_at) VALUES ('game',?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at").bind(now),
      db.prepare("DELETE FROM bridge_jobs WHERE expires_at IS NOT NULL AND expires_at<=?").bind(now),
      db.prepare("UPDATE bridge_jobs SET status='leased',lease=?,lease_until=? WHERE id=(SELECT id FROM bridge_jobs WHERE mode='bridge' "
        + "AND (status='queued' OR (status='leased' AND lease_until<=?)) AND (expires_at IS NULL OR expires_at>?) "
        + "ORDER BY CASE WHEN kind='delivery' THEN 0 ELSE 1 END, created_at LIMIT 1) RETURNING *")
        .bind(lease, now + leaseLifetime, now, now),
    ]);
    const job = result.results[0];
    return json({ job: job ? { id: job.id, kind: job.kind, lease: job.lease, payload: JSON.parse(job.payload) } : null });
  }
  if (action === "receipt") {
    const id = stringField(body, "id");
    const lease = stringField(body, "lease");
    const job = await db.prepare("SELECT * FROM bridge_jobs WHERE id=? AND mode='bridge' AND lease=?").bind(id, lease).first<Job>();
    if (!job || job.status !== "leased") return json({ ignored: true });
    const outcome = stringField(body, "outcome");
    if (!["ok", "retry", "failed"].includes(outcome)) throw new RequestError(400, "回执状态无效。");
    if (outcome === "retry") return json({ ok: true });
    const data = outcome === "ok" ? body.data ?? null : null;
    const status = outcome === "ok" ? "done" : "failed";
    const complete = db.prepare("UPDATE bridge_jobs SET status=?,result=? WHERE id=? AND lease=? AND status='leased'")
      .bind(status, JSON.stringify(data), id, lease);
    if (job.kind === "delivery") {
      await db.batch([
        db.prepare("UPDATE micet_orders SET status=?,detail=?,updated_at=? WHERE id=? AND status='paid' AND mode='bridge' "
          + "AND EXISTS(SELECT 1 FROM bridge_jobs WHERE id=? AND lease=? AND status='leased')")
          .bind(outcome === "ok" ? "delivered" : "failed", outcome === "ok" ? "游戏服已确认保存" : "游戏服拒绝了这次测试发放", now, id, id, lease),
        complete,
      ]);
    } else {
      await complete.run();
    }
    return json({ ok: true });
  }
  throw new RequestError(404, "找不到页面。");
}

export async function micetApi(request: Request, area: string, action: string) {
  try {
    if (area === "micet" && action === "server-status" && request.method !== "POST") {
      return json(await getServerStatus(env.MICET_STATUS_URL));
    }
    if (isPublicLaunch()) throw new RequestError(404, "该功能暂未开放。");
    const body = request.method === "POST" ? await readBody(request) : null;
    if (area === "bridge" && body) {
      await requireBridge(request);
      return await bridgePost(database(), action, body);
    }
    if (area !== "micet") throw new RequestError(404, "找不到页面。");
    const owner = await ownerId(request);
    if (body && request.headers.get("origin") !== new URL(request.url).origin) {
      throw new RequestError(403, "请求来源无效。");
    }
    const db = database();
    const mode = micetMode();
    return body ? await browserPost(db, action, body, owner, mode)
      : await browserGet(db, action, request, owner, mode);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    console.error("Micet request error", area, action, error instanceof Error ? error.name : "unknown");
    return json({ error: "站点暂时无法处理请求，请稍后再试。" }, 500);
  }
}

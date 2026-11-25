import { env } from "cloudflare:workers";
import { checkout, paymentEvent, reconcile, shopCatalog, shopOrders } from "./shop-server";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { demoMatchPattern, getDemoMatchDetail, matchUuidPattern } from "./micet-match-detail";
import { getServerStatus } from "./micet-server-status";
import { DEMO_PLAYER, TEST_SKU, demoBoards, getDemoMatches, getDemoProfile, type Link, type Mode, type Order } from "./micet-data";
import { codeLifetime, codePattern, digest, generateCode, hashCode, json, RequestError } from "./micet-http";
import { approveSiteLink, confirmSiteLink, endSiteSession, siteSession, startSiteLink } from "./micet-session";

type Body = Record<string, unknown>;
type Job = {
  id: string; owner: string; kind: string; mode: Mode; payload: string; status: string;
  created_at: number; expires_at: number | null; lease: string | null; lease_until: number | null; result: string | null;
};

const playerPattern = /^[A-Za-z0-9_]{1,16}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jobKinds = ["boards", "profile", "matches", "match-detail"];
const queryLifetime = 45_000;
const leaseLifetime = 20_000;
const publicOwner = "public-stats";
const minecraftOwner = "minecraft:";

export function isSelfHosted(): boolean {
  return env.MICET_SELF_HOSTED === "1";
}

export function micetMode(): Mode {
  return isSelfHosted() || env.MICET_MODE === "bridge" ? "bridge" : "demo";
}

export function isPublicLaunch(): boolean {
  return env.MICET_PUBLIC_LAUNCH === "1";
}

function database(): D1Database {
  if (!env.DB) throw new RequestError(503, "站点数据库暂不可用。");
  return env.DB;
}

async function ownerId(request: Request) {
  const user = await getChatGPTUser();
  if (user) return user.userId;
  const host = new URL(request.url).hostname;
  if (env.MICET_LOCAL_TEST === "1" && ["localhost", "127.0.0.1"].includes(host)) return "micet-local";
  throw new RequestError(401, "请先登录站点。");
}

async function readBody(request: Request, maxBytes = 100_000): Promise<Body> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "请求格式无效。");
  const decoder = new TextDecoder();
  let content = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
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
  const row = await db.prepare("SELECT seen_at FROM bridge_state WHERE id=?").bind(bridgeId()).first<{ seen_at: number }>();
  return Boolean(row && row.seen_at > Date.now() - 35_000);
}

const bridgeId = () => isSelfHosted() ? "self-hosted-game" : "game";

async function consumeCode(db: D1Database, code: string, mode: Mode, link: Link, owner?: string) {
  if (!codePattern.test(code)) throw new RequestError(400, "验证码格式有误。");
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

async function browserGet(db: D1Database, action: string, request: Request, owner: string, mode: Mode, verifiedLink?: Link) {
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
      const linked = verifiedLink ?? await playerLink(db, owner, mode);
      if (linked?.uuid !== JSON.parse(job.payload).uuid) throw new RequestError(404, "查询已过期，请重新尝试。");
    }
    return json({ status: job.status, data: job.result ? JSON.parse(job.result) : null });
  }
  throw new RequestError(404, "找不到页面。");
}

async function stats(db: D1Database, body: Body, owner: string, mode: Mode, verifiedLink?: Link) {
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
  const link = needsPlayer ? verifiedLink ?? await playerLink(db, owner, mode) : null;
  if (needsPlayer && !link) throw new RequestError(403, "绑定游戏账号后即可查看对局。");
  if (mode === "demo") {
    if (kind === "match-detail") return json({ data: getDemoMatchDetail(link!.uuid, matchId, target) });
    const data = kind === "boards" ? demoBoards : kind === "profile" ? getDemoProfile(name) : getDemoMatches(link!.uuid);
    return json({ data });
  }
  if (!await linkStatus(db, mode)) throw new RequestError(503, "游戏服桥接离线，请稍后再试。");
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

async function publicStats(db: D1Database, request: Request, kind: "boards" | "profile") {
  const name = (new URL(request.url).searchParams.get("name") ?? "").trim();
  if (kind === "profile" && !playerPattern.test(name)) throw new RequestError(400, "请输入有效的 Minecraft 玩家名。");
  const id = "public:" + (kind === "boards" ? kind : "profile:" + name.toLowerCase());
  const now = Date.now();
  const getJob = () => db.prepare("SELECT status,result FROM bridge_jobs WHERE id=? AND owner=? AND expires_at>?")
    .bind(id, publicOwner, now).first<Pick<Job, "status" | "result">>();
  let job = await getJob();
  if (!job) {
    if (!await linkStatus(db, "bridge")) throw new RequestError(503, "游戏服桥接离线，请稍后再试。");
    await db.prepare("INSERT INTO bridge_jobs (id,owner,kind,mode,payload,status,created_at,expires_at) "
      + "SELECT ?,?,?,'bridge',?,'queued',?,? WHERE "
      + "(SELECT COUNT(*) FROM bridge_jobs WHERE owner=? AND expires_at>? AND status IN ('queued','leased'))<8 "
      + "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,status='queued',created_at=excluded.created_at,"
      + "expires_at=excluded.expires_at,lease=NULL,lease_until=NULL,result=NULL WHERE bridge_jobs.expires_at<=excluded.created_at")
      .bind(id, publicOwner, kind, JSON.stringify({ name }), now, now + queryLifetime, publicOwner, now).run();
    job = await getJob();
  }
  if (!job) throw new RequestError(429, "查询繁忙，请稍后再试。");
  if (job.status === "failed") throw new RequestError(503, "游戏服暂时无法返回这项数据。");
  if (job.status !== "done") return json({ pending: true }, 202);
  return json({ data: job.result ? JSON.parse(job.result) : null });
}

async function selfHostedBrowser(db: D1Database, request: Request, action: string) {
  if (request.method !== "POST") {
    if (action === "leaderboard") return publicStats(db, request, "boards");
    if (action === "player") return publicStats(db, request, "profile");
    if (action === "shop") return shopCatalog();
    if (!["status", "result", "orders"].includes(action)) throw new RequestError(404, "找不到页面。");
    const linked = await siteSession(db, request);
    if (action === "status") return json({ mode: "bridge", linked, connected: await linkStatus(db, "bridge") });
    if (!linked) throw new RequestError(401, "请先绑定游戏账号。");
    if (action === "orders") return shopOrders(db, linked.uuid);
    return browserGet(db, action, request, minecraftOwner + linked.uuid, "bridge", linked);
  }
  const origin = env.MICET_SITE_ORIGIN?.trim();
  if (!origin?.startsWith("https://") || request.headers.get("origin") !== origin) {
    throw new RequestError(403, "请求来源无效。");
  }
  const body = await readBody(request);
  if (action === "code") {
    if (!await linkStatus(db, "bridge")) throw new RequestError(503, "游戏服桥接离线，请稍后再试。");
    return startSiteLink(db, request);
  }
  if (action === "confirm") return confirmSiteLink(db, request);
  if (action === "logout") return endSiteSession(db, request);
  if (action === "checkout" && body.sku !== TEST_SKU) {
    const linked = await siteSession(db, request);
    if (!linked) throw new RequestError(401, "请先绑定游戏账号。");
    return checkout(db, request, body, linked, await linkStatus(db, "bridge"));
  }
  if (action !== "stats" || !["matches", "match-detail"].includes(stringField(body, "kind"))) {
    throw new RequestError(404, "找不到页面。");
  }
  const linked = await siteSession(db, request);
  if (!linked) throw new RequestError(401, "请先绑定游戏账号。");
  return stats(db, body, minecraftOwner + linked.uuid, "bridge", linked);
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
    const code = generateCode();
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
    const link = { uuid: uuid.toLowerCase(), player };
    const code = stringField(body, "code");
    if (isSelfHosted()) await approveSiteLink(db, code, link);
    else await consumeCode(db, code, "bridge", link);
    return json({ ok: true });
  }
  if (action === "poll") {
    const lease = crypto.randomUUID();
    const [, , result] = await db.batch<Job>([
      db.prepare("INSERT INTO bridge_state (id,seen_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at").bind(bridgeId(), now),
      db.prepare("DELETE FROM bridge_jobs WHERE expires_at IS NOT NULL AND expires_at<=?").bind(now),
      db.prepare("UPDATE bridge_jobs SET status='leased',lease=?,lease_until=? WHERE id=(SELECT id FROM bridge_jobs WHERE mode='bridge' "
        + "AND (status='queued' OR (status='leased' AND lease_until<=?)) AND (expires_at IS NULL OR expires_at>?) "
        + "AND ((owner=? OR owner LIKE ?) = ?) AND (?=0 OR kind!='delivery') "
        + "AND (kind NOT IN ('tag-check','shop-deliver') OR ?=1) "
        + "ORDER BY CASE WHEN kind='delivery' THEN 0 ELSE 1 END, COALESCE(lease_until,created_at) LIMIT 1) RETURNING *")
        .bind(lease, now + leaseLifetime, now, now, publicOwner, minecraftOwner + "%", Number(isSelfHosted()), Number(isSelfHosted()), Number(isSelfHosted() && body.shop === 1)),
    ]);
    const job = result.results[0];
    return json({ job: job ? { id: job.id, kind: job.kind, lease: job.lease, payload: JSON.parse(job.payload) } : null });
  }
  if (action === "receipt") {
    const id = stringField(body, "id");
    const lease = stringField(body, "lease");
    const job = await db.prepare("SELECT * FROM bridge_jobs WHERE id=? AND mode='bridge' AND lease=?").bind(id, lease).first<Job>();
    if (!job || job.status !== "leased" || isSelfHosted() !== (job.owner === publicOwner || job.owner.startsWith(minecraftOwner))
        || (isSelfHosted() && job.kind === "delivery")) return json({ ignored: true });
    const outcome = stringField(body, "outcome");
    if (!["ok", "retry", "failed"].includes(outcome)) throw new RequestError(400, "回执状态无效。");
    if (outcome === "retry") return json({ ok: true });
    const data = outcome === "ok" ? body.data ?? null : null;
    const status = outcome === "ok" ? "done" : "failed";
    const expiry = job.owner === publicOwner ? now + (outcome === "failed" ? 5000 : job.kind === "boards" ? 60_000 : 30_000) : job.expires_at;
    const complete = db.prepare("UPDATE bridge_jobs SET status=?,result=?,expires_at=? WHERE id=? AND lease=? AND status='leased'")
      .bind(status, JSON.stringify(data), expiry, id, lease);
    if (job.kind === "shop-deliver") {
      await db.batch([
        db.prepare("UPDATE shop_orders SET status=? WHERE id=? AND status='paid' AND EXISTS(SELECT 1 FROM bridge_jobs WHERE id=? AND lease=? AND status='leased')")
          .bind(outcome === "ok" ? "delivered" : "review", id, id, lease),
        complete,
      ]);
    } else if (job.kind === "delivery") {
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
    if (isSelfHosted() && area === "payments" && action === "return" && request.method === "GET") {
      return new Response(null, { status: 303, headers: {
        Location: "/#orders", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      } });
    }
    if (isSelfHosted() && area === "payments" && request.method === "POST") {
      if (action === "xiaodou") return await paymentEvent(database(), request);
      if (action === "reconcile" && env.MICET_RECONCILE_TOKEN && request.headers.get("Authorization") === "Bearer " + env.MICET_RECONCILE_TOKEN) {
        await reconcile(database());
        return json({ ok: true });
      }
    }
    if (area === "bridge" && request.method === "POST") {
      await requireBridge(request);
      return await bridgePost(database(), action, await readBody(request, action === "receipt" ? 1_000_000 : undefined));
    }
    if (area !== "micet") throw new RequestError(404, "找不到页面。");
    if (isSelfHosted()) return await selfHostedBrowser(database(), request, action);
    const body = request.method === "POST" ? await readBody(request) : null;
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
    if (error instanceof Error && [error, error.cause].some(detail => detail instanceof Error &&
        /\bno such table:\s*(?:main\.)?web_(?:link_challenges|sessions)\b/i.test(detail.message))) {
      console.error("MiCet account binding tables are missing. Apply drizzle/0001_website_binding.sql to the running D1 database.");
      return json({ error: "账号绑定的数据库尚未初始化，请联系服务器管理员。" }, 503);
    }
    console.error("Micet request error", area, action, error instanceof Error ? error.name : "unknown");
    return json({ error: "站点暂时无法处理请求，请稍后再试。" }, 500);
  }
}

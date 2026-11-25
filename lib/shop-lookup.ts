import { scrypt } from "node:crypto";
import { hashToken, json, RequestError } from "./micet-http";
import { cookieHash, token, writeCookie } from "./micet-session";

const lookupCookie = "__Host-micet-lookup";
const sessionLifetime = 15 * 60_000;
const rejected = () => new RequestError(401, "查询账号或查询密码不匹配。");

function contactId(value: unknown) {
  const input = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/^[1-9]\d{4,10}$/.test(input)) return "qq:" + input;
  const parts = input.split("@");
  const [local, domain] = parts;
  if (input.length <= 254 && local && local.length <= 64 && !local.startsWith(".") && !local.endsWith(".")
      && !local.includes("..") && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) && parts.length === 2
      && domain?.includes(".") && domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    return "email:" + input;
  }
  throw new RequestError(400, "请输入有效的 QQ 号或邮箱。");
}

async function takeAttempt(db: D1Database, bucket: string, now: number, limit: number) {
  const result = await db.prepare("INSERT INTO shop_lookup_limits(bucket,attempts,expires_at) VALUES(?,1,?) " +
    "ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 WHERE attempts<?")
    .bind(bucket, now + sessionLifetime, limit).run();
  if (!result.meta.changes) throw new RequestError(429, "尝试次数过多，请稍后再试。");
}

export async function orderLookupKey(db: D1Database, request: Request, body: Record<string,unknown>, creating: boolean) {
  const contact = contactId(body.contact);
  const password = body.password;
  if (typeof password !== "string" || password.length < 8 || password.length > 128 || !password.trim())
    throw new RequestError(400,"查询密码须为 8–128 个字符。");
  const now = Date.now(), window = Math.floor(now / sessionLifetime);
  const id = await hashToken(contact);
  const address = await hashToken(request.headers.get("cf-connecting-ip") || "local");
  await db.prepare("DELETE FROM shop_lookup_limits WHERE expires_at<=?").bind(now).run();
  await takeAttempt(db, window+":ip:"+address, now, 60);
  await takeAttempt(db, window+":contact:"+id, now, 24);
  if (creating) {
    await db.prepare("INSERT OR IGNORE INTO shop_lookup_contacts(contact_hash,salt) VALUES(?,?)").bind(id,token()).run();
  }
  const row = await db.prepare("SELECT salt FROM shop_lookup_contacts WHERE contact_hash=?").bind(id).first<{salt:string}>();
  const salt = row?.salt ?? token();
  const key = await new Promise<string>((resolve,reject) => {
    scrypt(password, salt, 32, {N:16384,r:8,p:5,maxmem:32*1024*1024}, (err,derived) => {
      if (err) reject(err); else resolve(derived.toString("hex"));
    });
  });
  if (!row) throw rejected();
  return key;
}

export async function currentLookup(db: D1Database, request: Request) {
  const hash = await cookieHash(request, lookupCookie);
  if (!hash) return null;
  const row = await db.prepare("SELECT lookup_key FROM shop_lookup_sessions WHERE token_hash=? AND expires_at>?")
    .bind(hash, Date.now()).first<{lookup_key:string}>();
  return row?.lookup_key ?? null;
}

export async function unlockOrders(db: D1Database, request: Request, key: string, response: Response) {
  const secret = token(), now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM shop_lookup_sessions WHERE expires_at<=? OR token_hash=?").bind(now,await cookieHash(request,lookupCookie)),
    db.prepare("INSERT INTO shop_lookup_sessions(token_hash,lookup_key,expires_at) VALUES(?,?,?)")
      .bind(await hashToken(secret),key,now+sessionLifetime),
  ]);
  writeCookie(response, lookupCookie, secret, sessionLifetime);
  return response;
}

export async function lookupOrders(db: D1Database, request: Request, body: Record<string,unknown>) {
  if (body.close === true) {
    await db.prepare("DELETE FROM shop_lookup_sessions WHERE token_hash=?").bind(await cookieHash(request,lookupCookie)).run();
    const response=json({ok:true});
    writeCookie(response,lookupCookie,"",0);
    return response;
  }
  const key=await orderLookupKey(db, request, body, false);
  if (!await db.prepare("SELECT 1 FROM shop_orders WHERE lookup_key=? LIMIT 1").bind(key).first()) throw rejected();
  return unlockOrders(db,request,key,json({ok:true}));
}

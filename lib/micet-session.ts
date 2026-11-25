import { codeLifetime, codePattern, generateCode, hashCode, hashToken, json, RequestError } from "./micet-http";
import type { Link } from "./micet-data";

const challengeCookie = "__Host-micet-challenge";
const sessionCookie = "__Host-micet-session";
const sessionLifetime = 7 * 86_400_000;

export function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function cookieHash(request: Request, name: string) {
  const prefix = name + "=";
  const value = request.headers.get("cookie")?.split(";").map(part => part.trim())
    .find(part => part.startsWith(prefix))?.slice(prefix.length);
  return value && /^[0-9a-f]{64}$/.test(value) ? hashToken(value) : null;
}

export function writeCookie(response: Response, name: string, value: string, lifetime: number) {
  response.headers.append("Set-Cookie", `${name}=${value}; Path=/; Max-Age=${lifetime / 1000}; Secure; HttpOnly; SameSite=Strict`);
}

export async function siteSession(db: D1Database, request: Request) {
  const hash = await cookieHash(request, sessionCookie);
  if (!hash) return null;
  return db.prepare("SELECT uuid, player FROM web_sessions WHERE hash=? AND expires_at>?")
    .bind(hash, Date.now()).first<Link>();
}

const shopCookie = "__Host-micet-shop";
export const guestShopHash = (request: Request) => cookieHash(request, shopCookie);

export function startGuestShop(response: Response) {
  writeCookie(response, shopCookie, token(), 90 * 86_400_000);
  return response;
}

export async function startSiteLink(db: D1Database, request: Request) {
  const code = generateCode();
  const browserToken = token();
  const now = Date.now();
  const expiresAt = now + codeLifetime;
  const ip = request.headers.get("CF-Connecting-IP");
  const [codeHash, challengeHash, previous, addressHash] = await Promise.all([
    hashCode(code), hashToken(browserToken), cookieHash(request, challengeCookie), ip ? hashToken(ip) : null,
  ]);
  const [, , result] = await db.batch([
    db.prepare("DELETE FROM web_link_challenges WHERE expires_at<=? OR browser_hash=?").bind(now, previous),
    db.prepare("DELETE FROM web_sessions WHERE expires_at<=?").bind(now),
    db.prepare("INSERT INTO web_link_challenges (code_hash,browser_hash,address_hash,expires_at) SELECT ?,?,?,? "
      + "WHERE (SELECT COUNT(*) FROM web_link_challenges)<300 "
      + "AND (? IS NULL OR (SELECT COUNT(*) FROM web_link_challenges WHERE address_hash=?)<12)")
      .bind(codeHash, challengeHash, addressHash, expiresAt, addressHash, addressHash),
  ]);
  if (!result.meta.changes) throw new RequestError(429, "生成请求过多，请稍后再试。");
  const response = json({ code, expiresAt });
  writeCookie(response, challengeCookie, browserToken, codeLifetime);
  return response;
}

export async function approveSiteLink(db: D1Database, code: string, link: Link) {
  if (!codePattern.test(code)) throw new RequestError(400, "验证码格式有误。");
  const result = await db.prepare("UPDATE web_link_challenges SET uuid=?,player=? "
    + "WHERE code_hash=? AND expires_at>? AND uuid IS NULL")
    .bind(link.uuid, link.player, await hashCode(code), Date.now()).run();
  if (!result.meta.changes) throw new RequestError(404, "验证码已失效，请在站点重新生成。");
}

export async function confirmSiteLink(db: D1Database, request: Request) {
  const challengeHash = await cookieHash(request, challengeCookie);
  if (!challengeHash) throw new RequestError(404, "请在当前浏览器重新生成验证码。");
  const sessionToken = token();
  const [sessionHash, previous] = await Promise.all([hashToken(sessionToken), cookieHash(request, sessionCookie)]);
  const now = Date.now();
  const ready = "browser_hash=? AND expires_at>? AND uuid IS NOT NULL";
  const [issued] = await db.batch<Link>([
    db.prepare("INSERT INTO web_sessions (hash,uuid,player,expires_at) "
      + "SELECT ?,uuid,player,? FROM web_link_challenges WHERE " + ready + " RETURNING uuid,player")
      .bind(sessionHash, now + sessionLifetime, challengeHash, now),
    db.prepare("DELETE FROM web_sessions WHERE hash=? AND EXISTS "
      + "(SELECT 1 FROM web_link_challenges WHERE " + ready + ")").bind(previous, challengeHash, now),
    db.prepare("DELETE FROM web_link_challenges WHERE " + ready).bind(challengeHash, now),
  ]);
  const linked = issued.results[0];
  if (!linked) throw new RequestError(409, "验证码未验证或已过期。请先在游戏内输入验证码。");
  const response = json({ linked });
  writeCookie(response, sessionCookie, sessionToken, sessionLifetime);
  writeCookie(response, challengeCookie, "", 0);
  return response;
}

export async function endSiteSession(db: D1Database, request: Request) {
  const [session, challenge, lookup] = await Promise.all([
    cookieHash(request, sessionCookie), cookieHash(request, challengeCookie), cookieHash(request,"__Host-micet-lookup"),
  ]);
  await db.batch([
    db.prepare("DELETE FROM web_sessions WHERE hash=?").bind(session),
    db.prepare("DELETE FROM web_link_challenges WHERE browser_hash=?").bind(challenge),
    ...(lookup ? [db.prepare("DELETE FROM shop_lookup_sessions WHERE token_hash=?").bind(lookup)] : []),
  ]);
  const response = json({ ok: true });
  writeCookie(response, sessionCookie, "", 0);
  writeCookie(response, "__Host-micet-lookup", "", 0);
  writeCookie(response, challengeCookie, "", 0);
  return response;
}

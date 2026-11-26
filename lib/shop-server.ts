import { env } from "cloudflare:workers";
import { catalog, type Link } from "./micet-data";
import { orderLookupKey, unlockOrders } from "./shop-lookup";
import { json, RequestError } from "./micet-http";
import { channels, GatewayRejection, paymentUrl, readEvent, xdRequest, type Fields, type XDChannel } from "./xiaodou";

type ShopOrder = { id: string; uuid: string; player: string; sku: string; amount: number; channel: XDChannel;
  status: string; created_at: number; pay_url: string | null; qr_url: string | null; expires_at: number | null; next_check:number; detail: string | null; lookup_key: string | null;
  cashier_version: number; attempt_request: string | null; attempt_until: number };
export function products() {
  return catalog.map(tag => {
    const value = tag.name === "Vape" ? env.MICET_PRICE_VAPE_FEN : tag.name === "Heart" ? env.MICET_PRICE_HEART_FEN : undefined;
    const amount = value && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
    return { ...tag, amount };
  });
}
export const shopCatalog = () => json({ products: products(), channels: channels() });
const exposed = (o: ShopOrder) => ({ id:o.id, player:o.player, sku:o.sku, amount:o.amount, channel:o.channel,
  status:o.status, created_at:o.created_at, expires_at:o.expires_at, detail:o.detail,
  pay_url:o.status === "pending" && Number(o.expires_at) > Date.now() ? o.pay_url : null,
  qr_url:o.status === "pending" && Number(o.expires_at) > Date.now() ? o.qr_url : null });
function visibleOrders(db: D1Database, account: string | null, guest: string | null, key: string | null, suffix: string, ...args: string[]) {
  return key
    ? db.prepare("SELECT * FROM shop_orders WHERE lookup_key=? " + suffix).bind(key,...args)
    : db.prepare("SELECT * FROM shop_orders WHERE lookup_key IS NULL AND buyer IN (?,?) " + suffix).bind(account,guest,...args);
}
export async function shopOrders(db: D1Database, account: string | null, guest: string | null, key: string | null) {
  if (!account && !guest && !key) return json({orders:[],unlocked:false});
  const rows = await visibleOrders(db, account, guest, key, "ORDER BY created_at DESC LIMIT 100").all<ShopOrder>();
  return json({ orders: rows.results.map(exposed), unlocked:Boolean(key) });
}
const merchantOrder = (db: D1Database, id: string) => db.prepare("SELECT * FROM shop_orders WHERE id=?").bind(id).first<ShopOrder>();

export async function resolveRecipient(db: D1Database, player: unknown, sku: unknown, connected: boolean): Promise<Link | null> {
  if (typeof player !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(player)) throw new RequestError(400,"请输入 1–16 位游戏 ID，仅限字母、数字和下划线。");
  if (!products().some(item=>item.name===sku && item.amount)) throw new RequestError(400,"商品尚未开放。");
  if (!connected) throw new RequestError(503,"游戏服桥接暂时离线，请稍后重试。");
  const id = "recipient:" + player.toLowerCase() + ":" + sku;
  const now = Date.now();
  await db.prepare("INSERT INTO bridge_jobs(id,owner,kind,mode,payload,status,created_at,expires_at) " +
    "SELECT ?,'minecraft:shop','shop-recipient','bridge',?,'queued',?,? WHERE " +
    "(SELECT COUNT(*) FROM bridge_jobs WHERE kind='shop-recipient' AND expires_at>? AND status IN ('queued','leased'))<24 " +
    "ON CONFLICT(id) DO UPDATE SET status='queued',created_at=excluded.created_at,expires_at=excluded.expires_at,result=NULL,lease=NULL,lease_until=NULL WHERE bridge_jobs.expires_at<=?")
    .bind(id,JSON.stringify({player,sku}),now,now+60_000,now,now).run();
  const job = await db.prepare("SELECT status,result FROM bridge_jobs WHERE id=? AND expires_at>?").bind(id,now).first<{status:string; result:string|null}>();
  if (!job) throw new RequestError(429,"游戏服核验繁忙，请稍后再试。");
  if (job.status==="failed") throw new RequestError(503,"游戏档案核验失败，请稍后再试。");
  if (job.status!=="done") return null;
  const result = JSON.parse(job.result ?? "null");
  if (result?.found===false) throw new RequestError(404,"未找到唯一匹配的玩家档案，请核对游戏 ID。");
  if (typeof result?.player!=="string" || result.player.toLowerCase()!==player.toLowerCase() ||
      !/^[A-Za-z0-9_]{1,16}$/.test(result.player) || typeof result.uuid!=="string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result.uuid) || typeof result.owned!=="boolean")
    throw new RequestError(503,"游戏服未能确认收货角色。");
  if (result.owned) throw new RequestError(409,"这位玩家已经拥有该商品。");
  return {uuid:result.uuid.toLowerCase(),player:result.player};
}

export async function checkout(db: D1Database, request: Request, body: Fields, link: Link, buyer: string) {
  const item = products().find(i=>i.name===body.sku);
  const channel = body.channel as XDChannel;
  if (!item || !channels().includes(channel) || !item.amount) throw new RequestError(400,"商品或支付渠道未开放。");
  if (body.amount !== item.amount) throw new RequestError(409,"商品价格已变更，请重新打开商店确认。");
  const key = await orderLookupKey(db, request, body, true);
  const now = Date.now();
  const inserted = await db.prepare("INSERT OR IGNORE INTO shop_orders(id,uuid,player,sku,amount,channel,status,created_at,next_check,buyer,lookup_key) " +
    "SELECT ?,?,?,?,?,?,'pending',?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM shop_orders WHERE uuid=? AND sku=? AND status IN ('paid','delivered','review','refund_review','duplicate'))")
    .bind("MC"+crypto.randomUUID().replaceAll("-",""),link.uuid,link.player,item.name,item.amount,channel,now,now+60_000,buyer,key,link.uuid,item.name).run();
  const order = await db.prepare("SELECT * FROM shop_orders WHERE buyer=? AND uuid=? AND sku=? AND status='pending'")
    .bind(buyer,link.uuid,item.name).first<ShopOrder>();
  if (!order) throw new RequestError(409,"该角色已有此商品或有订单正在处理，请稍后再试。");
  if (!order.lookup_key) throw new RequestError(409,"已有历史待付订单，请从原购买记录继续。");
  if (order.lookup_key!==key) throw new RequestError(409,"已有待付订单，请使用下单时的查询账号和密码。");
  if (order.amount!==item.amount || order.channel!==channel) throw new RequestError(409,"你已为该角色创建过待付订单，请在「我的订单」确认原订单的金额和支付方式。");
  if (inserted.meta.changes) {
    const state = await createCashier(db, request, order);
    if (state === "renew") await recoverCashier(db, request, order);
  } else {
    await recoverCashier(db, request, order);
  }
  return unlockOrders(db,request,key,json({order:exposed((await merchantOrder(db,order.id))!)}));
}

async function createCashier(db: D1Database, request: Request, order: ShopOrder) {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) throw new RequestError(503,"支付入口未取得买家公网地址。");
  let snapshot: Fields;
  try {
    snapshot = await xdRequest("/api/open/v1/payments",{outTradeNo:order.id,channel:order.channel,
      currency:"CNY",amountFen:order.amount,subject:"MiCet 永久称号 "+order.sku,payerClientIp:ip,
      returnUrl:new URL("/api/payments/return",env.MICET_SITE_ORIGIN).href});
  } catch (error) {
    if (error instanceof GatewayRejection && [400,422].includes(error.gatewayStatus)) {
      await db.prepare("UPDATE shop_orders SET status='failed' WHERE id=? AND status='pending' AND expires_at IS NULL AND cashier_version=?").bind(order.id,order.cashier_version).run();
    }
    throw error;
  }
  return acceptSnapshot(db,order,snapshot);
}

async function applyState(db: D1Database, order: ShopOrder, type: string, amount: number, eventId?: string) {
  const id = order.id, now = Date.now();
  const statements: D1PreparedStatement[] = [];
  // Every transition is monotonic and replay-safe across both webhook and query paths.
  if (type === "PAYMENT_SUCCEEDED") {
    if (amount !== order.amount) throw new RequestError(409,"实付金额不匹配。");
    // A late first payment wins over an unpaid replacement. If both settle, only one can grant the Tag.
    statements.push(db.prepare("UPDATE shop_orders SET status='closed' WHERE id<>? AND uuid=? AND sku=? AND status='pending' AND EXISTS(SELECT 1 FROM shop_orders WHERE id=? AND status IN ('pending','closed','failed'))")
      .bind(id,order.uuid,order.sku,id));
    statements.push(db.prepare("UPDATE shop_orders SET status=CASE WHEN EXISTS (SELECT 1 FROM shop_orders s WHERE s.id<>? AND s.uuid=? AND s.sku=? AND s.status IN ('paid','delivered','review','refund_review')) THEN 'duplicate' ELSE 'paid' END WHERE id=? AND status IN ('pending','closed','failed')")
      .bind(id,order.uuid,order.sku,id));
    statements.push(db.prepare("INSERT OR IGNORE INTO bridge_jobs(id,owner,kind,mode,payload,status,created_at) SELECT id,?,'shop-deliver','bridge',?,'queued',? FROM shop_orders WHERE id=? AND status='paid'")
      .bind("minecraft:"+order.uuid,JSON.stringify({uuid:order.uuid,player:order.player,sku:order.sku}),now,id));
  } else if (type === "REFUND_SUCCEEDED") {
    if (!Number.isSafeInteger(amount) || amount<=0 || amount>order.amount) throw new RequestError(409,"退款金额不匹配。");
    statements.push(db.prepare("UPDATE shop_orders SET status=CASE WHEN status IN ('delivered','review','duplicate','refund_review') OR ?<>amount OR EXISTS(SELECT 1 FROM bridge_jobs WHERE id=? AND lease IS NOT NULL) THEN 'refund_review' ELSE 'refunded' END,detail='退款已记录' WHERE id=?").bind(amount,id,id));
    statements.push(db.prepare("UPDATE bridge_jobs SET status='cancelled' WHERE id=? AND kind='shop-deliver'").bind(id));
  } else if (type === "PAYMENT_CLOSED" || type === "PAYMENT_FAILED") {
    statements.push(db.prepare("UPDATE shop_orders SET status=? WHERE id=? AND status='pending'").bind(type==="PAYMENT_CLOSED"?"closed":"failed",id));
  } else if (type !== "REFUND_FAILED") throw new RequestError(400,"未知支付事件。");
  if (eventId) statements.push(db.prepare("INSERT INTO shop_events(id,order_id,kind,amount,created_at) VALUES(?,?,?,?,?)").bind(eventId,id,type,amount,now));
  if (statements.length) await db.batch(statements);
}

async function acceptSnapshot(db: D1Database, order: ShopOrder, data: Fields, checking = false) {
  if (data.outTradeNo!==order.id || data.amountFen!==order.amount || data.currency!=="CNY" || data.channel!==order.channel) throw new RequestError(502,"网关订单不匹配。");
  if (data.status==="SUCCEEDED" || data.status==="CLOSED" || data.status==="FAILED") {
    await applyState(db,order,"PAYMENT_"+data.status,order.amount);
    return "terminal";
  }
  const until = Date.parse(String(data.expireAt));
  const latest = data.latestAttempt as Fields | null | undefined;
  const attemptState = latest?.status ?? latest?.state;
  const payable = (data.status==="CREATED" || data.status==="PAYING") && !data.unknown &&
    attemptState!=="UNKNOWN" && attemptState!=="PAID" &&
    data.closeState!=="CLOSE_PENDING" && data.closeState!=="UNKNOWN_KEPT" && Number.isFinite(until) && until>Date.now();
  if (!payable || data.nextAction==="CREATE_ATTEMPT") {
    // A query read before another request renewed the code must not invalidate the new code.
    const changed = await db.prepare("UPDATE shop_orders SET pay_url=NULL,qr_url=NULL,cashier_version=cashier_version+1 " +
      "WHERE id=? AND status='pending' AND cashier_version=? AND (pay_url IS NOT NULL OR qr_url IS NOT NULL OR (? AND attempt_until>0))")
      .bind(order.id,order.cashier_version,checking && !payable ? 1 : 0).run();
    if (changed.meta.changes) order.cashier_version++;
    return payable ? "renew" : "wait";
  }
  // Query snapshots have no URLs even when the existing cashier is still usable.
  if (!checking) {
    const pay = paymentUrl(data.payUrl,env.XD_CASHIER_ORIGIN);
    const qr = order.channel==="ALIPAY_H5" ? paymentUrl(data.qrCode,"https://qr.alipay.com") : null;
    if (!pay) throw new RequestError(502,"平台收银地址无效。");
    await db.prepare("UPDATE shop_orders SET pay_url=?,qr_url=?,expires_at=?,attempt_request=NULL,attempt_until=0,cashier_version=cashier_version+1 " +
      "WHERE id=? AND status='pending' AND cashier_version=?").bind(pay,qr,until,order.id,order.cashier_version).run();
  }
  return "active";
}

async function recoverCashier(db: D1Database, request: Request, order: ShopOrder) {
  if (order.status!=="pending" || order.attempt_until>Date.now()) return;
  const path = "/api/open/v1/payments/" + encodeURIComponent(order.id);
  let snapshot: Fields;
  try {
    snapshot = await xdRequest(path);
  } catch (error) {
    if (!(error instanceof GatewayRejection && error.gatewayStatus===404 && order.expires_at===null && !order.attempt_request)) throw error;
    // A local order can exist before the first gateway request was received.
    if (await createCashier(db,request,order)!=="renew") return;
    snapshot = await xdRequest(path);
  }
  const state = await acceptSnapshot(db,order,snapshot,true);
  if (state==="terminal" || state==="wait") return;
  if (state==="active" && !order.attempt_request) {
    if (!exposed(order).pay_url) {
      // Recover lost initial issuance via the platform's same-order business replay.
      if (await createCashier(db,request,order)!=="renew") return;
    } else return;
  }
  const now = Date.now();
  const claimed = await db.prepare("UPDATE shop_orders SET attempt_request=COALESCE(attempt_request,?),attempt_until=?," +
    "cashier_version=cashier_version+1,pay_url=NULL,qr_url=NULL WHERE id=? AND status='pending' AND cashier_version=? AND attempt_until<=? RETURNING *")
    .bind(crypto.randomUUID(),now+30_000,order.id,order.cashier_version,now).first<ShopOrder>();
  if (!claimed) return;
  try {
    const issued = await xdRequest(path+"/attempts",{},claimed.attempt_request!);
    // Replaying an ambiguous request returns its original receipt, even if its code has since expired.
    const current = order.attempt_request ? await acceptSnapshot(db,claimed,await xdRequest(path),true) : "active";
    const result = current==="active" ? await acceptSnapshot(db,claimed,issued) : current;
    if (result==="renew") {
      await db.prepare("UPDATE shop_orders SET attempt_request=NULL WHERE id=? AND cashier_version=?")
        .bind(order.id,claimed.cashier_version).run();
    }
  } catch (error) {
    // A signed definitive rejection ends this attempt. Ambiguous failures retain its replay ID.
    if (error instanceof GatewayRejection && ([400,403,404,422].includes(error.gatewayStatus) || error.code==="OPEN_API_STATE_INVALID")) {
      await db.prepare("UPDATE shop_orders SET attempt_request=NULL WHERE id=? AND cashier_version=?")
        .bind(order.id,claimed.cashier_version).run();
    }
    if (error instanceof GatewayRejection && error.gatewayStatus===409) return;
    throw error;
  } finally {
    await db.prepare("UPDATE shop_orders SET attempt_until=0 WHERE id=? AND cashier_version=?")
      .bind(order.id,claimed.cashier_version).run();
  }
}

export async function continuePayment(db: D1Database, request: Request, body: Fields, account: string|null, guest: string|null, key: string|null) {
  if (Object.keys(body).length!==1 || typeof body.id!=="string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id)) throw new RequestError(400,"订单号无效。");
  const order = await visibleOrders(db,account,guest,key,"AND id=?",body.id).first<ShopOrder>();
  if (!order) throw new RequestError(404,"找不到该订单。");
  await recoverCashier(db,request,order);
  return json({order:exposed((await merchantOrder(db,order.id))!)});
}

export async function paymentEvent(db: D1Database, request: Request) {
  const event = await readEvent(request);
  const order = await merchantOrder(db,String(event.outTradeNo));
  if (!order || event.grossAmountFen!==order.amount || typeof event.eventAmountFen!=="number" ||
      event.status!==String(event.eventType).split("_")[1]) throw new RequestError(409,"支付事件与订单不符。");
  const recorded = async () => {
    const prior = await db.prepare("SELECT order_id,kind,amount FROM shop_events WHERE id=?").bind(event.eventId).first();
    if (prior && (prior.order_id!==order.id || prior.kind!==event.eventType || prior.amount!==event.eventAmountFen)) throw new RequestError(409,"支付事件冲突。");
    return Boolean(prior);
  };
  if (!await recorded()) {
    try { await applyState(db,order,String(event.eventType),event.eventAmountFen,String(event.eventId)); }
    catch (error) { if (!await recorded()) throw error; }
  }
  return new Response("success",{headers:{"Cache-Control":"no-store"}});
}
async function reconcileOne(db:D1Database, order:ShopOrder) {
  try {
    await acceptSnapshot(db,order,await xdRequest("/api/open/v1/payments/"+order.id),true);
  } catch (error) {
    if (!(error instanceof GatewayRejection && error.gatewayStatus===404 && order.expires_at===null && !order.attempt_request && Date.now()-order.created_at>900_000)) throw error;
    await db.prepare("UPDATE shop_orders SET status='closed' WHERE id=? AND status='pending' AND expires_at IS NULL AND attempt_request IS NULL AND cashier_version=?")
      .bind(order.id,order.cashier_version).run();
  }
}
export async function reconcile(db:D1Database) {
  if (!env.XD_APP_ID) return;
  const now=Date.now();
  const {results}=await db.prepare("SELECT * FROM shop_orders WHERE status IN ('pending','failed','closed') AND next_check<=? ORDER BY next_check LIMIT 8").bind(now).all<ShopOrder>();
  for (const order of results) {
    const interval = order.status==="pending" && now-order.created_at<86400000 ? 60_000 : 86400000;
    const claimed=await db.prepare("UPDATE shop_orders SET next_check=? WHERE id=? AND next_check=?").bind(now+interval,order.id,order.next_check).run();
    if (claimed.meta.changes) {
      try { await reconcileOne(db,order); } catch { console.warn("Payment reconciliation deferred",order.id); }
    }
  }
}

import { env } from "cloudflare:workers";
import { catalog, type Link } from "./micet-data";
import { json, RequestError } from "./micet-http";
import { channels, GatewayRejection, paymentUrl, readEvent, xdRequest, type Fields, type XDChannel } from "./xiaodou";

type ShopOrder = { id: string; uuid: string; player: string; sku: string; amount: number; channel: XDChannel;
  status: string; created_at: number; pay_url: string | null; qr_url: string | null; expires_at: number | null; next_check:number; detail: string | null };
const active = "('pending','paid','delivered','review')";
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
export async function shopOrders(db: D1Database, uuid: string) {
  const rows = await db.prepare("SELECT * FROM shop_orders WHERE uuid=? ORDER BY created_at DESC LIMIT 100").bind(uuid).all<ShopOrder>();
  return json({ orders: rows.results.map(exposed) });
}
const merchantOrder = (db: D1Database, id: string) => db.prepare("SELECT * FROM shop_orders WHERE id=?").bind(id).first<ShopOrder>();
const openOrder = (db: D1Database, uuid: string, sku: string) => db.prepare(
  "SELECT * FROM shop_orders WHERE uuid=? AND sku=? AND status IN " + active).bind(uuid,sku).first<ShopOrder>();

// One short-lived game lookup per buyer and SKU. Only a signed bridge receipt can authorize checkout.
export async function checkTag(db: D1Database, link: Link, sku: string) {
  const id = "tag:" + link.uuid + ":" + sku, now = Date.now();
  const payload = JSON.stringify({...link, sku});
  await db.prepare("INSERT INTO bridge_jobs(id,owner,kind,mode,payload,status,created_at,expires_at) VALUES(?,?,'tag-check','bridge',?,'queued',?,?) " +
    "ON CONFLICT(id) DO UPDATE SET status='queued',created_at=excluded.created_at,expires_at=excluded.expires_at,payload=excluded.payload,result=NULL,lease=NULL,lease_until=NULL WHERE bridge_jobs.expires_at<=?")
    .bind(id,"minecraft:"+link.uuid,payload,now,now+30_000,now).run();
  const job = await db.prepare("SELECT status,result FROM bridge_jobs WHERE id=?").bind(id).first<{status:string;result:string|null}>();
  if (job?.status === "failed") throw new RequestError(503,"游戏服无法核对这个 Tag，请稍后重试。");
  if (job?.status !== "done") return false;
  if (job.result === "true") throw new RequestError(409,"你已经拥有这个 Tag。");
  if (job.result !== "false") throw new RequestError(503,"游戏权益未能核对。");
  return true;
}

export async function checkout(db: D1Database, request: Request, body: Fields, link: Link, connected: boolean) {
  const item = products().find(i=>i.name===body.sku);
  const channel = body.channel as XDChannel;
  if (!item || !channels().includes(channel)) throw new RequestError(400,"商品或支付渠道未开放。");
  let order = await openOrder(db,link.uuid,item.name);
  if (!order) {
    const hold = await db.prepare("SELECT id FROM shop_orders WHERE uuid=? AND sku=? AND status IN ('refund_review','duplicate') LIMIT 1")
      .bind(link.uuid,item.name).first();
    if (hold) throw new RequestError(409,"该 Tag 有订单待人工核查，请查看我的订单。");
    if (!item.amount) throw new RequestError(400,"该商品暂未定价。");
    if (body.amount !== item.amount) throw new RequestError(409,"商品价格已变更，请重新打开商店确认。");
    if (!connected) throw new RequestError(503,"游戏服暂时离线，无法核对 Tag。");
    if (!await checkTag(db,link,item.name)) return json({checking:true},202);
    const now = Date.now();
    await db.prepare("INSERT OR IGNORE INTO shop_orders(id,uuid,player,sku,amount,channel,status,created_at,next_check) VALUES(?,?,?,?,?,?,'pending',?,?)")
      .bind("MC"+crypto.randomUUID().replaceAll("-",""),link.uuid,link.player,item.name,item.amount,channel,now,now+60_000).run();
    order = await openOrder(db,link.uuid,item.name);
  }
  if (!order || order.status !== "pending") throw new RequestError(409,"该 Tag 已购买或正在处理中，请查看我的订单。");
  if (order.pay_url && Number(order.expires_at)>Date.now()) return json({order:exposed(order)});
  if (order.expires_at && order.expires_at<=Date.now()) {
    await reconcileOne(db,order);
    throw new RequestError(409,"原支付窗口已到期，请刷新订单状态后再购买。");
  }
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) throw new RequestError(503,"支付入口未取得买家公网地址。");
  let snapshot: Fields;
  try {
    snapshot = await xdRequest("/api/open/v1/payments",{outTradeNo:order.id,channel:order.channel,
      currency:"CNY",amountFen:order.amount,subject:"MiCet 永久称号 "+order.sku,payerClientIp:ip,
      returnUrl:new URL("/api/payments/return",env.MICET_SITE_ORIGIN).href});
  } catch (error) {
    if (error instanceof GatewayRejection && [400,422].includes(error.gatewayStatus)) {
      await db.prepare("UPDATE shop_orders SET status='failed' WHERE id=? AND status='pending' AND pay_url IS NULL").bind(order.id).run();
    }
    throw error;
  }
  await acceptSnapshot(db,order,snapshot);
  return json({order:exposed((await merchantOrder(db,order.id))!)});
}

async function applyState(db: D1Database, order: ShopOrder, type: string, amount: number, eventId?: string) {
  const id = order.id, now = Date.now();
  const statements: D1PreparedStatement[] = [];
  // Every transition is monotonic and replay-safe across both webhook and query paths.
  if (type === "PAYMENT_SUCCEEDED") {
    if (amount !== order.amount) throw new RequestError(409,"实付金额不匹配。");
    // A late first payment wins over an unpaid replacement. If both settle, only one can grant the Tag.
    statements.push(db.prepare("UPDATE shop_orders SET status='closed' WHERE id<>? AND uuid=? AND sku=? AND status='pending' AND EXISTS(SELECT 1 FROM shop_orders WHERE id=? AND status IN ('closed','failed'))")
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
  } else if (data.status==="CREATED" || data.status==="PAYING") {
    // Query snapshots never contain cashier URLs. Keep the material issued at checkout.
    if (checking) return;
    const pay = paymentUrl(data.payUrl,env.XD_CASHIER_ORIGIN);
    const qr = order.channel==="ALIPAY_H5" ? paymentUrl(data.qrCode,"https://qr.alipay.com") : null;
    const until = Date.parse(String(data.expireAt));
    if (!pay || !Number.isFinite(until)) throw new RequestError(502,"平台收银地址或有效期无效。");
    await db.prepare("UPDATE shop_orders SET pay_url=?,qr_url=COALESCE(?,qr_url),expires_at=? WHERE id=? AND status='pending'").bind(pay,qr,until,order.id).run();
  } else throw new RequestError(502,"订单状态待核实。");
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
    if (!(error instanceof GatewayRejection && error.gatewayStatus===404 && !order.pay_url && Date.now()-order.created_at>900_000)) throw error;
    await db.prepare("UPDATE shop_orders SET status='closed' WHERE id=? AND status='pending' AND pay_url IS NULL").bind(order.id).run();
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

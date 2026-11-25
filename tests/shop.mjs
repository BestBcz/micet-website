import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const hash = v => createHash("sha256").update(v).digest("hex");
const now = () => String(Math.floor(Date.now()/1000));
const keyPair = () => generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{format:"pem",type:"pkcs8"},publicKeyEncoding:{format:"pem",type:"spki"}});
const merchant = keyPair(), provider = keyPair();
const signLines = (lines, key) => sign("sha256",Buffer.from(lines.join("\n")),key).toString("base64");

test("signed checkout, order isolation, reconciliation, delivery leases and refunds",async t=>{
  const origin="https://shop.test", uuid=randomUUID(), token="ab".repeat(32);
  const secret="bridge-fixture-only-01234567890123456789", cash="https://cashier.test";
  const records=new Map();
  let breakSignature=false;
  const root=resolve("dist/server");
  const config=JSON.parse(await readFile(resolve(root,"wrangler.json"),"utf8"));
  const files=(await readdir(root,{recursive:true})).filter(f=>/\.m?js$/.test(f));
  const mf=new Miniflare({modulesRoot:root,modules:[config.main,...files.filter(f=>f!==config.main)].map(f=>({type:"ESModule",path:resolve(root,f)})),
    compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,d1Databases:{DB:"shop"},
    bindings:{MICET_SELF_HOSTED:"1",MICET_SITE_ORIGIN:origin,MICET_BRIDGE_SECRET:secret,MICET_PRICE_VAPE_FEN:"500",MICET_PRICE_HEART_FEN:"600",
      MICET_RECONCILE_TOKEN:"local-scheduler",XD_CHANNELS:"WECHAT_H5,ALIPAY_H5",XD_BASE_URL:"https://gateway.test",XD_CASHIER_ORIGIN:cash,
      XD_APP_ID:"fixture",XD_KEY_ID:"merchant",XD_PRIVATE_KEY:merchant.privateKey,XD_PLATFORM_KEYS:JSON.stringify({provider:provider.publicKey})},
    outboundService:async req=>{
      const h=req.headers, path=new URL(req.url).pathname, body=await req.text(), rid=h.get("X-XD-Request-Id");
      const signed=["XD-Signature-v1",req.method,path,"",h.get("X-XD-Timestamp"),h.get("X-XD-Nonce"),"fixture","merchant",rid,h.get("Content-Type")??"",hash(body)].join("\n");
      assert(verify("sha256",Buffer.from(signed),merchant.publicKey,Buffer.from(h.get("X-XD-Sign"),"base64")));
      let order;
      if(req.method==="POST"){
        const input=JSON.parse(body);
        assert.equal(input.payerClientIp,"8.8.8.8");
        assert.equal(input.returnUrl,origin+"/api/payments/return");
        order=records.get(input.outTradeNo)??{...input,status:"CREATED",expireAt:new Date(Date.now()+900000).toISOString(),
          payUrl:cash+"/order/"+input.outTradeNo,qrCode:input.channel==="ALIPAY_H5"?"https://qr.alipay.com/test":null};
        records.set(input.outTradeNo,order);
      }else {
        const stored=records.get(path.split("/").pop());
        order={...stored,payUrl:null,qrCode:null};
      }
      const data=JSON.stringify(order), ts=now(), nonce=randomUUID();
      return new Response(data,{headers:{"Content-Type":"application/json",
        "X-XD-Response-Key-Id":"provider","X-XD-Response-Timestamp":ts,"X-XD-Response-Nonce":nonce,
        "X-XD-Response-Sign":signLines(["XD-Response-v1","200","application/json",rid,ts,nonce,"provider",hash(data)],breakSignature?merchant.privateKey:provider.privateKey)}});
    }});
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database("DB");
  for(const file of (await readdir("drizzle")).filter(f=>f.endsWith(".sql")).sort()){
    for(const sql of (await readFile("drizzle/"+file,"utf8")).split("--> statement-breakpoint").map(v=>v.trim()).filter(Boolean))await db.prepare(sql).run();
  }
  await db.prepare("INSERT INTO web_sessions VALUES(?,?,?,?)").bind(hash(token),uuid,"Buyer",Date.now()+3600000).run();
  const http=(path,body,headers={})=>mf.dispatchFetch(origin+"/api/"+path,{method:body===undefined?"GET":"POST",
    headers:{Origin:origin,"Content-Type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
  async function json(path,body,headers,status=200){const r=await http(path,body,headers);const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;}
  const auth={Cookie:"__Host-micet-session="+token,"CF-Connecting-IP":"8.8.8.8"};
  const bridge=(action,body)=>json("bridge/"+action,body,{"X-Micet-Bridge":secret});
  const poll=async()=> (await bridge("poll",{shop:1})).job;
  const receipt=(job,outcome,data=null)=>bridge("receipt",{id:job.id,lease:job.lease,outcome,data});
  const buy=(sku,status=200)=>json("micet/checkout",{sku,amount:sku==="Vape"?500:600,channel:sku==="Vape"?"WECHAT_H5":"ALIPAY_H5"},auth,status);
  const orders=async()=>(await json("micet/orders",undefined,auth)).orders;
  async function event(order,type,{id=randomUUID(),amount=order.amount,bad=false,gross=order.amount}={}){
    const ts=now(),nonce=randomUUID(),state=type.split("_")[1];
    const e={eventId:id,eventType:type,appId:"fixture",outTradeNo:order.id,status:state,grossAmountFen:gross,eventAmountFen:amount};
    const data=JSON.stringify(e);
    return http("payments/xiaodou",e,{"X-XD-Webhook-Event-Id":id,"X-XD-Webhook-Event-Type":type,
      "X-XD-Webhook-Key-Id":"provider","X-XD-Webhook-Timestamp":ts,"X-XD-Webhook-Nonce":nonce,
      "X-XD-Webhook-Signature":signLines(["XD-Webhook-v1",id,type,ts,nonce,"provider",hash(data)],bad?merchant.privateKey:provider.privateKey)});
  }
  assert.equal((await http("micet/orders")).status,401);
  const back=await mf.dispatchFetch(origin+"/api/payments/return?status=SUCCEEDED",{redirect:"manual"});
  assert.equal(back.status,303);
  assert.equal(new URL(back.headers.get("Location"),origin).hash,"#orders");
  await poll();
  assert((await buy("Vape",202)).checking);
  assert.equal((await bridge("poll",{})).job,null);
  const check=await poll();assert.equal(check.kind,"tag-check");await receipt(check,"ok",false);
  breakSignature=true;await buy("Vape",401);breakSignature=false;
  const [a,b]=await Promise.all([buy("Vape"),buy("Vape")]);assert.equal(a.order.id,b.order.id);assert.equal(records.size,1);
  const vape=a.order;
  assert.equal(vape.qr_url,null);
  assert.equal((await event(vape,"PAYMENT_SUCCEEDED",{bad:true})).status,401);
  assert.equal((await event(vape,"PAYMENT_SUCCEEDED",{gross:1})).status,409);
  assert.equal((await orders())[0].status,"pending");
  await db.prepare("UPDATE shop_orders SET next_check=0").run();
  await json("payments/reconcile",{}, {Authorization:"Bearer local-scheduler"});
  assert.equal((await orders())[0].pay_url,vape.pay_url);
  records.get(vape.id).status="SUCCEEDED";
  await db.prepare("UPDATE shop_orders SET next_check=0").run();
  await json("payments/reconcile",{}, {Authorization:"Bearer local-scheduler"});
  const eid=randomUUID();
  assert.equal(await (await event(vape,"PAYMENT_SUCCEEDED",{id:eid})).text(),"success");
  assert.equal(await (await event(vape,"PAYMENT_SUCCEEDED",{id:eid})).text(),"success");
  const job=await poll();assert.equal(job.kind,"shop-deliver");await receipt(job,"retry");
  assert.equal((await orders())[0].status,"paid");
  await db.prepare("UPDATE bridge_jobs SET lease_until=0 WHERE id=?").bind(job.id).run();
  const next=await poll();assert.notEqual(next.lease,job.lease);await receipt(job,"ok");
  assert.equal((await orders())[0].status,"paid");await receipt(next,"ok");
  await event(vape,"PAYMENT_CLOSED",{amount:0});assert.equal((await orders())[0].status,"delivered");
  assert.equal((await event(vape,"REFUND_SUCCEEDED")).status,200);assert.equal((await orders())[0].status,"refund_review");
  await buy("Heart",202);const heartCheck=await poll();await receipt(heartCheck,"ok",true);await buy("Heart",409);
  await db.prepare("DELETE FROM bridge_jobs WHERE id=?").bind(heartCheck.id).run();
  await buy("Heart",202);await receipt(await poll(),"ok",false);const {order:heart}=await buy("Heart");
  assert.equal(heart.qr_url,"https://qr.alipay.com/test");
  await event(heart,"PAYMENT_CLOSED",{amount:0});await event(heart,"PAYMENT_SUCCEEDED");await event(heart,"REFUND_SUCCEEDED");
  assert.equal(await poll(),null);await event(heart,"PAYMENT_SUCCEEDED");
  assert.equal((await orders()).find(o=>o.id===heart.id).status,"refunded");
  const first=(await buy("Heart")).order;
  await event(first,"PAYMENT_CLOSED",{amount:0});
  const second=(await buy("Heart")).order;
  assert.notEqual(first.id,second.id);
  await event(first,"PAYMENT_SUCCEEDED");
  assert.equal((await orders()).find(o=>o.id===first.id).status,"paid");
  assert.equal((await orders()).find(o=>o.id===second.id).status,"closed");
  const repeated=randomUUID();
  const results=await Promise.all([event(second,"PAYMENT_SUCCEEDED",{id:repeated}),event(second,"PAYMENT_SUCCEEDED",{id:repeated})]);
  assert.deepEqual(results.map(r=>r.status),[200,200]);
  assert.equal((await orders()).find(o=>o.id===second.id).status,"duplicate");
  assert.equal((await poll()).id,first.id);
  assert.equal(await poll(),null);
  const other="cd".repeat(32);
  await db.prepare("INSERT INTO web_sessions VALUES(?,?,?,?)").bind(hash(other),randomUUID(),"Other",Date.now()+3600000).run();
  assert.deepEqual((await json("micet/orders",undefined,{Cookie:"__Host-micet-session="+other})).orders,[]);
});

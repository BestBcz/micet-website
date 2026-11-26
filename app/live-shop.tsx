"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { api } from "@/lib/micet-client";
import { catalog, type Link } from "@/lib/micet-data";

type Channel = "WECHAT_H5" | "ALIPAY_H5";
type Product = { name: string; amount: number | null };
type Offer = { products: Product[]; channels: Channel[] };
type Purchase = { id: string; player: string; sku: string; amount: number; channel: Channel;
  status: string; pay_url: string | null; qr_url: string | null; expires_at: number | null };
const label: Record<Channel,string> = {WECHAT_H5:"微信支付",ALIPAY_H5:"支付宝"};
const states: Record<string,string> = {pending:"待付款",paid:"已付款，等待游戏发放",delivered:"已到账",review:"发放待人工核查",
  closed:"已关闭",failed:"支付失败",duplicate:"重复付款，待人工处理",refunded:"已退款",refund_review:"退款待人工核查"};
const price = (fen:number) => "¥" + (fen/100).toFixed(2);

function Cashier({order}:{order:Purchase}) {
  const material = order.qr_url || order.pay_url;
  const image = useMemo(() => {
    if (!material) return null;
    const qr = qrcode(0,"M");
    qr.addData(material,"Byte");
    qr.make();
    return qr.createDataURL(5,20);
  },[material]);
  if (!order.pay_url || !image) return <p>当前没有可用的付款码。点击「继续付款」检查原订单。</p>;
  return <div className="vstack">
    {image && <img src={image} alt={label[order.channel]+"付款二维码"} width={210} height={210} style={{maxWidth:"100%",height:"auto",imageRendering:"pixelated"}}/>}
    <a className="btn primary" href={order.pay_url} rel="noreferrer" referrerPolicy="no-referrer">打开{label[order.channel]}收银台</a>
    <small>{order.channel==="WECHAT_H5" ? "请用微信扫码，或在微信内打开收银台。" : "请用支付宝扫码或打开收银台。"}</small>
  </div>;
}

function LookupFields({contact,password,onContact,onPassword,creating=false}:{contact:string;password:string;onContact:(s:string)=>void;onPassword:(s:string)=>void;creating?:boolean}) {
  return <>
    <label htmlFor="order-contact">买家的 QQ 号或邮箱</label>
    <input id="order-contact" className="shop-player" value={contact} onChange={e=>onContact(e.target.value)}
      autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} required/>
    <label htmlFor="order-password">订单查询密码</label>
    <input id="order-password" className="shop-player" type="password" value={password} onChange={e=>onPassword(e.target.value)}
      autoComplete={creating?"new-password":"current-password"} minLength={5} maxLength={128} required/>
  </>;
}

export function LiveShop({linked,onOrder}:{linked?:Link|null;onOrder:(id:string)=>void}) {
  const [contact,setContact]=useState("");
  const [password,setPassword]=useState("");
  const [confirm,setConfirm]=useState("");
  const [offer,setOffer]=useState<Offer>();
  const [selected,select]=useState<Product>();
  const [busy,setBusy]=useState(false);
  const [typedPlayer,setPlayer]=useState<string>();
  const player=typedPlayer ?? linked?.player ?? "";
  const [recipient,setRecipient]=useState<Link>();
  const [error,setError]=useState("");
  const [revision,retry]=useState(0);
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>{
    const stop=new AbortController();
    api<Offer>("shop",undefined,stop.signal).then(setOffer).catch(e=>{if(!stop.signal.aborted)setError(e.message);});
    return ()=>{stop.abort();pending.current?.abort();};
  },[revision]);
  async function submit(channel?:Channel) {
    if (!selected || pending.current || (channel && !recipient)) return;
    if (channel && password!==confirm) {setError("两次输入的查询密码不一致。");return;}
    const stop=new AbortController();
    pending.current=stop;
    setBusy(true); setError("");
    try {
      for(let i=0;i<20;i++){
        const result=await api<{order?:Purchase;recipient?:Link;checking?:boolean}>(channel ? "checkout" : "recipient",
          {sku:selected.name,player:player.trim(),amount:selected.amount,channel,recipientUuid:recipient?.uuid,...(channel?{contact,password}:{})},stop.signal);
        if(result.recipient){setRecipient(result.recipient);return;}
        if(result.order){ onOrder(result.order.id);return; }
        if(!result.checking)break;
        await new Promise(resolve=>setTimeout(resolve,1000));
        stop.signal.throwIfAborted();
      }
      throw new Error("游戏服未能及时核对权益，请稍后再试。");
    } catch(e){if(!stop.signal.aborted)setError((e as Error).message);}
    finally {pending.current=null;if(!stop.signal.aborted)setBusy(false);}
  }
  return <>
    <div className="page-intro"><h1>商店</h1><a className="sub-link" href="#orders">我的订单</a></div>
    <div className="cards">{catalog.map(tag=>{
      const product=offer?.products.find(i=>i.name===tag.name);
      return <article className="panel card vstack" key={tag.name}><h2><span className={"tag tag-"+tag.color}>[{tag.prefix}]</span> {tag.name}</h2>
        <p>永久称号{product?.amount ? " · "+price(product.amount) : ""}</p>
        {product?.amount && offer?.channels.length ? <button className="btn" disabled={busy} onClick={()=>{select(product);setRecipient(undefined);setError("");}}>购买 {tag.name}</button>
          : <small>仅供展示</small>}</article>;
    })}</div>
    {selected && <section className="panel card vstack" aria-label="确认订单"><h2>购买 {selected.name}</h2>
      <form className="vstack" onSubmit={e=>{e.preventDefault();void submit();}}>
        <label htmlFor="shop-player">收货玩家的游戏 ID</label>
        <input id="shop-player" className="shop-player" value={player} maxLength={16} autoCapitalize="none" autoCorrect="off" spellCheck={false}
          required pattern="[A-Za-z0-9_]{1,16}" disabled={busy} aria-describedby="shop-hint"
          onChange={e=>{setPlayer(e.target.value);setRecipient(undefined);setError("");}}/>
        <small id="shop-hint">填自己或朋友的游戏 ID，收货玩家可以离线。</small>
        {!recipient && <button className="btn" disabled={busy || !player.trim()}>核验收货玩家</button>}
      </form>
      {recipient && <><p role="status">收货角色 <strong>{recipient.player}</strong> · 永久解锁 · 实付 {price(selected.amount!)}</p>
        <form className="vstack" onSubmit={e=>{
          e.preventDefault();
          const button=(e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null;
          const channel=offer?.channels.find(c=>c===button?.value);
          if(channel) void submit(channel);
        }}>
          <small>请为这笔订单设一个独立查询密码（至少 5 个字符）。换设备时，用同一组 QQ 号或邮箱和密码查询。</small>
          <LookupFields creating contact={contact} password={password} onContact={setContact} onPassword={setPassword}/>
          <label htmlFor="order-confirm">确认查询密码</label>
          <input id="order-confirm" className="shop-player" type="password" autoComplete="new-password" value={confirm}
            onChange={e=>setConfirm(e.target.value)} minLength={5} maxLength={128} required/>
          {offer?.channels.map(c=><button key={c} value={c} disabled={busy} className="btn primary">{label[c]}</button>)}
        </form></>}
      {busy && <p role="status">{recipient ? "正在准备收银台…" : "正在查找玩家档案…"}</p>}</section>}
    {error && <p role="alert">{error} {!offer && <button className="btn" onClick={()=>{setError("");retry(n=>n+1);}}>重试</button>}</p>}
  </>;
}

function PaymentDetails({order,onUpdate}:{order:Purchase;onUpdate:(order:Purchase)=>void}) {
  const [checking,setChecking]=useState(false);
  const [notice,setNotice]=useState("");
  const [unverifiedUrl,setUnverifiedUrl]=useState<string|null>(null);
  async function resume() {
    setChecking(true);
    setNotice("");
    try {
      const result=await api<{order:Purchase}>("continue-payment",{id:order.id});
      setUnverifiedUrl(null);
      onUpdate(result.order);
      if(result.order.status==="pending" && !result.order.pay_url) setNotice("支付状态正在核对，请稍后再试。");
    } catch(e) {setUnverifiedUrl(order.pay_url);setNotice((e as Error).message);}
    finally {setChecking(false);}
  }
  return <div className="vstack">
    {!checking && (!unverifiedUrl || unverifiedUrl!==order.pay_url) && <Cashier order={order}/>}
    <button className="btn" disabled={checking} onClick={()=>void resume()}>{checking?"正在核对订单…":"继续付款"}</button>
    {notice && <p role="status">{notice}</p>}
  </div>;
}

export function LiveOrders({linked,focus}:{linked?:Link|null;focus?:string}) {
  const [orders,setOrders]=useState<Purchase[]>();
  const [contact,setContact]=useState("");
  const [password,setPassword]=useState("");
  const [unlocked,setUnlocked]=useState(false);
  const [busy,setBusy]=useState(false);
  const [lookupError,setLookupError]=useState("");
  const [error,setError]=useState("");
  const [revision,refresh]=useState(0);
  const [expanded,expand]=useState<string|null>(focus ?? null);
  useEffect(()=>{
    const stop=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    async function update(){
      try{
        const data=await api<{orders:Purchase[];unlocked:boolean}>("orders",undefined,stop.signal);
        if(stop.signal.aborted)return;
        setOrders(data.orders);setUnlocked(data.unlocked);setError("");
        if(data.orders.some(o=>o.status==="pending"||o.status==="paid"))timer=setTimeout(update,3500);
        else if (data.unlocked) timer=setTimeout(update,60000);
      } catch(e){if(!stop.signal.aborted)setError((e as Error).message);}
    }
    void update(); return ()=>{stop.abort();clearTimeout(timer);};
  },[linked,revision]);
  async function lookup(close=false) {
    setBusy(true);setLookupError("");
    try {
      await api("order-lookup",close?{close:true}:{contact,password});
      setPassword("");setOrders(undefined);setUnlocked(!close);
      if (close) setContact("");
      refresh(n=>n+1);
    } catch(e) {setLookupError((e as Error).message);}
    finally {setBusy(false);}
  }
  return <><div className="page-intro"><a className="crumb" href="#shop">返回商店</a><h1>我的订单</h1></div>
    {error && <p role="alert">{error} <button className="btn" onClick={()=>refresh(n=>n+1)}>重试</button></p>}
    {unlocked ? <button className="btn" disabled={busy} onClick={()=>void lookup(true)}>退出订单查询</button> :
      <form className="panel card vstack" onSubmit={e=>{e.preventDefault();void lookup();}}>
        <p>输入下单时填写的 QQ 号或邮箱和查询密码，可在任何设备查看对应订单。</p>
        <LookupFields contact={contact} password={password} onContact={setContact} onPassword={setPassword}/>
        <button className="btn primary" disabled={busy}>{busy?"正在查询…":"查询订单"}</button>
      </form>}
    {lookupError && <p role="alert">{lookupError}</p>}
    {!unlocked && Boolean(orders?.length) && <h2>历史购买记录</h2>}
    {!orders ? <p>正在读取订单…</p> : !orders.length ? (unlocked && <p>暂无订单。</p>) :
      <div className="vstack">{orders.map((o,index)=><article key={o.id} className="panel card vstack">
        <h2>{o.sku} · {price(o.amount)}</h2><p>{o.player} · 永久解锁 · {label[o.channel]}</p><strong>{states[o.status]??"待核查"}</strong>
        {o.status==="paid" && <small>正在向收货角色发放，离线也可到账。</small>}
        {o.status==="pending" && <><button className="btn" onClick={()=>expand((expanded??orders[0].id)===o.id?"":o.id)}>付款详情</button>
        {(expanded===o.id || (expanded===null && index===0)) && <PaymentDetails order={o} onUpdate={updated=>{
          setOrders(list=>list?.map(existing=>existing.id===updated.id?updated:existing));
          refresh(n=>n+1);
        }}/>}</>}
        <small>订单 {o.id}</small></article>)}</div>}</>;
}

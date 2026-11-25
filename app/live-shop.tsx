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
  if (!order.pay_url || !image) return <p>{order.expires_at ? "支付窗口已结束，正在核对订单。" : "支付入口尚未生成，请返回商店继续下单。"}</p>;
  return <div className="vstack">
    {image && <img src={image} alt={label[order.channel]+"付款二维码"} width={210} height={210} style={{maxWidth:"100%",height:"auto",imageRendering:"pixelated"}}/>}
    <a className="btn primary" href={order.pay_url} rel="noreferrer" referrerPolicy="no-referrer">打开{label[order.channel]}收银台</a>
    <small>{order.channel==="WECHAT_H5" ? "请用微信扫码，或在微信内打开收银台。" : "请用支付宝扫码或打开收银台。"}</small>
  </div>;
}

export function LiveShop({linked,onOrder}:{linked?:Link|null;onOrder:(id:string)=>void}) {
  const [offer,setOffer]=useState<Offer>();
  const [selected,select]=useState<Product>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [revision,retry]=useState(0);
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>{
    const stop=new AbortController();
    api<Offer>("shop",undefined,stop.signal).then(setOffer).catch(e=>{if(!stop.signal.aborted)setError(e.message);});
    return ()=>{stop.abort();pending.current?.abort();};
  },[revision,linked?.uuid]);
  async function buy(channel:Channel) {
    if (!selected || !linked || pending.current) return;
    const stop=new AbortController();
    pending.current=stop;
    setBusy(true); setError("");
    try {
      for(let i=0;i<20;i++){
        const result=await api<{order?:Purchase;checking?:boolean}>("checkout",{sku:selected.name,amount:selected.amount,channel},stop.signal);
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
    <div className="page-intro"><h1>Tag 商店</h1><a className="sub-link" href="#orders">我的订单</a></div>
    <div className="cards">{catalog.map(tag=>{
      const product=offer?.products.find(i=>i.name===tag.name);
      return <article className="panel card vstack" key={tag.name}><h2><span className={"tag tag-"+tag.color}>[{tag.prefix}]</span> {tag.name}</h2>
        <p>永久称号{product?.amount ? " · "+price(product.amount) : ""}</p>
        {product?.amount && offer?.channels.length ? linked ? <button className="btn" disabled={busy} onClick={()=>{select(product);setError("");}}>购买 {tag.name}</button>
          : <a href="#account" className="btn">绑定账号后购买</a> : <small>仅供展示</small>}</article>;
    })}</div>
    {selected && linked && <section className="panel card vstack" aria-label="确认订单"><h2>确认购买 {selected.name}</h2>
      <p>接收角色 {linked.player} · 永久解锁 · 实付 {price(selected.amount!)}</p>
      {offer?.channels.map(c=><button key={c} disabled={busy} className="btn primary" onClick={()=>void buy(c)}>{label[c]}</button>)}
      {busy && <p role="status">正在核对游戏权益并准备收银台…</p>}</section>}
    {error && <p role="alert">{error} {!offer && <button className="btn" onClick={()=>{setError("");retry(n=>n+1);}}>重试</button>}</p>}
  </>;
}

export function LiveOrders({linked,focus}:{linked?:Link|null;focus?:string}) {
  const [orders,setOrders]=useState<Purchase[]>();
  const [error,setError]=useState("");
  const [revision,refresh]=useState(0);
  const [expanded,expand]=useState<string|null>(focus ?? null);
  useEffect(()=>{
    if(!linked)return;
    const stop=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    async function update(){
      try{
        const data=await api<{orders:Purchase[]}>("orders",undefined,stop.signal);
        if(stop.signal.aborted)return;
        setOrders(data.orders);setError("");
        if(data.orders.some(o=>o.status==="pending"||o.status==="paid"))timer=setTimeout(update,3500);
      } catch(e){if(!stop.signal.aborted)setError((e as Error).message);}
    }
    void update(); return ()=>{stop.abort();clearTimeout(timer);};
  },[linked,revision]);
  return <><div className="page-intro"><a className="crumb" href="#shop">返回商店</a><h1>我的订单</h1></div>
    {error && <p role="alert">{error} <button className="btn" onClick={()=>refresh(n=>n+1)}>重试</button></p>}
    {!linked ? linked===null ? <a className="btn" href="#account">绑定账号查看订单</a> : <p>正在读取账号…</p> :
      !orders ? <p>正在读取订单…</p> : !orders.length ? <p>暂无订单。</p> :
      <div className="vstack">{orders.map((o,index)=><article key={o.id} className="panel card vstack">
        <h2>{o.sku} · {price(o.amount)}</h2><p>{o.player} · 永久解锁 · {label[o.channel]}</p><strong>{states[o.status]??"待核查"}</strong>
        {o.status==="paid" && <small>进入 Practice 后可领取，到账后会自动更新。</small>}
        {o.status==="pending" && <><button className="btn" onClick={()=>expand((expanded??orders[0].id)===o.id?"":o.id)}>付款详情</button>
        {(expanded===o.id || (expanded===null && index===0)) && <Cashier order={o}/>}</>}
        <small>订单 {o.id}</small></article>)}</div>}</>;
}

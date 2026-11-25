"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  DEMO_PLAYER, TEST_SKU, catalog, demoBoards, testTag, type Board, type Link, type Match, type Mode, type Order, type Profile,
} from "@/lib/micet-data";
import { api, readPublicStats, readStats } from "@/lib/micet-client";
import { demoMatchPattern, matchUuidPattern } from "@/lib/micet-match-detail";
import { ServerHome } from "./server-home";
import { LiveShop, LiveOrders } from "./live-shop";
import { enterRows } from "./site-motion";
import { MatchDetailPage } from "./match-detail";
import serverLogo from "./micet-logo.png?inline";
import "./micet.css";

type View = "home" | "stats" | "ranking" | "player" | "matches" | "match" | "shop" | "orders" | "account";
type Route = { view: View; player?: string; matchId?: string; orderId?: string; backward?: boolean };
type SiteStatus = { mode: Mode; linked: Link | null; connected: boolean };
type Code = { code: string; expiresAt: number };

const views: View[] = ["home", "stats", "ranking", "player", "matches", "match", "shop", "orders", "account"];
const menu: Array<[View, string]> = [["home", "首页"], ["stats", "战绩查询"], ["ranking", "Elo 排行"], ["matches", "我的对局"], ["shop", "Tag 商店"]];
const publicMenu: Array<[View, string]> = [["home", "首页"], ["shop", "游戏 Tag"]];
function navView(view: View) {
  if (view === "player") return "stats";
  if (view === "match") return "matches";
  return view;
}

function rowDelay(index: number) {
  return { "--row-delay": Math.min(index, 7) * 35 + "ms" } as CSSProperties;
}
const formatNumber = (value: number | null) => value === null ? "—" : value.toLocaleString("en-US");
const formatDate = (value: number) => new Intl.DateTimeFormat("zh-CN", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(value);

function parseRoute(publicLaunch: boolean, selfHosted: boolean): Route {
  const [raw, name] = window.location.hash.slice(1).split("/");
  if (publicLaunch) return { view: raw === "shop" ? "shop" : "home" };
  if (selfHosted && raw === "orders") return { view: "orders", orderId: name };
  if (!views.includes(raw as View)) return { view: "home" };
  if (raw === "match") {
    return name && (demoMatchPattern.test(name) || matchUuidPattern.test(name))
      ? { view: "match", matchId: name.toLowerCase() } : { view: "matches" };
  }
  if (raw !== "player") return { view: raw as View };
  if (!name || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return { view: "home" };
  return { view: "player", player: name };
}

function Avatar({ name, uuid }: { name: string; uuid?: string }) {
  const [failedUuid, setFailedUuid] = useState<string>();
  const skin = uuid && uuid !== failedUuid && matchUuidPattern.test(uuid);
  return <span aria-hidden="true" className="avatar">{skin
    ? <img src={`https://mc-heads.net/avatar/${uuid}/48`} width={48} height={48} alt="" loading="lazy"
      referrerPolicy="no-referrer" onError={() => setFailedUuid(uuid)} />
    : name.slice(0, 1).toUpperCase()}</span>;
}

function HeroTitle({ home = false }: { home?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const heading = ref.current;
    if (!heading || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      heading.dataset.entered = "true";
      observer.disconnect();
    });
    observer.observe(heading);
    return () => observer.disconnect();
  }, []);

  const letters = (text: string, offset: number) => Array.from(text, (letter, index) =>
    <span className="title-letter" key={index} data-glyph={home && offset > 0 ? letter : undefined} style={{ "--letter-delay": (offset + index) * 35 + "ms" } as CSSProperties}>{letter}</span>);

  if (home) return <h1 id="server-title" className="hero-title server-title" ref={ref} aria-label="MiCet.cc">
    <span className="title-line" aria-hidden="true">{letters("MiCet", 0)}<span className="title-accent">{letters(".cc", 5)}</span></span>
  </h1>;

  return <h1 id="hero-title" className="hero-title" ref={ref} aria-label="MiCet 竞技战绩">
    <span className="title-line title-brand" aria-hidden="true">{letters("MiCet", 0)}</span>
    <span className="title-line title-cn" aria-hidden="true">{letters("竞技", 5)}<span className="title-accent">{letters("战绩", 7)}</span></span>
  </h1>;
}

function Search({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const inputId = useId();
  const errorId = inputId + "-error";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = value.trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
      setError("请输入 1–16 位有效的 Minecraft 玩家名。");
      return;
    }
    setError("");
    window.location.hash = "player/" + name;
  }
  return <div className="player-search">
    <label className="search-label" htmlFor={inputId}>Minecraft 玩家名</label>
    <form className="search" role="search" onSubmit={submit}>
      <span className="magnify" aria-hidden="true" />
      <input id={inputId} value={value} onChange={event => { setValue(event.target.value); setError(""); }} placeholder="输入游戏名" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={16} />
      <button type="submit" className="btn primary">查战绩</button>
    </form>
    {error && <p id={errorId} role="alert" className="inline-error">{error}</p>}
  </div>;
}

function PageIntro({ name, children }: { name: string; children?: ReactNode }) {
  return <div className="page-intro"><a className="crumb" href="#home">MiCet.cc</a><h1>{name}</h1>{children}</div>;
}

function Message({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p className={"message" + (error ? " error" : "")} role={error ? "alert" : "status"}>{children}</p>;
}

function Ranking({ mode, selfHosted, side = false }: { mode: Mode; selfHosted: boolean; side?: boolean }) {
  const [boards, setBoards] = useState<Board[]>(mode === "demo" ? demoBoards : []);
  const [selected, setSelected] = useState("global");
  const [backward, setBackward] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (mode === "demo") return;
    const stop = new AbortController();
    const load = selfHosted ? readPublicStats<Board[]>("leaderboard", stop.signal) : readStats<Board[]>("boards", stop.signal);
    load.then(setBoards).catch(err => { if (!stop.signal.aborted) setError(err.message); });
    return () => stop.abort();
  }, [mode, retry, selfHosted]);
  const board = boards.find(item => item.id === selected) ?? boards[0];
  return <section className="section" aria-label={side ? undefined : "Elo 排行榜"} aria-labelledby={side ? "rank-heading" : undefined}>
    {side && <div className="section-title"><div><h2 id="rank-heading">Elo 排行榜</h2><p>按玩法查看 MiCet 排位高手。</p></div>{!selfHosted && <span className="note">{mode === "demo" ? "示例排名" : "测试服"}</span>}</div>}
    <div className={side ? "score-layout" : ""}>
      <div className="panel">
        {boards.length > 0 && <div className="pills" aria-label="玩法" data-backward={backward}>{boards.map((item, index) =>
          <button type="button" key={item.id} className="pill" aria-pressed={board?.id === item.id} onClick={() => {
            if (board === item) return;
            setBackward(index < boards.indexOf(board));
            setSelected(item.id);
          }}>{item.name}</button>)}</div>}
        {error ? <Message error>{error} <button className="btn" onClick={() => { setError(""); setRetry(n => n + 1); }}>重试</button></Message>
          : !board ? <Message>正在查询排行榜…</Message>
          : board.entries.length === 0 ? <Message>这个玩法暂无排位数据。</Message>
          : <table aria-label={board.name + " Elo 排行"}>
            <thead><tr><th scope="col">排名</th><th scope="col">玩家</th><th scope="col">Elo</th></tr></thead>
            <tbody key={board.id} ref={enterRows}>{board.entries.map((item, index) => <tr key={item.uuid} data-entry-row="" style={rowDelay(index)}>
              <td className="rank">#{index + 1}</td>
              <td><a className="player" href={"#player/" + item.player}><Avatar name={item.player} uuid={item.uuid} /><span>{item.player}</span></a></td>
              <td className="elo">{formatNumber(item.elo)}</td>
            </tr>)}</tbody>
          </table>}
      </div>
      {side && <aside className="side">
        <div className="panel side-panel"><h3>我的对局</h3><p>绑定 Minecraft 账号，查看最近比赛和 Elo 变化。</p><a href="#matches">查看对局</a></div>
        <div className="panel side-panel"><h3>游戏内 Tag</h3><p>{selfHosted ? "查看 MiCet 游戏内标签。" : "浏览装饰标签，体验站内测试结账。"}</p><a href="#shop">{selfHosted ? "查看标签" : "浏览商店"}</a></div>
      </aside>}
    </div>
  </section>;
}

function ProfilePage({ name, mode, selfHosted }: { name: string; mode: Mode; selfHosted: boolean }) {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const stop = new AbortController();
    const load = selfHosted ? readPublicStats<Profile | null>("player?name=" + encodeURIComponent(name), stop.signal)
      : readStats<Profile | null>("profile", stop.signal, { name });
    load.then(setProfile).catch(err => { if (!stop.signal.aborted) setError(err.message); });
    return () => stop.abort();
  }, [name, retry, selfHosted]);
  const global = profile?.scores.find(score => score.id === "global");
  const rate = (wins: number, losses: number) => wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) + "%" : "—";
  return <>
    <PageIntro name="玩家战绩"><Search initial={name} /></PageIntro>
    {error ? <div className="panel"><Message error>{error} <button className="btn" onClick={() => { setError(""); setRetry(n => n + 1); }}>重试</button></Message></div>
      : profile === undefined ? <div className="panel"><Message>正在查找 {name}…</Message></div>
      : profile === null ? <div className="panel"><Message>找不到玩家 {name}。请核对游戏名后再试。</Message></div>
      : <>
        <div className="panel stat-banner"><Avatar name={profile.player} uuid={profile.uuid} /><div><p className="label">{mode === "demo" ? "示例玩家" : "MiCet 玩家"}</p><h2>{profile.player}</h2></div></div>
        {global && <div className="score-cards">
          {[["综合 Elo", formatNumber(global.elo)], ["胜场", formatNumber(global.wins)], ["败场", formatNumber(global.losses)], ["胜率", rate(global.wins, global.losses)]].map(([label, value]) =>
            <div className="panel score-card" key={label}><span className="label">{label}</span><strong>{value}</strong></div>)}
        </div>}
        <div className="panel">
          <h3 className="detail-title">各玩法战绩</h3>
          {profile.scores.length > 1 ? <table className="stats">
            <thead><tr><th scope="col">玩法</th><th scope="col">Elo</th><th scope="col">胜</th><th scope="col">负</th><th scope="col">胜率</th></tr></thead>
            <tbody ref={enterRows}>{profile.scores.filter(row => row.id !== "global").map((row, index) =>
              <tr key={row.id} data-entry-row="" style={rowDelay(index)}><td className="kit-name">{row.name}</td><td className="elo">{formatNumber(row.elo)}</td><td>{row.wins}</td><td>{row.losses}</td><td>{rate(row.wins, row.losses)}</td></tr>)}</tbody>
          </table> : <Message>暂无分玩法战绩。</Message>}
        </div>
      </>}
  </>;
}

function MatchesPage({ linked }: { linked: Link | null | undefined }) {
  const [matches, setMatches] = useState<Match[]>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const uuid = linked?.uuid;
  useEffect(() => {
    if (!uuid) return;
    const stop = new AbortController();
    readStats<Match[]>("matches", stop.signal).then(setMatches).catch(err => { if (!stop.signal.aborted) setError(err.message); });
    return () => stop.abort();
  }, [uuid, retry]);
  const labels = { win: "胜利", loss: "战败", draw: "平局" };
  return <>
    <PageIntro name="我的对局"><p>{linked ? linked.player + " · 7 天内最近 27 场" : "查看个人对局、胜负和排位 Elo 变化。"}</p></PageIntro>
    <div className="panel">
      {linked === undefined ? <Message>正在读取绑定状态…</Message>
        : linked === null ? <Message><a className="btn primary" href="#account">绑定游戏账号</a></Message>
        : error ? <Message error>{error} <button className="btn" onClick={() => { setError(""); setRetry(n => n + 1); }}>重试</button></Message>
        : !matches ? <Message>正在查询近期对局…</Message>
        : matches.length === 0 ? <Message>最近 7 天暂无可查看的对局。</Message>
        : <div ref={enterRows}>{matches.map((match, index) => <a key={match.id} className="list-row match-link" data-entry-row="" style={rowDelay(index)} href={"#match/" + match.id}>
          <div><strong>{match.kit} · {match.opponents.length ? match.opponents.join(" / ") : "未知对手"}</strong><small>{match.ranked ? "排位" : "非排位"} · {formatDate(match.endedAt)}</small></div>
          <div className={"result " + match.result}>{labels[match.result]}{match.delta !== null && <div>{match.delta > 0 ? "+" : ""}{match.delta} Elo</div>}<span className="match-link-label">查看详情</span></div>
        </a>)}</div>}
    </div>
  </>;
}

function AccountPage({ mode, selfHosted, linked, connected, onRefresh }: { mode: Mode; selfHosted: boolean; linked?: Link | null; connected?: boolean; onRefresh: () => Promise<void> }) {
  const [code, setCode] = useState<Code>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function issue() {
    setBusy(true); setError("");
    try { setCode(await api<Code>("code", {})); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function verifyDemo() {
    if (!code) return;
    setBusy(true); setError("");
    try { await api("demo-link", { code: code.code }); await onRefresh(); setCode(undefined); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function checkBinding() {
    setBusy(true); setError("");
    try {
      if (selfHosted) await api("confirm", {});
      await onRefresh();
      setCode(undefined);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError("");
    try { await api("logout", {}); await onRefresh(); setCode(undefined); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <PageIntro name="绑定游戏账号"><p>{selfHosted ? "验证你的 Minecraft 账号，访问个人对局。" : "用 Minecraft 账号确认对局和 Tag 发放的接收人。"}</p></PageIntro>
    <div className="panel card vstack">
      {linked ? <><p><strong>{linked.player}</strong> · 已绑定{mode === "demo" ? "（示例账号）" : ""}</p><a className="btn primary" href="#matches">查看我的对局</a>
        {selfHosted && <button className="btn" disabled={busy} onClick={logout}>退出当前浏览器</button>}</>
        : <>
          {mode === "bridge" && connected === false && <p>游戏服桥接离线。恢复连接后可在游戏内输入绑定指令。</p>}
          <button className="btn primary" disabled={busy || linked === undefined || (selfHosted && connected === false)} onClick={issue}>{code ? "重新生成验证码" : "生成一次性验证码"}</button>
          {code && <div className="vstack">
            <p>{selfHosted ? "请在 MiCet Practice 服输入本页生成的验证码。验证码 5 分钟内有效。" : `请在${mode === "demo" ? "示例" : "测试"}服输入，验证码 5 分钟内有效。`}</p>
            <code className="code">/micetlink {code.code}</code>
            {mode === "demo" ? <button className="btn" disabled={busy} onClick={verifyDemo}>模拟游戏内验证</button>
              : !selfHosted && <button className="btn" disabled={busy} onClick={checkBinding}>检查绑定结果</button>}
          </div>}
          {selfHosted && linked === null && <button className="btn" disabled={busy} onClick={checkBinding}>完成绑定</button>}
        </>}
      {error && <p role="alert" className="inline-error">{error}</p>}
    </div>
  </>;
}

function ShopPage({ catalogOnly, linked, onOrder }: { catalogOnly: boolean; linked?: Link | null; onOrder: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function checkout() {
    setBusy(true); setError("");
    try { const { order } = await api<{ order: Order }>("checkout", { sku: TEST_SKU }); onOrder(order.id); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <PageIntro name={catalogOnly ? "游戏 Tag" : "Tag 商店"}><p>查看 MiCet 游戏内标签。站内购买筹备中。</p></PageIntro>
    {!catalogOnly && <>
      <section className="panel feature" aria-label="测试商品">
        <div><span className="tag tag-test">[{testTag.tag}]</span><h2>{testTag.name}</h2><p>{testTag.description} 本次测试无需付款。</p></div>
        {linked === null ? <a className="btn primary" href="#account">绑定账号后结账</a>
          : <button className="btn primary" disabled={busy || linked === undefined} onClick={checkout}>{busy ? "正在创建…" : "创建测试订单"}</button>}
      </section>
      {error && <p role="alert" className="inline-error">{error}</p>}
    </>}
    <div className="section">
      <div className="section-title">
        <div><h2>标签列表</h2><p>共 {catalog.length} 个</p></div>
        {!catalogOnly && <a className="sub-link" href="#orders">查看订单</a>}
      </div>
      <div className="cards">{catalog.map(item =>
        <article key={item.name} className="panel card">
          <h3 className="catalog-tag-name">
            <span className={`tag tag-${item.color}`}>[{item.prefix}]</span>
            {item.prefix !== item.name && <span className="catalog-tag-caption">{item.name}</span>}
          </h3>
        </article>)}</div>
    </div>
  </>;
}

const statusLabel = { pending: "待支付", paid: "待发放", delivered: "已发放", failed: "发放异常" };

function OrdersPage({ mode, focus }: { mode: Mode; focus: string }) {
  const [orders, setOrders] = useState<Order[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      try {
        if (mode === "demo") await api("demo-progress", {}, stop.signal);
        const data = await api<{ orders: Order[] }>("orders", undefined, stop.signal);
        setOrders(data.orders);
        if (data.orders.some(order => order.status === "paid")) timer = setTimeout(update, 2200);
      } catch (err) { if (!stop.signal.aborted) setError((err as Error).message); }
    };
    void update();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [mode, revision]);
  async function pay(id: string) {
    setBusy(id); setError("");
    try { await api("pay", { id }); refresh(n => n + 1); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(undefined); }
  }
  return <>
    <PageIntro name="我的订单"><p>{mode === "demo" ? "模拟支付 · 模拟发货" : "模拟支付 · 测试服发货"}</p></PageIntro>
    {error && <p className="inline-error" role="alert">{error} <button className="btn" onClick={() => { setError(""); refresh(n => n + 1); }}>重试</button></p>}
    <div className="vstack">
      {!orders ? <div className="panel"><Message>正在读取订单…</Message></div>
        : !orders.length ? <div className="panel"><Message>暂无订单。 <a className="sub-link" href="#shop">前往 Tag 商店</a></Message></div>
        : orders.map(order => <article key={order.id} className={"panel card vstack" + (focus === order.id ? " order-focus" : "")}>
          <div className="section-title"><div><span className="tag tag-test">[MICET TEST]</span><h2>测试标签</h2></div><span className="order-status" role="status">{statusLabel[order.status]}</span></div>
          <p>接收人 {order.player} · {formatDate(order.created_at)}{order.detail ? " · " + order.detail : ""}</p>
          <small className="label">订单 {order.id}</small>
          {order.status === "pending" && <button className="btn primary" disabled={busy === order.id} onClick={() => void pay(order.id)}>确认模拟支付</button>}
          {order.status === "paid" && <small className="label">{mode === "demo" ? "等待模拟发货回执" : "等待测试服发货回执"}</small>}
        </article>)}
    </div>
  </>;
}

export function MicetSite({ mode, publicLaunch, selfHosted }: { mode: Mode; publicLaunch: boolean; selfHosted: boolean }) {
  const [route, setRoute] = useState<Route>({ view: "home" });
  const [status, setStatus] = useState<SiteStatus>();
  const [statusError, setStatusError] = useState("");
  const [orderFocus, setOrderFocus] = useState("");
  const main = useRef<HTMLElement>(null);
  async function refreshStatus() {
    try { setStatus(await api<SiteStatus>("status")); setStatusError(""); }
    catch (err) { setStatusError((err as Error).message); throw err; }
  }
  useEffect(() => {
    const update = () => {
      const next = parseRoute(publicLaunch, selfHosted);
      const position = (view: View) => menu.findIndex(([key]) => key === navView(view));
      setRoute(previous => ({ ...next, backward: position(next.view) < position(previous.view) }));
      window.scrollTo(0, 0);
    };
    const navigate = () => { update(); main.current?.focus({ preventScroll: true }); };
    update();
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [publicLaunch, selfHosted]);
  useEffect(() => {
    if (publicLaunch) return;
    const stop = new AbortController();
    void api<SiteStatus>("status", undefined, stop.signal).then(
      value => { if (!stop.signal.aborted) setStatus(value); },
      err => { if (!stop.signal.aborted) setStatusError((err as Error).message); },
    );
    return () => stop.abort();
  }, [publicLaunch]);
  const view = route.view;
  return <>
    <a className="skip-link" href="#main" onClick={event => {
      event.preventDefault();
      main.current?.focus();
      main.current?.scrollIntoView();
    }}>跳到主要内容</a>
    <header className="site-header"><div className="shell top">
      <a className="brand" href="#home" aria-label="MiCet.cc 首页"><img src={serverLogo} className="brand-logo" width={32} height={32} alt="" /><span>MiCet.cc</span></a>
      <nav aria-label="站点导航" data-backward={route.backward}>{(publicLaunch ? publicMenu : menu).map(([key, label]) =>
        <a key={key} href={"#" + key} aria-current={navView(view) === key ? "page" : undefined}>{label}</a>)}</nav>
      {!publicLaunch && <a className="btn top-account" href="#account">{status?.linked?.player ?? "绑定账号"}</a>}
    </div></header>
    <main className="shell" id="main" ref={main} tabIndex={-1}>
      {statusError && <p className="inline-error" role="alert">{statusError} <button className="btn" onClick={() => void refreshStatus().catch(() => {})}>重试</button></p>}
      {view === "home" && <ServerHome title={<HeroTitle home />} publicLaunch={publicLaunch} />}
      {view === "stats" && <>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-meta">
            <span className="hero-context">Elo Lookup</span>
            {!selfHosted && <span className="env">{mode === "demo" ? "私有预览 · 示例数据" : "私有预览 · 测试服"}</span>}
          </div>
          <div className="hero-grid">
            <HeroTitle />
            <div className="hero-lookup">
              <p className="hero-description">按游戏名查询 Elo、胜负场次和胜率。</p>
              <Search />
              {mode === "demo" && <p className="sample">查看 <a href={"#player/" + DEMO_PLAYER}>{DEMO_PLAYER}</a> 的示例战绩</p>}
            </div>
          </div>
        </section>
        <Ranking mode={mode} selfHosted={selfHosted} side />
      </>}
      {view === "ranking" && <><PageIntro name="Elo 排行榜"><p>{mode === "demo" ? "示例数据 · " : ""}查看综合与各玩法前十名。</p></PageIntro><Ranking mode={mode} selfHosted={selfHosted} /></>}
      {view === "player" && route.player && <ProfilePage key={route.player} mode={mode} name={route.player} selfHosted={selfHosted} />}
      {view === "matches" && <MatchesPage key={status?.linked?.uuid ?? "unlinked"} linked={status?.linked} />}
      {view === "match" && route.matchId && <MatchDetailPage key={route.matchId + ":" + (status?.linked?.uuid ?? "")} id={route.matchId} linked={status?.linked} mode={mode} />}
      {view === "shop" && (selfHosted && !publicLaunch ? <LiveShop key={status?.linked?.uuid} linked={status?.linked} onOrder={id => { window.location.hash = "orders/" + id; }}/> :
        <ShopPage catalogOnly={publicLaunch} linked={status?.linked} onOrder={id => { setOrderFocus(id); window.location.hash = "orders"; }} />)}
      {view === "orders" && (selfHosted ? <LiveOrders key={status?.linked?.uuid} linked={status?.linked} focus={route.orderId}/> : <OrdersPage mode={mode} focus={orderFocus} />)}
      {view === "account" && <AccountPage mode={mode} selfHosted={selfHosted} linked={status?.linked} connected={status?.connected} onRefresh={refreshStatus} />}
    </main>
    <footer className="site-footer"><div className="shell footer-row">
      <span><strong>MiCet.cc</strong> · 1.7-1.8 Practice Server</span>
      {!publicLaunch && !selfHosted && <><a href="#orders">我的订单</a><span>{mode === "demo" ? "私有预览 · 示例数据" : "私有预览 · 测试服"}</span></>}
    </div></footer>
  </>;
}

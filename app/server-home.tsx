"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSiteMotion } from "./site-motion";
import { api } from "@/lib/micet-client";
import { SERVER_ADDRESS, type ServerStatus } from "@/lib/micet-server-status";
import "./server-home.css";

const colorCodes: Record<string, string> = {
  "0": "#000000", "1": "#0000aa", "2": "#00aa00", "3": "#00aaaa",
  "4": "#aa0000", "5": "#aa00aa", "6": "#ffaa00", "7": "#aaaaaa",
  "8": "#555555", "9": "#5555ff", a: "#55ff55", b: "#55ffff",
  c: "#ff5555", d: "#ff55ff", e: "#ffff55", f: "#ffffff",
};

function ObfuscatedText({ text }: { text: string }) {
  const enabled = useSiteMotion();
  const [display, setDisplay] = useState(text);
  useEffect(() => {
    if (!enabled) return;
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const timer = setInterval(() => {
      if (!document.hidden) setDisplay(text.replace(/[!-~]/g, () => characters[Math.floor(Math.random() * characters.length)]));
    }, 120);
    return () => clearInterval(timer);
  }, [enabled, text]);
  return <><span className="motd-sr-text">{text}</span><span aria-hidden="true">{enabled ? display : text}</span></>;
}

function MotdLine({ line }: { line: string }) {
  let style: CSSProperties = {};
  let underline = false;
  let strike = false;
  let obfuscated = false;
  const runs: { text: string; style: CSSProperties; obfuscated: boolean }[] = [];
  for (const [i, part] of line.split(/(§x(?:§[0-9a-f]){6}|§[0-9a-fk-or])/gi).entries()) {
    if (!part) continue;
    if (i % 2 === 0) {
      runs.push({ text: part, style, obfuscated });
      continue;
    }
    const code = part[1].toLowerCase();
    if (code === "r" || colorCodes[code] || code === "x") {
      const color = code === "x" ? "#" + part.slice(2).replaceAll("§", "") : colorCodes[code];
      style = color ? { color } : {};
      underline = false;
      strike = false;
      obfuscated = false;
    }
    if (code === "k") obfuscated = true;
    if (code === "l") style = { ...style, fontWeight: 800 };
    if (code === "o") style = { ...style, fontStyle: "italic" };
    if (code === "n" || code === "m") {
      underline ||= code === "n";
      strike ||= code === "m";
      style = { ...style, textDecorationLine: [underline && "underline", strike && "line-through"].filter(Boolean).join(" ") };
    }
  }
  return <div className="motd-line">{runs.map(({ text, style, obfuscated }, index) =>
    <span key={index} style={style}>{obfuscated ? <ObfuscatedText key={text} text={text} /> : text}</span>)}</div>;
}

const stateText = {
  online: "在线",
  unreachable: "服务器未响应",
  unknown: "暂时无法查询状态",
};

function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return <svg className="refresh-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
    </svg>;
  }
  return <svg className="refresh-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="5.5" y="5.5" width="8" height="8" stroke="currentColor" strokeWidth="1.4" />
    <path d="M10.5 5.5V3H3v7.5h2.5" stroke="currentColor" strokeWidth="1.4" />
  </svg>;
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return <svg className={"refresh-icon" + (spinning ? " spinning" : "")} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M13.2 8a5.2 5.2 0 1 1-1.35-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    <path d="M12.5 2.4v2.9H9.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
  </svg>;
}

function ServerRow({ onQuickCopy, quickCopied }: { onQuickCopy: () => void; quickCopied: boolean }) {
  const [status, setStatus] = useState<ServerStatus | null>();
  const [revision, refresh] = useState(0);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let spinTimer: ReturnType<typeof setTimeout>;
    let fetching = false;
    async function update(manual = false) {
      if (fetching || stop.signal.aborted || document.hidden) return;
      fetching = true;
      const started = performance.now();
      try {
        const result = await api<ServerStatus>("server-status", undefined, stop.signal);
        if (!stop.signal.aborted) setStatus(result);
      } catch {
        if (!stop.signal.aborted) setStatus(null);
      } finally {
        fetching = false;
        if (manual && !stop.signal.aborted) {
          const wait = Math.max(0, 420 - (performance.now() - started));
          spinTimer = setTimeout(() => { if (!stop.signal.aborted) setProbing(false); }, wait);
        }
        if (!stop.signal.aborted && !document.hidden) timer = setTimeout(() => void update(false), 2500);
      }
    }
    const changed = () => { clearTimeout(timer); void update(false); };
    void update(revision > 0);
    document.addEventListener("visibilitychange", changed);
    return () => {
      stop.abort();
      clearTimeout(timer);
      clearTimeout(spinTimer);
      document.removeEventListener("visibilitychange", changed);
    };
  }, [revision]);

  const state = status?.state ?? "unknown";
  const count = status?.onlinePlayers == null ? null : status.maxPlayers == null
    ? status.onlinePlayers + " 在线" : status.onlinePlayers + " / " + status.maxPlayers;
  const isInitialLoad = status === undefined;

  return <section className="server-list home-reveal" style={{ "--reveal-delay": "300ms" } as CSSProperties} aria-labelledby="server-list-title">
    <div className="server-list-head">
      <h2 id="server-list-title">服务器状态</h2>
      <div className="server-list-actions">
        <button className="btn compact ip-copy-btn" type="button" data-copied={quickCopied} onClick={onQuickCopy}>
          <CopyIcon copied={quickCopied} />
          <span>{quickCopied ? "已复制" : SERVER_ADDRESS}</span>
        </button>
        <button className="btn compact refresh-btn" type="button" disabled={probing} onClick={() => { setProbing(true); refresh(value => value + 1); }}>
          <RefreshIcon spinning={probing || isInitialLoad} />
          <span>刷新</span>
        </button>
      </div>
    </div>
    <div className="server-entry" data-probing={probing || isInitialLoad}>
      <div className="server-icon">
        {status?.icon ? <img src={status.icon} width={64} height={64} alt="" /> : <span className="mark" aria-hidden="true" />}
      </div>
      <div className="server-entry-content">
        <div className="server-entry-title">
          <h3>Minecraft 服务器</h3>
          <span className="server-addr-tag">{SERVER_ADDRESS}</span>
        </div>
        {status?.motd.length ? status.motd.map((line, i) => <MotdLine key={i} line={line} />)
          : <p className="motd-fallback">{isInitialLoad ? "正在读取服务器 MOTD…" : "暂时无法读取服务器 MOTD"}</p>}
      </div>
      <div className="server-signal" role="status" aria-label={isInitialLoad ? "正在查询服务器" : stateText[state] + (count ? " " + count : "")}>
        <span className={"signal-bars " + (isInitialLoad || probing ? "probing" : state === "online" ? "online" : "")} aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className={"server-players" + (state !== "online" ? " muted-state" : "")}>{isInitialLoad ? "查询中" : count ?? stateText[state]}</span>
      </div>
    </div>
  </section>;
}

export function ServerHome({ title }: { title: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState("");
  const [quickCopied, setQuickCopied] = useState(false);
  const quickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(quickTimer.current), []);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(SERVER_ADDRESS);
      setCopied("已复制服务器地址，可直接粘贴到多人游戏。");
    } catch {
      address.current?.focus();
      address.current?.select();
      setCopied("地址已选中，可手动复制。");
    }
  }

  async function copyQuickAddress() {
    try {
      await navigator.clipboard.writeText(SERVER_ADDRESS);
      setQuickCopied(true);
      clearTimeout(quickTimer.current);
      quickTimer.current = setTimeout(() => setQuickCopied(false), 2000);
    } catch {
      dialog.current?.showModal();
    }
  }

  return <>
    <section className="server-home" aria-labelledby="server-title">
      <div className="server-intro">
        <p className="server-eyebrow home-reveal" style={{ "--reveal-delay": "0ms" } as CSSProperties}>
          <span className="eyebrow-dot" aria-hidden="true" />
          1.7-1.8 Practice Server
        </p>
        {title}
        <p className="server-description home-reveal" style={{ "--reveal-delay": "150ms" } as CSSProperties}>
          查看你在服务器的每场战绩、排位榜单与背包回放。
        </p>
        <div className="server-actions home-reveal" style={{ "--reveal-delay": "220ms" } as CSSProperties}>
          <button className="btn primary play-now" type="button" onClick={() => dialog.current?.showModal()}>
            Play Now <span className="play-arrow" aria-hidden="true"><span>→</span></span>
          </button>
        </div>
      </div>

      <ServerRow onQuickCopy={() => void copyQuickAddress()} quickCopied={quickCopied} />

      <div className="home-portals home-reveal" style={{ "--reveal-delay": "380ms" } as CSSProperties} aria-label="快捷入口">
        <a className="panel home-portal" href="#stats">
          <div>
            <div className="portal-head"><span>01 / PROFILE</span><span className="portal-arrow" aria-hidden="true">→</span></div>
            <h3>战绩与档案</h3>
            <p>按游戏名检索综合 Elo、各玩法胜负场次与胜率。</p>
          </div>
        </a>
        <a className="panel home-portal" href="#ranking">
          <div>
            <div className="portal-head"><span>02 / LADDER</span><span className="portal-arrow" aria-hidden="true">→</span></div>
            <h3>Elo 排行榜</h3>
            <p>实时浏览综合与各排位玩法前十高手榜单。</p>
          </div>
        </a>
        <div className="panel home-portal">
          <div>
            <div className="portal-head"><span>03 / ACCOUNT &amp; TAGS</span></div>
            <h3>个人对局与称号</h3>
            <p>绑定游戏账号回放背包快照，或挑选专属游戏内称号。</p>
          </div>
          <div className="portal-links">
            <a href="#matches">我的对局 <span className="link-arrow" aria-hidden="true">→</span></a>
            <a href="#shop">浏览商店 <span className="link-arrow" aria-hidden="true">→</span></a>
          </div>
        </div>
      </div>
    </section>

    <dialog
      ref={dialog}
      className="play-dialog"
      aria-labelledby="play-dialog-title"
      onClose={() => setCopied("")}
      onClick={event => { if (event.target === dialog.current) dialog.current?.close(); }}
    >
      <form method="dialog" className="play-form">
        <div className="play-dialog-head">
          <h2 id="play-dialog-title">加入 MiCet</h2>
          <button className="btn compact" type="submit" aria-label="关闭">关闭</button>
        </div>
        <p>在 Minecraft Java 版打开多人游戏，添加下面的服务器地址。</p>
        <label className="search-label" htmlFor="join-address">服务器地址</label>
        <div className="join-address">
          <input ref={address} id="join-address" value={SERVER_ADDRESS} readOnly onFocus={event => event.currentTarget.select()} />
          <button className="btn primary" type="button" onClick={() => void copyAddress()}>
            {copied ? "✓ 已复制" : "复制地址"}
          </button>
        </div>
        <p className="copy-feedback" role="status">{copied}</p>
      </form>
    </dialog>
  </>;
}

"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  const [display, setDisplay] = useState(text);
  useEffect(() => {
    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const timer = setInterval(() => {
      if (!document.hidden) setDisplay(text.replace(/[!-~]/g, () => characters[Math.floor(Math.random() * characters.length)]));
    }, 120);
    return () => clearInterval(timer);
  }, [text]);
  return <><span className="motd-sr-text">{text}</span><span aria-hidden="true">{display}</span></>;
}

function MotdLine({ line, paused }: { line: string; paused: boolean }) {
  let style: CSSProperties = {};
  let underline = false;
  let strike = false;
  let obfuscated = false;
  return <div className="motd-line">{line.split(/(§x(?:§[0-9a-f]){6}|§[0-9a-fk-or])/gi).map((part, i) => {
    if (!part) return null;
    if (i % 2 === 0) return <span key={i} style={style}>{obfuscated && !paused ? <ObfuscatedText key={part} text={part} /> : part}</span>;
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
    return null;
  })}</div>;
}

const stateText = {
  online: "在线",
  unreachable: "服务器未响应",
  unknown: "暂时无法查询状态",
};

function ServerRow() {
  const [status, setStatus] = useState<ServerStatus | null>();
  const [paused, setPaused] = useState(false);
  const [revision, refresh] = useState(0);
  useEffect(() => setPaused(window.matchMedia("(prefers-reduced-motion: reduce)").matches), []);

  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let fetching = false;
    async function update() {
      if (fetching || stop.signal.aborted || document.hidden) return;
      fetching = true;
      try {
        const result = await api<ServerStatus>("server-status", undefined, stop.signal);
        if (!stop.signal.aborted) setStatus(result);
      } catch {
        if (!stop.signal.aborted) setStatus(null);
      } finally {
        fetching = false;
        if (!paused && !stop.signal.aborted && !document.hidden) timer = setTimeout(update, 2500);
      }
    }
    const changed = () => { clearTimeout(timer); if (!paused) void update(); };
    void update();
    document.addEventListener("visibilitychange", changed);
    return () => { stop.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", changed); };
  }, [paused, revision]);
  const state = status?.state ?? "unknown";
  const count = status?.onlinePlayers == null ? null : status.maxPlayers == null
    ? status.onlinePlayers + " 在线" : status.onlinePlayers + " / " + status.maxPlayers;
  return <section className="server-list" aria-labelledby="server-list-title">
    <div className="server-list-head">
      <h2 id="server-list-title">多人游戏</h2>
      <div className="motd-actions">
        {paused && <button className="btn" type="button" onClick={() => refresh(value => value + 1)}>刷新</button>}
        <button className="btn" type="button" onClick={() => setPaused(value => !value)}>{paused ? "继续更新" : "暂停更新"}</button>
      </div>
    </div>
    <div className="server-entry">
      <div className="server-icon">
        {status?.icon ? <img src={status.icon} width={64} height={64} alt="" /> : <span className="mark" aria-hidden="true" />}
      </div>
      <div className="server-entry-content">
        <h3>Minecraft 服务器</h3>
        {status?.motd.length ? status.motd.map((line, i) => <MotdLine key={i} line={line} paused={paused} />)
          : <p className="motd-fallback">{status === undefined ? "正在读取服务器 MOTD…" : "Minecraft PvP"}</p>}
      </div>
      <div className="server-signal" role="status" aria-label={status === undefined ? "正在查询服务器" : stateText[state] + (count ? " " + count : "")}>
        <span className={"signal-bars " + (state === "online" ? "online" : "")} aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className="server-players">{status === undefined ? "查询中" : count ?? stateText[state]}</span>
      </div>
    </div>
  </section>;
}

export function ServerHome({ title }: { title: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState("");
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(SERVER_ADDRESS);
      setCopied("已复制服务器地址。");
    } catch {
      address.current?.focus();
      address.current?.select();
      setCopied("地址已选中，可手动复制。");
    }
  }

  return <>
    <section className="server-home" aria-labelledby="server-title">
      <div className="server-intro">
        <p className="hero-context">Minecraft Java Edition</p>
        {title}
        <p className="server-description">练习对战，挑战排位，查看你在 MiCet 的每场战绩。</p>
        <div className="server-actions">
          <button className="btn primary" type="button" onClick={() => dialog.current?.showModal()}>Play Now</button>
          <a className="btn" href="#stats">查看战绩</a>
        </div>
      </div>
      <ServerRow />
    </section>
    <dialog ref={dialog} className="play-dialog" aria-labelledby="play-dialog-title" onClose={() => setCopied("")}>
      <form method="dialog" className="play-form">
        <div className="play-dialog-head">
          <h2 id="play-dialog-title">加入 MiCet</h2>
          <button className="btn" type="submit" aria-label="关闭">关闭</button>
        </div>
        <p>在 Minecraft Java 版打开多人游戏，添加下面的服务器地址。</p>
        <label className="search-label" htmlFor="join-address">服务器地址</label>
        <div className="join-address">
          <input ref={address} id="join-address" value={SERVER_ADDRESS} readOnly onFocus={event => event.currentTarget.select()} />
          <button className="btn primary" type="button" onClick={() => void copyAddress()}>复制地址</button>
        </div>
        <p className="copy-feedback" role="status">{copied}</p>
      </form>
    </dialog>
  </>;
}

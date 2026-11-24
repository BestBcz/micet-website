"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { readStats } from "@/lib/micet-client";
import type { Link, Mode } from "@/lib/micet-data";
import type { InventoryItem, MatchDetail, MatchSnapshot } from "@/lib/micet-match-detail";
import { itemTexture, potionOverlay, potionTint } from "./match-item-textures";
import "./match-detail.css";

const items: Record<string, string> = {
  DIAMOND_SWORD: "钻石剑", IRON_SWORD: "铁剑", STONE_SWORD: "石剑", WOOD_SWORD: "木剑",
  DIAMOND_HELMET: "钻石头盔", DIAMOND_CHESTPLATE: "钻石胸甲", DIAMOND_LEGGINGS: "钻石护腿", DIAMOND_BOOTS: "钻石靴子",
  IRON_HELMET: "铁头盔", IRON_CHESTPLATE: "铁胸甲", IRON_LEGGINGS: "铁护腿", IRON_BOOTS: "铁靴子",
  ENDER_PEARL: "末影珍珠", COOKED_BEEF: "牛排", GOLDEN_APPLE: "金苹果", PUMPKIN_PIE: "南瓜派",
  POTION: "药水", GLASS_BOTTLE: "玻璃瓶", BOW: "弓", FISHING_ROD: "钓鱼竿", ARROW: "箭",
  COBBLESTONE: "圆石", WOOD: "木板", WATER_BUCKET: "水桶", LAVA_BUCKET: "岩浆桶", BUCKET: "桶",
  MUSHROOM_SOUP: "蘑菇煲", FLINT_AND_STEEL: "打火石",
};
const effects: Record<string, string> = {
  SPEED: "速度", SLOW: "缓慢", SLOWNESS: "缓慢", INCREASE_DAMAGE: "力量", STRENGTH: "力量",
  WEAKNESS: "虚弱", INSTANT_HEAL: "治疗", HEAL: "治疗", INSTANT_DAMAGE: "伤害", HARM: "伤害",
  REGEN: "再生", REGENERATION: "再生", POISON: "中毒", FIRE_RESISTANCE: "抗火", INVISIBILITY: "隐身",
  RESISTANCE: "抗性提升", DAMAGE_RESISTANCE: "抗性提升", ABSORPTION: "伤害吸收", WATER: "水瓶",
};
const enchantments: Record<string, string> = {
  DAMAGE_ALL: "锋利", PROTECTION_ENVIRONMENTAL: "保护", DURABILITY: "耐久", FIRE_ASPECT: "火焰附加",
  ARROW_DAMAGE: "力量", ARROW_KNOCKBACK: "冲击", ARROW_FIRE: "火矢", ARROW_INFINITE: "无限",
  KNOCKBACK: "击退", PROTECTION_FALL: "摔落保护", THORNS: "荆棘",
};
const healingMethods: Record<string, string> = { POTIONS: "治疗药水", SOUP: "蘑菇煲", GOLDEN_APPLE: "金苹果", GOLDEN_APPLES: "金苹果" };
const endingReasons: Record<string, string> = {
  NORMAL: "正常结束", ELIMINATION: "淘汰", FORFEIT: "认输", DISCONNECT: "断线", TIMEOUT: "超时",
  TIME_LIMIT: "时间耗尽", SERVER_SHUTDOWN: "服务器关闭",
};

function level(value: number) {
  return ["", "I", "II", "III", "IV", "V"][value] || String(value);
}

function itemName(item: InventoryItem) {
  if (item.name) return item.name;
  if (item.potion) {
    const { type, splash, level: amplifier, extended } = item.potion;
    if (type === "WATER") return effects.WATER;
    return (splash ? "喷溅型" : "") + (effects[type] ?? type) + "药水"
      + (amplifier > 1 ? " " + level(amplifier) : "") + (extended ? "（延长）" : "");
  }
  return items[item.material] ?? item.material.replaceAll("_", " ");
}

function iconKind(material: string) {
  if (/(SWORD|_AXE)$/.test(material)) return "blade";
  if (material.endsWith("_HELMET")) return "helmet";
  if (material.endsWith("_CHESTPLATE")) return "chest";
  if (material.endsWith("_LEGGINGS")) return "legs";
  if (material.endsWith("_BOOTS")) return "boots";
  if (/(POTION|BOTTLE|BUCKET)$/.test(material)) return "bottle";
  if (material === "BOW") return "bow";
  if (/(PEARL|APPLE|BEEF|SOUP|PIE)$/.test(material)) return "round";
  if (/(WOOD|COBBLESTONE|BLOCK|STONE)$/.test(material)) return "block";
  return "other";
}

function iconTone(item: InventoryItem) {
  if (item.material.startsWith("DIAMOND_") || item.material === "ENDER_PEARL") return "diamond";
  if (item.material.startsWith("GOLD") || item.material === "LAVA_BUCKET") return "gold";
  if (item.potion || item.material === "COOKED_BEEF") return item.potion?.type === "SPEED" ? "diamond" : "heal";
  return "neutral";
}

const num = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
function duration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function amount(value: number | null, unit = "") {
  return value === null ? "—" : num.format(value) + unit;
}

type Slot = { id: string; item: InventoryItem | null; title: string };
const armorLabels = ["头盔", "胸甲", "护腿", "靴子"];

function SlotRow({ slots, label, active, onSelect }: {
  slots: Slot[]; label: string; active: string | null; onSelect: (slot: Slot) => void;
}) {
  return <section className="slot-row" aria-label={label}>
    <h3>{label}</h3>
    <div className="slot-grid">
      {slots.map(slot => {
        if (!slot.item) return <span key={slot.id} className="item-slot empty" aria-hidden="true" />;
        const item = slot.item;
        const name = itemName(item);
        const texture = itemTexture(item);
        const short = item.material.split("_").at(-1)?.slice(0, 2);
        return <button key={slot.id} type="button"
          className={"item-slot" + (item.enchantments.length ? " enchanted" : "")}
          title={name} aria-pressed={slot.id === active}
          aria-label={slot.title + " · " + name + " ×" + item.count}
          onClick={() => onSelect(slot)}>
          {texture ? <span className="item-icon item-texture" aria-hidden="true">
            {item.material === "POTION" && potionOverlay && <span className="potion-fill" style={{
              "--potion-overlay": `url("${potionOverlay}")`, "--potion-tint": potionTint(item),
            } as CSSProperties} />}
            <img src={texture} alt="" />
          </span>
            : <span className={"item-icon " + iconKind(item.material) + " " + iconTone(item)} aria-hidden="true">
              {iconKind(item.material) === "other" ? short : null}
            </span>}
          {item.count > 1 && <span className="item-count" aria-hidden="true">{item.count}</span>}
          {item.maxDamage != null && item.damage != null && item.damage > 0 && <span className="slot-durability" aria-hidden="true">
            <span style={{ width: (Math.max(0, item.maxDamage - item.damage) / item.maxDamage) * 100 + "%" }} />
          </span>}
        </button>;
      })}
    </div>
  </section>;
}

function ItemInspector({ selection }: { selection: Slot | null }) {
  const item = selection?.item;
  return <section className="panel match-box item-inspector" aria-labelledby="item-inspector-title" aria-live="polite">
    <h3 id="item-inspector-title">物品详情</h3>
    {item ? <>
      <div className="item-inspector-heading"><strong>{itemName(item)}</strong><span>×{item.count}</span></div>
      <p className="item-id">{selection.title} · {item.material}</p>
      {item.damage != null && item.maxDamage != null && <p>耐久 {Math.max(0, item.maxDamage - item.damage)} / {item.maxDamage}</p>}
      {item.variant != null && <p>物品数据值 {item.variant}</p>}
      {item.enchantments.length > 0 && <ul>
        {item.enchantments.map(entry => <li key={entry.type}>{enchantments[entry.type] ?? entry.type} {level(entry.level)}</li>)}
      </ul>}
      {item.lore.length > 0 && <ul>{item.lore.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    </> : <p className="muted">选择一个有物品的格子，查看数量、耐久、附魔和描述。</p>}
  </section>;
}

function MatchNumbers({ snapshot }: { snapshot: MatchSnapshot }) {
  return <section className="panel match-box" aria-labelledby="match-stats-title">
    <h2 id="match-stats-title">对战数据</h2>
    <dl className="combat-stats">
      {[
        ["总命中", amount(snapshot.hits)], ["格挡命中", amount(snapshot.blocked)],
        ["暴击", amount(snapshot.critical)], ["最高连击", amount(snapshot.combo)],
        ["延迟", amount(snapshot.ping, " ms")], ["治疗药水准确率", amount(snapshot.healAccuracy, "%")],
        ...(snapshot.debuffAccuracy === null ? [] : [["负面药水准确率", amount(snapshot.debuffAccuracy, "%")]]),
        ...(snapshot.elo ? [["排位 Elo", snapshot.elo.before + " → " + snapshot.elo.after + " (" + (snapshot.elo.delta >= 0 ? "+" : "") + snapshot.elo.delta + ")"]] : []),
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  </section>;
}

function PlayerCapture({ snapshot, player }: { snapshot: MatchSnapshot; player: string }) {
  const [selection, select] = useState<Slot | null>(null);
  const inventory = snapshot.inventory;
  const armor = snapshot.armor;
  const bagSlots: Slot[] = Array.from({ length: 27 }, (_, index) => ({
    id: "bag-" + index, item: inventory?.[index + 9] ?? null, title: "物品栏第 " + (index + 1) + " 格",
  }));
  const hotbarSlots: Slot[] = Array.from({ length: 9 }, (_, index) => ({
    id: "hotbar-" + index, item: inventory?.[index] ?? null, title: "快捷栏第 " + (index + 1) + " 格",
  }));
  const armorSlots: Slot[] = armorLabels.map((title, index) => ({
    id: "armor-" + index, item: armor?.[3 - index] ?? null, title,
  }));
  const slotProps = { active: selection?.id ?? null, onSelect: select };

  return <div className="match-data-grid">
    <section className="panel match-box inventory-window" aria-labelledby="inventory-title">
      <div className="inventory-title"><h2 id="inventory-title">物品栏</h2><span>{player}</span></div>
      {inventory ? <>
        <SlotRow label="背包" slots={bagSlots} {...slotProps} />
        <SlotRow label="快捷栏" slots={hotbarSlots} {...slotProps} />
      </> : <p className="muted">这场对局没有保存背包和快捷栏。</p>}
      {armor ? <SlotRow label="护甲" slots={armorSlots} {...slotProps} /> : <p className="muted">没有保存护甲。</p>}
      <dl className="game-status">
        <div><dt>生命</dt><dd>{amount(snapshot.health, " HP")}</dd></div>
        <div><dt>饥饿</dt><dd>{snapshot.hunger === null ? "—" : snapshot.hunger + " / 20"}</dd></div>
        <div><dt>剩余治疗</dt><dd>{snapshot.healing ? snapshot.healing.count + " " + (healingMethods[snapshot.healing.method] ?? snapshot.healing.method) : "—"}</dd></div>
        {snapshot.healing?.method === "POTIONS" && <div><dt>扔空药水</dt><dd>{amount(snapshot.healing.missed)}</dd></div>}
      </dl>
    </section>
    <div className="match-extras">
      <ItemInspector selection={selection} />
      <MatchNumbers snapshot={snapshot} />
      <section className="panel match-box" aria-labelledby="match-effects-title">
        <h3 id="match-effects-title">药水效果</h3>
        {snapshot.effects === null ? <p className="muted">这场对局没有保存药水效果。</p> : snapshot.effects.length === 0
          ? <p className="muted">没有药水效果。</p>
          : <ul className="effect-list">{snapshot.effects.map((effect, index) =>
            <li key={effect.type + index}><span>{effects[effect.type] ?? effect.type} {level(effect.level)}</span><time>{duration(effect.seconds)}</time></li>)}</ul>}
      </section>
    </div>
  </div>;
}

async function loadMatch(id: string, signal: AbortSignal) {
  const detail = await readStats<MatchDetail | null>("match-detail", signal, { matchId: id });
  if (!detail) return null;
  const snapshots = new Map([detail.snapshot, ...(detail.otherSnapshots ?? [])].map(snapshot => [snapshot.uuid, snapshot]));
  // Older bridges and exceptionally large matches can return fewer snapshots in the first response.
  for (const { uuid } of detail.participants) {
    if (snapshots.has(uuid)) continue;
    const result = await readStats<MatchDetail | null>("match-detail", signal, { matchId: id, target: uuid });
    if (result) snapshots.set(result.snapshot.uuid, result.snapshot);
  }
  signal.throwIfAborted();
  const textures = new Set<string>();
  for (const snapshot of snapshots.values()) {
    for (const item of [...(snapshot.inventory ?? []), ...(snapshot.armor ?? [])]) {
      const texture = item && itemTexture(item);
      if (texture) textures.add(texture);
      if (item?.material === "POTION" && potionOverlay) textures.add(potionOverlay);
    }
  }
  for (const texture of textures) new Image().src = texture;
  return { detail, snapshots };
}

export function MatchDetailPage({ id, linked, mode }: { id: string; linked?: Link | null; mode: Mode }) {
  const [match, setMatch] = useState<Awaited<ReturnType<typeof loadMatch>>>();
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const viewer = linked?.uuid;

  useEffect(() => {
    if (!viewer) return;
    const stop = new AbortController();
    loadMatch(id, stop.signal)
      .then(result => {
        if (stop.signal.aborted) return;
        setMatch(result);
      }).catch(err => {
        if (stop.signal.aborted) return;
        setError(err.message);
      });
    return () => stop.abort();
  }, [id, viewer, retry]);

  const detail = match?.detail;
  const selected = target || detail?.snapshot.uuid;
  const player = detail?.participants.find(participant => participant.uuid === selected);
  const snapshot = selected ? match?.snapshots.get(selected) : undefined;
  const retryRequest = () => {
    setError("");
    setRetry(value => value + 1);
  };

  return <section className="match-page">
    <header className="page-intro">
      <a className="crumb" href="#matches">返回我的对局</a>
      <h1>对局详情</h1>
      {detail && <p>{[detail.kit, detail.map, detail.ranked ? "排位" : "非排位", mode === "demo" ? "示例对局" : null].filter(Boolean).join(" · ")}</p>}
    </header>
    {linked === null ? <div className="panel"><p className="message"><a className="btn primary" href="#account">绑定游戏账号后查看</a></p></div>
      : !linked || (match === undefined && !error) ? <div className="panel"><p role="status" className="message">正在读取对局详情和物品栏…</p></div>
      : error ? <div className="panel"><p role="alert" className="message error">{error} <button className="btn" onClick={retryRequest}>重试</button></p></div>
      : !detail ? <div className="panel"><p role="status" className="message">这场对局已过期、未保存或当前账号无权查看。</p></div>
      : <>
        <div className="match-meta">
          <p><time dateTime={new Date(detail.endedAt).toISOString()}>{date.format(detail.endedAt)}</time>
            {detail.startedAt !== null && " · 时长 " + duration((detail.endedAt - detail.startedAt) / 1000)}
            {detail.endReason && " · " + (endingReasons[detail.endReason] ?? detail.endReason)}
          </p>
          <div className="match-participants" aria-label="选择对局玩家">
            {detail.participants.map(entry => <button key={entry.uuid} className="pill" aria-pressed={entry.uuid === selected}
              onClick={() => setTarget(entry.uuid)}>
              {entry.name}{entry.uuid === viewer ? "（我）" : ""}
              <span>{detail.winnerTeam === null ? "平局" : detail.winnerTeam === entry.team ? "胜利" : "战败"}</span>
            </button>)}
          </div>
        </div>
        {player && snapshot ? <PlayerCapture key={player.uuid} snapshot={snapshot} player={player.name} />
          : <div className="panel"><p role="status" className="message">这场对局没有保存该玩家的物品栏。</p></div>}
      </>}
  </section>;
}

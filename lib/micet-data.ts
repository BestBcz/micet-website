export type Mode = "demo" | "bridge";
export type Link = { uuid: string; player: string };
export type Score = { id: string; name: string; elo: number | null; wins: number; losses: number };
export type Profile = Link & { scores: Score[] };
export type Entry = Link & { elo: number };
export type Board = { id: string; name: string; entries: Entry[] };
export type Match = { id: string; kit: string; opponents: string[]; result: "win" | "loss" | "draw"; endedAt: number; ranked: boolean; delta: number | null };
export type Order = { id: string; sku: string; player: string; status: "pending" | "paid" | "delivered" | "failed"; mode: Mode; created_at: number; detail?: string | null };

export const TEST_SKU = "micet-test";
export const DEMO_PLAYER = "KairoPvP";
export const testTag = { tag: "MICET TEST", name: "测试标签", description: "用于验证站内结账和游戏内 Tag 发放。" };

// AquaCore Tags snapshot, ordered by game menu weight (highest first).
export const catalog = [
  { name: "Parkour", prefix: "Parkour", color: "dark-gray" },
  { name: "Vape", prefix: "Vape", color: "red" },
  { name: "Vip", prefix: "Vip", color: "dark-green" },
  { name: "Heart", prefix: "❤", color: "dark-red" },
  { name: "Symbol#1", prefix: "❖", color: "red" },
  { name: "Symbol#2", prefix: "☠", color: "red" },
  { name: "Symbol#3", prefix: "☀", color: "red" },
  { name: "Symbol#4", prefix: "♚", color: "red" },
  { name: "Symbol#5", prefix: "✖", color: "red" },
  { name: "top", prefix: "〄", color: "dark-red" },
] as const;

const kits = [
  { id: "global", name: "综合" },
  { id: "nodebuff", name: "NoDebuff" },
  { id: "boxing", name: "Boxing" },
  { id: "sumo", name: "Sumo" },
  { id: "builduhc", name: "BuildUHC" },
];
const roster = [
  { player: DEMO_PLAYER, ratings: [2184, 2256, 2196, 2060, 2224], record: [164, 37] },
  { player: "Veltrix", ratings: [2067, 2074, 2213, 1984, 1997], record: [131, 52] },
  { player: "NyxBlade", ratings: [1992, 2031, 1840, 2150, 1947], record: [121, 44] },
  { player: "Frosted", ratings: [1876, 1889, 1915, 1740, 1960], record: [112, 61] },
  { player: "AstraCombo", ratings: [1799, 1779, 1844, 1725, 1848], record: [98, 60] },
  { player: "LunarFox", ratings: [1726, 1717, 1772, 1684, 1731], record: [73, 48] },
  { player: "PixelRush", ratings: [1654, 1632, 1710, 1608, 1666], record: [71, 53] },
  { player: "EchoFlint", ratings: [1621, 1638, 1580, 1714, 1552], record: [57, 45] },
  { player: "RiftKnight", ratings: [1532, 1533, 1480, 1580, 1535], record: [44, 37] },
  { player: "QuartzX", ratings: [1498, 1421, 1497, 1524, 1550], record: [42, 40] },
];
const demoUuid = (index: number) => "90484eac-090d-4f4a-b131-7e34d92000" + String(index).padStart(2, "0");

export const demoBoards: Board[] = kits.map((kit, kitIndex) => ({
  ...kit,
  entries: roster.map(({ player, ratings }, i) => ({ uuid: demoUuid(i), player, elo: ratings[kitIndex] }))
    .sort((a, b) => b.elo - a.elo || a.player.localeCompare(b.player)),
}));

export function getDemoProfile(name: string): Profile | null {
  const index = roster.findIndex(row => row.player.toLowerCase() === name.toLowerCase());
  if (index < 0) return null;
  const { player, ratings, record: [wins, losses] } = roster[index];
  return {
    uuid: demoUuid(index), player,
    scores: kits.map((kit, kitIndex) => ({
      ...kit, elo: ratings[kitIndex],
      wins: kitIndex ? Math.floor(wins / 4) + (kitIndex <= wins % 4 ? 1 : 0) : wins,
      losses: kitIndex ? Math.floor(losses / 4) + (kitIndex <= losses % 4 ? 1 : 0) : losses,
    })),
  };
}

export function getDemoMatches(uuid: string, now = Date.now()): Match[] {
  if (uuid !== demoUuid(0)) return [];
  return [
    { id: "demo-1", kit: "NoDebuff", opponents: ["NyxBlade"], result: "win", endedAt: now - 1_800_000, ranked: true, delta: 17 },
    { id: "demo-2", kit: "Boxing", opponents: ["Veltrix"], result: "loss", endedAt: now - 3_960_000, ranked: true, delta: -12 },
    { id: "demo-3", kit: "Sumo", opponents: ["Frosted"], result: "win", endedAt: now - 86_400_000, ranked: false, delta: null },
    { id: "demo-4", kit: "BuildUHC", opponents: ["AstraCombo"], result: "draw", endedAt: now - 172_800_000, ranked: false, delta: null },
  ];
}

import { getDemoMatches, getDemoProfile } from "./micet-data";

export const matchUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const demoMatchPattern = /^demo-[1-4]$/;

export type InventoryItem = {
  material: string;
  name: string | null;
  count: number;
  damage: number | null;
  maxDamage: number | null;
  variant: number | null;
  potion: { type: string; level: number; splash: boolean; extended: boolean } | null;
  enchantments: { type: string; level: number }[];
  lore: string[];
};

export type MatchSnapshot = {
  uuid: string;
  inventory: (InventoryItem | null)[] | null;
  armor: (InventoryItem | null)[] | null;
  health: number | null;
  hunger: number | null;
  effects: { type: string; level: number; seconds: number }[] | null;
  healing: { method: string; count: number; missed: number | null } | null;
  hits: number | null;
  blocked: number | null;
  critical: number | null;
  combo: number | null;
  ping: number | null;
  healAccuracy: number | null;
  debuffAccuracy: number | null;
  elo: { before: number; delta: number; after: number } | null;
};

export type MatchDetail = {
  id: string;
  kit: string;
  map: string | null;
  startedAt: number | null;
  endedAt: number;
  ranked: boolean;
  winnerTeam: number | null;
  endReason: string | null;
  participants: { uuid: string; name: string; team: number }[];
  snapshot: MatchSnapshot;
  otherSnapshots?: MatchSnapshot[];
};

function item(material: string, data: Partial<Omit<InventoryItem, "material">> = {}): InventoryItem {
  return { material, name: null, count: 1, damage: null, maxDamage: null, variant: null, potion: null, enchantments: [], lore: [], ...data };
}

const diamondArmor = (damage: number) => [
  item("DIAMOND_BOOTS", { damage, maxDamage: 429 }),
  item("DIAMOND_LEGGINGS", { damage, maxDamage: 495 }),
  item("DIAMOND_CHESTPLATE", { damage, maxDamage: 528, enchantments: [{ type: "PROTECTION_ENVIRONMENTAL", level: 2 }] }),
  item("DIAMOND_HELMET", { damage, maxDamage: 363 }),
];
const heal = item("POTION", { potion: { type: "INSTANT_HEAL", level: 2, splash: true, extended: false } });

export function getDemoMatchDetail(viewer: string, id: string, requestedTarget: string): MatchDetail | null {
  const match = getDemoMatches(viewer).find(entry => entry.id === id);
  if (!match) return null;
  const self = getDemoProfile("KairoPvP")!;
  const opponent = getDemoProfile(match.opponents[0])!;
  const participants = [self, opponent].map(({ uuid, player }, team) => ({ uuid, name: player, team }));
  const target = participants.find(entry => entry.uuid === (requestedTarget || viewer));
  if (!target) return null;
  const selfView = target.uuid === viewer;
  const winnerTeam = match.result === "draw" ? null : match.result === "win" ? 0 : 1;
  const won = winnerTeam === target.team;
  const inventory: (InventoryItem | null)[] = Array.from({ length: 36 }, () => null);
  const noDebuff = match.kit === "NoDebuff";
  const buildUhc = match.kit === "BuildUHC";
  const equipped = noDebuff || buildUhc;

  if (match.kit !== "Sumo") {
    inventory[0] = item("DIAMOND_SWORD", {
      damage: selfView ? 44 : 57, maxDamage: 1561,
      enchantments: [{ type: "DAMAGE_ALL", level: noDebuff ? 3 : 1 }],
    });
  }
  if (noDebuff) {
    inventory[1] = item("ENDER_PEARL", { count: selfView ? 12 : 7 });
    inventory[2] = item("COOKED_BEEF", { count: selfView ? 18 : 14 });
    for (const i of selfView ? [3, 4, 6, 9, 10, 11, 18, 27] : [4, 9, 14]) inventory[i] = { ...heal };
    if (selfView) inventory[7] = item("POTION", { potion: { type: "SPEED", level: 2, splash: false, extended: false } });
  }
  if (buildUhc) {
    inventory[1] = item("BOW", { damage: 28, maxDamage: 384, enchantments: [{ type: "ARROW_DAMAGE", level: 2 }] });
    inventory[2] = item("FISHING_ROD", { damage: 13, maxDamage: 64 });
    inventory[3] = item("GOLDEN_APPLE", { count: selfView ? 4 : 2 });
    inventory[4] = item("COBBLESTONE", { count: 47, variant: 0 });
    inventory[5] = item("WATER_BUCKET");
    inventory[6] = item("LAVA_BUCKET");
    inventory[10] = item("ARROW", { count: 28 });
  }
  const before = noDebuff ? selfView ? 2239 : 2048 : selfView ? 2208 : 2201;
  const delta = selfView ? match.delta : match.delta === null ? null : -match.delta;

  return {
    id, kit: match.kit, map: noDebuff ? "练习场" : null, startedAt: match.endedAt - (noDebuff ? 128_000 : 53_000),
    endedAt: match.endedAt, ranked: match.ranked, winnerTeam, endReason: null, participants,
    ...(requestedTarget ? {} : { otherSnapshots: [getDemoMatchDetail(viewer, id, opponent.uuid)!.snapshot] }),
    snapshot: {
      uuid: target.uuid, inventory, armor: equipped ? diamondArmor(selfView ? 63 : 78) : [null, null, null, null],
      health: won ? 13.5 : winnerTeam !== null ? 0 : 8, hunger: selfView ? 18 : 15,
      effects: noDebuff && selfView ? [{ type: "SPEED", level: 2, seconds: 42 }] : [],
      healing: noDebuff ? { method: "POTIONS", count: selfView ? 8 : 3, missed: selfView ? 2 : 4 }
        : buildUhc ? { method: "GOLDEN_APPLES", count: selfView ? 4 : 2, missed: 0 } : null,
      hits: selfView ? 56 : 42, blocked: selfView ? 9 : 7, critical: selfView ? 14 : 10,
      combo: selfView ? 8 : 5, ping: selfView ? 34 : 51, healAccuracy: noDebuff ? selfView ? 90 : 78 : null,
      debuffAccuracy: null, elo: delta === null ? null : { before, delta, after: before + delta },
    },
  };
}

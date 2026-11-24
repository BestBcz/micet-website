import type { InventoryItem } from "@/lib/micet-match-detail";

const textures: Record<string, unknown> = import.meta.glob("./match-textures/*/*.png", {
  eager: true, import: "default", query: "?no-inline",
});

const aliases: Record<string, string> = {
  BOW: "bow_standby", FISHING_ROD: "fishing_rod_uncast", GOLDEN_APPLE: "apple_golden",
  COOKED_BEEF: "beef_cooked", RAW_BEEF: "beef_raw", COOKED_CHICKEN: "chicken_cooked",
  RAW_CHICKEN: "chicken_raw", GRILLED_PORK: "porkchop_cooked", PORK: "porkchop_raw",
  WATER_BUCKET: "bucket_water", LAVA_BUCKET: "bucket_lava", MILK_BUCKET: "bucket_milk", BUCKET: "bucket_empty",
  MUSHROOM_SOUP: "mushroom_stew", BOOK: "book_normal", ENCHANTED_BOOK: "book_enchanted",
  BOOK_AND_QUILL: "book_writable", WRITTEN_BOOK: "book_written", EYE_OF_ENDER: "ender_eye",
  GLASS_BOTTLE: "potion_bottle_empty", EXP_BOTTLE: "experience_bottle", CARROT_ITEM: "carrot", GOLDEN_CARROT: "carrot_golden",
  RAW_FISH: "fish_raw", COOKED_FISH: "fish_cooked",
  POTATO_ITEM: "potato", BAKED_POTATO: "potato_baked", POISONOUS_POTATO: "potato_poisonous",
  SPECKLED_MELON: "melon_speckled", NETHER_STALK: "nether_wart", CLAY_BALL: "clay_ball",
  FIREBALL: "fireball", FIREWORK: "fireworks", FIREWORK_CHARGE: "fireworks_charge", REDSTONE: "redstone_dust",
  GRASS: "grass_side", MOSSY_COBBLESTONE: "cobblestone_mossy", SMOOTH_BRICK: "stonebrick",
  NETHER_BRICK: "nether_brick", ENDER_STONE: "end_stone", PACKED_ICE: "ice_packed",
  SNOW_BLOCK: "snow", SANDSTONE: "sandstone_normal", HAY_BLOCK: "hay_block_side",
  QUARTZ_BLOCK: "quartz_block_side", TNT: "tnt_side", SLIME_BLOCK: "slime",
};

const colors = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "silver", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const woods = ["oak", "spruce", "birch", "jungle", "acacia", "big_oak"];

const variants: Record<string, (data: number) => string> = {
  WOOD: data => "planks_" + (woods[data] ?? "oak"),
  LOG: data => "log_" + woods[data & 3],
  LOG_2: data => "log_" + (woods[4 + (data & 3)] ?? "acacia"),
  WOOL: data => "wool_colored_" + (colors[data] ?? "white"),
  STAINED_GLASS: data => "glass_" + (colors[data] ?? "white"),
  STAINED_GLASS_PANE: data => "glass_pane_top_" + (colors[data] ?? "white"),
  INK_SACK: data => "dye_powder_" + (colors[15 - data] ?? "black"),
  STONE: data => ["stone", "stone_granite", "stone_granite_smooth", "stone_diorite", "stone_diorite_smooth", "stone_andesite", "stone_andesite_smooth"][data] ?? "stone",
  DIRT: data => data === 2 ? "dirt_podzol_top" : "dirt",
  SAND: data => data === 1 ? "red_sand" : "sand",
  SMOOTH_BRICK: data => ["stonebrick", "stonebrick_mossy", "stonebrick_cracked", "stonebrick_carved"][data] ?? "stonebrick",
  SKULL_ITEM: data => ["skull_skeleton", "skull_wither", "skull_zombie", "skull_steve", "skull_creeper"][data] ?? "skull_steve",
};

// Legacy Minecraft item colors multiply the resource pack's grayscale potion overlay.
const potionColors: Record<string, string> = {
  WATER: "#385dc6", SPEED: "#7cafc6", SLOWNESS: "#5a6c81", STRENGTH: "#932423",
  INSTANT_HEAL: "#f82423", INSTANT_DAMAGE: "#430a09", JUMP: "#786297", REGEN: "#cd5cab",
  FIRE_RESISTANCE: "#e49a3a", WATER_BREATHING: "#2e5299", INVISIBILITY: "#7f8392",
  NIGHT_VISION: "#1f1fa1", WEAKNESS: "#484d48", POISON: "#4e9331",
};

const overlay = textures["./match-textures/items/potion_overlay.png"];
export const potionOverlay = typeof overlay === "string" ? overlay : undefined;

export function potionTint(item: InventoryItem) {
  return potionColors[item.potion?.type ?? "WATER"] ?? potionColors.WATER;
}

export function itemTexture(item: InventoryItem): string | undefined {
  const { material } = item;
  const name = material === "POTION"
    ? ((item.potion?.splash ?? Boolean((item.variant ?? 0) & 0x4000)) ? "potion_bottle_splash" : "potion_bottle_drinkable")
    : variants[material]?.(item.variant ?? 0) ?? aliases[material] ?? material.toLowerCase();
  const texture = textures[`./match-textures/items/${name}.png`] ?? textures[`./match-textures/blocks/${name}.png`];
  return typeof texture === "string" ? texture : undefined;
}

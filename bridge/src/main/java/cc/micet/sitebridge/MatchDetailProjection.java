package cc.micet.sitebridge;

import eu.bcz.micetpvp.MicetPvP;
import eu.bcz.micetpvp.kittype.HealingMethod;
import eu.bcz.micetpvp.match.history.MatchHistoryRecord;
import eu.bcz.micetpvp.postmatchinv.PostMatchPlayer;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.bukkit.ChatColor;
import org.bukkit.Material;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonArray;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonElement;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonNull;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonObject;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonParser;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonPrimitive;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.potion.Potion;
import org.bukkit.potion.PotionEffect;

/** Projects authorized snapshots without exposing serialized Bukkit data. */
final class MatchDetailProjection {
    private static final int MATCH_DETAIL_BYTE_BUDGET = 900_000;

    private MatchDetailProjection() {}

    static JsonElement project(String payload, UUID id, long endedAt, UUID viewer, UUID target) {
        if (payload == null) return JsonNull.INSTANCE;
        JsonObject raw = new JsonParser().parse(payload).getAsJsonObject();
        MatchHistoryRecord record = MicetPvP.getGson().fromJson(raw, MatchHistoryRecord.class);
        Map<UUID, PostMatchPlayer> players = record.getPlayers();
        if (players == null || players.isEmpty() || record.getTeams() == null) return JsonNull.INSTANCE;

        JsonArray participants = new JsonArray();
        Map<UUID, Integer> participantTeams = new LinkedHashMap<>();
        UUID selected = target == null && players.containsKey(viewer) ? viewer : target;
        for (int team = 0; team < record.getTeams().size(); team++) {
            for (UUID member : record.getTeams().get(team)) {
                PostMatchPlayer player = players.get(member);
                if (player == null || player.getLastUsername() == null) continue;
                JsonObject entry = new JsonObject();
                entry.addProperty("uuid", member.toString());
                entry.addProperty("name", player.getLastUsername());
                entry.addProperty("team", team);
                participants.add(entry);
                participantTeams.put(member, team);
                if (selected == null) selected = member;
            }
        }
        if (!participantTeams.containsKey(selected)) return JsonNull.INSTANCE;
        JsonObject captures = raw.getAsJsonObject("players");
        JsonObject saved = captures == null ? null : captures.getAsJsonObject(selected.toString());
        if (saved == null) return JsonNull.INSTANCE;
        int winner = record.getWinnerTeam();
        JsonObject result = new JsonObject();
        result.addProperty("id", id.toString());
        result.addProperty("kit", text(record.getKitName() == null ? record.getKitId() : record.getKitName(), 80));
        result.addProperty("map", text(record.getMapName(), 80));
        result.add("startedAt", record.getStartedAt() > 0 && record.getStartedAt() <= endedAt
                ? new JsonPrimitive(record.getStartedAt()) : JsonNull.INSTANCE);
        result.addProperty("endedAt", endedAt);
        result.addProperty("ranked", record.isRanked());
        result.add("winnerTeam", winner >= 0 ? new JsonPrimitive(winner) : JsonNull.INSTANCE);
        result.addProperty("endReason", record.getEndReason());
        result.add("participants", participants);
        result.add("snapshot", snapshot(players.get(selected), saved, selected, record, participantTeams.get(selected)));
        if (target == null) {
            // Keep room for the receipt envelope and load any remaining players separately on large matches.
            int remaining = MATCH_DETAIL_BYTE_BUDGET - result.toString().getBytes(StandardCharsets.UTF_8).length;
            JsonArray otherSnapshots = new JsonArray();
            for (Map.Entry<UUID, Integer> participant : participantTeams.entrySet()) {
                UUID member = participant.getKey();
                if (member.equals(selected)) continue;
                JsonObject capture = captures.getAsJsonObject(member.toString());
                if (capture == null) continue;
                JsonObject other = snapshot(players.get(member), capture, member, record, participant.getValue());
                int bytes = other.toString().getBytes(StandardCharsets.UTF_8).length + 1;
                if (bytes > remaining) break;
                otherSnapshots.add(other);
                remaining -= bytes;
            }
            result.add("otherSnapshots", otherSnapshots);
        }
        return result;
    }

    private static JsonObject snapshot(PostMatchPlayer player, JsonObject saved, UUID id, MatchHistoryRecord record, int team) {
        JsonObject snapshot = new JsonObject();
        snapshot.addProperty("uuid", id.toString());
        ItemStack[] inventory = present(saved, "inventory") ? player.getInventory() : null;
        ItemStack[] armor = present(saved, "armor") ? player.getArmor() : null;
        snapshot.add("inventory", items(inventory, 36));
        snapshot.add("armor", items(armor, 4));
        snapshot.add("health", number(saved, "health", player.getHealth()));
        snapshot.add("hunger", number(saved, "hunger", player.getHunger()));
        snapshot.add("effects", present(saved, "potionEffects") ? effects(player.getPotionEffects()) : JsonNull.INSTANCE);
        snapshot.add("hits", number(saved, "totalHits", player.getTotalHits()));
        snapshot.add("blocked", number(saved, "blockedHits", player.getBlockedHits()));
        snapshot.add("critical", number(saved, "criticalHits", player.getCriticalHits()));
        snapshot.add("combo", number(saved, "longestCombo", player.getLongestCombo()));
        snapshot.add("ping", number(saved, "ping", player.getPing()));
        HealingMethod healing = player.getHealingMethodUsed();
        snapshot.add("healing", inventory == null || healing == null ? JsonNull.INSTANCE
                : healing(healing, inventory, saved, player.getMissedPots()));
        boolean hasPots = healing == HealingMethod.POTIONS;
        boolean tracksDebuffs = "DEBUFF".equals(player.getKitId()) || "VANILLA".equals(player.getKitId());
        snapshot.add("healAccuracy", hasPots && present(saved, "thrownHp") && present(saved, "missedHp")
                ? accuracy(player.getThrownHp(), player.getMissedHp()) : JsonNull.INSTANCE);
        snapshot.add("debuffAccuracy", hasPots && tracksDebuffs && present(saved, "thrownDebuffs") && present(saved, "missedDebuffs")
                ? accuracy(player.getThrownDebuffs(), player.getMissedDebuffs()) : JsonNull.INSTANCE);
        snapshot.add("elo", elo(record, team));
        return snapshot;
    }

    private static JsonElement elo(MatchHistoryRecord record, int team) {
        MatchHistoryRecord.EloChange change = record.getEloChange();
        if (!record.isRanked() || record.getWinnerTeam() < 0 || change == null) return JsonNull.INSTANCE;
        boolean won = record.getWinnerTeam() == team;
        JsonObject elo = new JsonObject();
        elo.addProperty("before", won ? change.getWinnerOld() : change.getLoserOld());
        elo.addProperty("delta", won ? change.getWinnerGain() : change.getLoserGain());
        elo.addProperty("after", won ? change.getWinnerNew() : change.getLoserNew());
        return elo;
    }

    private static JsonElement healing(HealingMethod method, ItemStack[] items, JsonObject saved, int missed) {
        JsonObject value = new JsonObject();
        value.addProperty("method", method.name());
        value.addProperty("count", method.count(items));
        value.add("missed", number(saved, "missedPots", missed));
        return value;
    }

    private static JsonElement effects(List<PotionEffect> list) {
        if (list == null) return JsonNull.INSTANCE;
        JsonArray result = new JsonArray();
        for (PotionEffect effect : list) {
            if (effect == null || effect.getType() == null) continue;
            JsonObject entry = new JsonObject();
            entry.addProperty("type", effect.getType().getName());
            entry.addProperty("level", effect.getAmplifier() + 1);
            entry.addProperty("seconds", Math.max(0, effect.getDuration()) / 20);
            result.add(entry);
        }
        return result;
    }

    private static JsonElement items(ItemStack[] items, int slots) {
        if (items == null) return JsonNull.INSTANCE;
        JsonArray output = new JsonArray();
        for (int i = 0; i < slots; i++) output.add(i < items.length ? item(items[i]) : JsonNull.INSTANCE);
        return output;
    }

    private static JsonElement item(ItemStack stack) {
        if (stack == null || stack.getType() == Material.AIR || stack.getAmount() < 1) return JsonNull.INSTANCE;
        JsonObject item = new JsonObject();
        item.addProperty("material", stack.getType().name());
        item.addProperty("count", stack.getAmount());
        int maxDamage = stack.getType().getMaxDurability();
        int damage = stack.getDurability() & 0xffff;
        item.add("damage", maxDamage > 0 ? new JsonPrimitive(damage) : JsonNull.INSTANCE);
        item.add("maxDamage", maxDamage > 0 ? new JsonPrimitive(maxDamage) : JsonNull.INSTANCE);
        item.add("variant", maxDamage == 0 && damage > 0 ? new JsonPrimitive(damage) : JsonNull.INSTANCE);
        item.add("potion", potion(stack));

        ItemMeta meta = stack.hasItemMeta() ? stack.getItemMeta() : null;
        item.addProperty("name", meta != null && meta.hasDisplayName() ? text(meta.getDisplayName(), 100) : null);
        JsonArray lore = new JsonArray();
        if (meta != null && meta.hasLore()) {
            List<String> lines = meta.getLore();
            for (String line : lines.stream().limit(7).collect(Collectors.toList()))
                lore.add(new JsonPrimitive(text(line, 100)));
            if (lines.size() > 7) lore.add(new JsonPrimitive("…"));
        }
        item.add("lore", lore);

        JsonArray enchantments = new JsonArray();
        int index = 0;
        for (Map.Entry<Enchantment, Integer> enchantment : stack.getEnchantments().entrySet()) {
            if (index++ >= 16) break;
            JsonObject entry = new JsonObject();
            entry.addProperty("type", text(enchantment.getKey().getName(), 40));
            entry.addProperty("level", enchantment.getValue());
            enchantments.add(entry);
        }
        item.add("enchantments", enchantments);
        return item;
    }

    @SuppressWarnings("deprecation")
    private static JsonElement potion(ItemStack stack) {
        if (stack.getType() != Material.POTION) return JsonNull.INSTANCE;
        try {
            Potion potion = Potion.fromItemStack(stack);
            JsonObject value = new JsonObject();
            value.addProperty("type", potion.getType() == null ? "WATER" : potion.getType().name());
            value.addProperty("level", potion.getLevel());
            value.addProperty("splash", potion.isSplash());
            value.addProperty("extended", potion.hasExtendedDuration());
            return value;
        } catch (IllegalArgumentException unsupported) {
            return JsonNull.INSTANCE;
        }
    }

    private static JsonElement accuracy(double thrown, double missed) {
        return thrown > 0 && Double.isFinite(thrown) && Double.isFinite(missed)
                ? new JsonPrimitive(100 - (int) (missed / thrown * 100)) : JsonNull.INSTANCE;
    }

    private static JsonElement number(JsonObject saved, String field, double value) {
        return present(saved, field) && Double.isFinite(value) ? new JsonPrimitive(value) : JsonNull.INSTANCE;
    }

    private static boolean present(JsonObject object, String field) {
        JsonElement value = object.get(field);
        return value != null && !value.isJsonNull();
    }

    private static String text(String input, int limit) {
        if (input == null) return null;
        String cleaned = ChatColor.stripColor(input);
        return cleaned.length() > limit ? cleaned.substring(0, limit) : cleaned;
    }
}

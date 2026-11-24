package cc.micet.sitebridge;

import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoCursor;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.Sorts;
import eu.bcz.micetpvp.Micet.botduel.BotStoragePolicy;
import eu.bcz.micetpvp.MicetPvP;
import eu.bcz.micetpvp.kittype.KitType;
import eu.bcz.micetpvp.match.history.HistoryDocuments;
import eu.bcz.micetpvp.match.history.MatchHistoryRepository;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.bson.Document;
import org.bson.conversions.Bson;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonArray;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonElement;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonNull;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonObject;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonParser;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonPrimitive;

final class GameStats {
    private static final Pattern PLAYER_NAME = Pattern.compile("[A-Za-z0-9_]{1,16}");
    private final SiteBridge plugin;
    private final MicetPvP practice;
    private final MongoDatabase mongo;
    private final MatchHistoryRepository history;

    GameStats(SiteBridge plugin, MicetPvP practice) {
        this.plugin = plugin;
        this.practice = practice;
        this.mongo = practice.getMongoDatabase();
        this.history = new MatchHistoryRepository(mongo.getCollection("matchHistory"));
    }

    JsonElement profile(String name) throws Exception {
        if (!PLAYER_NAME.matcher(name).matches()) return JsonNull.INSTANCE;
        UUID id = practice.getUuidCache().uuid(name);
        if (id == null) {
            Pattern exactName = Pattern.compile("^" + Pattern.quote(name) + "$", Pattern.CASE_INSENSITIVE);
            Document found = find("playerStatistics", Filters.regex("lastUsername", exactName));
            if (found != null) id = tryUuid(found.getString("_id"));
            if (id == null) {
                found = find("elo", Filters.and(solo(), Filters.regex("lastUsername", exactName)));
                id = found == null ? null : firstPlayer(found);
            }
        }
        if (id == null || BotStoragePolicy.isBot(id)) return JsonNull.INSTANCE;
        Document rating = find("elo", Filters.eq("players", Collections.singletonList(id.toString())));
        Document counters = find("playerStatistics", Filters.eq("_id", id.toString()));
        String currentName = currentName(counters, rating);
        if (currentName == null) currentName = name;
        if (currentName == null) return JsonNull.INSTANCE;
        JsonObject result = entry(id, currentName);
        JsonArray scores = new JsonArray();
        for (Ladder ladder : ladders(false)) {
            Document stats = counters == null ? null : counters.get(ladder.key, Document.class);
            Object elo = rating == null ? null : rating.get(ladder.key);
            JsonObject score = ladder.description();
            score.add("elo", elo instanceof Number ? new JsonPrimitive((Number) elo) : JsonNull.INSTANCE);
            score.addProperty("wins", count(stats, "WINS"));
            score.addProperty("losses", count(stats, "LOSSES"));
            scores.add(score);
        }
        result.add("scores", scores);
        return result;
    }

    JsonArray boards() throws Exception {
        JsonArray boards = new JsonArray();
        MongoCollection<Document> ratings = mongo.getCollection("elo");
        for (Ladder ladder : ladders(true)) {
            JsonArray entries = new JsonArray();
            Bson projection = new Document("players", 1).append("lastUsername", 1).append(ladder.key, 1);
            try (MongoCursor<Document> cursor = ratings.find(Filters.and(solo(), Filters.exists(ladder.key)))
                    .projection(projection).sort(Sorts.orderBy(Sorts.descending(ladder.key), Sorts.ascending("_id")))
                    .maxTime(3, TimeUnit.SECONDS).iterator()) {
                while (entries.size() < 10 && cursor.hasNext()) {
                    Document row = cursor.next();
                    UUID uuid = firstPlayer(row);
                    if (uuid == null || BotStoragePolicy.isBot(uuid) || !(row.get(ladder.key) instanceof Number)) continue;
                    String player = currentName(row, null);
                    if (player == null) continue;
                    JsonObject entry = entry(uuid, player);
                    entry.addProperty("elo", ((Number) row.get(ladder.key)).intValue());
                    entries.add(entry);
                }
            }
            JsonObject board = ladder.description();
            board.add("entries", entries);
            boards.add(board);
        }
        return boards;
    }

    JsonArray matches(UUID owner) {
        JsonArray matches = new JsonArray();
        if (BotStoragePolicy.isBot(owner)) return matches;
        long now = System.currentTimeMillis();
        for (Document row : history.recent(owner, now)) {
            if (Boolean.TRUE.equals(row.get("botMatch")) || !HistoryDocuments.canView(row, owner, now)) continue;
            if (row.getDate("endedAt").getTime() < now - TimeUnit.DAYS.toMillis(7)) continue;
            JsonObject saved = new JsonParser().parse(row.getString("payload")).getAsJsonObject();
            JsonArray teams = saved.getAsJsonArray("teams");
            if (teams == null) continue;
            int ownerTeam = -1;
            for (int i = 0; i < teams.size(); i++) {
                for (JsonElement id : teams.get(i).getAsJsonArray()) {
                    if (owner.toString().equals(id.getAsString())) ownerTeam = i;
                }
            }
            if (ownerTeam < 0) continue;
            JsonObject playerSnapshots = saved.getAsJsonObject("players");
            JsonArray opponents = new JsonArray();
            for (int i = 0; i < teams.size(); i++) {
                if (i == ownerTeam) continue;
                for (JsonElement id : teams.get(i).getAsJsonArray()) {
                    UUID opponent = tryUuid(id.getAsString());
                    if (opponent == null || BotStoragePolicy.isBot(opponent)) continue;
                    JsonObject snapshot = playerSnapshots != null && playerSnapshots.has(id.getAsString())
                            ? playerSnapshots.getAsJsonObject(id.getAsString()) : null;
                    String name = string(snapshot, "lastUsername");
                    if (name != null && PLAYER_NAME.matcher(name).matches()) opponents.add(name);
                }
            }
            int winner = saved.get("winnerTeam").getAsInt();
            boolean ranked = saved.get("ranked").getAsBoolean();
            JsonObject match = new JsonObject();
            match.addProperty("id", row.getString("_id"));
            match.addProperty("kit", stripColor(string(saved, "kitName")));
            match.add("opponents", opponents);
            match.addProperty("result", winner < 0 ? "draw" : winner == ownerTeam ? "win" : "loss");
            match.addProperty("endedAt", row.getDate("endedAt").getTime());
            match.addProperty("ranked", ranked);
            JsonElement eloChange = saved.get("eloChange");
            JsonElement delta = ranked && winner >= 0 && eloChange != null && eloChange.isJsonObject()
                    ? eloChange.getAsJsonObject().get(winner == ownerTeam ? "winnerGain" : "loserGain") : null;
            match.add("delta", delta == null ? JsonNull.INSTANCE : delta);
            matches.add(match);
        }
        return matches;
    }

    JsonElement matchDetail(UUID viewer, UUID id, String rawTarget) throws Exception {
        if (BotStoragePolicy.isBot(viewer)) return JsonNull.INSTANCE;
        long now = System.currentTimeMillis();
        Document row = history.find(id);
        if (row == null || Boolean.TRUE.equals(row.get("botMatch"))
                || row.getDate("endedAt") == null || row.getDate("expiresAt") == null
                || !HistoryDocuments.canView(row, viewer, now)) return JsonNull.INSTANCE;
        long endedAt = row.getDate("endedAt").getTime();
        if (endedAt < now - TimeUnit.DAYS.toMillis(7)) return JsonNull.INSTANCE;

        UUID target = rawTarget == null || rawTarget.isEmpty() ? null : UUID.fromString(rawTarget);
        String payload = row.getString("payload");
        return Bukkit.getScheduler().callSyncMethod(plugin,
                () -> MatchDetailProjection.project(payload, id, endedAt, viewer, target))
                .get(5, TimeUnit.SECONDS);
    }

    private List<Ladder> ladders(boolean rankedOnly) throws Exception {
        return Bukkit.getScheduler().callSyncMethod(plugin, () -> {
            List<Ladder> ladders = new ArrayList<>();
            ladders.add(new Ladder("GLOBAL", "综合"));
            for (KitType kit : KitType.getAllTypes()) {
                if (rankedOnly && (!kit.isSupportsRanked() || kit.isHidden())) continue;
                String key = kit.getId();
                if (key.matches("[A-Za-z0-9_-]{1,40}") && !"GLOBAL".equalsIgnoreCase(key))
                    ladders.add(new Ladder(key, stripColor(kit.getDisplayName())));
                if (ladders.size() == 40) break;
            }
            return ladders;
        }).get(4, TimeUnit.SECONDS);
    }

    private Document find(String collection, Bson filter) {
        return mongo.getCollection(collection).find(filter).maxTime(3, TimeUnit.SECONDS).first();
    }

    private static String currentName(Document preferred, Document fallback) {
        String name = preferred == null ? null : preferred.getString("lastUsername");
        if (name == null && fallback != null) name = fallback.getString("lastUsername");
        return name != null && PLAYER_NAME.matcher(name).matches() ? name : null;
    }

    private static Bson solo() {
        return Filters.and(Filters.exists("players.0"), Filters.exists("players.1", false));
    }

    private static UUID firstPlayer(Document row) {
        List<?> players = row.get("players", List.class);
        return players == null || players.isEmpty() ? null : tryUuid(String.valueOf(players.get(0)));
    }

    private static UUID tryUuid(String text) {
        try { return UUID.fromString(text); }
        catch (IllegalArgumentException | NullPointerException error) { return null; }
    }

    private static long count(Document row, String field) {
        Object value = row == null ? null : row.get(field);
        return value instanceof Number ? Math.max(0, ((Number) value).longValue()) : 0;
    }

    private static JsonObject entry(UUID id, String player) {
        JsonObject entry = new JsonObject();
        entry.addProperty("uuid", id.toString());
        entry.addProperty("player", player);
        return entry;
    }

    static String string(JsonObject row, String key) {
        JsonElement value = row == null ? null : row.get(key);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }

    private static String stripColor(String value) {
        return value == null ? "未知玩法" : ChatColor.stripColor(value);
    }

    private static final class Ladder {
        final String key;
        final String label;
        Ladder(String key, String label) { this.key = key; this.label = label; }
        JsonObject description() {
            JsonObject object = new JsonObject();
            object.addProperty("id", key.toLowerCase(Locale.ROOT));
            object.addProperty("name", label);
            return object;
        }
    }
}

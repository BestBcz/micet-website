package cc.micet.sitebridge;

import eu.bcz.micetpvp.Micet.botduel.BotStoragePolicy;
import eu.bcz.micetpvp.MicetPvP;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import me.activated.core.api.player.PlayerData;
import me.activated.core.api.tags.Tag;
import me.activated.core.plugin.AquaCore;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonElement;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonNull;
import org.bukkit.craftbukkit.libs.com.google.gson.JsonObject;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

public final class SiteBridge extends JavaPlugin {
    private static final Pattern CODE = Pattern.compile("[A-Z2-9]{10}", Pattern.CASE_INSENSITIVE);

    private final Set<UUID> allowedPlayers = new HashSet<>();
    private final Set<UUID> bindingRequests = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private ScheduledExecutorService worker;
    private BridgeClient client;
    private GameStats stats;
    private AquaCore aqua;
    private String testTag;
    private long lastWarning;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        if (!getConfig().getBoolean("enabled")) {
            getLogger().info("Bridge is disabled. Configure the isolated test server before enabling.");
            return;
        }
        try {
            client = new BridgeClient(getConfig().getString("site-url", "").trim(),
                    getConfig().getString("bridge-secret", "").trim(), getConfig().getString("site-service-token", "").trim());
            for (String raw : getConfig().getStringList("allowed-player-uuids")) allowedPlayers.add(UUID.fromString(raw.trim()));
            testTag = getConfig().getString("test-tag", "MICET_TEST").trim();
            if (!testTag.matches("[A-Za-z0-9_-]{1,32}")) throw new IllegalArgumentException("Invalid test Tag identifier.");
            aqua = (AquaCore) Bukkit.getPluginManager().getPlugin("AquaCore");
            stats = new GameStats(this, MicetPvP.getInstance());
        } catch (RuntimeException error) {
            getLogger().warning("Bridge configuration is invalid. Check the Site origin, secrets, and allowlisted UUIDs.");
            return;
        }
        worker = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "MicetSiteBridge");
            thread.setDaemon(true);
            return thread;
        });
        int seconds = Math.max(2, Math.min(getConfig().getInt("poll-seconds", 3), 15));
        worker.scheduleWithFixedDelay(this::poll, 0, seconds, TimeUnit.SECONDS);
    }

    @Override
    public void onDisable() {
        if (worker != null) worker.shutdownNow();
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] arguments) {
        if (!(sender instanceof Player)) {
            sender.sendMessage("Run this command from your Minecraft account.");
            return true;
        }
        if (worker == null || worker.isShutdown()) {
            sender.sendMessage(ChatColor.RED + "站点绑定暂不可用。");
            return true;
        }
        if (arguments.length != 1 || !CODE.matcher(arguments[0]).matches()) return false;
        Player player = (Player) sender;
        UUID uuid = player.getUniqueId();
        if (!bindingRequests.add(uuid)) {
            player.sendMessage(ChatColor.YELLOW + "正在验证先前的请求。");
            return true;
        }
        String name = player.getName();
        String code = arguments[0];
        worker.execute(() -> bind(uuid, name, code));
        return true;
    }

    private void bind(UUID uuid, String name, String code) {
        String message;
        try {
            if (BotStoragePolicy.isBot(uuid)) throw new IllegalArgumentException();
            JsonObject body = new JsonObject();
            body.addProperty("uuid", uuid.toString());
            body.addProperty("player", name);
            body.addProperty("code", code);
            client.post("link", body);
            message = ChatColor.GREEN + "已绑定 MiCet.cc 测试站。";
        } catch (BridgeClient.HttpError error) {
            message = ChatColor.RED + (error.status == 404 ? "验证码已失效。" : error.status == 409 ? "这个账号已有绑定。" : "站点验证暂不可用。");
        } catch (Exception error) {
            message = ChatColor.RED + "站点验证暂不可用。";
        } finally {
            bindingRequests.remove(uuid);
        }
        String result = message;
        if (isEnabled()) Bukkit.getScheduler().runTask(this, () -> {
            Player online = Bukkit.getPlayer(uuid);
            if (online != null) online.sendMessage(result);
        });
    }

    private void poll() {
        try {
            JsonElement element = client.post("poll", new JsonObject()).get("job");
            if (element == null || !element.isJsonObject()) return;
            work(element.getAsJsonObject());
        } catch (Exception error) {
            if (System.currentTimeMillis() - lastWarning > 60_000 && isEnabled()) {
                getLogger().warning("Private Site bridge retrying (" + error.getClass().getSimpleName() + ").");
                lastWarning = System.currentTimeMillis();
            }
        }
    }

    private void work(JsonObject job) throws Exception {
        String kind = GameStats.string(job, "kind");
        JsonObject payload = job.getAsJsonObject("payload");
        JsonElement data = JsonNull.INSTANCE;
        String outcome = "ok";
        try {
            if ("boards".equals(kind)) data = stats.boards();
            else if ("profile".equals(kind)) data = stats.profile(GameStats.string(payload, "name"));
            else if ("matches".equals(kind)) data = stats.matches(UUID.fromString(GameStats.string(payload, "uuid")));
            else if ("match-detail".equals(kind)) data = stats.matchDetail(
                    UUID.fromString(GameStats.string(payload, "uuid")),
                    UUID.fromString(GameStats.string(payload, "matchId")), GameStats.string(payload, "target"));
            else if ("delivery".equals(kind)) outcome = deliver(payload);
            else outcome = "failed";
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return;
        } catch (Exception error) {
            outcome = "delivery".equals(kind) ? "retry" : "failed";
            getLogger().fine("Game data operation did not complete: " + error.getClass().getSimpleName());
        }
        JsonObject receipt = new JsonObject();
        receipt.addProperty("id", GameStats.string(job, "id"));
        receipt.addProperty("lease", GameStats.string(job, "lease"));
        receipt.addProperty("outcome", outcome);
        receipt.add("data", data);
        client.post("receipt", receipt);
    }

    private String deliver(JsonObject payload) throws Exception {
        UUID uuid = UUID.fromString(GameStats.string(payload, "uuid"));
        if (!"micet-test".equals(GameStats.string(payload, "sku")) || !allowedPlayers.contains(uuid) || BotStoragePolicy.isBot(uuid)) return "failed";

        // Stay on the same staging server as the account and use an absolute,
        // non-stackable ownership count so retrying the same order is safe.
        Grant grant = Bukkit.getScheduler().callSyncMethod(this, () -> {
            Tag tag = aqua.getTagManagement().getTag(testTag);
            if (tag == null || tag.isStackable() || (aqua.getManagedTagService() != null
                    && aqua.getManagedTagService().isManagedTag(tag.getName()))) return new Grant("failed", null);
            Player online = Bukkit.getPlayer(uuid);
            if (online == null) return new Grant("retry", null);
            PlayerData data = aqua.getPlayerManagement().getPlayerData(uuid);
            if (data == null) return new Grant("retry", null);
            if (data.isEphemeral() || data.setOwnedTagCount(tag.getName(), 1) != 1) return new Grant("failed", null);
            data.updateDisplayName(online);
            return new Grant("ok", data);
        }).get(4, TimeUnit.SECONDS);
        if (grant.data == null) return grant.outcome;
        return grant.data.save(false) == null ? "retry" : "ok";
    }

    private static final class Grant {
        final String outcome;
        final PlayerData data;
        Grant(String outcome, PlayerData data) { this.outcome = outcome; this.data = data; }
    }
}

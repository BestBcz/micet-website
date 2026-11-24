export const SERVER_ADDRESS = "micet.cc";

export type ServerStatus = {
  state: "online" | "unreachable" | "unknown";
  motd: string[];
  onlinePlayers: number | null;
  maxPlayers: number | null;
  icon: string | null;
};

const unknown: ServerStatus = { state: "unknown", motd: [], onlinePlayers: null, maxPlayers: null, icon: null };

export async function getServerStatus(source?: string): Promise<ServerStatus> {
  if (!source) return unknown;
  try {
    const endpoint = new URL(source);
    const local = endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
    if ((!local && endpoint.protocol !== "https:") || endpoint.username || endpoint.password) return unknown;
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5500), redirect: "manual" });
    if (!response.ok) return unknown;
    const data = await response.json() as ServerStatus;
    if (data.state !== "online") return data.state === "unreachable" ? { ...unknown, state: "unreachable" } : unknown;
    const safeCount = (value: number | null) => value != null && Number.isSafeInteger(value) && value >= 0 ? value : null;
    return {
      state: "online",
      motd: Array.isArray(data.motd) ? data.motd.filter(line => typeof line === "string").slice(0, 2).map(line => line.slice(0, 640)) : [],
      icon: typeof data.icon === "string" && data.icon.length <= 50_000
        && /^data:image\/png;base64,[a-z\d+/]+=*$/i.test(data.icon) ? data.icon : null,
      onlinePlayers: safeCount(data.onlinePlayers),
      maxPlayers: safeCount(data.maxPlayers),
    };
  } catch {
    return unknown;
  }
}

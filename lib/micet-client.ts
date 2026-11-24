export async function api<T>(action: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/micet/" + action, {
    signal,
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json = await response.json() as { error?: string };
  if (!response.ok) throw new Error(json.error ?? "请求失败，请稍后再试。");
  return json as T;
}

export async function readStats<T>(kind: string, signal: AbortSignal, filters?: Record<string, string>): Promise<T> {
  const initial = await api<{ data?: T; pending?: string }>("stats", { kind, ...filters }, signal);
  if (!initial.pending) return initial.data as T;
  for (let attempt = 0; attempt < 17; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 750));
    const result = await api<{ status: string; data: T }>("result?id=" + encodeURIComponent(initial.pending), undefined, signal);
    if (result.status === "done") return result.data;
    if (result.status === "failed") throw new Error("游戏服暂时无法返回这项数据。");
  }
  throw new Error("连接游戏服超时，请重试。");
}

export async function api<T>(action: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/micet/" + action, {
    signal,
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const failure = response.ok ? "服务器返回了无法读取的响应。" : `请求失败（HTTP ${response.status}），请稍后再试。`;
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) throw new Error(failure);
  const json = await response.json().catch(error => {
    if (signal?.aborted) throw error;
    throw new Error(failure);
  }) as { error?: string };
  if (!response.ok) throw new Error(json?.error ?? failure);
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

export async function readPublicStats<T>(action: string, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await api<{ data: T; pending?: true }>(action, undefined, signal);
    if (!result.pending) return result.data;
    await new Promise(resolve => setTimeout(resolve, 1250));
    signal.throwIfAborted();
  }
  throw new Error("连接游戏服超时，请重试。");
}

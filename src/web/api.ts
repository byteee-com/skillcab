// Remove stale credentials and fragments from versions before 0.3.
if (new URLSearchParams(window.location.hash.slice(1)).has("token"))
  history.replaceState(null, "", window.location.pathname);
sessionStorage.removeItem("skills-console-session");

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "X-Skills-Console": "1",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({ error: "请求失败，请重试。" }))) as { error?: string };
    throw new Error(body.error ?? `请求失败（${response.status}）。`);
  }
  return response.json() as Promise<T>;
}

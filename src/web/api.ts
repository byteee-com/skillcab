const fragment = new URLSearchParams(window.location.hash.slice(1));
const incoming = fragment.get("token");
if (incoming) {
  sessionStorage.setItem("skills-console-session", incoming);
  history.replaceState(null, "", window.location.pathname);
}
const token =
  incoming ?? sessionStorage.getItem("skills-console-session") ?? "";

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
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

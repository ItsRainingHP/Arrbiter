export type AuthStatus = { authenticated: boolean; mustChangeCredentials: boolean; username?: string; csrf?: string };
let csrf = "";
export function setCsrf(value?: string) { csrf = value || ""; }

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export function displayTime(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

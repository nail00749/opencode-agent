import * as Service from "@opencode/client/service"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isolatedEndpoint(value: unknown, pid: number, version: string): Service.Endpoint {
  if (!record(value) || value.pid !== pid || value.version !== version || typeof value.url !== "string" || typeof value.password !== "string" || !value.password) throw new Error("Disposable registration PID/version/auth invalid")
  const url = new URL(value.url)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Disposable registration endpoint invalid")
  return { url: url.href, auth: { type: "basic", username: "opencode", password: value.password } }
}

export function assertIdentity(value: unknown, pid: number, version: string): void {
  if (!record(value) || value.pid !== pid || value.version !== version) throw new Error("Server info PID/version mismatch")
}

export function locationQuery(directory: string): string {
  return `?${new URLSearchParams({ "location[directory]": directory })}`
}

// The installed 2.0.24 bundled service/client uses /api/info, no activation
// endpoint, direct info responses and exactly one {data} session envelope.
// Do not compensate for arbitrary boxing or accept primitive/error envelopes.
export type Transport = (url: URL, init: RequestInit) => Promise<Response>

export async function request(endpoint: Service.Endpoint, path: string, method = "GET", body?: unknown, empty = false, transport: Transport = fetch): Promise<unknown> {
  const base = new URL(endpoint.url)
  const url = new URL(path, base)
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || url.origin !== base.origin || !endpoint.auth?.password || endpoint.auth.username !== "opencode") throw new Error("Isolated authenticated loopback endpoint required")
  const response = await transport(url, { method, headers: { "content-type": "application/json", ...Service.headers(endpoint) }, signal: AbortSignal.timeout(10_000), redirect: "error", ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  // Never include rejected bodies, which can contain credentials or prompts.
  if (response.status !== (empty ? 204 : 200)) throw new Error(`Host API ${url.pathname} returned ${response.status}`)
  if (empty) return undefined
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Host API unsupported content type")
  let value: unknown
  try { value = await response.json() } catch { throw new Error("Host API malformed JSON") }
  if ((!record(value) && !Array.isArray(value)) || (record(value) && "error" in value)) throw new Error("Host API malformed or error response")
  return value
}

export function sessionData(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.data) || "error" in value || "error" in value.data) throw new Error("Host session data envelope invalid")
  return value.data
}

export async function awaitPlugin(read: () => Promise<unknown>, assertAlive: () => void, timeout = 15_000, pause: () => Promise<void> = () => Bun.sleep(100), now: () => number = Date.now): Promise<Record<string, unknown>> {
  const deadline = now() + timeout
  while (true) {
    assertAlive()
    const inventory = await read()
    if (!record(inventory) || !Array.isArray(inventory.data)) throw new Error("Host plugin inventory envelope invalid")
    const plugin = inventory.data.find((entry) => record(entry) && entry.id === "agent-gvozd")
    if (record(plugin) && record(plugin.state)) {
      if (plugin.state.status === "failed") throw new Error("Disposable agent-gvozd activation failed")
      if (plugin.state.status === "active") return plugin
    }
    if (now() >= deadline) throw new Error("Disposable agent-gvozd activation timed out")
    await pause()
  }
}

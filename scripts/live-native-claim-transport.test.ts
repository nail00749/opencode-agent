import { describe, expect, test } from "bun:test"
import { assertIdentity, awaitPlugin, isolatedEndpoint, locationQuery, request, sessionData, type Transport } from "./live-native-claim-transport"

const info = { pid: 123, version: "2.0.24", url: "http://127.0.0.1:54321", password: "isolated-test-password" }
const endpoint = isolatedEndpoint(info, info.pid, info.version)
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
function fixture(response: Response): Transport {
  return async () => response
}

describe("isolated installed-host transport", () => {
  test("activation polls empty inventory until active", async () => {
    const active = { id: "agent-gvozd", state: { status: "active" } }
    let calls = 0
    let alive = 0
    expect(await awaitPlugin(async () => ({ data: ++calls === 1 ? [] : [active] }), () => { alive++ }, 100, async () => {}, () => 0)).toEqual(active)
    expect(calls).toBe(2)
    expect(alive).toBe(2)
  })
  test("activation fails fast on failed state without leaking diagnostics", async () => {
    let sleeps = 0
    await expect(awaitPlugin(async () => ({ data: [{ id: "agent-gvozd", state: { status: "failed", error: "secret" } }] }), () => {}, 100, async () => { sleeps++ })).rejects.toThrow("Disposable agent-gvozd activation failed")
    expect(sleeps).toBe(0)
  })
  test("activation has a deadline and checks host exit", async () => {
    await expect(awaitPlugin(async () => ({ data: [] }), () => {}, 0)).rejects.toThrow("timed out")
    let reads = 0
    await expect(awaitPlugin(async () => { reads++; return { data: [] } }, () => { throw new Error("host exited") })).rejects.toThrow("host exited")
    expect(reads).toBe(0)
  })
  test("registration binds exact spawned PID/version and authenticated loopback", () => {
    expect(endpoint.auth).toEqual({ type: "basic", username: "opencode", password: info.password })
    for (const value of [null, 1, {}, { ...info, pid: 124 }, { ...info, version: "2.0.2" }, { ...info, password: "" }, { ...info, url: "https://example.com" }, { ...info, url: "http://127.0.0.1:54321/path" }, { ...info, url: "http://secret@127.0.0.1:54321" }]) {
      expect(() => isolatedEndpoint(value, info.pid, info.version)).toThrow()
    }
  })
  test("identity is direct, never recursively unboxed", () => {
    assertIdentity(info, info.pid, info.version)
    for (const value of [null, true, "ok", { data: info }, { ...info, pid: 124 }, { ...info, version: "2.0.2" }]) expect(() => assertIdentity(value, info.pid, info.version)).toThrow()
  })
  test("location is the generated client's deep-object query", () => {
    const params = new URLSearchParams(locationQuery("/private/space + &/project").slice(1))
    expect(params.get("location[directory]")).toBe("/private/space + &/project")
    expect(params.has("location")).toBe(false)
  })
  test("request sends only isolated Basic auth, body, timeout and rejects redirects", async () => {
    const transport = (async (url: URL, init: RequestInit) => {
      expect(url.origin).toBe("http://127.0.0.1:54321")
      expect(init.method).toBe("POST")
      expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`)
      expect(init.body).toBe('{"text":"fixture"}')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.redirect).toBe("error")
      return json({ data: { id: "ses_fixture" } })
    }) satisfies Transport
    expect(sessionData(await request(endpoint, "/api/session", "POST", { text: "fixture" }, false, transport)).id).toBe("ses_fixture")
    await expect(request(endpoint, "http://127.0.0.1:54322/api/info", "GET", undefined, false, transport)).rejects.toThrow("loopback")
    await expect(request({ url: endpoint.url }, "/api/info", "GET", undefined, false, transport)).rejects.toThrow("authenticated")
  })
  test("direct list/info and exact 204 empty contracts", async () => {
    expect(await request(endpoint, "/api/info", "GET", undefined, false, fixture(json(info)))).toEqual(info)
    expect(await request(endpoint, "/api/plugin", "GET", undefined, false, fixture(json([])))).toEqual([])
    expect(await request(endpoint, "/api/session/id/wait", "POST", undefined, true, fixture(new Response(null, { status: 204 })))).toBeUndefined()
    await expect(request(endpoint, "/api/info", "GET", undefined, false, fixture(new Response(null, { status: 204 })))).rejects.toThrow("204")
  })
  test("malformed, primitive, error and rejected envelopes fail without body leakage", async () => {
    for (const value of [null, true, 123, "boxed", { error: "secret" }]) await expect(request(endpoint, "/api/info", "GET", undefined, false, fixture(json(value)))).rejects.toThrow("malformed or error")
    await expect(request(endpoint, "/api/info", "GET", undefined, false, fixture(new Response("{", { headers: { "content-type": "application/json" } })))).rejects.toThrow("malformed JSON")
    await expect(request(endpoint, "/api/info", "GET", undefined, false, fixture(new Response("secret", { status: 401 })))).rejects.toThrow("Host API /api/info returned 401")
    for (const value of [{ id: "bare" }, { data: "primitive" }, { data: { data: { id: "nested" } }, error: "rejected" }, null]) expect(() => sessionData(value)).toThrow("envelope")
  })
})

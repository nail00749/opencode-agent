import { describe, expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import type { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { nativePermissions } from "./native-permissions"

type NativeContext = Parameters<typeof nativePermissions>[0]
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
const sessionInfo = (): SessionInfo => ({
  id: "ses_native",
  projectID: "prj_native",
  location: { directory: "/isolated-native-fixture" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  permissions: [{ action: "read", resource: "docs/**", effect: "allow" }],
})
const input = { sessionID: "ses_native", permissions: [{ action: "skill", resource: "*", effect: "allow" as const }] }

describe("native permission capabilities", () => {
  test("uses the typed SDK reader and rules writer with their receivers", async () => {
    let written: unknown
    const ctx: NativeContext = {
      session: { async get() { expect(this).toBe(ctx.session!); return sessionInfo() } },
      permission: { async rules(value) { expect(this).toBe(ctx.permission!); written = value } },
    }
    const native = nativePermissions(ctx)!
    expect((await native.get({ sessionID: input.sessionID })).permissions).toEqual(sessionInfo().permissions)
    await native.write(input)
    expect(written).toEqual(input)
  })

  test("supports a legacy-only session writer without requiring list", async () => {
    let written: unknown
    const ctx: NativeContext = { session: {
      async get() { return sessionInfo() },
      async update(value) { expect(this).toBe(ctx.session!); written = value; return sessionInfo() },
    } }
    await nativePermissions(ctx)!.write(input)
    expect(written).toEqual(input)
  })

  test("prefers permission.rules when both exist and never retries a failed write through legacy", async () => {
    let legacyWrites = 0
    let fail = false
    let writes = 0
    const native = nativePermissions({
      session: { async get() { return sessionInfo() }, async update() { legacyWrites++ } },
      permission: { async rules() { writes++; if (fail) throw new Error("write failed") } },
    })!
    await native.write(input)
    fail = true
    await expect(native.write(input)).rejects.toThrow("write failed")
    expect(writes).toBe(2)
    expect(legacyWrites).toBe(0)
  })

  test("requires a reader and a writer, never a write-only replacement", () => {
    expect(nativePermissions({})).toBeUndefined()
    expect(nativePermissions({ session: { async get() { return sessionInfo() } } })).toBeUndefined()
    expect(nativePermissions({ permission: { async rules() {} } })).toBeUndefined()
    expect(nativePermissions({ session: { async update() {} } })).toBeUndefined()
  })

  test("propagates legacy write and SDK read failures", async () => {
    const native = nativePermissions({ session: {
      async get() { throw new Error("read failed") },
      async update() { throw new Error("legacy write failed") },
    } })!
    await expect(native.get({ sessionID: input.sessionID })).rejects.toThrow("read failed")
    await expect(native.write(input)).rejects.toThrow("legacy write failed")
  })
})

test("installed 2.0.2 Promise adapter exposes rules/get, validates payloads and propagates host failures", async () => {
  let stored = sessionInfo()
  let writes = 0
  let fail = false
  const session: Pick<EffectPlugin.Context["session"], "get"> = {
    get: () => Effect.succeed(Schema.decodeUnknownSync(Session.Info)(stored)),
  }
  const permission: Pick<EffectPlugin.Context["permission"], "rules"> = {
    rules: (value) => Effect.sync(() => {
      if (fail) throw new Error("isolated host refused write")
      writes++
      stored = { ...stored, permissions: [...value.permissions] }
    }),
  }
  // Only get/rules are invoked. The other domains let the installed adapter
  // construct its real Promise context; no running server or filesystem is used.
  const host = {
    session, permission,
    agent: {}, aisdk: {}, catalog: { provider: {}, model: {} }, command: {}, event: {},
    experimental: { terminal: {} }, generate: {},
    integration: { connect: {}, oauth: {}, command: {} }, mcp: {}, plugin: {}, reference: {},
    rpc: {}, skill: {}, storage: {}, tool: {}, vcs: {}, websearch: {}, worktree: {}, shell: {},
  }
  const probe = Plugin.define({
    id: "gvozd-native-contract-test",
    async setup(ctx) {
      expect(typeof ctx.permission.rules).toBe("function")
      expect(typeof ctx.session.get).toBe("function")
      expect("update" in ctx.session).toBe(false)
      expect("list" in ctx.session).toBe(false)
      const native = nativePermissions(ctx)!
      const current = await native.get({ sessionID: input.sessionID })
      await native.write({ ...input, permissions: [...current.permissions!, ...input.permissions] })
      expect((await native.get({ sessionID: input.sessionID })).permissions).toEqual([
        ...sessionInfo().permissions!, ...input.permissions,
      ])
      expect(writes).toBe(1)
      // Exercise installed endpoint decoding, not merely a permissive callback.
      await expect(native.write({ ...input, sessionID: "invalid" })).rejects.toThrow()
      expect(writes).toBe(1)
      fail = true
      await expect(native.write(input)).rejects.toThrow("isolated host refused write")
      expect(writes).toBe(1)
    },
  })
  await Effect.runPromise(Effect.scoped(fromPromise(probe).effect(host as EffectPlugin.Context)))
})

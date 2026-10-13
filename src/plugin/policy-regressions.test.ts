import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"
import { loadConfig, type PermissionRule } from "../core/config"
import { buildAgentPermissions } from "../core/agent-permissions"
import { evaluateEffect } from "../rpc/permissions-rpc"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-policy-regression-")))
  const project = join(root, "project")
  mkdirSync(project)
  const previous = process.env.GVOZD_OPENCODE_CONFIG_ROOT
  process.env.GVOZD_OPENCODE_CONFIG_ROOT = join(root, "global")
  cleanups.push(() => {
    if (previous === undefined) delete process.env.GVOZD_OPENCODE_CONFIG_ROOT
    else process.env.GVOZD_OPENCODE_CONFIG_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  })
  const sessions: Record<string, { id: string; parentID?: string; permissions: PermissionRule[] }> = {
    root: { id: "root", permissions: [] },
    child: { id: "child", parentID: "root", permissions: [] },
  }
  const config = loadConfig(project)
  const servers = ["context7"]
  async function host(beforeWrite?: (sessionID: string) => void) {
    const rpc = new Map<string, any>()
    const tools = new Map<string, any>()
    const contexts: Array<(event: any) => Promise<void> | void> = []
    let evaluate: (event: any) => Promise<void>
    const registration = { async dispose() {} }
    const cleanup = await plugin.setup({
      location: { directory: project, project: { directory: project } },
      model: { async list() { return { data: [] } } },
      mcp: { async list() { return { data: servers.map((name) => ({ name })) } } },
      agent: { async transform() { return registration }, async reload() {} },
      tool: {
        async transform(fn: any) { fn({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }); return registration },
        async hook() { return registration },
      },
      session: {
        async get({ sessionID }: any) { return structuredClone(sessions[sessionID] ?? { id: sessionID, permissions: [] }) },
        async hook(name: string, fn: any) { if (name === "context") contexts.push(fn); return registration },
      },
      permission: {
        async rules({ sessionID, permissions }: { sessionID: string; permissions: readonly PermissionRule[] }) {
          beforeWrite?.(sessionID)
          sessions[sessionID] = { ...(sessions[sessionID] ?? { id: sessionID }), permissions: structuredClone([...permissions]) }
        },
        async hook(_name: string, fn: any) { evaluate = fn; return registration },
      },
      rpc: { async register(def: any, handlers: any) { rpc.set(def.id, handlers); return registration } },
      event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      })() },
    } as never)
    cleanups.push(async () => { await cleanup?.() })
    return {
      rpc, tools, cleanup,
      async context(sessionID: string, agent = "back-fast") {
        for (const context of contexts) await context({ sessionID, agent, tools: {}, system: [] })
      },
      async check(agent: string, action: string, resource: string, sessionID = "root") {
        const native = evaluateEffect([...buildAgentPermissions(config.agents[agent]!, servers, agent),
          ...(sessions[sessionID]?.permissions ?? [])], action, resource).effect
        const event = { agent, sessionID, action, resources: [resource], effect: native === "unknown" ? "ask" : native }
        // Match the host boundary: a configured deny never reaches the hook.
        if (event.effect !== "deny") await evaluate(event)
        return event.effect
      },
    }
  }
  return { host, sessions }
}

describe("runtime policy boundaries", () => {
  test("locations share file conflicts, claims and ownership across disposal", async () => {
    const { host } = fixture()
    const a = await host()
    const b = await host()
    const input = { operation: "reserve", agent: "back-fast", label: "change", files: ["same.ts"] }
    const context = { agent: "master", sessionID: "root" }
    const lease = await a.tools.get("lease").execute(input, context)
    await expect(b.tools.get("lease").execute(input, context)).rejects.toThrow("reserved")
    await b.tools.get("claim").execute({ leaseId: lease.output.leaseId }, { agent: "back-fast", sessionID: "child" })
    await a.cleanup?.()
    expect(await b.check("back-fast", "edit", "same.ts", "child")).not.toBe("deny")
    expect(await b.check("back-fast", "edit", "outside.ts", "child")).toBe("deny")
  })

  test("readonly mutations deny while targeted verification remains available", async () => {
    const { host } = fixture()
    const a = await host()
    for (const resource of ["find . -delete", "eslint --fix src/a.ts", "sort src/a.ts -o src/a.ts"]) {
      expect(await a.check("security", "shell", resource)).toBe("deny")
    }
    expect(await a.check("back-fast", "shell", "bun test src/core/config.test.ts", "child")).toBe("allow")
    expect(await a.check("back-fast", "shell", "eslint --fix src/a.ts", "child")).toBe("ask")
  })

  test("native skill/MCP overrides reopen denies and never leak into children", async () => {
    const { host, sessions } = fixture()
    const a = await host()
    expect(await a.check("master", "skill", "opencode")).toBe("deny")
    expect(await a.check("master", "context7_query", "*")).toBe("deny")
    await a.rpc.get("gvozd-mode").setOverrides({ sessionID: "root", overrides: { skill: "allow", mcp: "allow" } })
    expect(await a.check("master", "skill", "opencode")).toBe("allow")
    expect(await a.check("master", "context7_query", "*")).toBe("allow")
    sessions.child!.permissions = structuredClone(sessions.root!.permissions)
    await a.context("child")
    expect(await a.check("back-fast", "skill", "opencode", "child")).toBe("deny")
    await a.rpc.get("gvozd-mode").setOverrides({ sessionID: "root", overrides: {} })
    expect(await a.check("master", "skill", "opencode")).toBe("deny")
  })

  test("family allow removes the native deny already inherited by known children", async () => {
    const { host, sessions } = fixture()
    const a = await host()
    await a.rpc.get("gvozd-mode").setOverrides({ sessionID: "root", overrides: { shell: "deny" } })
    sessions.child!.permissions = structuredClone(sessions.root!.permissions)
    await a.context("child")
    expect(await a.check("back-fast", "shell", "bun test", "child")).toBe("deny")
    const b = await host()
    await b.rpc.get("gvozd-mode").setOverrides({ sessionID: "root", overrides: { shell: "allow" } })
    expect(await a.check("back-fast", "shell", "bun test", "child")).toBe("allow")
    expect(await a.check("back-fast", "shell", "git reset --hard", "child")).toBe("deny")
  })

  test.each([
    ["deny", "allow"],
    ["allow", "inherit"],
  ] as const)("same-value retry repairs failed known-child propagation from %s to %s before context", async (initial, next) => {
    const { host, sessions } = fixture()
    const userRule: PermissionRule = { action: "read", resource: "docs/**", effect: "allow" }
    const foreignRule: PermissionRule = { action: "read", resource: "private/**", effect: "deny" }
    sessions.root!.permissions = [userRule]
    sessions.child!.permissions = [userRule, foreignRule]
    const observer = await host()
    await observer.context("child")
    await observer.rpc.get("gvozd-mode").setOverrides({ sessionID: "root", overrides: { shell: initial } })
    let failChild = true
    const writer = await host((sessionID) => {
      if (sessionID === "child" && failChild) throw new Error("child write refused")
    })
    const request = { sessionID: "root", overrides: { shell: next } }
    await expect(writer.rpc.get("gvozd-mode").setOverrides(request)).rejects.toThrow("child write refused")
    const nativeShell = (sessionID: string) => evaluateEffect(sessions[sessionID]!.permissions, "shell", "custom-check").effect
    expect(nativeShell("root")).toBe(next === "inherit" ? "unknown" : "allow")
    expect(nativeShell("child")).toBe(initial)
    failChild = false
    await writer.rpc.get("gvozd-mode").setOverrides(request)
    // No context or evaluate hook may mask a stale native grant/restriction.
    expect(nativeShell("child")).toBe(next === "inherit" ? "unknown" : "allow")
    if (next === "inherit") expect(sessions.child!.permissions).toEqual([userRule, foreignRule])
    else expect(sessions.child!.permissions.slice(0, 2)).toEqual([userRule, foreignRule])
    expect(await observer.check("back-fast", "shell", "custom-check", "child")).toBe(next === "inherit" ? "ask" : "allow")
  })

  test("unknown children retain native denies until context reconciles them, without enumeration", async () => {
    const { host, sessions } = fixture()
    const a = await host()
    await a.rpc.get("gvozd-mode").setOverrides({ sessionID: "root", overrides: { shell: "deny" } })
    sessions.child!.permissions = structuredClone(sessions.root!.permissions)
    const foreignRule: PermissionRule = { action: "read", resource: "private/**", effect: "deny" }
    sessions.child!.permissions.push(foreignRule)
    await a.rpc.get("gvozd-mode").setOverrides({ sessionID: "root", overrides: { shell: "allow" } })
    // No session.list exists. A native deny skips evaluation, so the plugin
    // cannot discover this child through that request or rewrite it eagerly.
    expect(await a.check("back-fast", "shell", "bun test", "child")).toBe("deny")
    await a.context("child")
    expect(await a.check("back-fast", "shell", "bun test", "child")).toBe("allow")
    expect(await a.check("back-fast", "shell", "git reset --hard", "child")).toBe("deny")
    expect(sessions.child!.permissions.at(-1)).toEqual(foreignRule)
  })

  test("exact grants hydrate on reload, preserve foreign rules and stay out of siblings and roots", async () => {
    const { host, sessions } = fixture()
    const foreignRule: PermissionRule = { action: "read", resource: "private/**", effect: "deny" }
    sessions.child!.permissions = [foreignRule]
    sessions.sibling = { id: "sibling", parentID: "root", permissions: [] }
    const a = await host()
    await a.rpc.get("gvozd-mode").setOverrides({ sessionID: "child", overrides: { skill: "allow", mcp: "allow" } })
    expect(await a.check("master", "skill", "opencode", "child")).toBe("allow")
    expect(await a.check("master", "context7_query", "*", "child")).toBe("allow")
    await a.cleanup?.()
    const b = await host()
    expect(await b.rpc.get("gvozd-mode").get({ sessionID: "child" })).toEqual({
      mode: "balanced", overrides: { skill: "allow", mcp: "allow" },
    })
    for (const sessionID of ["root", "sibling"]) {
      expect(await b.check("master", "skill", "opencode", sessionID)).toBe("deny")
      expect(await b.check("master", "context7_query", "*", sessionID)).toBe("deny")
    }
    await b.rpc.get("gvozd-mode").setOverrides({ sessionID: "child", overrides: {} })
    expect(sessions.child!.permissions).toEqual([foreignRule])
    expect(await b.check("master", "skill", "opencode", "child")).toBe("deny")
  })

  test("goal stop revokes grants in every already-loaded location", async () => {
    const { host } = fixture()
    const a = await host()
    const b = await host()
    await a.rpc.get("gvozd-goal").start({ sessionID: "root", goalId: "g" })
    expect(await b.check("planner", "shell", "custom-check")).toBe("allow")
    await a.rpc.get("gvozd-goal").stop({ sessionID: "root" })
    expect(await b.check("planner", "shell", "custom-check")).toBe("ask")
    expect((await b.rpc.get("gvozd-goal").status({ sessionID: "child" })).active).toBe(false)
  })

  test("goal recording cannot start or relabel goals and enforces budget", async () => {
    const { host } = fixture()
    const a = await host()
    const goal = a.rpc.get("gvozd-goal")
    const result = { sessionID: "root", goalId: "g", after: 100, verifyOk: true }
    await expect(goal.record(result)).rejects.toThrow("current active goal")
    await goal.start({ sessionID: "root", goalId: "g" })
    await expect(goal.record({ ...result, goalId: "old" })).rejects.toThrow("current active goal")
    const stopped = await goal.record({ ...result, cost: 100 })
    expect(stopped).toMatchObject({ active: false, stopReason: "budget" })
    await expect(goal.record(result)).rejects.toThrow("current active goal")
    expect(await a.check("planner", "shell", "custom-check")).toBe("ask")
  })

  test("coordinator tool records rounds in its own family and exposes rollback", async () => {
    const { host } = fixture()
    const a = await host()
    const tool = a.tools.get("goal")
    const context = { sessionID: "child", agent: "extreme" }
    await expect(tool.execute({ operation: "status" }, { ...context, agent: "back-fast" }))
      .rejects.toThrow("Only goal coordinators")
    await a.rpc.get("gvozd-goal").start({ sessionID: "root", goalId: "metric", measureCmd: "measure", verifyCmd: "verify",
      metric: { baseline: 100, direction: "lower", threshold: 50, epsilon: 0.1 } })
    const first = await tool.execute({ operation: "record", goalId: "metric", after: 120, verifyOk: true }, context)
    expect(first.output).toMatchObject({ active: true, pendingRetry: true, needsRollback: false })
    const second = await tool.execute({ operation: "record", goalId: "metric", after: 120, verifyOk: true }, context)
    expect(second.output).toMatchObject({ active: false, stopReason: "degraded-after-retry", needsRollback: true })
    expect((await tool.execute({ operation: "status" }, context)).output.metric).toMatchObject({ baseline: 100, threshold: 50 })
  })

  test("reloaded goals retain consumed budgets and native exact overrides", async () => {
    const { host } = fixture()
    const a = await host()
    await a.rpc.get("gvozd-goal").start({ sessionID: "root", goalId: "g" })
    await a.rpc.get("gvozd-goal").record({ sessionID: "root", goalId: "g", after: 100, verifyOk: true, cost: 60 })
    await a.rpc.get("gvozd-mode").setOverrides({ sessionID: "root", overrides: { skill: "allow" } })
    await a.cleanup?.()
    const b = await host()
    expect(await b.check("master", "skill", "opencode")).toBe("allow")
    const result = await b.rpc.get("gvozd-goal").record({ sessionID: "root", goalId: "g", after: 90, verifyOk: true, cost: 40 })
    expect(result).toMatchObject({ active: false, stopReason: "budget", rounds: { iterations: 2 } })
  })

  test("dry run includes the same protected rules as agent generation", async () => {
    const { host } = fixture()
    const a = await host()
    const output = await a.rpc.get("gvozd-permissions").evaluate({ agent: "master", checks: [
      { action: "shell", resources: ["git reset --hard"] },
    ] })
    expect(output.results[0].effect).toBe("deny")
  })
})

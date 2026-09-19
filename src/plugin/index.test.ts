import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, type ResolvedConfig } from "../core/config"
import { configHolderOf } from "../core/config-holder"
import { enforceFileLeasePermission } from "./file-lease-plugin"
import { DEFAULT_ACTIVE_TTL_MS, DEFAULT_RESERVATION_TTL_MS, FileLeaseManager, GVOZD_CASE_INSENSITIVE_FILESYSTEM } from "../core/file-leases"
import agentGvozd, { applyAgentConfiguration } from "./index"
import type { ConfigGetOutput } from "../rpc/config-rpc"
import { computeProjectTrustToken } from "../core/project-trust"
import { GIT_FORBIDDEN_PREFIXES } from "../core/tool-permissions"
import { resolveJevConfig } from "../core/jev"

/** The protected Git deny set appended to every agent by buildAgentPermissions. */
const GIT_FORBIDDEN_RULES = GIT_FORBIDDEN_PREFIXES.map((prefix) => ({
  action: "shell",
  resource: `${prefix}*`,
  effect: "deny",
}))

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): ResolvedConfig {
  const root = mkdtempSync(join(tmpdir(), "gvozd-index-"))
  roots.push(root)
  const prompt = join(root, "prompt.md")
  writeFileSync(prompt, "Configured prompt\n")
  const agent = (fileLease: "coordinator" | "writer") => ({
    description: "configured",
    mode: fileLease === "coordinator" ? "primary" as const : "subagent" as const,
    models: ["openai/deep"],
    prompt,
    promptContent: "Configured prompt\n",
    skills: [],
    mcp: [],
    permissions: [],
    fileLease,
    disabled: false,
  })
  return {
    jev: resolveJevConfig(undefined),
    lease: { reservationTtlMs: DEFAULT_RESERVATION_TTL_MS, activeTtlMs: DEFAULT_ACTIVE_TTL_MS, shellEscalation: "ask" },
    defaultAgent: "master",
    agents: { master: agent("coordinator"), "back-fast": agent("writer") },
    packageRoot: root,
    projectRoot: root,
    projectConfigDirectory: join(root, "docs", ".gvozd"),
    globalConfigDirectory: join(root, "global", "gvozd"),
    sources: [],
  }
}

describe("global agent activation", () => {
  test("updates discovered global definitions without project-local files", () => {
    const config = fixture()
    config.agents.master!.skills = ["project-skill"]
    config.agents.master!.mcp = ["project-mcp"]
    config.agents.master!.permissions = [{ action: "read", resource: "project/*", effect: "allow" }]
    const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
    let defaultAgent: string | undefined
    const editor = {
      get: (id: string) => values.get(id),
      update: (id: string, update: (agent: any) => void) => update(values.get(id)),
      remove: (id: string) => values.delete(id),
      default: (id: string) => { defaultAgent = id },
    }
    const models = [{ enabled: true, providerID: "openai", id: "deep", variants: [] }] as never
    expect(() => applyAgentConfiguration(editor as never, configHolderOf(config), models, ["project-mcp", "other"])).not.toThrow()
    expect(values.get("master")).toMatchObject({ description: "configured", system: "Configured prompt", model: { providerID: "openai", id: "deep" } })
    const expectedPermissions = [
      { action: "read", resource: "project/*", effect: "allow" },
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "project-skill", effect: "allow" },
      { action: "project-mcp_*", resource: "*", effect: "allow" },
      { action: "other_*", resource: "*", effect: "deny" },
      ...GIT_FORBIDDEN_RULES,
    ]
    expect(values.get("master").permissions).toEqual(expectedPermissions)
    applyAgentConfiguration(editor as never, configHolderOf(config), models, ["project-mcp", "other"])
    expect(values.get("master").permissions).toEqual(expectedPermissions)
    expect(defaultAgent).toBe("master")
    expect(values.has("back-fast")).toBe(false)
  })

  test("replaces stale generated permissions when project arrays change", () => {
    const config = fixture()
    config.agents.master!.skills = []
    config.agents.master!.mcp = []
    config.agents.master!.permissions = [{ action: "edit", resource: "leased.ts", effect: "ask" }]
    const values = new Map<string, any>([["master", {
      description: "old",
      mode: "primary",
      permissions: [
        { action: "skill", resource: "removed-skill", effect: "allow" },
        { action: "removed_mcp_*", resource: "*", effect: "allow" },
      ],
    }]])
    const editor = {
      get: (id: string) => values.get(id),
      update: (id: string, update: (agent: any) => void) => update(values.get(id)),
      remove: (id: string) => values.delete(id),
      default() {},
    }

    applyAgentConfiguration(editor as never, configHolderOf(config), [] as never, ["removed-mcp"])
    expect(values.get("master").permissions).toEqual([
      { action: "edit", resource: "leased.ts", effect: "ask" },
      { action: "skill", resource: "*", effect: "deny" },
      { action: "removed-mcp_*", resource: "*", effect: "deny" },
      ...GIT_FORBIDDEN_RULES,
    ])
  })

  test("repeated transforms keep reviewed trusted-project prompt bytes after the source changes", () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-index-prompt-snapshot-"))
    roots.push(root)
    mkdirSync(join(root, ".git"))
    const projectConfig = join(root, "docs", ".gvozd")
    mkdirSync(projectConfig, { recursive: true })
    const prompt = join(projectConfig, "master.md")
    writeFileSync(prompt, "Reviewed project prompt\n")
    writeFileSync(join(projectConfig, "config.jsonc"), JSON.stringify({ agents: { master: { prompt: "master.md" } } }))
    const config = loadConfig(root, {
      configRoot: join(root, "global"),
      projectTrustToken: computeProjectTrustToken(root),
    })
    writeFileSync(prompt, "Unreviewed replacement\n")

    const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
    const editor = {
      get: (id: string) => values.get(id),
      update: (id: string, update: (agent: any) => void) => update(values.get(id)),
      remove: (id: string) => values.delete(id),
      default() {},
    }
    applyAgentConfiguration(editor as never, configHolderOf(config), [] as never, [])
    applyAgentConfiguration(editor as never, configHolderOf(config), [] as never, [])
    expect(values.get("master").system).toBe("Reviewed project prompt")
  })

  test("fails closed when a manually constructed runtime config lacks a prompt snapshot", () => {
    const config = fixture()
    delete config.agents.master!.promptContent
    const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
    const editor = {
      get: (id: string) => values.get(id),
      update: (id: string, update: (agent: any) => void) => update(values.get(id)),
      remove: (id: string) => values.delete(id),
      default() {},
    }
    expect(() => applyAgentConfiguration(editor as never, configHolderOf(config), [] as never, [])).toThrow("immutable prompt snapshot")
  })

  test("missing writer definitions still retain fail-closed permission enforcement", () => {
    const config = fixture()
    const leases = new FileLeaseManager({ projectRoot: config.projectRoot })
    const event: { sessionID: string; agent: string; action: string; resources: string[]; effect: "allow" | "ask" | "deny"; message?: string } = {
      sessionID: "child", agent: "back-fast", action: "edit", resources: ["file.ts"], effect: "allow",
    }
    expect(enforceFileLeasePermission(event, configHolderOf(config), leases)).toBe(true)
    expect(event.effect).toBe("deny")
  })

  test("loads existing MCP servers before the first agent transform", async () => {
    const values = new Map<string, any>([
      ["master", { description: "old", mode: "primary", permissions: [] }],
      ["back-fast", { description: "old", mode: "subagent", permissions: [] }],
    ])
    const calls: string[] = []
    const disposable = { async dispose() {} }
    const cleanup = await agentGvozd.setup({
      location: { project: { directory: process.cwd() } },
      catalog: { model: { async list() { return { data: [] } } } },
      mcp: {
        async list() {
          calls.push("mcp.list")
          return { data: [{ name: "context7" }] }
        },
      },
      agent: {
        async transform(register: (editor: any) => void) {
          calls.push("agent.transform")
          register({
            get: (id: string) => values.get(id),
            update: (id: string, update: (agent: any) => void) => update(values.get(id)),
            remove: (id: string) => values.delete(id),
            default() {},
          })
          return disposable
        },
        async reload() {},
      },
      tool: {
        async transform(register: (editor: any) => void) {
          register({ namespace() {}, add() {} })
          return disposable
        },
        async hook() { return disposable },
      },
      session: {
        async hook() { return disposable },
      },
      permission: {
        async hook() { return disposable },
      },
      event: {
        subscribe: () => (async function* () {})(),
      },
    } as never)

    expect(calls).toEqual(["mcp.list", "agent.transform"])
    expect(values.get("back-fast").permissions).toContainEqual({
      action: "context7_*",
      resource: "*",
      effect: "allow",
    })
    expect(values.get("master").permissions).toContainEqual({
      action: "context7_*",
      resource: "*",
      effect: "deny",
    })
    if (cleanup) await cleanup()
  })

  test("reads the 2.0.4 flat model domain and applies configured models to agents", async () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-index-flat-model-"))
    roots.push(root)
    const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
    const disposable = { async dispose() {} }
    const cleanup = await agentGvozd.setup({
      location: { project: { directory: root } },
      // 2.0.4+: no ctx.catalog; top-level ctx.model.list returns the `{ data }`
      // envelope. The defaults configure gpt-5.6-sol first, so selecting luna
      // proves the flat list was consulted instead of the configured fallback.
      model: { async list() { return { data: [{ enabled: true, providerID: "openai", id: "gpt-5.6-luna", variants: [] }] } } },
      mcp: { async list() { return { data: [] } } },
      agent: {
        async transform(register: (editor: any) => void) {
          register({
            get: (id: string) => values.get(id),
            update: (id: string, update: (agent: any) => void) => update(values.get(id)),
            remove: (id: string) => values.delete(id),
            default() {},
          })
          return disposable
        },
        async reload() {},
      },
      tool: { async transform() { return disposable }, async hook() { return disposable } },
      session: { async hook() { return disposable } },
      permission: { async hook() { return disposable } },
      event: { subscribe: () => (async function* () {})() },
    } as never)
    if (cleanup) await cleanup()
    expect(values.get("master").model).toEqual({ providerID: "openai", id: "gpt-5.6-luna" })
  })

  test("refreshes models on the 2.0.4 split catalog events", async () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-index-split-events-"))
    roots.push(root)
    const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
    const disposable = { async dispose() {} }
    const available: Array<{ enabled: boolean; providerID: string; id: string; variants: never[] }> = []
    let reloads = 0
    let transform: ((editor: any) => void) | undefined
    let release: (() => void) | undefined
    const refreshed = new Promise<void>((resolve) => { release = resolve })
    const editor = {
      get: (id: string) => values.get(id),
      update: (id: string, update: (agent: any) => void) => update(values.get(id)),
      remove: (id: string) => values.delete(id),
      default() {},
    }
    const cleanup = await agentGvozd.setup({
      location: { project: { directory: root } },
      model: {
        async list() {
          // The event handler re-reads after the test mutates the inventory.
          return { data: [...available] }
        },
      },
      mcp: { async list() { return { data: [] } } },
      agent: {
        async transform(register: (editor: any) => void) {
          transform = register
          register(editor)
          return disposable
        },
        // The real host re-runs transforms after a reload request.
        async reload() {
          reloads += 1
          transform?.(editor)
          if (reloads >= 2) release?.()
        },
      },
      tool: { async transform() { return disposable }, async hook() { return disposable } },
      session: { async hook() { return disposable } },
      permission: { async hook() { return disposable } },
      event: {
        subscribe: () =>
          (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 10))
            yield { type: "model.updated" }
            yield { type: "provider.updated" }
          })(),
      },
    } as never)
    try {
      available.push({ enabled: true, providerID: "openai", id: "gpt-5.6-luna", variants: [] })
      await Promise.race([refreshed, new Promise((resolve) => setTimeout(resolve, 2_000))])
      expect(reloads).toBe(2)
      expect(values.get("master").model).toEqual({ providerID: "openai", id: "gpt-5.6-luna" })
    } finally {
      await (cleanup as () => Promise<void>)()
    }
  })

  test("falls back to configured model refs when the host has no catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-index-no-catalog-"))
    roots.push(root)
    const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
    const disposable = { async dispose() {} }
    const diagnostics: string[] = []
    const originalError = console.error
    console.error = (message: string) => diagnostics.push(message)
    let cleanup: Awaited<ReturnType<typeof agentGvozd.setup>>
    try {
      cleanup = await agentGvozd.setup({
        location: { project: { directory: root } },
        mcp: { async list() { return { data: [] } } },
        agent: {
          async transform(register: (editor: any) => void) {
            register({
              get: (id: string) => values.get(id),
              update: (id: string, update: (agent: any) => void) => update(values.get(id)),
              remove: (id: string) => values.delete(id),
              default() {},
            })
            return disposable
          },
          async reload() {},
        },
        tool: { async transform() { return disposable }, async hook() { return disposable } },
        session: { async hook() { return disposable } },
        permission: { async hook() { return disposable } },
        event: { subscribe: () => (async function* () {})() },
      } as never)
      await (cleanup as () => Promise<void>)()
      expect(values.get("master").model).toEqual({ providerID: "openai", id: "gpt-5.6-sol" })
    } finally {
      console.error = originalError
    }
    expect(diagnostics.some((message) => message.includes("no model catalog"))).toBe(true)
  })

  test("warns about an out-of-range host version instead of failing setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-index-version-"))
    roots.push(root)
    const disposable = { async dispose() {} }
    const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
    const diagnostics: string[] = []
    const originalError = console.error
    console.error = (message: string) => diagnostics.push(message)
    const setup = (app: { version: string }) => agentGvozd.setup({
      app,
      location: { project: { directory: root } },
      model: { async list() { return { data: [] } } },
      mcp: { async list() { return { data: [] } } },
      agent: {
        async transform(register: (editor: any) => void) {
          register({
            get: (id: string) => values.get(id),
            update: (id: string, update: (agent: any) => void) => update(values.get(id)),
            remove: (id: string) => values.delete(id),
            default() {},
          })
          return disposable
        },
        async reload() {},
      },
      tool: { async transform() { return disposable }, async hook() { return disposable } },
      session: { async hook() { return disposable } },
      permission: { async hook() { return disposable } },
      event: { subscribe: () => (async function* () {})() },
    } as never)
    try {
      // An in-range host stays silent; an out-of-range one only warns, so the
      // plugin still finishes setup and applies agents in both cases.
      const supported = await setup({ version: "2.0.4" })
      await (supported as () => Promise<void>)()
      const unsupported = await setup({ version: "2.1.0" })
      await (unsupported as () => Promise<void>)()
      expect(values.get("master").model).toEqual({ providerID: "openai", id: "gpt-5.6-sol" })
    } finally {
      console.error = originalError
    }
    expect(diagnostics.filter((message) => message.includes("outside the supported")).length).toBe(1)
  })

  test("rejects an invalid filesystem case override before runtime setup", async () => {
    const previous = process.env[GVOZD_CASE_INSENSITIVE_FILESYSTEM]
    process.env[GVOZD_CASE_INSENSITIVE_FILESYSTEM] = "true"
    try {
      await expect(agentGvozd.setup({} as never)).rejects.toThrow(
        `${GVOZD_CASE_INSENSITIVE_FILESYSTEM} must be exactly 1 or 0`,
      )
    } finally {
      if (previous === undefined) delete process.env[GVOZD_CASE_INSENSITIVE_FILESYSTEM]
      else process.env[GVOZD_CASE_INSENSITIVE_FILESYSTEM] = previous
    }
  })

  test("uses the explicit process environment opt-in for runtime project capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "gvozd-index-trust-"))
    roots.push(root)
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, "docs", ".gvozd"), { recursive: true })
    writeFileSync(join(root, "docs", ".gvozd", "config.jsonc"), JSON.stringify({
      agents: { master: { skills: ["trusted-runtime-skill"] } },
    }))
    const previousTrust = process.env.GVOZD_TRUST_PROJECT_CONFIG
    const previousRoot = process.env.GVOZD_OPENCODE_CONFIG_ROOT
    process.env.GVOZD_TRUST_PROJECT_CONFIG = computeProjectTrustToken(root)
    process.env.GVOZD_OPENCODE_CONFIG_ROOT = join(root, "global")
    let cleanup: Awaited<ReturnType<typeof agentGvozd.setup>> = undefined
    try {
      const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
      const disposable = { async dispose() {} }
      cleanup = await agentGvozd.setup({
        location: { project: { directory: root } },
        catalog: { model: { async list() { return { data: [] } } } },
        mcp: { async list() { return { data: [] } } },
        agent: {
          async transform(register: (editor: any) => void) {
            register({
              get: (id: string) => values.get(id),
              update: (id: string, update: (agent: any) => void) => update(values.get(id)),
              remove: (id: string) => values.delete(id),
              default() {},
            })
            return disposable
          },
          async reload() {},
        },
        tool: { async transform() { return disposable }, async hook() { return disposable } },
        session: { async hook() { return disposable } },
        permission: { async hook() { return disposable } },
        event: { subscribe: () => (async function* () {})() },
      } as never)
      expect(values.get("master").permissions).toContainEqual({
        action: "skill",
        resource: "trusted-runtime-skill",
        effect: "allow",
      })
    } finally {
      if (cleanup) await cleanup()
      if (previousTrust === undefined) delete process.env.GVOZD_TRUST_PROJECT_CONFIG
      else process.env.GVOZD_TRUST_PROJECT_CONFIG = previousTrust
      if (previousRoot === undefined) delete process.env.GVOZD_OPENCODE_CONFIG_ROOT
      else process.env.GVOZD_OPENCODE_CONFIG_ROOT = previousRoot
    }
  })
})

test("registers the leases RPC and maps the manager snapshot", async () => {
  const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
  const disposable = { async dispose() {} }
  const registered: Array<{ id: string; handlers: Record<string, (input: unknown) => Promise<unknown>> }> = []
  let legacyRuleWrites = 0
  const cleanup = await agentGvozd.setup({
    location: { project: { directory: process.cwd() } },
    catalog: { model: { async list() { return { data: [] } } } },
    mcp: { async list() { return { data: [] } } },
    rpc: {
      async register(definition: { id: string }, handlers: Record<string, (input: unknown) => Promise<unknown>>) {
        registered.push({ id: definition.id, handlers })
        return disposable
      },
    },
    agent: {
      async transform(register: (editor: any) => void) {
        register({ get: (id: string) => values.get(id), update: (id: string, update: (agent: any) => void) => update(values.get(id)), remove: (id: string) => values.delete(id), default() {} })
        return disposable
      },
      async reload() {},
    },
    tool: {
      async transform(register: (editor: any) => void) {
        register({ namespace() {}, add() {} })
        return disposable
      },
      async hook() { return disposable },
    },
    session: { async hook() { return disposable } },
    permission: {
      async hook() { return disposable },
      async rules() { legacyRuleWrites++ },
    },
    event: { subscribe: () => (async function* () {})() },
  } as never)
  try {
    expect(registered.map((entry) => entry.id)).toEqual([
      "gvozd-mode",
      "gvozd-leases",
      "gvozd-permissions",
      "gvozd-roster",
      "gvozd-config",
    ])
    const configGet = registered.find((entry) => entry.id === "gvozd-config")!.handlers.get!
    const configOutput = await configGet({}) as ConfigGetOutput
    expect(configOutput.lease.shellEscalation).toBe("ask")
    expect(configOutput.agents.map((agent) => agent.id)).toContain("master")
    const leasesHandler = registered.find((entry) => entry.id === "gvozd-leases")!.handlers.list!
    const output = await leasesHandler({}) as { leases: Array<{ agent: string; state: string; files: string[] }> }
    expect(output.leases).toEqual([])
    const setMode = registered.find((entry) => entry.id === "gvozd-mode")!.handlers.set!
    const modeOutput = await setMode({ sessionID: "ses-x", mode: "trusted" }) as { mode: string }
    expect(modeOutput.mode).toBe("trusted")
    await registered.find((entry) => entry.id === "gvozd-mode")!.handlers.setOverrides!({
      sessionID: "ses-x",
      overrides: { edit: "allow" },
    })
    // Legacy permission.rules replaces the whole rule list and cannot merge
    // safely, so 2.0.2-2.0.3 stay on the runtime-hook fallback.
    expect(legacyRuleWrites).toBe(0)
  } finally {
    await (cleanup as () => Promise<void>)()
  }
})

test("applies session permission overrides through the evaluate hook", async () => {
  const disposable = { async dispose() {} }
  const registered: Array<{ id: string; handlers: Record<string, (input: unknown) => Promise<unknown>> }> = []
  let evaluateHook: ((event: any) => Promise<void>) | undefined
  const sessionContextHooks: Array<(event: any) => Promise<void> | void> = []
  let sessionLookupAvailable = true
  const sessions: Record<string, { id: string; parentID?: string }> = {
    "ses-override": { id: "ses-override" },
    "ses-child": { id: "ses-child", parentID: "ses-override" },
    "ses-grandchild": { id: "ses-grandchild", parentID: "ses-child" },
    "ses-other": { id: "ses-other" },
  }
  const cleanup = await agentGvozd.setup({
    location: { project: { directory: process.cwd() } },
    catalog: { model: { async list() { return { data: [] } } } },
    mcp: { async list() { return { data: [] } } },
    rpc: {
      async register(definition: { id: string }, handlers: Record<string, (input: unknown) => Promise<unknown>>) {
        registered.push({ id: definition.id, handlers })
        return disposable
      },
    },
    agent: {
      async transform() { return disposable },
      async reload() {},
    },
    tool: { async transform() { return disposable }, async hook() { return disposable } },
    session: {
      async hook(name: string, handler: (event: any) => Promise<void> | void) {
        if (name === "context") sessionContextHooks.push(handler)
        return disposable
      },
      async get({ sessionID }: { sessionID: string }) {
        if (!sessionLookupAvailable) throw new Error("session lookup unavailable during permission evaluation")
        return sessions[sessionID] ?? { id: sessionID }
      },
    },
    permission: {
      async hook(_name: string, handler: (event: any) => Promise<void>) {
        evaluateHook = handler
        return disposable
      },
    },
    event: { subscribe: () => (async function* () {})() },
  } as never)
  try {
    const modeHandlers = registered.find((entry) => entry.id === "gvozd-mode")!.handlers
    const sessionID = "ses-override"
    const setOverrides = modeHandlers.setOverrides!
    const stored = await setOverrides({ sessionID, overrides: { shell: "deny", skill: "allow" } }) as {
      overrides: Record<string, string>
    }
    expect(stored.overrides).toEqual({ shell: "deny", skill: "allow" })

    const evaluate = evaluateHook!
    // shell=deny override blocks an otherwise-allowed command.
    const shellEvent = { sessionID, agent: "master", action: "shell", resources: ["bun test"], effect: "allow" }
    await evaluate(shellEvent)
    expect(shellEvent.effect).toBe("deny")

    // skill=allow override re-opens a skill the agent policy denies.
    const skillEvent = { sessionID, agent: "master", action: "skill", resources: ["some-skill"], effect: "deny" }
    await evaluate(skillEvent)
    expect(skillEvent.effect).toBe("allow")

    // File-lease protection outranks overrides: a coordinator without an
    // active lease is denied regardless of a session "allow" for edits.
    await setOverrides({ sessionID, overrides: { edit: "allow" } })
    const leased = { sessionID, agent: "master", action: "edit", resources: ["src/a.ts"], effect: "allow" }
    await evaluate(leased)
    expect(leased.effect).toBe("deny")

    // A destructive command stays denied even under a permissive override.
    await setOverrides({ sessionID, overrides: { shell: "allow" } })
    // The child context resolves and caches its family before tool use. The
    // permission hook must then keep working even if session.get is not
    // re-entrant while OpenCode evaluates that first tool permission.
    for (const hook of sessionContextHooks) {
      await hook({ sessionID: "ses-grandchild", agent: "back-fast", tools: {}, system: [] })
    }
    sessionLookupAvailable = false
    const ordinary = { sessionID, agent: "master", action: "shell", resources: ["bun test"], effect: "ask" }
    await evaluate(ordinary)
    expect(ordinary.effect).toBe("allow")

    // A root shell grant covers nested subagent sessions and bypasses the
    // writer lease shell prompt that would otherwise ask for `printf`.
    const child = { sessionID: "ses-grandchild", agent: "back-fast", action: "shell", resources: ["printf test"], effect: "ask" }
    await evaluate(child)
    expect(child.effect).toBe("allow")
    const childState = await modeHandlers.get!({ sessionID: "ses-child" }) as { overrides: Record<string, string> }
    expect(childState.overrides.shell).toBe("allow")

    await modeHandlers.set!({ sessionID, mode: "trusted" })
    const childMode = await modeHandlers.get!({ sessionID: "ses-grandchild" }) as { mode: string }
    expect(childMode.mode).toBe("trusted")

    const destructive = { sessionID: "ses-child", agent: "back-fast", action: "shell", resources: ["git push --force origin main"], effect: "allow" }
    await evaluate(destructive)
    expect(destructive.effect).toBe("deny")

    // Another session is unaffected by this session's overrides.
    const other = { sessionID: "ses-other", agent: "master", action: "shell", resources: ["bun test"], effect: "ask" }
    await evaluate(other)
    expect(other.effect).toBe("ask")

    // Returning a category to inherit removes the override entirely.
    const cleared = await setOverrides({ sessionID: "ses-child", overrides: { shell: "inherit" } }) as { overrides: Record<string, string> }
    expect(cleared.overrides).toEqual({})
    const readBack = await modeHandlers.get!({ sessionID }) as { overrides: Record<string, string> }
    expect(readBack.overrides).toEqual({})
  } finally {
    await (cleanup as () => Promise<void>)()
  }
})

type NativeRule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
type NativeSession = { id: string; parentID?: string; permissions?: NativeRule[] }

async function setupNativeModeHost(
  sessions: Record<string, NativeSession>,
  beforeUpdate?: (call: number) => Promise<void>,
  afterUpdate?: (call: number) => Promise<void>,
) {
  const disposable = { async dispose() {} }
  const registered = new Map<string, Record<string, (input: unknown) => Promise<unknown>>>()
  const updated: Array<{ sessionID: string; permissions: NativeRule[] }> = []
  let updateCalls = 0
  const cleanup = await agentGvozd.setup({
    location: { project: { directory: process.cwd() } },
    catalog: { model: { async list() { return { data: [] } } } },
    mcp: { async list() { return { data: [] } } },
    rpc: {
      async register(definition: { id: string }, handlers: Record<string, (input: unknown) => Promise<unknown>>) {
        registered.set(definition.id, handlers)
        return disposable
      },
    },
    agent: { async transform() { return disposable }, async reload() {} },
    tool: { async transform() { return disposable }, async hook() { return disposable } },
    session: {
      async hook() { return disposable },
      async get({ sessionID }: { sessionID: string }) {
        return sessions[sessionID] ?? { id: sessionID }
      },
      async update(input: { sessionID: string; permissions: NativeRule[] }) {
        updateCalls++
        await beforeUpdate?.(updateCalls)
        updated.push({ sessionID: input.sessionID, permissions: [...input.permissions] })
        sessions[input.sessionID] = {
          ...(sessions[input.sessionID] ?? { id: input.sessionID }),
          permissions: [...input.permissions],
        }
        await afterUpdate?.(updateCalls)
      },
    },
    permission: { async hook() { return disposable } },
    event: { subscribe: () => (async function* () {})() },
  } as never)
  return { cleanup: cleanup as () => Promise<void>, handlers: registered.get("gvozd-mode")!, updated }
}

test("persists and rehydrates family grants without reordering foreign rules", async () => {
  const userRule: NativeRule = { action: "read", resource: "docs/**", effect: "allow" }
  const foreignDeny: NativeRule = { action: "shell", resource: "printf secret*", effect: "deny" }
  const sessions: Record<string, NativeSession> = {
    "ses-root": { id: "ses-root", permissions: [userRule] },
    "ses-child": { id: "ses-child", parentID: "ses-root" },
  }
  let host = await setupNativeModeHost(sessions)
  try {
    let { handlers } = host
    await handlers.setOverrides!({ sessionID: "ses-child", overrides: { shell: "allow" } })

    expect(host.updated.at(-1)?.sessionID).toBe("ses-root")
    expect(sessions["ses-root"]!.permissions).toContainEqual(userRule)
    expect(sessions["ses-root"]!.permissions).toContainEqual({
      action: "shell",
      resource: "*",
      effect: "allow",
    })
    expect(sessions["ses-root"]!.permissions).toContainEqual({
      action: "bash",
      resource: "*",
      effect: "allow",
    })
    expect(sessions["ses-root"]!.permissions).toContainEqual({
      action: "shell",
      resource: "git push --force*",
      effect: "deny",
    })

    // OpenCode copies the parent's native permissions during child creation.
    sessions["ses-new-child"] = {
      id: "ses-new-child",
      parentID: "ses-root",
      permissions: [...sessions["ses-root"]!.permissions!],
    }
    expect(sessions["ses-new-child"]!.permissions).toContainEqual({
      action: "shell",
      resource: "*",
      effect: "allow",
    })
    expect(sessions["ses-new-child"]!.permissions).toContainEqual({
      action: "bash",
      resource: "*",
      effect: "allow",
    })

    // A foreign rule added after Gvozd's block must stay after it when the
    // block is replaced; last-match-wins keeps this narrower deny effective.
    sessions["ses-root"]!.permissions!.push(foreignDeny)
    await handlers.set!({ sessionID: "ses-child", mode: "trusted" })
    const trustedRules = sessions["ses-root"]!.permissions!
    expect(trustedRules).toContainEqual({
      action: "shell",
      resource: "*",
      effect: "allow",
    })
    expect(trustedRules).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    })
    expect(trustedRules.indexOf(foreignDeny)).toBeGreaterThan(
      trustedRules.findIndex((rule) => rule.action === "gvozd.session-policy" && rule.resource === "end"),
    )

    // A fresh plugin instance must reconstruct the persisted family state.
    await host.cleanup()
    host = await setupNativeModeHost(sessions)
    handlers = host.handlers
    const restored = await handlers.get!({ sessionID: "ses-child" }) as {
      mode: string
      overrides: Record<string, string>
    }
    expect(restored).toEqual({ mode: "trusted", overrides: { shell: "allow" } })

    // Clearing both settings removes only Gvozd's block.
    await handlers.setOverrides!({ sessionID: "ses-root", overrides: { shell: "inherit" } })
    await handlers.set!({ sessionID: "ses-root", mode: "balanced" })
    expect(sessions["ses-root"]!.permissions).toEqual([userRule, foreignDeny])
    expect(host.updated.every((entry) => entry.sessionID === "ses-root")).toBe(true)
  } finally {
    await host.cleanup()
  }
})

test("migrates an existing shell-only native policy block on first access", async () => {
  const sessions: Record<string, NativeSession> = {
    "ses-root": {
      id: "ses-root",
      permissions: [
        { action: "gvozd.session-policy", resource: "begin:trusted:allow", effect: "deny" },
        { action: "edit", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "allow" },
        { action: "gvozd.session-policy", resource: "end", effect: "deny" },
      ],
    },
  }
  const host = await setupNativeModeHost(sessions)
  try {
    const state = await host.handlers.get!({ sessionID: "ses-root" }) as {
      mode: string
      overrides: Record<string, string>
    }
    expect(state).toEqual({ mode: "trusted", overrides: { shell: "allow" } })
    expect(host.updated).toHaveLength(1)
    expect(sessions["ses-root"]!.permissions).toContainEqual({
      action: "bash",
      resource: "*",
      effect: "allow",
    })
    expect(sessions["ses-root"]!.permissions).toContainEqual({
      action: "bash",
      resource: "git push --force*",
      effect: "deny",
    })
  } finally {
    await host.cleanup()
  }
})

test("serializes concurrent native family policy updates", async () => {
  const sessions: Record<string, NativeSession> = {
    "ses-root": { id: "ses-root", permissions: [] },
  }
  let releaseFirst!: () => void
  let firstStarted!: () => void
  const started = new Promise<void>((resolve) => { firstStarted = resolve })
  const release = new Promise<void>((resolve) => { releaseFirst = resolve })
  const host = await setupNativeModeHost(sessions, async (call) => {
    if (call === 1) {
      firstStarted()
      await release
    }
  })
  try {
    const setMode = host.handlers.set!({ sessionID: "ses-root", mode: "trusted" })
    await started
    const setShell = host.handlers.setOverrides!({
      sessionID: "ses-root",
      overrides: { shell: "deny" },
    })
    releaseFirst()
    await Promise.all([setMode, setShell])

    const state = await host.handlers.get!({ sessionID: "ses-root" }) as {
      mode: string
      overrides: Record<string, string>
    }
    expect(state).toEqual({ mode: "trusted", overrides: { shell: "deny" } })
    const permissions = sessions["ses-root"]!.permissions!
    expect(permissions).toContainEqual({ action: "edit", resource: "*", effect: "allow" })
    expect(permissions).toContainEqual({ action: "shell", resource: "*", effect: "deny" })
    expect(permissions).toContainEqual({ action: "bash", resource: "*", effect: "deny" })
  } finally {
    await host.cleanup()
  }
})

test("reconciles local state when a native update commits before reporting failure", async () => {
  const sessions: Record<string, NativeSession> = {
    "ses-root": { id: "ses-root", permissions: [] },
  }
  const host = await setupNativeModeHost(sessions, undefined, async (call) => {
    if (call === 1) throw new Error("response lost after commit")
  })
  try {
    await expect(host.handlers.set!({ sessionID: "ses-root", mode: "trusted" })).rejects.toThrow(
      "response lost after commit",
    )
    const state = await host.handlers.get!({ sessionID: "ses-root" }) as { mode: string }
    expect(state.mode).toBe("trusted")
    expect(sessions["ses-root"]!.permissions).toContainEqual({
      action: "shell",
      resource: "*",
      effect: "allow",
    })
  } finally {
    await host.cleanup()
  }
})

test("applies the session posture to agents gvozd does not configure", async () => {
  const disposable = { async dispose() {} }
  const registered = new Map<string, Record<string, (input: unknown) => Promise<unknown>>>()
  let evaluateHook: ((event: any) => Promise<void>) | undefined
  const cleanup = await agentGvozd.setup({
    location: { project: { directory: process.cwd() } },
    catalog: { model: { async list() { return { data: [] } } } },
    mcp: { async list() { return { data: [] } } },
    rpc: {
      async register(definition: { id: string }, handlers: Record<string, (input: unknown) => Promise<unknown>>) {
        registered.set(definition.id, handlers)
        return disposable
      },
    },
    agent: { async transform() { return disposable }, async reload() {} },
    tool: { async transform() { return disposable }, async hook() { return disposable } },
    session: { async hook() { return disposable } },
    // No native session writer: the hook must still enforce the posture.
    permission: {
      async hook(_name: string, handler: (event: any) => Promise<void>) {
        evaluateHook = handler
        return disposable
      },
    },
    event: { subscribe: () => (async function* () {})() },
  } as never)
  try {
    const setMode = registered.get("gvozd-mode")!.set!
    const sessionID = "ses-builtin"
    await setMode({ sessionID, mode: "strict" })

    // `build` is not a gvozd agent, so no agent policy runs; the posture must
    // still turn a bare action into an ask instead of silently allowing it.
    const strictEvent = { sessionID, agent: "build", action: "shell", resources: ["some-tool --run"], effect: "allow" }
    await evaluateHook!(strictEvent)
    expect(strictEvent.effect).toBe("ask")

    // An agent-less shell event gets the posture too (some hosts omit the ID).
    const anonymousShell = { sessionID, action: "shell", resources: ["some-tool --run"], effect: "allow" }
    await evaluateHook!(anonymousShell)
    expect(anonymousShell.effect).toBe("ask")

    // An agent-less mutation is denied by the file-lease guard before any
    // posture is considered — a safety invariant no toggle can bypass.
    const anonymousEdit = { sessionID, action: "edit", resources: ["src/a.ts"], effect: "allow" }
    await evaluateHook!(anonymousEdit)
    expect(anonymousEdit.effect).toBe("deny")
  } finally {
    await (cleanup as () => Promise<void>)()
  }
})

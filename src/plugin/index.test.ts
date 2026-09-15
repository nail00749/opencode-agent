import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, type ResolvedConfig } from "../core/config"
import { enforceFileLeasePermission } from "./file-lease-plugin"
import { DEFAULT_ACTIVE_TTL_MS, DEFAULT_RESERVATION_TTL_MS, FileLeaseManager, GVOZD_CASE_INSENSITIVE_FILESYSTEM } from "../core/file-leases"
import agentGvozd, { applyAgentConfiguration } from "./index"
import { computeProjectTrustToken } from "../core/project-trust"

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
    lease: { reservationTtlMs: DEFAULT_RESERVATION_TTL_MS, activeTtlMs: DEFAULT_ACTIVE_TTL_MS },
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
    expect(() => applyAgentConfiguration(editor as never, config, models, ["project-mcp", "other"])).not.toThrow()
    expect(values.get("master")).toMatchObject({ description: "configured", system: "Configured prompt", model: { providerID: "openai", id: "deep" } })
    const expectedPermissions = [
      { action: "read", resource: "project/*", effect: "allow" },
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "project-skill", effect: "allow" },
      { action: "project-mcp_*", resource: "*", effect: "allow" },
      { action: "other_*", resource: "*", effect: "deny" },
    ]
    expect(values.get("master").permissions).toEqual(expectedPermissions)
    applyAgentConfiguration(editor as never, config, models, ["project-mcp", "other"])
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

    applyAgentConfiguration(editor as never, config, [] as never, ["removed-mcp"])
    expect(values.get("master").permissions).toEqual([
      { action: "edit", resource: "leased.ts", effect: "ask" },
      { action: "skill", resource: "*", effect: "deny" },
      { action: "removed-mcp_*", resource: "*", effect: "deny" },
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
    applyAgentConfiguration(editor as never, config, [] as never, [])
    applyAgentConfiguration(editor as never, config, [] as never, [])
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
    expect(() => applyAgentConfiguration(editor as never, config, [] as never, [])).toThrow("immutable prompt snapshot")
  })

  test("missing writer definitions still retain fail-closed permission enforcement", () => {
    const config = fixture()
    const leases = new FileLeaseManager({ projectRoot: config.projectRoot })
    const event: { sessionID: string; agent: string; action: string; resources: string[]; effect: "allow" | "ask" | "deny"; message?: string } = {
      sessionID: "child", agent: "back-fast", action: "edit", resources: ["file.ts"], effect: "allow",
    }
    expect(enforceFileLeasePermission(event, config, leases)).toBe(true)
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
      async rules() {},
    },
    event: { subscribe: () => (async function* () {})() },
  } as never)
  try {
    expect(registered.map((entry) => entry.id)).toEqual(["gvozd-mode", "gvozd-leases", "gvozd-permissions"])
    const leasesHandler = registered.find((entry) => entry.id === "gvozd-leases")!.handlers.list!
    const output = await leasesHandler({}) as { leases: Array<{ agent: string; state: string; files: string[] }> }
    expect(output.leases).toEqual([])
    const setMode = registered.find((entry) => entry.id === "gvozd-mode")!.handlers.set!
    const modeOutput = await setMode({ sessionID: "ses-x", mode: "trusted" }) as { mode: string }
    expect(modeOutput.mode).toBe("trusted")
  } finally {
    await (cleanup as () => Promise<void>)()
  }
})

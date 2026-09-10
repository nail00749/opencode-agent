import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ResolvedConfig } from "./config"
import { enforceFileLeasePermission } from "./file-lease-plugin"
import { FileLeaseManager } from "./file-leases"
import agentGvozd, { applyAgentConfiguration } from "./index"

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
    skills: [],
    mcp: [],
    permissions: [],
    fileLease,
    disabled: false,
  })
  return {
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
    const values = new Map<string, any>([["master", { description: "old", mode: "primary", permissions: [] }]])
    let defaultAgent: string | undefined
    const editor = {
      get: (id: string) => values.get(id),
      update: (id: string, update: (agent: any) => void) => update(values.get(id)),
      remove: (id: string) => values.delete(id),
      default: (id: string) => { defaultAgent = id },
    }
    expect(() => applyAgentConfiguration(editor as never, config, [{ enabled: true, providerID: "openai", id: "deep", variants: [] }] as never, [])).not.toThrow()
    expect(values.get("master")).toMatchObject({ description: "configured", system: "Configured prompt", model: { providerID: "openai", id: "deep" } })
    expect(defaultAgent).toBe("master")
    expect(values.has("back-fast")).toBe(false)
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
})

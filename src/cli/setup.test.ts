import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { PromptUI } from "./configure"
import type { OpenCodeClient } from "./opencode"
import { PACKAGE_VERSION } from "../release-metadata"
import { runSetup } from "./setup"
import { GENERATED_MARKER } from "../constants"

const roots: string[] = []
const modelList = ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.3-codex-spark"]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { pluginFailure?: boolean; restartFailure?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".gvozd-setup-")))
  roots.push(root)
  mkdirSync(join(root, ".git"))
  const configRoot = join(root, "config", "opencode")
  const calls: string[] = []
  const client: OpenCodeClient = {
    executable: "opencode2",
    async version() { calls.push("version"); return "opencode2 v2.0.2" },
    async debugPaths() { calls.push("paths"); return { config: configRoot } },
    async models() { calls.push("models"); return modelList },
    async pluginAdd(spec) { calls.push(`plugin-add:${spec}`); if (options.pluginFailure) throw new Error("registry down") },
    async pluginRemove(spec) { calls.push(`plugin-remove:${spec}`) },
    async pluginList() { calls.push("plugin-list"); return `@nail00749/agent-gvozd ${PACKAGE_VERSION}` },
    async pluginCheck() { calls.push("plugin-check"); return "ok" },
    async debugAgents() { calls.push("debug-agents"); return "master master-trusted back-fast back-deep front-fast front-deep review-fast review-deep researcher explorer git docs debugger security devops planner" },
    async serviceStatus() { calls.push("service-status"); return "running" },
    async serviceRestart() { calls.push("restart"); if (options.restartFailure) throw new Error("restart unavailable") },
  }
  return { root, configRoot, calls, client }
}

function prompt(answers: unknown[], calls: string[]): PromptUI {
  return {
    async select<T>() { calls.push("prompt"); return answers.shift() as T | symbol },
    async confirm() { calls.push("confirm"); return answers.shift() as boolean | symbol },
    intro() {},
    outro() {},
  }
}

describe("global setup orchestration", () => {
  test("registers before writes, restarts, and runs doctor", async () => {
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(join(root, "docs", ".gvozd"), { recursive: true })
    writeFileSync(join(root, "docs", ".gvozd", "config.jsonc"), '{ "agents": { "master": { "description": "PROJECT ONLY" } } }\n')
    calls.push("detect")
    const result = await runSetup({ cwd: root, runtimeConfigRoot: configRoot, isTTY: true, ui: prompt(["openai", modelList[0], modelList[1], true], calls), findClient: async () => client })
    expect(result.status).toBe("complete")
    expect(result.report?.status).toBe("pass")
    expect(calls.slice(0, 8)).toEqual(["detect", "paths", "version", "models", "prompt", "prompt", "prompt", "confirm"])
    // Setup lists configured specs first so it can remove stale versions
    // of this package before registering the new one.
    expect(calls[8]).toBe("plugin-list")
    expect(calls[9]).toStartWith(`plugin-add:@nail00749/agent-gvozd@${PACKAGE_VERSION}`)
    expect(calls.indexOf("restart")).toBeGreaterThan(9)
    expect(existsSync(join(configRoot, "gvozd", "config.jsonc"))).toBe(true)
    expect(existsSync(join(configRoot, "agents", "master.md"))).toBe(true)
    expect(readFileSync(join(configRoot, "agents", "master.md"), "utf8")).not.toContain("PROJECT ONLY")
  })

  test("removes a previously registered package version before adding the new one", async () => {
    const { root, calls, client } = fixture()
    client.pluginList = async () => [
      "ID           VERSION  SOURCE",
      "agent-gvozd  0.1.5    @nail00749/agent-gvozd@0.1.5",
      "agent-gvozd  0.1.6    @nail00749/agent-gvozd@0.1.6",
      `agent-gvozd  ${PACKAGE_VERSION}    @nail00749/agent-gvozd@${PACKAGE_VERSION}`,
      "other        1.0.0    someone/else@1.0.0",
    ].join("\n")
    const result = await runSetup({ cwd: root, yes: true, findClient: async () => client })
    expect(result.status).toBe("complete")
    const removes = calls.filter((call) => call.startsWith("plugin-remove:"))
    expect(removes).toEqual([
      "plugin-remove:@nail00749/agent-gvozd@0.1.5",
      "plugin-remove:@nail00749/agent-gvozd@0.1.6",
    ])
    expect(calls.find((call) => call.startsWith("plugin-add:"))).toBe(`plugin-add:@nail00749/agent-gvozd@${PACKAGE_VERSION}`)
    // The foreign package spec is never touched.
    expect(calls.some((call) => call.includes("someone/else"))).toBe(false)
  })

  test("plugin registration failure leaves no managed files or lock", async () => {
    const { root, configRoot, client } = fixture({ pluginFailure: true })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("registry down")
    expect(existsSync(join(configRoot, "gvozd", "config.jsonc"))).toBe(false)
    expect(existsSync(join(configRoot, "gvozd", "schema.json"))).toBe(false)
    expect(existsSync(join(configRoot, "gvozd", "setup.lock"))).toBe(false)
    expect(existsSync(join(configRoot, "agents"))).toBe(false)
  })

  test("cancellation happens before plugin registration or writes", async () => {
    const { root, configRoot, calls, client } = fixture()
    const result = await runSetup({ cwd: root, isTTY: true, ui: prompt([Symbol("cancel")], calls), findClient: async () => client })
    expect(result.status).toBe("cancelled")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    expect(existsSync(configRoot)).toBe(false)
  })

  test("a symlinked debug config-root is rejected before registration or mutation", async () => {
    if (process.platform === "win32") return
    const { root, calls, client } = fixture()
    const outside = join(root, "outside")
    mkdirSync(outside)
    symlinkSync(outside, join(root, "linked-config"))
    client.debugPaths = async () => ({ config: join(root, "linked-config", "opencode") })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("symbolic-link")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    expect(existsSync(join(outside, "opencode"))).toBe(false)
  })

  test("unmanaged global collision fails before package registration", async () => {
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(join(configRoot, "agents"), { recursive: true })
    writeFileSync(join(configRoot, "agents", "master.md"), "user owned\n")
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("unmanaged")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })

  test("mismatching unmarked schema fails before package registration", async () => {
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(join(configRoot, "gvozd"), { recursive: true })
    writeFileSync(join(configRoot, "gvozd", "schema.json"), JSON.stringify({
      $id: "user-schema",
      description: "Generated by agent-gvozd sync",
    }))
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("unmanaged")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })

  test("locked revalidation catches an unmanaged schema swap before plugin registration", async () => {
    const { root, configRoot, calls, client } = fixture()
    await expect(runSetup({
      cwd: root,
      yes: true,
      findClient: async () => client,
      output() {
        mkdirSync(join(configRoot, "gvozd"), { recursive: true })
        writeFileSync(join(configRoot, "gvozd", "schema.json"), JSON.stringify({ $id: "swapped-user-schema" }))
      },
    })).rejects.toThrow("unmanaged")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })

  test("an existing setup lock blocks plugin registration and is not deleted", async () => {
    const { root, configRoot, calls, client } = fixture()
    const lock = join(configRoot, "gvozd", "setup.lock")
    mkdirSync(join(configRoot, "gvozd"), { recursive: true })
    writeFileSync(lock, "other setup\n", { mode: 0o600 })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("Another Gvozd setup")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    expect(readFileSync(lock, "utf8")).toBe("other setup\n")
  })

  test("embedded doctor reports a nonstandard runtime config-root mismatch", async () => {
    const { root, client } = fixture()
    const result = await runSetup({ cwd: root, yes: true, findClient: async () => client })
    expect(result.report?.checks.find((check) => check.id === "config-root")?.status).toBe("fail")
  })

  test("non-writeable config root fails before package registration", async () => {
    if (process.platform === "win32") return
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(configRoot, { recursive: true })
    chmodSync(configRoot, 0o500)
    try {
      await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("writeable")
      expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    } finally {
      chmodSync(configRoot, 0o700)
    }
  })

  test("a group-writable config-root ancestor fails before package registration", async () => {
    if (process.platform === "win32") return
    const { root, configRoot, calls, client } = fixture()
    chmodSync(root, 0o770)
    try {
      await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("group/world-writable")
      expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
      expect(existsSync(configRoot)).toBe(false)
    } finally { chmodSync(root, 0o700) }
  })

  test("reports registered-package and partial local state after a post-registration failure", async () => {
    const { root, configRoot, client } = fixture({ restartFailure: true })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow(
      "remains registered",
    )
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow(
      "no automatic rollback",
    )
    expect(existsSync(join(configRoot, "gvozd", "config.jsonc"))).toBe(true)
  })

  test("previews and removes stale marker-owned agents during setup", async () => {
    const { root, configRoot, client } = fixture()
    const agents = join(configRoot, "agents")
    mkdirSync(agents, { recursive: true })
    writeFileSync(join(agents, "stale.md"), `---\n${GENERATED_MARKER}\ndescription: stale\n---\n`)
    const output: string[] = []
    await runSetup({ cwd: root, yes: true, findClient: async () => client, output: (message) => output.push(message) })
    expect(output.join("\n")).toContain("Remove 1 stale")
    expect(existsSync(join(agents, "stale.md"))).toBe(false)
  })

  test("rejects an adjacent unsupported beta before registration", async () => {
    const { root, calls, client } = fixture()
    client.version = async () => { calls.push("version"); return "opencode2 v2.1.0" }
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("Unsupported")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })
})

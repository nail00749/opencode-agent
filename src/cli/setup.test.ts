import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PromptUI } from "./configure"
import type { OpenCodeClient } from "./opencode"
import { runSetup } from "./setup"

const roots: string[] = []
const modelList = ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.3-codex-spark"]

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { pluginFailure?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gvozd-setup-"))
  roots.push(root)
  const configRoot = join(root, "config", "opencode")
  const calls: string[] = []
  const client: OpenCodeClient = {
    executable: "opencode2",
    async version() { calls.push("version"); return "opencode2 v0.0.0-beta-19425" },
    async debugPaths() { calls.push("paths"); return { config: configRoot } },
    async models() { calls.push("models"); return modelList },
    async pluginAdd(spec) { calls.push(`plugin-add:${spec}`); if (options.pluginFailure) throw new Error("registry down") },
    async pluginList() { calls.push("plugin-list"); return "@nail00749/agent-gvozd 0.1.0" },
    async pluginCheck() { calls.push("plugin-check"); return "ok" },
    async debugAgents() { calls.push("debug-agents"); return "master back-fast back-deep front-fast front-deep review-fast review-deep researcher explorer git docs verifier debugger security devops planner" },
    async serviceStatus() { calls.push("service-status"); return "running" },
    async serviceRestart() { calls.push("restart") },
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
    const result = await runSetup({ cwd: root, isTTY: true, ui: prompt(["openai", modelList[0], modelList[1], true], calls), findClient: async () => client })
    expect(result.status).toBe("complete")
    expect(result.report?.status).toBe("pass")
    expect(calls.slice(0, 8)).toEqual(["detect", "paths", "version", "models", "prompt", "prompt", "prompt", "confirm"])
    expect(calls[8]).toStartWith("plugin-add:@nail00749/agent-gvozd@^0.1.0")
    expect(calls.indexOf("restart")).toBeGreaterThan(8)
    expect(existsSync(join(configRoot, "gvozd", "config.jsonc"))).toBe(true)
    expect(existsSync(join(configRoot, "agents", "master.md"))).toBe(true)
    expect(readFileSync(join(configRoot, "agents", "master.md"), "utf8")).not.toContain("PROJECT ONLY")
  })

  test("plugin registration failure leaves the filesystem untouched", async () => {
    const { root, configRoot, client } = fixture({ pluginFailure: true })
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("registry down")
    expect(existsSync(configRoot)).toBe(false)
  })

  test("cancellation happens before plugin registration or writes", async () => {
    const { root, configRoot, calls, client } = fixture()
    const result = await runSetup({ cwd: root, isTTY: true, ui: prompt([Symbol("cancel")], calls), findClient: async () => client })
    expect(result.status).toBe("cancelled")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
    expect(existsSync(configRoot)).toBe(false)
  })

  test("unmanaged global collision fails before package registration", async () => {
    const { root, configRoot, calls, client } = fixture()
    mkdirSync(join(configRoot, "agents"), { recursive: true })
    writeFileSync(join(configRoot, "agents", "master.md"), "user owned\n")
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("unmanaged")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })

  test("rejects an adjacent unsupported beta before registration", async () => {
    const { root, calls, client } = fixture()
    client.version = async () => { calls.push("version"); return "opencode2 v0.0.0-beta-194250" }
    await expect(runSetup({ cwd: root, yes: true, findClient: async () => client })).rejects.toThrow("Unsupported")
    expect(calls.some((call) => call.startsWith("plugin-add"))).toBe(false)
  })
})

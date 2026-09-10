import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../config"
import { writeGlobalConfig } from "./config-store"
import { runDoctor, doctorExitCode, renderDoctorHuman, renderDoctorJson } from "./doctor"
import { writeManagedAgents } from "./global-sync"
import type { OpenCodeClient } from "./opencode"
import type { ModelProfile } from "./provider-catalog"

const roots: string[] = []
const models = ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.3-codex-spark"]
const profile: ModelProfile = {
  provider: "openai",
  fast: [models[0]!, models[1]!],
  deep: [models[1]!, models[0]!],
  agentOverrides: { explorer: [models[2]!, models[0]!] },
}

function client(configRoot: string, overrides: Partial<OpenCodeClient> = {}): OpenCodeClient {
  return {
    executable: "opencode2",
    async version() { return "opencode2 v0.0.0-beta-19425" },
    async debugPaths() { return { config: configRoot } },
    async models() { return models },
    async pluginAdd() { throw new Error("doctor must not mutate") },
    async pluginList() { return "@nail00749/agent-gvozd 0.1.0" },
    async pluginCheck() { return "ok" },
    async debugAgents() { return Object.keys(loadConfig(process.cwd(), { configRoot }).agents).join("\n") },
    async serviceStatus() { return "running" },
    async serviceRestart() { throw new Error("doctor must not mutate") },
    ...overrides,
  }
}

function installed(): { root: string; configRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "gvozd-doctor-"))
  roots.push(root)
  const configRoot = join(root, "opencode")
  writeGlobalConfig({ configRoot, profile, schemaSource: readFileSync(join(process.cwd(), "defaults", "schema.json"), "utf8") })
  writeManagedAgents({ configRoot, agents: loadConfig(root, { configRoot }).agents })
  return { root, configRoot }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("read-only doctor", () => {
  test("returns deterministic passing checks and stable renderers", async () => {
    const { root, configRoot } = installed()
    const report = await runDoctor({ client: client(configRoot), configRoot, cwd: root })
    expect(report.status).toBe("pass")
    expect(report.checks.map((check) => check.id)).toEqual([
      "opencode-version", "service", "plugin", "plugin-check", "config-root",
      "config", "models", "global-agents", "runtime-agents", "legacy-local",
    ])
    expect(doctorExitCode(report)).toBe(0)
    expect(renderDoctorHuman(report)).toStartWith("Gvozd doctor: PASS")
    expect(JSON.parse(renderDoctorJson(report))).toEqual(report)
    expect(renderDoctorJson(report)).not.toContain("◇")
  })

  test("aggregates warnings without a failing exit", async () => {
    const { root, configRoot } = installed()
    const local = join(root, ".opencode", "agents")
    mkdirSync(local, { recursive: true })
    writeFileSync(join(local, "master.md"), "duplicate")
    const report = await runDoctor({ client: client(configRoot), configRoot, cwd: root })
    expect(report.status).toBe("warn")
    expect(doctorExitCode(report)).toBe(0)
  })

  test("turns subprocess failures into redacted individual checks", async () => {
    const { root, configRoot } = installed()
    const report = await runDoctor({
      client: client(configRoot, { async serviceStatus() { throw new Error("token=supersecret authorization:Bearer-secret") } }),
      configRoot,
      cwd: root,
    })
    expect(report.status).toBe("fail")
    expect(doctorExitCode(report)).toBe(1)
    const output = renderDoctorHuman(report)
    expect(output).not.toContain("supersecret")
    expect(output).not.toContain("Bearer-secret")
    expect(output).toContain("[redacted]")
  })

  test("reports missing runtime agents without printing unrelated output", async () => {
    const { root, configRoot } = installed()
    const report = await runDoctor({ client: client(configRoot, { async debugAgents() { return "unrelated-secret-config" } }), configRoot, cwd: root })
    expect(report.checks.find((check) => check.id === "runtime-agents")?.status).toBe("fail")
    expect(renderDoctorJson(report)).not.toContain("unrelated-secret-config")
  })
})

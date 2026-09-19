import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../core/config"
import { writeGlobalConfig } from "./config-store"
import { runDoctor, doctorExitCode, renderDoctorHuman, renderDoctorJson } from "./doctor"
import { writeManagedAgents } from "./global-sync"
import type { OpenCodeClient } from "./opencode"
import type { ModelProfile } from "./provider-catalog"
import { GENERATED_MARKER } from "../core/constants"
import { PACKAGE_SPEC, PACKAGE_VERSION } from "../core/release-metadata"

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
    async version() { return "opencode2 v2.0.2" },
    async debugPaths() { return { config: configRoot } },
    async models() { return models },
    async pluginAdd() { throw new Error("doctor must not mutate") },
    async pluginRemove() { throw new Error("doctor must not mutate") },
    async pluginList() { return `@nail00749/agent-gvozd ${PACKAGE_VERSION}` },
    async pluginCheck() { return "ok" },
    async debugAgents() { return Object.keys(loadConfig(process.cwd(), { configRoot }).agents).join("\n") },
    async serviceStatus() { return "running" },
    async serviceRestart() { throw new Error("doctor must not mutate") },
    async apiJson() { throw new Error("doctor must not call the HTTP API") },
    ...overrides,
  }
}

function installed(): { root: string; configRoot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-doctor-")))
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
      "node-version", "opencode-version", "service", "plugin", "plugin-check", "config-root",
      "config", "models", "global-agents", "runtime-agents", "legacy-local", "jev",
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

  test("reports the Node.js gate and enabled Jev credential state without revealing values", async () => {
    const { root, configRoot } = installed()
    const configPath = join(configRoot, "gvozd", "config.jsonc")
    const source = readFileSync(configPath, "utf8").replace(/\n}\n$/, ',\n  "jev": { "enabled": true }\n}\n')
    writeFileSync(configPath, source)
    const report = await runDoctor({ client: client(configRoot), configRoot, cwd: root, nodeVersion: "20.12.0", env: {} })
    expect(report.checks.find((check) => check.id === "node-version")?.status).toBe("fail")
    const jev = report.checks.find((check) => check.id === "jev")
    expect(jev).toMatchObject({ status: "warn", remediation: "Set TYPESAFE_API_KEY in the OpenCode service environment" })
    expect(renderDoctorJson(report)).not.toContain("secret-value")
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

  test("does not expose shared diagnostic secret forms in human or JSON output", async () => {
    const { root, configRoot } = installed()
    const diagnostic = [
      "https://url-user:url-password@example.test/path?token=query-secret",
      "Bearer bearer-secret",
      "-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----",
    ].join(" ")
    const report = await runDoctor({
      client: client(configRoot, { async serviceStatus() { throw new Error(diagnostic) } }),
      configRoot,
      cwd: root,
    })

    for (const output of [renderDoctorHuman(report), renderDoctorJson(report)]) {
      expect(output).not.toContain("url-user")
      expect(output).not.toContain("url-password")
      expect(output).not.toContain("query-secret")
      expect(output).not.toContain("private-key-secret")
      expect(output).not.toContain("bearer-secret")
      expect(output).toContain("[redacted]")
    }
  })

  test("reports missing runtime agents without printing unrelated output", async () => {
    const { root, configRoot } = installed()
    const report = await runDoctor({ client: client(configRoot, { async debugAgents() { return "unrelated-secret-config" } }), configRoot, cwd: root })
    expect(report.checks.find((check) => check.id === "runtime-agents")?.status).toBe("fail")
    expect(renderDoctorJson(report)).not.toContain("unrelated-secret-config")
  })

  test("accepts any 2.0.x patch as the supported version range", async () => {
    const { root, configRoot } = installed()
    const report = await runDoctor({
      client: client(configRoot, {
        async version() { return "opencode2 v2.0.41" },
        async pluginList() { return "@nail00749/agent-gvozd 0.1.8" },
        async debugAgents() { return Object.keys(loadConfig(root, { configRoot }).agents).join("\n") },
      }),
      configRoot,
      cwd: root,
    })
    expect(report.checks.find((check) => check.id === "opencode-version")?.status).toBe("pass")
  })

  test("requires exact version, plugin, and agent identifiers", async () => {
    const { root, configRoot } = installed()
    const report = await runDoctor({
      client: client(configRoot, {
        async version() { return "opencode2 v2.1.0" },
        async pluginList() { return "@nail00749/agent-gvozd-old 0.1.2" },
        async debugAgents() { return Object.keys(loadConfig(root, { configRoot }).agents).map((id) => `${id}-old`).join("\n") },
      }),
      configRoot,
      cwd: root,
    })
    expect(report.checks.find((check) => check.id === "opencode-version")?.status).toBe("fail")
    expect(report.checks.find((check) => check.id === "plugin")?.status).toBe("fail")
    expect(report.checks.find((check) => check.id === "runtime-agents")?.status).toBe("fail")
  })

  test("rejects the previous installed package version", async () => {
    const { root, configRoot } = installed()
    const report = await runDoctor({
      client: client(configRoot, { async pluginList() { return "@nail00749/agent-gvozd 0.1.1" } }),
      configRoot,
      cwd: root,
    })
    expect(report.checks.find((check) => check.id === "plugin")?.status).toBe("fail")
  })

  test("does not pass model validation when config loading fails", async () => {
    const { root, configRoot } = installed()
    writeFileSync(join(configRoot, "gvozd", "config.jsonc"), '{ "agents": ')
    const report = await runDoctor({ client: client(configRoot), configRoot, cwd: root })
    expect(report.checks.find((check) => check.id === "config")?.status).toBe("fail")
    expect(report.checks.find((check) => check.id === "models")?.status).toBe("fail")
  })

  test("treats successful plugin check exit status as authoritative", async () => {
    const { root, configRoot } = installed()
    let checkedPackage: string | undefined
    const report = await runDoctor({
      client: client(configRoot, { async pluginCheck(packageSpec) {
        checkedPackage = packageSpec
        return "0 errors; no failed or incompatible plugins"
      } }),
      configRoot,
      cwd: root,
    })
    expect(checkedPackage).toBe(PACKAGE_SPEC)
    expect(checkedPackage).not.toBe("@nail00749/agent-gvozd@^0.1.2")
    expect(report.checks.find((check) => check.id === "plugin-check")?.status).toBe("pass")
  })

  test("warns for missing fallbacks but fails when an agent has no available configured model", async () => {
    const { root, configRoot } = installed()
    const warning = await runDoctor({
      client: client(configRoot, { async models() { return [models[0]!] } }),
      configRoot,
      cwd: root,
    })
    expect(warning.checks.find((check) => check.id === "models")?.status).toBe("warn")

    const failure = await runDoctor({
      client: client(configRoot, { async models() { return ["custom/available"] } }),
      configRoot,
      cwd: root,
    })
    expect(failure.checks.find((check) => check.id === "models")?.status).toBe("fail")
  })

  test("reports marker-owned orphan agents and ignores unmanaged files", async () => {
    const { root, configRoot } = installed()
    const directory = join(configRoot, "agents")
    writeFileSync(join(directory, "orphan.md"), `---\n${GENERATED_MARKER}\ndescription: orphan\n---\n`)
    writeFileSync(join(directory, "unmanaged.md"), "user owned\n")
    const report = await runDoctor({ client: client(configRoot), configRoot, cwd: root })
    const check = report.checks.find((candidate) => candidate.id === "global-agents")
    expect(check).toMatchObject({ status: "fail", remediation: "gvozd setup" })
    expect(check?.summary).toContain("orphan")
    expect(check?.summary).not.toContain("unmanaged.md")
  })

  test("compares debug paths with an independently resolved runtime root", async () => {
    const { root, configRoot } = installed()
    const report = await runDoctor({
      client: client(configRoot),
      configRoot,
      runtimeConfigRoot: join(root, "different-runtime-root"),
      cwd: root,
    })
    const check = report.checks.find((candidate) => candidate.id === "config-root")
    expect(check?.status).toBe("fail")
    expect(check?.remediation).toContain("GVOZD_OPENCODE_CONFIG_ROOT")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, resolveAgentConfig } from "./config"
import { computeProjectTrustToken } from "./project-trust"

const completeAgent = {
  description: "Custom implementation agent",
  mode: "subagent" as const,
  models: ["openai/gpt-5.6-luna"],
  prompt: "/tmp/custom-agent.md",
  promptContent: "Custom implementation prompt\n",
  skills: [],
  mcp: [],
  permissions: [],
  disabled: false,
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function project(): { root: string; configRoot: string; projectConfig: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-config-")))
  roots.push(root)
  mkdirSync(join(root, ".git"))
  const configRoot = join(root, "config", "opencode")
  const projectConfig = join(root, "docs", ".gvozd")
  mkdirSync(join(configRoot, "gvozd"), { recursive: true })
  mkdirSync(projectConfig, { recursive: true })
  return { root, configRoot, projectConfig }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe("file lease configuration", () => {
  test("new agents default to readonly", () => {
    expect(resolveAgentConfig(completeAgent).fileLease).toBe("readonly")
  })

  test("accepts an explicit writer role and rejects unknown roles", () => {
    expect(resolveAgentConfig({ ...completeAgent, fileLease: "writer" }).fileLease).toBe("writer")
    expect(() => resolveAgentConfig({ ...completeAgent, fileLease: "admin" })).toThrow()
  })

  test("rejects unknown agent and permission fields instead of stripping them", () => {
    expect(() => resolveAgentConfig({ ...completeAgent, unexpected: true })).toThrow()
    expect(() => resolveAgentConfig({
      ...completeAgent,
      permissions: [{ action: "read", resource: "*", effect: "allow", unexpected: true }],
    })).toThrow()
  })

  test("package defaults classify every built-in agent", () => {
    const config = loadConfig(process.cwd())
    expect(config.agents.master?.fileLease).toBe("coordinator")
    for (const id of ["back-fast", "back-deep", "front-fast", "front-deep", "docs", "devops"]) {
      expect(config.agents[id]?.fileLease).toBe("writer")
    }
    for (const id of [
      "planner",
      "review-fast",
      "review-deep",
      "researcher",
      "explorer",
      "git",
      "debugger",
      "security",
    ]) {
      expect(config.agents[id]?.fileLease).toBe("readonly")
    }
  })
})

describe("strict layered configuration", () => {
  test("merges scalar patches, replaces arrays, and resolves a custom default agent", () => {
    const { root, configRoot, projectConfig } = project()
    const globalDirectory = join(configRoot, "gvozd")
    writeJson(join(globalDirectory, "config.jsonc"), {
      agents: {
        master: {
          description: "global master",
          models: ["global/first", "global/fallback"],
          skills: ["global-skill"],
          mcp: ["global-mcp"],
          permissions: [{ action: "read", resource: "global", effect: "allow" }],
        },
      },
    })
    writeFileSync(join(projectConfig, "custom.md"), "Custom prompt\n")
    writeJson(join(projectConfig, "config.jsonc"), {
      $schema: "./schema.json",
      defaultAgent: "custom",
      agents: {
        master: {
          models: ["project/only"],
          skills: [],
          mcp: ["project-mcp"],
          permissions: [],
        },
        custom: {
          description: "custom primary",
          mode: "primary",
          models: ["custom/model"],
          prompt: "custom.md",
        },
      },
    })

    const config = loadConfig(root, { configRoot, projectTrustToken: computeProjectTrustToken(root) })
    expect(config.defaultAgent).toBe("custom")
    expect(config.agents.master).toMatchObject({
      description: "global master",
      models: ["project/only"],
      skills: [],
      mcp: ["project-mcp"],
      permissions: [],
    })
    expect(config.agents.custom).toMatchObject({
      mode: "primary",
      skills: [],
      mcp: [],
      permissions: [],
      fileLease: "readonly",
      disabled: false,
    })
    expect(config.agents.custom?.prompt).toBe(join(projectConfig, "custom.md"))
    expect(config.agents.custom?.promptContent).toBe("Custom prompt\n")
  })

  test("inherits prompt snapshots and replaces path and content together", () => {
    const { root, configRoot, projectConfig } = project()
    const globalDirectory = join(configRoot, "gvozd")
    const globalPrompt = join(globalDirectory, "global-master.md")
    writeFileSync(globalPrompt, "Global prompt snapshot\n")
    writeJson(join(globalDirectory, "config.jsonc"), { agents: { master: { prompt: "global-master.md" } } })
    writeJson(join(projectConfig, "config.jsonc"), { agents: { master: { description: "description only" } } })

    const inherited = loadConfig(root, { configRoot })
    expect(inherited.agents.master?.prompt).toBe(globalPrompt)
    expect(inherited.agents.master?.promptContent).toBe("Global prompt snapshot\n")

    const projectPrompt = join(projectConfig, "project-master.md")
    writeFileSync(projectPrompt, "Project prompt snapshot\n")
    writeJson(join(projectConfig, "config.jsonc"), { agents: { master: { prompt: "project-master.md" } } })
    const overridden = loadConfig(root, { configRoot, projectTrustToken: computeProjectTrustToken(root) })
    writeFileSync(projectPrompt, "Changed after trusted load\n")
    expect(overridden.agents.master?.prompt).toBe(projectPrompt)
    expect(overridden.agents.master?.promptContent).toBe("Project prompt snapshot\n")
  })

  test("rejects unknown root and nested fields", () => {
    const { root, configRoot, projectConfig } = project()
    writeJson(join(projectConfig, "config.jsonc"), { agents: {}, unknown: true })
    expect(() => loadConfig(root, { configRoot })).toThrow()

    writeJson(join(projectConfig, "config.jsonc"), { agents: { master: { unknown: true } } })
    expect(() => loadConfig(root, { configRoot })).toThrow()
  })

  test("requires a custom default to be enabled and primary-capable", () => {
    const { root, configRoot, projectConfig } = project()
    writeFileSync(join(projectConfig, "custom.md"), "Custom prompt\n")
    writeJson(join(projectConfig, "config.jsonc"), {
      defaultAgent: "custom",
      agents: {
        custom: {
          description: "custom",
          mode: "subagent",
          models: ["custom/model"],
          prompt: "custom.md",
        },
      },
    })
    expect(() => loadConfig(root, { configRoot, projectTrustToken: computeProjectTrustToken(root) })).toThrow("enabled primary")
  })
})

describe("configuration path boundaries", () => {
  test("rejects a missing prompt", () => {
    const { root, projectConfig } = project()
    writeJson(join(projectConfig, "config.jsonc"), { agents: { master: { prompt: "missing.md" } } })
    expect(() => computeProjectTrustToken(root)).toThrow("missing")
  })

  test("rejects prompt traversal outside its declaring layer", () => {
    const { root, projectConfig } = project()
    writeFileSync(join(root, "docs", "outside.md"), "Outside\n")
    writeJson(join(projectConfig, "config.jsonc"), { agents: { master: { prompt: "../outside.md" } } })
    expect(() => computeProjectTrustToken(root)).toThrow("must stay inside")
  })

  test("rejects symlinked prompt files and agent directories", () => {
    const promptFixture = project()
    const outside = join(promptFixture.root, "outside.md")
    writeFileSync(outside, "Outside\n")
    symlinkSync(outside, join(promptFixture.projectConfig, "linked.md"))
    writeJson(join(promptFixture.projectConfig, "config.jsonc"), { agents: { master: { prompt: "linked.md" } } })
    expect(() => computeProjectTrustToken(promptFixture.root)).toThrow("symlink")

    const directoryFixture = project()
    const agentsOutside = join(directoryFixture.root, "agents-outside")
    mkdirSync(agentsOutside)
    symlinkSync(agentsOutside, join(directoryFixture.projectConfig, "linked-agents"))
    writeJson(join(directoryFixture.projectConfig, "config.jsonc"), { agentsDirectory: "linked-agents", agents: {} })
    expect(() => computeProjectTrustToken(directoryFixture.root)).toThrow("symlink")
  })

  test("uses explicit config root before environment-derived roots", () => {
    const { root, configRoot } = project()
    const config = loadConfig(root, {
      configRoot,
      env: { GVOZD_OPENCODE_CONFIG_ROOT: "/ignored", XDG_CONFIG_HOME: "/also-ignored" },
    })
    expect(config.globalConfigDirectory).toBe(join(configRoot, "gvozd"))
  })
})

describe("project capability trust boundary", () => {
  test("rejects every privileged project field and custom agents by default", () => {
    for (const [rootFields, patch] of [
      [{ defaultAgent: "master" }, undefined],
      [{ agentsDirectory: "agents" }, undefined],
      [{}, { mode: "primary" }],
      [{}, { models: ["custom/model"] }],
      [{}, { prompt: "prompt.md" }],
      [{}, { disabled: true }],
      [{}, { permissions: [{ action: "shell", resource: "*", effect: "allow" }] }],
      [{}, { skills: ["repo-controlled-skill"] }],
      [{}, { mcp: ["repo-controlled-server"] }],
      [{}, { fileLease: "writer" }],
    ] as const) {
      const { root, configRoot, projectConfig } = project()
      writeFileSync(join(projectConfig, "prompt.md"), "Prompt\n")
      writeJson(join(projectConfig, "config.jsonc"), { ...rootFields, agents: patch ? { master: patch } : {} })
      expect(() => loadConfig(root, { configRoot, env: {} })).toThrow("Untrusted project config")
    }
    const { root, configRoot, projectConfig } = project()
    writeJson(join(projectConfig, "config.jsonc"), { agents: { custom: { description: "custom" } } })
    expect(() => loadConfig(root, { configRoot, env: {} })).toThrow("unknown agent custom")
  })

  test("applies trusted capabilities and default agent using exact option or env token", () => {
    const { root, configRoot, projectConfig } = project()
    writeFileSync(join(projectConfig, "custom.md"), "Trusted prompt\n")
    writeJson(join(projectConfig, "config.jsonc"), {
      defaultAgent: "custom",
      agents: {
        master: {
          permissions: [{ action: "read", resource: "trusted/*", effect: "allow" }],
          skills: ["trusted-skill"],
          mcp: ["trusted-mcp"],
          fileLease: "coordinator",
        },
        custom: {
          description: "custom",
          mode: "primary",
          models: ["custom/model"],
          prompt: "custom.md",
        },
      },
    })
    const token = computeProjectTrustToken(root)
    for (const options of [
      { projectTrustToken: token, env: {} },
      { env: { GVOZD_TRUST_PROJECT_CONFIG: token } },
    ]) {
      const config = loadConfig(root, { configRoot, ...options })
      expect(config.defaultAgent).toBe("custom")
      expect(config.agents.master).toMatchObject({
        permissions: [{ action: "read", resource: "trusted/*", effect: "allow" }],
        skills: ["trusted-skill"],
        mcp: ["trusted-mcp"],
        fileLease: "coordinator",
      })
      expect(config.agents.custom?.prompt).toBe(join(projectConfig, "custom.md"))
    }
  })

  test("does not trust stale, boolean-like, or foreign tokens", () => {
    const first = project()
    writeJson(join(first.projectConfig, "config.jsonc"), { agents: { master: { skills: ["trusted"] } } })
    const token = computeProjectTrustToken(first.root)
    writeJson(join(first.projectConfig, "config.jsonc"), { agents: { master: { skills: ["changed"] } } })
    for (const value of [token, "1", "true", "sha256:" + "0".repeat(64)]) {
      expect(() => loadConfig(first.root, { configRoot: first.configRoot, env: { GVOZD_TRUST_PROJECT_CONFIG: value } })).toThrow("Untrusted")
    }
    const second = project()
    writeJson(join(second.projectConfig, "config.jsonc"), { agents: { master: { skills: ["trusted"] } } })
    expect(() => loadConfig(second.root, { configRoot: second.configRoot, projectTrustToken: computeProjectTrustToken(first.root) })).toThrow("Untrusted")
  })

  test("allows only description on an existing agent without trust", () => {
    const { root, configRoot, projectConfig } = project()
    writeJson(join(projectConfig, "config.jsonc"), { agents: { master: { description: "ordinary project override" } } })
    expect(loadConfig(root, { configRoot, env: {} }).agents.master?.description).toBe("ordinary project override")
  })

  test("includeProject false ignores malformed project config and trust discovery", () => {
    const { root, configRoot, projectConfig } = project()
    writeFileSync(join(projectConfig, "config.jsonc"), '{ "agents": ')
    expect(() => loadConfig(root, {
      configRoot,
      includeProject: false,
      projectTrustToken: "sha256:" + "0".repeat(64),
    })).not.toThrow()
  })
})

describe("default MCP access", () => {
  test("grants Context7 only to roles that need current documentation", () => {
    const config = loadConfig(process.cwd())
    const expected = [
      "planner",
      "back-fast",
      "back-deep",
      "front-fast",
      "front-deep",
      "review-fast",
      "review-deep",
      "researcher",
      "docs",
      "debugger",
      "security",
      "devops",
    ].sort()
    const granted = Object.entries(config.agents)
      .filter(([, agent]) => agent.mcp.includes("context7"))
      .map(([id]) => id)
      .sort()
    expect(granted).toEqual(expected)
    for (const id of expected) expect(config.agents[id]?.mcp).toEqual(["context7"])
    for (const id of ["master", "explorer", "git"]) {
      expect(config.agents[id]?.mcp).toEqual([])
    }
  })
})

describe("built-in desktop browser tool gating", () => {
  test("every built-in agent denies the host desktop browser namespace", () => {
    const config = loadConfig(process.cwd())
    // OpenCode's desktop browser tools are registered with options.permission
    // "browser" and never call Permission.assert at runtime. The only host
    // enforcement is hiding the tool when a matching deny rule exists, so
    // every Gvozd agent must end on a deny for the "browser" action.
    for (const [id, agent] of Object.entries(config.agents)) {
      const matching = agent.permissions.filter(
        (rule) => rule.effect === "deny" && rule.resource === "*" && (rule.action === "browser" || rule.action === "*"),
      )
      expect(matching.length).toBeGreaterThan(0)
      expect(matching.at(-1)?.action, id).toBe(matching.at(0)!.action)
    }
  })
})

describe("lease TTL configuration", () => {
  test("defaults match the documented 5/30 minute TTLs", () => {
    const config = loadConfig(projectDirectory(), { includeProject: false, configRoot: tmpRoot() })
    expect(config.lease.reservationTtlMs).toBe(5 * 60 * 1_000)
    expect(config.lease.activeTtlMs).toBe(30 * 60 * 1_000)
  })

  test("global layer may raise the TTLs", () => {
    const config = loadConfig(projectDirectory(), {
      includeProject: false,
      configRoot: globalRootWith({ lease: { reservationTtlMinutes: 15, activeTtlMinutes: 120 } }),
    })
    expect(config.lease.reservationTtlMs).toBe(15 * 60_000)
    expect(config.lease.activeTtlMs).toBe(120 * 60_000)
  })

  test("untrusted project layer cannot override lease tuning", () => {
    const root = projectDirectory()
    const directory = join(root, "docs", ".gvozd")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "config.jsonc"), '{ "lease": { "activeTtlMinutes": 999 } }\n')
    expect(() => loadConfig(root, { includeProject: true })).toThrow(/cannot override lease/)
  })
})

function projectDirectory(): string {
  return mkdtempSync(join(tmpdir(), "gvozd-lease-config-"))
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gvozd-lease-root-"))
}

function globalRootWith(overrides: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "gvozd-lease-global-"))
  mkdirSync(join(root, "gvozd"), { recursive: true })
  writeFileSync(
    join(root, "gvozd", "config.jsonc"),
    JSON.stringify({ ...overrides, agents: {} }) + "\n",
  )
  return root
}

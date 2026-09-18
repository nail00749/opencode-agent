import { describe, expect, test } from "bun:test"
import { DEFAULT_ACTIVE_TTL_MS, DEFAULT_RESERVATION_TTL_MS } from "./file-leases"
import { buildAgentContext } from "./agent-context"
import type { ResolvedConfig } from "./config"

function agent(fileLease: "coordinator" | "writer" | "readonly") {
  return {
    description: "test agent",
    mode: "subagent" as const,
    models: ["openai/gpt-5.6-luna"],
    prompt: "/tmp/prompt.md",
    promptContent: "test prompt\n",
    skills: [],
    mcp: [],
    permissions: [],
    fileLease,
    disabled: false,
  }
}

function config(): ResolvedConfig {
  return {
    lease: { reservationTtlMs: DEFAULT_RESERVATION_TTL_MS, activeTtlMs: DEFAULT_ACTIVE_TTL_MS, shellEscalation: "ask" },
    defaultAgent: "master",
    agents: {
      master: { ...agent("coordinator"), mode: "primary" },
      "back-fast": agent("writer"),
      git: agent("readonly"),
    },
    packageRoot: "/pkg",
    projectRoot: "/repo",
    projectConfigDirectory: "/repo/docs/.gvozd",
    globalConfigDirectory: "/global/gvozd",
    sources: [],
  }
}

describe("buildAgentContext", () => {
  test("describes the role, lease policy, and AGENTS.md path", () => {
    const block = buildAgentContext(config(), "back-fast")!
    expect(block.agent).toBe("back-fast")
    expect(block.role).toBe("writer")
    expect(block.text).toContain('"back-fast" (writer role)')
    expect(block.text).toContain("/repo/AGENTS.md")
  })

  test("writer guidance explains the shell request flow under ask escalation", () => {
    const block = buildAgentContext(config(), "back-fast")!
    expect(block.text).toContain("permission request")
    expect(block.text).toContain("Destructive commands")
    expect(block.text).not.toContain("hard-denied in this project")
  })

  test("deny escalation tells the agent to report instead of requesting", () => {
    const resolved = config()
    resolved.lease.shellEscalation = "deny"
    const block = buildAgentContext(resolved, "back-fast")!
    expect(block.text).toContain("lease.shellEscalation: deny")
    expect(block.text).not.toContain("permission request")
  })

  test("coordinator guidance covers lease ownership and its own shell pause", () => {
    const block = buildAgentContext(config(), "master")!
    expect(block.role).toBe("coordinator")
    expect(block.text).toContain("reserve files with gvozd_lease")
    expect(block.text).toContain("your own shell pauses")
  })

  test("readonly guidance forbids mutations", () => {
    const block = buildAgentContext(config(), "git")!
    expect(block.text).toContain("never mutate files")
  })

  test("returns undefined for unconfigured, unknown, and disabled agents", () => {
    const resolved = config()
    expect(buildAgentContext(resolved, "build")).toBeUndefined()
    expect(buildAgentContext(resolved, "nonexistent")).toBeUndefined()
    resolved.agents["back-fast"]!.disabled = true
    expect(buildAgentContext(resolved, "back-fast")).toBeUndefined()
  })
})
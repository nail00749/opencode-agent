import { describe, expect, test } from "bun:test"
import { loadConfig, resolveAgentConfig } from "./config"

const completeAgent = {
  description: "Custom implementation agent",
  mode: "subagent" as const,
  models: ["openai/gpt-5.6-luna"],
  prompt: "/tmp/custom-agent.md",
  skills: [],
  mcp: [],
  permissions: [],
  disabled: false,
}

describe("file lease configuration", () => {
  test("new agents default to readonly", () => {
    expect(resolveAgentConfig(completeAgent).fileLease).toBe("readonly")
  })

  test("accepts an explicit writer role and rejects unknown roles", () => {
    expect(resolveAgentConfig({ ...completeAgent, fileLease: "writer" }).fileLease).toBe("writer")
    expect(() => resolveAgentConfig({ ...completeAgent, fileLease: "admin" })).toThrow()
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
      "verifier",
      "debugger",
      "security",
    ]) {
      expect(config.agents[id]?.fileLease).toBe("readonly")
    }
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
      "verifier",
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

import { describe, expect, test } from "bun:test"
import { buildAgentPermissions, explicitMcpAccess, matchingMcpServers } from "./agent-permissions"

const configured = {
  skills: ["review"],
  mcp: ["context7"],
  permissions: [
    { action: "read", resource: "src/*", effect: "allow" as const },
    { action: "gitlab_get_issue", resource: "owned", effect: "ask" as const },
  ],
}

describe("resolved agent permissions", () => {
  test("combines configured, skill, and MCP rules deterministically", () => {
    const expected = buildAgentPermissions(configured, ["context7", "gitlab"])
    expect(buildAgentPermissions(configured, ["context7", "gitlab"])).toEqual(expected)
    expect(expected).toContainEqual({ action: "skill", resource: "*", effect: "deny" })
    expect(expected).toContainEqual({ action: "skill", resource: "review", effect: "allow" })
    expect(expected).toContainEqual({ action: "context7_*", resource: "*", effect: "allow" })
    expect(expected).toContainEqual({ action: "gitlab_*", resource: "*", effect: "deny" })
    expect(expected.at(-1)).toEqual({ action: "gitlab_get_issue", resource: "owned", effect: "ask" })
  })

  test("requires every resource to receive explicit MCP access", () => {
    expect(explicitMcpAccess(configured, "gitlab_get_issue", ["owned"])).toBe(true)
    expect(explicitMcpAccess(configured, "gitlab_get_issue", ["owned", "other"])).toBe(false)
    expect(explicitMcpAccess(configured, "gitlab_get_issue", [])).toBe(false)
  })

  test("exposes normalized-prefix ambiguity to the fail-closed hook", () => {
    expect(matchingMcpServers("git_lab_get", ["git.lab", "git_lab", "other"])).toEqual(["git.lab", "git_lab"])
  })
})

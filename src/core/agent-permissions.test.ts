import { describe, expect, test } from "bun:test"
import { buildAgentPermissions, explicitMcpAccess, hasMcpServerAccess, matchingMcpServers } from "./agent-permissions"

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
    // The protected Git deny set lands after every other rule (last-match-wins).
    expect(expected.at(-1)).toEqual({ action: "shell", resource: "git remote add*", effect: "deny" })
    expect(expected).toContainEqual({ action: "gitlab_get_issue", resource: "owned", effect: "ask" })
  })

  test("requires every resource to receive explicit MCP access", () => {
    expect(explicitMcpAccess(configured, "gitlab_get_issue", ["owned"])).toBe(true)
    expect(explicitMcpAccess(configured, "gitlab_get_issue", ["owned", "other"])).toBe(false)
    expect(explicitMcpAccess(configured, "gitlab_get_issue", [])).toBe(false)
  })

  test("wildcard mcp grant allows every discovered server, explicit lists stay exact", () => {
    expect(hasMcpServerAccess(["*"], "gitlab")).toBe(true)
    expect(hasMcpServerAccess(["*"], "anything-new")).toBe(true)
    expect(hasMcpServerAccess(["context7"], "context7")).toBe(true)
    expect(hasMcpServerAccess(["context7"], "gitlab")).toBe(false)
    expect(hasMcpServerAccess([], "gitlab")).toBe(false)
    const wildcard = buildAgentPermissions({ ...configured, mcp: ["*"] }, ["context7", "gitlab"])
    expect(wildcard).toContainEqual({ action: "context7_*", resource: "*", effect: "allow" })
    expect(wildcard).toContainEqual({ action: "gitlab_*", resource: "*", effect: "allow" })
    // Explicit per-tool rules still append after the generated grant (last-match-wins).
    expect(wildcard).toContainEqual({ action: "gitlab_get_issue", resource: "owned", effect: "ask" })
    const gitlabToolRules = wildcard
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.action === "gitlab_get_issue")
    expect(gitlabToolRules.at(-1)!.index)
      .toBeGreaterThan(wildcard.findIndex((rule) => rule.action === "gitlab_*"))
  })

  test("exposes normalized-prefix ambiguity to the fail-closed hook", () => {
    expect(matchingMcpServers("git_lab_get", ["git.lab", "git_lab", "other"])).toEqual(["git.lab", "git_lab"])
  })
})

import { describe, expect, test } from "bun:test"
import { buildAgentPermissions, explicitMcpAccess, hasMcpServerAccess, matchingMcpServers, wildcardMatch } from "./agent-permissions"
import { loadConfig } from "./config"

const configured = {
  skills: ["review"],
  mcp: ["context7"],
  permissions: [
    { action: "read", resource: "src/*", effect: "allow" as const },
    { action: "gitlab_get_issue", resource: "owned", effect: "ask" as const },
  ],
}

describe("resolved agent permissions", () => {
  test("default forge skills do not grant MCP or generic CLI access and reviewers stay read-only", () => {
    const { agents } = loadConfig(process.cwd(), { configRoot: "/nonexistent-gvozd-config", includeProject: false })
    const effect = (id: string, action: string, resource: string) => buildAgentPermissions(agents[id]!, ["gitlab"])
      .filter((rule) => wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, resource)).at(-1)?.effect
    for (const id of ["git", "devops", "review-fast", "review-deep", "security"]) {
      expect(agents[id]!.permissions.some((rule) => rule.action.startsWith("gitlab_"))).toBe(false)
      expect(effect(id, "gitlab_get_issue", "*")).toBe("deny")
      expect(effect(id, "shell", "glab api --hostname gitlab.example --method GET projects/1")).not.toBe("allow")
      expect(effect(id, "shell", "gh api --hostname github.example --method POST repos/a/b/actions/runs/1/cancel")).not.toBe("allow")
    }
    expect(effect("git", "skill", "forge-workflow")).toBe("allow")
    expect(effect("git", "shell", "glab mr create --repo gitlab.example/a/b")).toBe("ask")
    expect(effect("git", "shell", "glab auth login")).toBe("deny")
    expect(effect("git", "shell", "gh repo delete a/b")).toBe("deny")
    expect(effect("devops", "skill", "ci-workflow")).toBe("allow")
    expect(effect("devops", "skill", "runner-workflow")).toBe("allow")
    for (const id of ["review-fast", "review-deep", "security"]) {
      expect(effect(id, "edit", "file")).toBe("deny")
      expect(effect(id, "shell", "glab mr approve 1 --repo gitlab.example/a/b")).toBe("ask")
      expect(effect(id, "shell", "gh run cancel 1 --repo github.example/a/b")).toBe("ask")
    }
  })
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

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
  test("Git remote deletion/prune asks override config allows without granting other identities", () => {
    const agent = { ...configured, permissions: [{ action: "*", resource: "*", effect: "allow" as const }] }
    const deletions = [
      "git push origin :topic", "git push origin :refs/heads/topic", "git push origin :refs/tags/tag",
      "git push :topic origin", "git push origin main :refs/heads/topic other:other :refs/tags/tag",
      "git push origin :topic :other", "git push :", "git push origin :",
      "git push --prune origin", "git push origin --prune", "git push origin main --prune",
      "git push --prune", "git -C . push origin :refs/heads/topic",
      "git -c push.default=current -C . push origin main --prune",
    ]
    for (const id of [undefined, "custom", "review-deep", "back-fast", "git"]) {
      const rules = buildAgentPermissions(agent, [], id)
      const effect = (command: string) => rules.filter((rule) => wildcardMatch(rule.action, "shell") && wildcardMatch(rule.resource, command)).at(-1)?.effect
      for (const command of deletions) {
        for (const prefix of ["", "GIT_OPTIONAL_LOCKS=0 ", "A=1 B=2 C=3 D=4 "]) {
          // Non-Git's configured allow is unchanged: no identity inference or
          // new privilege is introduced by the Git-only final ask rules.
          expect(effect(`${prefix}${command}`)).toBe(id === "git" ? "ask" : "allow")
        }
      }
      for (const command of ["git add file", "git commit -m normal", "git push", "git push origin HEAD:refs/heads/topic"]) expect(effect(command)).toBe("allow")
      expect(effect("git push origin main --force")).toBe(id === "git" ? "ask" : "deny")
      expect(effect("git reset --hard")).toBe("deny")
    }
  })
  test("only the authoritative resolved Git identity receives the final force ask", () => {
    const agent = { ...configured, permissions: [{ action: "*", resource: "*", effect: "allow" as const }] }
    const commands = [
      "git push --force origin main", "git push origin main --force", "git push origin --force-with-lease main",
      "git push --force-with-lease=refs/heads/main:abc origin main", "git push -f origin main", "git push origin main -f",
      "git push -vf origin main", "git push origin +HEAD:main", "git -C . push origin main --force",
      "GIT_OPTIONAL_LOCKS=0 git push origin main -f", "A=1 B=2 C=3 D=4 git push origin main --force-with-lease",
    ]
    for (const id of [undefined, "custom", "review-deep", "back-fast", "git"]) {
      const rules = buildAgentPermissions(agent, [], id)
      const effect = (command: string) => rules.filter((rule) => wildcardMatch(rule.action, "shell") && wildcardMatch(rule.resource, command)).at(-1)?.effect
      for (const command of commands) expect(effect(command)).toBe(id === "git" ? "ask" : "deny")
      for (const command of ["git push --follow-tags origin feature", "git push --tags origin feature", "git push --dry-run origin feature"]) expect(effect(command)).toBe("allow")
      for (const command of ["git reset --hard", "A=1 git clean -fd", "git -C . rebase main", "git restore .", "git branch -D topic", "git remote add origin url"]) expect(effect(command)).toBe("deny")
      if (id === "git") {
        expect(effect("git commit --amend -m changed")).toBe("ask")
        expect(effect("git commit -m changed --amend")).toBe("ask")
        expect(effect("A=1 git -C . commit -m changed --amend")).toBe("ask")
        expect(effect("git push origin --delete main")).toBe("ask")
        expect(effect("git push --mirror origin")).toBe("ask")
      }
    }
  })
  test("deny-all writers grant only the exact native claim action", () => {
    const { agents } = loadConfig(process.cwd(), { configRoot: "/nonexistent-gvozd-config", includeProject: false })
    for (const id of ["cartographer", "docs", "devops"]) {
      const agent = agents[id]!
      const rules = buildAgentPermissions(agent, ["context7", "unrelated"], id)
      const effect = (action: string) => rules
        .filter((rule) => wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, "*")).at(-1)?.effect
      expect(agent.fileLease).toBe("writer")
      const denyIndex = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "deny")
      const claimIndex = rules.findIndex((rule) => rule.action === "gvozd_claim" && rule.resource === "*" && rule.effect === "allow")
      expect(denyIndex).toBeGreaterThanOrEqual(0)
      expect(claimIndex).toBeGreaterThan(denyIndex)
      expect(effect("gvozd_claim")).toBe("allow")
      for (const action of ["execute", "gvozd_lease", "gvozd_jev", "gvozd_claim_extra", "unrelated_tool"]) {
        expect(effect(action)).toBe("deny")
      }
      expect(effect("unrelated_tool_from_mcp")).toBe("deny")
      expect(agent.mcp).toEqual(id !== "cartographer" ? ["context7"] : [])
      expect(effect("context7_lookup")).toBe(id !== "cartographer" ? "allow" : "deny")
    }
    // BackFast has no deny-all rule or explicit claim grant: its existing
    // host-default posture is the control, not a new broad permission grant.
    const control = buildAgentPermissions(agents["back-fast"]!, [])
    expect(control.filter((rule) => wildcardMatch(rule.action, "gvozd_claim")).at(-1)).toBeUndefined()
    for (const id of ["explorer", "debugger", "security", "review-fast", "review-deep", "git"]) {
      expect(agents[id]!.fileLease).toBe("readonly")
      expect(buildAgentPermissions(agents[id]!, []).some((rule) => rule.action === "gvozd_claim" && rule.effect === "allow")).toBe(false)
    }
  })

  test("default forge skills do not grant MCP or generic CLI access and reviewers stay read-only", () => {
    const { agents } = loadConfig(process.cwd(), { configRoot: "/nonexistent-gvozd-config", includeProject: false })
    const effect = (id: string, action: string, resource: string) => buildAgentPermissions(agents[id]!, ["gitlab"], id)
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

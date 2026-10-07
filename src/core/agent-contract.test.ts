import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildAgentContext } from "./agent-context"
import { buildAgentPermissions, wildcardMatch } from "./agent-permissions"
import { renderAgent } from "./agent-generation"
import { loadConfig, type PermissionRule } from "./config"

const root = join(import.meta.dir, "../..")
const config = loadConfig(root, { configRoot: "/nonexistent-gvozd-config", includeProject: false })
const roster = {
  master: "coordinator", extreme: "coordinator",
  "back-fast": "writer", "back-deep": "writer", "front-fast": "writer", "front-deep": "writer",
  cartographer: "writer", docs: "writer", devops: "writer",
  planner: "readonly", debugger: "readonly", explorer: "readonly", researcher: "readonly",
  git: "readonly", "review-fast": "readonly", "review-deep": "readonly", security: "readonly",
} as const

function effect(rules: PermissionRule[], action: string, resource: string) {
  return rules.filter((rule) => wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, resource)).at(-1)?.effect
}

function generatedRules(content: string): PermissionRule[] {
  return [...content.matchAll(/  - action: ("[^\n]+")\n    resource: ("[^\n]+")\n    effect: (allow|ask|deny)/g)]
    .map((match) => ({ action: JSON.parse(match[1]!), resource: JSON.parse(match[2]!), effect: match[3] as PermissionRule["effect"] }))
}

describe("all 17 team contracts", () => {
  test("Git rendered and runtime permission rules both ask for remote deletion/prune", () => {
    const agent = config.agents.git!
    const runtime = buildAgentPermissions(agent, [], "git")
    const generated = generatedRules(readFileSync(join(root, ".opencode/agents/git.md"), "utf8"))
    for (const rules of [runtime, generated]) {
      for (const command of [
        "git push origin :topic", "git push origin :refs/heads/topic", "git push origin :refs/tags/tag",
        "git push origin main :topic :other", "git push :", "git push origin :",
        "git push --prune origin", "git push origin main --prune",
        "GIT_OPTIONAL_LOCKS=0 git push origin :topic", "A=1 B=2 C=3 D=4 git -C . push origin --prune",
      ]) expect(effect(rules, "shell", command)).toBe("ask")
      for (const command of ["git add file", "git commit -m normal", "git push origin HEAD:refs/heads/topic"]) expect(effect(rules, "shell", command)).toBe("allow")
      expect(effect(rules, "shell", "git reset --hard")).toBe("deny")
      expect(effect(rules, "shell", "git push origin main --force-with-lease")).toBe("ask")
    }
  })
  test("the table covers the complete built-in roster", () => {
    expect(Object.keys(config.agents).sort()).toEqual(Object.keys(roster).sort())
  })
  for (const [id, role] of Object.entries(roster)) {
    test(`${id}: capabilities, prompt, orientation and generated rules agree`, () => {
      const agent = config.agents[id]!
      expect(agent.fileLease).toBe(role)
      expect(agent.disabled).toBe(false)
      const rules = buildAgentPermissions(agent, [], id)
      const rendered = renderAgent(agent, id)
      expect(generatedRules(rendered)).toEqual(rules)
      expect(readFileSync(join(root, ".opencode/agents", `${id}.md`), "utf8")).toBe(rendered)
      const orientation = buildAgentContext(config, id)!
      expect(orientation.role).toBe(role)
      expect(orientation.text).toContain("/AGENTS.md")
      expect(rendered).toEndWith(`${agent.promptContent!.trim()}\n`)
      if (role === "writer") {
        expect(agent.promptContent).toContain("gvozd_claim")
        expect(agent.promptContent).toContain("lease.shellEscalation")
        expect(orientation.text).toContain("configured ask/deny")
        expect(effect(rules, "gvozd_claim", "*")).not.toBe("deny")
      }
      if (role === "coordinator") expect(orientation.text).toContain("your own shell pauses")
      if (role === "readonly") {
        expect(effect(rules, "edit", "file")).toBe("deny")
        expect(effect(rules, "gvozd_claim", "*")).not.toBe("allow")
        expect(orientation.text).toContain(id === "git" ? "never use direct patch/edit" : "never mutate files")
      }
      if (["review-fast", "review-deep", "security"].includes(id)) {
        expect(agent.promptContent).toContain("no mutation requests or execution")
        expect(agent.promptContent).not.toContain("approval-gated shell for anything mutating")
      }
      expect(effect(rules, "shell", "git reset --hard HEAD~1")).toBe("deny")
      expect(effect(rules, "shell", "git push origin main --force-with-lease")).toBe(id === "git" ? "ask" : "deny")
    })
  }
  test("untrusted Master guidance and nonmutating discovery roles are preserved", () => {
    expect(config.agents.master!.promptContent).toContain("You cannot run shell commands yourself")
    for (const id of ["explorer", "researcher"]) expect(config.agents[id]!.promptContent).toContain("Do not modify files, run shell commands")
    expect(config.agents.extreme!.promptContent).toContain("your own shell pauses")
  })
})

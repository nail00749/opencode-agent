import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentPermissions, wildcardMatch } from "./agent-permissions"
import { loadConfig, type AgentConfig } from "./config"

/**
 * Consistency gate: the static permission copies in defaults/agents/*.jsonc
 * must never let a mutating or destructive command fall through to allow.
 * The runtime rule order is author order with last-match-wins, so evaluation
 * replicates exactly what OpenCode sees per agent.
 */

const projectRoot = join(import.meta.dir, "..")

function shellEffectFor(agent: AgentConfig, command: string): "allow" | "ask" | "deny" | undefined {
  const rules = buildAgentPermissions(agent, [])
    .filter((rule) => rule.action === "shell" && wildcardMatch(rule.resource, command))
  return rules.at(-1)?.effect
}

const corpus: Array<{ command: string; readonly expected: Record<"git" | "review-deep", "allow" | "ask" | "deny" | undefined> }> = [
  // Composed read-only pipelines must not fall through to deny.
  { command: "printf '%s' x", expected: { git: "allow", "review-deep": "allow" } },
  { command: "echo done", expected: { git: "allow", "review-deep": "allow" } },
  // Mutating flag forms must never inherit a read-only allow wildcard.
  { command: "git branch -d merged", expected: { git: "ask", "review-deep": "ask" } },
  { command: "git branch -D feature", expected: { git: "deny", "review-deep": "deny" } },
  { command: "git branch -m old new", expected: { git: "ask", "review-deep": "ask" } },
  { command: "git branch new-branch", expected: { git: "ask", "review-deep": "ask" } },
  { command: "git tag -d v1.0", expected: { git: "ask", "review-deep": "ask" } },
  { command: "git tag v2.0", expected: { git: "ask", "review-deep": "ask" } },
  { command: "git remote rename origin upstream", expected: { git: "ask", "review-deep": "ask" } },
  { command: "git remote prune origin", expected: { git: "ask", "review-deep": "ask" } },
  { command: "git symbolic-ref HEAD refs/heads/other", expected: { git: "ask", "review-deep": "ask" } },
  { command: "git reflog expire --expire=now --all", expected: { git: "ask", "review-deep": "ask" } },
  // The -C flag must not smuggle any mutation past the read-only baseline.
  { command: "git -C . push --force origin main", expected: { git: undefined, "review-deep": "ask" } },
  { command: "git -C . reset --hard", expected: { git: undefined, "review-deep": "ask" } },
  // Destructive commands stay denied for every consumer of the baseline.
  { command: "git reset --hard HEAD~1", expected: { git: "deny", "review-deep": "deny" } },
  { command: "git push --force origin main", expected: { git: "deny", "review-deep": "deny" } },
  { command: "git clean -fd", expected: { git: "deny", "review-deep": "deny" } },
  // Read-only listing forms stay allowed where the role grants them.
  { command: "git status", expected: { git: "allow", "review-deep": "allow" } },
  { command: "git branch", expected: { git: "allow", "review-deep": "allow" } },
  { command: "git branch -a", expected: { git: "allow", "review-deep": "allow" } },
  { command: "git tag", expected: { git: "allow", "review-deep": "allow" } },
  { command: "git tag --list", expected: { git: "allow", "review-deep": "allow" } },
  { command: "git symbolic-ref HEAD", expected: { git: "allow", "review-deep": "allow" } },
  { command: "git stash list", expected: { git: "allow", "review-deep": "allow" } },
  { command: "git worktree list", expected: { git: "allow", "review-deep": "allow" } },
]

describe("writer agent shell permission consistency", () => {
  test("writers pre-approve read-only verification and deny every other shell command", () => {
    const configRoot = mkdtempSync(join(tmpdir(), "agent-gvozd-writer-"))
    try {
      const config = loadConfig(projectRoot, { configRoot, includeProject: false })
      for (const id of ["back-fast", "back-deep", "front-fast", "front-deep"]) {
        const agent = config.agents[id]
        expect(agent).toBeDefined()
        for (const command of ["cargo test *", "bun test", "tsc --noEmit", "git diff *", "wc *", "printf *"]) {
          expect(shellEffectFor(agent!, command)).toBe("allow")
        }
        // Mutations and anything unlisted reach the user as a permission
        // request (the agent can request shell access); destructive Git
        // commands stay denied outright.
        expect(shellEffectFor(agent!, "sed -i s/a/b/ src/a.ts")).toBe("ask")
        expect(shellEffectFor(agent!, "bun install")).toBe("ask")
        expect(shellEffectFor(agent!, "npm publish")).toBe("ask")
        expect(shellEffectFor(agent!, "git push origin main")).toBe("ask")
        expect(shellEffectFor(agent!, "git push --force origin main")).toBe("deny")
        expect(shellEffectFor(agent!, "git reset --hard HEAD~1")).toBe("deny")
      }
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
    }
  })
})

describe("security agent shell permission consistency", () => {
  test("security pre-approves read-only verification like the review agents", () => {
    const configRoot = mkdtempSync(join(tmpdir(), "agent-gvozd-security-"))
    try {
      const config = loadConfig(projectRoot, { configRoot, includeProject: false })
      const agent = config.agents.security
      expect(agent).toBeDefined()
      for (const command of ["git diff *", "git show *", "cargo test *", "cargo clippy *", "bun test", "wc *", "printf *"]) {
        expect(shellEffectFor(agent!, command)).toBe("allow")
      }
      // Mutations stay ask, destructive git stays denied.
      expect(shellEffectFor(agent!, "npm publish")).toBe("ask")
      expect(shellEffectFor(agent!, "git commit -m x")).toBe("ask")
      expect(shellEffectFor(agent!, "git branch -d merged")).toBe("ask")
      expect(shellEffectFor(agent!, "git symbolic-ref HEAD refs/heads/other")).toBe("ask")
      expect(shellEffectFor(agent!, "git reset --hard HEAD~1")).toBe("deny")
      expect(shellEffectFor(agent!, "git push --force origin main")).toBe("deny")
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
    }
  })
})

describe("review agent shell permission consistency", () => {
  test("review-deep and review-fast pre-approve read-only review commands", () => {
    const configRoot = mkdtempSync(join(tmpdir(), "agent-gvozd-review-"))
    try {
      const config = loadConfig(projectRoot, { configRoot, includeProject: false })
      for (const id of ["review-deep", "review-fast"]) {
        const agent = config.agents[id]
        expect(agent).toBeDefined()
        // Deep review legitimately needs diffs and targeted verification runs.
        for (const command of ["git diff *", "git show *", "git log *", "cargo test *", "cargo clippy *", "cargo fmt --check *", "wc *", "printf *", "echo *"]) {
          expect(shellEffectFor(agent!, command)).toBe("allow")
        }
        // Anything unlisted stays ask-level.
        expect(shellEffectFor(agent!, "npm publish")).toBe("ask")
        expect(shellEffectFor(agent!, "bun install")).toBe("ask")
        // Mutating git stays ask, destructive git stays denied.
        expect(shellEffectFor(agent!, "git commit -m x")).toBe("ask")
        expect(shellEffectFor(agent!, "git push origin main")).toBe("ask")
        expect(shellEffectFor(agent!, "git reset --hard HEAD~1")).toBe("deny")
        expect(shellEffectFor(agent!, "git push --force origin main")).toBe("deny")
      }
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
    }
  })
})

describe("git shell permission consistency", () => {
  test("defaults/agents/*.jsonc keep mutations ask and destructive denied", () => {
    const configRoot = mkdtempSync(join(tmpdir(), "agent-gvozd-consistency-"))
    try {
      const config = loadConfig(projectRoot, { configRoot, includeProject: false })
      for (const { command, expected } of corpus) {
        for (const [id, want] of Object.entries(expected)) {
          const agent = config.agents[id]
          expect(agent).toBeDefined()
          const effect = shellEffectFor(agent!, command)
          expect(effect).toBe(want)
        }
      }
    } finally {
      rmSync(configRoot, { recursive: true, force: true })
    }
  })
})

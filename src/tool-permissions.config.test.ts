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

const corpus: Array<{ command: string; readonly expected: Record<"git" | "verifier", "allow" | "ask" | "deny" | undefined> }> = [
  // Mutating flag forms must never inherit a read-only allow wildcard.
  { command: "git branch -d merged", expected: { git: "ask", verifier: "ask" } },
  { command: "git branch -D feature", expected: { git: "deny", verifier: "deny" } },
  { command: "git branch -m old new", expected: { git: "ask", verifier: "ask" } },
  { command: "git branch new-branch", expected: { git: "ask", verifier: "ask" } },
  { command: "git tag -d v1.0", expected: { git: "ask", verifier: "ask" } },
  { command: "git tag v2.0", expected: { git: "ask", verifier: "ask" } },
  { command: "git remote rename origin upstream", expected: { git: "ask", verifier: "ask" } },
  { command: "git remote prune origin", expected: { git: "ask", verifier: "ask" } },
  { command: "git symbolic-ref HEAD refs/heads/other", expected: { git: "ask", verifier: "ask" } },
  { command: "git reflog expire --expire=now --all", expected: { git: "ask", verifier: "ask" } },
  // The -C flag must not smuggle any mutation past the read-only baseline.
  { command: "git -C . push --force origin main", expected: { git: undefined, verifier: "ask" } },
  { command: "git -C . reset --hard", expected: { git: undefined, verifier: "ask" } },
  // Destructive commands stay denied for every consumer of the baseline.
  { command: "git reset --hard HEAD~1", expected: { git: "deny", verifier: "deny" } },
  { command: "git push --force origin main", expected: { git: "deny", verifier: "deny" } },
  { command: "git clean -fd", expected: { git: "deny", verifier: "deny" } },
  // Read-only listing forms stay allowed where the role grants them.
  { command: "git status", expected: { git: "allow", verifier: "allow" } },
  { command: "git branch", expected: { git: "allow", verifier: "allow" } },
  { command: "git branch -a", expected: { git: "allow", verifier: "allow" } },
  { command: "git tag", expected: { git: "allow", verifier: "allow" } },
  { command: "git tag --list", expected: { git: "allow", verifier: "allow" } },
  { command: "git symbolic-ref HEAD", expected: { git: "allow", verifier: "allow" } },
  { command: "git stash list", expected: { git: "allow", verifier: "allow" } },
  { command: "git worktree list", expected: { git: "allow", verifier: "allow" } },
]

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

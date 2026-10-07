import { describe, expect, test } from "bun:test"
import {
  SHELL_NO_ESCALATE_PREFIXES,
  shellMustNotEscalate,
  GIT_FORBIDDEN_PREFIXES,
  GIT_MUTATING_COMMANDS,
  GIT_READONLY_COMMANDS,
  INSPECTION_COMMANDS,
  TOOLCHAIN_COMMANDS,
  exactOnly,
  family,
  gitForbiddenShellDenies,
  gitExceptionalMutationShellAsks,
  gitMutatingShellAsks,
  gitReadonlyShellAllows,
  toolchainShellAllows,
  withEnvPrefixes,
} from "./tool-permissions"
import { buildAgentPermissions, wildcardMatch } from "./agent-permissions"

function resources(rules: { action: string; resource: string; effect: string }[]): string[] {
  return rules.filter((rule) => rule.action === "shell").map((rule) => rule.resource)
}

describe("shell command families", () => {
  test("every family expands to an exact rule and a wildcard rule", () => {
    for (const { exact, wildcard } of [...INSPECTION_COMMANDS, ...TOOLCHAIN_COMMANDS, ...GIT_READONLY_COMMANDS, ...GIT_MUTATING_COMMANDS]) {
      if (wildcard === exact) continue
      expect(wildcard).toBe(`${exact} *`)
    }
  })

  test("exactOnly families never widen to a wildcard", () => {
    const families = exactOnly("git symbolic-ref HEAD")
    expect(families).toEqual([{ exact: "git symbolic-ref HEAD", wildcard: "git symbolic-ref HEAD" }])
  })

  test("family aliases expand each variant independently", () => {
    const expanded = family("bun test", "bun run test")
    expect(expanded.map((entry) => entry.exact)).toEqual(["bun test", "bun run test"])
    expect(expanded.map((entry) => entry.wildcard)).toEqual(["bun test *", "bun run test *"])
  })
})

describe("cross-toolchain verification baseline", () => {
  const allows = toolchainShellAllows()

  test("covers the runtimes a verification role may encounter", () => {
    for (const command of [
      "bun test", "bun test *", "npm run build", "cargo test *", "go test ./...",
      "pytest *", "mvn verify *", "./gradlew check *", "make test *", "tsc --noEmit",
    ]) {
      expect(resources(allows)).toContain(command)
    }
  })

  test("never allows package installation or publishing", () => {
    const allowed = resources(allows)
    for (const forbidden of ["npm install", "npm publish", "bun install", "cargo publish", "pip install"]) {
      expect(allowed.some((resource) => wildcardMatch(resource, forbidden))).toBe(false)
    }
  })
})

describe("git permission families", () => {
  test("exceptional push asks cover empty-source refspecs and prune, not ordinary refspecs", () => {
    const asks = gitExceptionalMutationShellAsks()
    for (const command of [
      "git push origin :topic", "git push origin :refs/heads/topic", "git push origin :refs/tags/tag",
      "git push origin main:main :topic :refs/tags/tag", "git push :", "git push origin :",
      "git push --prune origin", "git push origin --prune", "git push origin main --prune",
      "git -C . push origin :topic", "A=1 B=2 C=3 D=4 git -C . push origin --prune",
    ]) expect(asks.some((rule) => rule.effect === "ask" && wildcardMatch(rule.resource, command))).toBe(true)
    for (const command of ["git push", "git push origin main", "git push origin HEAD:refs/heads/topic", "git push origin refs/tags/tag:refs/tags/tag"]) {
      expect(asks.some((rule) => wildcardMatch(rule.resource, command))).toBe(false)
    }
    // These are resource globs, not shell parsing: quoting and wrappers remain
    // unsupported. Four rendered prefixes are not an enforced assignment count:
    // '*' absorbs spaces, so additional assignments can conservatively ask too.
    expect(asks.some((rule) => wildcardMatch(rule.resource, "git push origin ':topic'"))).toBe(false)
    expect(asks.some((rule) => wildcardMatch(rule.resource, "env git push origin --prune"))).toBe(false)
    expect(asks.some((rule) => wildcardMatch(rule.resource, "A=1 B=2 C=3 D=4 E=5 git push origin --prune"))).toBe(true)
  })
  test("read-only allows cover bare commands and their argument forms", () => {
    const allowed = resources(gitReadonlyShellAllows())
    // Bare `git status` must match: session 0.1.2 needed a manual approval for it.
    expect(wildcardMatch("git status", "git status")).toBe(true)
    expect(allowed).toContain("git status")
    expect(allowed).toContain("git status *")
    expect(allowed).toContain("git diff")
  })

  test("the -C flag does not smuggle mutations through the read-only baseline", () => {
    const allowed = resources(gitReadonlyShellAllows())
    for (const smuggled of ["git -C", "git -C *"]) {
      expect(allowed).not.toContain(smuggled)
    }
    expect(allowed.some((resource) => wildcardMatch(resource, "git -C . push --force origin main"))).toBe(false)
    expect(allowed.some((resource) => wildcardMatch(resource, "git -C . reset --hard"))).toBe(false)
  })

  test("mutations are ask, not allow", () => {
    const asks = resources(gitMutatingShellAsks().filter((rule) => rule.effect === "ask"))
    expect(asks).toContain("git push")
    expect(asks).toContain("git push *")
    expect(asks).toContain("GIT_OPTIONAL_LOCKS=0 git commit *")
  })

  test("destructive git commands deny last", () => {
    const denied = gitForbiddenShellDenies().map((rule) => rule.resource)
    for (const prefix of GIT_FORBIDDEN_PREFIXES) {
      expect(denied).toContain(`${prefix}*`)
    }
  })
})

describe("env prefix expansion", () => {
  test("withEnvPrefixes prefixes both exact and wildcard resources", () => {
    const expanded = withEnvPrefixes({ action: "shell", resource: "git push *", effect: "ask" })
    expect(expanded).toEqual([
      { action: "shell", resource: "GIT_OPTIONAL_LOCKS=0 git push *", effect: "ask" },
    ])
  })
})

describe("buildAgentPermissions env duplication", () => {
  test("authoritative git rules gain env-prefixed twins automatically", () => {
    const rules = buildAgentPermissions(
      {
        skills: [],
        mcp: [],
        permissions: [
          { action: "shell", resource: "git status", effect: "allow" },
          { action: "shell", resource: "git status *", effect: "allow" },
        ],
      },
      [],
    )
    const allowResources = rules.filter((rule) => rule.effect === "allow").map((rule) => rule.resource)
    expect(allowResources).toContain("GIT_OPTIONAL_LOCKS=0 git status")
    expect(allowResources).toContain("GIT_OPTIONAL_LOCKS=0 git status *")
    // Non-git rules are not duplicated.
    expect(allowResources.filter((resource) => resource.includes("GIT_OPTIONAL_LOCKS=0")).length).toBe(2)
  })

  test("existing GIT_-prefixed authored rules are not double-prefixed", () => {
    const rules = buildAgentPermissions(
      {
        skills: [],
        mcp: [],
        permissions: [{ action: "shell", resource: "GIT_OPTIONAL_LOCKS=0 git status", effect: "allow" }],
      },
      [],
    )
    const all = rules.map((rule) => rule.resource)
    expect(all).toContain("GIT_OPTIONAL_LOCKS=0 git status")
    expect(all.filter((resource) => resource.startsWith("GIT_OPTIONAL_LOCKS=0")).length).toBe(1)
  })

  test("forbidden prefixes deny the destructive forms", () => {
    const denied = gitForbiddenShellDenies().map((rule) => rule.resource)
    for (const prefix of GIT_FORBIDDEN_PREFIXES) {
      expect(denied).toContain(`${prefix}*`)
    }
    expect(GIT_READONLY_COMMANDS.length).toBeGreaterThan(0)
    expect(GIT_MUTATING_COMMANDS.length).toBeGreaterThan(0)
  })
})

describe("shellMustNotEscalate", () => {
  test("flags destructive git forms including env-prefixed and suffixed variants", () => {
    for (const command of [
      "git push --force origin main",
      "git push -f",
      "git push origin main --force-with-lease",
      "git push origin main -f",
      "git -C . push origin main --force",
      "A=1 B=2 C=3 D=4 git push origin main --force",
      "git reset --hard HEAD~1",
      "git rebase main",
      "git clean -fd",
      "GIT_OPTIONAL_LOCKS=0 git filter-branch master",
      "git branch -D feature",
      "git remote set-url origin https://example.com/repo.git",
    ]) {
      expect(shellMustNotEscalate([command])).toBe(true)
    }
  })

  test("flags system-wrecking commands", () => {
    for (const command of ["sudo make install", "rm -rf /", "rm -rf /usr/local/bin", "mkfs.ext4 /dev/sda1", "chmod -R 777 /etc"]) {
      expect(shellMustNotEscalate([command])).toBe(true)
    }
  })

  test("passes verification and ordinary mutation commands", () => {
    for (const command of ["bun test", "cargo test", "bun install", "curl https://example.com", "git push", "git rebase --abort", "git rebase --continue", "npm publish"]) {
      expect(shellMustNotEscalate([command])).toBe(false)
    }
    expect(shellMustNotEscalate([])).toBe(false)
  })

  test("escalates only when every resource is safe", () => {
    // One unsafe resource in a multi-command call blocks escalation for the
    // whole batch — an agent must not smuggle a destructive command behind
    // an approved read-only one.
    expect(shellMustNotEscalate(["bun test", "bun install"])).toBe(false)
    expect(shellMustNotEscalate(["git reset --hard"])).toBe(true)
    expect(shellMustNotEscalate(["bun test", "git reset --hard"])).toBe(true)
    expect(shellMustNotEscalate(["git rebase --abort", "git reset --hard"])).toBe(true)
  })

  test("covers the whole protected deny set", () => {
    expect(SHELL_NO_ESCALATE_PREFIXES).toContain("git push --force")
    expect(SHELL_NO_ESCALATE_PREFIXES.length).toBeGreaterThan(GIT_FORBIDDEN_PREFIXES.length)
  })
})

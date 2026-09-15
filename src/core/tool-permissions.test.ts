import { describe, expect, test } from "bun:test"
import {
  GIT_FORBIDDEN_PREFIXES,
  GIT_MUTATING_COMMANDS,
  GIT_READONLY_COMMANDS,
  INSPECTION_COMMANDS,
  TOOLCHAIN_COMMANDS,
  exactOnly,
  family,
  gitForbiddenShellDenies,
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

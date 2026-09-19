import type { PermissionRule } from "./config"

/**
 * Toolchain-agnostic command families used to build `shell` permission rules.
 * The goal is to cover the commands implementation and verification work
 * legitimately needs across languages, while keeping mutations behind `ask`
 * and destructive commands denied by the trailing catch-all rules.
 *
 * Note on matching: OpenCode permission resources are matched with the same
 * wildcard semantics as {@link wildcardMatch} in `agent-permissions.ts`.
 * A pattern ending in " *" does NOT match the bare command, so every family
 * expands to an exact rule plus a wildcard rule.
 */
export interface ShellCommandFamily {
  /** Exact command with no trailing arguments, e.g. `bun test`. */
  exact: string
  /** The same command with arbitrary trailing arguments, e.g. `bun test *`. */
  wildcard: string
}

export function family(command: string, ...variants: string[]): ShellCommandFamily[] {
  return [command, ...variants].map((entry) => ({
    exact: entry,
    wildcard: `${entry} *`,
  }))
}

/**
 * Read-only commands whose wildcard form would be unsafe. `exactOnly` never
 * widens, so an argument form can never inherit the read-only effect. Use for
 * subcommands whose trailing arguments turn a read into a write, such as
 * `git symbolic-ref HEAD` (query) versus `git symbolic-ref HEAD refs/heads/x`
 * (moves HEAD).
 */
export function exactOnly(command: string, ...variants: string[]): ShellCommandFamily[] {
  return [command, ...variants].map((entry) => ({ exact: entry, wildcard: entry }))
}

/**
 * Read-only inspection utilities that never mutate project files. Kept
 * language-neutral on purpose so verification roles work in any stack.
 */
export const INSPECTION_COMMANDS: ShellCommandFamily[] = [
  ...family("pwd", "true", "test"),
  ...family("cat", "head", "tail", "wc", "sort", "uniq"),
  ...family("grep", "rg", "find", "diff", "cmp"),
  ...family("ls", "du", "df", "stat", "file", "realpath", "basename", "dirname"),
  ...family("shasum", "sha256sum", "md5sum"),
  ...family("uname", "whoami", "hostname", "date", "printenv"),
  ...family("which", "command -v"),
  ...family("mktemp"),
  ...family("tr", "cut", "paste", "column"),
  ...family("node --version", "python3 --version", "python --version", "deno --version"),
]

/**
 * Build, test, lint, and package commands grouped by ecosystem. Each entry is
 * safe for verification and implementation roles: it compiles, tests, or
 * inspects. Package-manager install/publish mutations stay behind `ask` rules
 * declared per agent, never in this baseline.
 */
export const TOOLCHAIN_COMMANDS: ShellCommandFamily[] = [
  // JavaScript / TypeScript runtimes and package managers (test + build paths)
  ...family("bun test", "bun run test", "bun --version"),
  ...family("bun run typecheck", "bun run lint", "bun run build", "bun run check"),
  ...family("tsc --noEmit", "npx tsc --noEmit"),
  ...family("eslint", "biome check", "prettier --check"),
  ...family("npm test", "npm run test", "npm run typecheck", "npm run lint", "npm run build"),
  ...family("pnpm test", "pnpm run test", "pnpm run build"),
  ...family("yarn test", "yarn build"),
  ...family("vitest run", "jest", "playwright test"),
  // Rust
  ...family("cargo check", "cargo test", "cargo build", "cargo clippy", "cargo fmt --check", "cargo --version"),
  // Go
  ...family("go build ./...", "go test ./...", "go vet ./...", "go version"),
  // Python
  ...family("pytest", "python3 -m pytest", "python -m pytest"),
  ...family("ruff check", "mypy", "pyright"),
  // JVM
  ...family("mvn test", "mvn verify", "gradle test", "gradle check", "./gradlew test", "./gradlew check"),
  // Generic build entrypoints
  ...family("make test", "make check", "make build", "make --version"),
  ...family("just --list"),
]

/** Git read-only subcommand families shared by git and other read-only agents. */
export const GIT_READONLY_COMMANDS: ShellCommandFamily[] = [
  ...family(
    "git status",
    "git status --short",
    "git status --short --branch",
    "git status --porcelain",
    "git status --porcelain=v1 --branch",
  ),
  ...family("git diff", "git diff --stat", "git diff --cached", "git diff --check"),
  ...family("git log", "git show"),
  ...family("git rev-parse", "git rev-list", "git show-ref", "git cat-file"),
  // symbolic-ref reads HEAD only in its argument-less query form; a ref
  // argument rewrites HEAD, so this family must never widen to a wildcard.
  ...exactOnly("git symbolic-ref HEAD", "git symbolic-ref --short HEAD"),
  ...family("git ls-files", "git ls-remote", "git grep"),
  // Bare subcommands list their objects and stay exact-only; flag mutations
  // (-d/-m/-c, tag create/delete, remote rename/prune, reflog expire) fall
  // through to ask rules instead of inheriting these read-only allows.
  ...exactOnly("git branch", "git tag", "git remote", "git reflog"),
  ...family(
    "git branch --list", "git branch -l", "git branch -a", "git branch -r", "git branch -v", "git branch -vv",
    "git branch --all", "git branch --remotes", "git branch --show-current", "git branch --contains",
  ),
  ...family("git tag --list", "git tag -l", "git tag -n"),
  ...family("git remote -v", "git remote --verbose", "git remote show", "git remote get-url"),
  ...family("git reflog show"),
  ...family("git stash list", "git describe", "git worktree list"),
  ...family("git config --get", "git config --get-regexp"),
]

/** Git mutations that still require per-call approval. */
export const GIT_MUTATING_COMMANDS: ShellCommandFamily[] = [
  ...family("git add", "git rm --cached"),
  ...family("git commit", "git merge --ff-only", "git merge --no-ff"),
  ...family("git push", "git fetch", "git pull --ff-only"),
  ...family("git stash", "git cherry-pick", "git revert"),
  ...family("git switch", "git checkout -b", "git worktree add"),
  // Every other branch/tag/remote/symbolic-ref/reflog form mutates state
  // (create, delete, rename, move HEAD, expire reflog). The exact-only
  // wildcards below make each ask-level; the read-only families that follow
  // in GIT_READONLY_COMMANDS override the listing forms because allows are
  // ordered after asks in the generated rules.
  ...exactOnly("git branch *", "git tag *", "git remote *", "git symbolic-ref *", "git reflog *"),
]

/** Git commands this plugin never allows a delegated agent to run. */
export const GIT_FORBIDDEN_PREFIXES: string[] = [
  "git push --force",
  "git push -f",
  "git reset --hard",
  "git clean",
  "git filter-branch",
  "git filter-repo",
  "git rebase",
  "git checkout --",
  "git restore",
  "git branch -D",
  "git remote remove",
  "git remote set-url",
  "git remote add",
]

/**
 * Shell commands that must never escalate from a lease-policy denial to a
 * user-facing `ask`: a user prompt cannot be the only guard for command
 * families that rewrite history, destroy worktrees, or wreck systems. When
 * shell escalation is enabled these stay denials even though the surrounding
 * policy turned into `ask`. Entries ending in `*` match by prefix; the others
 * match the bare command or the command with trailing arguments.
 */
export const SHELL_NO_ESCALATE_PREFIXES: readonly string[] = [
  ...GIT_FORBIDDEN_PREFIXES,
  "sudo*",
  "rm -rf /*",
  "mkfs*",
  "dd if=*",
  "chmod -R 777 /*",
]

/**
 * Environment prefixes that keep Git from taking filesystem locks. Rules are
 * duplicated for these prefixes so agents that set them explicitly still match
 * the allow-list instead of falling through to `ask`.
 */
export const GIT_ENV_PREFIXES: readonly string[] = ["GIT_OPTIONAL_LOCKS=0"]

/** Expand one shell rule into its env-prefixed twins. */
export function withEnvPrefixes(
  rule: Pick<PermissionRule, "action" | "resource" | "effect">,
  prefixes: readonly string[] = GIT_ENV_PREFIXES,
): PermissionRule[] {
  return prefixes.map((prefix) => ({
    action: rule.action,
    resource: `${prefix} ${rule.resource}`,
    effect: rule.effect,
  }))
}

function expand(groups: readonly ShellCommandFamily[][], effect: "allow" | "ask"): PermissionRule[] {
  const rules: PermissionRule[] = []
  for (const group of groups) {
    for (const { exact, wildcard } of group) {
      rules.push({ action: "shell", resource: exact, effect })
      if (wildcard !== exact) rules.push({ action: "shell", resource: wildcard, effect })
    }
  }
  return rules
}

/**
 * Shared read-only shell baseline for agents that must run builds, tests, and
 * inspections without per-command approval. Deliberately cross-toolchain.
 */
export function toolchainShellAllows(): PermissionRule[] {
  return expand([INSPECTION_COMMANDS, TOOLCHAIN_COMMANDS], "allow")
}

/** Read-only Git shell allows (used by the git and other read-only agents). */
export function gitReadonlyShellAllows(): PermissionRule[] {
  return expand([GIT_READONLY_COMMANDS], "allow")
}

/** Ask-level rules for Git mutations, including their env-prefixed twins. */
export function gitMutatingShellAsks(): PermissionRule[] {
  const rules = expand([GIT_MUTATING_COMMANDS], "ask")
  return rules.flatMap((rule) => [rule, ...withEnvPrefixes(rule)])
}

/** Deny-level trailing rules for destructive Git commands (last-match-wins). */
export function gitForbiddenShellDenies(): PermissionRule[] {
  return GIT_FORBIDDEN_PREFIXES.map((prefix) => ({
    action: "shell",
    resource: `${prefix}*`,
    effect: "deny",
  }))
}

/** Strip leading `KEY=VALUE ` environment assignments from a command string. */
function stripEnvPrefixes(command: string): string {
  let current = command
  for (let index = 0; index < 4; index++) {
    const stripped = current.replace(/^\S+=("[^"]*"|'[^']*'|\S*)\s+/, "")
    if (stripped === current) break
    current = stripped
  }
  return current
}

/**
 * Recovery forms that sit inside a denied family but are legitimate
 * bookkeeping, mirroring the trailing re-allow rules in the trusted mode —
 * an interrupted rebase must stay escapable for cleanup.
 */
export const SHELL_ESCALATE_ANYWAY_SUFFIXES: readonly string[] = [
  "git rebase --abort*",
  "git rebase --continue*",
  "git rebase --quit*",
]

function nativeShellPattern(prefix: string): string {
  return prefix.includes("*") ? prefix : `${prefix}*`
}

function withAssignmentPrefixes(resource: string): string[] {
  const resources = [resource]
  let prefix = ""
  for (let index = 0; index < 4; index++) {
    prefix += "*=* "
    resources.push(`${prefix}${resource}`)
  }
  return resources
}

/**
 * Native session rules mirroring {@link shellMustNotEscalate}. They sit after
 * broad shell grants so persisted trusted/override policies remain safe even
 * before the plugin's runtime hook has rehydrated after a host reload.
 * Assignment-prefixed forms cover the same bounded prefix depth as the
 * runtime normalizer; recovery rules intentionally come last.
 */
export function shellNeverEscalateRules(recoveryEffect: "allow" | "ask" = "allow"): PermissionRule[] {
  const denies = SHELL_NO_ESCALATE_PREFIXES.flatMap((prefix) =>
    withAssignmentPrefixes(nativeShellPattern(prefix)).map((resource): PermissionRule => ({
      action: "shell",
      resource,
      effect: "deny",
    })))
  const recovery = SHELL_ESCALATE_ANYWAY_SUFFIXES.flatMap((resource) =>
    withAssignmentPrefixes(resource).map((prefixed): PermissionRule => ({
      action: "shell",
      resource: prefixed,
      effect: recoveryEffect,
    })))
  return [...denies, ...recovery]
}

/**
 * True when the whole shell call must stay denied — the lease policy never
 * converts it into a user `ask`. A call escalates only when **every**
 * resource is outside the never-escalate families; one destructive command
 * in a multi-command batch blocks escalation for the whole call so an agent
 * cannot smuggle it behind an approved read-only one. Matches the resource
 * text (lowercased, leading env assignments removed) with the same
 * literal-prefix semantics as the generated deny rules — resource matching,
 * not shell syntax parsing. Recovery forms are checked first so an
 * interrupted rebase cleanup can still reach the user prompt.
 */
export function shellMustNotEscalate(resources: readonly string[]): boolean {
  if (resources.length === 0) return false
  const matches = (patterns: readonly string[], command: string): boolean =>
    patterns.some((prefix) => {
      const star = prefix.indexOf("*")
      if (star >= 0) return command.startsWith(prefix.slice(0, star))
      return command === prefix || command.startsWith(`${prefix} `)
    })
  const commands = resources.map((resource) => stripEnvPrefixes(resource.toLowerCase()))
  if (commands.some((command) => matches(SHELL_ESCALATE_ANYWAY_SUFFIXES, command))) return false
  return commands.some((command) => matches(SHELL_NO_ESCALATE_PREFIXES.map((prefix) => prefix.toLowerCase()), command))
}

# agent-gvozd

OpenCode V2 plugin that installs a small agent team:

- `master` — primary coordinator
- `planner` — read-only planning subagent
- `back-fast` / `back-deep` — fast and deep backend implementation tiers
- `front-fast` / `front-deep` — fast and deep frontend implementation tiers
- `review-fast` / `review-deep` — fast and deep read-only review tiers
- `researcher` — source-backed internet research
- `explorer` — read-only local file and execution-path discovery
- `git` — focused Git inspection and explicitly authorized operations
- `docs` — documentation, examples, and migration notes
- `verifier` — independent build, runtime, and manual scenario verification
- `debugger` — read-only root-cause investigation
- `security` — read-only security and trust-boundary review
- `devops` — CI, Docker, infrastructure, deployment, and release configuration

The project targets the exact OpenCode beta version declared in `package.json`.

## Development setup

```bash
bun install
bun run sync
opencode2 service restart
```

`bun run sync` materializes the resolved configuration as native
`.opencode/agents/*.md` files and installs the local plugin entrypoint at
`.opencode/plugins/agent-gvozd/index.ts`. OpenCode V2 discovers that entrypoint
automatically.

Run `bun run sync --check` to report drift without changing files. The command
prints a diff before replacing or removing an existing generated agent and
never overwrites an agent file it does not own.

Run `bun test`, `bun run typecheck`, and `bun run build` for local verification.

## Configuration layers

Configuration is merged in this order:

1. package defaults in `defaults/default.jsonc` and `defaults/agents/*.jsonc`
2. global overrides in `~/.config/opencode/gvozd/config.jsonc` and its `agents/` directory
3. project overrides in `<project>/docs/.gvozd/config.jsonc` and its `agents/` directory

Later scalar values replace earlier values. Arrays such as `models`, `skills`,
`mcp`, and `permissions` replace the complete earlier array.

## Cooperative file leases

Writer agents coordinate exact project files before editing them. The default
roles are:

- `master`: `coordinator`
- backend, frontend, Docs, and DevOps agents: `writer`
- planning, exploration, review, research, Git, verification, debugging, and
  security agents: `readonly`

Custom agents default to `readonly`. Set `fileLease` explicitly when a custom
agent must write:

```jsonc
{
  "agents": {
    "custom-writer": {
      "fileLease": "writer"
    }
  }
}
```

Before parallel writer delegation, Master asks Explorer for the exact existing
and planned files in each independent work package. Master reserves each set
with `gvozd_lease` and passes the returned `leaseId` to the matching writer.
The writer calls `gvozd_claim` before its first mutation. Overlapping
reservations fail immediately, and `edit`, `write`, or `apply_patch` targets
outside the claimed lease are denied.

Writer and coordinator agents cannot use arbitrary shell commands because
shell writes cannot be safely inferred from command text. Verifier runs builds
and tests only after active writer leases are released. If a writer discovers
another required file, it reports the exact path to Master, which can extend
the lease after a conflict check or serialize the work.

Leases are in-memory and protect child sessions within one OpenCode server
process. Unclaimed reservations expire after five minutes; active leases expire
after thirty minutes without tool activity and are released on terminal session
events. Separate OpenCode processes and remote hosts are not coordinated.

An agent override can be inline:

```jsonc
{
  "$schema": "./schema.json",
  "defaultAgent": "master",
  "agents": {
    "review-deep": {
      "models": [
        "openai/gpt-5.6-sol",
        "openai/gpt-5.6-luna"
      ],
      "skills": ["code-review"],
      "mcp": ["gitlab"]
    }
  }
}
```

Or it can live in `docs/.gvozd/agents/review-deep.jsonc`. Relative prompt paths
are resolved from the file that declares them. Prompt files and a custom
`agentsDirectory` must remain inside the configuration layer that owns them;
sync rejects symlinked output directories and files.

`skills` contains exact skill IDs. `mcp` contains MCP server names; the plugin
converts them to the V2 `<server>_*` permission action. Use explicit
`permissions` with a matching normalized action (for example,
`gitlab_get_issue`) when an agent should receive only selected tools from a
server. If an MCP action can match more than one normalized server prefix,
access to that ambiguous action is denied.

## Default capabilities

The built-in team uses exact skill IDs and tool-level MCP permissions from the
current OpenCode setup. Server-wide `mcp` grants remain empty by default because
GitLab, GitNexus, and Playwright each expose actions that are too broad for at
least one receiving role.

| Agents | Skills | MCP access |
| --- | --- | --- |
| `planner` | verification planning, ASCII UI review, GitNexus impact | GitNexus read-only |
| `back-deep` | GitNexus impact and refactoring | GitNexus except group sync |
| `front-fast` | modern web and interface polish | Playwright observation; interactions ask |
| `front-deep` | frontend/layout skills plus GitNexus impact/refactoring | GitNexus except group sync; Playwright interactions ask |
| `review-fast` | code review | read-only GitLab without CI variables |
| `review-deep` | code review and GitNexus review/impact | read-only GitLab and GitNexus |
| `explorer` | GitNexus exploration | GitNexus read-only |
| `git` | none | GitLab reads; mutations ask; CI variables denied |
| `verifier` | verification before completion | read-only GitNexus; Playwright interactions ask |
| `debugger` | systematic debugging and GitNexus debugging/PDG | read-only GitNexus; Playwright interactions ask |
| `security` | code review and GitNexus taint/PDG | read-only GitLab/GitNexus; Playwright interactions ask |
| `devops` | verification before completion | GitLab reads and CI validation; mutations ask; CI variables denied |

`master`, `back-fast`, `researcher`, and `docs` intentionally keep their
existing narrow capability sets. TDD skills are not enabled implicitly.

## Model order

`models` is an ordered preference list. During plugin activation, agent-gvozd
selects the first enabled model and variant present in the OpenCode catalog. If
none is currently catalogued, it preserves the first configured model so that
OpenCode can report the underlying availability problem.

OpenCode V2 currently exposes only one model on an agent and does not expose a
safe hook for replacing that model inside an already dispatched provider
request. The ordered list therefore handles activation-time availability; an
outage or rate limit after dispatch still follows OpenCode's own retry policy.

## Fast and deep routing

Fast workers and reviewers prefer `openai/gpt-5.6-luna` with
`openai/gpt-5.6-sol` as fallback. Deep agents use the reverse order. Master
selects the tier from task complexity and risk: localized, clear, low-risk
changes go to fast; ambiguous, cross-module, security-sensitive, migration,
concurrency, or otherwise material work goes to deep. Review depth is selected
independently from implementation depth.

Researcher, Git, and Docs prefer `openai/gpt-5.6-luna` with
`openai/gpt-5.6-sol` as fallback. Explorer prefers
`openai/gpt-5.3-codex-spark` with `openai/gpt-5.6-luna` as fallback. Researcher
is restricted to web search and fetch tools; Explorer is restricted to local
glob, grep, and read tools. Git allows common read-only Git commands and asks
for approval before diff/history inspection or any mutating Git command. Docs
can edit Markdown and files under `docs/`; edits elsewhere require approval,
and shell access is denied.

Verifier uses `openai/gpt-5.6-luna` with `openai/gpt-5.6-sol` as fallback.
Debugger, Security, and DevOps use the reverse order. Verifier, Debugger, and
Security are read-only and require approval for shell commands. DevOps can edit
common CI, Docker, and infrastructure paths; other edits and every shell or
external mutation require approval.

This pre-release change replaces the earlier single-tier agent IDs. Existing
global or project overrides must be split explicitly:

| Previous ID | New IDs |
| --- | --- |
| `backender` | `back-fast`, `back-deep` |
| `frontend` | `front-fast`, `front-deep` |
| `reviewer` | `review-fast`, `review-deep` |

There are no automatic aliases because copying one override to both tiers could
silently give them the same model order and defeat complexity-based routing.

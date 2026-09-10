# agent-gvozd

OpenCode V2 plugin that installs a small agent team:

- `master` — primary coordinator
- `planner` — read-only planning subagent
- `back-fast` / `back-deep` — fast and deep backend implementation tiers
- `front-fast` / `front-deep` — fast and deep frontend implementation tiers
- `review-fast` / `review-deep` — fast and deep read-only review tiers

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

## Configuration layers

Configuration is merged in this order:

1. package defaults in `defaults/default.jsonc` and `defaults/agents/*.jsonc`
2. global overrides in `~/.config/opencode/gvozd/config.jsonc` and its `agents/` directory
3. project overrides in `<project>/docs/.gvozd/config.jsonc` and its `agents/` directory

Later scalar values replace earlier values. Arrays such as `models`, `skills`,
`mcp`, and `permissions` replace the complete earlier array.

An agent override can be inline:

```jsonc
{
  "$schema": "./schema.json",
  "defaultAgent": "master",
  "agents": {
    "review-deep": {
      "models": [
        "openai/gpt-5.6-sol",
        "openai/gpt-5.3-codex-spark"
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

Fast workers and reviewers prefer `openai/gpt-5.3-codex-spark` with
`openai/gpt-5.6-sol` as fallback. Deep agents use the reverse order. Master
selects the tier from task complexity and risk: localized, clear, low-risk
changes go to fast; ambiguous, cross-module, security-sensitive, migration,
concurrency, or otherwise material work goes to deep. Review depth is selected
independently from implementation depth.

This pre-release change replaces the earlier single-tier agent IDs. Existing
global or project overrides must be split explicitly:

| Previous ID | New IDs |
| --- | --- |
| `backender` | `back-fast`, `back-deep` |
| `frontend` | `front-fast`, `front-deep` |
| `reviewer` | `review-fast`, `review-deep` |

There are no automatic aliases because copying one override to both tiers could
silently give them the same model order and defeat complexity-based routing.

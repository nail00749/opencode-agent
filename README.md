# Gvozd for OpenCode V2

Gvozd installs one permission-aware agent team globally, so every OpenCode
project can use it without copying plugin or agent files into the repository.
Release `0.3.3` targets OpenCode V2 `2.0.*` — any 2.0.x patch release,
including the plugin-API split in 2.0.4.

Contributors and agents: see `AGENTS.md` for workflow rules and
`docs/architecture.md` for the codebase map.

## What is new in 0.3.3

- **Stable TUI action dialog.** Clicking the Gvozd team section now opens its
  actions after mouse release, so the triggering click cannot immediately
  close the dialog.
- **Setup keeps valid model choices.** A repeated interactive setup now offers
  to retain the existing model profile or start model selection again.

<details>
<summary>What was new in 0.3.2</summary>

- **Visible shell state and direct session controls.** The sidebar always shows
  the active permission mode and effective shell state. Click `gvozd` to allow
  ordinary shell commands without prompts for the current session or reset to
  the agent policy. Destructive Git remains denied.
- **TUI RPC calls fixed.** Roster and lease requests now send the explicit
  empty input required across the supported OpenCode 2.0.x line, preventing the
  HTTP 400 that left the sidebar empty. The asynchronous roster also updates
  reactively when its response arrives.

</details>

<details>
<summary>What was new in 0.3.1</summary>

- **Works across the whole 2.0.x line.** OpenCode 2.0.4 split the plugin's
  `ctx.catalog` domain into top-level `ctx.model` / `ctx.provider` domains,
  renamed `catalog.updated` to `model.updated` / `provider.updated`, and
  removed `permission.rules`. The plugin detects the surface the host actually
  provides and enforces session postures through the `evaluate` hook, so one
  build runs on 2.0.2 through 2.0.4+ without crashing.
- **Session permission toggles** (`/gvozd-perms`): a checkbox list for shell,
  edit, skill, and MCP access. `[ ]` means the agent policy decides, `[x]`
  means the session overrides it; selecting a row cycles
  `inherit → allow → ask → deny`. Session-only — nothing is written to disk,
  and destructive shell commands stay denied regardless of the toggle.
- **Shell escalation**: a shell command blocked by the file-lease policy now
  surfaces a normal permission request by default instead of a hard deny.
  Destructive Git and system-wrecking commands never escalate; set
  `lease.shellEscalation: "deny"` to restore the old block.
- **Agent orientation and server-side roster**: each agent is told its lease
  role and how to request a blocked command, and the TUI team section reads the
  resolved roster (agent → model, including disabled agents) from the server.
- **Host version check at runtime.** The plugin reads `ctx.app.version` and
  warns when the host is outside the supported range instead of failing with an
  obscure error.
- **Compatible binary selection in the CLI.** `gvozd setup`, `doctor`, and the
  rest now version-check every known binary (`opencode2`, `opencode`), prefer
  the newest compatible one, and fail with an actionable message when only an
  incompatible build (for example a V1 `opencode`) is present.

</details>

<details>
<summary>What was new in 0.3.0</summary>

- **Layered codebase**: `core/`, `shared/`, `rpc/`, `plugin/`, `tui/`, `cli/`
  with an enforced dependency direction; stable build artifacts unchanged.
- **`gvozd analyze <sessionID>`**: Markdown/JSON session export for agent
  handoff and review — timeline, tool calls, permission denials.
- **TUI team roster**: sidebar section showing which agent runs on which
  model in the current project.
- **Review lifecycle**: writers iterate to a solved, verified state before
  reporting; review happens once, before the commit boundary.
- **oxlint** zero-warning gate in CI and `prepublishOnly`.
- **TUI mode panel fixed**: `/gvozd-mode` now uses a real selectable list, so
  choosing a posture with arrow keys + Enter applies it (previously the apply
  action was unreachable).

</details>

<details>
<summary>What was new in 0.2.x</summary>

- **File-lease verification for writers**: Back Fast, Back Deep, Front Fast,
  and Front Deep hold the read-only toolchain shell baseline (tests, builds,
  typecheck, lint) and verify their own changes while their lease is active;
  mutating shell stays denied.
- **Verifier removed**: writers verify themselves; routing text, permissions,
  and the model profile no longer reference the agent.
- **TUI plugin** (`./tui` export): a session sidebar section with subagent
  tree, skills, permission history (durable across restarts), and tool
  statistics, plus `/gvozd` (insights), `/gvozd-dryrun` (permission dry run
  per pipeline segment), `/gvozd-leases` (lease snapshot), and `/gvozd-mode`
  (session permission posture).
- **Permission dry run RPC** (`gvozd-permissions`): evaluates the exact
  effect a ruleset produces for a hypothetical call.
- **Lease snapshot RPC** (`gvozd-leases`): lists active and reserved leases
  with owners and TTLs.
- **Session trust modes RPC** (`gvozd-mode`): switch a session between
  balanced, trusted (full shell; destructive Git stays denied), and strict
  postures; child sessions inherit the mode.
- **`gvozd agents`** CLI: list the resolved team and disable or enable
  built-in agents in the managed global config.
- **OpenCode `2.0.*` compatibility range** instead of an exact patch pin.
- **Unconfigured agents may edit while no writer leases are active** instead
  of a hard edit deadlock; parallel writer protection is unchanged.
</details>

## Global setup

Run the guided setup once:

```bash
npx @nail00749/agent-gvozd setup
```

Or with Bun:

```bash
bunx @nail00749/agent-gvozd setup
```

The wizard discovers `opencode2` (then `opencode`), reads the live model
catalog, asks for fast and deep preferences, registers the plugin through
OpenCode, writes marker-owned global agents, restarts the service, and runs a
read-only doctor. On a later interactive run, setup offers to keep a valid
existing model profile before opening the model-selection steps. It does not
configure provider credentials. Authenticate with OpenCode first if the desired
provider is absent from `opencode models`.

For a deterministic unattended rerun, use `gvozd setup --yes`. It retains a
valid existing profile, or selects the built-in OpenAI preset only when Luna,
Sol, and Codex Spark are all available. Setup registers the exact current
release (`@nail00749/agent-gvozd@0.3.3`), not a version range. Rerunning setup
after updating the CLI is the supported upgrade path.

Inspect an installation at any time:

```bash
gvozd doctor
gvozd doctor --json
```

Setup owns `<OpenCode config>/gvozd/config.jsonc`, its generated schema, and
the Gvozd Markdown files under `<OpenCode config>/agents`. During upgrades it
removes disabled or obsolete agents only when they are regular files with the
exact Gvozd ownership marker. Unmanaged files are never removed or overwritten.
Unrelated JSONC fields and comments are preserved. Project overrides under
`docs/.gvozd` still take precedence.

The installed team contains:

- `master` — primary coordinator
- `master-trusted` — Master with full shell access for sessions the user marks as trusted
- `planner` — read-only planning subagent
- `back-fast` / `back-deep` — fast and deep backend implementation tiers
- `front-fast` / `front-deep` — fast and deep frontend implementation tiers
- `review-fast` / `review-deep` — fast and deep read-only review tiers
- `researcher` — source-backed internet research
- `explorer` — read-only local file and execution-path discovery
- `git` — focused Git inspection and explicitly authorized operations
- `docs` — documentation, examples, and migration notes
- `debugger` — read-only root-cause investigation
- `security` — read-only security and trust-boundary review
- `devops` — CI, Docker, infrastructure, deployment, and release configuration

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
never overwrites an agent file it does not own. In `0.1.2`, check mode also
reports a missing project template or schema and stale managed schema content;
it performs no migration or directory creation. A markerless legacy schema is
migrated only when it is semantically identical to the known generated schema.
User-owned project configuration is not replaced. This legacy check resolves
the normal user-global OpenCode configuration. `bun run verify:sync` is the
deterministic release gate: it uses an empty temporary config root, checks the
repository, and removes the temporary root afterward.

Run `bun test`, `bun run typecheck`, and `bun run build` for local verification.

## Release verification

The regular CI workflow runs on Ubuntu and macOS with a frozen Bun install. It
runs tests, TypeScript checking (including `scripts/**/*.ts`), the build,
the deterministic `verify:sync` gate, and package verification. Package
verification installs the actual npm tarball outside the workspace, imports
its plugin entrypoint, and runs its Node CLI without depending on a system
`tar` command.

Live OpenCode compatibility is opt-in through the `Live OpenCode
compatibility` `workflow_dispatch`. It accepts no caller-controlled paths or
package specifications and is protected by the `gvozd-live` GitHub environment.
Provision these protected environment variables:

- `GVOZD_LIVE_OPENCODE`: absolute path to the pinned OpenCode executable;
- `GVOZD_LIVE_OPENCODE_SHA256`: its allowlisted SHA-256;
- `GVOZD_LIVE_HOST_DRIVER`: absolute path to the trusted host scenario driver;
- `GVOZD_LIVE_HOST_DRIVER_SHA256`: its allowlisted SHA-256;
- `GVOZD_LIVE_SAFE_PATH`: the complete child-process `PATH`, containing only
  provisioner-controlled tool directories required by OpenCode and the driver.

These values come only from protected environment variables; the dispatch has
no path, digest, or package inputs. Every `GVOZD_LIVE_SAFE_PATH` entry must be
nonempty, absolute, existing, canonical, and a non-symlink directory. It must
not be group- or world-writable, and the same checks apply to its directory
chain. On POSIX, every directory owner must differ from the non-root runner
account and the runner must not have write access. Child processes receive
only this validated value, never the runner's ambient `PATH`.

The self-hosted runner must carry the `gvozd-live` and `ephemeral` labels and
must be provisioned as a one-shot runner that is destroyed after the job. A
runner label is only routing metadata; GitHub does not technically guarantee
ephemerality from that label. Environment reviewers must verify the selected
ref and runner provisioning before approval.

Provision the OpenCode executable and host driver outside runner-writable
storage. They must be regular canonical non-symlink files, executable, owned
by root or another trusted provisioning account rather than the workflow
runner, and have no owner, group, or world write bits (for example mode
`0555`). Every parent directory must likewise be provisioner-owned and not
runner-writable. A POSIX runner operating as root is rejected. The gate records
their file identity and exact allowlisted digest, then re-stats and re-hashes
each file immediately before every corresponding spawn; replacement or
metadata change hard-fails.

The workflow builds the checkout, creates its own local npm tarball, computes
its SHA-256, and passes only that path and digest to the gate. Arbitrary package
specifications are not accepted. Unlike the provisioned executables, this
artifact is expected to be runner-owned and may be owner-writable, while still
being a regular non-symlink file with no group/world write bits. Its digest is
a build-consistency check that detects changes after packing; it is not an
external provenance assertion. Review and protected checkout controls remain
the source-provenance boundary.

The executable must report exactly `2.0.2`. The gate gives child
processes a minimal allowlisted environment and isolated HOME, XDG config,
temporary, and project directories. Commands have timeouts, bounded output,
and redacted failure messages. The pinned CLI exposes no credential-free
non-interactive API that can itself prove permission-event resource mapping,
MCP refresh, and the complete lease lifecycle. The protected host driver must
run those scenarios and emit one JSON object with `pluginActivation`,
`projectOverride`, `editResourceMapping`, `mcpRefresh`, and `leaseLifecycle`
all set to `true`. Missing paths, digests, host integration, credentials, or
proof hard-fail the gate; they are never reported as a successful skip.

Node does not expose a portable descriptor-based `exec`, so a privileged
provisioner could still race the final verified pathname between revalidation
and spawn. That privileged-provisioner race is outside this gate's threat
model. Residual trust therefore remains in GitHub environment approvers,
one-shot runner and safe-PATH provisioning, the pinned OpenCode binary, and
the allowlisted host driver. The driver should use an isolated local MCP
fixture where possible rather than long-lived provider credentials.

## Configuration layers

Configuration is merged in this order:

1. package defaults in `defaults/default.jsonc` and `defaults/agents/*.jsonc`
2. global overrides under the platform/XDG OpenCode config root in `gvozd/config.jsonc`
3. project overrides in `<project>/docs/.gvozd/config.jsonc` and its `agents/` directory

Later scalar values replace earlier values. Arrays such as `models`, `skills`,
`mcp`, and `permissions` replace the complete earlier array.

Configuration objects are validated strictly. Unknown root, agent, and
permission keys are errors rather than silently ignored. Prompt paths and
custom agent directories must stay within the layer that declares them;
missing files, traversal, and symlink targets are rejected.

### Shell escalation

By default, a shell command blocked by the file-lease policy (a writer
running something outside the read-only verification baseline, or any agent
running shell while writer leases are active) surfaces a normal OpenCode
permission request — you approve or reject the exact command, and the agent
continues with your decision. Destructive Git command families
(`git push --force`, `git reset --hard`, `git rebase`, `git clean`,
`git filter-*`, `git checkout --`, `git restore`, `git branch -D`,
`git remote remove/set-url/add`) and system-wrecking commands (`sudo`,
`rm -rf /`, `mkfs*`, `dd if=*`) never escalate: they stay denied.

To restore the older hard-block behavior, set `lease.shellEscalation` in the
package, global, or (trusted) project layer:

```jsonc
{
  "lease": { "shellEscalation": "deny" }
}
```

### Project capability trust

As a security and compatibility change in `0.1.2`, untrusted
repository-controlled configuration may contain only `$schema` and
`description` overrides for existing agents. Custom agents and all other root
or agent fields require explicit trust.

After reviewing the repository configuration, a user may opt in externally:

```bash
TOKEN="$(gvozd trust-project)"
GVOZD_TRUST_PROJECT_CONFIG="$TOKEN" opencode2
```

The second command must start the OpenCode process with the exact token; setting
the variable in another process does not grant trust. `gvozd trust-project`
uses the current directory by default and accepts an explicit project directory.
It only prints the current token and does not modify files or the environment.
A repository cannot self-authorize by placing the token in its files.

The token is bound to the canonical project root and the reviewed project root
config, agent fragments, and referenced prompts. Changing any of them
invalidates it, and a token for one project cannot authorize another project.
API callers can pass the exact token as `projectTrustToken` to `loadConfig`.

### OpenCode config-root contract

`setup` and `doctor` use `opencode debug paths` as the authority for CLI writes
and diagnostics. Runtime/config loading resolves its root in this order:

1. an explicit `configRoot` supplied by an API caller;
2. `GVOZD_OPENCODE_CONFIG_ROOT`;
3. `XDG_CONFIG_HOME/opencode`;
4. `APPDATA/opencode` on Windows;
5. `~/.config/opencode`.

OpenCode `2.0.2` does not expose its config root in the plugin
context. The runtime therefore cannot infer a nonstandard host root from
`debug paths`. If Doctor reports a mismatch, set
`GVOZD_OPENCODE_CONFIG_ROOT` to the absolute path printed by
`opencode debug paths` before starting or restarting OpenCode.

The config root reported by `debug paths` must already use its canonical
absolute spelling. Before setup creates a lock or managed directory, every
existing component from the filesystem root through the nearest existing
ancestor is checked with `lstat`: symbolic links, non-directory ancestors, and
POSIX group/world-writable directories are rejected. Managed config, Gvozd,
agents, and lock directories additionally must be owned by and writable by the
current account. Known platform aliases such as macOS `/var` are not followed;
OpenCode must report the corresponding canonical path.

These checks prevent an unprivileged different-user path swap, but Node has no
portable descriptor-relative recursive mkdir/rename transaction. A
same-UID process that deliberately races the final validated component, or a
non-cooperating process that performs a final rename between validation and
mutation, remains outside this cooperative setup threat model.

## Permission modes

Switch a session's permission posture without changing agents. In the TUI run
`/gvozd-mode` and pick a posture:

- `balanced` — the default; unknown shell commands and edits ask.
- `trusted` — all shell and edits allowed; destructive Git (push --force,
  reset --hard, clean, rebase, filter-branch/filter-repo, checkout --,
  restore) stays denied, and writer-lease pauses still apply.
- `strict` — every shell command and edit asks.

The sidebar always shows the effective session mode and shell state. Click the
`gvozd` section and choose **Allow shell without prompts for this session** to
grant ordinary shell access immediately, or **Reset shell to agent policy for
this session** to remove the override. The grant is session-scoped and never
re-opens destructive Git commands.

Modes apply through session-scoped rules that evaluate after agent rules, and
child sessions inherit the mode in effect when they are created. For a
persistent per-session agent, switch to the `master-trusted` primary agent
(Tab in the TUI): it holds full shell access under the same lease protocol.

The permissions sidebar section shows pending requests, answered requests
(durable across TUI restarts), and the saved `always` approvals. Run
`/gvozd-dryrun` to evaluate a hypothetical command — including compound
pipelines, segment by segment — against the resolved ruleset.

## Managing the team

`gvozd agents` lists the resolved team with mode, lease role, and model.
`gvozd agents disable <id>` and `gvozd agents enable <id>` toggle a built-in
agent in the managed global config; rerun `gvozd sync` and `gvozd doctor` to
apply. Disabled agents disappear from the runtime, the generated files, and
doctor checks.

## Session analysis

`gvozd analyze <sessionID>` exports one OpenCode session for review by an
agent or a human. It writes `gvozd-<sessionID>.md` into the current directory
by default and prints a one-line summary:

```bash
gvozd analyze ses_example123
gvozd analyze ses_example123 --json      # machine-readable dump
gvozd analyze ses_example123 --stdout    # print instead of writing a file
```

The report contains the session header (agents, models, cost, tokens,
outcome), aggregate tool usage, recent errors, tools whose calls failed with
permission-shaped errors, and a full timeline: every user message, every
assistant turn with its agent/model and each tool call (command, file, URL)
with its status and error, plus skill activations and direct shell messages.
The session ID is visible in the OpenCode TUI (for example in `/sessions`)
or from `opencode2 api get /api/session`.

Analyze is read-only: it talks to the running OpenCode service through the
`opencode api` CLI and never mutates session state.

## Cooperative file leases

Writer agents coordinate exact project files before editing them. The default
roles are:

- `master`: `coordinator`
- backend, frontend, Docs, and DevOps agents: `writer`
- planning, exploration, review, research, Git, verification, debugging, and
  security agents: `readonly`

Custom agents default to `readonly`. Agents with no configured lease role
participate as outsiders: they may edit files while no writer leases are
active — the normal single-agent case — and pause during parallel writer work.
They cannot join the coordination protocol itself; set `fileLease` explicitly
when a custom agent must write:

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
shell writes cannot be safely inferred from command text. Read-only roles keep
running the toolchain verification baseline while writer leases are active;
only approval-gated commands pause until the leases are released. If a writer
discovers another required file, it reports the exact path to Master, which can
extend the lease after a conflict check or serialize the work.

Leases are in-memory and protect child sessions within one OpenCode server
process. Unclaimed reservations expire after five minutes; active leases expire
after thirty minutes without tool activity and are released on terminal session
events. Separate OpenCode processes and remote hosts are not coordinated.

File ownership keys are case-insensitive by default on macOS and Windows and
case-sensitive on other platforms. Because the runtime cannot portably detect
the mounted filesystem policy, start OpenCode with
`GVOZD_CASE_INSENSITIVE_FILESYSTEM=0` for a case-sensitive APFS workspace, or
with `GVOZD_CASE_INSENSITIVE_FILESYSTEM=1` for a case-folding Linux workspace
such as a suitably configured casefold filesystem or CIFS mount. Only the exact
values `0` and `1` are accepted; any other value aborts plugin setup rather than
selecting an uncertain ownership policy.

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

The built-in team uses exact skill IDs, a server-wide grant to the configured
Context7 documentation server where current library references help the role,
and tool-level MCP permissions for GitLab, GitNexus, and Playwright. Those
broader servers remain tool-scoped because each exposes actions that are too
broad for at least one receiving role.

The Context7 grant activates only when OpenCode already has an MCP server named
exactly `context7`. Gvozd grants access to that server; it does not install or
configure it, inspect its implementation, or constrain its individual tools.
Operators must trust that exact server identity and its advertised tool set.

OpenCode's built-in desktop browser tools report only the `browser` permission
action and never request runtime approval themselves. Every built-in Gvozd agent
therefore ends with an explicit `browser` deny so the host hides those tools;
agents that need live UI evidence use the Playwright MCP server instead, where
Gvozd's tool-level permissions apply.

| Agents | Skills | MCP access |
| --- | --- | --- |
| `master` | none | none |
| `planner` | verification planning, ASCII UI review, GitNexus impact | Context7; GitNexus read-only |
| `back-fast` | none | Context7 |
| `back-deep` | GitNexus impact and refactoring | Context7; GitNexus except rename and group sync |
| `front-fast` | modern web and interface polish | Context7; Playwright observation; interactions ask |
| `front-deep` | frontend/layout skills plus GitNexus impact/refactoring | Context7; GitNexus except rename and group sync; Playwright interactions ask |
| `review-fast` | code review | Context7; read-only GitLab without CI variables |
| `review-deep` | code review and GitNexus review/impact | Context7; read-only GitLab and GitNexus |
| `researcher` | none | Context7 |
| `explorer` | GitNexus exploration | GitNexus read-only |
| `git` | none | GitLab reads; mutations ask; CI variables denied |
| `docs` | none | Context7 |
| `debugger` | systematic debugging and GitNexus debugging/PDG | Context7; read-only GitNexus; Playwright interactions ask |
| `security` | code review and GitNexus taint/PDG | Context7; read-only GitLab/GitNexus; Playwright interactions ask |
| `devops` | verification before completion | Context7; GitLab reads and CI validation; mutations ask; CI variables denied |

`master`, `explorer`, and `git` intentionally receive no Context7 grant. TDD
skills are not enabled implicitly.

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
glob, grep, and read tools. Git and the other read-only roles allow read-only Git commands and
listing forms (status, diff, log, show, rev-parse, ls-files, branch, tag,
remote, symbolic-ref HEAD, reflog, worktree list); any form that creates,
deletes, renames, or rewrites state requires approval, and destructive
commands (push --force, reset --hard, clean, rebase, branch -D, remote
remove/set-url/add, restore, checkout --, filter-branch/filter-repo) are
denied outright. Docs
can edit Markdown and files under `docs/`; edits elsewhere require approval,
and shell access is denied.

Debugger, Security, and DevOps use `openai/gpt-5.6-luna` with
`openai/gpt-5.6-sol` as fallback. Debugger and Security are read-only and
require approval for shell commands. DevOps can edit
common CI, Docker, and infrastructure paths; other edits require approval, shell
is denied for the writer role, and every external mutation requires explicit
task authorization.

This pre-release change replaces the earlier single-tier agent IDs. Existing
global or project overrides must be split explicitly:

| Previous ID | New IDs |
| --- | --- |
| `backender` | `back-fast`, `back-deep` |
| `frontend` | `front-fast`, `front-deep` |
| `reviewer` | `review-fast`, `review-deep` |

There are no automatic aliases because copying one override to both tiers could
silently give them the same model order and defeat complexity-based routing.

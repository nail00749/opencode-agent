# Architecture

Codebase map for agents and contributors. For user-facing docs see
`README.md`; for workflow rules see `AGENTS.md`.

## Layers and entrypoints

| Path | Role | Built artifact |
| --- | --- | --- |
| `src/core/` | Domain logic: config resolution, sync, agent generation, permissions, file leases, project trust, release metadata | — |
| `src/shared/` | Infrastructure primitives: fs, text, locks, path security, runtime events | — |
| `src/rpc/` | RPC contract definitions shared by the server plugin and the TUI | — |
| `src/plugin/` | OpenCode server plugin | `dist/index.js` (export `.` / `./server`) |
| `src/tui/` | OpenCode TUI plugin | `dist/tui.js` (export `./tui`) |
| `src/cli/` | `gvozd` command-line interface | `dist/cli.js` (bin `gvozd`) |

Dependency direction (acyclic, enforced by convention and code review):

```
plugin ──▶ rpc ──▶ core ──▶ shared
tui ──▶ rpc, core
cli ──▶ core, shared
scripts ──▶ core, shared
shared ──▶ (nothing internal)
```

## core/ — domain modules

- **`config.ts`** — resolves the layered configuration (package `defaults/` →
  global `gvozd/config.jsonc` → project `docs/.gvozd/`), validates strictly,
  resolves agent prompts, exposes `loadConfig` and `resolveOpenCodeConfigRoot`.
- **`sync.ts`** — materializes the resolved team into `.opencode/agents/*.md`,
  the local dev plugin entrypoint, and the `docs/.gvozd` template. Marker-owned
  writes only; refuses to touch unmanaged files.
- **`agent-generation.ts`** — renders one agent Markdown file from an
  `AgentConfig` (frontmatter + prompt body).
- **`agent-permissions.ts`** — builds the effective permission rules for an
  agent (tool baseline, MCP grants, deny-first ordering); `wildcardMatch`
  powers all action/resource matching.
- **`tool-permissions.ts`** — exact/wildcard tool permission tables and
  helpers used by both enforcement and the dry-run RPC.
- **`file-leases.ts`** — in-memory cooperative lease manager: reserve, claim,
  extend, release, snapshot; canonical project-relative paths only.
- **`project-trust.ts`** — trust tokens binding untrusted project config to a
  canonical project root (`GVOZD_TRUST_PROJECT_CONFIG`).
- **`constants.ts`** — generated-file markers, legacy schema equivalence, and
  the built-in agent ID lists (`FAST_AGENT_IDS`, `DEEP_AGENT_IDS`,
  `ALL_AGENT_IDS`) shared by the CLI and the TUI roster.
- **`release-metadata.ts`** — package name/version, supported OpenCode range.
- **`config-root.ts`** — platform/XDG resolution of the OpenCode config root.

## shared/ — infrastructure primitives

- **`fs.ts`** — `statOptional`, `isWithin`/`assertWithin`,
  `createExclusiveFile`, `replaceFileAtomic`, `assertWriteable`.
- **`text.ts`** — bounded output helpers for child-process capture.
- **`file-lock.ts`** — stale-aware exclusive lock files (pid + uuid owner
  records) for sync/setup/config writes.
- **`secure-path.ts`** — `secureCanonicalPath`: per-component `lstat`
  validation, symlink and non-canonical ancestor rejection.
- **`runtime-events.ts`** — `redactDiagnostic`, resource disposal,
  runtime event loop plumbing.

## rpc/ — contracts

- **`permissions-rpc.ts`** — `gvozd-permissions` (dry-run evaluation) and
  `gvozd-leases` (lease snapshot) definitions with JSON Schemas.
- **`trusted-mode.ts`** — `gvozd-mode` definition plus the per-mode rule
  tables (balanced / trusted / strict).

Both sides import the same module, so plugin and TUI can never drift apart on
the wire format.

## plugin/ — server plugin

- **`index.ts`** — `Plugin.define` setup: applies agent transforms, registers
  RPC methods, installs the permission hook (lease enforcement, skill/MCP
  scoping), subscribes to runtime events, disposes resources on teardown.
- **`file-lease-plugin.ts`** — bridges the lease manager into the permission
  hook and registers the `gvozd_lease` tool surface. Shell commands blocked
  by lease policy escalate to a user `ask` (configurable through
  `lease.shellEscalation: "ask" | "deny"`); destructive Git command families
  never escalate.

## tui/ — TUI plugin

- **`index.tsx`** — slot registrations: sidebar insights, team roster, footer
  status, `/gvozd*` fullscreen panels, keymap command host.
- **`insights.ts`** — session insights resource (tree, skills, permissions),
  lease/mode RPC calls.
- **`agent-roster.ts`** — sidebar "team" section: which configured agent runs
  on which resolved model (source: `data.location.agent.list` after the
  server plugin's transform).
- **`session-insights.ts`**, **`session-tools.ts`** — pure data shaping for
  the sidebar/panels (easily testable without a renderer).
- **`command-pipeline.ts`** — splits a command line into pipeline segments
  for the permission dry-run view.

## cli/ — gvozd CLI

- **`index.ts`** — argument routing for `setup`, `config`, `doctor`, `sync`,
  `agents`, `trust-project`, `analyze`.
- **`setup.ts`** / **`configure.ts`** — guided global install and model
  profile configuration.
- **`opencode.ts`** — process runner and client for `opencode2`/`opencode`
  (version, debug paths, models, plugin add/check/list, service restart,
  read-only HTTP API access). Output is byte-bounded; large payloads drain
  through a temp file (OpenCode 2.0.3 truncates piped stdout at ~256 KB).
- **`analyze.ts`** — `gvozd analyze <sessionID>`: fetches session info and
  every message page (cursor-aware), distills tool calls, errors, permission
  denials, and renders a Markdown or JSON report for agent handoff.
- **`doctor.ts`** — installation diagnostics (human and JSON rendering).
- **`config-store.ts`** — managed global `gvozd/config.jsonc`: preflight,
  snapshot-verified atomic writes, JSONC edit helpers.
- **`global-sync.ts`** — writes marker-owned global agents (setup path).
- **`provider-catalog.ts`** — fast/deep model presets parsed from
  `opencode models`.
- **`agents.ts`** — listing and enable/disable for the resolved team.

## scripts/ — build and release gates

- **`build.ts`** — three Bun builds producing the stable artifact paths.
- **`verify-sync.ts`** — deterministic drift gate over a temp config root.
- **`verify-package.ts`** — installs the packed tarball into a temp prefix and
  imports/runs it.
- **`live-opencode-compat.ts`** — opt-in live gate against a provisioned
  pinned OpenCode binary (attested executables, allowlisted env, JSON proof).

## Lint

`bun run lint` runs oxlint (dev dependency) with the repository config in
`.oxlintrc.json`. It must finish with zero warnings and zero errors; CI runs
it after tests. Per-file rule overrides exist only where the pattern is
deliberate and carry an explanatory comment in the config.

## defaults/ — the agent team definition

`default.jsonc` (schema + defaults), `agents/*.jsonc` (per-agent config with
prompt references), `prompts/*.md` (immutable prompt bodies),
`schema.json` (published for editors). `bun run sync` renders these through
`core/agent-generation.ts`; the generated Markdown in `.opencode/agents/` is
never hand-edited.

## Test layout

Tests sit beside their modules (`*.test.ts` / in `src/tui/`), run by
`bun test`. The npm-package smoke test lives in `src/cli/package-smoke.test.ts`
and is excluded from unit runs (`test:unit`) but included in `test:e2e`.
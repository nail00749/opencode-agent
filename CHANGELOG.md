# Changelog

## 0.2.1

### Fixed

- `gvozd doctor` no longer reports false "runtime agents are missing" on
  OpenCode 2.0.3: the runtime reads `debug agents` through a temp stdout file
  because that build truncates piped stdout (~320 KB), dropping agent IDs from
  the JSON payload.
- The TUI no longer crashes with "Keymap not found. Wrap the tree in
  <KeymapProvider>." — the Gvozd commands now register their keymap layer
  inside the rendered `app` slot (where the host keymap context is active)
  instead of during plugin setup, which runs outside that scope.
- Permission wildcard matching no longer uses `.*`-built regexes: the new
  linear matcher eliminates catastrophic backtracking that could freeze a
  session on star-heavy config rules and long agent commands.
- `gvozd setup` recovers from crash leftovers: a lock whose owning process no
  longer exists (and that is older than 30 minutes) is collected instead of
  demanding manual removal.
- `gvozd agents enable/disable` now runs under the exclusive setup lock, so
  concurrent toggles cannot silently lose an update.
- `publish:fast` runs the unit tests before publishing.
- The TUI insights panels refetch on permission/skill events; previously the
  resource source did not change between revisions, so the subagent tree and
  permission history stayed frozen after the first load.
- The permission dry-run keeps heredoc bodies, `$( )`/backtick substitutions,
  and env-prefixed commands intact instead of splitting them into misleading
  segments.
- Trusted mode keeps `git rebase --abort` / `--continue` allowed after the
  blanket rebase deny, so interrupted-rebase recovery stays possible.

## 0.2.0

Targets OpenCode V2 `2.0.*` (any 2.0.x patch) instead of the exact `2.0.2` pin.

### Added

- **TUI plugin** (`./tui` export) with a session sidebar section and four
  fullscreen panels:
  - sidebar: subagent tree (agent, model, live status, cost), skills used in
    the selected session, permission history, and tool-call statistics with a
    permission-error split;
  - `/gvozd` — the same insights fullscreen;
  - `/gvozd-dryrun` — permission dry run that evaluates each segment of a
    compound command (`;`, `&&`, `||`, `|`, newlines) against the resolved
    ruleset;
  - `/gvozd-leases` — lease snapshot with owners, files, and remaining TTL;
  - `/gvozd-mode` — session permission posture switcher.
- **`gvozd-permissions` RPC**: evaluates the exact `allow`/`ask`/`deny` effect
  a resolved ruleset produces for a hypothetical action and resource.
- **`gvozd-leases` RPC**: returns the lease snapshot
  (`FileLeaseManager.snapshot()`); claimed leases first, ordered by expiry.
- **`gvozd-mode` RPC and session trust modes**: switch a session between
  `balanced` (default asks), `trusted` (full shell and edits; destructive Git
  stays denied), and `strict` (everything asks). Modes apply through
  session-scoped permission rules; child sessions inherit the mode in effect
  when they are created.
- **`gvozd agents` CLI**: list the resolved team (mode, lease role, model) and
  toggle built-in agents in the managed global config
  (`gvozd agents disable|enable <id>`) with the same snapshot and atomic-write
  discipline as model configuration.
- **Writer verification baseline**: Back Fast, Back Deep, Front Fast, and
  Front Deep hold the read-only toolchain shell baseline (tests, builds,
  typecheck, lint, read-only Git) and verify their own changes while their
  lease is active. The lease plugin passes safe read-only commands from
  writers; every other command stays denied, protecting the structured
  mutation model.
- **Security baseline**: the Security agent pre-approves the same read-only
  verification commands as the review agents.
- **`master-trusted` primary agent**: Master with full shell access for
  sessions the user marks as trusted; same lease protocol, destructive Git
  still asks.
- **Durable permission history** in the TUI: answered permission requests
  persist across TUI restarts through plugin storage.
- **Prompt-footer status**: pending permissions, running subagents, and
  accumulated cost at the prompt.

### Changed

- Unconfigured agents (no file-lease role) may edit files while no writer
  leases are active — the normal single-agent case — and pause during parallel
  writer work. Missing agent identity stays fail-closed. This replaces the
  previous hard edit deadlock that pushed agents into shell-based writes.
- `SUPPORTED_OPENCODE_VERSION` is the range `2.0.*`; setup and doctor accept
  any 2.0.x patch and reject prereleases and adjacent minor versions.
- Review agents' Git mutation forms (`git branch *`, `git symbolic-ref *`,
  and friends) are ask-level even after listing-form allows, with
  `GIT_OPTIONAL_LOCKS=0` twins, closing an escalation path found by the
  consistency tests.

### Removed

- The `verifier` agent: writers verify their own work; routing prompts,
  permission profiles, model presets, and doctor checks no longer reference
  it. `gvozd agents disable <id>` removes any other agent selectively.

## 0.1.8

- Setup replaces the registered package version before adding the new one.

## 0.1.7

- Opt-in dev plugin entrypoint (`gvozd sync --dev-plugin`) ships to consumers
  without colliding with the globally registered package.

## 0.1.6

- Parse OpenCode `2.0.2` `debug agents` JSON output (full agent definitions)
  down to the identifier list doctor expects.

## 0.1.5

- Target OpenCode V2 `2.0.2` stable.

## 0.1.4

- Close Git permission bypasses (`-C` flag smuggling, exact-only wildcards)
  and align agent prompts with the shipped baselines.

## 0.1.3

- Cut permission prompts and lease friction; read-only toolchain baseline.

## 0.1.2

- Initial public release: global permission-aware agent team, cooperative
  file leases, project trust tokens, doctor, and sync tooling.

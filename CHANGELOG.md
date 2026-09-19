# Changelog

## 0.3.15

### Fixed

- `gvozd doctor` now understands OpenCode's current `ID VERSION SOURCE` plugin
  table and validates the registered tracking source instead of falsely
  reporting that an updated `@latest` installation is missing.

## 0.3.14

### Fixed

- Location-scoped plugin instances now reconcile family shell grants from the
  persisted root-session policy before evaluating shell permissions, so a
  stale in-memory lease policy cannot prompt after `shell=allow`.
- Native `session.permissions` events refresh the owning family cache without
  allowing child-specific permission changes to replace root policy.
- Context and permission refreshes are read-only, preventing an older plugin
  snapshot from overwriting a concurrent user grant. Destructive command
  families remain denied.

## 0.3.13

### Fixed

- `gvozd update` now updates the globally installed CLI through the package
  manager that owns it, instead of updating only the OpenCode plugin.
- Migrating a pinned registration to `@latest` immediately runs OpenCode's
  native updater, so an old tag cache cannot become the reported active
  version.
- Update verification waits for the exact CLI version to load in OpenCode and
  reports CLI and plugin versions separately.
- Installations older than `0.3.13` require one explicit package-manager
  bootstrap because their already-running CLI does not yet contain the
  self-updater.

## 0.3.12

### Fixed

- Native session policies now cover OpenCode V2's `bash` permission action as
  well as the plugin-facing `shell` alias. Trusted mode and `shell=allow`
  therefore suppress inherited subagent command prompts on OpenCode 2.0.8.
- Existing `0.3.11` session-policy blocks are upgraded on first access, so
  already-open root sessions do not require a manual permission toggle.
- Protected destructive-command rules are duplicated for both action names, so
  the compatibility fix does not weaken the existing safety boundary.

## 0.3.11

### Fixed

- Trusted mode and explicit shell grants now persist as native root-session
  permission rules on OpenCode 2.0.8+, so newly created subagents inherit the
  grant before their first tool call instead of prompting for commands such as
  `printf`.
- Native rule updates preserve unrelated session permissions and continue to
  append the protected destructive-command deny set. Older OpenCode 2.0.x
  hosts keep the existing capability-detected fallback.

## 0.3.10

### Fixed

- `gvozd update` no longer asks OpenCode to update an exact version back to
  itself. Existing pinned registrations migrate to `@latest`, with rollback
  to the previous source if the new registration cannot be added.
- Registrations already tracking `@latest` continue through OpenCode's native
  package updater, while `--check` remains read-only.

## 0.3.9

### Fixed

- Session modes and explicit shell overrides now inherit across the full
  parent/child session family.
- Child ancestry is cached from session lifecycle events and preloaded before
  the first tool call, preventing a new subagent's first shell permission from
  falling back to its local `ask` policy during session lookup races.

## 0.3.8

### Changed

- Replaced the custom fullscreen Control Center with OpenCode-native dialogs.
  `/gvozd` now opens a reliable menu for status, session mode, permissions,
  leases, Jev, and permission dry-run; the existing shortcut commands open
  their native section directly.
- The sidebar roster is local-first and no longer starts Gvozd RPC reads or
  displays a synthetic connection/refresh state.

### Fixed

- Removed the custom panel focus, navigation, and refresh lifecycle that could
  leave the Control Center stuck on `REFRESHING` or make palette commands close
  without a usable interactive surface in OpenCode 2.0.8.
- Each native action loads only the data it needs, reports finite RPC failures,
  and returns to the Gvozd menu after completion.

## 0.3.7

### Added

- `gvozd update` delegates package replacement to OpenCode's native plugin
  updater, restarts the service, verifies the active registration, and removes
  only cache roots belonging to older Gvozd versions.
- `gvozd update --check` reports update availability and stale Gvozd cache
  versions without changing the installation.

### Fixed

- Control Center refresh state now has an explicit latest-request lifecycle;
  failed or superseded RPC reads always leave `REFRESHING`, and stale replies
  cannot overwrite newer panel state.

## 0.3.6

### Added

- Optional Jev structured evaluation through TypeSafe direct or Vercel AI
  Gateway, with typed questions, bounded execution, cancellation, agent
  allowlists, and secret-free configuration.
- Guided Jev configuration in `gvozd setup` and `gvozd config`, plus doctor
  diagnostics and Control Center status/actions.

### Fixed

- Control Center buttons now own their visible focus border and support mouse,
  Enter, Space, Tab, Shift+Tab, and arrow-key navigation.
- Disabled controls are skipped during keyboard navigation, focused controls
  scroll into view, and the panel shows its interaction shortcuts.
- Refresh remains available while initial RPC reads are pending, and enabled
  agents without a resolved model no longer appear as disabled.

### Changed

- The package now requires Node.js 22 or newer.

## 0.3.5

### Fixed

- Replaced keyboard-only OpenTUI selects with real mouse and Enter-activated
  controls in a unified Gvozd Control Center.
- RPC reads and writes now have bounded per-attempt timeouts, so the sidebar
  reaches `READY` or `DEGRADED` instead of remaining on `connecting` forever.
- Deferred TUI actions use the plugin context captured during render rather
  than calling `usePlugin()` after the Solid owner context has been lost.
- The roster appears immediately from OpenCode's local agent data while the
  server RPC refreshes it in the background.

### Changed

- `/gvozd`, `/gvozd-mode`, and `/gvozd-perms` now open one Control Center that
  shows current effective permissions, their source, session mode, lease
  policy, roster, health, and explicit `inherit`/`allow`/`ask`/`deny` buttons.

## 0.3.4

### Fixed

- **Gvozd session panels had no reliable close action.** Every panel now binds
  `Esc` to the host-owned close action and shows the shortcut on screen.
- Session panels now use the session ID supplied by the panel host instead of
  inferring it from the current router state.
- The sidebar retries roster and permission RPC reads while the server plugin
  is starting, instead of permanently retaining `unavailable` after one
  transient failure.

### Changed

- The sidebar and session panels show the loaded Gvozd package version.
- Shell grants now cover the selected session and all descendant subagent
  sessions. They bypass ordinary agent-policy and writer-lease shell prompts;
  destructive shell commands remain denied. Structured edit hooks still
  enforce leases, but granted shell commands can mutate files outside them.

## 0.3.3

### Fixed

- **Clicking the TUI team section immediately closed its actions dialog.** The
  dialog now opens on mouse release, after the click that triggered it has
  completed.
- **Repeated interactive setup always reopened model selection.** When the
  existing model profile is valid, setup now offers to keep it or explicitly
  start a fresh provider/model selection.

## 0.3.2

### Added

- **Visible session shell controls**: the TUI sidebar now always shows the
  active permission mode and effective shell state. Its Gvozd actions menu can
  allow ordinary shell commands without prompts for the current session or
  reset shell handling to the agent policy. Destructive Git remains denied.

### Fixed

- **The TUI team section and lease panel could stay empty.** No-payload RPC
  calls omitted the request input even though the cross-version RPC contract
  requires an empty object, so OpenCode returned HTTP 400. These calls now send
  `{}`, and the roster remains reactive when its asynchronous response arrives.

## 0.3.1

### Added

- **TUI session permission toggles** (`/gvozd-perms` or the team actions
  menu): a checkbox list for `shell`, `edit`, `skill`, and MCP access. Each row
  shows `[ ]` when the agent policy decides and `[x]` when the session
  overrides it; selecting a row cycles
  `inherit → allow → ask → deny → inherit`. The panel is **session-only** —
  nothing is written to disk, so it disappears with the session and can never
  alter the managed config.
- **Shell escalation**: a shell command blocked by the file-lease policy now
  surfaces a normal OpenCode permission request by default, instead of being
  hard-denied. Destructive Git families (`git push --force`, `git reset
  --hard`, `git rebase`, `git clean`, `git filter-*`, `git checkout --`,
  `git restore`, `git branch -D`, `git remote remove/set-url/add`) and
  system-wrecking commands (`sudo`, `rm -rf /`, `mkfs*`, `dd if=*`) never
  escalate. Restore the old hard block with `lease.shellEscalation: "deny"`.
- **Agent orientation context**: every Gvozd agent now receives a short block
  describing its lease role, the shell policy, and the project `AGENTS.md`
  path, so subagents launched in fresh sessions know the lease protocol and
  how to request a blocked command.
- **Server-side roster and config RPC** (`gvozd-roster`, `gvozd-config`): the
  TUI team section reads the resolved agent roster (which agent runs on which
  model, including disabled agents) from the server, because the host reports
  `model: null` for plugin-transformed agents. The config RPC persists
  `lease.shellEscalation` and agent models/enabled state to the managed global
  config.
- **Team actions menu**: clicking the sidebar team section opens a menu for
  insights, leases, permission mode, dry-run, and shell-escalation changes.
- **Runtime host version diagnostic**: the plugin reads `ctx.app.version` and
  warns when the host is outside the supported `2.0.*` range instead of
  failing setup.
- **Shared version contract** (`core/version.ts`): `parseOpenCodeVersion`,
  `satisfiesOpenCodeRange`, and `compareOpenCodeVersions`, used by both the CLI
  and the plugin.

### Fixed

- **Plugin setup crashed on OpenCode 2.0.4.** That release removed
  `ctx.catalog` and split it into top-level `ctx.model` / `ctx.provider`
  domains, and renamed the `catalog.updated` event to `model.updated` /
  `provider.updated`. Plugin setup called `ctx.catalog.model.list()`
  unconditionally, so loading the plugin on 2.0.4 threw
  `undefined is not an object (evaluating 'ctx.catalog.model')` and no agent
  configuration was applied. The plugin now reads whichever model surface the
  host exposes and reacts to both the old and new refresh events.
- **Session posture had no effect on OpenCode 2.0.4.** That release also
  removed `permission.rules` from the plugin permission domain, so the
  balanced/trusted/strict switch pushed session rules into a method that no
  longer existed and silently did nothing. Postures and toggles are now applied
  through the `evaluate` hook, which exists on every supported 2.0.x host.
  Postures additionally now apply to agents Gvozd does not configure
  (host built-ins and custom primaries), restoring the behavior the removed
  host-level rules provided.
- **CLI could select an incompatible OpenCode binary.** Discovery stopped at
  the first binary that answered `--version` at all, so a V1 `opencode` on
  `PATH` could shadow a V2 `opencode2` and fail later with an opaque error.
  Discovery now version-checks every known binary, prefers the newest
  compatible one, and reports an actionable message when only an incompatible
  build is present.

## 0.3.0

### Added

- **Layered codebase**: `src/` is split into `core/` (domain), `shared/`
  (fs/text/lock/path-security primitives), `rpc/` (plugin↔TUI contracts),
  `plugin/`, `tui/`, and `cli/` with an enforced dependency direction.
  Build artifacts keep their stable paths (`dist/index.js`, `dist/tui.js`,
  `dist/cli.js`).
- **`gvozd analyze <sessionID>`**: exports one OpenCode session as a
  Markdown (default) or `--json` report — session header, tool usage, recent
  errors, permission denials, and a full timeline of user/assistant turns
  with every tool call. Reads through `opencode api`; drains large payloads
  through a temp file because OpenCode 2.0.3 truncates piped stdout at ~256 KB.
- **TUI team roster**: the sidebar shows which configured agent runs on
  which resolved model in the current project, including disabled agents.
- **Shared infrastructure helpers** (`shared/fs.ts`, `shared/text.ts`):
  `statOptional`, `isWithin`/`assertWithin`, `createExclusiveFile`,
  `replaceFileAtomic`, `assertWriteable`, bounded output — replacing
  duplicated copies across sync, global-sync, config-store, and the live
  gate.
- **oxlint** with zero-warning gate in CI and `prepublishOnly`
  (`.oxlintrc.json`).
- **Agent-facing documentation**: `AGENTS.md` (workflow rules, security
  invariants) and `docs/architecture.md` (codebase map).

### Changed

- **Review lifecycle**: agents now work their scope to completion —
  implement, run their own verification loop (tests, typecheck, build, smoke
  checks), and iterate until the task is solved before reporting. Review runs
  only after the writer's verification, immediately before anything proceeds
  toward a commit; reviewers return `REVIEW_TOO_EARLY` when a diff is still
  in progress, and findings loop back to the writer for fix-and-reverify.
- Built-in agent ID lists (`FAST_AGENT_IDS`, `DEEP_AGENT_IDS`,
  `ALL_AGENT_IDS`) moved to `core/constants.ts`; `cli/config-store` still
  re-exports them.

### Fixed

- TUI `/gvozd-mode` panel now uses a real selectable list; previously the
  apply action was unreachable (the posture list rendered as plain text with
  no selection handler).
- `isWithin` semantics split: config-layer containment allows the target to
  equal the base layer (`agentsDirectory` pointing at its own layer), while
  lease targets stay strictly inside the project root.

### Removed

- Orphaned `defaults/prompts/verifier.md` (the Verifier agent was removed in
  0.2.0).

## 0.2.2

### Fixed

- Coordinator agents (`master`, `master-trusted`) run shell commands again
  while no writer file leases are active: the lease plugin no longer denies
  coordinator shell unconditionally, it pauses only while writers hold
  leases. This restores the "full shell access" behavior the
  `master-trusted` prompt promises (e.g. read-only `ssh` stand checks).

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

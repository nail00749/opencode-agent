# AGENTS.md — Gvozd for OpenCode V2

Mandatory rules for any agent working in this repository. Read this before
touching code. User-facing documentation lives in `README.md`; this file is
the agent-facing map and workflow contract.

## What this repository is

`@nail00749/agent-gvozd` ships a permission-aware agent team for OpenCode V2
as one npm package:

- a **server plugin** (`dist/index.js`) that applies agent configuration,
  permissions, MCP scoping, cooperative file leases, and session trust modes;
- a **TUI plugin** (`dist/tui.js`) with sidebar insights, footer status, and
  the `/gvozd*` panels;
- a **Node CLI** (`dist/cli.js`, binary `gvozd`) for setup, doctor, sync, and
  team management.

OpenCode loads the package globally (`plugins` in the user's
`opencode.json`); agent Markdown files are generated per project by
`gvozd sync`.

## Architecture map (enforced dependency direction)

```
src/
├── core/     # domain: config, sync, agents, leases, trust, constants
├── shared/   # infrastructure: fs, text, file-lock, secure-path, runtime-events
├── rpc/      # RPC contracts shared by plugin and TUI (permissions, trust mode)
├── plugin/   # server plugin → dist/index.js (index.ts, file-lease-plugin.ts)
├── tui/      # TUI plugin → dist/tui.js (index.tsx, insights, panels)
└── cli/      # CLI → dist/cli.js (index.ts + setup, doctor, opencode, ...)
scripts/      # build.ts, verify-*.ts, live-opencode-compat.ts (release gates)
defaults/     # agent team definition: default.jsonc, agents/*.jsonc, prompts/
```

Allowed dependency direction — never create a back edge:

- `plugin → rpc → core → shared`
- `tui → rpc + core` (tui never imports from `plugin/`)
- `cli → core + shared` (cli never imports from `plugin/` or `tui/`)
- `scripts → core + shared`
- `shared` imports nothing from the other layers

Build entrypoints live at `src/plugin/index.ts`, `src/tui/index.tsx`, and
`src/cli/index.ts`; `scripts/build.ts` compiles them to the stable artifact
paths `dist/index.js`, `dist/tui.js`, `dist/cli.js` (package `exports` and
the published contract depend on those paths — do not rename artifacts).

## Workflow rules

1. **Read before editing.** Inspect the affected module and its callers
   (`grep` for the symbol) before changing an exported signature.
2. **Respect the layers.** New shared helpers go to `src/shared/*` only when
   at least two layers need them; otherwise keep them local.
3. **No new dependencies** without explicit user approval. Runtime deps are
   minimal on purpose; the plugin must keep running inside OpenCode's host.
4. **Tests live beside the code** (`*.test.ts` next to the module; TUI tests
   in `src/tui/`). Bun's test runner discovers them automatically.
5. **Verify with the smallest sufficient set:**

   ```bash
   bun run lint                     # oxlint; always alongside typecheck
   bun run typecheck                # always
   bun test src/<touched>/...       # targeted tests
   bun test                         # full unit suite before claiming done
   bun run build                    # before any release or packaging claim
   bun run verify:sync              # generated-file drift gate
   bun run verify:package           # npm tarball gate (requires build)
   ```

   `bun run test:e2e` runs the package smoke test and rebuilds; it is slow —
   run it only for packaging or CLI-entry changes.
6. **Do not edit generated files.** `.opencode/agents/*.md`,
   `.opencode/plugins/agent-gvozd/`, and `docs/.gvozd/` are produced by
   `bun run sync` (see `src/core/sync.ts`). Change `defaults/` and rerun sync
   instead.
7. **Commits are user-initiated.** Do not commit, push, or publish unless the
   user asked. Release commits follow the changelog + version bump pattern in
   `CHANGELOG.md`.

## Security invariants (do not weaken)

This codebase treats filesystem and process paths as a trust boundary:

- `src/shared/secure-path.ts` (`secureCanonicalPath`) validates every path
  component with `lstat` before use; symlinked components and non-canonical
  ancestors are rejected.
- `src/shared/fs.ts` `assertWriteable` requires user-owned, non-group/world-
  writable directories; `createExclusiveFile`/`replaceFileAtomic` give
  owner-only (0o600) atomic writes. Never replace them with plain
  `writeFileSync` on managed paths.
- `src/core/project-trust.ts` gates untrusted repository config behind
  `GVOZD_TRUST_PROJECT_CONFIG`; a repo can never self-authorize.
- Never parse shell command text to decide safety; permission decisions use
  action/resource matching (`src/core/tool-permissions.ts`,
  `agent-permissions.ts`).
- Diagnostics that may include command output go through `redactDiagnostic`
  (`src/shared/runtime-events.ts`).

Any change that loosens these checks needs an explicit user decision first.

## Conventions

- TypeScript 7, strict mode, ESM, `"type": "module"`. Node ≥ 20.12, Bun 1.4.
- `bun run lint` (oxlint, `.oxlintrc.json`) must pass with zero warnings; do
  not disable rules inline. Per-file overrides in `.oxlintrc.json` carry a
  comment explaining why. Known intentional exception:
  - `src/core/file-leases.ts` spreads the lease Map before loops that mutate
    it (`unicorn/no-useless-spread` off) — removal during iteration needs the
    snapshot.
- Imports use explicit relative paths with no extension; layer boundaries are
  the only coupling rules.
- Error messages: short, actionable, no secrets; thrown as `Error` (leases
  use typed `LeaseError` with codes).
- Comments explain *why* (threat model, host quirks) rather than *what*.
- Tests use `bun:test` with `describe/test/expect`; prefer small focused
  files mirroring the module under test.
- Formatting: no linter config in-repo; match the surrounding style (no
  semicolons, double quotes, 2-space indent).

## Release notes

- `package.json` `prepublishOnly` runs the full gate chain; never bypass it.
- `SUPPORTED_OPENCODE_VERSION` in `src/core/release-metadata.ts` pins the
  compatible OpenCode V2 range; update it together with any plugin-API
  dependency bump.
- After changing anything under `defaults/`, run `bun run sync` and commit
  the regenerated `.opencode/agents/*.md` files together with the source.
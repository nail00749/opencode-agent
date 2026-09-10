# Global CLI and npm Distribution Design

## Purpose

Make Gvozd installable once as a global OpenCode V2 plugin and usable in every
project. A guided CLI provides a `create-vite`-style setup flow, selects models
from the user's live OpenCode catalog, maintains the global Gvozd
configuration, and diagnoses installation or configuration failures without
requiring project-local setup.

The first public package is `@nail00749/agent-gvozd` version `0.1.0`, licensed
under MIT and linked to `https://github.com/nail00749/opencode-agent`.

## Goals

- Install Gvozd globally through one guided command.
- Make the configured Gvozd team available in every OpenCode project.
- Discover the user's enabled models instead of assuming OpenAI-only access.
- Keep provider recommendations extensible without coupling them to the prompt
  UI or configuration writer.
- Provide a read-only `doctor` with actionable human and JSON output.
- Preserve comments, unrelated settings, and unmanaged files.
- Publish a conventional, minimal npm tarball that runs without repository
  sources or a separately installed Bun executable.
- Preserve project-level Gvozd overrides as an optional advanced feature.

## Non-goals

- Configure provider credentials or store API keys.
- Create a new application or repository.
- Ask users to choose which Gvozd agents exist in the first wizard version.
- Configure MCP servers, skills, or detailed permissions in the first wizard
  version.
- Automatically repair problems from `doctor`.
- Publish to npm, push GitHub state, or create a GitHub repository without a
  separate release authorization.
- Support OpenCode V1.

## Public commands

The npm package exposes one executable named `gvozd`. Users do not need a
global npm installation; the primary entrypoint is:

```bash
npx @nail00749/agent-gvozd@latest setup
```

`bunx` is also supported:

```bash
bunx @nail00749/agent-gvozd@latest setup
```

The command surface is:

```text
gvozd setup [--yes]
gvozd config [--yes]
gvozd doctor [--json]
gvozd sync [directory] [--check]
```

- `setup` performs global installation, guided model configuration, global
  agent generation, service reload, and a final doctor run.
- `config` runs the model wizard and updates the existing global Gvozd config
  without reinstalling the package.
- `doctor` is read-only. It prints diagnostics and exits non-zero for failures.
- `sync` preserves the existing project-local workflow for development and
  compatibility. It is not part of the recommended public installation flow.

Unknown commands or flags exit with code 2 and show concise usage. Interactive
commands refuse to run without a TTY unless `--yes` supplies a fully
deterministic default path. `--yes` accepts the displayed write plan but never
silently guesses a model when no compatible recommended model is available.

## Global installation layout

The CLI obtains OpenCode's actual directories from `opencode debug paths` and
does not assume that the config directory is always `~/.config/opencode`.
The normal layout is:

```text
<opencode-config>/
├── agents/
│   ├── master.md
│   ├── back-fast.md
│   └── ...
└── gvozd/
    ├── config.jsonc
    └── schema.json
```

The npm package is registered in OpenCode's global configuration through the
official `plugin add` CLI. Setup records the compatible package range for its
current minor release, initially `@nail00749/agent-gvozd@^0.1.0`. Patch updates
remain discoverable through `plugin check`; rerunning
`npx @nail00749/agent-gvozd@latest setup` is the explicit path to a later minor
release.

OpenCode's plugin API can update existing agent definitions but cannot add a
missing agent. Therefore global Markdown agent files remain required. They are
generated once under the global OpenCode config directory rather than in every
project. The runtime plugin then applies the resolved prompt, selected model,
permissions, and file-lease policy to those discovered agent definitions.

Project overrides under `<project>/docs/.gvozd` remain supported and load after
the package and global layers. The global wizard does not create project files.

## Setup flow

`gvozd setup` performs these stages:

1. Find `opencode2`, falling back to `opencode`, using direct process spawning
   without a shell.
2. Read the OpenCode version and `debug paths` output.
3. Require the first release's verified OpenCode V2 version,
   `0.0.0-beta-19425`, and reject an unsupported CLI or an unparseable config
   path before changing files.
4. Run a complete ownership and writeability preflight for every target Gvozd
   file.
5. Read the available model list from `opencode models`.
6. Run the interactive provider and model selection flow.
7. Show the exact package registration and file write plan.
8. Require confirmation unless `--yes` was supplied.
9. Register the current compatible minor range, initially
   `@nail00749/agent-gvozd@^0.1.0`, through `plugin add`.
10. Atomically write the global Gvozd config, schema, and managed agent files.
11. Restart the OpenCode service.
12. Run the same checks as `gvozd doctor` and print the final result.

Installing the plugin before writing agents is intentional. If package
registration succeeds but a later file operation fails, no new unguarded Gvozd
writer agent is introduced. The result is reported as a partial setup with a
safe rerun command. Setup does not automatically remove a successfully
registered plugin during rollback.

All generated agents are preflighted as one batch. If any target exists without
the Gvozd ownership marker, setup fails before writing any agent file and lists
the conflicts. Managed files are written through same-directory temporary files
and atomic rename. Existing global `config.jsonc` is patched only at the owned
model fields, preserving comments, formatting where practical, unrelated
fields, permissions, skills, MCP configuration, and custom agents.

## Interactive experience

The CLI uses `@clack/prompts` for a compact, step-oriented interface. The first
wizard keeps the team composition fixed and asks only questions required to
produce a valid model configuration:

```text
◇ OpenCode installation detected
◇ Select a model provider
◇ Choose the fast model preference
◇ Choose the deep model preference
◇ Review generated changes
◆ Run setup?
◇ Running doctor
```

Cancellation is a normal exit with no file changes. Errors use short summaries
and remediation commands rather than stack traces unless a future debug flag is
added.

## Provider and model architecture

The source of truth for availability is the live line-oriented output from
`opencode models`. The CLI parses exact `provider/model` references, groups
them by provider, and never treats a hardcoded provider list as availability.

Provider recommendations are data adapters behind one interface:

```ts
interface ProviderPreset {
  id: string
  label: string
  recommend(catalog: ModelCatalog): {
    fast: string[]
    deep: string[]
    agentOverrides?: Record<string, string[]>
  } | undefined
}
```

The first release includes an OpenAI preset matching the current Gvozd defaults.
Every provider observed in the live catalog is still selectable even without a
preset. For an unknown provider, the wizard presents its actual models and asks
the user to select fast and deep preferences manually. Adding Anthropic,
Google, OpenRouter, Ollama, or another recommendation later requires adding a
preset, not changing wizard control flow or config persistence.

The CLI does not authenticate providers. If a requested provider is absent, it
directs the user to OpenCode's own auth flow and exits without changing the
current model configuration.

The global config continues to use the existing `agents.<id>.models` arrays.
The fast-first preference applies to `back-fast`, `front-fast`, `review-fast`,
`researcher`, `git`, `docs`, and `verifier`. The deep-first preference applies
to `master`, `planner`, `back-deep`, `front-deep`, `review-deep`, `debugger`,
`security`, and `devops`. A preset may supply a role-specific override; the
initial OpenAI preset retains `gpt-5.3-codex-spark` first for `explorer` and the
selected fast model as its fallback. For an unknown provider, Explorer uses
the fast-first preference because no provider-specific lightweight model is
known. Manual per-agent arrays already present in the global file are preserved
unless the user confirms the new profile.

With `--yes`, a valid existing profile is retained. On a fresh setup the
OpenAI preset is selected only when all of its required models are present. If
neither condition holds, setup exits before writes and instructs the user to
run the interactive wizard; it never chooses an unknown provider implicitly.

## Runtime changes

Package activation must no longer require project-local
`.opencode/agents/*.md` files. The agent transform updates every discovered
Gvozd agent and skips an absent definition without aborting plugin activation;
the permission gate remains installed for every configured Gvozd agent. Doctor
reports the exact missing global managed files and the setup command that
creates them. Project-local generated files remain valid for the legacy `sync`
workflow, but `doctor` warns when both global and project-local Gvozd agent or
plugin definitions would load together.

Global configuration resolution follows OpenCode's config root. The CLI records
the resolved root in the managed setup, and the runtime loader follows the
platform/XDG config convention used by OpenCode. `doctor` compares that result
with `opencode debug paths` and fails on a mismatch rather than silently loading
a different configuration.

The cooperative file-lease behavior, tool visibility, permission gate, TTLs,
and project-root lease boundaries are unchanged. A global plugin instance still
creates a separate in-memory lease manager for each loaded project context.

## Doctor contract

`gvozd doctor` performs no writes, package updates, service restarts, or auth
changes. It checks:

- an OpenCode V2 executable is available and its version is compatible;
- the background service is reachable;
- the exact Gvozd package is registered and active according to `plugin list`;
- package and config schema versions are compatible;
- the global JSONC and every resolved agent patch pass validation;
- the selected models exist in `opencode models`;
- every enabled Gvozd agent appears in `opencode debug agents`;
- all expected global agent files are managed and current;
- no legacy local wrapper or duplicate local Gvozd agents are active for the
  current directory;
- `plugin check` does not report an installation failure or incompatible
  update state.

Human output groups checks and uses `PASS`, `WARN`, and `FAIL`. Each warning or
failure includes its evidence and an exact remediation command when one is
safe. Secrets, auth tokens, environment values, and full unrelated OpenCode
configuration are never printed.

Exit codes are:

- 0: no failures; warnings may be present;
- 1: at least one failed diagnostic;
- 2: invalid CLI invocation.

`--json` writes one JSON object to stdout with a schema version, overall status,
and an ordered list of checks. Progress and decorative output are disabled in
JSON mode. Operational errors are represented as failed checks rather than
mixed into stdout, making the output usable in CI and bug reports.

## Internal modules

The current single-file CLI is split into focused modules:

- `src/cli.ts`: executable entrypoint and command dispatch;
- `src/cli/setup.ts`: setup orchestration and confirmation flow;
- `src/cli/configure.ts`: interactive provider/model wizard;
- `src/cli/doctor.ts`: read-only checks and renderers;
- `src/cli/opencode.ts`: safe OpenCode process adapter and output parsing;
- `src/cli/paths.ts`: global path resolution;
- `src/cli/provider-catalog.ts`: live catalog parsing and preset interface;
- `src/cli/global-sync.ts`: ownership-safe global agent and schema writes;
- `src/cli/config-store.ts`: targeted JSONC updates and atomic persistence.

Core config merging and agent rendering are extracted from the existing sync
implementation where necessary so project and global generation use one
contract. Command modules depend on injected process, filesystem-root, prompt,
and output interfaces in tests; they do not mutate the real home directory.

## npm package contract

`package.json` changes to:

- `name`: `@nail00749/agent-gvozd`;
- remove `private`;
- `license`: `MIT`;
- public repository, homepage, bugs, description, and keywords;
- `publishConfig.access`: `public`;
- `bin.gvozd`: the built CLI entrypoint;
- `exports["."]` and `exports["./server"]`: the built plugin entrypoint;
- `files`: only `dist`, `defaults`, `README.md`, and `LICENSE`;
- a Node engine compatible with the built CLI;
- lifecycle scripts that build and validate the tarball before publication.

The plugin bundle targets Bun/OpenCode and keeps `@opencode/plugin` external.
The CLI bundle targets supported Node.js and contains its user-interface and
JSONC dependencies, so `npx` works without a global Bun installation. Both
outputs are ESM, and the CLI artifact has a Node shebang and executable mode.

The tarball does not contain tests, source files, generated project state,
`.opencode`, `docs/superpowers`, or local configuration. Package defaults and
prompt assets remain included because runtime config resolution needs them.

The MIT license names `nail00749` as copyright holder. Actual publication,
registry authentication, GitHub repository creation, push, tag, and release are
separate externally mutating steps requiring explicit authorization.

## Failure handling

- Missing OpenCode: fail before writes and show the official installation
  prerequisite.
- Unsupported OpenCode version: fail before writes and report the supported
  range.
- Empty model catalog: retain existing config and direct the user to OpenCode
  auth.
- Unmanaged target agent: fail the complete agent write batch and name every
  collision.
- Invalid existing Gvozd JSONC: preserve it unchanged and report the parse
  location.
- Package registration failure: do not generate global writer agents.
- Later setup failure after registration: report partial state and a safe rerun;
  do not silently uninstall the package.
- Service restart failure: keep valid installed files, return failure, and show
  the manual restart plus doctor commands.
- Doctor subprocess timeout or malformed output: report an individual failed
  check without crashing or leaking raw configuration.

## Testing and release verification

Unit tests cover:

- provider/model catalog parsing, grouping, preset selection, and manual
  fallback;
- CLI command/flag validation, cancellation, non-TTY behavior, and exit codes;
- OpenCode executable fallback and subprocess timeouts;
- `debug paths`, `models`, `plugin list`, `plugin check`, and `debug agents`
  parsing;
- targeted JSONC updates that preserve comments and unrelated fields;
- global agent batch preflight, marker ownership, atomic replacement, and
  collision refusal;
- doctor PASS/WARN/FAIL aggregation, JSON schema, and redaction;
- partial setup failures and idempotent reruns.

Integration tests use a temporary config root and a fake OpenCode executable.
They exercise setup, config, doctor, and legacy sync without reading or writing
the developer's real global configuration.

Repository verification is:

```bash
bun test
bun run typecheck
bun run build
bun run sync -- --check
npm pack --dry-run --json
```

The packed tarball is then extracted into a temporary directory. Tests invoke
its Node CLI against the fake OpenCode executable and import its plugin
entrypoint with production dependencies installed. A clean temporary OpenCode
config smoke verifies global agent discovery, plugin activation, selected model
resolution, and a green `gvozd doctor` from the packed artifact.

An independent read-only review checks the complete release diff, install
mutation boundaries, command injection resistance, config preservation,
diagnostic redaction, and tarball contents. Findings are fixed before a release
commit.

## Acceptance criteria

- A new user can run one interactive `npx ... setup` command and use Master in
  any OpenCode project afterward.
- Setup never overwrites an unmanaged global agent or unrelated OpenCode/Gvozd
  configuration.
- Rerunning setup is idempotent and is the documented first-release upgrade
  path.
- The wizard uses the live model catalog, recommends OpenAI defaults when
  available, and supports any unknown provider through manual model selection.
- Provider credentials remain entirely under OpenCode control.
- Doctor is read-only, redacts sensitive data, produces stable JSON, and returns
  documented exit codes.
- No project-local sync is required for normal global use.
- Legacy project-local sync remains functional and duplicate global/local
  installations are diagnosed.
- The npm tarball contains only the documented runtime, CLI, defaults, README,
  license, and package metadata.
- The packed artifact, not only the source checkout, passes CLI and OpenCode
  activation smoke tests.
- The implementation is committed and release-ready, but npm publication and
  GitHub external mutations remain unperformed until separately authorized.

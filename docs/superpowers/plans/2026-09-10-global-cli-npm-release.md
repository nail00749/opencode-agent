# Global CLI and npm Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a publish-ready `@nail00749/agent-gvozd` package with global guided setup, live model-provider selection, and a read-only doctor.

**Architecture:** Focused CLI modules wrap OpenCode process calls, the live model catalog, global managed files, JSONC persistence, setup orchestration, and diagnostics behind injected interfaces. Setup generates the required agent Markdown once in OpenCode's global config directory; the runtime keeps package → global → project layering. npm publishes built ESM artifacts plus defaults and public docs.

**Tech Stack:** TypeScript 7, Bun 1.4.2, Node.js >=20.12.0, `@clack/prompts` 1.8.0, `jsonc-parser` 3.3.1, Zod 4.4.3, OpenCode V2 `0.0.0-beta-19425`

**Spec:** `docs/superpowers/specs/2026-09-10-global-cli-npm-release-design.md`

## Global Constraints

- Publish as `@nail00749/agent-gvozd` version `0.1.0` under MIT.
- Target only OpenCode V2 `0.0.0-beta-19425` in the first release.
- Normal installation is global and must not require project-local sync.
- Obtain the config root from `opencode debug paths`; never hardcode the user's home path in the CLI.
- Never configure provider credentials or print secrets or unrelated OpenCode configuration.
- Refuse to overwrite unmanaged agent files and preserve unrelated JSONC fields/comments.
- Spawn OpenCode directly with argv arrays; never compose shell commands from user input.
- Keep doctor read-only with stable human and JSON output.
- Preserve `gvozd sync` as the legacy project-local workflow.
- Do not publish, push, tag, or create the GitHub repository during implementation.

---

### Task 1: Shared agent rendering and global managed files

**Files:**
- Create: `src/agent-generation.ts`
- Create: `src/agent-generation.test.ts`
- Create: `src/cli/global-sync.ts`
- Create: `src/cli/global-sync.test.ts`
- Modify: `src/sync.ts`

**Interfaces:**
- Produces: `renderAgent(agent: AgentConfig): string`.
- Produces: `writeManagedAgents(input: GlobalSyncInput): GlobalSyncResult`.
- Preserves: `syncAgents(config, options)` byte-for-byte output and project-local behavior.

- [ ] **Step 1: Write renderer and global-preflight tests**

Test the extracted renderer and a temporary global `agents/` directory:

~~~ts
expect(renderAgent(agent)).toContain(GENERATED_MARKER)
expect(renderAgent(agent)).toContain('description: "test agent"')
expect(writeManagedAgents({ configRoot, agents, check: true }).created).toContain("master.md")
writeFileSync(join(configRoot, "agents", "master.md"), "user owned\n")
expect(() => writeManagedAgents({ configRoot, agents })).toThrow("unmanaged")
~~~

Also prove that one unmanaged collision prevents every pending write.

- [ ] **Step 2: Run focused tests and confirm missing modules**

Run: `bun test src/agent-generation.test.ts src/cli/global-sync.test.ts`
Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Extract rendering and implement batch-safe global writes**

Define:

~~~ts
export interface GlobalSyncInput {
  configRoot: string
  agents: Record<string, AgentConfig>
  check?: boolean
}
export interface GlobalSyncResult {
  created: string[]
  updated: string[]
  unchanged: string[]
  conflicts: string[]
}
~~~

Preflight every enabled target before directory creation or writes. Accept replacement only when `GENERATED_MARKER` is present. Write with same-directory temporary files and atomic rename.

- [ ] **Step 4: Verify old and new generation paths**

Run: `bun test src/agent-generation.test.ts src/cli/global-sync.test.ts && bun run sync -- --check`
Expected: PASS and every existing project artifact unchanged.

- [ ] **Step 5: Commit**

~~~bash
git add src/agent-generation.ts src/agent-generation.test.ts src/cli/global-sync.ts src/cli/global-sync.test.ts src/sync.ts
git commit -m "refactor: share global agent generation"
~~~

### Task 2: OpenCode process adapter and provider catalog

**Files:**
- Create: `src/cli/opencode.ts`
- Create: `src/cli/opencode.test.ts`
- Create: `src/cli/provider-catalog.ts`
- Create: `src/cli/provider-catalog.test.ts`

**Interfaces:**
- Produces: `findOpenCode()`, `parseDebugPaths()`, `parseModels()`, `recommendProfile()`.
- Consumes: injected `ProcessRunner` calls expressed as executable plus argv arrays.
- Produces: provider-neutral `ModelCatalog` and `ModelProfile`.

- [ ] **Step 1: Test executable fallback and parsers**

~~~ts
const client = await findOpenCode(fakeRunner({ opencode2: "ENOENT", opencode: "ok" }))
expect(client.executable).toBe("opencode")
expect(parseDebugPaths("config /tmp/opencode\n").config).toBe("/tmp/opencode")
expect(parseModels("openai/a\nanthropic/b\n").providers.get("openai")).toEqual(["openai/a"])
~~~

Cover non-zero exits, timeouts, bounded stderr, non-absolute config paths, and malformed model references.

- [ ] **Step 2: Implement the process boundary**

~~~ts
export interface ProcessResult { code: number; stdout: string; stderr: string }
export interface ProcessRunner {
  run(executable: string, args: readonly string[], timeoutMs?: number): Promise<ProcessResult>
}
export interface OpenCodeClient {
  executable: string
  version(): Promise<string>
  debugPaths(): Promise<Record<string, string>>
  models(): Promise<string[]>
  pluginAdd(spec: string): Promise<void>
  pluginList(): Promise<string>
  pluginCheck(spec?: string): Promise<string>
  debugAgents(): Promise<string>
  serviceStatus(): Promise<string>
  serviceRestart(): Promise<void>
}
~~~

Use `Bun.spawn` only in the default runner. Pass argv separately, cap captured output, and terminate timed-out children.

- [ ] **Step 3: Test presets and unknown-provider fallback**

The OpenAI case must produce Luna fast-first, Sol deep-first, and Spark first for Explorer only when all exist. An unknown provider must accept only its catalogued fast/deep choices and use fast-first for Explorer.

- [ ] **Step 4: Implement the provider-neutral contract**

~~~ts
export interface ModelProfile {
  provider: string
  fast: string[]
  deep: string[]
  agentOverrides: Record<string, string[]>
}
export interface ProviderPreset {
  id: string
  label: string
  recommend(catalog: ModelCatalog): ModelProfile | undefined
}
~~~

Run: `bun test src/cli/opencode.test.ts src/cli/provider-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/cli/opencode.ts src/cli/opencode.test.ts src/cli/provider-catalog.ts src/cli/provider-catalog.test.ts
git commit -m "feat: discover OpenCode models for setup"
~~~

### Task 3: Comment-preserving global profile persistence

**Files:**
- Create: `src/cli/config-store.ts`
- Create: `src/cli/config-store.test.ts`
- Modify: `src/config.ts`
- Modify: `defaults/schema.json`

**Interfaces:**
- Produces: `applyModelProfile(source, profile): string`, `writeGlobalConfig(input): void`, and `resolveOpenCodeConfigRoot()`.
- Preserves: package → global → project precedence.

- [ ] **Step 1: Test targeted JSONC edits and root resolution**

~~~ts
const updated = applyModelProfile('{ // keep\n "custom": 1, "agents": {}\n}', profile)
expect(updated).toContain("// keep")
expect(updated).toContain('"custom": 1')
expect(parse(updated).agents.master.models).toEqual(profile.deep)
expect(resolveOpenCodeConfigRoot({ XDG_CONFIG_HOME: "/tmp/xdg" }, "linux", "/home/u"))
  .toBe("/tmp/xdg/opencode")
~~~

Cover every exact fast/deep role, Explorer override, invalid JSONC, unrelated fields, idempotence, Windows APPDATA, and Unix fallback.

- [ ] **Step 2: Implement targeted edits and atomic persistence**

Use `jsonc-parser.modify` plus `applyEdits` only at `agents.<id>.models`. Parse before producing writes. Atomically write global `config.jsonc` and the marker-owned schema without changing valid files when selection fails.

- [ ] **Step 3: Align runtime config root resolution**

Allow an explicit config root for tests/CLI while existing runtime callers follow the platform/XDG convention. Keep prompt containment and config-layer semantics intact.

Run: `bun test src/cli/config-store.test.ts src/config.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

~~~bash
git add src/cli/config-store.ts src/cli/config-store.test.ts src/config.ts defaults/schema.json
git commit -m "feat: persist global Gvozd model profiles"
~~~

### Task 4: Read-only doctor

**Files:**
- Create: `src/cli/doctor.ts`
- Create: `src/cli/doctor.test.ts`

**Interfaces:**
- Produces: `runDoctor(input): Promise<DoctorReport>`, `renderDoctorHuman()`, and `renderDoctorJson()`.
- Consumes: `OpenCodeClient`, resolved config, expected agents, current directory, and package metadata.

- [ ] **Step 1: Define and test stable diagnostics**

~~~ts
export interface DoctorCheck {
  id: string
  status: "pass" | "warn" | "fail"
  summary: string
  remediation?: string
}
export interface DoctorReport {
  schemaVersion: 1
  status: "pass" | "warn" | "fail"
  checks: DoctorCheck[]
}
~~~

Test deterministic order, aggregation, exit codes, single-object JSON output, and absence of decorative output in JSON mode.

- [ ] **Step 2: Test every required diagnostic**

Fake version, service status, plugin list/check, global JSONC/schema, model catalog, debug agents, managed agent files, and current-project legacy duplicates. Prove redaction of token/password/authorization assignments and exclusion of full unrelated config.

- [ ] **Step 3: Implement read-only checks and renderers**

Run only read/list/status commands. Convert each bounded subprocess failure into its own check. Never invoke plugin add, restart, auth, or filesystem writes.

Run: `bun test src/cli/doctor.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

~~~bash
git add src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "feat: add read-only Gvozd doctor"
~~~

### Task 5: Interactive configure and global setup

**Files:**
- Create: `src/cli/configure.ts`
- Create: `src/cli/configure.test.ts`
- Create: `src/cli/setup.ts`
- Create: `src/cli/setup.test.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `chooseModelProfile()`, `runSetup()`, `runConfigure()`, and exact CLI dispatch.
- Consumes: Tasks 1-4 and an injected prompt adapter backed by `@clack/prompts` 1.8.0.

- [ ] **Step 1: Add the exact prompt dependency**

Run: `bun add --exact @clack/prompts@1.8.0`
Expected: only `package.json` and `bun.lock` dependency state changes.

- [ ] **Step 2: Test wizard behavior**

~~~ts
export interface PromptUI {
  select<T>(input: SelectInput<T>): Promise<T | symbol>
  confirm(input: ConfirmInput): Promise<boolean | symbol>
  intro(message: string): void
  outro(message: string): void
}
~~~

Cover preset selection, unknown-provider manual selection, valid-profile retention, cancellation before writes, and non-TTY rejection when `--yes` lacks deterministic defaults.

- [ ] **Step 3: Test setup ordering and partial failure**

~~~ts
expect(calls).toEqual([
  "detect", "paths", "version", "preflight", "models", "prompt", "confirm",
  "plugin-add", "write-config", "write-agents", "restart", "doctor",
])
~~~

Prove plugin-add failure writes nothing; later failure never uninstalls; rerun is idempotent; `--yes` retains a valid profile or chooses only the complete OpenAI preset.

- [ ] **Step 4: Implement setup/configure and CLI dispatch**

The real UI adapter alone imports `@clack/prompts`. Register `@nail00749/agent-gvozd@^0.1.0`, persist global config/agents, restart, then run doctor. Support `setup`, `config`, `doctor`, and legacy `sync`; invalid usage exits 2.

Run: `bun test src/cli && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add package.json bun.lock src/cli.ts src/cli/configure.ts src/cli/configure.test.ts src/cli/setup.ts src/cli/setup.test.ts
git commit -m "feat: add global Gvozd setup wizard"
~~~

### Task 6: Runtime activation from global agents

**Files:**
- Modify: `src/index.ts`
- Create: `src/index.test.ts`
- Modify: `src/config.test.ts`

**Interfaces:**
- Consumes: globally discovered agent Markdown and global config root resolution.
- Produces: activation that skips missing definitions while retaining fail-closed permission/lease enforcement for configured Gvozd IDs.

- [ ] **Step 1: Test a project with no local generated agents**

Use an agent-editor harness seeded only with global Gvozd IDs. Assert setup succeeds and every present definition receives the configured prompt, model, and permissions.

- [ ] **Step 2: Test partial global setup safety**

Omit one writer definition. Assert setup does not abort or fabricate it, while a permission event bearing that configured agent ID still fails closed.

- [ ] **Step 3: Remove the project-file prerequisite**

Delete the `projectRoot/.opencode/agents` marker requirement. Check `agents.get(id)` before update and skip only absent definitions. Keep disabled-agent removal and the complete lease runtime unchanged.

Run: `bun test src/index.test.ts src/config.test.ts src/file-lease-plugin.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

~~~bash
git add src/index.ts src/index.test.ts src/config.test.ts
git commit -m "feat: load Gvozd from global OpenCode setup"
~~~

### Task 7: Public build, metadata, license, and docs

**Files:**
- Create: `LICENSE`
- Create: `scripts/verify-package.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `dist/index.js`, `dist/cli.js`, and a minimal npm tarball.
- Consumes: all runtime/CLI modules and package defaults.

- [ ] **Step 1: Test approved package contents**

The verifier must reject paths outside this allowlist and require both dist entrypoints:

~~~text
package.json
README.md
LICENSE
dist/**
defaults/**
~~~

- [ ] **Step 2: Build separate runtime and CLI artifacts**

Build the plugin for Bun with `@opencode/plugin` external. Build the CLI for Node.js with bundled UI/JSONC dependencies and a `#!/usr/bin/env node` shebang. Clean only repository `dist`.

- [ ] **Step 3: Apply exact public package metadata**

Set name `@nail00749/agent-gvozd`, version `0.1.0`, MIT, repository `git+https://github.com/nail00749/opencode-agent.git`, homepage, bugs, public publishConfig, Node `>=20.12.0`, `bin.gvozd=./dist/cli.js`, both exports to `./dist/index.js`, and files `dist/defaults/README/LICENSE`. Remove `private` and add description/keywords.

- [ ] **Step 4: Add MIT and public documentation**

Create standard MIT text with `Copyright (c) 2026 nail00749`. Lead README with global npx setup, bunx alternative, doctor, supported beta, managed global files, provider behavior, project overrides, legacy local development, upgrade rerun, and same-process lease limits.

- [ ] **Step 5: Verify repository and tarball**

Run:

~~~bash
bun test
bun run typecheck
bun run build
bun run sync -- --check
npm_config_cache=/private/tmp/agent-gvozd-npm-cache npm pack --dry-run --json
~~~

Expected: green; tarball contains no source, tests, project state, or planning docs.

- [ ] **Step 6: Commit**

~~~bash
git add LICENSE scripts/verify-package.ts package.json README.md .gitignore
git commit -m "chore: prepare Gvozd npm package"
~~~

### Task 8: Packed-artifact acceptance and review

**Files:**
- Create: `src/cli/package-smoke.test.ts`
- Modify only files required by concrete acceptance or review findings.

**Interfaces:**
- Consumes: final tarball, fake OpenCode fixture, exact spec acceptance criteria.
- Produces: shipped-artifact setup/doctor evidence and independent review.

- [ ] **Step 1: Exercise the packed Node CLI**

Pack/extract in a temporary directory, run `node package/dist/cli.js setup --yes` with a fake OpenCode executable and temporary config root, and assert registration argv, global agents, model config, restart, and green doctor.

- [ ] **Step 2: Exercise idempotence and failures**

Run setup twice, human/JSON doctor, missing model, unmanaged collision, and legacy duplicate warning. Assert no real-home access.

- [ ] **Step 3: Run isolated real OpenCode smoke**

Use temporary `XDG_CONFIG_HOME` and the local tarball against exact OpenCode beta. Verify plugin list, debug agents, selected models, service reload, and doctor without touching the active global config.

- [ ] **Step 4: Independent read-only review**

Review the complete diff from `05fa91a` plus spec and tarball list for command injection, config loss, diagnostic leakage, runtime regressions, and packaging gaps. Fix findings and rerun invalidated checks.

- [ ] **Step 5: Final readiness and commit**

Run full tests/type/build/sync/tarball checks, `git diff --check`, and confirm no tarball or temporary config remains. Do not publish, push, tag, release, or create the GitHub repository.

~~~bash
git add src package.json bun.lock README.md LICENSE scripts
git commit -m "test: verify packed Gvozd setup"
~~~


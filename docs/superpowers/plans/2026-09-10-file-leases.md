# Cooperative File Leases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent parallel Gvozd writer sessions from editing overlapping files in one OpenCode V2 process.

**Architecture:** A standalone in-memory lease manager owns canonical file reservations and session binding. The plugin exposes coordinator and writer tools, enforces leases in the permission hook, removes tools by agent role, and releases leases from session lifecycle events.

**Tech Stack:** TypeScript 7, Bun 1.4, Zod 4, OpenCode V2 Promise plugin API `0.0.0-beta-19425`

**Spec:** `docs/superpowers/specs/2026-09-10-file-leases-design.md`

## Global Constraints

- Coordinate only sessions inside one OpenCode process and one canonical project root.
- Accept exact project-relative file paths only; no globs or directory scopes.
- Deny mutation when lease identity or OpenCode mutation resources cannot be verified.
- Never parse arbitrary shell strings to infer whether they are safe.
- Preserve package default -> global override -> project override precedence.
- Do not add an external runtime dependency.

---

### Task 1: Lease state machine and canonical paths

**Files:**
- Create: `src/file-leases.ts`
- Create: `src/file-leases.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `FileLeaseManager`, `LeaseError`, `LeaseRecord`, `LeaseStatus`, and `FileLeaseManagerOptions`.
- Produces: `reserve`, `extend`, `claim`, `authorizeMutation`, `touchSession`, `release`, `releaseSession`, `listForCoordinator`, `hasActiveLeases`, `sweep`, and `clear` methods.
- Consumes: project root, clock callback, random ID callback, and TTL values supplied at construction.

- [ ] **Step 1: Add focused failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileLeaseManager, LeaseError } from "./file-leases"

test("reserve is atomic when one requested file conflicts", () => {
  const manager = fixture()
  manager.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "one", files: ["src/a.ts"] })
  expect(() => manager.reserve({ parentSessionID: "master-1", agent: "front-fast", label: "two", files: ["src/b.ts", "src/a.ts"] })).toThrow(LeaseError)
  expect(manager.status("src/b.ts")).toBeUndefined()
})

test("claim requires matching direct child and assignee", () => {
  const manager = fixture()
  const lease = manager.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "one", files: ["src/a.ts"] })
  expect(() => manager.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-2", agent: "back-fast" })).toThrow(LeaseError)
})
```

- [ ] **Step 2: Run tests and confirm the module is missing**

Run: `bun test src/file-leases.test.ts`
Expected: FAIL because `src/file-leases.ts` does not exist.

- [ ] **Step 3: Implement the dependency-free lease manager**

```ts
export type FileLeaseRole = "coordinator" | "writer" | "readonly"

export interface ReserveInput {
  parentSessionID: string
  agent: string
  label: string
  files: readonly string[]
}

export interface ClaimInput {
  leaseId: string
  sessionID: string
  parentSessionID?: string
  agent: string
}

export class FileLeaseManager {
  reserve(input: ReserveInput): LeaseStatus
  extend(input: { leaseId: string; parentSessionID: string; files: readonly string[] }): LeaseStatus
  claim(input: ClaimInput): LeaseStatus
  authorizeMutation(sessionID: string, resources: readonly string[]): LeaseStatus
  touchSession(sessionID: string): void
  release(leaseId: string, parentSessionID: string): void
  releaseSession(sessionID: string): void
  listForCoordinator(parentSessionID: string): LeaseStatus[]
  hasActiveLeases(): boolean
  sweep(): void
  clear(): void
}
```

Use synchronous map updates without an intervening `await`, so conflict check plus insertion is atomic within the JavaScript event loop. Canonicalize existing ancestors with `realpathSync`, append non-existing suffixes, and verify containment with `path.relative`.

- [ ] **Step 4: Cover boundaries and lifecycle**

Add tests for absolute/escaping/directory paths, symlink aliases, new files, idempotent reserve/claim/release, extension rollback, one lease per session, mutation authorization, activity refresh, expiry, status redaction, and terminal session cleanup.

- [ ] **Step 5: Add the package test script and run the unit suite**

```json
"test": "bun test"
```

Run: `bun test src/file-leases.test.ts`
Expected: PASS.

### Task 2: Fail-closed agent role configuration

**Files:**
- Modify: `src/config.ts`
- Modify: `defaults/schema.json`
- Modify: `defaults/agents/*.jsonc`
- Create: `src/config.test.ts`

**Interfaces:**
- Consumes: `FileLeaseRole` from `src/file-leases.ts`.
- Produces: `AgentConfig.fileLease: FileLeaseRole` for every resolved agent.

- [ ] **Step 1: Test the fail-closed default and layer override**

```ts
test("custom agents default to readonly file leases", () => {
  const config = loadFixture({ agents: { custom: customAgent() } })
  expect(config.agents.custom?.fileLease).toBe("readonly")
})

test("later layers replace fileLease as a scalar", () => {
  const config = loadLayeredFixture("writer")
  expect(config.agents.custom?.fileLease).toBe("writer")
})
```

- [ ] **Step 2: Run the focused config tests**

Run: `bun test src/config.test.ts`
Expected: FAIL because `fileLease` is not parsed.

- [ ] **Step 3: Extend Zod and JSON schemas**

Add `fileLease: z.enum(["coordinator", "writer", "readonly"]).optional()` to patches, require it in resolved agents, and inject `fileLease: "readonly"` before applying patches. Add the matching enum and description to `defaults/schema.json`.

- [ ] **Step 4: Assign every built-in role explicitly**

Set `master` to `coordinator`; backend, frontend, Docs, and DevOps roles to `writer`; all other built-ins to `readonly`.

- [ ] **Step 5: Run config, full tests, and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

### Task 3: OpenCode tools, mutation gate, and lifecycle cleanup

**Files:**
- Create: `src/file-lease-plugin.ts`
- Create: `src/file-lease-plugin.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `FileLeaseManager`, resolved agent roles, `Plugin.Context`, and OpenCode tool/session identifiers.
- Produces: `installFileLeasePlugin(ctx, config)` returning one async cleanup function.
- Produces tools `gvozd_lease` and `gvozd_claim`.

- [ ] **Step 1: Test tool visibility and executor authorization**

```ts
test("only coordinators see gvozd_lease", async () => {
  const harness = await pluginHarness()
  const tools = await harness.sessionTools("back-fast")
  expect(tools.gvozd_lease).toBeUndefined()
  expect(tools.gvozd_claim).toBeDefined()
})

test("claim rejects a sibling or wrong agent", async () => {
  const harness = await pluginHarness()
  const leaseId = await harness.reserve("master-1", "back-fast", ["src/a.ts"])
  await expect(harness.claim("child-1", "master-2", "back-fast", leaseId)).rejects.toThrow()
})
```

- [ ] **Step 2: Test permission enforcement before implementation**

Cover valid edit resources, missing resources, out-of-scope paths, readonly edits, coordinator/writer shell denial, auxiliary ask-shell denial while a lease is active, and exact built-in Git read command allowance.

- [ ] **Step 3: Implement tool registration and context filtering**

Register Zod-backed tools through `ctx.tool.transform`. Filter them in `ctx.session.hook("context")`; also check the configured role inside each executor. `gvozd_claim` obtains the current session through `ctx.session.get({ sessionID })` and passes its `parentID` to the manager.

- [ ] **Step 4: Integrate the permission gate**

Extend the existing permission hook rather than adding a competing permission workflow. For `edit`, deny unless the manager authorizes every resource. For `shell` and `bash`, override coordinator/writer actions to deny. While a lease is active, deny non-whitelisted auxiliary shell operations.

- [ ] **Step 5: Integrate lifecycle and cleanup**

Release by session ID for `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted`, `session.idle`, and `session.deleted`. Add a sweep timer, `unref()` it, and dispose tool/session/permission registrations plus the event subscription in one cleanup path.

- [ ] **Step 6: Run integration tests and repository checks**

Run: `bun test src/file-lease-plugin.test.ts && bun test && bun run typecheck && bun run build`
Expected: PASS.

### Task 4: Generated workflow contract and documentation

**Files:**
- Modify: `defaults/prompts/master.md`
- Modify: `defaults/prompts/back-fast.md`
- Modify: `defaults/prompts/back-deep.md`
- Modify: `defaults/prompts/front-fast.md`
- Modify: `defaults/prompts/front-deep.md`
- Modify: `defaults/prompts/docs.md`
- Modify: `defaults/prompts/devops.md`
- Modify: `README.md`
- Regenerate: `.opencode/agents/*.md`
- Regenerate: `docs/.gvozd/schema.json`

**Interfaces:**
- Consumes: tool names and behavior from Task 3.
- Produces: exact coordinator/writer instructions matching runtime enforcement.

- [ ] **Step 1: Update Master delegation instructions**

Require Explorer before parallel writers, exact non-overlapping files, `gvozd_lease reserve`, lease ID propagation, scope extension through Master, and Verifier only after releases.

- [ ] **Step 2: Update every writer prompt**

Require `gvozd_claim` before mutation, structured edits only, no self-expansion, and a concise return to Master when another file is needed.

- [ ] **Step 3: Document guarantees and limitations**

Add configuration roles, same-process scope, shell restrictions, TTL behavior, failure recovery, and a minimal workflow example to `README.md`.

- [ ] **Step 4: Regenerate and verify owned artifacts**

Run: `bun run sync && bun run sync -- --check`
Expected: sync updates owned generated agents/schema; check exits zero with no diff.

### Task 5: Runtime acceptance and independent review

**Files:**
- Modify only files required to fix findings in Tasks 1-4.

**Interfaces:**
- Consumes: the complete implemented plugin and generated agents.
- Produces: current unit/build evidence, OpenCode runtime evidence, and an independent diff review.

- [ ] **Step 1: Run the complete local verification set**

Run: `bun test && bun run typecheck && bun run build && bun run sync -- --check`
Expected: every command exits zero.

- [ ] **Step 2: Reload the pinned OpenCode service**

Run: `opencode2 service restart`
Expected: the local service restarts and loads `agent-gvozd` without activation errors.

- [ ] **Step 3: Execute the six smoke scenarios from the spec**

Record disjoint parallel claims, overlap rejection, out-of-scope edit denial, writer shell denial, post-release Verifier execution, and generated-agent loading. Do not substitute build output for runtime permission evidence.

- [ ] **Step 4: Request one independent reviewer**

Give the reviewer the complete diff from `94ea5d6`, surrounding source, spec, and test results. Fix correctness, security, or regression findings and rerun invalidated checks.

- [ ] **Step 5: Commit the verified implementation**

```bash
git add package.json src defaults README.md .opencode/agents docs/.gvozd/schema.json docs/superpowers/plans/2026-09-10-file-leases.md
git commit -m "feat: coordinate parallel writer file leases"
```

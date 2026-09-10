# Cooperative File Leases Design

## Purpose

Allow Gvozd writer subagents to work in parallel in one OpenCode V2 process without silently overwriting each other's files. Explorer discovers the expected file sets, Master reserves non-overlapping work packages, and the plugin enforces those reservations before structured file mutations execute.

The first version coordinates child sessions created by one OpenCode process for one project root. Coordination between separate OpenCode processes, windows backed by different server processes, or remote hosts is out of scope.

## Goals

- Detect overlapping writer scopes before parallel work starts.
- Require each writer child session to claim the lease assigned by its parent Master session.
- Deny structured mutations outside the active lease.
- Prevent arbitrary shell commands from bypassing an active writer lease.
- Release leases deterministically on session completion and recover abandoned in-process reservations.
- Preserve the existing layered configuration and generated-agent workflow.

## Non-goals

- Automatically merge two implementations of the same file.
- Coordinate independent OpenCode server processes.
- Infer safe write targets from arbitrary shell text.
- Support directory or glob leases in the first version.
- Replace OpenCode's own path-containment, symlink, permission, or stale-edit checks.

## Agent roles

Each resolved agent gains a `fileLease` field with one of these values:

- `coordinator`: may reserve, extend, inspect, and release leases. It must reserve and claim a lease before making its own structured file mutation.
- `writer`: may claim a lease assigned to its agent ID. It must have an active claimed lease before making a structured file mutation.
- `readonly`: cannot claim a writer lease and is denied structured file mutations by the Gvozd gate.

The default value is `readonly`, so a newly configured agent does not silently become an unmanaged writer. Package defaults assign:

- `coordinator`: `master`
- `writer`: `back-fast`, `back-deep`, `front-fast`, `front-deep`, `docs`, `devops`
- `readonly`: all other built-in agents

Later global or project layers may override `fileLease`, using the existing scalar-precedence rules.

## Planning and delegation flow

When Master wants to run more than one writer concurrently:

1. Master delegates read-only discovery to Explorer.
2. Explorer returns an exact project-relative file list for every work package, including files expected to be created.
3. Master verifies the packages are independently implementable.
4. Master calls `gvozd_lease` with operation `reserve`, the assignee agent ID, a short task label, and the exact files.
5. The lease manager canonicalizes every path and atomically rejects the entire reservation if any file is already reserved.
6. Master includes the returned opaque `leaseId` in the child task prompt.
7. The child calls `gvozd_claim` before its first mutation. Claiming binds the reservation to the child session.
8. The child uses structured mutation tools only. If it discovers another required file, it stops and reports the path to Master. It does not broaden its own scope.
9. Master either extends the lease after a conflict check or waits and schedules the additional work serially.

For a single writer or a direct Master edit, the same reserve-and-claim contract applies. Explorer is required before parallel writer delegation, but remains optional for an obvious single-file task.

## Lease tools

### `gvozd_lease`

Visible only to a `coordinator` agent. It supports:

- `reserve`: accepts `agent`, `label`, and a non-empty list of exact project-relative `files`; returns `leaseId`, normalized files, and expiry.
- `extend`: accepts a coordinator-owned `leaseId` and additional exact files; checks the complete addition atomically before changing the lease.
- `release`: releases a coordinator-owned reservation or active lease.
- `status`: lists leases created by the current coordinator session without exposing unrelated session prompts or content.

An unclaimed reservation records the coordinator session as `parentSessionID` and the configured assignee as `agent`.

### `gvozd_claim`

Visible only to a `writer` or `coordinator`. It accepts one `leaseId` and succeeds only when:

- the lease exists and has not expired;
- the current agent ID equals the reservation assignee;
- the current session is the reserving session or its direct child;
- the lease is not already bound to another session.

Claim is idempotent for the same session. A session may own at most one active lease in the first version.

Both tools enforce their role and ownership rules inside their executors in addition to tool visibility, so a hidden tool invoked indirectly still fails closed.

## Path and conflict rules

- Lease input uses exact project-relative file paths only.
- Absolute paths, empty paths, the project root, directory-only scopes, and paths escaping the project root are rejected.
- Separators and dot segments are normalized before conflict checks.
- Existing path components are canonicalized so symlink aliases cannot create two lease identities for the same target.
- A file that does not exist may be reserved when its nearest existing ancestor remains inside the canonical project root.
- A reservation is all-or-none: if one requested file conflicts, no new file from that request remains reserved.
- Re-reserving a file into the same lease is idempotent.

The in-memory manager uses canonical absolute paths as conflict keys, but tool output and errors show project-relative paths.

## Mutation enforcement

The existing permission hook remains the authoritative fail-closed gate. For every `edit` permission evaluation:

1. Resolve all reported resources to canonical project files.
2. Deny an empty, malformed, external, or unresolvable resource set.
3. Deny `readonly` agents.
4. Require `coordinator` and `writer` sessions to own a claimed, unexpired lease.
5. Require every target resource to belong to that lease.
6. Refresh the active lease's inactivity deadline after a successful check.

This covers OpenCode's structured `edit`, `write`, and `apply_patch` operations because they use the `edit` permission action and report their mutation targets as resources. Runtime validation against the pinned OpenCode beta is an acceptance criterion. If the host omits a target resource, the plugin denies the operation rather than allowing an unverified write.

The plugin also registers a tool `execute.before` observer to refresh lease activity and produce consistent diagnostics, but tool observation is not treated as the authorization boundary.

## Shell policy

Arbitrary shell is never allowed for `coordinator` or `writer` agents, even if a lower-precedence OpenCode permission proposed `allow` or `ask`. The permission hook overrides both `shell` and `bash` actions to `deny` for these roles.

While at least one writer lease is active, shell operations that would otherwise require approval are denied for every agent. This prevents an approved Git, verifier, debugger, or other auxiliary command from racing active writers. Existing explicitly allowed, package-owned read-only Git inspection commands may continue because their complete command strings are enumerated in the Git agent defaults.

Verifier runs builds, tests, and manual commands after all writer leases have been released. Master must not schedule Verifier concurrently with active writers. Structured `read`, `glob`, and `grep` remain available according to each agent's existing permissions.

The design deliberately does not parse shell command text to decide whether it mutates files.

## Lifecycle and expiry

Lease state lives in the plugin instance and contains:

- `leaseId`
- `parentSessionID`
- optional claimed `sessionID`
- assignee `agent`
- task `label`
- canonical file set
- creation, claim, last-activity, and expiry timestamps

Defaults:

- unclaimed reservation TTL: 5 minutes
- active inactivity TTL: 30 minutes

The plugin refreshes an active lease when its owner passes a mutation check or invokes another tool. It releases the lease when the owner session emits execution success, failure, interruption, idle, or deletion. Releasing an unknown or already released lease is idempotent for its owner.

Expired entries are removed lazily before every lease or mutation operation and by a lightweight periodic sweep. Plugin cleanup stops the sweep, disposes hooks, and clears the in-memory registry. A full OpenCode process crash therefore cannot leave persistent stale locks.

## Failures and user-visible diagnostics

Conflicts fail immediately; the plugin does not wait or retry automatically. Errors include:

- the requested project-relative file;
- the owning agent and task label;
- whether the lease is reserved or active;
- the required next action: change the split, extend the correct lease, or serialize the work.

Errors never expose another session's prompt or generated content. Lease IDs are random opaque identifiers and do not grant access without matching parent/child and agent identity.

If lifecycle observation fails unexpectedly, active leases remain enforced until their inactivity TTL expires or Master releases them. Failure to initialize the lease tools or permission gate aborts plugin setup when any enabled agent is configured as `coordinator` or `writer`.

## Configuration and generated artifacts

The following surfaces change:

- `src/config.ts`: parse and resolve `fileLease` with a fail-closed default.
- `defaults/schema.json`: document the new enum.
- built-in agent JSONC files: assign coordinator, writer, and readonly roles.
- Master and writer prompts: describe Explorer discovery, reservation, claim, scope-expansion, and release behavior.
- generated `.opencode/agents/*.md`: refreshed by the existing `agent-gvozd sync` path so they contain the updated prompts. Lease roles remain plugin configuration and are not emitted as unsupported OpenCode frontmatter.
- `README.md`: document guarantees, limitations, configuration, and operational flow.

No persistent lock files or new external dependency are introduced.

## Internal structure

Lease behavior lives in a focused `src/file-leases.ts` module. It owns path normalization, atomic reservation, claim validation, extension, release, expiry, and safe status projection. It has no OpenCode SDK dependency; callers pass plain session and agent identifiers.

`src/index.ts` owns OpenCode integration: tool registration and per-agent visibility, executor-level role checks, permission checks, session lookup, lifecycle event handling, and cleanup. This keeps the state machine independently testable and prevents the existing plugin setup from absorbing lease semantics.

## Verification

Add Bun tests and a `test` package script. Unit coverage must demonstrate:

- atomic reservation and rollback on overlap;
- path normalization, containment, symlink alias handling, and not-yet-created files;
- parent/child and assignee checks;
- idempotent claim, extension, and release;
- one-active-lease-per-session enforcement;
- expiry and activity refresh;
- mutation denial for missing, expired, foreign, or out-of-scope leases;
- shell denial rules during and outside active writer work;
- cleanup after every terminal session event.

Repository verification consists of:

- `bun test`
- `bun run typecheck`
- `bun run build`
- `bun run sync`
- `bun run sync -- --check`

A manual smoke test against the exact OpenCode beta pinned in `package.json` must demonstrate:

1. two disjoint writer leases can be claimed and edited concurrently;
2. overlapping reservations fail before child dispatch;
3. an out-of-scope structured edit is denied;
4. writer shell is denied;
5. Verifier can run after writers release their leases;
6. generated agents and the local plugin reload successfully.

Completion claims must distinguish unit/type/build evidence from the OpenCode runtime smoke. A green build alone does not prove that the pinned host reports mutation resources as expected.

## Acceptance criteria

- Master can use Explorer output to reserve two disjoint work packages and run their writer agents concurrently.
- No default coordinator or writer can mutate a project file without owning a claimed lease for that exact file.
- An overlap is reported before the conflicting writer starts.
- A writer cannot bypass the lease using shell.
- Missing runtime mutation resources fail closed.
- Leases disappear on terminal session lifecycle events or expiry.
- Existing layered configuration, sync ownership safeguards, and unrelated agent permissions continue to work.
- The documented runtime smoke passes on `@opencode/plugin@0.0.0-beta-19425`, or the remaining host limitation is reported without claiming enforcement is complete.

# Context7 Default Access And 0.1.1 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grant the built-in roles that need current library documentation access to a configured `context7` MCP server and publish the change as `@nail00749/agent-gvozd@0.1.1`.

**Architecture:** Keep the permission model declarative: the selected agent defaults receive the exact server allowlist entry `"context7"`, while `master`, `explorer`, and `git` remain ungranted. The package does not install or configure the server; it only converts the configured name into OpenCode permissions through the existing configuration path.

**Tech Stack:** Bun, TypeScript, JSONC, npm, GitHub CLI

**Spec:** Approved conversation design: Context7 for `planner`, implementation, review, research, docs, verification, debugging, security, and DevOps roles; no grant for `master`, `explorer`, or `git`.

## Global Constraints

- Use the exact MCP server name `context7`.
- Do not install or configure a Context7 MCP server.
- Preserve every existing skill and tool-level permission.
- Publish only after tests and package verification pass.

---

### Task 1: Lock the role allowlist

**Files:**
- Modify: `src/config.test.ts`
- Modify: `defaults/agents/*.jsonc`

**Interfaces:**
- Consumes: `loadConfig(process.cwd())` and built-in agent `mcp` arrays.
- Produces: the exact Context7-enabled role set.

- [ ] **Step 1: Write the failing test**

Add a test that expects `mcp` to equal `["context7"]` for `planner`, `back-fast`, `back-deep`, `front-fast`, `front-deep`, `review-fast`, `review-deep`, `researcher`, `docs`, `verifier`, `debugger`, `security`, and `devops`, and to equal `[]` for `master`, `explorer`, and `git`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test src/config.test.ts`

Expected: FAIL because the selected defaults currently have empty `mcp` arrays.

- [ ] **Step 3: Apply the minimal configuration change**

Replace only the selected roles' `"mcp": []` with `"mcp": ["context7"]`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun test src/config.test.ts`

Expected: PASS.

### Task 2: Document and version the release

**Files:**
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the exact allowlist from Task 1.
- Produces: accurate capability documentation and package version `0.1.1`.

- [ ] **Step 1: Update capability documentation**

Document that selected roles receive server-wide read-only Context7 access only when a server is configured with the exact name `context7`; keep GitLab, GitNexus, and Playwright scoped at tool level. Include every built-in role in the capability table.

- [ ] **Step 2: Bump the package version**

Change only the package version from `0.1.0` to `0.1.1`; retain compatibility examples and historical first-release references at `^0.1.0` or `0.1.0`.

- [ ] **Step 3: Run the complete release gate**

Run: `bun test`, `bun run typecheck`, `bun run build`, `bun run sync -- --check`, `bun run verify:package`, and `git diff --check`.

Expected: all commands succeed.

### Task 3: Publish and verify 0.1.1

**Files:**
- Commit the files from Tasks 1 and 2.
- Create tag `v0.1.1` and its GitHub Release after registry verification.

**Interfaces:**
- Consumes: a clean, verified release commit and npm authentication.
- Produces: `origin/main`, npm `0.1.1`, tag `v0.1.1`, and a GitHub Release.

- [ ] **Step 1: Commit and push the verified change**

Run `git add` for the scoped files, commit with a Context7 release message, and push `v2` to `origin/main`.

- [ ] **Step 2: Publish npm 0.1.1**

Run `npm publish --access public`; complete npm browser authentication if requested.

- [ ] **Step 3: Verify the registry artifact**

Wait for npm publish-time scanning if necessary, then install `@nail00749/agent-gvozd@0.1.1` in an isolated temporary directory, run `gvozd sync`, and confirm the generated installation with `gvozd sync --check`.

- [ ] **Step 4: Create the tag and GitHub Release**

Create and push annotated tag `v0.1.1`, then create the GitHub Release with concise Context7 access notes.

- [ ] **Step 5: Confirm final state**

Verify the npm version, GitHub Release, remote commit/tag, and clean local worktree.

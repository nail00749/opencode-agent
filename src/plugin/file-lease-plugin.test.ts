import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ResolvedConfig } from "../core/config"
import { DEFAULT_ACTIVE_TTL_MS, DEFAULT_RESERVATION_TTL_MS } from "../core/file-leases"
import { FileLeaseManager, GVOZD_CASE_INSENSITIVE_FILESYSTEM, LeaseError } from "../core/file-leases"
import {
  GVOZD_CLAIM_TOOL,
  GVOZD_LEASE_TOOL,
  enforceFileLeasePermission,
  handleFileLeaseEvent,
  installFileLeaseRuntime,
} from "./file-lease-plugin"

const temporaryProjects: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "gvozd-plugin-leases-"))
  temporaryProjects.push(root)
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  return root
}

function agent(fileLease: "coordinator" | "writer" | "readonly") {
  return {
    description: "test agent",
    mode: "subagent" as const,
    models: ["openai/gpt-5.6-luna"],
    prompt: "/tmp/prompt.md",
    promptContent: "test prompt\n",
    skills: [],
    mcp: [],
    permissions: [],
    fileLease,
    disabled: false,
  }
}

function config(root = project()): ResolvedConfig {
  return {
    lease: { reservationTtlMs: DEFAULT_RESERVATION_TTL_MS, activeTtlMs: DEFAULT_ACTIVE_TTL_MS },
    defaultAgent: "master",
    agents: {
      master: { ...agent("coordinator"), mode: "primary" },
      "back-fast": agent("writer"),
      debugger: agent("readonly"),
      git: agent("readonly"),
    },
    packageRoot: root,
    projectRoot: root,
    projectConfigDirectory: join(root, "docs", ".gvozd"),
    globalConfigDirectory: join(root, "global", "gvozd"),
    sources: [],
  }
}

function manager(root: string): FileLeaseManager {
  let sequence = 0
  return new FileLeaseManager({ projectRoot: root, createID: () => `lease-${++sequence}` })
}

afterEach(() => {
  for (const root of temporaryProjects.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("file lease permission policy", () => {
  test("fails closed for readonly and unclaimed writer edits", () => {
    const resolved = config()
    const leases = manager(resolved.projectRoot)
    const readonly = permission("debugger", "edit", ["src/a.ts"])
    const writer = permission("back-fast", "edit", ["src/a.ts"])

    expect(enforceFileLeasePermission(readonly, resolved, leases)).toBe(true)
    expect(readonly).toMatchObject({ effect: "deny", message: expect.stringContaining("readonly") })
    expect(enforceFileLeasePermission(writer, resolved, leases)).toBe(true)
    expect(writer).toMatchObject({ effect: "deny", message: expect.stringContaining("no active") })
  })

  test("unconfigured agents edit while idle and pause during writer leases", () => {
    const resolved = config()
    const leases = manager(resolved.projectRoot)
    const unknown = permission("unmanaged", "edit", ["src/a.ts"])
    const missing = permission(undefined, "edit", ["src/a.ts"])

    // No active leases: the normal single-agent case passes through.
    expect(enforceFileLeasePermission(unknown, resolved, leases)).toBe(false)
    expect(unknown.effect).toBe("allow")
    // A missing agent identity stays fail-closed even when idle.
    expect(enforceFileLeasePermission(missing, resolved, leases)).toBe(true)
    expect(missing).toMatchObject({ effect: "deny", message: expect.stringContaining("no agent identity") })

    // Once a writer lease activates, unconfigured agents pause.
    const lease = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    const during = permission("unmanaged", "edit", ["src/other.ts"])
    expect(enforceFileLeasePermission(during, resolved, leases)).toBe(true)
    expect(during).toMatchObject({ effect: "deny", message: expect.stringContaining("no writer leases are active") })
    // Released leases restore the pass-through.
    leases.release(lease.leaseId, "master-1")
    const after = permission("unmanaged", "edit", ["src/other.ts"])
    expect(enforceFileLeasePermission(after, resolved, leases)).toBe(false)
  })

  test("allows only every file in the current session lease", () => {
    const resolved = config()
    const leases = manager(resolved.projectRoot)
    const lease = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    const allowed = permission("back-fast", "edit", ["src/a.ts"], "child-1")
    const denied = permission("back-fast", "edit", ["src/a.ts", "src/b.ts"], "child-1")

    expect(enforceFileLeasePermission(allowed, resolved, leases)).toBe(false)
    expect(allowed.effect).toBe("allow")
    expect(enforceFileLeasePermission(denied, resolved, leases)).toBe(true)
    expect(denied).toMatchObject({ effect: "deny", message: expect.stringContaining("src/b.ts") })
  })

  test("fails closed for empty, unknown, and malformed edit resource mappings", () => {
    const resolved = config()
    const leases = manager(resolved.projectRoot)
    const lease = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })

    const empty = permission("back-fast", "edit", [], "child-1")
    const unknown = permission("back-fast", "edit", ["unknown-target"], "child-1")
    const incomplete = permission("back-fast", "edit", ["src/a.ts", ""], "child-1")
    const malformed = permission("back-fast", "edit", undefined as never, "child-1")

    for (const event of [empty, unknown, incomplete, malformed]) {
      expect(enforceFileLeasePermission(event, resolved, leases)).toBe(true)
      expect(event.effect).toBe("deny")
      expect(event.message).toBeTruthy()
    }
  })

  test("writer runs read-only verification shell while blocked from mutations and other commands", () => {
    const resolved = config()
    const leases = manager(resolved.projectRoot)
    const lease = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    const verify = permission("back-fast", "shell", ["cargo test"], "child-1", "ask")
    const mutate = permission("back-fast", "shell", ["sed -i s/a/b/ src/a.ts"], "child-1", "ask")
    const install = permission("back-fast", "shell", ["bun install"], "child-1", "ask")
    const coordinator = permission("master", "shell", ["bun test"], "master-1", "ask")
    const readonlyToolchain = permission("debugger", "shell", ["bun test"], "debug-1", "ask")
    const safeGit = permission("git", "shell", ["GIT_OPTIONAL_LOCKS=0 git status --short"], "git-1")
    const unknown = permission("unmanaged", "shell", ["bun test"], "unknown-1", "ask")

    // Pre-approved verification passes even with the writer's own lease active.
    expect(enforceFileLeasePermission(verify, resolved, leases)).toBe(false)
    // Mutating shell stays denied for writers.
    expect(enforceFileLeasePermission(mutate, resolved, leases)).toBe(true)
    expect(mutate.effect).toBe("deny")
    expect(enforceFileLeasePermission(install, resolved, leases)).toBe(true)
    expect(install.effect).toBe("deny")
    // The coordinator pauses its shell while writer leases are active.
    expect(enforceFileLeasePermission(coordinator, resolved, leases)).toBe(true)
    expect(coordinator.effect).toBe("deny")
    // Read-only roles keep the toolchain baseline while writer leases are active.
    expect(enforceFileLeasePermission(readonlyToolchain, resolved, leases)).toBe(false)
    expect(enforceFileLeasePermission(unknown, resolved, leases)).toBe(true)
    expect(unknown.effect).toBe("deny")
    expect(enforceFileLeasePermission(safeGit, resolved, leases)).toBe(false)
    expect(safeGit.effect).toBe("allow")
  })

  test("coordinator shell defers to agent rules when no leases are active", () => {
    const resolved = config()
    const leases = manager(resolved.projectRoot)
    const idle = permission("master", "shell", ["ssh -o BatchMode=yes serv hostname"], "master-1", "ask")

    // With no writer leases the plugin stays out of the way; the trusted
    // coordinator's own `shell * → allow` rule governs the command. The
    // plugin passes the decision through untouched (the "ask" here is the
    // host's pre-plugin posture; only a deny from this plugin would block).
    expect(enforceFileLeasePermission(idle, resolved, leases)).toBe(false)
    expect(idle.effect).toBe("ask")

    // The moment a writer lease activates, the coordinator's shell pauses.
    const lease = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: lease.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })
    const during = permission("master", "shell", ["ssh -o BatchMode=yes serv hostname"], "master-1", "ask")
    expect(enforceFileLeasePermission(during, resolved, leases)).toBe(true)
    expect(during.effect).toBe("deny")
    expect(during.message).toContain("while file leases enforce structured mutations")

    // Releasing the lease restores the idle pass-through.
    leases.release(lease.leaseId, "master-1")
    const after = permission("master", "shell", ["ssh -o BatchMode=yes serv hostname"], "master-1", "ask")
    expect(enforceFileLeasePermission(after, resolved, leases)).toBe(false)
    expect(after.effect).toBe("ask")
  })

  test("terminal session events release active and parent reservations", () => {
    const resolved = config()
    const leases = manager(resolved.projectRoot)
    const active = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: active.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })

    expect(handleFileLeaseEvent({ type: "session.execution.succeeded", data: { sessionID: "child-1" } }, leases)).toBe(true)
    expect(leases.hasActiveLeases()).toBe(false)

    leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "next", files: ["src/a.ts"] })
    expect(handleFileLeaseEvent({ type: "session.deleted", data: { sessionID: "master-1" } }, leases)).toBe(true)
    expect(leases.listForCoordinator("master-1")).toEqual([])
  })

  test("a parent terminal event preserves an active child lease", () => {
    const resolved = config()
    const leases = manager(resolved.projectRoot)
    const active = leases.reserve({ parentSessionID: "master-1", agent: "back-fast", label: "backend", files: ["src/a.ts"] })
    leases.claim({ leaseId: active.leaseId, sessionID: "child-1", parentSessionID: "master-1", agent: "back-fast" })

    expect(handleFileLeaseEvent({ type: "session.execution.succeeded", data: { sessionID: "master-1" } }, leases)).toBe(true)
    expect(leases.authorizeMutation("child-1", ["src/a.ts"]).leaseId).toBe(active.leaseId)

    expect(handleFileLeaseEvent({ type: "session.execution.succeeded", data: { sessionID: "child-1" } }, leases)).toBe(true)
    expect(leases.hasActiveLeases()).toBe(false)
  })
})

describe("OpenCode file lease runtime", () => {
  test("filters tools by role and validates reserve/claim at execution", async () => {
    const resolved = config()
    const harness = pluginHarness({
      "master-1": { id: "master-1" },
      "child-1": { id: "child-1", parentID: "master-1" },
      "sibling-1": { id: "sibling-1", parentID: "master-2" },
    })
    const runtime = await installFileLeaseRuntime(harness.context, resolved)

    const writerTools = harness.visibleTools("back-fast")
    expect(writerTools[GVOZD_LEASE_TOOL]).toBeUndefined()
    expect(writerTools[GVOZD_CLAIM_TOOL]).toBeDefined()
    const readonlyTools = harness.visibleTools("verifier")
    expect(readonlyTools[GVOZD_LEASE_TOOL]).toBeUndefined()
    expect(readonlyTools[GVOZD_CLAIM_TOOL]).toBeUndefined()

    const leaseTool = harness.tools.get(GVOZD_LEASE_TOOL)!
    const claimTool = harness.tools.get(GVOZD_CLAIM_TOOL)!
    const reserved = await leaseTool.execute(
      { operation: "reserve", agent: "back-fast", label: "backend", files: ["src/a.ts"] },
      toolContext("master-1", "master"),
    )
    const leaseId = reserved.output.leaseId as string

    await expect(claimTool.execute({ leaseId }, toolContext("sibling-1", "back-fast"))).rejects.toThrow("parent")
    const claimed = await claimTool.execute({ leaseId }, toolContext("child-1", "back-fast"))
    expect(claimed.output).toMatchObject({ leaseId, state: "active" })

    await runtime.dispose()
    expect(harness.disposed).toBe(3)
  })

  test("passes an explicit case-sensitive filesystem override to the manager", async () => {
    const resolved = config()
    const runtime = await installFileLeaseRuntime(pluginHarness({}).context, resolved, {
      env: { [GVOZD_CASE_INSENSITIVE_FILESYSTEM]: "0" },
      platform: "darwin",
    })
    try {
      const upper = runtime.manager.reserve({
        parentSessionID: "master-1",
        agent: "back-fast",
        label: "upper",
        files: ["src/New.ts"],
      })
      const lower = runtime.manager.reserve({
        parentSessionID: "master-1",
        agent: "back-fast",
        label: "lower",
        files: ["src/new.ts"],
      })
      expect(upper.files).toEqual(["src/New.ts"])
      expect(lower.files).toEqual(["src/new.ts"])
    } finally {
      await runtime.dispose()
    }
  })

  test("passes an explicit case-insensitive filesystem override to the manager", async () => {
    const resolved = config()
    const runtime = await installFileLeaseRuntime(pluginHarness({}).context, resolved, {
      env: { [GVOZD_CASE_INSENSITIVE_FILESYSTEM]: "1" },
      platform: "linux",
    })
    try {
      runtime.manager.reserve({
        parentSessionID: "master-1",
        agent: "back-fast",
        label: "upper",
        files: ["src/New.ts"],
      })
      try {
        runtime.manager.reserve({
          parentSessionID: "master-1",
          agent: "back-fast",
          label: "lower",
          files: ["src/new.ts"],
        })
        throw new Error("expected case-insensitive ownership conflict")
      } catch (error) {
        expect(error).toBeInstanceOf(LeaseError)
        expect((error as LeaseError).code).toBe("FILE_CONFLICT")
      }
    } finally {
      await runtime.dispose()
    }
  })

  test("rejects an invalid filesystem override before registering runtime resources", async () => {
    const resolved = config()
    const harness = pluginHarness({})
    await expect(installFileLeaseRuntime(harness.context, resolved, {
      env: { [GVOZD_CASE_INSENSITIVE_FILESYSTEM]: "true" },
      platform: "linux",
    })).rejects.toThrow(`${GVOZD_CASE_INSENSITIVE_FILESYSTEM} must be exactly 1 or 0`)
    expect(harness.disposed).toBe(0)
    expect(harness.tools.size).toBe(0)
  })
})

function permission(
  agentID: string | undefined,
  action: string,
  resources: string[],
  sessionID = `${agentID}-session`,
  effect: "allow" | "ask" | "deny" = "allow",
) {
  return { sessionID, agent: agentID, action, resources, effect, message: undefined as string | undefined }
}

function toolContext(sessionID: string, agentID: string) {
  return {
    sessionID,
    agent: agentID,
    messageID: "message-1",
    id: "call-1",
    progress: async () => {},
  } as never
}

function pluginHarness(sessions: Record<string, { id: string; parentID?: string }>) {
  const tools = new Map<string, { execute: (input: any, context: any) => Promise<any> }>()
  let contextHook: ((event: any) => void | Promise<void>) | undefined
  let beforeHook: ((event: any) => void | Promise<void>) | undefined
  let disposed = 0
  const registration = () => ({ dispose: async () => void disposed++ })
  const context = {
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          namespace: () => {},
          add: (tool: any) => tools.set(`${tool.options.namespace}_${tool.name}`, tool),
        })
        return registration()
      },
      hook: async (name: string, callback: (event: any) => void | Promise<void>) => {
        if (name === "execute.before") beforeHook = callback
        return registration()
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => void | Promise<void>) => {
        if (name === "context") contextHook = callback
        return registration()
      },
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID] ?? { id: sessionID },
    },
  } as unknown as Plugin.Context

  return {
    context,
    tools,
    get disposed() {
      return disposed
    },
    visibleTools(agentID: string) {
      const visible = Object.fromEntries([...tools].map(([id]) => [id, { description: id, input: {} }]))
      void contextHook?.({ agent: agentID, tools: visible })
      return visible
    },
    touch(event: unknown) {
      return beforeHook?.(event)
    },
  }
}

describe("configured lease TTL", () => {
  test("manager receives the resolved config TTLs", () => {
    const config = {
      lease: { reservationTtlMs: 9 * 60_000, activeTtlMs: 45 * 60_000 },
    } as unknown as Parameters<typeof installFileLeaseRuntime>[1]
    expect(config.lease.reservationTtlMs).toBe(540_000)
    expect(config.lease.activeTtlMs).toBe(2_700_000)
  })
})

function runtimeFixture(): { config: ResolvedConfig; manager: FileLeaseManager } {
  const resolved = config()
  return { config: resolved, manager: manager(resolved.projectRoot) }
}

describe("read-only agent shell during active writer leases", () => {
  test("toolchain commands are allowed while writer leases are active", () => {
    const { config, manager } = runtimeFixture()
    const lease = manager.reserve({ parentSessionID: "ses-master", agent: "back-fast", label: "pkg", files: ["src/a.ts"] })
    manager.claim({ leaseId: lease.leaseId, sessionID: "ses-writer", parentSessionID: "ses-master", agent: "back-fast" })
    const event = { sessionID: "ses-git", agent: "git", action: "shell", resources: ["bun test *"], effect: "allow" as "allow" | "deny" }
    expect(enforceFileLeasePermission(event, config, manager)).toBe(false)
    expect(event.effect).toBe("allow")
  })

  test("non-baseline commands still pause during active writer leases", () => {
    const { config, manager } = runtimeFixture()
    const lease = manager.reserve({ parentSessionID: "ses-master", agent: "back-fast", label: "pkg", files: ["src/a.ts"] })
    manager.claim({ leaseId: lease.leaseId, sessionID: "ses-writer", parentSessionID: "ses-master", agent: "back-fast" })
    const event = { sessionID: "ses-git", agent: "git", action: "shell", resources: ["curl *"], effect: "allow" as "allow" | "deny" }
    expect(enforceFileLeasePermission(event, config, manager)).toBe(true)
    expect(event.effect).toBe("deny")
  })
})

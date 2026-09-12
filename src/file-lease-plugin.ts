import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import type { ResolvedConfig } from "./config"
import { FileLeaseManager, resolveCaseInsensitiveFilesystem, type FileLeaseRole } from "./file-leases"
import {
  GIT_ENV_PREFIXES,
  GIT_READONLY_COMMANDS,
  INSPECTION_COMMANDS,
  TOOLCHAIN_COMMANDS,
} from "./tool-permissions"

export const GVOZD_LEASE_TOOL = "gvozd_lease"
export const GVOZD_CLAIM_TOOL = "gvozd_claim"

const TERMINAL_SESSION_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.deleted",
])

// Resources (exact command strings) that read-only roles may execute while
// writer leases are active. Derived from the shared toolchain families so
// verification work is not blocked by unrelated writers.
const SAFE_SHELL_DURING_ACTIVE_LEASES: ReadonlySet<string> = new Set(
  [...INSPECTION_COMMANDS, ...TOOLCHAIN_COMMANDS, ...GIT_READONLY_COMMANDS].flatMap(({ exact, wildcard }) => [
    exact,
    wildcard,
    ...GIT_ENV_PREFIXES.map((prefix) => `${prefix} ${exact}`),
    ...GIT_ENV_PREFIXES.map((prefix) => `${prefix} ${wildcard}`),
  ]),
)

const leaseInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("reserve"),
    agent: z.string().min(1).describe("Agent ID that will claim the lease"),
    label: z.string().min(1).describe("Short work-package label shown in conflict errors"),
    files: z.array(z.string().min(1)).min(1).describe("Exact project-relative files, including planned new files"),
  }),
  z.object({
    operation: z.literal("extend"),
    leaseId: z.string().min(1),
    files: z.array(z.string().min(1)).min(1).describe("Additional exact project-relative files"),
  }),
  z.object({ operation: z.literal("release"), leaseId: z.string().min(1) }),
  z.object({ operation: z.literal("status") }),
])

const claimInputSchema = z.object({
  leaseId: z.string().min(1).describe("Lease ID supplied by the parent coordinator"),
})

const leaseStatusSchema = z.object({
  leaseId: z.string(),
  parentSessionID: z.string(),
  sessionID: z.string().optional(),
  agent: z.string(),
  label: z.string(),
  state: z.enum(["reserved", "active"]),
  files: z.array(z.string()),
  createdAt: z.number(),
  claimedAt: z.number().optional(),
  lastActivityAt: z.number(),
  expiresAt: z.number(),
})

const leaseOutputSchema = z.union([
  leaseStatusSchema,
  z.object({ released: z.string() }),
  z.object({ leases: z.array(leaseStatusSchema) }),
])

export interface FileLeasePermissionEvent {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  effect: "allow" | "ask" | "deny"
  message?: string
}

export interface FileLeaseRuntime {
  readonly manager: FileLeaseManager
  enforcePermission(event: FileLeasePermissionEvent): boolean
  handleEvent(event: unknown): boolean
  dispose(): Promise<void>
}

function roleOf(config: ResolvedConfig, agentID: string | undefined): FileLeaseRole | undefined {
  if (!agentID) return undefined
  const agent = config.agents[agentID]
  if (!agent || agent.disabled) return undefined
  return agent.fileLease
}

function deny(event: FileLeasePermissionEvent, message: string): true {
  event.effect = "deny"
  event.message = message
  return true
}

/**
 * Read-only roles (git, verifier, explorer, debugger, security) keep running
 * inspection and toolchain verification commands while writer leases are
 * active; anything outside the safe set pauses until the leases are released.
 */
function safeReadonlyShell(agent: string | undefined, resources: readonly string[]): boolean {
  return agent !== undefined && resources.length > 0 && resources.every((resource) => SAFE_SHELL_DURING_ACTIVE_LEASES.has(resource))
}

export function enforceFileLeasePermission(
  event: FileLeasePermissionEvent,
  config: ResolvedConfig,
  manager: FileLeaseManager,
): boolean {
  const role = roleOf(config, event.agent)

  if (event.action === "edit") {
    if (!role) {
      return deny(
        event,
        event.agent
          ? `Agent ${event.agent} has no configured file lease role`
          : "OpenCode supplied no agent identity for this mutation; the write is denied",
      )
    }
    if (role === "readonly") return deny(event, `Agent ${event.agent} is readonly and cannot mutate project files`)
    try {
      manager.authorizeMutation(event.sessionID, event.resources)
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : "File lease authorization failed"
      return deny(event, message)
    }
  }

  if (event.action !== "shell" && event.action !== "bash") return false
  if (role === "coordinator" || role === "writer") {
    return deny(event, `Agent ${event.agent} cannot use shell while file leases enforce structured mutations`)
  }
  if (manager.hasActiveLeases() && !(role === "readonly" && safeReadonlyShell(event.agent, event.resources))) {
    return deny(event, "Shell commands are paused until all active writer file leases are released")
  }
  return false
}

export function handleFileLeaseEvent(event: unknown, manager: FileLeaseManager): boolean {
  if (!event || typeof event !== "object") return false
  const candidate = event as { type?: unknown; data?: { sessionID?: unknown } }
  if (typeof candidate.type !== "string" || !TERMINAL_SESSION_EVENTS.has(candidate.type)) return false
  const sessionID = candidate.data?.sessionID
  if (typeof sessionID !== "string" || sessionID === "") return false
  manager.releaseSession(sessionID)
  return true
}

function requireRole(config: ResolvedConfig, agentID: string, allowed: readonly FileLeaseRole[]): FileLeaseRole {
  const role = roleOf(config, agentID)
  if (!role || !allowed.includes(role)) {
    throw new Error(`Agent ${agentID} is not allowed to use this file lease tool`)
  }
  return role
}

export interface FileLeaseRuntimeOptions {
  caseInsensitive?: boolean
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}

export async function installFileLeaseRuntime(
  ctx: Plugin.Context,
  config: ResolvedConfig,
  options: FileLeaseRuntimeOptions = {},
): Promise<FileLeaseRuntime> {
  const caseInsensitive = options.caseInsensitive
    ?? resolveCaseInsensitiveFilesystem(options.env ?? process.env, options.platform ?? process.platform)
  const manager = new FileLeaseManager({
    projectRoot: config.projectRoot,
    caseInsensitive,
    reservationTtlMs: config.lease.reservationTtlMs,
    activeTtlMs: config.lease.activeTtlMs,
  })

  const toolTransform = await ctx.tool.transform((tools) => {
    tools.namespace({
      name: "gvozd",
      description: "Coordinate exact project file ownership between parallel Gvozd writer sessions.",
    })
    tools.add({
      name: "lease",
      description:
        "Reserve, extend, inspect, or release exact project files before delegating writer work. Explorer should identify the files first.",
      input: leaseInputSchema,
      output: leaseOutputSchema,
      options: { namespace: "gvozd" },
      execute: async (input, context) => {
        const agentID = String(context.agent)
        requireRole(config, agentID, ["coordinator"])
        const parentSessionID = String(context.sessionID)
        if (input.operation === "reserve") {
          const assignee = config.agents[input.agent]
          if (!assignee || assignee.disabled || (assignee.fileLease !== "writer" && assignee.fileLease !== "coordinator")) {
            throw new Error(`Agent ${input.agent} is not an enabled file-lease writer or coordinator`)
          }
          return {
            output: manager.reserve({
              parentSessionID,
              agent: input.agent,
              label: input.label,
              files: input.files,
            }),
          }
        }
        if (input.operation === "extend") {
          return { output: manager.extend({ leaseId: input.leaseId, parentSessionID, files: input.files }) }
        }
        if (input.operation === "release") {
          manager.release(input.leaseId, parentSessionID)
          return { output: { released: input.leaseId } }
        }
        return { output: { leases: manager.listForCoordinator(parentSessionID) } }
      },
    })
    tools.add({
      name: "claim",
      description:
        "Claim the exact file lease ID supplied by Master before making any structured project file mutation.",
      input: claimInputSchema,
      output: leaseStatusSchema,
      options: { namespace: "gvozd" },
      execute: async (input, context) => {
        const agentID = String(context.agent)
        requireRole(config, agentID, ["coordinator", "writer"])
        const sessionID = String(context.sessionID)
        const session = await ctx.session.get({ sessionID: context.sessionID })
        return {
          output: manager.claim({
            leaseId: input.leaseId,
            sessionID,
            parentSessionID: session.parentID ? String(session.parentID) : undefined,
            agent: agentID,
          }),
        }
      },
    })
  })

  const sessionContext = await ctx.session.hook("context", (event) => {
    const role = roleOf(config, String(event.agent))
    if (role !== "coordinator") delete event.tools[GVOZD_LEASE_TOOL]
    if (role !== "coordinator" && role !== "writer") delete event.tools[GVOZD_CLAIM_TOOL]
  })

  const toolBefore = await ctx.tool.hook("execute.before", (event) => {
    manager.touchSession(String(event.sessionID))
  })

  const sweepInterval = setInterval(() => manager.sweep(), 60_000)
  sweepInterval.unref?.()
  let disposed = false

  return {
    manager,
    enforcePermission: (event) => enforceFileLeasePermission(event, config, manager),
    handleEvent: (event) => handleFileLeaseEvent(event, manager),
    async dispose() {
      if (disposed) return
      disposed = true
      clearInterval(sweepInterval)
      manager.clear()
      await Promise.all([toolBefore.dispose(), sessionContext.dispose(), toolTransform.dispose()])
    },
  }
}

import { createResource, createSignal, onCleanup, onMount, type InitializedResource } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { GvozdAccessExplanation, GvozdLeases, GvozdPermissions } from "../rpc/permissions-rpc"
import { GvozdMode } from "../rpc/trusted-mode"
import type { TrustMode } from "../rpc/trusted-mode"
import type { AccessExplanationInput, AccessExplanationOutput, EvaluateInput, EvaluateOutput, LeaseListOutput } from "../rpc/permissions-rpc"
import type { SessionPermissionOverrides } from "../core/session-permissions"
import { retryRpc } from "./rpc-client"
import {
  collectPermissionUsages,
  collectSkillUsages,
  type SessionPermissionUsage,
  type SessionSkillUsage,
} from "./session-insights"
import {
  collectSessionTree,
  collectToolStats,
  type SessionToolStats,
  type SessionTreeNode,
} from "./session-tools"
import type { PermissionReply, PermissionRequest, SessionInfo, SessionMessageInfo } from "@opencode/client"

/** Answered permission requests accumulated while this TUI observes the session. */
export interface ReplyRecord {
  id: string
  action?: string
  resources?: readonly string[]
  reply: PermissionReply
  time: number
}

/** Durable shape stored across TUI restarts: requestID -> reply record. */
export interface StoredReplyLog {
  readonly replies: Record<string, ReplyRecord>
}

/**
 * Distinguishes a confirmed empty collection from a fetch that has not
 * succeeded. Callers must not render unavailable as zero.
 */
export type InsightAvailability = "loading" | "ready" | "unavailable" | "stale" | "empty"

/** Resolved insights for one session: tree, skills, permissions, tool usage. */
export interface SessionInsights {
  readonly tree: SessionTreeNode[]
  readonly skills: SessionSkillUsage[]
  readonly permissions: SessionPermissionUsage[]
  readonly tools: SessionToolStats
  readonly messageAvailability: InsightAvailability
  readonly permissionAvailability: InsightAvailability
  readonly sessionAvailability: InsightAvailability
}

const EMPTY_TOOLS: SessionToolStats = { counts: new Map(), totalCalls: 0, errors: 0, recentErrors: [] }

export const EMPTY_INSIGHTS: SessionInsights = {
  tree: [],
  skills: [],
  permissions: [],
  tools: EMPTY_TOOLS,
  messageAvailability: "loading",
  permissionAvailability: "loading",
  sessionAvailability: "loading",
}

export interface InsightSources {
  readonly sessionID: string
  readonly messagesResult: "fulfilled" | "rejected"
  readonly permissionResult: "fulfilled" | "rejected"
  readonly messages: readonly SessionMessageInfo[] | undefined
  readonly pending: readonly PermissionRequest[] | undefined
  readonly family: readonly SessionInfo[] | undefined
  readonly rootPresent: boolean
  readonly status: (sessionID: string) => "idle" | "running"
  readonly replies: readonly ReplyRecord[]
  readonly previous?: SessionInsights
}

function collectionAvailability(
  result: "fulfilled" | "rejected",
  list: readonly unknown[] | undefined,
  previous: InsightAvailability | undefined,
): InsightAvailability {
  if (result === "fulfilled" && list !== undefined) return "ready"
  // An empty list after a rejected sync is an unfilled cache, not proof of none.
  const cached = list !== undefined && list.length > 0
  if (cached || previous === "ready" || previous === "stale") return "stale"
  return "unavailable"
}

/**
 * Builds a sidebar snapshot without turning a failed sync into a confirmed
 * empty session. Cached lists survive a rejected refresh as stale data.
 */
export function resolveInsightSnapshot(input: InsightSources): SessionInsights {
  const previous = input.previous
  const messageAvailability = collectionAvailability(input.messagesResult, input.messages, previous?.messageAvailability)
  const permissionAvailability = collectionAvailability(input.permissionResult, input.pending, previous?.permissionAvailability)
  const sessionAvailability = input.rootPresent
    ? "ready"
    : previous?.sessionAvailability === "ready" || previous?.sessionAvailability === "stale"
      ? "stale"
      : "unavailable"
  const skills = messageAvailability === "ready"
    ? collectSkillUsages(input.messages)
    : messageAvailability === "stale"
      ? input.messages && input.messages.length > 0 ? collectSkillUsages(input.messages) : previous?.skills ?? []
      : []
  const tools = messageAvailability === "ready"
    ? collectToolStats(input.messages)
    : messageAvailability === "stale"
      ? input.messages && input.messages.length > 0 ? collectToolStats(input.messages) : previous?.tools ?? EMPTY_TOOLS
      : EMPTY_TOOLS
  const permissions = permissionAvailability === "ready"
    ? collectPermissionUsages(input.pending, input.replies)
    : permissionAvailability === "stale"
      ? input.pending && input.pending.length > 0 ? collectPermissionUsages(input.pending, input.replies) : previous?.permissions ?? []
      : []
  const tree = sessionAvailability === "ready"
    ? collectSessionTree(input.sessionID, input.family, input.status)
    : sessionAvailability === "stale"
      ? previous?.tree ?? []
      : []
  return {
    tree,
    skills,
    permissions,
    tools,
    messageAvailability,
    permissionAvailability,
    sessionAvailability,
  }
}

/** Reads a theme color defensively; theme shapes vary across host versions. */
export function themeColor(theme: unknown, path: readonly string[], fallback = "#808080"): string | undefined {
  let current: unknown = theme
  for (const key of path) {
    if (typeof current !== "object" || current === null) return fallback
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === "string" ? current : fallback
}

const CYAN_PATHS = [
  ["text", "cyan"],
  ["ansi", "cyan"],
  ["syntax", "cyan"],
  ["primary"],
  ["accent"],
] as const

/** Heading color that follows a host cyan/accent token and otherwise stays cyan. */
export function headingColor(theme: unknown): string {
  for (const path of CYAN_PATHS) {
    const color = themeColor(theme, path, "")
    if (color) return color
  }
  return "#22d3ee"
}

export function relativeTime(timestamp: number, now: number): string {
  if (!timestamp) return ""
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Loads the message list once per session and keeps a live reply log from
 * permission events. Skill updates re-sync on `session.skill.activated`;
 * permission updates on asked/replied events.
 */
export function useSessionInsights(sessionID: () => string | undefined): InitializedResource<SessionInsights> {
  const context = usePlugin()
  // Replies persist across TUI restarts so the permissions section keeps its
  // history instead of restarting empty after every launch.
  const [log, updateLog] = context.storage.store<StoredReplyLog>("gvozd.tui.permission-replies", {
    initial: { replies: {} },
  })
  const replies = () => Object.values(log.replies)
  const recordReply = (record: ReplyRecord) => {
    void updateReply(record)
  }
  const updateReply = async (record: ReplyRecord) => {
    await updateLog((draft) => {
      draft.replies[record.id] = record
    })
  }
  const [version, setVersion] = createSignal(0)
  let previousID: string | undefined
  let previous: SessionInsights | undefined

  onMount(() => {
    const stops = [
      context.data.on("session.skill.activated", (event) => {
        if (event.data?.sessionID !== sessionID()) return
        context.data.session.message.invalidate(event.data.sessionID)
        setVersion((value) => value + 1)
      }),
      context.data.on("permission.asked", (event) => {
        if (event.data?.sessionID !== sessionID()) return
        context.data.session.permission.sync(event.data.sessionID)
        setVersion((value) => value + 1)
      }),
      context.data.on("permission.replied", (event) => {
        if (event.data?.sessionID !== sessionID()) return
        const data = event.data
        recordReply({
          id: data.requestID,
          reply: data.reply,
          time: event.created ?? Date.now(),
        })
        context.data.session.permission.invalidate(data.sessionID)
        setVersion((value) => value + 1)
      }),
      context.data.on("session.execution.succeeded", (event) => {
        if (event.data?.sessionID !== sessionID()) return
        context.data.session.message.invalidate(event.data.sessionID)
        setVersion((value) => value + 1)
      }),
    ]
    onCleanup(() => {
      for (const stop of stops) stop()
    })
  })

  const [resource] = createResource(
    () => {
      const id = sessionID()
      // version participates in the fetched key so permission/skill events
      // refetch: the source must return a NEW value per revision, otherwise
      // Solid keeps the previous fetch.
      return { id, revision: version() }
    },
    async (key) => {
      const id = key.id
      if (!id) {
        const empty: SessionInsights = {
          ...EMPTY_INSIGHTS,
          messageAvailability: "empty",
          permissionAvailability: "empty",
          sessionAvailability: "empty",
        }
        return empty
      }
      if (id !== previousID) {
        previous = undefined
        previousID = id
      }
      const [messages, pending] = await Promise.allSettled([
        context.data.session.message.sync(id),
        context.data.session.permission.sync(id),
      ])
      if (messages.status === "rejected") {
        console.error("gvozd tui: message sync failed", messages.reason)
      }
      if (pending.status === "rejected") {
        console.error("gvozd tui: permission sync failed", pending.reason)
      }
      const sessionList = context.data.session.message.list(id) as SessionMessageInfo[] | undefined
      const pendingList = context.data.session.permission.list(id)
      // family() returns session IDs; resolve each to its SessionInfo record.
      const family = (memberSessionID: string): SessionInfo[] => {
        const members = [memberSessionID, ...context.data.session.family(memberSessionID).filter((member) => member !== memberSessionID)]
        const resolved: SessionInfo[] = []
        for (const member of members) {
          const info = context.data.session.get(member)
          if (info) resolved.push(info)
        }
        return resolved
      }
      const snapshot = resolveInsightSnapshot({
        sessionID: id,
        messagesResult: messages.status,
        permissionResult: pending.status,
        messages: sessionList,
        pending: pendingList,
        family: family(id),
        rootPresent: context.data.session.get(id) !== undefined,
        status: (memberID) => context.data.session.status(memberID) ?? "idle",
        replies: replies(),
        previous,
      })
      if (
        snapshot.messageAvailability !== "unavailable"
        || snapshot.permissionAvailability !== "unavailable"
        || snapshot.sessionAvailability !== "unavailable"
      ) previous = snapshot
      return snapshot
    },
    { initialValue: EMPTY_INSIGHTS },
  )
  return resource
}

/** Sets the session permission posture through the gvozd-mode RPC. */
export async function setTrustMode(
  context: Context,
  sessionID: string,
  mode: "balanced" | "trusted" | "strict",
): Promise<{ mode: string } | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        set: (input: { sessionID: string; mode: string }, options?: { signal?: AbortSignal }) => Promise<{ mode: string }>
      }
    }).rpc(GvozdMode)
    return await retryRpc((signal) => rpc.set({ sessionID, mode }, { signal }), { attempts: 1 })
  } catch (error) {
    console.error("gvozd tui: mode switch failed", error)
    return undefined
  }
}

/** Persists the per-category session permission toggles through gvozd-mode. */
export async function setSessionOverrides(
  context: Context,
  sessionID: string,
  overrides: SessionPermissionOverrides,
): Promise<SessionPermissionOverrides | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        setOverrides: (
          input: { sessionID: string; overrides: SessionPermissionOverrides },
          options?: { signal?: AbortSignal },
        ) => Promise<{ overrides: SessionPermissionOverrides }>
      }
    }).rpc(GvozdMode)
    return (await retryRpc((signal) => rpc.setOverrides({ sessionID, overrides }, { signal }), { attempts: 1 }))?.overrides
  } catch (error) {
    console.error("gvozd tui: session override update failed", error)
    return undefined
  }
}

/** Reads the current posture and toggles for a session through gvozd-mode. */
export async function getSessionState(
  context: Context,
  sessionID: string,
): Promise<{ mode: TrustMode; overrides: SessionPermissionOverrides } | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        get: (input: { sessionID: string }, options?: { signal?: AbortSignal }) => Promise<{ mode: TrustMode; overrides?: SessionPermissionOverrides }>
      }
    }).rpc(GvozdMode)
    const result = await retryRpc((signal) => rpc.get({ sessionID }, { signal }))
    if (!result) return undefined
    return { mode: result.mode, overrides: result.overrides ?? {} }
  } catch (error) {
    console.error("gvozd tui: session state read failed", error)
    return undefined
  }
}

/** Fetches the lease snapshot through the server-side gvozd-leases RPC. */
export async function listLeases(context: Context): Promise<LeaseListOutput | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => { list: (input: Record<string, never>, options?: { signal?: AbortSignal }) => Promise<LeaseListOutput> }
    }).rpc(GvozdLeases)
    return await retryRpc((signal) => rpc.list({}, { signal }))
  } catch (error) {
    console.error("gvozd tui: lease list failed", error)
    return undefined
  }
}

/**
 * Reads one access explanation. A failed call stays undefined so the sidebar
 * cannot present it as an empty or allowing decision.
 */
export async function explainAccess(
  context: Context,
  input: AccessExplanationInput,
): Promise<AccessExplanationOutput | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        explain: (input: AccessExplanationInput, options?: { signal?: AbortSignal }) => Promise<AccessExplanationOutput>
      }
    }).rpc(GvozdAccessExplanation)
    return await retryRpc((signal) => rpc.explain(input, { signal }))
  } catch (error) {
    console.error("gvozd tui: access explanation failed", error)
    return undefined
  }
}

/** Dry-run permission effects through the server-side gvozd-permissions RPC. */
export async function evaluatePermissions(
  context: Context,
  agent: string,
  checks: { action: string; resources: readonly string[] }[],
): Promise<EvaluateOutput | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        evaluate: (input: EvaluateInput, options?: { signal?: AbortSignal }) => Promise<EvaluateOutput>
      }
    }).rpc(GvozdPermissions)
    const input: EvaluateInput = { agent, checks }
    return await retryRpc((signal) => rpc.evaluate(input, { signal }), { attempts: 1 })
  } catch (error) {
    console.error("gvozd tui: permission dry-run failed", error)
    return undefined
  }
}

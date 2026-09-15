import { createResource, createSignal, onCleanup, onMount, type InitializedResource } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { GvozdLeases, GvozdPermissions } from "../rpc/permissions-rpc"
import { GvozdMode } from "../rpc/trusted-mode"
import type { EvaluateInput, EvaluateOutput, LeaseListOutput } from "../rpc/permissions-rpc"
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
import type { PermissionReply, SessionInfo, SessionMessageInfo } from "@opencode/client"

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

/** Resolved insights for one session: tree, skills, permissions, tool usage. */
export interface SessionInsights {
  readonly tree: SessionTreeNode[]
  readonly skills: SessionSkillUsage[]
  readonly permissions: SessionPermissionUsage[]
  readonly tools: SessionToolStats
}

export const EMPTY_INSIGHTS: SessionInsights = {
  tree: [],
  skills: [],
  permissions: [],
  tools: { counts: new Map(), totalCalls: 0, errors: 0, recentErrors: [] },
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
      if (!id) return EMPTY_INSIGHTS
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
      // family() returns session IDs; resolve each to its SessionInfo record.
      const family = (sessionID: string): SessionInfo[] => {
        const members = [sessionID, ...context.data.session.family(sessionID).filter((member) => member !== sessionID)]
        const resolved: SessionInfo[] = []
        for (const member of members) {
          const info = context.data.session.get(member)
          if (info) resolved.push(info)
        }
        return resolved
      }
      return {
        tree: collectSessionTree(id, family(id), (memberID) => context.data.session.status(memberID) ?? "idle"),
        skills: collectSkillUsages(sessionList),
        permissions: collectPermissionUsages(context.data.session.permission.list(id), replies()),
        tools: collectToolStats(sessionList),
      }
    },
    { initialValue: EMPTY_INSIGHTS },
  )
  return resource
}

/** Sets the session permission posture through the gvozd-mode RPC. */
export async function setTrustMode(
  sessionID: string,
  mode: "balanced" | "trusted" | "strict",
): Promise<{ mode: string } | undefined> {
  const context = usePlugin()
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => { set: (input: { sessionID: string; mode: string }) => Promise<{ mode: string }> }
    }).rpc(GvozdMode)
    return await rpc.set({ sessionID, mode })
  } catch (error) {
    console.error("gvozd tui: mode switch failed", error)
    return undefined
  }
}

/** Fetches the lease snapshot through the server-side gvozd-leases RPC. */
export async function listLeases(): Promise<LeaseListOutput | undefined> {
  const context = usePlugin()
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => { list: () => Promise<LeaseListOutput> }
    }).rpc(GvozdLeases)
    return await rpc.list()
  } catch (error) {
    console.error("gvozd tui: lease list failed", error)
    return undefined
  }
}

/** Dry-run permission effects through the server-side gvozd-permissions RPC. */
export async function evaluatePermissions(
  agent: string,
  checks: { action: string; resources: readonly string[] }[],
): Promise<EvaluateOutput | undefined> {
  const context = usePlugin()
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => { evaluate: (input: EvaluateInput) => Promise<EvaluateOutput> }
    }).rpc(GvozdPermissions)
    const input: EvaluateInput = { agent, checks }
    return await rpc.evaluate(input)
  } catch (error) {
    console.error("gvozd tui: permission dry-run failed", error)
    return undefined
  }
}

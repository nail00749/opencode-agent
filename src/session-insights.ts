import type { PermissionReply, PermissionRequest, SessionMessageInfo } from "@opencode/client"

/**
 * Session-skill activation record distilled from `skill` messages.
 */
export interface SessionSkillUsage {
  /** Skill name as activated (matches SkillInfo.name). */
  readonly name: string
  /** Millisecond timestamp of the most recent activation. */
  readonly lastUsedAt: number
  /** Total activations in the session. */
  readonly activations: number
}

/**
 * Collect skill usage from a session message list. Skill messages carry
 * `{skill, name, text}`; a skill may activate several times, so entries are
 * deduplicated by activation name with the latest timestamp kept.
 */
export function collectSkillUsages(
  messages: readonly SessionMessageInfo[] | undefined,
): SessionSkillUsage[] {
  if (!messages || messages.length === 0) return []
  const byName = new Map<string, { name: string; lastUsedAt: number; activations: number }>()
  for (const message of messages) {
    if (message.type !== "skill") continue
    const name = message.name || message.skill
    if (!name) continue
    const time = message.time?.created ?? 0
    const existing = byName.get(name)
    if (existing) {
      existing.activations += 1
      existing.lastUsedAt = Math.max(existing.lastUsedAt, time)
    } else {
      byName.set(name, { name, lastUsedAt: time, activations: 1 })
    }
  }
  return [...byName.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** One recorded permission outcome or a still-pending request. */
export interface SessionPermissionUsage {
  readonly id: string
  readonly action: string
  /** First resource, or the raw id when the request had no resources. */
  readonly resource: string
  /** Number of additional resources beyond the first. */
  readonly extraResources: number
  /** Pending request that has not been answered yet. */
  readonly pending: boolean
  /** Answer recorded by the TUI while it observed the request. */
  readonly reply?: PermissionReply
  /** Millisecond timestamp of the reply, when known. */
  readonly repliedAt?: number
}

/**
 * Merge currently pending requests with replies the TUI observed. Pending
 * requests render first; answered entries follow newest-first. Deduplicated
 * by request id — a pending request whose reply arrived later keeps only the
 * answered record.
 */
export function collectPermissionUsages(
  pending: readonly PermissionRequest[] | undefined,
  replies: readonly {
    id: string
    action?: string
    resources?: readonly string[]
    reply: PermissionReply
    time: number
  }[],
): SessionPermissionUsage[] {
  const byID = new Map<string, SessionPermissionUsage>()
  for (const request of pending ?? []) {
    if (!request || typeof request.id !== "string" || request.id === "") continue
    const resources = request.resources ?? []
    byID.set(request.id, {
      id: request.id,
      action: request.action ?? "",
      resource: resources[0] ?? "(no resource)",
      extraResources: Math.max(0, resources.length - 1),
      pending: true,
    })
  }
  for (const reply of replies) {
    const answered: SessionPermissionUsage = {
      id: reply.id,
      action: reply.action ?? "",
      resource: reply.resources?.[0] ?? "(no resource)",
      extraResources: Math.max(0, (reply.resources?.length ?? 1) - 1),
      pending: false,
      reply: reply.reply,
      repliedAt: reply.time,
    }
    byID.set(reply.id, answered)
  }
  const entries = [...byID.values()]
  return entries.sort((a, b) => {
    if (a.pending !== b.pending) return a.pending ? -1 : 1
    return (b.repliedAt ?? 0) - (a.repliedAt ?? 0)
  })
}

/** Reply outcome ordering used for stable grouping in the UI. */
export function replyRank(reply: PermissionReply | undefined): number {
  if (reply === "always") return 0
  if (reply === "reject") return 1
  return 2
}

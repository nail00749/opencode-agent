import type { SessionInfo, SessionMessageInfo } from "@opencode/client"

/** One row of the subagent tree: the session itself or one of its descendants. */
export interface SessionTreeNode {
  readonly sessionID: string
  readonly agent?: string
  readonly model?: string
  readonly title?: string
  readonly status: "idle" | "running"
  /** Absent when the host did not report a cost. Never coerced to zero. */
  readonly cost?: number
  /** Absent when any input/output/reasoning total is missing. */
  readonly tokens?: number
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  readonly isRoot: boolean
}

/**
 * Build the subagent tree for a session from the SDK's family list. The root
 * session comes first; descendants keep their server order (creation order).
 */
export function collectSessionTree(
  rootSessionID: string,
  family: readonly SessionInfo[] | undefined,
  status: (sessionID: string) => "idle" | "running",
): SessionTreeNode[] {
  if (!family || family.length === 0) return []
  const nodes: SessionTreeNode[] = []
  for (const session of family) {
    if (!session || typeof session.id !== "string") continue
    nodes.push({
      sessionID: session.id,
      agent: session.agent,
      model: session.model ? `${session.model.providerID}/${session.model.id}` : undefined,
      title: session.title,
      status: status(session.id) ?? "idle",
      // Missing host fields stay unknown. A zero default would report a session
      // that has not reported usage as a confirmed free session.
      cost: typeof session.cost === "number" ? session.cost : undefined,
      tokens: knownTokenTotal(session.tokens),
      outcome: session.outcome,
      isRoot: session.id === rootSessionID,
    })
  }
  // Root first, then descendants in their natural (creation) order.
  nodes.sort((a, b) => (a.isRoot === b.isRoot ? 0 : a.isRoot ? -1 : 1))
  return nodes
}

/** Aggregated tool usage for one session. */
export interface SessionToolStats {
  /** tool name -> call count */
  readonly counts: ReadonlyMap<string, number>
  readonly totalCalls: number
  readonly errors: number
  /** Most recent errors, newest first (bounded). */
  readonly recentErrors: readonly {
    readonly tool: string
    readonly message: string
    readonly permission: boolean
    readonly time: number
  }[]
}

const RECENT_ERROR_LIMIT = 5

/**
 * Sums a complete token report. A missing component is unknown, not zero:
 * a partial sum would hide unreported usage.
 */
export function knownTokenTotal(tokens: { input?: number; output?: number; reasoning?: number } | null | undefined): number | undefined {
  if (!tokens) return undefined
  const parts = [tokens.input, tokens.output, tokens.reasoning]
  let sum = 0
  for (const part of parts) {
    if (typeof part !== "number") return undefined
    sum += part
  }
  return sum
}

/** Sums session cost only when every node reported one. */
export function knownSessionCost(tree: readonly SessionTreeNode[]): number | undefined {
  let sum = 0
  for (const node of tree) {
    if (typeof node.cost !== "number") return undefined
    sum += node.cost
  }
  return sum
}

/**
 * Distill tool statistics from assistant message tool calls. Tool error text
 * is retained for display but is not an access decision: permission
 * attribution comes only from AccessExplanation evidence.
 */
export function collectToolStats(
  messages: readonly SessionMessageInfo[] | undefined,
): SessionToolStats {
  const counts = new Map<string, number>()
  let errors = 0
  const recentErrors: { tool: string; message: string; permission: boolean; time: number }[] = []
  if (!messages) {
    return { counts, totalCalls: 0, errors: 0, recentErrors }
  }
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue
      counts.set(part.name, (counts.get(part.name) ?? 0) + 1)
      if (part.state?.status !== "error") continue
      errors += 1
      const raw = part.state.error
      const message_ = typeof raw === "string" ? raw : (raw as { message?: string } | undefined)?.message ?? ""
      recentErrors.push({
        tool: part.name,
        message: message_.replace(/\s+/g, " ").slice(0, 160),
        // Regex over error text is not authoritative attribution.
        permission: false,
        time: message.time?.created ?? 0,
      })
    }
  }
  recentErrors.sort((a, b) => b.time - a.time)
  return {
    counts,
    totalCalls: [...counts.values()].reduce((sum, count) => sum + count, 0),
    errors,
    recentErrors: recentErrors.slice(0, RECENT_ERROR_LIMIT),
  }
}

/**
 * Renders the prompt-footer status line: pending permission count, running
 * subagent count, and accumulated session cost. Empty parts are omitted; an
 * all-zero snapshot renders no footer at all.
 */
export function formatFooterStatus(
  permissions: readonly { pending: boolean }[],
  tree: readonly SessionTreeNode[],
): string {
  const pending = permissions.filter((entry) => entry.pending).length
  const running = tree.filter((node) => !node.isRoot && node.status === "running").length
  const cost = knownSessionCost(tree)
  return [
    pending > 0 ? `⏳${pending} perm` : "",
    running > 0 ? `●${running} agents` : "",
    cost !== undefined && cost > 0 ? `$${cost.toFixed(2)}` : "",
  ].filter(Boolean).join(" · ")
}

/** Top tools sorted by call count, bounded for display. */
export function topTools(stats: SessionToolStats, limit = 5): { name: string; count: number }[] {
  return [...stats.counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

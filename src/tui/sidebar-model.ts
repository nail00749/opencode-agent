import type { AccessExplanation, AccessNextStep } from "../core/access-explanation"
import type { LeaseSnapshotEntry } from "../rpc/permissions-rpc"
import { EMPTY_INSIGHTS, type InsightAvailability, type SessionInsights } from "./insights"
import { relativeTime } from "./insights"
import type { SessionSkillUsage } from "./session-insights"

export const SIDEBAR_SECTIONS = ["GVOZD", "TASKS", "AGENTS", "SKILLS", "ACCESS", "CONTEXT"] as const
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number]

export type FetchPhase = "loading" | "ready" | "error"

/**
 * A failed fetch is unavailable or stale. It is never rewritten into a
 * confirmed empty collection.
 */
export type FetchState<T> =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "stale"; readonly value: T }
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly value: T }

export interface SidebarAction {
  readonly id: "open-menu"
  readonly label: string
  readonly section: "GVOZD"
}

export interface SidebarLine {
  readonly text: string
  readonly tone: "muted" | "default" | "success" | "error"
}

export interface SidebarSectionModel {
  readonly id: SidebarSection
  readonly title: string
  readonly summary: string
  readonly expanded: boolean
  readonly lines: readonly SidebarLine[]
  readonly actions: readonly SidebarAction[]
}

export interface HostTask {
  readonly id: string
  readonly title: string
  readonly status?: string
}

export interface PendingCheck {
  readonly id: string
  readonly action: string
  readonly resources: readonly string[]
  readonly observationID?: string
}

export interface AgentIdentity {
  readonly id: string
  readonly model?: string
  readonly disabled: boolean
  readonly primary: boolean
}

export interface SidebarInput {
  readonly expanded: Readonly<Record<SidebarSection, boolean>>
  readonly version: string
  readonly sessionID: string
  readonly now: number
  readonly insights: SessionInsights
  readonly agents: readonly AgentIdentity[] | undefined
  readonly mode: FetchState<{ readonly label: string; readonly policy: string }>
  readonly fileGuard: FetchState<{ readonly shellEscalation: "ask" | "deny" }>
  readonly leases: FetchState<readonly LeaseSnapshotEntry[]>
  readonly hostTasks: FetchState<readonly HostTask[]>
  readonly explanations: FetchState<readonly AccessExplanation[]>
}

export function defaultExpanded(): Record<SidebarSection, boolean> {
  return { GVOZD: true, TASKS: false, AGENTS: false, SKILLS: false, ACCESS: false, CONTEXT: false }
}

export function toggleSection(
  expanded: Readonly<Record<SidebarSection, boolean>>,
  section: SidebarSection,
): Record<SidebarSection, boolean> {
  return { ...expanded, [section]: !expanded[section] }
}

export function classifyFetch<T>(
  phase: FetchPhase,
  value: T | undefined,
  previous: T | undefined,
  isEmpty: (value: T) => boolean,
): FetchState<T> {
  if (phase === "loading") return previous === undefined ? { status: "loading" } : { status: "stale", value: previous }
  if (phase === "error" || value === undefined) {
    return previous === undefined ? { status: "unavailable" } : { status: "stale", value: previous }
  }
  return isEmpty(value) ? { status: "empty" } : { status: "ready", value }
}

function line(text: string, tone: SidebarLine["tone"] = "muted"): SidebarLine {
  return { text, tone }
}

function availabilitySummary(status: FetchState<unknown>["status"] | InsightAvailability, ready: string): string {
  if (status === "loading") return "loading"
  if (status === "unavailable") return "unavailable"
  if (status === "stale") return "stale"
  if (status === "empty") return "none"
  return ready
}

function countLabel(status: InsightAvailability, count: number, emptyLabel: string): string {
  if (status === "loading") return "loading"
  if (status === "unavailable") return "unavailable"
  if (status === "stale") return `${count} (stale)`
  if (status === "empty" || count === 0) return emptyLabel
  return String(count)
}

export function formatUsage(cost: number | undefined, tokens: number | undefined): string {
  const costText = cost === undefined ? "cost unknown" : `$${cost.toFixed(2)}`
  const tokenText = tokens === undefined ? "tokens unknown" : `${tokens} tok`
  return `${costText} · ${tokenText}`
}

function nextStepLabel(step: AccessNextStep): string {
  if (step === "none") return "no further step"
  if (step === "request-approval") return "request approval"
  if (step === "ask-coordinator") return "ask coordinator"
  if (step === "inspect-policy") return "inspect policy"
  if (step === "inspect-host") return "inspect host"
  return "retry preview"
}

/** Formats producer evidence. Preview allow is displayed, never treated as authorization. */
export function formatExplanation(explanation: AccessExplanation): SidebarLine[] {
  const resource = explanation.resources[0] ?? "(no resource)"
  const extra = explanation.resources.length > 1 ? ` +${explanation.resources.length - 1}` : ""
  const lines = [
    line(`${explanation.action} · ${resource}${extra} · ${explanation.kind}`, "default"),
    line(`native: ${explanation.nativeOutcome}`),
  ]
  if (explanation.kind === "preview") lines.push(line("preview is not authorization"))
  if (explanation.evidence.length === 0) lines.push(line("evidence: none"))
  for (const item of explanation.evidence.slice(0, 6)) {
    lines.push(line(`${item.source} · ${item.effect} · ${item.code} · ${item.resource ?? "batch"}`, item.effect === "deny" ? "error" : "default"))
    if (item.matchedRule) lines.push(line(`rule ${item.matchedRule.action} ${item.matchedRule.resource} ${item.matchedRule.effect}`))
  }
  if (explanation.evidence.length > 6) lines.push(line(`… +${explanation.evidence.length - 6} evidence`))
  lines.push(line(`next: ${nextStepLabel(explanation.nextStep)}`))
  return lines
}

function taskLines(state: FetchState<readonly HostTask[]>): SidebarLine[] {
  if (state.status === "loading") return [line("loading")]
  if (state.status === "unavailable") return [line("host tasks unavailable")]
  if (state.status === "empty") return [line("no host tasks")]
  const tasks = state.value
  const prefix = state.status === "stale" ? [line("host tasks stale")] : []
  return [
    ...prefix,
    ...tasks.slice(0, 6).map((task) => line(`${task.status ?? "open"} · ${task.title}`, "default")),
  ]
}

function agentLines(agents: readonly AgentIdentity[] | undefined, insights: SessionInsights): SidebarLine[] {
  if (!agents) return [line("agents unavailable")]
  if (agents.length === 0) return [line("no configured agents")]
  const live = new Map(insights.tree.map((node) => [node.agent, node]))
  const statusNote = insights.sessionAvailability === "ready"
    ? []
    : [line(insights.sessionAvailability === "stale" ? "live status stale" : insights.sessionAvailability === "loading" ? "live status loading" : "live status unavailable")]
  return [
    ...statusNote,
    ...agents.slice(0, 8).flatMap((agent) => {
      const node = live.get(agent.id)
      const status = agent.disabled
        ? "disabled"
        : insights.sessionAvailability === "ready" || insights.sessionAvailability === "stale"
          ? node?.status ?? "idle"
          : "status unavailable"
      const tone = status === "running" ? "success" : status === "disabled" || node?.outcome === "failed" ? "error" : "default"
      const marker = status === "running" ? "●" : status === "disabled" || node?.outcome === "failed" ? "✗" : "○"
      return [
        line(`${marker} ${agent.id} · ${status}`, tone),
        line(`  ${agent.model ?? "model unavailable"} · ${formatUsage(node?.cost, node?.tokens)}`),
      ]
    }),
  ]
}

function skillLines(skills: readonly SessionSkillUsage[], availability: InsightAvailability, now: number): SidebarLine[] {
  if (availability === "loading") return [line("loading")]
  if (availability === "unavailable") return [line("skills unavailable")]
  if (availability === "stale" && skills.length === 0) return [line("skills stale")]
  if (skills.length === 0) return [line("no skills used")]
  const prefix = availability === "stale" ? [line("skills stale")] : []
  return [
    ...prefix,
    ...skills.slice(0, 8).map((skill) => line(`▸ ${skill.name} · ${relativeTime(skill.lastUsedAt, now) || "unknown"} · ×${skill.activations}`, "default")),
  ]
}

function leaseLines(state: FetchState<readonly LeaseSnapshotEntry[]>, now: number): SidebarLine[] {
  if (state.status === "loading") return [line("leases: loading")]
  if (state.status === "unavailable") return [line("leases: unavailable")]
  if (state.status === "empty") return [line("leases: 0")]
  const leases = state.value
  const label = state.status === "stale" ? `${leases.length} (stale)` : String(leases.length)
  return [
    line(`leases: ${label}`, "default"),
    ...leases.slice(0, 4).map((lease) => {
      const seconds = Math.max(0, Math.ceil((lease.expiresAt - now) / 1000))
      return line(`${lease.state} · ${lease.agent} · ${lease.label} · ${lease.files.length} files · ${seconds}s`)
    }),
  ]
}

function accessLines(input: SidebarInput): SidebarLine[] {
  const pending = input.insights.permissions.filter((entry) => entry.pending).length
  const approval = countLabel(input.insights.permissionAvailability, pending, "none")
  const modeLine = input.mode.status === "ready" || input.mode.status === "stale"
    ? `mode: ${input.mode.value.label}${input.mode.status === "stale" ? " (stale)" : ""}`
    : `mode: ${input.mode.status}`
  const policyLine = input.mode.status === "ready" || input.mode.status === "stale"
    ? `policy: ${input.mode.value.policy}${input.mode.status === "stale" ? " (stale)" : ""}`
    : `policy: ${input.mode.status}`
  const guard = input.fileGuard.status === "ready" || input.fileGuard.status === "stale"
    ? `file-guard: ${input.fileGuard.value.shellEscalation}${input.fileGuard.status === "stale" ? " (stale)" : ""}`
    : `file-guard: ${input.fileGuard.status}`
  const explanationLines = input.explanations.status === "ready" || input.explanations.status === "stale"
    ? [
        ...(input.explanations.status === "stale" ? [line("explanation stale")] : []),
        ...input.explanations.value.flatMap((explanation) => formatExplanation(explanation)),
      ]
    : [line(input.explanations.status === "empty" ? "no pending checks" : `explanation ${input.explanations.status}`)]
  return [
    line(`prompts: ${approval}`),
    line(modeLine, "default"),
    line(guard),
    ...leaseLines(input.leases, input.now),
    line(`pending approvals: ${approval}`),
    line(policyLine),
    ...explanationLines,
    line("read only · does not approve, execute, or change policy"),
  ]
}

function contextLines(input: SidebarInput): SidebarLine[] {
  const insights = input.insights
  if (insights.sessionAvailability === "unavailable" && insights.messageAvailability === "unavailable") {
    return [line("context unavailable")]
  }
  if (insights.sessionAvailability === "loading" && insights.messageAvailability === "loading") return [line("loading")]
  if (insights.sessionAvailability === "empty") return [line("context empty")]
  const root = insights.tree.find((node) => node.isRoot) ?? insights.tree[0]
  const lines: SidebarLine[] = []
  if (insights.sessionAvailability === "stale" || insights.messageAvailability === "stale") lines.push(line("context stale"))
  if (insights.sessionAvailability === "unavailable") lines.push(line("session unavailable"))
  else if (root) {
    lines.push(line(input.sessionID, "default"))
    lines.push(line(`${root.agent ?? "agent unknown"} · ${root.model ?? "model unavailable"}`))
    lines.push(line(formatUsage(root.cost, root.tokens)))
    if (root.outcome) lines.push(line(`outcome: ${root.outcome}`))
  }
  if (insights.messageAvailability === "unavailable") lines.push(line("tools unavailable"))
  else if (insights.messageAvailability !== "loading") {
    lines.push(line(`tools: ${insights.tools.totalCalls} · errors: ${insights.tools.errors}${insights.messageAvailability === "stale" ? " (stale)" : ""}`))
  }
  return lines.length > 0 ? lines : [line("context unavailable")]
}

function sectionSummary(id: SidebarSection, input: SidebarInput): string {
  if (id === "GVOZD") return `v${input.version}`
  if (id === "TASKS") return availabilitySummary(input.hostTasks.status, input.hostTasks.status === "ready" ? String(input.hostTasks.value.length) : "none")
  if (id === "AGENTS") return input.agents ? String(input.agents.length) : "unavailable"
  if (id === "SKILLS") return countLabel(input.insights.messageAvailability, input.insights.skills.length, "none")
  if (id === "ACCESS") return countLabel(input.insights.permissionAvailability, input.insights.permissions.filter((entry) => entry.pending).length, "none")
  if (input.insights.sessionAvailability === "unavailable" || input.insights.messageAvailability === "unavailable") return "unavailable"
  return input.insights.sessionAvailability === "loading" ? "loading" : "ready"
}

function sectionLines(id: SidebarSection, input: SidebarInput): SidebarLine[] {
  if (id === "GVOZD") {
    const mode = input.mode.status === "ready" || input.mode.status === "stale"
      ? input.mode.value.label
      : input.mode.status
    return [
      line(`v${input.version} · native`, "default"),
      line("controls on demand · /gvozd"),
      line(`mode: ${mode}${input.mode.status === "stale" ? " (stale)" : ""}`),
    ]
  }
  if (id === "TASKS") return taskLines(input.hostTasks)
  if (id === "AGENTS") return agentLines(input.agents, input.insights)
  if (id === "SKILLS") return skillLines(input.insights.skills, input.insights.messageAvailability, input.now)
  if (id === "ACCESS") return accessLines(input)
  return contextLines(input)
}

export function buildSidebar(input: SidebarInput): SidebarSectionModel[] {
  return SIDEBAR_SECTIONS.map((id) => ({
    id,
    title: id,
    summary: sectionSummary(id, input),
    expanded: input.expanded[id],
    lines: sectionLines(id, input),
    actions: id === "GVOZD"
      ? [{ id: "open-menu", label: "Open Gvozd menu", section: "GVOZD" }]
      : [],
  }))
}

const OBSERVATION_KEY = "observationID"

/** Reads an observation id only when the host supplied that exact field. */
export function observationID(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined
  const value = (metadata as Record<string, unknown>)[OBSERVATION_KEY]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export interface ExplanationPlan {
  readonly status: "loading" | "unavailable" | "empty" | "ready"
  readonly requests: readonly {
    readonly sessionID: string
    readonly agent: string
    readonly action: string
    readonly resources: readonly string[]
    readonly observationID?: string
  }[]
}

/**
 * Plans read-only explanation calls. Missing agent, action, or availability
 * never becomes a guessed master check or an empty allow.
 */
export function explanationRequests(input: {
  readonly sessionID: string
  readonly agent: string | undefined
  readonly availability: InsightAvailability
  readonly pending: readonly PendingCheck[] | undefined
}): ExplanationPlan {
  if (input.availability === "loading") return { status: "loading", requests: [] }
  if (input.availability === "unavailable" || input.pending === undefined) return { status: "unavailable", requests: [] }
  if (input.pending.length === 0) return { status: "empty", requests: [] }
  if (!input.agent) return { status: "unavailable", requests: [] }
  const requests = []
  for (const check of input.pending.slice(0, 4)) {
    if (!check.action) continue
    requests.push({
      sessionID: input.sessionID,
      agent: input.agent,
      action: check.action,
      resources: [...check.resources],
      ...(check.observationID ? { observationID: check.observationID } : {}),
    })
  }
  return requests.length > 0 ? { status: "ready", requests } : { status: "unavailable", requests: [] }
}

export function joinSidebarText(sections: readonly SidebarSectionModel[]): string {
  return sections.flatMap((section) => [section.title, section.summary, ...section.lines.map((entry) => entry.text)]).join("\n")
}

export function formatSectionHeading(entry: Pick<SidebarSectionModel, "expanded" | "title" | "summary">): string {
  return `${entry.expanded ? "▼" : "▶"} ${entry.title}${entry.expanded ? "" : `  ${entry.summary}`}`
}

/**
 * Owns a snapshot when its root belongs to this session. Descendant session
 * IDs are family members, not a foreign fetch. A root from another session is
 * still rejected, as is a mismatched fetch owner.
 */
export function insightsForSession(
  sessionID: string,
  fetchedFor: string | undefined,
  insights: SessionInsights | undefined,
): SessionInsights {
  if (!insights || fetchedFor !== sessionID) return EMPTY_INSIGHTS
  const root = insights.tree.find((node) => node.isRoot)
  if (root && root.sessionID !== sessionID) return EMPTY_INSIGHTS
  return insights
}

/** Agent id only when this session's own root recorded one. */
export function agentForSession(sessionID: string, insights: SessionInsights | undefined): string | undefined {
  if (!insights) return undefined
  if (insights.sessionAvailability !== "ready" && insights.sessionAvailability !== "stale") return undefined
  const root = insights.tree.find((node) => node.isRoot && node.sessionID === sessionID)
  return root?.agent ? root.agent : undefined
}

/** A fetch owned by another session is loading, never that session's stale value. */
export function adoptSessionFetch<T>(sessionID: string, owner: string | undefined, state: FetchState<T> | undefined): FetchState<T> {
  if (owner !== sessionID || !state) return { status: "loading" }
  return state
}

export function listSessionOwner(sessionID: string, list: readonly { sessionID?: string }[] | undefined): string | undefined {
  if (!list) return undefined
  if (list.length === 0) return sessionID
  const owners = new Set(list.map((entry) => entry.sessionID).filter((id): id is string => typeof id === "string" && id.length > 0))
  if (owners.size !== 1) return undefined
  return [...owners][0]
}

/**
 * Plans explanation calls for one session. A cached list or agent from another
 * session produces no requests, including when this session's refetch failed.
 */
export function explanationPlanForSession(input: {
  readonly sessionID: string
  readonly insights: SessionInsights | undefined
  readonly insightsSessionID: string | undefined
  readonly pending: readonly PendingCheck[] | undefined
  readonly pendingSessionID: string | undefined
}): ExplanationPlan {
  if (input.pendingSessionID !== undefined && input.pendingSessionID !== input.sessionID) {
    return { status: "unavailable", requests: [] }
  }
  const insights = insightsForSession(input.sessionID, input.insightsSessionID, input.insights)
  return explanationRequests({
    sessionID: input.sessionID,
    agent: agentForSession(input.sessionID, insights),
    availability: input.insightsSessionID === input.sessionID ? insights.permissionAvailability : "loading",
    pending: input.pendingSessionID === input.sessionID ? input.pending : undefined,
  })
}

// Package typings resolve to the server build, which does not subscribe in the
// OpenTUI client renderer. The client build is the same runtime the host uses.
// @ts-expect-error solid-js/dist/solid.js has no bundled declaration
import { createEffect, createRenderEffect, createResource, createSignal, For } from "solid-js/dist/solid.js"
import { usePlugin } from "@opencode/plugin/tui"
import { TextRenderable, type BoxRenderable, type KeyEvent, type RenderContext } from "@opentui/core"
import { ALL_AGENT_IDS } from "../core/constants"
import type { AccessExplanation } from "../core/access-explanation"
import { PACKAGE_VERSION } from "../core/release-metadata"
import { collectAgentRoster, sortAgentRoster, type AgentRosterEntry } from "./agent-roster"
import {
  explainAccess,
  getSessionState,
  headingColor,
  listLeases,
  themeColor,
  useSessionInsights,
  type SessionInsights,
} from "./insights"
import { openNativeControl, readGvozdConfig } from "./native-control"
import { sessionPermissionStatus, summarizeOverrides } from "./permission-panel"
import {
  adoptSessionFetch,
  agentForSession,
  buildSidebar,
  classifyFetch,
  defaultExpanded,
  explanationPlanForSession,
  formatSectionHeading,
  insightsForSession,
  listSessionOwner,
  observationID,
  SIDEBAR_SECTIONS,
  toggleSection,
  type FetchPhase,
  type FetchState,
  type PendingCheck,
  type SidebarInput,
  type SidebarLine,
  type SidebarSection,
  type SidebarSectionModel,
} from "./sidebar-model"
import { TeamActionTrigger } from "./team-action-trigger"
import type { LeaseListOutput } from "../rpc/permissions-rpc"

function phaseOf(loading: boolean, failed: boolean): FetchPhase {
  if (loading) return "loading"
  if (failed) return "error"
  return "ready"
}

function toneColor(tone: SidebarLine["tone"], colors: { muted: string; text: string; success: string; error: string }): string {
  if (tone === "success") return colors.success
  if (tone === "error") return colors.error
  if (tone === "default") return colors.text
  return colors.muted
}

function readSidebarInput(input: Omit<SidebarInput, "expanded"> | (() => Omit<SidebarInput, "expanded">)): Omit<SidebarInput, "expanded"> {
  return typeof input === "function" ? input() : input
}

export function GroupedSidebarView(props: {
  input: Omit<SidebarInput, "expanded"> | (() => Omit<SidebarInput, "expanded">)
  heading: string
  muted: string
  text: string
  success: string
  error: string
  initialExpanded?: Record<SidebarSection, boolean>
  onOpenMenu: () => void
  onHeader?: (section: SidebarSection, node: BoxRenderable) => void
  onToggled?: (section: SidebarSection) => void
  onBody?: (section: SidebarSection, node: BoxRenderable) => void
}) {
  const [expanded, setExpanded] = createSignal(props.initialExpanded ?? defaultExpanded())
  const headers = new Map<SidebarSection, TextRenderable>()
  const bodies = new Map<SidebarSection, BoxRenderable>()
  const lines = new Map<SidebarSection, TextRenderable[]>()
  const colors = () => ({ muted: props.muted, text: props.text, success: props.success, error: props.error })
  const model = (): SidebarSectionModel[] => buildSidebar({ ...readSidebarInput(props.input), expanded: expanded() })
  const ensureLineSlots = (id: SidebarSection, count: number) => {
    const body = bodies.get(id)
    if (!body || count <= 0) return
    const slots = lines.get(id) ?? []
    while (slots.length < count) {
      const template = slots.find((slot) => slot)
      const ctx = (template as unknown as { _ctx?: RenderContext } | undefined)?._ctx ?? (body as unknown as { _ctx?: RenderContext })._ctx
      if (!ctx) return
      const node = new TextRenderable(ctx, { content: "" })
      const anchor = body.getChildren().find((child) => !slots.includes(child as TextRenderable))
      if (anchor) body.insertBefore(node, anchor)
      else body.add(node)
      slots.push(node)
    }
    lines.set(id, slots)
  }
  const paint = (sections: readonly SidebarSectionModel[]) => {
    const palette = colors()
    for (const entry of sections) {
      const header = headers.get(entry.id)
      if (header) header.content = formatSectionHeading(entry)
      const body = bodies.get(entry.id)
      if (body) body.visible = entry.expanded
      ensureLineSlots(entry.id, entry.lines.length)
      const slots = lines.get(entry.id) ?? []
      for (let index = 0; index < slots.length; index++) {
        const slot = slots[index]
        const row = entry.lines[index]
        if (!slot) continue
        if (!row) {
          slot.content = ""
          slot.visible = false
          continue
        }
        slot.content = row.text
        slot.fg = toneColor(row.tone, palette)
        slot.visible = true
      }
    }
  }
  const toggle = (id: SidebarSection, event?: KeyEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    setExpanded((current: Record<SidebarSection, boolean>) => toggleSection(current, id))
    props.onToggled?.(id)
  }
  // mapArray does not rerun when expanded() or input changes. Write the live
  // model into the mounted text nodes instead of relying on JSX evaluation.
  createRenderEffect(() => {
    paint(model())
  })
  return (
    <box flexDirection="column">
      <For each={SIDEBAR_SECTIONS}>
        {(id: SidebarSection) => (
          <box flexDirection="column">
            <box
              focusable
              ref={(node: BoxRenderable) => props.onHeader?.(id, node)}
              onMouseUp={() => toggle(id)}
              onKeyDown={(event) => {
                if (event.name !== "return" && event.name !== "linefeed" && event.name !== "space") return
                toggle(id, event)
              }}
            >
              <text fg={props.heading} ref={(node: TextRenderable) => { headers.set(id, node); paint(model()) }} />
            </box>
            <box
              flexDirection="column"
              ref={(node: BoxRenderable) => {
                bodies.set(id, node)
                node.visible = expanded()[id]
                props.onBody?.(id, node)
                paint(model())
              }}
            >
              <text
                ref={(node: TextRenderable) => {
                  const slots = lines.get(id) ?? []
                  slots[0] = node
                  lines.set(id, slots)
                  paint(model())
                }}
              />
              {id === "GVOZD" ? (
                <TeamActionTrigger onAction={props.onOpenMenu}>
                  <text fg={props.text}>[ Open Gvozd menu ]</text>
                </TeamActionTrigger>
              ) : null}
            </box>
          </box>
        )}
      </For>
    </box>
  )
}

function rosterOf(agents: readonly AgentRosterEntry[] | undefined): SidebarInput["agents"] {
  if (!agents) return undefined
  return agents.map((agent) => ({ id: agent.id, model: agent.model, disabled: agent.disabled, primary: agent.primary }))
}

function insightOwner(sessionID: string, snapshot: SessionInsights | undefined): string | undefined {
  if (!snapshot) return undefined
  const root = snapshot.tree.find((node) => node.isRoot)
  if (!root || root.sessionID !== sessionID) return undefined
  return sessionID
}

function pendingChecks(insights: SessionInsights, list: readonly { id: string; action?: string; resources?: readonly string[]; metadata?: unknown; sessionID?: string }[] | undefined): readonly PendingCheck[] | undefined {
  if (insights.permissionAvailability === "loading" || insights.permissionAvailability === "unavailable") return undefined
  if (list) {
    return list.map((request) => ({
      id: request.id,
      action: request.action ?? "",
      resources: request.resources ?? [],
      observationID: observationID(request.metadata),
    }))
  }
  if (insights.permissionAvailability !== "stale") return undefined
  return insights.permissions.filter((entry) => entry.pending).map((entry) => ({
    id: entry.id,
    action: entry.action,
    resources: entry.resource === "(no resource)" ? [] : [entry.resource],
  }))
}

export function GroupedSidebar(props: { sessionID: string }) {
  const context = usePlugin()
  const [sessionID, setSessionID] = createSignal(props.sessionID)
  const [modeOwner, setModeOwner] = createSignal<string | undefined>()
  const [explanationOwner, setExplanationOwner] = createSignal<string | undefined>()
  const [previousMode, setPreviousMode] = createSignal<NonNullable<Awaited<ReturnType<typeof getSessionState>>> | undefined>()
  const [previousGuard, setPreviousGuard] = createSignal<"ask" | "deny">()
  const [previousLeases, setPreviousLeases] = createSignal<LeaseListOutput["leases"]>()
  const [previousExplanations, setPreviousExplanations] = createSignal<readonly AccessExplanation[] | undefined>()
  // Clear session posture before the next paint. A later failed refetch must
  // not classify the previous session's mode or explanation as stale data.
  if (props.sessionID !== sessionID()) {
    setSessionID(props.sessionID)
    setModeOwner(undefined)
    setPreviousMode(undefined)
    setExplanationOwner(undefined)
    setPreviousExplanations(undefined)
  }
  const insights = useSessionInsights(sessionID)
  const [modeResource] = createResource(sessionID, (id: string) => getSessionState(context, id))
  const [guardResource] = createResource(() => props.sessionID, () => readGvozdConfig(context))
  const [leaseResource] = createResource(() => props.sessionID, () => listLeases(context))
  createRenderEffect(() => {
    const id = sessionID()
    if (modeResource.loading) return
    setModeOwner(id)
    setPreviousMode(modeResource.error !== undefined ? undefined : modeResource())
  })
  createEffect(() => {
    const guard = guardResource()?.lease.shellEscalation
    if (guard) setPreviousGuard(guard)
    const leases = leaseResource()?.leases
    if (leases) setPreviousLeases(leases)
  })
  const scopedInsights = () => insightsForSession(sessionID(), insightOwner(sessionID(), insights()), insights())
  const plan = () => {
    const id = sessionID()
    const list = context.data.session.permission.list(id)
    return explanationPlanForSession({
      sessionID: id,
      insights: insights(),
      insightsSessionID: insightOwner(id, insights()),
      pending: pendingChecks(scopedInsights(), list),
      pendingSessionID: listSessionOwner(id, list),
    })
  }
  const [explanationResource] = createResource(
    () => {
      const id = sessionID()
      const currentPlan = plan()
      if (currentPlan.status !== "ready") return undefined
      if (currentPlan.requests.some((request) => request.sessionID !== id || request.agent !== agentForSession(id, scopedInsights()))) return undefined
      return currentPlan
    },
    async (currentPlan: { requests: readonly { sessionID: string; agent: string; action: string; resources: readonly string[]; observationID?: string }[] }) => {
      const rows: AccessExplanation[] = []
      for (const request of currentPlan.requests) {
        const explanation = await explainAccess(context, request)
        if (!explanation) throw new Error("access explanation unavailable")
        rows.push(explanation)
      }
      return rows
    },
  )
  createRenderEffect(() => {
    const id = sessionID()
    const currentPlan = plan()
    if (currentPlan.status !== "ready") {
      setExplanationOwner(id)
      setPreviousExplanations(undefined)
      return
    }
    if (explanationResource.loading) return
    setExplanationOwner(id)
    setPreviousExplanations(explanationResource.error !== undefined ? undefined : explanationResource())
  })
  const mode = (): SidebarInput["mode"] => {
    const id = sessionID()
    const owned = modeOwner() === id
    const state = adoptSessionFetch(id, owned ? id : undefined, owned ? classifyFetch(
      phaseOf(modeResource.loading, modeResource.error !== undefined || previousMode() === undefined),
      previousMode(),
      undefined,
      () => false,
    ) : undefined)
    if (state.status !== "ready" && state.status !== "stale") return state
    return {
      status: state.status,
      value: { label: sessionPermissionStatus(state.value.mode, state.value.overrides), policy: summarizeOverrides(state.value.overrides) },
    }
  }
  const fileGuard = (): SidebarInput["fileGuard"] => {
    const escalation = guardResource()?.lease.shellEscalation
    const state = classifyFetch(
      phaseOf(guardResource.loading, guardResource.error !== undefined),
      escalation,
      previousGuard(),
      () => false,
    )
    if (state.status !== "ready" && state.status !== "stale") return state
    return { status: state.status, value: { shellEscalation: state.value } }
  }
  const leases = (): SidebarInput["leases"] => classifyFetch(
    phaseOf(leaseResource.loading, leaseResource.error !== undefined),
    leaseResource()?.leases,
    previousLeases(),
    (entries) => entries.length === 0,
  )
  const explanations = (): FetchState<readonly AccessExplanation[]> => {
    const id = sessionID()
    const currentPlan = plan()
    if (currentPlan.status === "loading" || currentPlan.status === "unavailable" || currentPlan.status === "empty") {
      return { status: currentPlan.status }
    }
    return adoptSessionFetch(
      id,
      explanationOwner() === id ? id : undefined,
      explanationOwner() === id ? classifyFetch(
        phaseOf(explanationResource.loading, explanationResource.error !== undefined || previousExplanations() === undefined),
        previousExplanations(),
        undefined,
        () => false,
      ) : undefined,
    )
  }
  const listed = context.data.location.agent.list(context.location)
  const input = (): Omit<SidebarInput, "expanded"> => {
    const id = props.sessionID
    if (id !== sessionID()) {
      setSessionID(id)
      setModeOwner(undefined)
      setPreviousMode(undefined)
      setExplanationOwner(undefined)
      setPreviousExplanations(undefined)
    }
    return {
      version: PACKAGE_VERSION,
      sessionID: id,
      now: Date.now(),
      insights: scopedInsights(),
      agents: listed ? rosterOf(sortAgentRoster(collectAgentRoster(listed, ALL_AGENT_IDS))) : undefined,
      mode: mode(),
      fileGuard: fileGuard(),
      leases: leases(),
      hostTasks: { status: "unavailable" },
      explanations: explanations(),
    }
  }
  return (
    <GroupedSidebarView
      input={input}
      heading={headingColor(context.theme)}
      muted={themeColor(context.theme, ["text", "muted"]) ?? "#808080"}
      text={themeColor(context.theme, ["text", "default"]) ?? "#d0d0d0"}
      success={themeColor(context.theme, ["status", "success"]) ?? "#22c55e"}
      error={themeColor(context.theme, ["status", "error"]) ?? "#ef4444"}
      onOpenMenu={() => void openNativeControl(context, props.sessionID)}
    />
  )
}

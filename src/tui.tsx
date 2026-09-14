import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  EMPTY_INSIGHTS,
  evaluatePermissions,
  listLeases,
  relativeTime,
  setTrustMode,
  themeColor,
  useSessionInsights,
  type SessionInsights,
} from "./tui-insights"
import type { LeaseListOutput } from "./permissions-rpc"
import { formatFooterStatus, topTools } from "./session-tools"
import { splitCommandPipeline } from "./command-pipeline"

function SkillsSection(props: { insights: SessionInsights }) {
  const context = usePlugin()
  const now = Date.now()
  return (
    <box flexDirection="column">
      <text fg={themeColor(context.theme, ["text", "muted"])}>skills</text>
      <For each={props.insights.skills.slice(0, 8)}>
        {(skill) => (
          <text fg={themeColor(context.theme, ["text", "default"])}>
            {`▸ ${skill.name} ${relativeTime(skill.lastUsedAt, now)}`}
          </text>
        )}
      </For>
    </box>
  )
}

function PermissionsSection(props: { insights: SessionInsights }) {
  const context = usePlugin()
  return (
    <box flexDirection="column">
      <text fg={themeColor(context.theme, ["text", "muted"])}>permissions</text>
      <For each={props.insights.permissions.slice(0, 8)}>
        {(entry) => {
          const marker = entry.pending ? "⏳" : entry.reply === "reject" ? "✗" : "✓"
          const fg = entry.pending
            ? themeColor(context.theme, ["text", "default"])
            : entry.reply === "reject"
              ? themeColor(context.theme, ["status", "error"])
              : entry.reply === "always"
                ? themeColor(context.theme, ["status", "success"])
                : themeColor(context.theme, ["text", "muted"])
          const label = entry.pending ? "" : entry.reply === "always" ? " always" : entry.reply === "reject" ? " reject" : " once"
          const extra = entry.extraResources > 0 ? ` +${entry.extraResources}` : ""
          return <text fg={fg}>{`${marker} ${entry.action} | ${entry.resource}${extra}${label}`}</text>
        }}
      </For>
    </box>
  )
}

function SubagentsSection(props: { insights: SessionInsights }) {
  const context = usePlugin()
  const descendants = () => props.insights.tree.filter((node) => !node.isRoot)
  return (
    <Show when={descendants().length > 0}>
      <box flexDirection="column">
        <text fg={themeColor(context.theme, ["text", "muted"])}>subagents</text>
        <For each={descendants().slice(0, 8)}>
          {(node) => {
            const marker = node.status === "running" ? "●" : node.outcome === "failed" || node.outcome === "interrupted" ? "✗" : "○"
            const fg = node.status === "running"
              ? themeColor(context.theme, ["status", "success"])
              : node.outcome === "failed" || node.outcome === "interrupted"
                ? themeColor(context.theme, ["status", "error"])
                : themeColor(context.theme, ["text", "muted"])
            const model = node.model ? ` ${node.model.split("/").pop()}` : ""
            const cost = node.cost > 0 ? ` $${node.cost.toFixed(2)}` : ""
            return <text fg={fg}>{`${marker} ${node.agent ?? "?"}${model}${cost}`}</text>
          }}
        </For>
      </box>
    </Show>
  )
}

function ToolsSection(props: { insights: SessionInsights }) {
  const context = usePlugin()
  const ranked = () => topTools(props.insights.tools, 5)
  return (
    <Show when={props.insights.tools.totalCalls > 0}>
      <box flexDirection="column">
        <text fg={themeColor(context.theme, ["text", "muted"])}>tools</text>
        <For each={ranked()}>
          {(tool) => (
            <text fg={themeColor(context.theme, ["text", "default"])}>{`▸ ${tool.name} ×${tool.count}`}</text>
          )}
        </For>
        <Show when={props.insights.tools.errors > 0}>
          <text fg={themeColor(context.theme, ["status", "error"])}>
            {`${props.insights.tools.errors} error(s), ${props.insights.tools.recentErrors.filter((error) => error.permission).length} permission`}
          </text>
        </Show>
      </box>
    </Show>
  )
}

function SessionInsightsSlot(props: { sessionID: string }) {
  const insights = useSessionInsights(() => props.sessionID)
  const current = () => insights.latest ?? EMPTY_INSIGHTS
  return (
    <Show
      when={
        current().skills.length > 0 ||
        current().permissions.length > 0 ||
        current().tree.some((node) => !node.isRoot) ||
        current().tools.totalCalls > 0
      }
    >
      <box flexDirection="column" marginTop={1}>
        <Show when={current().tree.some((node) => !node.isRoot)}>
          <SubagentsSection insights={current()} />
        </Show>
        <Show when={current().skills.length > 0}>
          <SkillsSection insights={current()} />
        </Show>
        <Show when={current().permissions.length > 0}>
          <PermissionsSection insights={current()} />
        </Show>
        <Show when={current().tools.totalCalls > 0}>
          <ToolsSection insights={current()} />
        </Show>
      </box>
    </Show>
  )
}

/** Dry-run panel state: one evaluated command row. */
interface DryRunRow {
  readonly command: string
  readonly effect: string
  readonly matchedRule: string | null
}

function DryRunPanel() {
  const context = usePlugin()
  const [input, setInput] = createSignal("")
  const [agent, setAgent] = createSignal("master")
  const [rows, setRows] = createSignal<DryRunRow[]>([])
  const [busy, setBusy] = createSignal(false)

  const run = async () => {
    const command = input().trim()
    if (!command || busy()) return
    setBusy(true)
    try {
      // Compound lines evaluate segment-by-segment so each command in a
      // pipeline gets its own verdict.
      const segments = splitCommandPipeline(command)
      const output = await evaluatePermissions(agent(), [{ action: "shell", resources: segments }])
      if (output) {
        setRows((current) => [
          ...output.results.map((result) => ({
            command: result.resource,
            effect: result.effect,
            matchedRule: result.matchedRule,
          })),
          ...current,
        ].slice(0, 20))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <box flexDirection="column" padding={1}>
      <text fg={themeColor(context.theme, ["text", "default"])}>gvozd permission dry-run</text>
      <text fg={themeColor(context.theme, ["text", "muted"])}>{`agent: ${agent()} — type a shell command and press enter`}</text>
      <input
        placeholder="git diff HEAD"
        onInput={(value: string) => setInput(value)}
        onSubmit={() => void run()}
      />
      <For each={rows()}>
        {(row) => {
          const fg = row.effect === "deny"
            ? themeColor(context.theme, ["status", "error"])
            : row.effect === "allow"
              ? themeColor(context.theme, ["status", "success"])
              : themeColor(context.theme, ["text", "default"])
          return (
            <text fg={fg}>
              {`${row.effect.padEnd(7)} ${row.command}${row.matchedRule ? `  ← ${row.matchedRule}` : ""}`}
            </text>
          )
        }}
      </For>
      <Show when={rows().length === 0 && !busy()}>
        <text fg={themeColor(context.theme, ["text", "muted"])}>no evaluations yet</text>
      </Show>
    </box>
  )
}

function LeasePanel() {
  const context = usePlugin()
  const [snapshot, setSnapshot] = createSignal<LeaseListOutput | undefined>()
  const [busy, setBusy] = createSignal(false)

  const refresh = async () => {
    setBusy(true)
    try {
      setSnapshot(await listLeases())
    } finally {
      setBusy(false)
    }
  }
  void onMount(() => void refresh())

  return (
    <box flexDirection="column" padding={1}>
      <text fg={themeColor(context.theme, ["text", "default"])}>gvozd file leases</text>
      <Show when={!busy()} fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>refreshing…</text>}>
        <Show
          when={((snapshot() as LeaseListOutput | undefined)?.leases.length ?? 0) > 0}
          fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>no leases — writers run without reservations</text>}
        >
          <For each={snapshot()?.leases ?? []}>
            {(lease) => (
              <text>
                <span style={{ fg: lease.state === "active" ? themeColor(context.theme, ["status", "success"]) : themeColor(context.theme, ["text", "muted"]) }}>{`${lease.state === "active" ? "●" : "○"} ${lease.agent} ${lease.label} ${lease.files.length}f `}</span>
                <span style={{ fg: themeColor(context.theme, ["text", "muted"]) }}>{`ttl ${relativeTime(lease.expiresAt, Date.now())}`}</span>
              </text>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

function FullscreenPanel() {
  const context = usePlugin()
  const [sessionID, setSessionID] = createSignal<string | undefined>(undefined)
  // Resolve the current session from the host route when the panel opens.
  const route = context.ui.router.current()
  if (route.type === "session") setSessionID(route.sessionID)
  const insights = useSessionInsights(sessionID)
  const current = () => insights.latest ?? EMPTY_INSIGHTS
  return (
    <box flexDirection="column" padding={1}>
      <text fg={themeColor(context.theme, ["text", "default"])}>gvozd session insights</text>
      <Show when={sessionID()} fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>open inside a session to see insights</text>}>
        <box flexDirection="column">
          <SubagentsSection insights={current()} />
          <SkillsSection insights={current()} />
          <PermissionsSection insights={current()} />
          <ToolsSection insights={current()} />
        </box>
      </Show>
    </box>
  )
}

function FooterStatusSlot(props: { sessionID: string }) {
  const insights = useSessionInsights(() => props.sessionID)
  const current = () => insights.latest ?? EMPTY_INSIGHTS
  const context = usePlugin()
  const running = () => current().tree.filter((node) => !node.isRoot && node.status === "running").length
  const pending = () => current().permissions.filter((entry) => entry.pending).length
  const cost = () => current().tree.reduce((sum, node) => sum + node.cost, 0)
  return (
    <Show when={running() > 0 || pending() > 0 || cost() > 0}>
      <text fg={themeColor(context.theme, ["text", "muted"])}>
        {formatFooterStatus(current().permissions, current().tree)}
      </text>
    </Show>
  )
}

function ModePanel() {
  const context = usePlugin()
  const route = context.ui.router.current()
  const sessionID = route.type === "session" ? route.sessionID : undefined
  const [applied, setApplied] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)

  const apply = async (mode: "balanced" | "trusted" | "strict") => {
    if (!sessionID || busy()) return
    setBusy(true)
    try {
      const result = await setTrustMode(sessionID, mode)
      if (result) setApplied(result.mode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <box flexDirection="column" padding={1}>
      <text fg={themeColor(context.theme, ["text", "default"])}>gvozd permission mode</text>
      <Show when={sessionID} fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>open inside a session to switch modes</text>}>
        <box flexDirection="column">
          <text fg={themeColor(context.theme, ["text", "default"])}>{busy() ? "applying…" : "select a posture (enter to apply):"}</text>
          <For each={["balanced", "trusted", "strict"] as const}>
            {(mode) => (
              <text fg={themeColor(context.theme, ["text", "default"])}>{`▸ ${mode}: ${MODE_HINTS[mode]}`}</text>
            )}
          </For>
          <Show when={applied()}>
            <text fg={themeColor(context.theme, ["status", "success"])}>{`applied: ${applied()} — child sessions inherit it`}</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const MODE_HINTS: Record<"balanced" | "trusted" | "strict", string> = {
  balanced: "ask for unknown shell and edits (current default)",
  trusted: "allow all shell and edits; destructive git still denied",
  strict: "ask for every shell command and edit",
}

export default Plugin.define({
  id: "agent-gvozd",
  setup(context) {
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <SessionInsightsSlot sessionID={sessionID} />,
    })
    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => (sessionID ? <FooterStatusSlot sessionID={sessionID} /> : null),
    })
    const unregisterPanelSlot = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <>
          <Show when={panel.name === "gvozd.insights"}>
            <FullscreenPanel />
          </Show>
          <Show when={panel.name === "gvozd.dryrun"}>
            <DryRunPanel />
          </Show>
          <Show when={panel.name === "gvozd.leases"}>
            <LeasePanel />
          </Show>
          <Show when={panel.name === "gvozd.mode"}>
            <ModePanel />
          </Show>
        </>
      ),
    })
    const unregisterKeymap = context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "gvozd.insights",
          title: "Gvozd session insights",
          group: "Gvozd",
          palette: true,
          slash: { name: "gvozd" },
          run: () => {
            context.ui.panel.open("gvozd.insights", { presentation: "fullscreen" })
          },
        },
        {
          id: "gvozd.dryrun",
          title: "Gvozd permission dry-run",
          group: "Gvozd",
          palette: true,
          slash: { name: "gvozd-dryrun" },
          run: () => {
            context.ui.panel.open("gvozd.dryrun", { presentation: "fullscreen" })
          },
        },
        {
          id: "gvozd.leases",
          title: "Gvozd file leases",
          group: "Gvozd",
          palette: true,
          slash: { name: "gvozd-leases" },
          run: () => {
            context.ui.panel.open("gvozd.leases", { presentation: "fullscreen" })
          },
        },
        {
          id: "gvozd.mode",
          title: "Gvozd permission mode",
          group: "Gvozd",
          palette: true,
          slash: { name: "gvozd-mode" },
          run: () => {
            context.ui.panel.open("gvozd.mode", { presentation: "fullscreen" })
          },
        },
      ],
    }))
    return () => {
      unregisterSidebar()
      unregisterFooter()
      unregisterPanelSlot()
    }
  },
})

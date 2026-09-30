import { createResource, For, Show } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  EMPTY_INSIGHTS,
  getSessionState,
  relativeTime,
  themeColor,
  useSessionInsights,
  type SessionInsights,
} from "./insights"
import { formatFooterStatus, topTools } from "./session-tools"
import { sessionPermissionStatus } from "./permission-panel"
import { TeamActionTrigger } from "./team-action-trigger"
import { PACKAGE_VERSION } from "../core/release-metadata"
import {
  openNativeControl,
  openNativeControlForCurrentSession,
  type NativeControlSection,
} from "./native-control"

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

function TeamSection(props: { sessionID: string }) {
  const context = usePlugin()
  const insights = useSessionInsights(() => props.sessionID)
  const current = () => insights.latest ?? EMPTY_INSIGHTS
  const [sessionState] = createResource(() => props.sessionID, (id) => getSessionState(context, id))
  const statusLine = () => {
    const state = sessionState()
    if (!state) return "mode: …"
    return sessionPermissionStatus(state.mode, state.overrides)
  }
  const pending = () => current().permissions.filter((entry) => entry.pending)
  const running = () => current().tree.filter((node) => !node.isRoot && node.status === "running")
  return (
    <TeamActionTrigger onAction={() => void openNativeControl(context, props.sessionID)}>
      <box flexDirection="row">
        <text fg={themeColor(context.theme, ["text", "muted"])}>{`gvozd v${PACKAGE_VERSION}`}</text>
        <text fg={themeColor(context.theme, ["status", "success"])}>  NATIVE</text>
      </box>
      <text fg={themeColor(context.theme, ["text", "muted"])}>controls load on demand · /gvozd</text>
      <text fg={themeColor(context.theme, ["text", "default"])}>{statusLine()}</text>
      <Show
        when={pending().length > 0}
        fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>no pending approvals</text>}
      >
        <For each={pending().slice(0, 4)}>
          {(entry) => (
            <text fg={themeColor(context.theme, ["text", "default"])}>
              {`⏳ ${entry.action} | ${entry.resource}${entry.extraResources > 0 ? ` +${entry.extraResources}` : ""}`}
            </text>
          )}
        </For>
        <Show when={pending().length > 4}>
          <text fg={themeColor(context.theme, ["text", "muted"])}>{`… +${pending().length - 4} more`}</text>
        </Show>
      </Show>
      <Show
        when={running().length > 0}
        fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>no running subagents</text>}
      >
        <For each={running().slice(0, 4)}>
          {(node) => (
            <text fg={themeColor(context.theme, ["status", "success"])}>
              {`● ${node.agent ?? "?"}${node.model ? ` ${node.model.split("/").pop()}` : ""}`}
            </text>
          )}
        </For>
        <Show when={running().length > 4}>
          <text fg={themeColor(context.theme, ["text", "muted"])}>{`… +${running().length - 4} more`}</text>
        </Show>
      </Show>
      <box border borderColor={themeColor(context.theme, ["text", "muted"])} paddingX={1} marginTop={1}>
        <text fg={themeColor(context.theme, ["text", "default"])}>[ Open Gvozd menu ]</text>
      </box>
    </TeamActionTrigger>
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

interface GvozdCommand {
  readonly id: string
  readonly title: string
  readonly slash: string
  readonly section?: NativeControlSection
}

const GVOZD_COMMANDS: readonly GvozdCommand[] = [
  { id: "gvozd.control", title: "Gvozd menu", slash: "gvozd" },
  { id: "gvozd.dryrun", title: "Gvozd permission dry-run", slash: "gvozd-dryrun", section: "dryrun" },
  { id: "gvozd.leases", title: "Gvozd file leases", slash: "gvozd-leases", section: "leases" },
  { id: "gvozd.mode", title: "Gvozd permission mode", slash: "gvozd-mode", section: "mode" },
  { id: "gvozd.perms", title: "Gvozd session permissions", slash: "gvozd-perms", section: "permissions" },
  { id: "gvozd.allowall", title: "Gvozd allow all", slash: "gvozd-allowall", section: "allowall" },
  { id: "gvozd.goal", title: "Gvozd goal", slash: "gvozd-goal", section: "goal" },
]

function KeymapCommands() {
  const context = usePlugin()
  context.keymap.layer(() => ({
    mode: "global",
    commands: GVOZD_COMMANDS.map((command) => ({
      id: command.id,
      title: command.title,
      group: "Gvozd",
      palette: true,
      slash: { name: command.slash },
      run: () => openNativeControlForCurrentSession(context, command.section),
    })),
  }))
  return null
}

function AgentTeamSlot(props: { sessionID: string }) {
  return <TeamSection sessionID={props.sessionID} />
}

export default Plugin.define({
  id: "agent-gvozd",
  setup(context) {
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <SessionInsightsSlot sessionID={sessionID} />,
    })
    const unregisterTeam = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <AgentTeamSlot sessionID={sessionID} />,
    })
    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => (sessionID ? <FooterStatusSlot sessionID={sessionID} /> : null),
    })
    const unregisterKeymapHost = context.ui.slot({
      append: "app",
      render: () => <KeymapCommands />,
    })
    return () => {
      unregisterSidebar()
      unregisterTeam()
      unregisterFooter()
      unregisterKeymapHost()
    }
  },
})

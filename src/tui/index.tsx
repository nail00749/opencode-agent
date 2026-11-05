import { Show } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { EMPTY_INSIGHTS, themeColor, useSessionInsights } from "./insights"
import { formatFooterStatus, knownSessionCost } from "./session-tools"
import { openNativeControlForCurrentSession, type NativeControlSection } from "./native-control"
import { GroupedSidebar } from "./sidebar"

function FooterStatusSlot(props: { sessionID: string }) {
  const insights = useSessionInsights(() => props.sessionID)
  const current = () => insights.latest ?? EMPTY_INSIGHTS
  const context = usePlugin()
  const running = () => current().tree.filter((node) => !node.isRoot && node.status === "running").length
  const pending = () => current().permissions.filter((entry) => entry.pending).length
  const cost = () => knownSessionCost(current().tree) ?? 0
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

export default Plugin.define({
  id: "agent-gvozd",
  setup(context) {
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <GroupedSidebar sessionID={sessionID} />,
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
      unregisterFooter()
      unregisterKeymapHost()
    }
  },
})

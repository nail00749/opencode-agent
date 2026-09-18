import { For, Show, createResource, createSignal, onMount } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  EMPTY_INSIGHTS,
  evaluatePermissions,
  getSessionState,
  listLeases,
  relativeTime,
  setSessionOverrides,
  setTrustMode,
  themeColor,
  useSessionInsights,
  type SessionInsights,
} from "./insights"
import type { LeaseListOutput } from "../rpc/permissions-rpc"
import { GvozdRoster, type RosterListOutput } from "../rpc/roster-rpc"
import { GvozdConfig, type ConfigGetOutput, type ConfigPatchOutput } from "../rpc/config-rpc"
import { formatFooterStatus, topTools } from "./session-tools"
import { splitCommandPipeline } from "./command-pipeline"
import { sortAgentRoster, type AgentRosterEntry } from "./agent-roster"
import { cycleSessionPermissionEffect, type SessionPermissionAction, type SessionPermissionOverrides } from "../core/session-permissions"
import { nextOverrides, sessionPermissionStatus, summarizeOverrides, toggleRows } from "./permission-panel"
import type { TrustMode } from "../rpc/trusted-mode"
import { callNoPayloadRpc, retryRpc } from "./rpc-client"
import { TeamActionTrigger } from "./team-action-trigger"
import { PanelFrame } from "./panel-frame"
import { PACKAGE_VERSION } from "../core/release-metadata"

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

const ROSTER_LIMIT = 12

/** Actions available from the interactive team section. */
type TeamAction = "shell-allow" | "shell-inherit" | "insights" | "leases" | "mode" | "perms" | "dryrun" | "escalation-ask" | "escalation-deny"

const TEAM_COMMANDS: readonly { readonly action: TeamAction; readonly panel?: string; readonly title: string }[] = [
  { action: "shell-allow", title: "Allow ordinary shell for this session family" },
  { action: "shell-inherit", title: "Reset family shell to agent policy" },
  { action: "insights", panel: "gvozd.insights", title: "Open session insights" },
  { action: "leases", panel: "gvozd.leases", title: "Open file leases" },
  { action: "mode", panel: "gvozd.mode", title: "Switch permission mode…" },
  { action: "perms", panel: "gvozd.perms", title: "Toggle session permissions…" },
  { action: "dryrun", panel: "gvozd.dryrun", title: "Dry-run a permission…" },
  { action: "escalation-ask", title: "Persist shell escalation: ask (default)…" },
  { action: "escalation-deny", title: "Persist shell escalation: deny…" },
]

interface SessionPermissionState {
  readonly mode: TrustMode
  readonly overrides: SessionPermissionOverrides
}

function TeamSection(props: {
  sessionID: string
  roster: RosterListOutput["entries"]
  rosterLoading: boolean
  permissionState?: SessionPermissionState
  permissionLoading: boolean
  onPermissionState: (state: SessionPermissionState) => void
}) {
  const context = usePlugin()
  const shown = () => sortAgentRoster(props.roster.map((entry) => ({ ...entry, disabled: entry.disabled }))).slice(0, ROSTER_LIMIT)
  const openPanel = (panel: string) => {
    context.ui.panel.open(panel, { presentation: "fullscreen" })
  }
  const pickAction = () => {
    void context.ui.dialog
      .select<string>({
        title: "Team actions",
        options: TEAM_COMMANDS.map((command) => ({ title: command.title, value: command.action })),
      })
      .then(async (action) => {
        if (!action) return
        const command = TEAM_COMMANDS.find((entry) => entry.action === action)
        if (command?.panel) {
          openPanel(command.panel)
          return
        }
        if (action === "shell-allow" || action === "shell-inherit") {
          const current = props.permissionState ?? await getSessionState(props.sessionID)
          if (!current) {
            context.ui.toast.show({ message: "Could not read session permissions", variant: "error" })
            return
          }
          const effect = action === "shell-allow" ? "allow" : "inherit"
          const next = nextOverrides(current.overrides, "shell", effect)
          const saved = await setSessionOverrides(props.sessionID, next)
          if (!saved) {
            context.ui.toast.show({ message: "Could not update shell permission", variant: "error" })
            return
          }
          props.onPermissionState({ mode: current.mode, overrides: saved })
          context.ui.toast.show({
            message: effect === "allow"
              ? "Shell allowed for this session family; lease shell prompts are bypassed, destructive Git remains denied"
              : "This session family now follows the shell agent policy",
            variant: "success",
          })
          return
        }
        if (action === "escalation-ask" || action === "escalation-deny") {
          const escalation = action === "escalation-ask" ? "ask" : "deny"
          const failure = await patchShellEscalation(escalation)
          if (failure) console.error("gvozd tui: shell escalation patch failed", failure)
        }
      })
  }
  return (
    <TeamActionTrigger onAction={pickAction}>
      <box flexDirection="row">
        <text fg={themeColor(context.theme, ["text", "muted"])}>{`gvozd v${PACKAGE_VERSION}`}</text>
        <text fg={themeColor(context.theme, ["text", "muted"])}>{` (click for actions)`}</text>
      </box>
      <Show
        when={props.permissionState}
        fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>{props.permissionLoading ? "permissions connecting…" : "permissions unavailable"}</text>}
      >
        {(state) => (
          <text fg={state().overrides.shell === "allow" || (state().mode === "trusted" && !state().overrides.shell)
            ? themeColor(context.theme, ["status", "success"])
            : themeColor(context.theme, ["text", "default"])}>
            {sessionPermissionStatus(state().mode, state().overrides)}
          </text>
        )}
      </Show>
      <Show when={props.roster.length > 0} fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>{props.rosterLoading ? "team roster connecting…" : "team roster unavailable"}</text>}>
        <For each={shown()}>
          {(entry) => (
            <Show
              when={!entry.disabled}
              fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>{`✗ ${entry.id} (disabled)`}</text>}
            >
              <text fg={themeColor(context.theme, ["text", "default"])}>
                {`${entry.primary ? "●" : "▸"} ${entry.id} ${entry.model ? `· ${entry.model.split("/").pop()}` : ""}`}
              </text>
            </Show>
          )}
        </For>
        <Show when={props.roster.length > ROSTER_LIMIT}>
          <text fg={themeColor(context.theme, ["text", "muted"])}>{`… +${props.roster.length - ROSTER_LIMIT} more`}</text>
        </Show>
      </Show>
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

/** Dry-run panel state: one evaluated command row. */
interface DryRunRow {
  readonly command: string
  readonly effect: "allow" | "ask" | "deny" | "unknown"
  readonly matchedRule: string | null
}

function DryRunPanel() {
  const context = usePlugin()
  const [input, setInput] = createSignal("")
  const [agent] = createSignal("master")
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
          when={(snapshot()?.leases.length ?? 0) > 0}
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

function FullscreenPanel(props: { sessionID: string }) {
  const context = usePlugin()
  const insights = useSessionInsights(() => props.sessionID)
  const current = () => insights.latest ?? EMPTY_INSIGHTS
  return (
    <box flexDirection="column" padding={1}>
      <text fg={themeColor(context.theme, ["text", "default"])}>gvozd session insights</text>
      <box flexDirection="column">
        <SubagentsSection insights={current()} />
        <SkillsSection insights={current()} />
        <PermissionsSection insights={current()} />
        <ToolsSection insights={current()} />
      </box>
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

function ModePanel(props: { sessionID: string }) {
  const context = usePlugin()
  const [applied, setApplied] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)

  const apply = async (mode: "balanced" | "trusted" | "strict") => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await setTrustMode(props.sessionID, mode)
      if (result) setApplied(result.mode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <box flexDirection="column" padding={1}>
      <text fg={themeColor(context.theme, ["text", "default"])}>gvozd permission mode</text>
      <box flexDirection="column">
        <text fg={themeColor(context.theme, ["text", "default"])}>{busy() ? "applying…" : "select a posture (enter to apply):"}</text>
        <select
          options={(["balanced", "trusted", "strict"] as const).map((mode) => ({
            name: `▸ ${mode}: ${MODE_HINTS[mode]}`,
            description: "",
            value: mode,
          }))}
          onSelect={(index) => {
            const modes = ["balanced", "trusted", "strict"] as const
            const mode = modes[index]
            if (mode) void apply(mode)
          }}
        />
        <Show when={applied()}>
          <text fg={themeColor(context.theme, ["status", "success"])}>{`applied to this session: ${applied()}`}</text>
        </Show>
      </box>
    </box>
  )
}

const MODE_HINTS: Record<"balanced" | "trusted" | "strict", string> = {
  balanced: "ask for unknown shell and edits (current default)",
  trusted: "allow all shell and edits; destructive git still denied",
  strict: "ask for every shell command and edit",
}

/**
 * Session permission toggles. Each row reads as a checkbox: `[ ]` inherits the
 * agent policy, `[x]` is overridden. Selecting a row advances it through
 * inherit -> allow -> ask -> deny -> inherit and pushes the whole map to the
 * server-side `gvozd-mode` RPC, which applies it in the evaluate hook.
 *
 * Session-only by construction: nothing here is written to disk, so the change
 * disappears with the session and can never alter the managed config.
 */
function PermissionTogglePanel(props: { sessionID: string }) {
  const context = usePlugin()
  const [overrides, setOverrides] = createSignal<SessionPermissionOverrides>({})
  const [mode, setMode] = createSignal<string>("balanced")
  const [status, setStatus] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)

  void onMount(async () => {
    const state = await getSessionState(props.sessionID)
    if (!state) return
    setOverrides(state.overrides)
    setMode(state.mode)
  })

  const rows = () => toggleRows(overrides())

  const cycle = async (action: SessionPermissionAction) => {
    if (busy()) return
    setBusy(true)
    const current = overrides()[action] ?? "inherit"
    const effect = cycleSessionPermissionEffect(current)
    const next = nextOverrides(overrides(), action, effect)
    try {
      const saved = await setSessionOverrides(props.sessionID, next)
      if (!saved) {
        setStatus("failed to save override")
        return
      }
      setOverrides(saved)
      setStatus(`${action} = ${effect}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <box flexDirection="column" padding={1}>
      <text fg={themeColor(context.theme, ["text", "default"])}>gvozd session permissions</text>
      <box flexDirection="column">
        <text fg={themeColor(context.theme, ["text", "muted"])}>{`session-only — nothing is written to your config. posture: ${mode()}`}</text>
        <text fg={themeColor(context.theme, ["text", "muted"])}>{`active overrides: ${summarizeOverrides(overrides())}`}</text>
        <text fg={themeColor(context.theme, ["text", "default"])}>{busy() ? "applying…" : "select a row to cycle its value:"}</text>
        <select
          options={rows().map((row) => ({ name: row.display, description: "", value: row.action }))}
          onSelect={(index) => {
            const row = rows()[index]
            if (row) void cycle(row.action)
          }}
        />
        <text fg={themeColor(context.theme, ["text", "muted"])}>[ ] inherit · [x] overridden · shell grant covers descendants and bypasses lease prompts; destructive commands stay denied</text>
        <Show when={status()}>
          <text fg={themeColor(context.theme, ["status", "success"])}>{status()}</text>
        </Show>
      </box>
    </box>
  )
}

function KeymapCommands() {
  const context = usePlugin()
  // Register the keymap layer while rendering inside the host tree: setup()
  // runs outside the KeymapProvider scope, so layers registered there crash
  // the TUI with "Keymap not found. Wrap the tree in <KeymapProvider>."
  context.keymap.layer(() => ({
    mode: "global",
    commands: GVOZD_COMMANDS.map((command) => ({
      id: command.id,
      title: command.title,
      group: "Gvozd",
      palette: true,
      slash: { name: command.slash },
      run: () => {
        context.ui.panel.open(command.panel, { presentation: "fullscreen" })
      },
    })),
  }))
  return null
}

interface GvozdCommand {
  readonly id: string
  readonly title: string
  readonly panel: string
  readonly slash: string
}

const GVOZD_COMMANDS: readonly GvozdCommand[] = [
  { id: "gvozd.insights", title: "Gvozd session insights", panel: "gvozd.insights", slash: "gvozd" },
  { id: "gvozd.dryrun", title: "Gvozd permission dry-run", panel: "gvozd.dryrun", slash: "gvozd-dryrun" },
  { id: "gvozd.leases", title: "Gvozd file leases", panel: "gvozd.leases", slash: "gvozd-leases" },
  { id: "gvozd.mode", title: "Gvozd permission mode", panel: "gvozd.mode", slash: "gvozd-mode" },
  { id: "gvozd.perms", title: "Gvozd session permission toggles", panel: "gvozd.perms", slash: "gvozd-perms" },
]

function AgentTeamSlot(props: { sessionID: string }) {
  const context = usePlugin()
  const [roster] = createResource(
    async () => {
      try {
        const rpc = (context.client as unknown as {
          rpc: (definition: unknown) => { list: (input: Record<string, never>) => Promise<RosterListOutput> }
        }).rpc(GvozdRoster)
        return await retryRpc(() => callNoPayloadRpc(rpc.list)) ?? { entries: [] as AgentRosterEntry[] }
      } catch (error) {
        console.error("gvozd tui: roster list failed", error)
        return { entries: [] as AgentRosterEntry[] }
      }
    },
    { initialValue: { entries: [] } },
  )
  const [permissionState, { mutate: setPermissionState }] = createResource(
    () => props.sessionID,
    async (sessionID) => getSessionState(sessionID),
  )
  return (
    <TeamSection
      sessionID={props.sessionID}
      roster={roster().entries}
      rosterLoading={roster.loading}
      permissionState={permissionState()}
      permissionLoading={permissionState.loading}
      onPermissionState={(state) => setPermissionState(state)}
    />
  )
}

/**
 * Persists `lease.shellEscalation` to the managed global config through the
 * server-side `gvozd-config` RPC. Returns the failure message on error so the
 * caller can surface it; `undefined` on success.
 */
async function patchShellEscalation(escalation: "ask" | "deny"): Promise<string | undefined> {
  const context = usePlugin()
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        get: (input: Record<string, never>) => Promise<ConfigGetOutput>
        patch: (input: { lease: { shellEscalation: "ask" | "deny" } }) => Promise<ConfigPatchOutput>
      }
    }).rpc(GvozdConfig)
    await rpc.patch({ lease: { shellEscalation: escalation } })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
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
    const unregisterPanelSlot = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <>
          <Show when={panel.name === "gvozd.insights"}>
            <PanelFrame panel={panel}><FullscreenPanel sessionID={panel.sessionID} /></PanelFrame>
          </Show>
          <Show when={panel.name === "gvozd.dryrun"}>
            <PanelFrame panel={panel}><DryRunPanel /></PanelFrame>
          </Show>
          <Show when={panel.name === "gvozd.leases"}>
            <PanelFrame panel={panel}><LeasePanel /></PanelFrame>
          </Show>
          <Show when={panel.name === "gvozd.mode"}>
            <PanelFrame panel={panel}><ModePanel sessionID={panel.sessionID} /></PanelFrame>
          </Show>
          <Show when={panel.name === "gvozd.perms"}>
            <PanelFrame panel={panel}><PermissionTogglePanel sessionID={panel.sessionID} /></PanelFrame>
          </Show>
        </>
      ),
    })
    return () => {
      unregisterSidebar()
      unregisterTeam()
      unregisterFooter()
      unregisterPanelSlot()
      unregisterKeymapHost()
    }
  },
})

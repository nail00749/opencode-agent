import { For, Show, createResource, createSignal, onMount } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
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
import { collectAgentRoster, sortAgentRoster, type AgentRosterEntry } from "./agent-roster"
import { type SessionPermissionAction, type SessionPermissionEffect, type SessionPermissionOverrides } from "../core/session-permissions"
import { nextOverrides, sessionPermissionStatus, toggleRows } from "./permission-panel"
import type { TrustMode } from "../rpc/trusted-mode"
import { retryRpc } from "./rpc-client"
import { TeamActionTrigger } from "./team-action-trigger"
import { PanelFrame } from "./panel-frame"
import { PACKAGE_VERSION } from "../core/release-metadata"
import { ALL_AGENT_IDS } from "../core/constants"

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

const ROSTER_LIMIT = 5

interface SessionPermissionState {
  readonly mode: TrustMode
  readonly overrides: SessionPermissionOverrides
}

function localRoster(context: Context): AgentRosterEntry[] {
  return collectAgentRoster(context.data.location.agent.list(context.location), ALL_AGENT_IDS)
}

async function fetchRoster(context: Context, fallback: AgentRosterEntry[]): Promise<RosterListOutput> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        list: (input: Record<string, never>, options?: { signal?: AbortSignal }) => Promise<RosterListOutput>
      }
    }).rpc(GvozdRoster)
    return await retryRpc((signal) => rpc.list({}, { signal })) ?? { entries: fallback }
  } catch (error) {
    console.error("gvozd tui: roster list failed", error)
    return { entries: fallback }
  }
}

function useTeamState(sessionID: () => string) {
  const context = usePlugin()
  const fallback = localRoster(context)
  const [roster, { refetch: refreshRoster }] = createResource(
    () => sessionID(),
    async () => fetchRoster(context, fallback),
    { initialValue: { entries: fallback } },
  )
  const [permission, { mutate: setPermission, refetch: refreshPermission }] = createResource(
    () => sessionID(),
    async (id) => getSessionState(context, id),
  )
  return {
    context,
    roster,
    permission,
    setPermission,
    refresh: () => {
      void refreshRoster()
      void refreshPermission()
    },
  }
}

function TeamSection(props: {
  roster: RosterListOutput["entries"]
  permissionState?: SessionPermissionState
  permissionLoading: boolean
}) {
  const context = usePlugin()
  const shown = () => sortAgentRoster(props.roster.map((entry) => ({ ...entry, disabled: entry.disabled }))).slice(0, 5)
  const openControlCenter = () => context.ui.panel.open("gvozd.control", { presentation: "fullscreen" })
  const connection = () => props.permissionLoading ? "CHECKING" : props.permissionState ? "READY" : "DEGRADED"
  const connectionColor = () => props.permissionState
    ? themeColor(context.theme, ["status", "success"])
    : props.permissionLoading
      ? themeColor(context.theme, ["text", "muted"])
      : themeColor(context.theme, ["status", "warning"])
  return (
    <TeamActionTrigger onAction={openControlCenter}>
      <box flexDirection="row">
        <text fg={themeColor(context.theme, ["text", "muted"])}>{`gvozd v${PACKAGE_VERSION}`}</text>
        <text fg={connectionColor()}>{`  ${connection()}`}</text>
      </box>
      <Show
        when={props.permissionState}
        fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>{props.permissionLoading ? "permissions: checking (bounded)" : "permissions: unavailable — open to retry"}</text>}
      >
        {(state) => (
          <text fg={state().overrides.shell === "allow" || (state().mode === "trusted" && !state().overrides.shell)
            ? themeColor(context.theme, ["status", "success"])
            : themeColor(context.theme, ["text", "default"])}>
            {sessionPermissionStatus(state().mode, state().overrides)}
          </text>
        )}
      </Show>
      <Show when={props.roster.length > 0} fallback={<text fg={themeColor(context.theme, ["text", "muted"])}>team roster unavailable</text>}>
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
      <box border borderColor={themeColor(context.theme, ["text", "muted"])} paddingX={1} marginTop={1}>
        <text fg={themeColor(context.theme, ["text", "default"])}>[ Open control center ]</text>
      </box>
    </TeamActionTrigger>
  )
}

const PERMISSION_EFFECTS: readonly SessionPermissionEffect[] = ["inherit", "allow", "ask", "deny"]

function ControlButton(props: {
  label: string
  active?: boolean
  disabled?: boolean
  onAction: () => void
}) {
  const context = usePlugin()
  const color = () => props.disabled
    ? themeColor(context.theme, ["text", "muted"])
    : props.active
      ? themeColor(context.theme, ["status", "success"])
      : themeColor(context.theme, ["text", "default"])
  return (
    <TeamActionTrigger onAction={() => { if (!props.disabled) props.onAction() }}>
      <box
        border
        borderColor={color()}
        focusedBorderColor={themeColor(context.theme, ["status", "success"])}
        paddingX={1}
      >
        <text fg={color()}>{`${props.active ? "* " : ""}${props.label}`}</text>
      </box>
    </TeamActionTrigger>
  )
}

export function PermissionControls(props: {
  state: SessionPermissionState
  busy: boolean
  onEffect: (action: SessionPermissionAction, effect: SessionPermissionEffect) => void
}) {
  const context = usePlugin()
  const rows = () => toggleRows(props.state.overrides, props.state.mode)
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={themeColor(context.theme, ["text", "muted"])}>CURRENT PERMISSIONS</text>
      <For each={rows()}>
        {(row) => (
          <box flexDirection="column" marginBottom={1}>
            <text fg={themeColor(context.theme, ["text", "default"])}>
              {`${row.action.padEnd(5)} ${row.effective.toUpperCase()}  <- ${row.source}`}
            </text>
            <box flexDirection="row" gap={1}>
              <For each={PERMISSION_EFFECTS}>
                {(effect) => (
                  <ControlButton
                    label={effect}
                    active={row.effect === effect}
                    disabled={props.busy}
                    onAction={() => props.onEffect(row.action, effect)}
                  />
                )}
              </For>
            </box>
          </box>
        )}
      </For>
      <text fg={themeColor(context.theme, ["text", "muted"])}>
        shell overrides apply to the session family; destructive shell stays denied
      </text>
    </box>
  )
}

function ControlCenterPanel(props: { panel: PanelInput }) {
  const team = useTeamState(() => props.panel.sessionID)
  const context = team.context
  const [leases, { refetch: refreshLeases }] = createResource(
    () => props.panel.sessionID,
    async () => listLeases(context),
  )
  const [config, { refetch: refreshConfig }] = createResource(async () => getGvozdConfig(context))
  const [busy, setBusy] = createSignal(false)

  const refreshing = () => team.roster.loading || team.permission.loading || leases.loading || config.loading
  const healthy = () => Boolean(team.permission() && leases() && config())
  const health = () => refreshing() ? "REFRESHING" : healthy() ? "READY" : "DEGRADED"
  const healthColor = () => healthy()
    ? themeColor(context.theme, ["status", "success"])
    : refreshing()
      ? themeColor(context.theme, ["text", "muted"])
      : themeColor(context.theme, ["status", "warning"])
  const sortedRoster = () => sortAgentRoster(team.roster().entries)

  const refresh = () => {
    team.refresh()
    void refreshLeases()
    void refreshConfig()
  }
  const applyEffect = async (action: SessionPermissionAction, effect: SessionPermissionEffect) => {
    const current = team.permission()
    if (!current || busy()) return
    setBusy(true)
    try {
      const saved = await setSessionOverrides(context, props.panel.sessionID, nextOverrides(current.overrides, action, effect))
      if (!saved) {
        context.ui.toast.show({ title: "Gvozd permissions", message: "Update failed; press Refresh and try again", variant: "error" })
        return
      }
      team.setPermission({ mode: current.mode, overrides: saved })
      context.ui.toast.show({ title: "Gvozd permissions", message: `${action} now ${effect}`, variant: "success" })
    } finally {
      setBusy(false)
    }
  }
  const applyMode = async (mode: TrustMode) => {
    const current = team.permission()
    if (!current || busy()) return
    setBusy(true)
    try {
      const saved = await setTrustMode(context, props.panel.sessionID, mode)
      if (!saved) {
        context.ui.toast.show({ title: "Gvozd mode", message: "Mode update failed", variant: "error" })
        return
      }
      team.setPermission({ mode, overrides: current.overrides })
    } finally {
      setBusy(false)
    }
  }
  const applyEscalation = async (value: "ask" | "deny") => {
    if (busy()) return
    setBusy(true)
    try {
      const failure = await patchShellEscalation(context, value)
      if (failure) {
        context.ui.toast.show({ title: "Gvozd lease policy", message: failure, variant: "error" })
        return
      }
      void refreshConfig()
    } finally {
      setBusy(false)
    }
  }
  const openPanel = (name: string) => context.ui.panel.open(name, { presentation: "fullscreen" })

  return (
    <scrollbox flexDirection="column" width="100%" height="100%" padding={1} focused={props.panel.focused}>
      <box flexDirection="row" gap={2}>
        <text fg={themeColor(context.theme, ["text", "default"])}>GVOZD CONTROL CENTER</text>
        <text fg={healthColor()}>{health()}</text>
        <ControlButton label="Refresh" disabled={refreshing()} onAction={refresh} />
      </box>
      <text fg={themeColor(context.theme, ["text", "muted"])}>{`session: ${props.panel.sessionID}`}</text>

      <Show
        when={team.permission()}
        fallback={(
          <box flexDirection="column" marginTop={1}>
            <text fg={themeColor(context.theme, ["status", "warning"])}>
              {team.permission.loading ? "permissions: checking (timeout protected)" : "permissions: unavailable"}
            </text>
            <text fg={themeColor(context.theme, ["text", "muted"])}>Use Refresh; controls stay disabled until state is known.</text>
          </box>
        )}
      >
        {(state) => (
          <>
            <box flexDirection="column" marginTop={1}>
              <text fg={themeColor(context.theme, ["text", "muted"])}>SESSION MODE</text>
              <box flexDirection="row" gap={1}>
                <For each={["balanced", "trusted", "strict"] as const}>
                  {(mode) => (
                    <ControlButton
                      label={mode}
                      active={state().mode === mode}
                      disabled={busy()}
                      onAction={() => void applyMode(mode)}
                    />
                  )}
                </For>
              </box>
            </box>
            <PermissionControls state={state()} busy={busy()} onEffect={(action, effect) => void applyEffect(action, effect)} />
          </>
        )}
      </Show>

      <box flexDirection="column" marginTop={1}>
        <text fg={themeColor(context.theme, ["text", "muted"])}>LEASE POLICY</text>
        <text fg={themeColor(context.theme, ["text", "default"])}>
          {`active leases: ${leases()?.leases.length ?? "unknown"} | blocked shell: ${config()?.lease.shellEscalation ?? "unknown"}`}
        </text>
        <box flexDirection="row" gap={1}>
          <ControlButton label="ask" active={config()?.lease.shellEscalation === "ask"} disabled={busy()} onAction={() => void applyEscalation("ask")} />
          <ControlButton label="deny" active={config()?.lease.shellEscalation === "deny"} disabled={busy()} onAction={() => void applyEscalation("deny")} />
          <ControlButton label="Open leases" onAction={() => openPanel("gvozd.leases")} />
        </box>
      </box>

      <box flexDirection="column" marginTop={1}>
        <text fg={themeColor(context.theme, ["text", "muted"])}>{`TEAM ROSTER (${sortedRoster().filter((entry) => !entry.disabled).length} enabled)`}</text>
        <For each={sortedRoster()}>
          {(entry) => (
            <text fg={entry.disabled ? themeColor(context.theme, ["text", "muted"]) : themeColor(context.theme, ["text", "default"])}>
              {`${entry.disabled ? "x" : entry.primary ? "*" : ">"} ${entry.id.padEnd(16)} ${entry.model?.split("/").pop() ?? "disabled"}`}
            </text>
          )}
        </For>
      </box>

      <box flexDirection="row" gap={1} marginTop={1}>
        <ControlButton label="Insights" onAction={() => openPanel("gvozd.insights")} />
        <ControlButton label="Permission dry-run" onAction={() => openPanel("gvozd.dryrun")} />
      </box>
    </scrollbox>
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
      const output = await evaluatePermissions(context, agent(), [{ action: "shell", resources: segments }])
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
      setSnapshot(await listLeases(context))
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
  { id: "gvozd.control", title: "Gvozd control center", panel: "gvozd.control", slash: "gvozd" },
  { id: "gvozd.dryrun", title: "Gvozd permission dry-run", panel: "gvozd.dryrun", slash: "gvozd-dryrun" },
  { id: "gvozd.leases", title: "Gvozd file leases", panel: "gvozd.leases", slash: "gvozd-leases" },
  { id: "gvozd.mode", title: "Gvozd permission mode", panel: "gvozd.control", slash: "gvozd-mode" },
  { id: "gvozd.perms", title: "Gvozd session permissions", panel: "gvozd.control", slash: "gvozd-perms" },
]

function AgentTeamSlot(props: { sessionID: string }) {
  const team = useTeamState(() => props.sessionID)
  return (
    <TeamSection
      roster={team.roster().entries}
      permissionState={team.permission()}
      permissionLoading={team.permission.loading}
    />
  )
}

/** Reads the resolved server-side Gvozd configuration for the status panel. */
async function getGvozdConfig(context: Context): Promise<ConfigGetOutput | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        get: (input: Record<string, never>, options?: { signal?: AbortSignal }) => Promise<ConfigGetOutput>
      }
    }).rpc(GvozdConfig)
    return await retryRpc((signal) => rpc.get({}, { signal }))
  } catch (error) {
    console.error("gvozd tui: config read failed", error)
    return undefined
  }
}

async function patchShellEscalation(context: Context, escalation: "ask" | "deny"): Promise<string | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        patch: (
          input: { lease: { shellEscalation: "ask" | "deny" } },
          options?: { signal?: AbortSignal },
        ) => Promise<ConfigPatchOutput>
      }
    }).rpc(GvozdConfig)
    const result = await retryRpc((signal) => rpc.patch({ lease: { shellEscalation: escalation } }, { signal }), { attempts: 1 })
    if (!result) return "Gvozd config update returned no result"
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
          <Show when={panel.name === "gvozd.control"}>
            <PanelFrame panel={panel}><ControlCenterPanel panel={panel} /></PanelFrame>
          </Show>
          <Show when={panel.name === "gvozd.dryrun"}>
            <PanelFrame panel={panel}><DryRunPanel /></PanelFrame>
          </Show>
          <Show when={panel.name === "gvozd.leases"}>
            <PanelFrame panel={panel}><LeasePanel /></PanelFrame>
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

import type { Context } from "@opencode/plugin/tui/context"
import type { PermissionRequest } from "@opencode/client"
import { ALL_AGENT_IDS } from "../core/constants"
import {
  SESSION_PERMISSION_EFFECTS,
  type SessionPermissionAction,
  type SessionPermissionEffect,
  type SessionPermissionOverrides,
} from "../core/session-permissions"
import { PACKAGE_VERSION } from "../core/release-metadata"
import { GvozdConfig, type ConfigAgentPatch, type ConfigGetOutput, type ConfigPatchOutput } from "../rpc/config-rpc"
import type { LeaseListOutput, EvaluateOutput } from "../rpc/permissions-rpc"
import { GvozdGoal, type GoalStartOutput, type GoalStatusOutput, type GoalStopOutput } from "../rpc/goal-mode"
import { TRUST_MODES, type TrustMode } from "../rpc/trusted-mode"
import { collectAgentRoster, type AgentRosterEntry } from "./agent-roster"
import { splitCommandPipeline } from "./command-pipeline"
import {
  evaluatePermissions,
  getSessionState,
  listLeases,
  setSessionOverrides,
  setTrustMode,
} from "./insights"
import { allowAllOverrides, nextOverrides, resetAllOverrides, summarizeOverrides, toggleRows } from "./permission-panel"
import { allowAllOptions, allowAllTitle, pendingRequests, replyAllowAll, type AllowAllReply, type AllowAllResult } from "./permission-bulk"
import { retryRpc } from "./rpc-client"

export type NativeControlSection = "status" | "mode" | "permissions" | "allowall" | "leases" | "jev" | "agents" | "dryrun" | "goal"

interface SessionPermissionState {
  readonly mode: TrustMode
  readonly overrides: SessionPermissionOverrides
}

export interface NativeControlServices {
  getSessionState(context: Context, sessionID: string): Promise<SessionPermissionState | undefined>
  setTrustMode(context: Context, sessionID: string, mode: TrustMode): Promise<{ mode: string } | undefined>
  setSessionOverrides(
    context: Context,
    sessionID: string,
    overrides: SessionPermissionOverrides,
  ): Promise<SessionPermissionOverrides | undefined>
  listLeases(context: Context): Promise<LeaseListOutput | undefined>
  getConfig(context: Context): Promise<ConfigGetOutput | undefined>
  patchShellEscalation(context: Context, escalation: "ask" | "deny"): Promise<string | undefined>
  patchJevEnabled(context: Context, enabled: boolean): Promise<string | undefined>
  patchAgentDisabled(context: Context, id: string, disabled: boolean): Promise<string | undefined>
  evaluatePermissions(context: Context, agent: string, commands: readonly string[]): Promise<EvaluateOutput | undefined>
  startGoal(context: Context, sessionID: string, goalId?: string, measureCmd?: string, verifyCmd?: string): Promise<GoalStartOutput | undefined>
  getGoalStatus(context: Context, sessionID: string, goalId?: string): Promise<GoalStatusOutput | undefined>
  stopGoal(context: Context, sessionID: string, goalId?: string): Promise<GoalStopOutput | undefined>
  listPendingPermissions(context: Context, sessionID: string): readonly PermissionRequest[]
  replyAllowAll(
    context: Context,
    sessionID: string,
    pending: readonly PermissionRequest[],
    reply: AllowAllReply,
  ): Promise<AllowAllResult>
  roster(context: Context): AgentRosterEntry[]
}

async function getConfig(context: Context): Promise<ConfigGetOutput | undefined> {
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

async function patchConfig(
  context: Context,
  patch: { lease?: { shellEscalation: "ask" | "deny" }; jev?: { enabled: boolean }; agents?: readonly ConfigAgentPatch[] },
): Promise<string | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        patch: (
          input: typeof patch,
          options?: { signal?: AbortSignal },
        ) => Promise<ConfigPatchOutput>
      }
    }).rpc(GvozdConfig)
    const result = await retryRpc((signal) => rpc.patch(patch, { signal }), { attempts: 1 })
    if (!result) return "Gvozd config update returned no result"
    if (result.rejected.length > 0) return result.rejected.map((entry) => `${entry.path}: ${entry.reason}`).join("; ")
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Raises the family goal flag through the server-side gvozd-goal RPC.
 *
 * Provenance: `measureCmd`/`verifyCmd` come only from the user's start
 * prompts below — the agent never supplies them, so the recorded loop
 * commands cannot be steered from the agent side.
 */
async function startGoal(
  context: Context,
  sessionID: string,
  goalId?: string,
  measureCmd?: string,
  verifyCmd?: string,
): Promise<GoalStartOutput | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        start: (
          input: { sessionID: string; goalId?: string; measureCmd?: string; verifyCmd?: string },
          options?: { signal?: AbortSignal },
        ) => Promise<GoalStartOutput>
      }
    }).rpc(GvozdGoal)
    return await retryRpc((signal) => rpc.start({
      sessionID,
      ...(goalId !== undefined ? { goalId } : {}),
      ...(measureCmd !== undefined ? { measureCmd } : {}),
      ...(verifyCmd !== undefined ? { verifyCmd } : {}),
    }, { signal }), { attempts: 1 })
  } catch (error) {
    console.error("gvozd tui: goal start failed", error)
    return undefined
  }
}

/** Reads the family goal flag without mutating it. */
async function getGoalStatus(context: Context, sessionID: string, goalId?: string): Promise<GoalStatusOutput | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        status: (input: { sessionID: string; goalId?: string }, options?: { signal?: AbortSignal }) => Promise<GoalStatusOutput>
      }
    }).rpc(GvozdGoal)
    return await retryRpc((signal) => rpc.status({ sessionID, ...(goalId !== undefined ? { goalId } : {}) }, { signal }), { attempts: 1 })
  } catch (error) {
    console.error("gvozd tui: goal status read failed", error)
    return undefined
  }
}

/** Quenches the family goal grant; a manual stop always wins server-side. */
async function stopGoal(context: Context, sessionID: string, goalId?: string): Promise<GoalStopOutput | undefined> {
  try {
    const rpc = (context.client as unknown as {
      rpc: (definition: unknown) => {
        stop: (input: { sessionID: string; goalId?: string }, options?: { signal?: AbortSignal }) => Promise<GoalStopOutput>
      }
    }).rpc(GvozdGoal)
    return await retryRpc((signal) => rpc.stop({ sessionID, ...(goalId !== undefined ? { goalId } : {}) }, { signal }), { attempts: 1 })
  } catch (error) {
    console.error("gvozd tui: goal stop failed", error)
    return undefined
  }
}

export const nativeControlServices: NativeControlServices = {
  getSessionState,
  setTrustMode,
  setSessionOverrides,
  listLeases,
  getConfig,
  patchShellEscalation: (context, escalation) => patchConfig(context, { lease: { shellEscalation: escalation } }),
  patchJevEnabled: (context, enabled) => patchConfig(context, { jev: { enabled } }),
  // Agent toggles reuse the generic patch.agents[] contract: the payload
  // carries only the one agent's disabled flag, never models or full rows.
  patchAgentDisabled: (context, id, disabled) => patchConfig(context, { agents: [{ id, disabled }] }),
  evaluatePermissions: (context, agent, commands) => evaluatePermissions(context, agent, [{ action: "shell", resources: commands }]),
  startGoal,
  getGoalStatus,
  stopGoal,
  listPendingPermissions(context, sessionID) {
    return pendingRequests(context.data.session.permission.list(sessionID))
  },
  replyAllowAll(context, sessionID, pending, reply) {
    // Context types narrow permission to list/sync/invalidate; the host data
    // layer also exposes reply (see @opencode/client solid data contract).
    const permission = context.data.session.permission as unknown as {
      reply(input: { sessionID: string; requestID: string; reply: AllowAllReply }): Promise<void>
    }
    return replyAllowAll((input) => permission.reply(input), sessionID, pending, reply)
  },
  roster(context) {
    return collectAgentRoster(context.data.location.agent.list(context.location), ALL_AGENT_IDS)
  },
}

function unavailable(context: Context, section: string): Promise<void> {
  return context.ui.dialog.alert({
    title: `Gvozd ${section}`,
    message: "The server did not answer in time. Close this dialog and retry from /gvozd.",
  })
}

async function showStatus(context: Context, sessionID: string, services: NativeControlServices): Promise<void> {
  const [permission, leases, config] = await Promise.all([
    services.getSessionState(context, sessionID),
    services.listLeases(context),
    services.getConfig(context),
  ])
  const roster = services.roster(context)
  const enabled = roster.filter((entry) => !entry.disabled)
  const lines = [
    `Gvozd ${PACKAGE_VERSION}`,
    `Session: ${sessionID}`,
    `Mode: ${permission?.mode ?? "unavailable"}`,
    `Overrides: ${permission ? summarizeOverrides(permission.overrides) : "unavailable"}`,
    `Leases: ${leases?.leases.length ?? "unavailable"}`,
    `Blocked shell: ${config?.lease.shellEscalation ?? "unavailable"}`,
    `JEV: ${config ? config.jev.enabled ? "enabled" : "disabled" : "unavailable"}`,
    `Team: ${enabled.length}/${roster.length} enabled`,
  ]
  await context.ui.dialog.alert({ title: "Gvozd status", message: lines.join("\n") })
}

async function chooseMode(context: Context, sessionID: string, services: NativeControlServices): Promise<void> {
  const state = await services.getSessionState(context, sessionID)
  if (!state) return unavailable(context, "session mode")
  const selected = await context.ui.dialog.select<TrustMode>({
    title: "Gvozd session mode",
    current: state.mode,
    options: TRUST_MODES.map((mode) => ({
      title: mode,
      value: mode,
      description: mode === state.mode ? "current" : mode === "trusted" ? "allow routine shell and edits" : mode === "strict" ? "ask for shell and edits" : "use agent policy",
    })),
  })
  if (!selected || selected === state.mode) return
  const saved = await services.setTrustMode(context, sessionID, selected)
  if (!saved) return unavailable(context, "session mode")
  context.ui.toast.show({ title: "Gvozd mode", message: `Session mode is now ${selected}`, variant: "success" })
}

async function choosePermissions(context: Context, sessionID: string, services: NativeControlServices): Promise<void> {
  const state = await services.getSessionState(context, sessionID)
  if (!state) return unavailable(context, "permissions")
  const rows = toggleRows(state.overrides, state.mode)
  type PermissionChoice = SessionPermissionAction | "allow-all" | "reset-all"
  const action = await context.ui.dialog.select<PermissionChoice>({
    title: "Gvozd session permissions",
    options: [
      { title: "Allow all", value: "allow-all", description: "allow shell, edits, skills, and MCP without asking" },
      { title: "Reset all", value: "reset-all", description: "clear overrides, back to agent policy" },
      ...rows.map((row) => ({ title: row.label, value: row.action as PermissionChoice, description: `${row.effective} · ${row.source}` })),
    ],
  })
  if (!action) return
  if (action === "allow-all") {
    const overrides = allowAllOverrides()
    const saved = await services.setSessionOverrides(context, sessionID, overrides)
    if (!saved) return unavailable(context, "permissions")
    context.ui.toast.show({ title: "Gvozd permissions", message: `All permissions allowed (${summarizeOverrides(saved)})`, variant: "success" })
    return
  }
  if (action === "reset-all") {
    const overrides = resetAllOverrides()
    const saved = await services.setSessionOverrides(context, sessionID, overrides)
    if (!saved) return unavailable(context, "permissions")
    context.ui.toast.show({ title: "Gvozd permissions", message: "All permission overrides cleared (agent policy decides)", variant: "success" })
    return
  }
  const current = state.overrides[action] ?? "inherit"
  const effect = await context.ui.dialog.select<SessionPermissionEffect>({
    title: `Permission: ${action}`,
    current,
    options: SESSION_PERMISSION_EFFECTS.map((value) => ({
      title: value,
      value,
      description: value === "inherit" ? "use the mode and agent policy" : value === "allow" ? "allow without asking" : value === "ask" ? "ask for approval" : "block",
    })),
  })
  if (!effect || effect === current) return
  const overrides = nextOverrides(state.overrides, action, effect)
  const saved = await services.setSessionOverrides(context, sessionID, overrides)
  if (!saved) return unavailable(context, "permissions")
  context.ui.toast.show({ title: "Gvozd permissions", message: `${action} is now ${effect}`, variant: "success" })
}

async function chooseAllowAll(context: Context, sessionID: string, services: NativeControlServices): Promise<void> {
  const pending = services.listPendingPermissions(context, sessionID)
  if (pending.length === 0) {
    await context.ui.dialog.alert({ title: "Gvozd allow all", message: "No pending permission requests to approve." })
    return
  }
  const choice = await context.ui.dialog.select<AllowAllReply>({
    title: allowAllTitle(pending.length),
    options: allowAllOptions(pending.length),
  })
  if (!choice) return
  try {
    const { replied, failed } = await services.replyAllowAll(context, sessionID, pending, choice)
    if (failed > 0) {
      await context.ui.dialog.alert({
        title: "Gvozd allow all",
        message: `Approved ${replied}/${pending.length} request(s) (${choice}); ${failed} failed.`,
      })
      return
    }
    context.ui.toast.show({ title: "Gvozd allow all", message: `Approved ${replied}/${pending.length} request(s) (${choice})`, variant: "success" })
  } catch (error) {
    await context.ui.dialog.alert({ title: "Gvozd allow all", message: error instanceof Error ? error.message : String(error) })
  }
}

function leaseSummary(leases: LeaseListOutput): string {
  if (leases.leases.length === 0) return "No active or reserved file leases."
  const now = Date.now()
  return leases.leases.slice(0, 12).map((lease) => {
    const seconds = Math.max(0, Math.ceil((lease.expiresAt - now) / 1_000))
    return `${lease.state === "active" ? "ACTIVE" : "RESERVED"} · ${lease.agent} · ${lease.label} · ${lease.files.length} files · ${seconds}s`
  }).join("\n")
}

async function chooseLeases(context: Context, services: NativeControlServices): Promise<void> {
  const [leases, config] = await Promise.all([services.listLeases(context), services.getConfig(context)])
  if (!leases || !config) return unavailable(context, "leases")
  const choice = await context.ui.dialog.select<"details" | "ask" | "deny">({
    title: "Gvozd leases",
    current: config.lease.shellEscalation,
    options: [
      { title: `View ${leases.leases.length} lease(s)`, value: "details", description: "owners, labels, files, and remaining TTL" },
      { title: "Ask on blocked shell", value: "ask", description: "request approval when a lease blocks shell" },
      { title: "Deny blocked shell", value: "deny", description: "reject immediately when a lease blocks shell" },
    ],
  })
  if (!choice) return
  if (choice === "details") {
    await context.ui.dialog.alert({ title: "Gvozd file leases", message: leaseSummary(leases) })
    return
  }
  if (choice === config.lease.shellEscalation) return
  const failure = await services.patchShellEscalation(context, choice)
  if (failure) {
    await context.ui.dialog.alert({ title: "Gvozd leases", message: failure })
    return
  }
  context.ui.toast.show({ title: "Gvozd leases", message: `Blocked shell now ${choice}`, variant: "success" })
}

async function chooseJev(context: Context, services: NativeControlServices): Promise<void> {
  const config = await services.getConfig(context)
  if (!config) return unavailable(context, "JEV")
  const jev = config.jev
  const choice = await context.ui.dialog.select<"enabled" | "disabled" | "details">({
    title: "Gvozd JEV",
    current: jev.globalEnabled ? "enabled" : "disabled",
    options: [
      { title: "Enabled", value: "enabled", description: `${jev.provider}/${jev.model}` },
      { title: "Disabled", value: "disabled", description: "cancel active requests and disable the tool" },
      { title: "Connection details", value: "details", description: `${jev.baseUrlHost} · ${jev.apiKeyEnv}` },
    ],
  })
  if (!choice) return
  if (choice === "details") {
    await context.ui.dialog.alert({
      title: "Gvozd JEV",
      message: [
        `Status: ${jev.enabled ? "available" : "unavailable"}`,
        `Provider: ${jev.provider}`,
        `Model: ${jev.model}`,
        `Endpoint: ${jev.baseUrlHost}${jev.customBaseUrl ? " (custom)" : ""}`,
        `${jev.apiKeyEnv}: ${jev.credentialPresent ? "present" : "missing"}`,
        `Allowed agents: ${jev.allowedAgents.length}`,
      ].join("\n"),
    })
    return
  }
  const enabled = choice === "enabled"
  if (enabled === jev.globalEnabled) return
  const failure = await services.patchJevEnabled(context, enabled)
  if (failure) {
    await context.ui.dialog.alert({ title: "Gvozd JEV", message: failure })
    return
  }
  context.ui.toast.show({ title: "Gvozd JEV", message: enabled ? "JEV enabled" : "JEV disabled", variant: "success" })
}

async function chooseAgents(context: Context, services: NativeControlServices): Promise<void> {
  const config = await services.getConfig(context)
  if (!config) return unavailable(context, "agents")
  const agent = await context.ui.dialog.select<string>({
    title: "Gvozd agents",
    options: config.agents.map((entry) => ({
      title: `${entry.disabled ? "✗" : "✓"} ${entry.id}`,
      value: entry.id,
      description: entry.disabled ? "disabled" : entry.models[0] ?? "enabled",
    })),
  })
  if (!agent) return
  const current = config.agents.find((entry) => entry.id === agent)
  const choice = await context.ui.dialog.select<"enabled" | "disabled">({
    title: `Agent: ${agent}`,
    current: current?.disabled ? "disabled" : "enabled",
    options: [
      { title: "Enabled", value: "enabled", description: "visible to OpenCode" },
      { title: "Disabled", value: "disabled", description: "hidden until re-enabled" },
    ],
  })
  if (!choice) return
  const disabled = choice === "disabled"
  if (disabled === (current?.disabled ?? false)) return
  const failure = await services.patchAgentDisabled(context, agent, disabled)
  if (failure) {
    await context.ui.dialog.alert({ title: "Gvozd agents", message: failure })
    return
  }
  context.ui.toast.show({ title: "Gvozd agents", message: `${agent} ${disabled ? "disabled" : "enabled"}`, variant: "success" })
}

async function runDryRun(context: Context, services: NativeControlServices): Promise<void> {
  const command = await context.ui.dialog.prompt({
    title: "Gvozd permission dry-run",
    description: "Evaluate a shell command against the master agent policy",
    placeholder: "git diff HEAD",
  })
  if (!command?.trim()) return
  const output = await services.evaluatePermissions(context, "master", splitCommandPipeline(command.trim()))
  if (!output) return unavailable(context, "permission dry-run")
  const message = output.results.map((result) => (
    `${result.effect.toUpperCase()} · ${result.resource}${result.matchedRule ? `\n  matched: ${result.matchedRule}` : ""}`
  )).join("\n")
  await context.ui.dialog.alert({ title: "Gvozd permission dry-run", message: message || "No command segments found." })
}

function formatGoalStatus(sessionID: string, status: GoalStatusOutput): string {
  // The server flag carries no round log: status reports the live grant only.
  // Iterations and deltas live in the Extreme loop's own round log, not here.
  // The grant is family-scoped, never goalId-scoped, and the loop must run
  // exactly the recorded user-supplied commands — never agent-invented ones.
  return [
    `Session: ${sessionID}`,
    `Goal: ${status.goalId ?? "none"}`,
    `Active: ${status.active ? "yes" : "no"}`,
    `Stopped: ${status.stopped ? "yes" : "no"}`,
    `Stop reason: ${status.stopReason ?? "—"}`,
    `Scope: family (family-scoped grant; goalId is a label only)`,
    `Measure: ${status.measureCmd ?? "—"}`,
    `Verify: ${status.verifyCmd ?? "—"}`,
  ].join("\n")
}

async function chooseGoal(context: Context, sessionID: string, services: NativeControlServices): Promise<void> {
  const action = await context.ui.dialog.select<"start" | "status" | "stop">({
    title: "Gvozd goal",
    options: [
      { title: "Start", value: "start", description: "raise the family goal flag for optimization rounds" },
      { title: "Status", value: "status", description: "show the goal flag, goal id, and stop reason" },
      { title: "Stop", value: "stop", description: "quench the grant immediately (manual stop wins)" },
    ],
  })
  if (!action) return
  if (action === "start") {
    const name = await context.ui.dialog.prompt({
      title: "Gvozd goal start",
      description: "Metric or goal name the optimization rounds work toward",
      placeholder: "bundle-size",
    })
    if (!name?.trim()) return
    // Both loop commands are user input: the agent must run exactly these
    // recorded commands and may never substitute its own. An empty answer
    // records nothing rather than a blank command.
    const measure = await context.ui.dialog.prompt({
      title: "Gvozd goal measure",
      description: "Measure command the optimization rounds must run (from your input only)",
      placeholder: "bun run measure",
    })
    const verify = await context.ui.dialog.prompt({
      title: "Gvozd goal verify",
      description: "Verify command the optimization rounds must run (from your input only)",
      placeholder: "bun test",
    })
    const measureCmd = measure?.trim() ? measure.trim() : undefined
    const verifyCmd = verify?.trim() ? verify.trim() : undefined
    const started = await services.startGoal(context, sessionID, name.trim(), measureCmd, verifyCmd)
    if (!started) return unavailable(context, "goal")
    context.ui.toast.show({ title: "Gvozd goal", message: `Goal ${started.goalId} started`, variant: "success" })
    return
  }
  if (action === "status") {
    const status = await services.getGoalStatus(context, sessionID)
    if (!status) return unavailable(context, "goal")
    await context.ui.dialog.alert({ title: "Gvozd goal", message: formatGoalStatus(sessionID, status) })
    return
  }
  const stopped = await services.stopGoal(context, sessionID)
  if (!stopped) return unavailable(context, "goal")
  context.ui.toast.show({ title: "Gvozd goal", message: `Goal ${stopped.goalId ?? "goal"} stopped (manual)`, variant: "success" })
}

async function openSection(
  context: Context,
  sessionID: string,
  section: NativeControlSection,
  services: NativeControlServices,
): Promise<void> {
  if (section === "status") return showStatus(context, sessionID, services)
  if (section === "mode") return chooseMode(context, sessionID, services)
  if (section === "permissions") return choosePermissions(context, sessionID, services)
  if (section === "allowall") return chooseAllowAll(context, sessionID, services)
  if (section === "leases") return chooseLeases(context, services)
  if (section === "jev") return chooseJev(context, services)
  if (section === "agents") return chooseAgents(context, services)
  if (section === "goal") return chooseGoal(context, sessionID, services)
  return runDryRun(context, services)
}

/** Opens Gvozd using only host-native dialogs, so focus and input stay owned by OpenCode. */
export async function openNativeControl(
  context: Context,
  sessionID: string,
  initial?: NativeControlSection,
  services: NativeControlServices = nativeControlServices,
): Promise<void> {
  if (initial) {
    await openSection(context, sessionID, initial, services)
    return
  }
  while (true) {
    const section = await context.ui.dialog.select<NativeControlSection>({
      title: `Gvozd ${PACKAGE_VERSION}`,
      placeholder: "Choose a control",
      options: [
        { title: "Status", value: "status", description: "session, leases, JEV, and team health" },
        { title: "Session mode", value: "mode", description: "balanced, trusted, or strict" },
        { title: "Permissions", value: "permissions", description: "session overrides for shell, edits, skills, and MCP" },
        { title: "Allow all", value: "allowall", description: "approve all pending permission requests at once" },
        { title: "File leases", value: "leases", description: "inspect leases and blocked-shell policy" },
        { title: "JEV", value: "jev", description: "inspect or toggle the evaluator" },
        { title: "Agents", value: "agents", description: "enable or disable team agents" },
        { title: "Goal", value: "goal", description: "start, inspect, or stop the family optimization goal" },
        { title: "Permission dry-run", value: "dryrun", description: "evaluate a shell command without running it" },
      ],
    })
    if (!section) return
    await openSection(context, sessionID, section, services)
  }
}

export function currentSessionID(context: Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

export function openNativeControlForCurrentSession(
  context: Context,
  initial?: NativeControlSection,
  services: NativeControlServices = nativeControlServices,
): void {
  const sessionID = currentSessionID(context)
  if (!sessionID) {
    context.ui.toast.show({ title: "Gvozd", message: "Open a session before using Gvozd controls", variant: "warning" })
    return
  }
  void openNativeControl(context, sessionID, initial, services)
}

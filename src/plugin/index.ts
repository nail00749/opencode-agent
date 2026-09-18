import { Agent, Model, Plugin } from "@opencode/plugin"
import { buildAgentPermissions, explicitMcpAccess, matchingMcpServers } from "../core/agent-permissions"
import { join } from "node:path"
import { createConfigHolder, type ConfigHolder, type LeaseEditPatch } from "../core/config-holder"
import { GvozdLeases, GvozdPermissions, evaluateInput, type EvaluateInput, type LeaseListOutput } from "../rpc/permissions-rpc"
import { GvozdConfig, configPatchSchema, type ConfigGetOutput, type ConfigPatchOutput } from "../rpc/config-rpc"
import { GvozdRoster, type RosterListOutput } from "../rpc/roster-rpc"
import { GvozdMode, modePermissions, type ModeGetInput, type ModeSetInput, type ModeSetOverridesInput, type TrustMode } from "../rpc/trusted-mode"
import {
  modeDecisionFor,
  sessionOverrideDecision,
  sessionPermissionAction,
  type SessionPermissionOverrides,
} from "../core/session-permissions"
import { installFileLeaseRuntime } from "./file-lease-plugin"
import { resolveCaseInsensitiveFilesystem } from "../core/file-leases"
import { disposeResources, startRuntimeEventLoop } from "../shared/runtime-events"
import { parseOpenCodeVersion, satisfiesOpenCodeRange } from "../core/version"
import { SUPPORTED_OPENCODE_VERSION } from "../core/release-metadata"

function selectModel(models: string[], available: Awaited<ReturnType<Plugin.Context["catalog"]["model"]["list"]>>["data"]): Model.Ref {
  const configured = models.map((model) => Model.Ref.parse(model))
  const selected = configured.find((candidate) => {
    const match = available.find(
      (model) => model.enabled && model.providerID === candidate.providerID && model.id === candidate.id,
    )
    if (!match) return false
    return candidate.variant === undefined || match.variants.some((variant) => variant.id === candidate.variant)
  })
  return selected ?? configured[0]!
}

type ModelListData = Awaited<ReturnType<Plugin.Context["catalog"]["model"]["list"]>>["data"]

/**
 * OpenCode 2.0.4 split the catalog domain into top-level `model` and
 * `provider` domains and removed `ctx.catalog`; 2.0.2–2.0.3 hosts only expose
 * `ctx.catalog.model`. Both surfaces return the same `{ data }` envelope, and
 * reading whichever one the host provides keeps one build working across the
 * supported 2.0.* range. A host with neither surface degrades to unvalidated
 * configured model refs instead of failing setup.
 */
async function listModels(ctx: Plugin.Context, diagnostic: (message: string) => void): Promise<ModelListData> {
  const flat = ctx as unknown as { model?: { list(): Promise<{ data: ModelListData }> } }
  if (typeof flat.model?.list === "function") return (await flat.model.list()).data
  if (typeof ctx.catalog?.model?.list === "function") return (await ctx.catalog.model.list()).data
  diagnostic("agent-gvozd: host exposes no model catalog; agent models fall back to configured refs")
  return []
}

/**
 * Emits a diagnostic when the host advertises a version outside the supported
 * range. This is advisory only: the plugin adapts to the API surface it is
 * actually handed (see `listModels`), so a newer in-range host is not failed
 * merely because a version string looks unexpected. It exists so an out-of-
 * range host produces a clear message instead of an obscure crash.
 */
function reportHostVersion(ctx: Plugin.Context, diagnostic: (message: string) => void): void {
  const version = parseOpenCodeVersion(ctx.app?.version ?? "")
  if (version && !satisfiesOpenCodeRange(version, SUPPORTED_OPENCODE_VERSION)) {
    diagnostic(
      `agent-gvozd: OpenCode ${version} is outside the supported ${SUPPORTED_OPENCODE_VERSION} range; `
      + "the plugin will adapt to the available API but compatibility is not guaranteed",
    )
  }
}

type AgentTransformCallback = Parameters<Plugin.Context["agent"]["transform"]>[0]
type AgentTransformEditor = Parameters<AgentTransformCallback>[0]

export function applyAgentConfiguration(
  agents: AgentTransformEditor,
  config: ConfigHolder,
  models: Awaited<ReturnType<Plugin.Context["catalog"]["model"]["list"]>>["data"],
  mcpServers: string[],
): void {
  const held = config.get()
  for (const [id, configured] of Object.entries(held.agents)) {
    if (configured.disabled) {
      agents.remove(id as Agent.ID)
      continue
    }
    if (!agents.get(id as Agent.ID)) continue
    agents.update(id as Agent.ID, (agent) => {
      if (configured.promptContent === undefined) {
        throw new Error(`Agent ${id} is missing its immutable prompt snapshot (${configured.prompt})`)
      }
      agent.description = configured.description
      agent.mode = configured.mode
      agent.system = configured.promptContent.trim()
      agent.model = selectModel(configured.models, models)
      agent.permissions = buildAgentPermissions(configured, mcpServers)
    })
  }
  if (agents.get(held.defaultAgent as Agent.ID)) agents.default(held.defaultAgent as Agent.ID)
}

export default Plugin.define({
  id: "agent-gvozd",
  async setup(ctx) {
    const caseInsensitive = resolveCaseInsensitiveFilesystem(process.env)
    const config = createConfigHolder(ctx.location.project.directory, { env: process.env })
    const diagnostic = (message: string) => console.error(message)
    reportHostVersion(ctx, diagnostic)
    const mcp = await ctx.mcp.list()
    let mcpServers = mcp.data.map((server) => server.name)
    let models = await listModels(ctx, diagnostic)
    const resources: Array<{ dispose(): Promise<void> | void }> = []
    // Session-scoped permission state. Declared outside the RPC block so the
    // evaluate hook can consult it even on hosts without an RPC surface.
    const sessionModes = new Map<string, TrustMode>()
    const sessionOverrides = new Map<string, SessionPermissionOverrides>()
    const defaultMode = (): TrustMode => "balanced"
    try {
      const fileLeases = await installFileLeaseRuntime(ctx, config, { caseInsensitive })
      resources.push(fileLeases)
      // Older plugin hosts may not expose the RPC surface; the dry run is an
      // enhancement, so absence degrades to skipping registration.
      if (ctx.rpc && typeof ctx.rpc.register === "function") {
        const modeRpc = await ctx.rpc.register(GvozdMode, {
          set: async (raw) => {
            const input = raw as unknown as ModeSetInput
            sessionModes.set(input.sessionID, input.mode)
            // Session rules evaluate after agent rules; child sessions inherit
            // the rules in effect when they are created. Hosts that still
            // expose `permission.rules` get them pushed natively; 2.0.4+
            // removed that method, so the evaluate hook applies the same
            // posture table below.
            if (typeof ctx.permission.rules === "function") {
              await ctx.permission.rules({
                sessionID: input.sessionID,
                permissions: modePermissions(input.mode),
              })
            }
            return { mode: input.mode }
          },
          get: async (raw) => {
            const input = raw as unknown as ModeGetInput
            return {
              mode: sessionModes.get(input.sessionID) ?? defaultMode(),
              overrides: sessionOverrides.get(input.sessionID) ?? {},
            }
          },
          setOverrides: async (raw) => {
            const input = raw as unknown as ModeSetOverridesInput
            // Drop inherit entries so the map only holds real deviations.
            const overrides: SessionPermissionOverrides = {}
            for (const [action, effect] of Object.entries(input.overrides)) {
              if (effect && effect !== "inherit") {
                overrides[action as keyof SessionPermissionOverrides] = effect
              }
            }
            if (Object.keys(overrides).length === 0) sessionOverrides.delete(input.sessionID)
            else sessionOverrides.set(input.sessionID, overrides)
            return { overrides }
          },
        })
        resources.push(modeRpc)
        const leasesRpc = await ctx.rpc.register(GvozdLeases, {
          list: async () => {
            const output: LeaseListOutput = {
              leases: fileLeases.manager.snapshot().map((lease) => ({
                leaseId: lease.leaseId,
                parentSessionID: lease.parentSessionID,
                ...(lease.sessionID ? { sessionID: lease.sessionID } : {}),
                agent: lease.agent,
                label: lease.label,
                state: lease.state,
                files: [...lease.files],
                expiresAt: lease.expiresAt,
                lastActivityAt: lease.lastActivityAt,
              })),
            }
            return output
          },
        })
        resources.push(leasesRpc)
        const permissionRpc = await ctx.rpc.register(GvozdPermissions, {
          evaluate: async (raw) => {
            const input = raw as unknown as EvaluateInput
            const agent = config.get().agents[input.agent]
            return evaluateInput(agent && !agent.disabled ? agent.permissions : undefined, input)
          },
        })
        resources.push(permissionRpc)
        const rosterRpc = await ctx.rpc.register(GvozdRoster, {
          list: async () => {
            const output: RosterListOutput = {
              entries: Object.entries(config.get().agents)
                .filter(([, agent]) => !agent.disabled)
                .map(([id, agent]) => ({
                  id,
                  primary: agent.mode === "primary",
                  model: agent.models[0],
                  disabled: false,
                })),
            }
            return output
          },
        })
        resources.push(rosterRpc)
        const configRpc = await ctx.rpc.register(GvozdConfig, {
          get: async (): Promise<ConfigGetOutput> => {
            const resolved = config.get()
            return {
              projectRoot: resolved.projectRoot,
              agents: Object.entries(resolved.agents).map(([id, agent]) => ({
                id,
                models: [...agent.models],
                disabled: agent.disabled,
              })),
              lease: {
                reservationTtlMs: resolved.lease.reservationTtlMs,
                activeTtlMs: resolved.lease.activeTtlMs,
                shellEscalation: resolved.lease.shellEscalation,
              },
            }
          },
          patch: async (raw): Promise<ConfigPatchOutput> => {
            // Validate before writing: a malformed patch must not touch the file.
            const parsed = configPatchSchema.safeParse(raw)
            if (!parsed.success) {
              throw new Error(`Invalid gvozd config patch: ${parsed.error.issues[0]?.message ?? "unknown"}`)
            }
            const agents = (parsed.data.agents ?? []).map((agent) => ({
              id: agent.id,
              models: agent.models,
              disabled: agent.disabled,
            }))
            const lease: LeaseEditPatch = parsed.data.lease ?? {}
            // Global layer only — the managed user-owned file; project-layer
            // edits stay behind the CLI setup flow and trust token.
            const fresh = config.patch(agents, lease)
            // Agents replay transforms against the new holder value.
            await ctx.agent.reload()
            return {
              configPath: join(fresh.globalConfigDirectory, "config.jsonc"),
              rejected: [],
            }
          },
        })
        resources.push(configRpc)
      }
      const agentTransform = await ctx.agent.transform((agents) => {
        applyAgentConfiguration(agents, config, models, mcpServers)
      })
      resources.push(agentTransform)
      const permissionHook = await ctx.permission.hook("evaluate", async (event) => {
        // Lease policy outranks everything: it is the file-ownership guard and
        // must not be bypassable by a session toggle.
        if (fileLeases.enforcePermission(event)) return

        const category = sessionPermissionAction(event.action, mcpServers)
        const override = category ? sessionOverrides.get(event.sessionID)?.[category] : undefined
        const overrideDecision = sessionOverrideDecision(override, event.action, event.resources)
        const modeEffect = modeDecisionFor(modePermissions(sessionModes.get(event.sessionID) ?? defaultMode()), event.action, event.resources)

        // Agent-specific policy first. Only configured Gvozd agents carry
        // skills/MCP scoping; other primaries and host built-ins are untouched
        // here and still receive the session posture below.
        const configured = event.agent ? config.get().agents[event.agent] : undefined
        if (configured && !configured.disabled) {
          if (event.action === "skill") {
            const allowed = new Set(configured.skills)
            if (event.resources.some((resource) => !allowed.has(resource))) {
              event.effect = "deny"
              event.message = `Agent ${event.agent} cannot use this skill`
            }
          } else {
            let matchingServers = matchingMcpServers(event.action, mcpServers)
            if (matchingServers.length === 0 && event.action.includes("_")) {
              const mcp = await ctx.mcp.list()
              mcpServers = mcp.data.map((server) => server.name)
              matchingServers = matchingMcpServers(event.action, mcpServers)
            }
            if (matchingServers.length > 1) {
              // An ambiguous prefix is a configuration error, not a policy
              // choice, so no session toggle may resolve it.
              event.effect = "deny"
              event.message = `MCP action has an ambiguous server prefix: ${matchingServers.join(", ")}`
              return
            }
            if (matchingServers.length === 1
              && !matchingServers.some((server) => configured.mcp.includes(server))
              && !explicitMcpAccess(configured, event.action, event.resources)) {
              event.effect = "deny"
              event.message = `Agent ${event.agent} cannot use this MCP server`
            }
          }
        }

        // Session posture and per-category toggles evaluate last, matching the
        // host's last-match-wins ordering: an explicit user grant re-opens
        // what agent policy denied. `sessionOverrideDecision`/`modeDecisionFor`
        // clamp the never-escalate shell families so a toggle can never widen
        // a destructive command.
        if (overrideDecision && overrideDecision.effect === "deny") {
          event.effect = "deny"
          event.message = overrideDecision.message
          return
        }
        if (modeEffect === "deny") {
          event.effect = "deny"
          event.message = "Session posture denies this action"
          return
        }
        if (overrideDecision) {
          event.effect = overrideDecision.effect
          event.message = overrideDecision.message
          return
        }
        if (modeEffect) {
          event.effect = modeEffect
          event.message = `Session posture: ${modeEffect}`
        }
      })
      resources.push(permissionHook)
      const eventLoop = startRuntimeEventLoop({
        subscribe: (signal) => ctx.event.subscribe({ signal }),
        diagnostic,
        async handle(event) {
          fileLeases.handleEvent(event)
          if (event.type === "mcp.status.changed") {
            const mcp = await ctx.mcp.list()
            const next = mcp.data.map((server) => server.name)
            if (next.length === mcpServers.length && next.every((server, index) => server === mcpServers[index])) return
            mcpServers = next
            await ctx.agent.reload()
          }
          // 2.0.2–2.0.3 emit one catalog refresh; 2.0.4+ split it into
          // model- and provider-scoped events. The wider match is string-based
          // because the pinned 2.0.2 event union predates the new names.
          const type: string = event.type
          if (type === "catalog.updated" || type === "model.updated" || type === "provider.updated") {
            models = await listModels(ctx, diagnostic)
            await ctx.agent.reload()
          }
        },
      })
      resources.push(eventLoop)
      return async () => disposeResources(resources, diagnostic)
    } catch (error) {
      try {
        await disposeResources(resources, diagnostic)
      } catch {}
      throw error
    }
  },
})

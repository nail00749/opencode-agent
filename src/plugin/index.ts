import { Agent, Model, Plugin } from "@opencode/plugin"
import { buildAgentPermissions, explicitMcpAccess, matchingMcpServers } from "../core/agent-permissions"
import { loadConfig, type ResolvedConfig } from "../core/config"
import { GvozdLeases, GvozdPermissions, evaluateInput, type EvaluateInput, type LeaseListOutput } from "../rpc/permissions-rpc"
import { GvozdMode, modePermissions, type ModeGetInput, type ModeSetInput, type TrustMode } from "../rpc/trusted-mode"
import { installFileLeaseRuntime } from "./file-lease-plugin"
import { resolveCaseInsensitiveFilesystem } from "../core/file-leases"
import { disposeResources, startRuntimeEventLoop } from "../shared/runtime-events"

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

type AgentTransformCallback = Parameters<Plugin.Context["agent"]["transform"]>[0]
type AgentTransformEditor = Parameters<AgentTransformCallback>[0]

export function applyAgentConfiguration(
  agents: AgentTransformEditor,
  config: ResolvedConfig,
  models: Awaited<ReturnType<Plugin.Context["catalog"]["model"]["list"]>>["data"],
  mcpServers: string[],
): void {
  for (const [id, configured] of Object.entries(config.agents)) {
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
  if (agents.get(config.defaultAgent as Agent.ID)) agents.default(config.defaultAgent as Agent.ID)
}

export default Plugin.define({
  id: "agent-gvozd",
  async setup(ctx) {
    const caseInsensitive = resolveCaseInsensitiveFilesystem(process.env)
    const config = loadConfig(ctx.location.project.directory, { env: process.env })
    const mcp = await ctx.mcp.list()
    let mcpServers = mcp.data.map((server) => server.name)
    let models = await ctx.catalog.model.list()
    const diagnostic = (message: string) => console.error(message)
    const resources: Array<{ dispose(): Promise<void> | void }> = []
    try {
      const fileLeases = await installFileLeaseRuntime(ctx, config, { caseInsensitive })
      resources.push(fileLeases)
      // Older plugin hosts may not expose the RPC surface; the dry run is an
      // enhancement, so absence degrades to skipping registration.
      if (ctx.rpc && typeof ctx.rpc.register === "function") {
        const sessionModes = new Map<string, TrustMode>()
        const defaultMode = (): TrustMode => "balanced"
        const modeRpc = await ctx.rpc.register(GvozdMode, {
          set: async (raw) => {
            const input = raw as unknown as ModeSetInput
            sessionModes.set(input.sessionID, input.mode)
            // Session rules evaluate after agent rules; child sessions inherit
            // the rules in effect when they are created.
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
            return { mode: sessionModes.get(input.sessionID) ?? defaultMode() }
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
            const agent = config.agents[input.agent]
            return evaluateInput(agent && !agent.disabled ? agent.permissions : undefined, input)
          },
        })
        resources.push(permissionRpc)
      }
      const agentTransform = await ctx.agent.transform((agents) => {
        applyAgentConfiguration(agents, config, models.data, mcpServers)
      })
      resources.push(agentTransform)
      const permissionHook = await ctx.permission.hook("evaluate", async (event) => {
        if (fileLeases.enforcePermission(event)) return
        if (!event.agent) return
        const configured = config.agents[event.agent]
        if (!configured || configured.disabled) return

        if (event.action === "skill") {
          const allowed = new Set(configured.skills)
          if (event.resources.some((resource) => !allowed.has(resource))) {
            event.effect = "deny"
            event.message = `Agent ${event.agent} cannot use this skill`
          }
          return
        }

        let matchingServers = matchingMcpServers(event.action, mcpServers)
        if (matchingServers.length === 0 && event.action.includes("_")) {
          const mcp = await ctx.mcp.list()
          mcpServers = mcp.data.map((server) => server.name)
          matchingServers = matchingMcpServers(event.action, mcpServers)
        }
        if (matchingServers.length === 0) return
        if (matchingServers.length > 1) {
          event.effect = "deny"
          event.message = `MCP action has an ambiguous server prefix: ${matchingServers.join(", ")}`
          return
        }
        if (!matchingServers.some((server) => configured.mcp.includes(server)) && !explicitMcpAccess(configured, event.action, event.resources)) {
          event.effect = "deny"
          event.message = `Agent ${event.agent} cannot use this MCP server`
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
          if (event.type === "catalog.updated") {
            models = await ctx.catalog.model.list()
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

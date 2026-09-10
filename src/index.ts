import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Agent, Model, Plugin } from "@opencode/plugin"
import { loadConfig, type PermissionRule } from "./config"
import { GENERATED_MARKER } from "./constants"

function normalizeMcpName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_-]/g, "_")
}

function wildcardMatch(pattern: string, value: string): boolean {
  let source = "^"
  for (const character of pattern) {
    if (character === "*") source += ".*"
    else if (character === "?") source += "."
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
  }
  return new RegExp(`${source}$`).test(value)
}

function explicitMcpAccess(agent: { permissions: PermissionRule[] }, action: string, resources: readonly string[]): boolean {
  if (resources.length === 0) return false
  return resources.every((resource) => {
    const matching = agent.permissions.filter(
      (rule) => wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, resource),
    )
    const effect = matching.at(-1)?.effect
    return effect === "allow" || effect === "ask"
  })
}

function mcpPermissions(agent: { mcp: string[] }, mcpServers: string[]): PermissionRule[] {
  return [
    ...mcpServers.map(
      (server): PermissionRule => ({ action: `${normalizeMcpName(server)}_*`, resource: "*", effect: "deny" }),
    ),
    ...agent.mcp.map(
      (server): PermissionRule => ({ action: `${normalizeMcpName(server)}_*`, resource: "*", effect: "allow" }),
    ),
  ]
}

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

export default Plugin.define({
  id: "agent-gvozd",
  async setup(ctx) {
    const config = loadConfig(ctx.location.project.directory)
    const missing = Object.entries(config.agents)
      .filter(([id, agent]) => {
        if (agent.disabled) return false
        const path = join(config.projectRoot, ".opencode", "agents", `${id}.md`)
        return !existsSync(path) || !readFileSync(path, "utf8").includes(GENERATED_MARKER)
      })
      .map(([id]) => id)
    if (missing.length > 0) {
      throw new Error(`Run agent-gvozd sync before starting OpenCode. Missing or unmanaged agent files: ${missing.join(", ")}`)
    }

    let mcpServers: string[] = []
    let models = await ctx.catalog.model.list()

    const agentTransform = await ctx.agent.transform((agents) => {
      for (const [id, configured] of Object.entries(config.agents)) {
        if (configured.disabled) {
          agents.remove(id as Agent.ID)
          continue
        }
        agents.update(id as Agent.ID, (agent) => {
          agent.description = configured.description
          agent.mode = configured.mode
          agent.system = readFileSync(configured.prompt, "utf8").trim()
          agent.model = selectModel(configured.models, models.data)
          agent.permissions.push(...mcpPermissions(configured, mcpServers))
        })
      }
      agents.default(config.defaultAgent as Agent.ID)
    })

    const permissionHook = await ctx.permission.hook("evaluate", async (event) => {
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

      let matchingServers = mcpServers.filter((server) => event.action.startsWith(`${normalizeMcpName(server)}_`))
      if (matchingServers.length === 0 && event.action.includes("_")) {
        const mcp = await ctx.mcp.list()
        mcpServers = mcp.data.map((server) => server.name)
        matchingServers = mcpServers.filter((server) => event.action.startsWith(`${normalizeMcpName(server)}_`))
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

    const events = new AbortController()
    const refreshMcp = (async () => {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        if (event.type === "mcp.status.changed") {
          const mcp = await ctx.mcp.list()
          const next = mcp.data.map((server) => server.name)
          if (next.length === mcpServers.length && next.every((server, index) => server === mcpServers[index])) continue
          mcpServers = next
          await ctx.agent.reload()
        }
        if (event.type === "catalog.updated") {
          models = await ctx.catalog.model.list()
          await ctx.agent.reload()
        }
      }
    })()
    void refreshMcp.catch(() => {})

    return async () => {
      events.abort()
      await refreshMcp.catch(() => {})
      await permissionHook.dispose()
      await agentTransform.dispose()
    }
  },
})

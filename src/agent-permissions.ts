import type { PermissionRule } from "./config"
import { withEnvPrefixes } from "./tool-permissions"

export interface PermissionConfiguredAgent {
  skills: string[]
  mcp: string[]
  permissions: PermissionRule[]
}

export function normalizeMcpName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_-]/g, "_")
}

export function wildcardMatch(pattern: string, value: string): boolean {
  let source = "^"
  for (const character of pattern) {
    if (character === "*") source += ".*"
    else if (character === "?") source += "."
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
  }
  return new RegExp(`${source}$`).test(value)
}

export function explicitMcpAccess(
  agent: Pick<PermissionConfiguredAgent, "permissions">,
  action: string,
  resources: readonly string[],
): boolean {
  if (resources.length === 0) return false
  return resources.every((resource) => {
    const matching = agent.permissions.filter(
      (rule) => wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, resource),
    )
    const effect = matching.at(-1)?.effect
    return effect === "allow" || effect === "ask"
  })
}

export function matchingMcpServers(action: string, mcpServers: readonly string[]): string[] {
  return mcpServers.filter((server) => action.startsWith(`${normalizeMcpName(server)}_`))
}

export function buildAgentPermissions(agent: PermissionConfiguredAgent, mcpServers: readonly string[]): PermissionRule[] {
  const result: PermissionRule[] = [
    ...agent.permissions,
    { action: "skill", resource: "*", effect: "deny" },
    ...agent.skills.map((skill): PermissionRule => ({ action: "skill", resource: skill, effect: "allow" })),
  ]
  for (const server of mcpServers) {
    const prefix = `${normalizeMcpName(server)}_`
    result.push({
      action: `${prefix}*`,
      resource: "*",
      effect: agent.mcp.includes(server) ? "allow" : "deny",
    })
    result.push(...agent.permissions.filter((rule) => rule.action.startsWith(prefix)))
  }
  // Authoritative rules authored with git resources are duplicated for the
  // common lock-avoiding env prefixes so agents that set them explicitly
  // still match the intended effect instead of falling through to `ask`.
  for (const rule of agent.permissions) {
    if (rule.action !== "shell") continue
    if (!/(^|\s|["'])git(?:$|\s)/.test(rule.resource)) continue
    if (rule.resource.startsWith("GIT_")) continue
    result.push(...withEnvPrefixes(rule))
  }
  return result
}

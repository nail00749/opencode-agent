import type { PermissionRule } from "./config"
import { GIT_FORBIDDEN_PREFIXES, gitExceptionalMutationShellAsks, gitForcePushShellAsks, wildcardMatch, withEnvPrefixes } from "./tool-permissions"

export { wildcardMatch } from "./tool-permissions"

export interface PermissionConfiguredAgent {
  skills: string[]
  mcp: string[]
  permissions: PermissionRule[]
}

export function normalizeMcpName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_-]/g, "_")
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

export function hasMcpServerAccess(mcp: readonly string[], server: string): boolean {
  return mcp.includes("*") || mcp.includes(server)
}

export function matchingMcpServers(action: string, mcpServers: readonly string[]): string[] {
  return mcpServers.filter((server) => action.startsWith(`${normalizeMcpName(server)}_`))
}

export function buildAgentPermissions(agent: PermissionConfiguredAgent, mcpServers: readonly string[], resolvedAgentID?: string): PermissionRule[] {
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
      effect: hasMcpServerAccess(agent.mcp, server) ? "allow" : "deny",
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
  // Protected denies override config allows. Only the resolved Git identity
  // has the narrow final force-push ask exception below (last-match-wins).
  for (const prefix of GIT_FORBIDDEN_PREFIXES) {
    result.push({ action: "shell", resource: `${prefix}*`, effect: "deny" })
  }
  // Identity comes from the resolved roster key, never config capabilities or
  // a readonly role. Omitted identity deliberately retains all hard denials.
  if (resolvedAgentID === "git") result.push(...gitExceptionalMutationShellAsks(), ...gitForcePushShellAsks())
  return result
}

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

/**
 * Linear wildcard matcher: `*` matches any run of characters (including
 * empty), `?` matches exactly one. Iterative backtracking with a single
 * restart point, so matching never explodes like `.*`-based regexes do —
 * patterns come from user config and values from live agent commands.
 * O(pattern length × value length) in the worst case, no catastrophic
 * backtracking.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  let patternIndex = 0
  let valueIndex = 0
  let starPatternIndex = -1
  let restartValueIndex = 0
  while (valueIndex < value.length) {
    // A pattern star always takes priority over a character match: it is
    // remembered as a restart point and matched lazily, one absorbed
    // character per retry. Checking the star first keeps the restart point
    // alive even when the star could also "exactly" match a literal `*` in
    // the value.
    if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starPatternIndex = patternIndex++
      restartValueIndex = valueIndex
    } else if (patternIndex < pattern.length && (pattern[patternIndex] === "?" || pattern[patternIndex] === value[valueIndex])) {
      patternIndex++
      valueIndex++
    } else if (starPatternIndex >= 0) {
      // Mismatch: let the last star absorb one more character.
      patternIndex = starPatternIndex + 1
      valueIndex = ++restartValueIndex
    } else {
      return false
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex++
  return patternIndex === pattern.length
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

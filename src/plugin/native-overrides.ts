import { normalizeMcpName } from "../core/agent-permissions"
import type { SessionPermissionOverrides } from "../core/session-permissions"
import type { ModePermissionRule } from "../rpc/trusted-mode"

const ACTION = "gvozd.session-overrides"

function block(rules: readonly ModePermissionRule[]) {
  const start = rules.findIndex((rule) => rule.action === ACTION && rule.resource.startsWith("begin:") && rule.effect === "deny")
  if (start < 0) return undefined
  const end = rules.findIndex((rule, index) => index > start && rule.action === ACTION && rule.resource === "end" && rule.effect === "deny")
  return end < 0 ? undefined : { start, end }
}

export function readNativeOverrides(rules: readonly ModePermissionRule[], sessionID: string): SessionPermissionOverrides {
  const found = block(rules)
  if (!found) return {}
  try {
    const value = JSON.parse(rules[found.start]!.resource.slice("begin:".length))
    if (value.sessionID !== sessionID) return {}
    const overrides: SessionPermissionOverrides = {}
    for (const action of ["edit", "skill", "mcp"] as const) {
      const effect = value.overrides?.[action]
      if (effect === "allow" || effect === "ask" || effect === "deny") overrides[action] = effect
    }
    return overrides
  } catch {
    return {}
  }
}

/** Owner-tagged blocks survive reload, but are stripped from children rather
 * than leaking exact-session grants through native permission inheritance.
 */
export function replaceNativeOverrides(
  rules: readonly ModePermissionRule[], sessionID: string,
  overrides: SessionPermissionOverrides, mcpServers: readonly string[],
): ModePermissionRule[] {
  const found = block(rules)
  const before = found ? rules.slice(0, found.start) : rules
  const after = found ? rules.slice(found.end + 1) : []
  const additions: ModePermissionRule[] = []
  for (const action of ["edit", "skill", "mcp"] as const) {
    const effect = overrides[action]
    if (!effect || effect === "inherit") continue
    const actions = action === "mcp" ? mcpServers.map((name) => `${normalizeMcpName(name)}_*`) : [action]
    for (const name of actions) additions.push({ action: name, resource: "*", effect })
  }
  if (Object.keys(overrides).length === 0) return [...before, ...after]
  return [...before,
    { action: ACTION, resource: `begin:${JSON.stringify({ sessionID, overrides })}`, effect: "deny" },
    ...additions, { action: ACTION, resource: "end", effect: "deny" }, ...after]
}

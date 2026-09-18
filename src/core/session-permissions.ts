import { matchingMcpServers, wildcardMatch as matches } from "./agent-permissions"
import { shellMustNotEscalate } from "./tool-permissions"

/**
 * Session-scoped permission overrides for the interactive TUI toggle panel.
 *
 * Why this exists rather than reusing `ctx.permission.rules`: OpenCode 2.0.4
 * removed the `rules` method from the plugin permission domain (only
 * `hook/list/get/reply` remain), so session rules can no longer be pushed to
 * the host there. The `evaluate` hook survives on every supported 2.0.x host,
 * so the plugin applies these overrides itself while deciding an event's
 * effect. That keeps the panel working on 2.0.2 through 2.0.4+.
 *
 * Overrides are session-only and hold no persistence: they are dropped when
 * the process exits, and they can never weaken the destructive-command guards
 * (see `sessionOverrideDecision`).
 */

/** Tool categories the panel can toggle. */
export const SESSION_PERMISSION_ACTIONS = ["shell", "edit", "skill", "mcp"] as const
export type SessionPermissionAction = (typeof SESSION_PERMISSION_ACTIONS)[number]

/** `inherit` means "no override": the agent's own rules decide. */
export const SESSION_PERMISSION_EFFECTS = ["allow", "ask", "deny", "inherit"] as const
export type SessionPermissionEffect = (typeof SESSION_PERMISSION_EFFECTS)[number]

export type SessionPermissionOverrides = Partial<Record<SessionPermissionAction, SessionPermissionEffect>>

/**
 * Maps an event action to a toggle category. MCP tool actions are namespaced
 * by server (`<server>_tool`), so they need the live server list; the exact
 * actions map first.
 */
export function sessionPermissionAction(action: string, mcpServers: readonly string[] = []): SessionPermissionAction | undefined {
  if (action === "shell" || action === "bash") return "shell"
  if (action === "edit" || action === "write" || action === "patch") return "edit"
  if (action === "skill") return "skill"
  return matchingMcpServers(action, mcpServers).length > 0 ? "mcp" : undefined
}

export interface SessionOverrideDecision {
  effect: "allow" | "ask" | "deny"
  message: string
}

/**
 * Resolves the effect a session override imposes on a permission event, or
 * `undefined` when the override is absent/inherit and the agent's own rules
 * must decide.
 *
 * Safety invariant: a shell override can never allow (or ask for) a command
 * in the never-escalate families — history rewrites, worktree destruction,
 * and similar. Those stay denied even when the session says `allow`, so a
 * toggle cannot talk an agent past the destructive-command guard.
 */
export function sessionOverrideDecision(
  override: SessionPermissionEffect | undefined,
  action: string,
  resources: readonly string[],
): SessionOverrideDecision | undefined {
  if (override === undefined || override === "inherit") return undefined
  const category = sessionPermissionAction(action)
  if (category === "shell" && override !== "deny" && shellMustNotEscalate(resources)) {
    return {
      effect: "deny",
      message: "Destructive shell commands stay denied regardless of the session permission override",
    }
  }
  return {
    effect: override,
    message: `Session permission override: ${category ?? action} = ${override}`,
  }
}

/**
 * Advances a toggle through its values for the next Enter press:
 * inherit -> allow -> ask -> deny -> inherit.
 */
export function cycleSessionPermissionEffect(current: SessionPermissionEffect | undefined): SessionPermissionEffect {
  const order = SESSION_PERMISSION_EFFECTS
  const index = order.indexOf(current ?? "inherit")
  return order[(index + 1) % order.length]!
}

/**
 * Resolves the effect a posture's rule list imposes on one event, replicating
 * the host's last-match-wins evaluation per resource. Returns `undefined` when
 * no rule matches.
 *
 * Used only when the host does not expose `ctx.permission.rules` (2.0.4+),
 * where the plugin must apply the session posture itself.
 */
export function modeOverrideFor(
  rules: readonly PermissionRuleLike[],
  action: string,
  resources: readonly string[],
): "allow" | "ask" | "deny" | undefined {
  const evaluate = (resource: string): "allow" | "ask" | "deny" | undefined => {
    let matched: PermissionRuleLike | undefined
    for (const rule of rules) {
      if (matches(rule.action, action) && matches(rule.resource, resource)) matched = rule
    }
    return matched?.effect
  }
  const found = (resources.length > 0 ? resources : ["*"]).map(evaluate)
  if (found.some((effect) => effect === "deny")) return "deny"
  if (found.some((effect) => effect === "ask")) return "ask"
  if (found.some((effect) => effect === "allow")) return "allow"
  return undefined
}

interface PermissionRuleLike {
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
}

/**
 * Resolves the effect a posture's rule list imposes, honoring the never-
 * escalate families for shell: a session posture may not widen a destructive
 * command to allow/ask either.
 */
export function modeDecisionFor(
  rules: readonly PermissionRuleLike[],
  action: string,
  resources: readonly string[],
): "allow" | "ask" | "deny" | undefined {
  const effect = modeOverrideFor(rules, action, resources)
  if (effect === undefined) return undefined
  const category = sessionPermissionAction(action)
  if (category === "shell" && effect !== "deny" && shellMustNotEscalate(resources)) return "deny"
  return effect
}

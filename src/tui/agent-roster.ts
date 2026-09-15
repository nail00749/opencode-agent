/**
 * Agent roster for the TUI sidebar: which agent runs on which model in the
 * current project. Data comes from the location agent collection, which the
 * Gvozd server plugin has already transformed (model applied).
 */

/** One resolved agent entry for the sidebar. */
export interface AgentRosterEntry {
  readonly id: string
  /** Primary agent flag (primary/all versus subagent). */
  readonly primary: boolean
  /** Resolved model as provider/model, when the host reports one. */
  readonly model?: string
  readonly disabled: boolean
}

/** Minimal structural view of AgentInfo returned by the host data layer. */
export interface RosterAgentInfo {
  readonly id: string
  readonly mode: string
  readonly model?: { readonly providerID?: string; readonly id?: string; readonly variant?: string } | null
  readonly hidden?: boolean
  readonly description?: string
}

/**
 * Builds the sidebar roster from the location agent list. Gvozd's own agents
 * are matched against the configured team; unmanaged host agents are excluded
 * because the roster's purpose is showing the Gvozd configuration. `enabled`
 * carries the set of enabled Gvozd agent IDs when the caller knows the
 * configured team; agents outside it are skipped entirely.
 */
export function collectAgentRoster(
  agents: readonly RosterAgentInfo[] | undefined,
  team: readonly string[],
): AgentRosterEntry[] {
  if (!team || team.length === 0) return []
  const byID = new Map<string, RosterAgentInfo>()
  for (const agent of agents ?? []) {
    if (agent && typeof agent.id === "string") byID.set(agent.id, agent)
  }
  const entries: AgentRosterEntry[] = []
  for (const id of team) {
    const info = byID.get(id)
    if (!info) {
      entries.push({ id, primary: id === "master" || id === "master-trusted", model: undefined, disabled: true })
      continue
    }
    const model = info.model
    entries.push({
      id,
      primary: info.mode === "primary",
      model: model ? `${model.providerID}/${model.id}` : undefined,
      disabled: false,
    })
  }
  return entries
}

/** Orders the roster: primary agents first, then the configured team order. */
export function sortAgentRoster(entries: readonly AgentRosterEntry[]): AgentRosterEntry[] {
  return [...entries].sort((left, right) => {
    if (left.primary !== right.primary) return left.primary ? -1 : 1
    return left.id.localeCompare(right.id)
  })
}
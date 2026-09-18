import type { ResolvedConfig } from "./config"

/**
 * Per-agent orientation injected into every model request through the
 * session `context` hook. Host instruction sources (project `AGENTS.md`,
 * skills, references) are appended by OpenCode itself, but a subagent sees
 * them without session context: it does not know its lease role, what the
 * shell policy allows, or how to request a blocked command. This module
 * builds that missing orientation from the resolved configuration.
 */

/** One rendered orientation block for an agent. */
export interface AgentContextBlock {
  readonly agent: string
  readonly role: "coordinator" | "writer" | "readonly"
  readonly text: string
}

/** Role-specific behavior summary, kept short: prompts carry the details. */
const ROLE_GUIDANCE: Record<"coordinator" | "writer" | "readonly", string> = {
  coordinator:
    "You coordinate the lease protocol: reserve files with gvozd_lease before delegating, release leases as soon as a package completes. While any writer lease is active your own shell pauses — route shell needs to writers or wait for release.",
  writer:
    "You hold a file lease. Read-only verification commands (tests, typecheck, lint, build, read-only Git) are pre-approved. Any other shell command is blocked by the lease policy; Destructive commands (force-push, history rewrite, resets) are always denied without a prompt.",
  readonly:
    "You are read-only: never mutate files. While writer leases are active your shell is limited to the read-only verification baseline.",
}

/** Per-mode addition telling the agent what a lease-policy block means. */
const ESCALATION_GUIDANCE: Record<"ask" | "deny", string> = {
  ask:
    "A shell command blocked by the lease policy surfaces a permission request to the user: run it and the user will approve or reject the exact command — do not retry after a rejection, report to your coordinator instead.",
  deny:
    "A shell command blocked by the lease policy is hard-denied in this project (lease.shellEscalation: deny): report the exact command line to your coordinator instead of retrying.",
}

/**
 * Builds the orientation block appended to an agent's system prompt.
 * Returns undefined for unconfigured agents (custom primaries, host
 * built-ins) — the plugin leaves their context untouched.
 */
export function buildAgentContext(config: ResolvedConfig, agentID: string): AgentContextBlock | undefined {
  const agent = config.agents[agentID]
  if (!agent || agent.disabled) return undefined
  const role = agent.fileLease
  const escalation = ESCALATION_GUIDANCE[config.lease.shellEscalation]
  return {
    agent: agentID,
    role,
    text: [
      `You are running as the Gvozd agent "${agentID}" (${role} role) in ${config.projectRoot}.`,
      ROLE_GUIDANCE[role],
      escalation,
      `Read ${joinPath(config.projectRoot, "AGENTS.md")} before your first action when you need the project's workflow rules and security invariants.`,
    ].join("\n"),
  }
}

function joinPath(root: string, name: string): string {
  return root.endsWith("/") ? `${root}${name}` : `${root}/${name}`
}
import { buildAgentPermissions } from "./agent-permissions"
import type { AgentConfig, PermissionRule } from "./config"
import { GENERATED_MARKER } from "./constants"

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function renderPermissions(rules: PermissionRule[]): string[] {
  if (rules.length === 0) return []
  return [
    "permissions:",
    ...rules.flatMap((rule) => [
      `  - action: ${yamlString(rule.action)}`,
      `    resource: ${yamlString(rule.resource)}`,
      `    effect: ${rule.effect}`,
    ]),
  ]
}

export function renderAgent(agent: AgentConfig): string {
  if (agent.promptContent === undefined) {
    throw new Error(`Agent is missing its immutable prompt snapshot (${agent.prompt})`)
  }
  const prompt = agent.promptContent.trim()
  const permissions = buildAgentPermissions(agent, [])
  return [
    "---",
    GENERATED_MARKER,
    `description: ${yamlString(agent.description)}`,
    `mode: ${agent.mode}`,
    ...renderPermissions(permissions),
    "---",
    "",
    prompt,
    "",
  ].join("\n")
}

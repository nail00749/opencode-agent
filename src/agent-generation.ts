import { readFileSync } from "node:fs"
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
  const prompt = readFileSync(agent.prompt, "utf8").trim()
  const permissions: PermissionRule[] = [
    ...agent.permissions,
    { action: "skill", resource: "*", effect: "deny" },
    ...agent.skills.map((skill): PermissionRule => ({ action: "skill", resource: skill, effect: "allow" })),
  ]
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

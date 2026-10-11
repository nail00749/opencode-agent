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

// Language policy is injected here rather than copied into every prompt so the
// coordinator/worker contract cannot drift between agents or user overrides.
export const COORDINATOR_LANGUAGE = [
  "<language>",
  "Speak to the user in the user's own language: detect it from their latest message and use it for all user-facing text, questions, and summaries. Keep every subagent delegation strictly in English, including the fixed scope/files/leaseId/acceptance structure: translate it into concise English before dispatching, even when the user wrote in another language. Worker reports come back in English — translate their substance into the user's language for display, but keep evidence verbatim (file paths, file:line refs, commands, diff ranges, identifiers, stop reasons) untranslated. When invoked as a subagent by another coordinator, that coordinator is your user: report in English.",
  "</language>",
].join("\n")

export const WORKER_LANGUAGE = [
  "<language>",
  "Internal working language is English. Write all reports and evidence summaries in English. If a delegated task contains non-English text, translate it for your own work but still report in English. Produced artifacts (code comments, documentation, knowledge pages, commit messages) follow the project's existing language and conventions; default to English only when the project has no established convention. Never switch the report language; the coordinator handles all translation for the user.",
  "</language>",
].join("\n")

export function agentSystemPrompt(agent: AgentConfig, id = agent.prompt): string {
  if (agent.promptContent === undefined) {
    throw new Error(`Agent ${id} is missing its immutable prompt snapshot (${agent.prompt})`)
  }
  const language = agent.mode === "subagent" ? WORKER_LANGUAGE : COORDINATOR_LANGUAGE
  return `${agent.promptContent.trim()}\n\n${language}`
}

export function renderAgent(agent: AgentConfig, resolvedAgentID?: string): string {
  const prompt = agentSystemPrompt(agent, resolvedAgentID)
  const permissions = buildAgentPermissions(agent, [], resolvedAgentID)
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

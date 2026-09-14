import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser/lib/esm/main.js"
import { loadConfig } from "../config"
import { ALL_AGENT_IDS } from "./config-store"
import { resolveOpenCodeConfigRoot } from "./config-store"

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }

function assertValidJsonc(source: string, label: string): void {
  const errors: ParseError[] = []
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || value === undefined || value === null || Array.isArray(value) || typeof value !== "object") {
    const details = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
    throw new Error(`Invalid JSONC in ${label}${details ? `: ${details}` : ""}`)
  }
}

function setJsonc(source: string, path: (string | number)[], value: unknown): string {
  return applyEdits(source, modify(source, path, value, { formattingOptions }))
}

export interface AgentRow {
  readonly id: string
  readonly mode: string
  readonly lease: string
  readonly disabled: boolean
  readonly model: string
}

/** Lists the resolved agent team: mode, lease role, model, disabled flag. */
export function listAgents(cwd: string): AgentRow[] {
  const config = loadConfig(cwd, { configRoot: resolveOpenCodeConfigRoot() })
  return Object.entries(config.agents).map(([id, agent]) => ({
    id,
    mode: agent.mode,
    lease: agent.fileLease,
    disabled: agent.disabled,
    model: agent.models[0] ?? "",
  }))
}

/**
 * Writes `"disabled": true|false` for one built-in agent into the global
 * Gvozd config. Returns the new file bytes; the caller persists them with
 * the same atomic snapshot discipline as model configuration.
 */
export function setAgentDisabled(source: string, agentID: string, disabled: boolean): string {
  if (!ALL_AGENT_IDS.includes(agentID as (typeof ALL_AGENT_IDS)[number])) {
    throw new Error(`Unknown agent: ${agentID}`)
  }
  assertValidJsonc(source, "global Gvozd config")
  return applyEdits(
    source,
    modify(source, ["agents", agentID, "disabled"], disabled, { formattingOptions }),
  )
}

/** Reads the current managed global config bytes, or the seed when absent. */
export function readGlobalConfig(configRoot: string): string {
  const path = join(configRoot, "gvozd", "config.jsonc")
  if (!existsSync(path)) return '{\n  "$schema": "./schema.json",\n  "agents": {}\n}\n'
  const source = readFileSync(path, "utf8")
  assertValidJsonc(source, path)
  return source
}

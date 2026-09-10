import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { renderAgent } from "../agent-generation"
import { loadConfig, type ResolvedConfig } from "../config"
import { GENERATED_MARKER, GENERATED_PLUGIN_MARKER } from "../constants"
import type { OpenCodeClient } from "./opencode"
import { parseModels } from "./provider-catalog"

export interface DoctorCheck {
  id: string
  status: "pass" | "warn" | "fail"
  summary: string
  remediation?: string
}

export interface DoctorReport {
  schemaVersion: 1
  status: "pass" | "warn" | "fail"
  checks: DoctorCheck[]
}

export interface DoctorInput {
  client: OpenCodeClient
  configRoot: string
  cwd: string
  packageName?: string
  packageVersion?: string
  supportedOpenCodeVersion?: string
}

const SETUP_COMMAND = "gvozd setup"

function redact(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message
    .replace(/\b(token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 300)
}

function aggregate(checks: DoctorCheck[]): DoctorReport["status"] {
  if (checks.some((check) => check.status === "fail")) return "fail"
  if (checks.some((check) => check.status === "warn")) return "warn"
  return "pass"
}

function safeFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function hasName(output: string, name: string): boolean {
  return output.split(/\r?\n/).some((line) => line.includes(name))
}

function checkGlobalFiles(config: ResolvedConfig, configRoot: string): DoctorCheck {
  const missing: string[] = []
  const stale: string[] = []
  for (const [id, agent] of Object.entries(config.agents).sort(([left], [right]) => left.localeCompare(right))) {
    if (agent.disabled) continue
    const path = join(configRoot, "agents", `${id}.md`)
    if (!safeFile(path)) {
      missing.push(id)
      continue
    }
    const content = readFileSync(path, "utf8")
    if (!content.includes(GENERATED_MARKER) || content !== renderAgent(agent)) stale.push(id)
  }
  if (missing.length + stale.length === 0) {
    return { id: "global-agents", status: "pass", summary: `${Object.keys(config.agents).length} managed global agents are current` }
  }
  const details = [missing.length ? `missing: ${missing.join(", ")}` : "", stale.length ? `unmanaged or stale: ${stale.join(", ")}` : ""].filter(Boolean).join("; ")
  return { id: "global-agents", status: "fail", summary: details, remediation: SETUP_COMMAND }
}

function checkLegacy(config: ResolvedConfig): DoctorCheck {
  const duplicates: string[] = []
  const plugin = join(config.projectRoot, ".opencode", "plugins", "agent-gvozd", "index.ts")
  if (safeFile(plugin)) duplicates.push("local plugin")
  const agents = Object.keys(config.agents).filter((id) => safeFile(join(config.projectRoot, ".opencode", "agents", `${id}.md`)))
  if (agents.length > 0) duplicates.push(`${agents.length} local agents`)
  if (duplicates.length === 0) return { id: "legacy-local", status: "pass", summary: "no duplicate project-local Gvozd installation" }
  return {
    id: "legacy-local",
    status: "warn",
    summary: `legacy duplicates detected: ${duplicates.join(", ")}`,
    remediation: "Remove project-local generated Gvozd files after verifying global setup",
  }
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const packageName = input.packageName ?? "@nail00749/agent-gvozd"
  const packageVersion = input.packageVersion ?? "0.1.0"
  const supportedVersion = input.supportedOpenCodeVersion ?? "0.0.0-beta-19425"
  const checks: DoctorCheck[] = []

  try {
    const version = await input.client.version()
    checks.push(version.includes(supportedVersion)
      ? { id: "opencode-version", status: "pass", summary: `OpenCode ${supportedVersion} is available` }
      : { id: "opencode-version", status: "fail", summary: `unsupported OpenCode version: ${redact(version)}`, remediation: `Install OpenCode ${supportedVersion}` })
  } catch (error) {
    checks.push({ id: "opencode-version", status: "fail", summary: `OpenCode version check failed: ${redact(error)}`, remediation: `Install OpenCode ${supportedVersion}` })
  }

  try {
    await input.client.serviceStatus()
    checks.push({ id: "service", status: "pass", summary: "OpenCode service is reachable" })
  } catch (error) {
    checks.push({ id: "service", status: "fail", summary: `OpenCode service is unavailable: ${redact(error)}`, remediation: `${input.client.executable} service restart` })
  }

  try {
    const output = await input.client.pluginList()
    checks.push(hasName(output, packageName)
      ? { id: "plugin", status: "pass", summary: `${packageName} is registered` }
      : { id: "plugin", status: "fail", summary: `${packageName} is not registered`, remediation: SETUP_COMMAND })
  } catch (error) {
    checks.push({ id: "plugin", status: "fail", summary: `plugin list failed: ${redact(error)}`, remediation: SETUP_COMMAND })
  }

  try {
    const output = await input.client.pluginCheck(`${packageName}@^${packageVersion}`)
    const unhealthy = /\b(error|failed|incompatible)\b/i.test(output)
    checks.push(unhealthy
      ? { id: "plugin-check", status: "fail", summary: "OpenCode reports an unhealthy Gvozd plugin", remediation: SETUP_COMMAND }
      : { id: "plugin-check", status: "pass", summary: "Gvozd plugin check passed" })
  } catch (error) {
    checks.push({ id: "plugin-check", status: "fail", summary: `plugin check failed: ${redact(error)}`, remediation: SETUP_COMMAND })
  }

  try {
    const paths = await input.client.debugPaths()
    checks.push(resolve(paths.config!) === resolve(input.configRoot)
      ? { id: "config-root", status: "pass", summary: "runtime and CLI config roots match" }
      : { id: "config-root", status: "fail", summary: "runtime and CLI config roots differ", remediation: `${input.client.executable} debug paths` })
  } catch (error) {
    checks.push({ id: "config-root", status: "fail", summary: `config path check failed: ${redact(error)}` })
  }

  let config: ResolvedConfig | undefined
  const configPath = join(input.configRoot, "gvozd", "config.jsonc")
  const schemaPath = join(input.configRoot, "gvozd", "schema.json")
  try {
    if (!safeFile(configPath) || !safeFile(schemaPath)) throw new Error("global config.jsonc or schema.json is missing")
    const schemaErrors: ParseError[] = []
    const schema = parse(readFileSync(schemaPath, "utf8"), schemaErrors)
    if (schemaErrors.length > 0 || schema?.["x-agent-gvozd-schema-version"] !== 1 || !readFileSync(schemaPath, "utf8").includes(GENERATED_PLUGIN_MARKER)) {
      throw new Error("global schema is invalid, incompatible, or unmanaged")
    }
    config = loadConfig(input.cwd, { configRoot: input.configRoot })
    checks.push({ id: "config", status: "pass", summary: "global Gvozd config and schema are valid" })
  } catch (error) {
    checks.push({ id: "config", status: "fail", summary: `global config check failed: ${redact(error)}`, remediation: SETUP_COMMAND })
  }

  let catalog = parseModels([])
  try {
    catalog = parseModels(await input.client.models())
    if (catalog.models.length === 0) throw new Error("model catalog is empty")
    const configured = new Set(Object.values(config?.agents ?? {}).flatMap((agent) => agent.models))
    const missing = [...configured].filter((model) => !catalog.models.includes(model)).sort()
    checks.push(missing.length === 0
      ? { id: "models", status: "pass", summary: `${catalog.models.length} available models cover the Gvozd profile` }
      : { id: "models", status: "fail", summary: `configured models are unavailable: ${missing.join(", ")}`, remediation: "gvozd config" })
  } catch (error) {
    checks.push({ id: "models", status: "fail", summary: `model catalog check failed: ${redact(error)}`, remediation: `${input.client.executable} auth` })
  }

  if (config) checks.push(checkGlobalFiles(config, input.configRoot))
  else checks.push({ id: "global-agents", status: "fail", summary: "global agents cannot be validated without a valid config", remediation: SETUP_COMMAND })

  try {
    const output = await input.client.debugAgents()
    const missing = Object.entries(config?.agents ?? {}).filter(([, agent]) => !agent.disabled).map(([id]) => id).filter((id) => !hasName(output, id))
    checks.push(missing.length === 0 && config
      ? { id: "runtime-agents", status: "pass", summary: "all enabled Gvozd agents are visible to OpenCode" }
      : { id: "runtime-agents", status: "fail", summary: `runtime agents are missing: ${missing.join(", ") || "config unavailable"}`, remediation: `${input.client.executable} service restart` })
  } catch (error) {
    checks.push({ id: "runtime-agents", status: "fail", summary: `runtime agent check failed: ${redact(error)}`, remediation: `${input.client.executable} service restart` })
  }

  checks.push(config ? checkLegacy(config) : { id: "legacy-local", status: "warn", summary: "legacy duplicates could not be checked" })
  return { schemaVersion: 1, status: aggregate(checks), checks }
}

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.status === "fail" ? 1 : 0
}

export function renderDoctorHuman(report: DoctorReport): string {
  return [
    `Gvozd doctor: ${report.status.toUpperCase()}`,
    ...report.checks.flatMap((check) => [
      `${check.status.toUpperCase()} ${check.id}: ${check.summary}`,
      ...(check.remediation ? [`  Fix: ${check.remediation}`] : []),
    ]),
  ].join("\n")
}

export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report)
}

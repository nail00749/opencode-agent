import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js"
import { renderAgent } from "../agent-generation"
import { loadConfig, type ResolvedConfig } from "../config"
import { GENERATED_PLUGIN_MARKER, hasGeneratedAgentMarker } from "../constants"
import { CONFIG_SCHEMA_VERSION, PACKAGE_NAME, PACKAGE_SPEC, PACKAGE_VERSION, SUPPORTED_OPENCODE_VERSION } from "../release-metadata"
import { redactDiagnostic } from "../runtime-events"
import { parseOpenCodeVersion, satisfiesOpenCodeRange, type OpenCodeClient } from "./opencode"
import { parseModels } from "./provider-catalog"

export interface DoctorCheck {
  id: string
  status: "pass" | "warn" | "fail"
  summary: string
  remediation?: string
}

export interface DoctorReport {
  schemaVersion: number
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
  runtimeConfigRoot?: string
}

const SETUP_COMMAND = "gvozd setup"

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasAgentIdentifier(output: string, id: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(id)}(?=$|[^A-Za-z0-9_-])`, "m").test(output)
}

function hasInstalledPluginVersion(output: string, name: string, version: string): boolean {
  const boundary = `[\\s"'|│,}\\]]`
  const pattern = `(?:^|${boundary})${escapeRegExp(name)}(?:@|\\s+)v?${escapeRegExp(version)}(?=$|${boundary})`
  return new RegExp(pattern, "m").test(output)
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
    if (!hasGeneratedAgentMarker(content) || content !== renderAgent(agent)) stale.push(id)
  }
  const enabled = new Set(Object.entries(config.agents).filter(([, agent]) => !agent.disabled).map(([id]) => `${id}.md`))
  const orphans: string[] = []
  const directory = join(configRoot, "agents")
  if (existsSync(directory) && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink()) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || enabled.has(entry.name)) continue
      const content = readFileSync(join(directory, entry.name), "utf8")
      if (hasGeneratedAgentMarker(content)) orphans.push(entry.name.slice(0, -3))
    }
  }
  if (missing.length + stale.length + orphans.length === 0) {
    return { id: "global-agents", status: "pass", summary: `${enabled.size} managed global agents are current` }
  }
  const details = [
    missing.length ? `missing: ${missing.join(", ")}` : "",
    stale.length ? `unmanaged or stale: ${stale.join(", ")}` : "",
    orphans.length ? `orphan managed agents: ${orphans.join(", ")}` : "",
  ].filter(Boolean).join("; ")
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
  const packageName = input.packageName ?? PACKAGE_NAME
  const packageVersion = input.packageVersion ?? PACKAGE_VERSION
  const supportedVersion = input.supportedOpenCodeVersion ?? SUPPORTED_OPENCODE_VERSION
  const checks: DoctorCheck[] = []

  try {
    const version = await input.client.version()
    checks.push(satisfiesOpenCodeRange(parseOpenCodeVersion(version), supportedVersion)
      ? { id: "opencode-version", status: "pass", summary: `OpenCode ${supportedVersion} is available` }
      : { id: "opencode-version", status: "fail", summary: `unsupported OpenCode version: ${redactDiagnostic(version)}`, remediation: `Install OpenCode ${supportedVersion}` })
  } catch (error) {
    checks.push({ id: "opencode-version", status: "fail", summary: `OpenCode version check failed: ${redactDiagnostic(error)}`, remediation: `Install OpenCode ${supportedVersion}` })
  }

  try {
    await input.client.serviceStatus()
    checks.push({ id: "service", status: "pass", summary: "OpenCode service is reachable" })
  } catch (error) {
    checks.push({ id: "service", status: "fail", summary: `OpenCode service is unavailable: ${redactDiagnostic(error)}`, remediation: `${input.client.executable} service restart` })
  }

  try {
    const output = await input.client.pluginList()
    checks.push(hasInstalledPluginVersion(output, packageName, packageVersion)
      ? { id: "plugin", status: "pass", summary: `${packageName} ${packageVersion} is registered` }
      : { id: "plugin", status: "fail", summary: `${packageName} ${packageVersion} is not registered`, remediation: SETUP_COMMAND })
  } catch (error) {
    checks.push({ id: "plugin", status: "fail", summary: `plugin list failed: ${redactDiagnostic(error)}`, remediation: SETUP_COMMAND })
  }

  try {
    await input.client.pluginCheck(PACKAGE_SPEC)
    checks.push({ id: "plugin-check", status: "pass", summary: "Gvozd plugin check passed" })
  } catch (error) {
    checks.push({ id: "plugin-check", status: "fail", summary: `plugin check failed: ${redactDiagnostic(error)}`, remediation: SETUP_COMMAND })
  }

  try {
    const paths = await input.client.debugPaths()
    const reported = resolve(paths.config!)
    const expected = resolve(input.runtimeConfigRoot ?? input.configRoot)
    checks.push(reported === resolve(input.configRoot) && reported === expected
      ? { id: "config-root", status: "pass", summary: "runtime and CLI config roots match" }
      : { id: "config-root", status: "fail", summary: "OpenCode debug path and independently resolved runtime config root differ", remediation: `${input.client.executable} debug paths; set GVOZD_OPENCODE_CONFIG_ROOT to the reported config path before starting OpenCode` })
  } catch (error) {
    checks.push({ id: "config-root", status: "fail", summary: `config path check failed: ${redactDiagnostic(error)}` })
  }

  let config: ResolvedConfig | undefined
  let globalConfig: ResolvedConfig | undefined
  const configPath = join(input.configRoot, "gvozd", "config.jsonc")
  const schemaPath = join(input.configRoot, "gvozd", "schema.json")
  try {
    if (!safeFile(configPath) || !safeFile(schemaPath)) throw new Error("global config.jsonc or schema.json is missing")
    const schemaErrors: ParseError[] = []
    const schema = parse(readFileSync(schemaPath, "utf8"), schemaErrors)
    if (schemaErrors.length > 0 || schema?.["x-agent-gvozd-schema-version"] !== CONFIG_SCHEMA_VERSION || schema?.$comment !== GENERATED_PLUGIN_MARKER) {
      throw new Error("global schema is invalid, incompatible, or unmanaged")
    }
    globalConfig = loadConfig(input.cwd, { configRoot: input.configRoot, includeProject: false })
    config = loadConfig(input.cwd, { configRoot: input.configRoot })
    checks.push({ id: "config", status: "pass", summary: "global Gvozd config and schema are valid" })
  } catch (error) {
    checks.push({ id: "config", status: "fail", summary: `global config check failed: ${redactDiagnostic(error)}`, remediation: SETUP_COMMAND })
  }

  let catalog = parseModels([])
  try {
    catalog = parseModels(await input.client.models())
    if (catalog.models.length === 0) throw new Error("model catalog is empty")
    if (!config) {
      checks.push({ id: "models", status: "fail", summary: "configured models cannot be validated without a valid config", remediation: SETUP_COMMAND })
    } else {
      const available = new Set(catalog.models)
      const enabled = Object.entries(config.agents).filter(([, agent]) => !agent.disabled)
      const unavailableAgents = enabled.filter(([, agent]) => !agent.models.some((model) => available.has(model))).map(([id]) => id)
      const missingFallbacks = [...new Set(enabled.flatMap(([, agent]) => agent.models.filter((model) => !available.has(model))))].sort()
      checks.push(unavailableAgents.length > 0
        ? { id: "models", status: "fail", summary: `no configured model is available for: ${unavailableAgents.join(", ")}`, remediation: "gvozd config" }
        : missingFallbacks.length > 0
          ? { id: "models", status: "warn", summary: `primary coverage is available; unavailable fallback models: ${missingFallbacks.join(", ")}`, remediation: "gvozd config" }
          : { id: "models", status: "pass", summary: `${catalog.models.length} available models cover the Gvozd profile` })
    }
  } catch (error) {
    checks.push({ id: "models", status: "fail", summary: `model catalog check failed: ${redactDiagnostic(error)}`, remediation: `${input.client.executable} auth` })
  }

  if (globalConfig) checks.push(checkGlobalFiles(globalConfig, input.configRoot))
  else checks.push({ id: "global-agents", status: "fail", summary: "global agents cannot be validated without a valid config", remediation: SETUP_COMMAND })

  try {
    const output = await input.client.debugAgents()
    const missing = Object.entries(config?.agents ?? {}).filter(([, agent]) => !agent.disabled).map(([id]) => id).filter((id) => !hasAgentIdentifier(output, id))
    checks.push(missing.length === 0 && config
      ? { id: "runtime-agents", status: "pass", summary: "all enabled Gvozd agents are visible to OpenCode" }
      : { id: "runtime-agents", status: "fail", summary: `runtime agents are missing: ${missing.join(", ") || "config unavailable"}`, remediation: `${input.client.executable} service restart` })
  } catch (error) {
    checks.push({ id: "runtime-agents", status: "fail", summary: `runtime agent check failed: ${redactDiagnostic(error)}`, remediation: `${input.client.executable} service restart` })
  }

  checks.push(config ? checkLegacy(config) : { id: "legacy-local", status: "warn", summary: "legacy duplicates could not be checked" })
  return { schemaVersion: CONFIG_SCHEMA_VERSION, status: aggregate(checks), checks }
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

export function doctorOperationalFailure(error: unknown): DoctorReport {
  const checks: DoctorCheck[] = [{
    id: "opencode-discovery",
    status: "fail",
    summary: `OpenCode discovery failed: ${redactDiagnostic(error)}`,
    remediation: `Install OpenCode ${SUPPORTED_OPENCODE_VERSION} and run gvozd doctor again`,
  }]
  return { schemaVersion: CONFIG_SCHEMA_VERSION, status: "fail", checks }
}

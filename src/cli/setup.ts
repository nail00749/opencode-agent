import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadConfig } from "../config"
import { preflightGlobalConfig, writeGlobalConfig } from "./config-store"
import { chooseModelProfile, profileFromAgents, type PromptUI } from "./configure"
import { doctorExitCode, runDoctor, type DoctorReport } from "./doctor"
import { writeManagedAgents } from "./global-sync"
import { findOpenCode, type OpenCodeClient } from "./opencode"
import { parseModels } from "./provider-catalog"

const PACKAGE_SPEC = "@nail00749/agent-gvozd@^0.1.0"
const SUPPORTED_VERSION = "0.0.0-beta-19425"

export interface SetupInput {
  cwd: string
  yes?: boolean
  isTTY?: boolean
  ui?: PromptUI
  findClient?: () => Promise<OpenCodeClient>
  output?: (message: string) => void
}

export interface SetupResult {
  status: "complete" | "cancelled"
  report?: DoctorReport
}

function assertVersion(version: string): void {
  if (!version.includes(SUPPORTED_VERSION)) {
    throw new Error(`Unsupported OpenCode version. Gvozd 0.1.0 requires ${SUPPORTED_VERSION}.`)
  }
}

async function selectProfile(input: SetupInput, client: OpenCodeClient, configRoot: string) {
  const catalog = parseModels(await client.models())
  const config = loadConfig(input.cwd, { configRoot })
  const hasGlobalConfig = existsSync(join(configRoot, "gvozd", "config.jsonc"))
  return chooseModelProfile({
    catalog,
    ui: input.ui,
    yes: input.yes,
    isTTY: input.isTTY,
    existingProfile: hasGlobalConfig ? profileFromAgents(config.agents, catalog) : undefined,
  })
}

async function confirm(input: SetupInput, message: string): Promise<boolean> {
  if (input.yes) return true
  if (!input.ui) throw new Error("Interactive confirmation requires a TTY")
  const answer = await input.ui.confirm({ message, initialValue: true })
  return typeof answer === "symbol" ? false : answer
}

export async function runSetup(input: SetupInput): Promise<SetupResult> {
  const client = await (input.findClient ?? (() => findOpenCode()))()
  const paths = await client.debugPaths()
  const configRoot = paths.config
  if (!configRoot) throw new Error("OpenCode did not report its config path")
  assertVersion(await client.version())

  preflightGlobalConfig(configRoot)
  const before = loadConfig(input.cwd, { configRoot })
  writeManagedAgents({ configRoot, agents: before.agents, check: true })
  const profile = await selectProfile(input, client, configRoot)
  if (!profile) return { status: "cancelled" }

  input.output?.(`Register ${PACKAGE_SPEC}\nWrite ${join(configRoot, "gvozd", "config.jsonc")}\nWrite managed agents in ${join(configRoot, "agents")}`)
  if (!(await confirm(input, "Run setup?"))) return { status: "cancelled" }

  await client.pluginAdd(PACKAGE_SPEC)
  try {
    const schemaSource = join(dirname(before.sources[0]!), "schema.json")
    writeGlobalConfig({ configRoot, profile, schemaSource: readFileSync(schemaSource, "utf8") })
    const configured = loadConfig(input.cwd, { configRoot })
    writeManagedAgents({ configRoot, agents: configured.agents })
    await client.serviceRestart()
    const report = await runDoctor({ client, configRoot, cwd: input.cwd })
    return { status: "complete", report }
  } catch (error) {
    throw new Error(`Gvozd plugin was registered, but setup is incomplete: ${error instanceof Error ? error.message : String(error)}. Rerun: gvozd setup`)
  }
}

export async function runConfigure(input: SetupInput): Promise<SetupResult> {
  const client = await (input.findClient ?? (() => findOpenCode()))()
  const paths = await client.debugPaths()
  const configRoot = paths.config
  if (!configRoot) throw new Error("OpenCode did not report its config path")
  assertVersion(await client.version())
  preflightGlobalConfig(configRoot)
  const profile = await selectProfile(input, client, configRoot)
  if (!profile || !(await confirm(input, "Apply model configuration?"))) return { status: "cancelled" }
  const config = loadConfig(input.cwd, { configRoot })
  const schemaSource = join(dirname(config.sources[0]!), "schema.json")
  writeGlobalConfig({ configRoot, profile, schemaSource: readFileSync(schemaSource, "utf8") })
  await client.serviceRestart()
  const report = await runDoctor({ client, configRoot, cwd: input.cwd })
  return { status: "complete", report }
}

export function setupExitCode(result: SetupResult): 0 | 1 {
  if (result.status === "cancelled") return 0
  return result.report ? doctorExitCode(result.report) : 1
}

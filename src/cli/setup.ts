import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js"
import { JevPatchSchema, loadConfig, type JevConfig, type JevPatch } from "../core/config"
import { preflightGlobalConfig, writeGlobalConfig } from "./config-store"
import { chooseModelProfile, profileFromAgents, type PromptUI } from "./configure"
import { doctorExitCode, runDoctor, type DoctorReport } from "./doctor"
import { writeManagedAgents } from "./global-sync"
import { findOpenCode, parseOpenCodeVersion, satisfiesOpenCodeRange, type OpenCodeClient } from "./opencode"
import { parseModels, recommendProfile, type ModelProfile } from "./provider-catalog"
import { MINIMUM_NODE_VERSION, PACKAGE_NAME, PACKAGE_SPEC, PACKAGE_VERSION, SUPPORTED_OPENCODE_VERSION } from "../core/release-metadata"
import { resolveOpenCodeConfigRoot } from "../core/config-root"
import { redactDiagnostic } from "../shared/runtime-events"
import { replaceFileAtomic } from "../shared/fs"
import { withExclusiveFileLock } from "../shared/file-lock"
import type { GlobalConfigSnapshot } from "./config-store"
import { secureCanonicalPath } from "../shared/secure-path"
import { parseModelPreset, parseSetupPreset, presetJevPatch } from "../core/setup-presets"
import { DEFAULT_JEV_ALLOWED_AGENTS, JEV_PROVIDER_DEFAULTS, isDefaultJevBaseUrl, type JevProviderID } from "../core/jev"
import { satisfiesMinimumRuntime } from "../core/version"
import { installBuiltinSkills, planBuiltinSkills } from "../core/builtin-skills"

export interface SetupInput {
  cwd: string
  yes?: boolean
  /** Named model preset (`cheap|balanced|premium`) resolved non-interactively from the live catalog. */
  preset?: string
  /** Named Jev preset (`minimal|full|docs-only`) applied without Jev prompts; combines independently with `preset`. */
  jevPreset?: string
  isTTY?: boolean
  ui?: PromptUI
  findClient?: () => Promise<OpenCodeClient>
  output?: (message: string) => void
  runtimeConfigRoot?: string
  env?: Readonly<Record<string, string | undefined>>
  nodeVersion?: string
}

export interface SetupResult {
  status: "complete" | "cancelled"
  report?: DoctorReport
}

function assertVersion(version: string): void {
  if (!satisfiesOpenCodeRange(parseOpenCodeVersion(version), SUPPORTED_OPENCODE_VERSION)) {
    throw new Error(`Unsupported OpenCode version. Gvozd ${PACKAGE_VERSION} requires ${SUPPORTED_OPENCODE_VERSION}.`)
  }
}

function assertNodeVersion(version: string): void {
  if (!satisfiesMinimumRuntime(version, MINIMUM_NODE_VERSION)) {
    throw new Error(`Unsupported Node.js ${version}. Gvozd ${PACKAGE_VERSION} requires Node.js ${MINIMUM_NODE_VERSION} or newer.`)
  }
}

async function selectProfile(input: SetupInput, client: OpenCodeClient, configRoot: string, offerExisting = false) {
  const catalog = parseModels(await client.models())
  const config = loadConfig(input.cwd, { configRoot, includeProject: false })
  const hasGlobalConfig = existsSync(join(configRoot, "gvozd", "config.jsonc"))
  const existingProfile = hasGlobalConfig ? profileFromAgents(config.agents, catalog) : undefined
  if (offerExisting && existingProfile && !input.yes && input.isTTY && input.ui) {
    const keep = await input.ui.confirm({ message: "Keep the existing model configuration?", initialValue: true })
    if (typeof keep === "symbol") return undefined
    if (keep) return existingProfile
  }
  return chooseModelProfile({
    catalog,
    ui: input.ui,
    yes: input.yes,
    isTTY: input.isTTY,
    existingProfile,
  })
}

function editableJev(config: JevConfig): Required<JevPatch> {
  return {
    enabled: config.globalEnabled,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    allowedAgents: [...config.allowedAgents],
  }
}

async function selectAllowedAgents(
  ui: PromptUI,
  agentIDs: readonly string[],
  initialValues: readonly string[],
): Promise<string[] | symbol> {
  const available = [...new Set([...agentIDs, ...initialValues])].sort()
  if (ui.multiselect) {
    return ui.multiselect({
      message: "Choose agents allowed to use Jev",
      options: available.map((value) => ({ value, label: value })),
      initialValues: [...initialValues],
      required: false,
    })
  }
  const selected: string[] = []
  for (const agent of available) {
    const allowed = await ui.confirm({ message: `Allow ${agent} to use Jev?`, initialValue: initialValues.includes(agent) })
    if (typeof allowed === "symbol") return allowed
    if (allowed) selected.push(agent)
  }
  return selected
}

async function selectJevConfig(
  input: SetupInput,
  existing: JevConfig,
  agentIDs: readonly string[],
  offerExisting = false,
): Promise<Required<JevPatch> | undefined | null> {
  // Undefined means preserve the existing source exactly. This is the only
  // non-interactive behavior, including a fresh install where package
  // defaults already keep Jev disabled. On repeated interactive setup the
  // keep prompt lets the user skip the full flow without changes.
  if (input.yes) return undefined
  if (offerExisting && !input.yes && input.isTTY && input.ui) {
    const keep = await input.ui.confirm({ message: "Keep the existing Jev configuration?", initialValue: true })
    if (typeof keep === "symbol") return null
    if (keep) return undefined
  }
  if (!input.isTTY || !input.ui) throw new Error("Interactive Jev configuration requires a TTY")
  const ui = input.ui
  const enabled = await ui.confirm({ message: "Enable Jev structured evaluation?", initialValue: existing.globalEnabled })
  if (typeof enabled === "symbol") return null
  if (!enabled) return { ...editableJev(existing), enabled: false }

  const provider = await ui.select<JevProviderID>({
    message: "Select the Jev provider",
    options: [
      { value: "typesafe", label: "TypeSafe direct" },
      { value: "vercel", label: "Vercel AI Gateway" },
    ],
    initialValue: existing.provider,
  })
  if (typeof provider === "symbol") return null
  const providerChanged = provider !== existing.provider
  const defaults = JEV_PROVIDER_DEFAULTS[provider]
  const current = providerChanged ? defaults : existing

  if (!ui.text) throw new Error("This prompt UI cannot configure Jev text fields")
  const apiKeyEnv = await ui.text({ message: "Credential environment variable", initialValue: current.apiKeyEnv })
  if (typeof apiKeyEnv === "symbol") return null
  const urlMode = await ui.select<"standard" | "custom">({
    message: "Select the Jev endpoint",
    options: [
      { value: "standard", label: "Provider default", hint: defaults.baseUrl },
      { value: "custom", label: "Custom base URL", hint: "Vercel deployment, proxy, or self-hosted endpoint" },
    ],
    initialValue: isDefaultJevBaseUrl(provider, current.baseUrl) ? "standard" : "custom",
  })
  if (typeof urlMode === "symbol") return null
  let baseUrl: string = defaults.baseUrl
  if (urlMode === "custom") {
    const value = await ui.text({ message: "Custom Jev base URL", initialValue: current.baseUrl })
    if (typeof value === "symbol") return null
    baseUrl = value
  }
  const model = await ui.text({ message: "Jev model", initialValue: current.model })
  if (typeof model === "symbol") return null
  const allowed = await selectAllowedAgents(
    ui,
    agentIDs,
    providerChanged ? DEFAULT_JEV_ALLOWED_AGENTS : existing.allowedAgents,
  )
  if (typeof allowed === "symbol") return null
  const parsed = JevPatchSchema.parse({ enabled: true, provider, baseUrl, model, apiKeyEnv, allowedAgents: allowed })
  if (urlMode === "custom") input.output?.(`Jev will send evaluated state to custom host: ${new URL(parsed.baseUrl!).host}`)
  const credential = (input.env ?? process.env)[parsed.apiKeyEnv!]
  if (typeof credential !== "string" || credential.trim() === "") {
    input.output?.(`Warning: ${parsed.apiKeyEnv} is not set in this shell; configure it in the OpenCode service environment.`)
  }
  return parsed as Required<JevPatch>
}

async function confirm(input: SetupInput, message: string): Promise<boolean> {
  if (input.yes) return true
  if (!input.ui) throw new Error("Interactive confirmation requires a TTY")
  const answer = await input.ui.confirm({ message, initialValue: true })
  return typeof answer === "symbol" ? false : answer
}

/**
 * Named model preset resolution for `runSetup`/`runConfigure`. The profile
 * is resolved non-interactively from the live catalog (mirroring the
 * interactive preset mode); a Jev preset (if any) is applied separately via
 * `resolveJevSelection`, so no Jev/agent prompt is ever skipped here.
 * Unknown names throw before any mutation.
 */
async function resolvePresetSelection(input: SetupInput, client: OpenCodeClient) {
  const id = parseModelPreset(input.preset ?? "")
  const catalog = parseModels(await client.models())
  const profile = recommendProfile(catalog, id)
  if (!profile) {
    throw new Error(`Model preset "${id}" is not available with the current models. Available models: ${catalog.models.join(", ") || "none"}`)
  }
  return profile
}

/**
 * Named Jev preset resolution for `runSetup`/`runConfigure`. Returns the
 * static Jev patch without touching prompts; undefined means no Jev preset
 * was requested. Unknown names throw before any mutation.
 */
function resolveJevSelection(input: SetupInput): Required<JevPatch> | undefined {
  if (input.jevPreset === undefined) return undefined
  return presetJevPatch(parseSetupPreset(input.jevPreset))
}

function formatProfilePreview(profile: ModelProfile): string {
  return `Models: fast@${profile.fastProvider} ${profile.fast.join(", ")}; deep@${profile.deepProvider} ${profile.deep.join(", ")}`
}

const migrationFormatting = { insertSpaces: true, tabSize: 2, eol: "\n" }

/**
 * 0.8.0 migration: `master-trusted` merged into `master` (shell comes from
 * the session posture now, never from agent identity). Rewrites a global
 * `defaultAgent: "master-trusted"` to `"master"` and drops the
 * `agents.master-trusted` override, folding its models into `agents.master`
 * when master carries none — comments survive through JSONC edits and the
 * write is atomic. Idempotent: a rerun finds nothing and stays silent.
 * Returns true when anything was migrated.
 */
export function migrateMasterTrusted(configRoot: string, output?: (message: string) => void): boolean {
  const path = join(configRoot, "gvozd", "config.jsonc")
  if (!existsSync(path)) return false
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch {
    return false
  }
  const errors: ParseError[] = []
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as
    | Record<string, unknown>
    | undefined
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) return false
  const needsDefault = value.defaultAgent === "master-trusted"
  const agents = value.agents && typeof value.agents === "object" && !Array.isArray(value.agents)
    ? value.agents as Record<string, unknown>
    : undefined
  const override = agents?.["master-trusted"]
  if (!needsDefault && override === undefined) return false
  let updated = source
  if (needsDefault) {
    updated = applyEdits(updated, modify(updated, ["defaultAgent"], "master", { formattingOptions: migrationFormatting }))
  }
  if (override !== undefined) {
    const master = agents?.["master"]
    const masterModels = master && typeof master === "object" && !Array.isArray(master)
      ? (master as Record<string, unknown>)["models"]
      : undefined
    const overrideModels = override && typeof override === "object" && !Array.isArray(override)
      ? (override as Record<string, unknown>)["models"]
      : undefined
    if (Array.isArray(overrideModels) && masterModels === undefined) {
      updated = applyEdits(updated, modify(updated, ["agents", "master", "models"], overrideModels, { formattingOptions: migrationFormatting }))
    }
    updated = applyEdits(updated, modify(updated, ["agents", "master-trusted"], undefined, { formattingOptions: migrationFormatting }))
  }
  replaceFileAtomic(path, updated)
  output?.(`Migrated legacy master-trusted configuration to master in ${path}; run gvozd sync to refresh generated agents.`)
  return true
}

function sameSnapshot(left: GlobalConfigSnapshot, right: GlobalConfigSnapshot): boolean {
  return left.configRoot === right.configRoot
    && left.config.exists === right.config.exists && left.config.dev === right.config.dev
    && left.config.ino === right.config.ino && left.config.bytes === right.config.bytes
    && left.schema.exists === right.schema.exists && left.schema.dev === right.schema.dev
    && left.schema.ino === right.schema.ino && left.schema.bytes === right.schema.bytes
}


/**
 * Older setup versions appended a new package spec per release without
 * removing the previous one, which OpenCode 2.0.2 rejects with
 * "Duplicate plugin ID". Return every configured spec of this package
 * that is not the target spec so setup can remove it first.
 */
async function registeredPackageSpecs(client: OpenCodeClient, packageName: string, target: string): Promise<string[]> {
  const output = await client.pluginList()
  const specPattern = new RegExp(`${packageName.replace(/[/@]/g, "\\$&")}@[^\\s]+`, "g")
  const specs = [...new Set(output.match(specPattern) ?? [])]
  return specs.filter((spec) => spec !== target)
}

/**
 * `service restart` can return before the fresh server exposes the newly
 * registered plugin, which made the setup-embedded doctor report the
 * registration as missing even though a standalone doctor passed a moment
 * later. Poll the plugin list briefly instead of racing it.
 */
async function awaitRegisteredPlugin(client: OpenCodeClient, timeoutMs = 15_000): Promise<void> {
  const target = PACKAGE_SPEC
  const started = Date.now()
  // The first list call also happens to warm any caches on the fresh server.
  for (;;) {
    try {
      const output = await client.pluginList()
      const escapedName = PACKAGE_NAME.replace(/[/@]/g, "\\$&")
      const registered = new RegExp(`${escapedName}(?:@|\\s+)v?${PACKAGE_VERSION}(?=$|[^0-9.])`, "m").test(output)
      if (registered) return
    } catch {
      // The service may still be coming up; keep polling until the budget ends.
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`OpenCode did not report ${target} within ${timeoutMs}ms after the service restart`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

export async function runSetup(input: SetupInput): Promise<SetupResult> {
  assertNodeVersion(input.nodeVersion ?? process.versions.node)
  if (input.preset !== undefined) parseModelPreset(input.preset)
  if (input.jevPreset !== undefined) parseSetupPreset(input.jevPreset)
  const client = await (input.findClient ?? (() => findOpenCode()))()
  const paths = await client.debugPaths()
  if (!paths.config) throw new Error("OpenCode did not report its config path")
  const configRoot = secureCanonicalPath(paths.config, "OpenCode config root")
  preflightGlobalConfig(configRoot)
  migrateMasterTrusted(configRoot, input.output)
  const runtimeConfigRoot = input.runtimeConfigRoot ?? resolveOpenCodeConfigRoot()
  assertVersion(await client.version())

  const before = loadConfig(input.cwd, { configRoot, includeProject: false })
  const schemaSource = join(dirname(before.sources[0]!), "schema.json")
  const packagedSchema = readFileSync(schemaSource, "utf8")
  const previewSnapshot = preflightGlobalConfig(configRoot, packagedSchema)
  const preview = writeManagedAgents({ configRoot, agents: before.agents, check: true })
  const skillsDestination = join(configRoot, "skills")
  const skillPreview = planBuiltinSkills(before.packageRoot, skillsDestination)
  const usePreset = input.preset !== undefined
  const preset = usePreset ? await resolvePresetSelection(input, client) : undefined
  const profile = preset ?? await selectProfile(input, client, configRoot, true)
  if (!profile) return { status: "cancelled" }
  const jevPresetPatch = resolveJevSelection(input)
  const jev = jevPresetPatch ?? await selectJevConfig(input, before.jev, Object.keys(before.agents), existsSync(join(configRoot, "gvozd", "config.jsonc")))
  if (jev === null) return { status: "cancelled" }

  input.output?.([
    `Register ${PACKAGE_SPEC}`,
    `Write ${join(configRoot, "gvozd", "config.jsonc")}`,
    `Write managed agents in ${join(configRoot, "agents")}`,
    `Install 3 managed built-in skills in ${skillsDestination} (${skillPreview.created.length} new, ${skillPreview.updated.length} updated)`,
    formatProfilePreview(profile),
    `Jev: ${jev ? `${jev.enabled ? "enabled" : "disabled"} via ${jev.provider} (${jev.model})` : "preserve existing settings"}`,
    ...(preview.removed.length > 0 ? [`Remove ${preview.removed.length} stale or disabled managed agent(s)`] : []),
  ].join("\n"))
  if (!(await confirm(input, "Run setup?"))) return { status: "cancelled" }

  return withExclusiveFileLock(join(configRoot, "gvozd", "setup.lock"), async () => {
    if (secureCanonicalPath(configRoot, "OpenCode config root") !== configRoot) throw new Error("OpenCode config root changed while setup awaited the lock")
    const lockedSchema = readFileSync(schemaSource, "utf8")
    const snapshot = preflightGlobalConfig(configRoot, lockedSchema)
    if (!sameSnapshot(previewSnapshot, snapshot)) throw new Error("Global Gvozd configuration changed while setup awaited confirmation; review and rerun setup")
    const lockedBefore = loadConfig(input.cwd, { configRoot, includeProject: false })
    if (JSON.stringify(planBuiltinSkills(lockedBefore.packageRoot, skillsDestination)) !== JSON.stringify(skillPreview)) {
      throw new Error("Managed skills changed while setup awaited confirmation; review and rerun setup")
    }
    writeManagedAgents({ configRoot, agents: lockedBefore.agents, check: true })
    let lockedProfile: ModelProfile | undefined = profile
    if (usePreset) lockedProfile = await resolvePresetSelection(input, client)
    else if (input.yes) lockedProfile = await selectProfile(input, client, configRoot)
    if (!lockedProfile) throw new Error("Model profile changed while setup awaited the global lock; rerun setup")
    if (!sameSnapshot(snapshot, preflightGlobalConfig(configRoot, lockedSchema))) {
      throw new Error("Global Gvozd configuration changed during locked setup revalidation; review and rerun setup")
    }
    writeManagedAgents({ configRoot, agents: lockedBefore.agents, check: true })
    for (const stale of await registeredPackageSpecs(client, PACKAGE_NAME, PACKAGE_SPEC)) {
      await client.pluginRemove(stale)
    }
    await client.pluginAdd(PACKAGE_SPEC)
    try {
      writeGlobalConfig({ configRoot, profile: lockedProfile, jev, schemaSource: lockedSchema, snapshot })
      const configured = loadConfig(input.cwd, { configRoot, includeProject: false })
      installBuiltinSkills(configured.packageRoot, skillsDestination, { expected: skillPreview })
      writeManagedAgents({ configRoot, agents: configured.agents })
      await client.serviceRestart()
      await awaitRegisteredPlugin(client)
      const report = await runDoctor({
        client,
        configRoot,
        runtimeConfigRoot,
        cwd: input.cwd,
        env: input.env,
        nodeVersion: input.nodeVersion,
      })
      return { status: "complete", report }
    } catch (error) {
      const detail = redactDiagnostic(error)
      throw new Error(
        `${PACKAGE_NAME} remains registered, but setup is incomplete: ${detail}. `
        + `Managed files under ${configRoot} may be partially updated; no automatic rollback was attempted because concurrent or user changes cannot be distinguished safely. `
        + "Fix the reported cause, then rerun: gvozd setup",
      )
    }
  })
}

export async function runConfigure(input: SetupInput): Promise<SetupResult> {
  assertNodeVersion(input.nodeVersion ?? process.versions.node)
  if (input.preset !== undefined) parseModelPreset(input.preset)
  if (input.jevPreset !== undefined) parseSetupPreset(input.jevPreset)
  const client = await (input.findClient ?? (() => findOpenCode()))()
  const paths = await client.debugPaths()
  if (!paths.config) throw new Error("OpenCode did not report its config path")
  const configRoot = secureCanonicalPath(paths.config, "OpenCode config root")
  preflightGlobalConfig(configRoot)
  const runtimeConfigRoot = input.runtimeConfigRoot ?? resolveOpenCodeConfigRoot()
  assertVersion(await client.version())
  const config = loadConfig(input.cwd, { configRoot, includeProject: false })
  const schemaSource = join(dirname(config.sources[0]!), "schema.json")
  const packagedSchema = readFileSync(schemaSource, "utf8")
  const previewSnapshot = preflightGlobalConfig(configRoot, packagedSchema)
  const usePreset = input.preset !== undefined
  const preset = usePreset ? await resolvePresetSelection(input, client) : undefined
  const profile = preset ?? await selectProfile(input, client, configRoot)
  if (!profile) return { status: "cancelled" }
  const jev = resolveJevSelection(input) ?? await selectJevConfig(input, config.jev, Object.keys(config.agents))
  if (jev === null) return { status: "cancelled" }
  input.output?.([
    formatProfilePreview(profile),
    `Jev: ${jev ? `${jev.enabled ? "enabled" : "disabled"} via ${jev.provider} (${jev.model})` : "preserve existing settings"}`,
  ].join("\n"))
  if (!(await confirm(input, "Apply model and Jev configuration?"))) return { status: "cancelled" }
  return withExclusiveFileLock(join(configRoot, "gvozd", "setup.lock"), async () => {
    if (secureCanonicalPath(configRoot, "OpenCode config root") !== configRoot) throw new Error("OpenCode config root changed while configuration awaited the lock")
    const lockedSchema = readFileSync(schemaSource, "utf8")
    const snapshot = preflightGlobalConfig(configRoot, lockedSchema)
    if (!sameSnapshot(previewSnapshot, snapshot)) throw new Error("Global Gvozd configuration changed while configuration awaited confirmation; review and rerun")
    loadConfig(input.cwd, { configRoot, includeProject: false })
    let lockedProfile: ModelProfile | undefined = profile
    if (usePreset) lockedProfile = await resolvePresetSelection(input, client)
    else if (input.yes) lockedProfile = await selectProfile(input, client, configRoot)
    if (!lockedProfile) throw new Error("Model profile changed while configuration awaited the global lock; rerun configuration")
    if (!sameSnapshot(snapshot, preflightGlobalConfig(configRoot, lockedSchema))) {
      throw new Error("Global Gvozd configuration changed during locked configuration revalidation; review and rerun")
    }
    writeGlobalConfig({ configRoot, profile: lockedProfile, jev, schemaSource: lockedSchema, snapshot })
    await client.serviceRestart()
    const report = await runDoctor({
      client,
      configRoot,
      runtimeConfigRoot,
      cwd: input.cwd,
      env: input.env,
      nodeVersion: input.nodeVersion,
    })
    return { status: "complete", report }
  })
}

export function setupExitCode(result: SetupResult): 0 | 1 {
  if (result.status === "cancelled") return 0
  return result.report ? doctorExitCode(result.report) : 1
}

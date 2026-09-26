import { existsSync, lstatSync, mkdirSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { loadConfig } from "../core/config"
import { formatSyncResult, syncAgents } from "../core/sync"
import { assertWriteable, createExclusiveFile } from "../shared/fs"
import { secureCanonicalPath } from "../shared/secure-path"

export interface InitInput {
  /** Raw target directory from the CLI positional argument. Defaults to `cwd`. */
  target?: string
  cwd: string
  output?: (message: string) => void
}

export interface InitResult {
  directory: string
  configPath: string
  createdConfig: boolean
}

// Project-layer only: `$schema` plus description overrides. Never a trust
// self-authorization (`GVOZD_TRUST_PROJECT_CONFIG` is an env-only token) and
// never trust-granting keys (`defaultAgent`, `agentsDirectory`, `lease`,
// `jev`, or agent fields beyond `description`).
const PROJECT_TEMPLATE = [
  "{",
  '  "$schema": "./schema.json",',
  "  // Project overrides are merged after built-in and global configuration.",
  "  // Untrusted projects may only override agent descriptions here. Custom",
  "  // agents and every other key require explicit trust; see `gvozd trust-project`.",
  '  "agents": {}',
  "}",
  "",
].join("\n")

function assertRegularFile(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Project config path is not a safe file: ${path}`)
}

export async function runInit(input: InitInput): Promise<InitResult> {
  if (!input.cwd || !isAbsolute(input.cwd)) throw new Error(`Project working directory must be absolute: ${input.cwd}`)
  const raw = input.target ?? input.cwd
  if (!raw || raw.includes("\0")) throw new Error(`Project directory is not usable: ${raw}`)
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(input.cwd, raw)
  // Validates every existing ancestor with lstat: symlinked components,
  // non-directory ancestors, and group/world-writable directories without a
  // private boundary are rejected before anything is created.
  const pending = secureCanonicalPath(absolute, "Project directory")
  mkdirSync(pending, { recursive: true, mode: 0o700 })
  const directory = secureCanonicalPath(pending, "Project directory")
  const directoryStat = lstatSync(directory)
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Project directory is not a safe directory: ${directory}`)
  }
  assertWriteable(directory, "Project directory")

  const layer = secureCanonicalPath(join(directory, "docs", ".gvozd"), "Project Gvozd directory")
  mkdirSync(join(directory, "docs", ".gvozd", "agents"), { recursive: true, mode: 0o700 })
  const canonicalLayer = secureCanonicalPath(layer, "Project Gvozd directory")
  assertWriteable(canonicalLayer, "Project Gvozd directory")
  const agentsDirectory = secureCanonicalPath(join(canonicalLayer, "agents"), "Project agents directory")
  assertWriteable(agentsDirectory, "Project agents directory")

  const configPath = join(canonicalLayer, "config.jsonc")
  let createdConfig = false
  if (!existsSync(configPath)) {
    createExclusiveFile(configPath, PROJECT_TEMPLATE)
    createdConfig = true
  } else {
    assertRegularFile(configPath)
    assertWriteable(configPath, "Project Gvozd config")
  }

  // In-process materialization: never a subprocess, so the caller's file
  // lease and trust context apply to the whole onboarding run.
  const config = loadConfig(directory)
  const result = syncAgents(config)

  input.output?.(`Initialized Gvozd project layer in ${directory}`)
  input.output?.(`${createdConfig ? "Wrote" : "Kept"} ${configPath}`)
  input.output?.(formatSyncResult(result, false))
  input.output?.([
    "Next steps:",
    "- Review docs/.gvozd/config.jsonc (description overrides only; other keys need explicit trust)",
    "- Run gvozd sync to refresh .opencode/agents after editing project overrides",
    "- Run gvozd doctor to validate the installation",
  ].join("\n"))
  return { directory, configPath, createdConfig }
}

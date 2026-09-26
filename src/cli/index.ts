#!/usr/bin/env node

import * as prompts from "@clack/prompts"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../core/config"
import type { PromptUI } from "./configure"
import { doctorOperationalFailure, renderDoctorHuman, renderDoctorJson, runDoctor } from "./doctor"
import { findOpenCode, type OpenCodeClient } from "./opencode"
import { listAgents, readGlobalConfig, setAgentDisabled } from "./agents"
import { preflightGlobalConfig, snapshot as globalFileSnapshot, writeManagedGlobalFile } from "./config-store"
import { runConfigure, runSetup, setupExitCode, type SetupInput } from "./setup"
import { runInit, type InitInput } from "./init"
import { isSetupPreset, SETUP_PRESET_NAMES } from "../core/setup-presets"
import { formatSyncResult, syncAgents } from "../core/sync"
import { resolveOpenCodeConfigRoot } from "../core/config-root"
import { PACKAGE_VERSION } from "../core/release-metadata"
import { redactDiagnostic } from "../shared/runtime-events"
import { computeProjectTrustToken } from "../core/project-trust"
import { withExclusiveFileLock } from "../shared/file-lock"
import { analyzeSession, fetchSessionInfo, fetchSessionMessages, renderAnalyzeMarkdown, writeAnalyzeReport } from "./analyze"
import { renderUpdateResult, runUpdate, type UpdateInput } from "./update"

export interface CliIO {
  stdout(message: string): void
  stderr(message: string): void
  cwd(): string
  isTTY: boolean
}

export interface CliCommands {
  setup(input: SetupInput): ReturnType<typeof runSetup>
  configure(input: SetupInput): ReturnType<typeof runConfigure>
  init?(input: InitInput): ReturnType<typeof runInit>
  update?(input: UpdateInput): ReturnType<typeof runUpdate>
  findClient?(): Promise<OpenCodeClient>
}

const defaultIO: CliIO = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
  cwd: () => process.cwd(),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
}

const promptUI: PromptUI = {
  select: <T>(input: Parameters<PromptUI["select"]>[0]) => prompts.select(input as never) as Promise<T | symbol>,
  confirm: (input) => prompts.confirm(input),
  text: (input) => prompts.text(input),
  multiselect: <T>(input: Parameters<NonNullable<PromptUI["multiselect"]>>[0]) => prompts.multiselect(input as never) as Promise<T[] | symbol>,
  intro: prompts.intro,
  outro: prompts.outro,
}

const HELP = [
  "Usage: gvozd <setup|update|config|doctor|sync|trust-project|analyze|init> [options]",
  "",
  "Commands:",
  "  setup [--yes] [--preset minimal|full|docs-only]    Install or upgrade the global agent team",
  "  update [--check] Update the global CLI and registered plugin",
  "  agents [list]    Show the resolved agent team",
  "  agents disable <id> | enable <id>  Toggle an agent in the global config",
  "  config [--yes] [--preset minimal|full|docs-only]   Configure model preferences",
  "  doctor [--json]  Diagnose the global installation",
  "  sync [--check] [--dev-plugin]  Maintain the project-local installation",
  "                   --dev-plugin also writes the local plugin entrypoint (dev repositories only)",
  "  trust-project [directory]  Print the current project trust token",
  "  analyze <sessionID> [--json] [--stdout]  Export one OpenCode session",
  "                   (messages, tool calls, permission denials) as a Markdown",
  "                   report; --json writes JSON; --stdout prints instead of",
  "                   writing gvozd-<sessionID>.md into the current directory",
  "  init [directory] Scaffold the project layer (docs/.gvozd) and materialize",
  "                   .opencode/agents in-process; defaults to the current directory",
  "",
  "Options:",
  "  --help           Show this help",
  "  --version        Show the Gvozd version",
].join("\n")

function usage(io: CliIO): 2 {
  io.stderr(HELP)
  return 2
}

function parseFlags(args: string[], allowed: readonly string[]): { flags: Set<string>; positional: string[] } | undefined {
  const flags = new Set(args.filter((arg) => arg.startsWith("--")))
  if ([...flags].some((flag) => !allowed.includes(flag))) return undefined
  return { flags, positional: args.filter((arg) => !arg.startsWith("--")) }
}

function parseSetupArgs(args: string[]): { yes: boolean; preset?: string; unknownPreset?: string } | undefined {
  let yes = false
  let preset: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--yes") {
      yes = true
      continue
    }
    if (arg === "--preset") {
      const next = args[index + 1]
      if (next === undefined || next.startsWith("--") || preset !== undefined) return undefined
      preset = next
      index++
      continue
    }
    if (arg.startsWith("--preset=")) {
      const value = arg.slice("--preset=".length)
      if (value === "" || preset !== undefined) return undefined
      preset = value
      continue
    }
    return undefined
  }
  if (preset !== undefined && !isSetupPreset(preset)) return { yes, preset, unknownPreset: preset }
  return { yes, preset }
}

export async function runCli(
  args: string[],
  io: CliIO = defaultIO,
  commands: CliCommands = { setup: runSetup, configure: runConfigure },
): Promise<number> {
  const [command, ...rest] = args
  try {
    if ((command === "--help" || command === "help") && rest.length === 0) {
      io.stdout(HELP)
      return 0
    }
    if (command === "--version" && rest.length === 0) {
      io.stdout(PACKAGE_VERSION)
      return 0
    }
    if (command === "setup" || command === "config") {
      const parsed = parseSetupArgs(rest)
      if (!parsed) return usage(io)
      if (parsed.unknownPreset !== undefined) {
        io.stderr(`Unknown preset "${parsed.unknownPreset}". Available presets: ${SETUP_PRESET_NAMES}`)
        return usage(io)
      }
      const input: SetupInput = {
        cwd: io.cwd(),
        yes: parsed.yes,
        preset: parsed.preset,
        isTTY: io.isTTY,
        ui: promptUI,
        output: io.stdout,
      }
      if (!input.yes) input.ui?.intro(command === "setup" ? "Gvozd global setup" : "Gvozd model configuration")
      const result = command === "setup" ? await commands.setup(input) : await commands.configure(input)
      if (!input.yes) input.ui?.outro(result.status === "cancelled" ? "Cancelled; no changes were made" : "Gvozd configuration complete")
      if (result.report) io.stdout(renderDoctorHuman(result.report))
      return setupExitCode(result)
    }
    if (command === "update") {
      const parsed = parseFlags(rest, ["--check"])
      if (!parsed || parsed.positional.length > 0) return usage(io)
      const result = await (commands.update ?? runUpdate)({
        check: parsed.flags.has("--check"),
        findClient: commands.findClient,
      })
      io.stdout(renderUpdateResult(result))
      return 0
    }
    if (command === "doctor") {
      const parsed = parseFlags(rest, ["--json"])
      if (!parsed || parsed.positional.length > 0) return usage(io)
      let report
      try {
        const client = await (commands.findClient ?? findOpenCode)()
        const paths = await client.debugPaths()
        report = await runDoctor({
          client,
          configRoot: paths.config!,
          runtimeConfigRoot: resolveOpenCodeConfigRoot(),
          cwd: io.cwd(),
        })
      } catch (error) {
        report = doctorOperationalFailure(error)
      }
      io.stdout(parsed.flags.has("--json") ? renderDoctorJson(report) : renderDoctorHuman(report))
      return report.status === "fail" ? 1 : 0
    }
    if (command === "sync") {
      const parsed = parseFlags(rest, ["--check", "--dev-plugin"])
      if (!parsed || parsed.positional.length > 1) return usage(io)
      const check = parsed.flags.has("--check")
      const devPlugin = parsed.flags.has("--dev-plugin")
      const config = loadConfig(parsed.positional[0] ?? io.cwd())
      const result = syncAgents(config, { check, devPlugin, onDiff: (diff) => io.stdout(`${diff}\n`) })
      io.stdout(formatSyncResult(result, check))
      return check && result.created.length + result.updated.length + result.removed.length > 0 ? 1 : 0
    }
    if (command === "agents") {
      const [action, agentID] = rest
      if (!action || action === "list") {
        if (rest.length > 1) return usage(io)
        const rows = listAgents(io.cwd())
        for (const row of rows) {
          io.stdout(`${row.disabled ? "✗" : " "} ${row.id.padEnd(12)} ${row.mode.padEnd(8)} ${row.lease.padEnd(12)} ${row.model}`)
        }
        return 0
      }
      if (action === "disable" || action === "enable") {
        if (agentID === undefined || agentID.startsWith("--") || rest.length > 2) return usage(io)
        const configRoot = resolveOpenCodeConfigRoot()
        // Serialize against setup/config so snapshot checks cannot interleave.
        await withExclusiveFileLock(join(configRoot, "gvozd", "setup.lock"), async () => {
          preflightGlobalConfig(configRoot)
          const snapshot = globalFileSnapshot(join(configRoot, "gvozd", "config.jsonc"))
          const next = setAgentDisabled(readGlobalConfig(configRoot), agentID, action === "disable")
          writeManagedGlobalFile(join(configRoot, "gvozd", "config.jsonc"), next, snapshot)
        })
        io.stdout(`${action}d ${agentID}; run gvozd sync and gvozd doctor to apply`)
        return 0
      }
      return usage(io)
    }
    if (command === "trust-project") {
      const parsed = parseFlags(rest, [])
      if (!parsed || parsed.positional.length > 1) return usage(io)
      io.stdout(computeProjectTrustToken(parsed.positional[0] ?? io.cwd()))
      return 0
    }
    if (command === "analyze") {
      const parsed = parseFlags(rest, ["--json", "--stdout"])
      const [sessionID] = parsed?.positional ?? []
      if (!parsed || !sessionID || parsed.positional.length > 1) return usage(io)
      const format = parsed.flags.has("--json") ? "json" as const : "markdown" as const
      const client = await (commands.findClient ?? findOpenCode)()
      const info = await fetchSessionInfo(client, sessionID)
      const messages = await fetchSessionMessages(client, sessionID)
      const session = analyzeSession(info, messages)
      if (parsed.flags.has("--stdout")) {
        io.stdout(format === "markdown"
          ? renderAnalyzeMarkdown(session)
          : JSON.stringify(session, null, 2))
        return 0
      }
      const path = writeAnalyzeReport(io.cwd(), session, format)
      io.stdout(`Session report written: ${path}`)
      io.stdout(`${session.entries.length} entries, ${session.totalToolCalls} tool calls, ${session.errors.length} errors, ${session.permissionDenials.length} permission-denied tools`)
      return 0
    }
    if (command === "init") {
      if (rest.length > 1 || rest.some((arg) => arg.startsWith("--"))) return usage(io)
      await (commands.init ?? runInit)({ target: rest[0], cwd: io.cwd(), output: io.stdout })
      return 0
    }
    return usage(io)
  } catch (error) {
    io.stderr(redactDiagnostic(error))
    return 1
  }
}

// Only run the CLI when this module is the entrypoint. Realpath can fail for
// exotic loaders that pass a non-file argv[1]; treat that as "not the CLI".
const invokedPath = process.argv[1]
try {
  if (invokedPath && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
    process.exitCode = await runCli(process.argv.slice(2))
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
}

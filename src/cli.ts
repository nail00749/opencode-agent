#!/usr/bin/env node

import * as prompts from "@clack/prompts"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./config"
import type { PromptUI } from "./cli/configure"
import { doctorOperationalFailure, renderDoctorHuman, renderDoctorJson, runDoctor } from "./cli/doctor"
import { findOpenCode, type OpenCodeClient } from "./cli/opencode"
import { runConfigure, runSetup, setupExitCode, type SetupInput } from "./cli/setup"
import { formatSyncResult, syncAgents } from "./sync"
import { resolveOpenCodeConfigRoot } from "./config-root"
import { PACKAGE_VERSION } from "./release-metadata"
import { redactDiagnostic } from "./runtime-events"
import { computeProjectTrustToken } from "./project-trust"

export interface CliIO {
  stdout(message: string): void
  stderr(message: string): void
  cwd(): string
  isTTY: boolean
}

export interface CliCommands {
  setup(input: SetupInput): ReturnType<typeof runSetup>
  configure(input: SetupInput): ReturnType<typeof runConfigure>
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
  intro: prompts.intro,
  outro: prompts.outro,
}

const HELP = [
  "Usage: gvozd <setup|config|doctor|sync|trust-project> [options]",
  "",
  "Commands:",
  "  setup [--yes]    Install or upgrade the global agent team",
  "  config [--yes]   Configure model preferences",
  "  doctor [--json]  Diagnose the global installation",
  "  sync [--check]   Maintain the legacy project-local installation",
  "  trust-project [directory]  Print the current project trust token",
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
      const parsed = parseFlags(rest, ["--yes"])
      if (!parsed || parsed.positional.length > 0) return usage(io)
      const input: SetupInput = {
        cwd: io.cwd(),
        yes: parsed.flags.has("--yes"),
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
      const parsed = parseFlags(rest, ["--check"])
      if (!parsed || parsed.positional.length > 1) return usage(io)
      const check = parsed.flags.has("--check")
      const config = loadConfig(parsed.positional[0] ?? io.cwd())
      const result = syncAgents(config, { check, onDiff: (diff) => io.stdout(`${diff}\n`) })
      io.stdout(formatSyncResult(result, check))
      return check && result.created.length + result.updated.length + result.removed.length > 0 ? 1 : 0
    }
    if (command === "trust-project") {
      const parsed = parseFlags(rest, [])
      if (!parsed || parsed.positional.length > 1) return usage(io)
      io.stdout(computeProjectTrustToken(parsed.positional[0] ?? io.cwd()))
      return 0
    }
    return usage(io)
  } catch (error) {
    io.stderr(redactDiagnostic(error))
    return 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2))
}

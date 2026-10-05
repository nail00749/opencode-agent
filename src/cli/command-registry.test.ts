// Registry contract: the single source of truth for commands, flags, value
// enums, and subcommands. HELP parity with the real CLI is asserted here so
// HELP can never drift from the registry.

import { describe, expect, test } from "bun:test"
import { COMMANDS, GLOBAL_FLAGS, allFlagNames, buildHelp, findCommand } from "./command-registry"
import { MODEL_PRESET_IDS, SETUP_PRESET_IDS } from "../core/setup-presets"
import { runCli, type CliIO } from "./index"

function names(): string[] {
  return COMMANDS.map((command) => command.name)
}

function flagsOf(command: string): string[] {
  return findCommand(command)?.flags.map((flag) => flag.name) ?? []
}

describe("command registry", () => {
  test("covers every routed command", () => {
    expect(names()).toEqual([
      "setup", "update", "config", "doctor", "sync", "agents",
      "trust-project", "analyze", "init", "goal", "completion",
    ])
  })

  test("declares the global help and version flags", () => {
    expect(GLOBAL_FLAGS.map((flag) => flag.name).sort()).toEqual(["--help", "--version"])
    for (const flag of GLOBAL_FLAGS) expect(flag.takesValue).toBe(false)
  })

  test("setup and config share yes/preset/jev-preset with closed enums", () => {
    for (const command of ["setup", "config"]) {
      expect(flagsOf(command)).toEqual(["--yes", "--preset", "--jev-preset"])
    }
    const preset = findCommand("setup")?.flags.find((flag) => flag.name === "--preset")
    expect(preset?.takesValue).toBe(true)
    expect(preset?.values).toEqual([...MODEL_PRESET_IDS])
    const jevPreset = findCommand("setup")?.flags.find((flag) => flag.name === "--jev-preset")
    expect(jevPreset?.takesValue).toBe(true)
    expect(jevPreset?.values).toEqual([...SETUP_PRESET_IDS])
  })

  test("models the =-forms and goal start-only flags", () => {
    // =-forms need no extra entry: every takesValue flag accepts `--flag=value`.
    for (const flag of findCommand("setup")?.flags ?? []) {
      if (flag.name === "--preset" || flag.name === "--jev-preset") expect(flag.takesValue).toBe(true)
    }
    expect(flagsOf("goal")).toEqual(["--measure", "--verify"])
    for (const flag of findCommand("goal")?.flags ?? []) {
      expect(flag.takesValue).toBe(true)
      expect(flag.startOnly).toBe(true)
    }
    expect(findCommand("goal")?.subcommands).toEqual(["start", "status", "stop"])
    expect(findCommand("agents")?.subcommands).toEqual(["list", "disable", "enable"])
    expect(findCommand("completion")?.subcommands).toEqual(["bash", "zsh", "fish"])
  })

  test("declares the remaining command flags", () => {
    expect(flagsOf("update")).toEqual(["--check"])
    expect(flagsOf("doctor")).toEqual(["--json"])
    expect(flagsOf("sync")).toEqual(["--check", "--dev-plugin"])
    expect(flagsOf("analyze")).toEqual(["--json", "--stdout"])
    expect(flagsOf("trust-project")).toEqual([])
    expect(flagsOf("init")).toEqual([])
    expect(flagsOf("completion")).toEqual([])
    expect(flagsOf("agents")).toEqual([])
  })

  test("buildHelp matches the real --help output exactly", async () => {
    const stdout: string[] = []
    const io: CliIO = { stdout: (value) => stdout.push(value), stderr: () => {}, cwd: () => "/tmp", isTTY: false }
    expect(await runCli(["--help"], io)).toBe(0)
    expect(stdout).toEqual([buildHelp()])
    expect(allFlagNames().has("--preset")).toBe(true)
  })
})

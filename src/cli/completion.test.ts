// Completion emitters, Tab emulation, and the registry parity gate: any
// `--flag` parsed by `src/cli/index.ts` or `src/cli/goal.ts` must exist in
// the registry, and every registry command must be routed by the CLI.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { COMMANDS, allFlagNames } from "./command-registry"
import { COMPLETION_SHELLS, isCompletionShell, renderCompletion, suggestCompletion } from "./completion"
import { runCli, type CliIO } from "./index"

function harness(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), cwd: () => "/tmp", isTTY: false },
  }
}

describe("completion emitters", () => {
  test("bash, zsh, and fish scripts cover every command and flag", () => {
    const scripts = Object.fromEntries(COMPLETION_SHELLS.map((shell) => [shell, renderCompletion(shell)]))
    for (const command of COMMANDS) {
      for (const script of Object.values(scripts)) expect(script).toContain(command.name)
    }
    expect(scripts.bash).toContain("complete")
    expect(scripts.bash).toContain("--preset")
    expect(scripts.bash).toContain("cheap balanced premium")
    expect(scripts.bash).toContain("minimal full docs-only")
    expect(scripts.zsh).toStartWith("#compdef gvozd")
    expect(scripts.zsh).toContain("_arguments")
    expect(scripts.zsh).toContain("compdef _gvozd gvozd")
    expect(scripts.zsh).not.toContain(`_gvozd "$@"`)
    // Stray-paren gate: subcommand arms must close the _describe quote
    // without an extra `)` (a trailing paren breaks the whole _gvozd fn).
    for (const subs of ["(list disable enable)' ;;", "(start status stop)' ;;", "(bash zsh fish)' ;;"]) {
      expect(scripts.zsh).toContain(subs)
    }
    expect(scripts.zsh).not.toContain(")) ;;")
    expect(scripts.fish).toContain("complete -c gvozd")
    expect(scripts.fish).toContain("start status stop")
  })

  test("completion command prints the same script and rejects unknown shells", async () => {
    for (const shell of COMPLETION_SHELLS) {
      const { io, stdout, stderr } = harness()
      expect(await runCli(["completion", shell], io)).toBe(0)
      expect(stdout).toEqual([renderCompletion(shell)])
      expect(stderr).toEqual([])
    }
    for (const args of [["completion"], ["completion", "bash", "extra"], ["completion", "powershell"]]) {
      const { io, stdout, stderr } = harness()
      expect(await runCli(args, io)).toBe(2)
      expect(stdout).toEqual([])
      expect(stderr[0]).toStartWith("Usage:")
    }
    expect(isCompletionShell("bash")).toBe(true)
    expect(isCompletionShell("powershell")).toBe(false)
  })
})

describe("tab emulation", () => {
  test("completes bare command prefixes", () => {
    expect(suggestCompletion([])).toEqual(COMMANDS.map((command) => command.name).sort())
    expect(suggestCompletion(["s"])).toEqual(["setup", "sync"])
    expect(suggestCompletion(["goal"])).toEqual(["goal"])
  })

  test("completes goal subcommands", () => {
    expect(suggestCompletion(["goal", ""])).toEqual(["start", "status", "stop"])
    expect(suggestCompletion(["goal", "st"])).toEqual(["start", "status", "stop"])
    expect(suggestCompletion(["goal", "start", ""])).toEqual([])
  })

  test("completes setup preset values in space and =-forms", () => {
    expect(suggestCompletion(["setup", "--preset", ""])).toEqual(["balanced", "cheap", "premium"])
    expect(suggestCompletion(["setup", "--preset=bal"])).toEqual(["balanced"])
    expect(suggestCompletion(["setup", "--jev-preset", ""])).toEqual(["docs-only", "full", "minimal"])
    expect(suggestCompletion(["setup", "--"])).toContain("--preset")
  })

  test("goal measure/verify flags are start-only", () => {
    expect(suggestCompletion(["goal", "start", "ses-x", "--"])).toEqual(["--help", "--measure", "--verify", "--version"])
    expect(suggestCompletion(["goal", "status", "ses-x", "--"])).toEqual(["--help", "--version"])
    expect(suggestCompletion(["goal", "stop", "ses-x", "--"])).toEqual(["--help", "--version"])
  })
})

describe("registry parity gate", () => {
  test("every --flag parsed by the CLI exists in the registry", () => {
    const sources = ["./index.ts", "./goal.ts"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\\n/g, "\n"))
    const seen = new Set<string>()
    for (const source of sources) {
      for (const match of source.matchAll(/--[a-z][a-z0-9-]*/g)) seen.add(match[0])
    }
    // Parser sentinels (`startsWith("--")`) contribute no literal flag.
    const known = allFlagNames()
    expect([...seen].sort()).toEqual([...known].sort())
  })

  test("every registry command is routed by the CLI", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    for (const command of COMMANDS) {
      expect(source.includes(`"${command.name}"`)).toBe(true)
    }
  })
})

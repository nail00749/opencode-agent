import { describe, expect, test } from "bun:test"
import { runCli, type CliCommands, type CliIO } from "./cli"

function harness(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), cwd: () => "/tmp", isTTY: false },
  }
}

describe("CLI dispatch", () => {
  test("dispatches setup and config with exact flags", async () => {
    const seen: string[] = []
    const commands: CliCommands = {
      async setup(input) { seen.push(`setup:${input.yes}`); return { status: "cancelled" } },
      async configure(input) { seen.push(`config:${input.yes}`); return { status: "cancelled" } },
    }
    const { io } = harness()
    expect(await runCli(["setup", "--yes"], io, commands)).toBe(0)
    expect(await runCli(["config", "--yes"], io, commands)).toBe(0)
    expect(seen).toEqual(["setup:true", "config:true"])
  })

  test("invalid commands and flags exit 2", async () => {
    const { io, stderr } = harness()
    expect(await runCli(["unknown"], io)).toBe(2)
    expect(await runCli(["setup", "--json"], io)).toBe(2)
    expect(stderr.every((line) => line.startsWith("Usage:"))).toBe(true)
  })
})

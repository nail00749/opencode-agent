import { describe, expect, test } from "bun:test"
import type { ProcessRunner } from "./opencode"
import { findOpenCode, parseDebugPaths } from "./opencode"

describe("OpenCode process adapter", () => {
  test("falls back from opencode2 to opencode and always passes argv", async () => {
    const calls: Array<[string, readonly string[]]> = []
    const runner: ProcessRunner = {
      async run(executable, args) {
        calls.push([executable, args])
        if (executable === "opencode2") throw Object.assign(new Error("missing"), { code: "ENOENT" })
        return { code: 0, stdout: "opencode v0.0.0-beta-19425\n", stderr: "" }
      },
    }
    const client = await findOpenCode(runner)
    expect(client.executable).toBe("opencode")
    await client.pluginAdd("package name; still one argv")
    expect(calls.at(-1)).toEqual(["opencode", ["plugin", "add", "package name; still one argv"]])
  })

  test("parses paths and requires an absolute config directory", () => {
    expect(parseDebugPaths("home /home/u\nconfig     /tmp/opencode\n").config).toBe("/tmp/opencode")
    expect(() => parseDebugPaths("config relative/path\n")).toThrow("absolute")
    expect(() => parseDebugPaths("garbage\n")).toThrow("config")
  })

  test("reports bounded non-zero command output", async () => {
    const runner: ProcessRunner = {
      async run() {
        return { code: 7, stdout: "", stderr: "x".repeat(100_000) }
      },
    }
    await expect(findOpenCode(runner)).rejects.toThrow("exited 7")
    try {
      await findOpenCode(runner)
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(132_000)
    }
  })
})

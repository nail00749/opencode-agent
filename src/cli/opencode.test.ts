import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProcessRunner } from "./opencode"
import { defaultProcessRunner, findOpenCode, parseAgentIdentifiers, parseDebugPaths, parseOpenCodeVersion, satisfiesOpenCodeRange } from "./opencode"
import { wildcardMatch } from "../core/agent-permissions"

describe("OpenCode process adapter", () => {
  test("falls back from opencode2 to opencode and always passes argv", async () => {
    const calls: Array<[string, readonly string[]]> = []
    const runner: ProcessRunner = {
      async run(executable, args) {
        calls.push([executable, args])
        if (executable === "opencode2") throw Object.assign(new Error("missing"), { code: "ENOENT" })
        return { code: 0, stdout: "opencode v2.0.2\n", stderr: "" }
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

  test("parses the complete version token", () => {
    expect(parseOpenCodeVersion("opencode2 v2.0.2\n")).toBe("2.0.2")
    expect(parseOpenCodeVersion("opencode2 v2.0.20\n")).toBe("2.0.20")
  })

  test("prefers the newest compatible binary when several are present", async () => {
    const runner: ProcessRunner = {
      async run(executable) {
        const versions: Record<string, string> = { opencode2: "opencode v2.0.4\n", opencode: "opencode v2.0.2\n" }
        return { code: 0, stdout: versions[executable]!, stderr: "" }
      },
    }
    const client = await findOpenCode(runner)
    expect(client.executable).toBe("opencode2")
  })

  test("skips an out-of-range V1 binary and selects the compatible V2 one", async () => {
    const runner: ProcessRunner = {
      async run(executable) {
        if (executable === "opencode2") throw Object.assign(new Error("missing"), { code: "ENOENT" })
        return { code: 0, stdout: "opencode v1.18.30\n", stderr: "" }
      },
    }
    await expect(findOpenCode(runner)).rejects.toThrow("only incompatible builds were found")
    await expect(findOpenCode(runner)).rejects.toThrow("opencode v1.18.30")
  })

  test("rejects a host outside the supported range with an actionable message", async () => {
    const runner: ProcessRunner = {
      async run() {
        return { code: 0, stdout: "opencode v2.1.0\n", stderr: "" }
      },
    }
    await expect(findOpenCode(runner)).rejects.toThrow("OpenCode 2.0.* is required")
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

  test("waits for TERM-triggered close before reporting timeout", async () => {
    const started = Date.now()
    const source = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 180)); setInterval(() => {}, 1000)"
    const failure = defaultProcessRunner.run(process.execPath, ["-e", source], 250)
    await expect(failure).rejects.toMatchObject({ code: "ETIMEDOUT" })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(350)
    expect(elapsed).toBeLessThan(1_200)
  })

  test("force-kills an uncooperative timed-out child within a bounded deadline", async () => {
    const started = Date.now()
    const failure = defaultProcessRunner.run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], 250)
    await expect(failure).rejects.toMatchObject({ code: "ETIMEDOUT" })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(500)
    expect(elapsed).toBeLessThan(2_000)
  })

  test("returns normal results and bounds real child output", async () => {
    const normal = await defaultProcessRunner.run(process.execPath, ["-e", "console.log('ok')"])
    expect(normal).toMatchObject({ code: 0, stdout: "ok\n", stderr: "" })
    const bounded = await defaultProcessRunner.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"])
    expect(Buffer.byteLength(bounded.stdout)).toBe(64 * 1024)
  })

  test("redacts stderr secrets and never echoes URL arguments", async () => {
    const secretUrl = "https://user:password@example.test/plugin.tgz?token=supersecret"
    const runner: ProcessRunner = {
      async run(_executable, args) {
        if (args[0] === "--version") return { code: 0, stdout: "v2.0.2", stderr: "" }
        return { code: 9, stdout: "", stderr: "authorization=Bearer-private cookie=session-secret" }
      },
    }
    const client = await findOpenCode(runner)
    try {
      await client.pluginAdd(secretUrl)
      throw new Error("expected pluginAdd to fail")
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain(secretUrl)
      expect(message).not.toContain("Bearer-private")
      expect(message).not.toContain("session-secret")
      expect(message).toContain("[redacted]")
    }
  })

  test("kills the detached POSIX process group after timeout", async () => {
    if (process.platform === "win32") return
    const root = mkdtempSync(join(tmpdir(), "gvozd-process-group-"))
    const pidPath = join(root, "child.pid")
    const source = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
      "process.on('SIGTERM', () => {})",
      "setInterval(() => {}, 1000)",
    ].join(";")
    try {
      await expect(defaultProcessRunner.run(process.execPath, ["-e", source], 250)).rejects.toThrow("timed out")
      await Bun.sleep(700)
      const pid = Number(readFileSync(pidPath, "utf8"))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("satisfiesOpenCodeRange accepts any patch in the minor range and rejects others", () => {
  expect(satisfiesOpenCodeRange("2.0.2", "2.0.*")).toBe(true)
  expect(satisfiesOpenCodeRange("2.0.41", "2.0.*")).toBe(true)
  expect(satisfiesOpenCodeRange("2.1.0", "2.0.*")).toBe(false)
  expect(satisfiesOpenCodeRange("3.0.0", "2.0.*")).toBe(false)
  expect(satisfiesOpenCodeRange("2.0.2-beta.1", "2.0.*")).toBe(false)
  expect(satisfiesOpenCodeRange(undefined, "2.0.*")).toBe(false)
  // Exact ranges and prerelease exclusions.
  expect(satisfiesOpenCodeRange("2.0.2", "2.0.2")).toBe(true)
  expect(satisfiesOpenCodeRange("2.0.3", "2.0.2")).toBe(false)
})

test("parseAgentIdentifiers collapses OpenCode 2.0.2 debug agents JSON to IDs", () => {
  const json = JSON.stringify([
    { id: "master", mode: "primary", system: "You are Master".repeat(5000) },
    { id: "review-deep", mode: "subagent" },
    { id: "build", mode: "primary" },
  ])
  expect(parseAgentIdentifiers(json)).toBe("master review-deep build")
  expect(parseAgentIdentifiers("master review-deep build\n")).toBe("master review-deep build")
  expect(parseAgentIdentifiers("not json at all")).toBe("not json at all")
})

test("wildcardMatch stays linear under star-heavy patterns (ReDoS guard)", () => {
  // Patterns that hung the previous regex implementation for minutes now
  // finish instantly; star-priority matching keeps restart points alive.
  const start = Date.now()
  expect(wildcardMatch("a*".repeat(28) + "ab", "a".repeat(56))).toBe(false)
  expect(wildcardMatch("*a*".repeat(15) + "z", "a".repeat(100))).toBe(false)
  expect(wildcardMatch("*", "*anything")).toBe(true)
  const elapsed = Date.now() - start
  expect(elapsed).toBeLessThan(2_000)
})

test("wildcardMatch supports star and question semantics", () => {
  expect(wildcardMatch("*", "anything at all")).toBe(true)
  expect(wildcardMatch("shell git diff*", "shell git diff HEAD")).toBe(true)
  expect(wildcardMatch("shell git diff*", "shell git dif")).toBe(false)
  expect(wildcardMatch("git status?", "git status")).toBe(false)
  expect(wildcardMatch("git status?", "git status1")).toBe(true)
  expect(wildcardMatch("a*b*c", "a--b--c")).toBe(true)
  expect(wildcardMatch("a*b*c", "abc")).toBe(true)
  expect(wildcardMatch("a*b*c", "ab")).toBe(false)
  expect(wildcardMatch("", "")).toBe(true)
  expect(wildcardMatch("", "x")).toBe(false)
  expect(wildcardMatch("*x", "xx")).toBe(true)
})

test("debugAgents drains the JSON payload through a temp stdout file", async () => {
  const bigPayload = JSON.stringify([{ id: "master", system: "x".repeat(300_000) }, { id: "review-deep" }])
  const runner: ProcessRunner = {
    async run(_executable, args, _timeoutMs, _maxOutputBytes, options) {
      if (args[0] === "--version") return { code: 0, stdout: "opencode v2.0.4\n", stderr: "" }
      if (args.at(-1) !== "agents") return { code: 0, stdout: "unexpected", stderr: "" }
      if (!options?.stdoutFile) {
        // Simulate the OpenCode 2.0.3 pipe truncation.
        return { code: 0, stdout: bigPayload.slice(0, 320 * 1024), stderr: "" }
      }
      writeFileSync(options.stdoutFile, bigPayload)
      return { code: 0, stdout: bigPayload, stderr: "" }
    },
  }
  const client = await findOpenCode(runner)
  expect(await client.debugAgents()).toBe("master review-deep")
})

test("defaultProcessRunner writes file-redirected stdout completely", async () => {
  const root = mkdtempSync(join(tmpdir(), "gvozd-stdout-file-"))
  const stdoutFile = join(root, "out.txt")
  try {
    const result = await defaultProcessRunner.run(
      process.execPath,
      ["-e", `process.stdout.write('x'.repeat(200000) + 'tail')`],
      15_000,
      1024 * 1024,
      { stdoutFile },
    )
    expect(result.code).toBe(0)
    expect(result.stdout.length).toBe(200_004)
    expect(result.stdout.endsWith("tail")).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

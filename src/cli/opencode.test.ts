import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProcessRunner } from "./opencode"
import { defaultProcessRunner, findOpenCode, parseDebugPaths, parseOpenCodeVersion } from "./opencode"

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

  test("parses the complete version token", () => {
    expect(parseOpenCodeVersion("opencode2 v0.0.0-beta-19425\n")).toBe("0.0.0-beta-19425")
    expect(parseOpenCodeVersion("opencode2 v0.0.0-beta-194250\n")).toBe("0.0.0-beta-194250")
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
        if (args[0] === "--version") return { code: 0, stdout: "v0.0.0-beta-19425", stderr: "" }
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

import { spawn } from "node:child_process"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import { redactDiagnostic } from "../runtime-events"

const MAX_OUTPUT_BYTES = 64 * 1024
const AGENT_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * OpenCode 2.0.3 truncates `debug agents` stdout to ~320 KB when it is a pipe
 * (while a file or tty gets the full payload). Commands that return large
 * bodies therefore target a file instead of the pipe; the runner returns the
 * file contents as `stdout`.
 */
export interface ProcessRunOptions {
  /** Redirect child stdout to this file and return its contents as `stdout`. */
  stdoutFile?: string
}

export interface ProcessRunner {
  run(executable: string, args: readonly string[], timeoutMs?: number, maxOutputBytes?: number, options?: ProcessRunOptions): Promise<ProcessResult>
}

export interface OpenCodeClient {
  executable: string
  version(): Promise<string>
  debugPaths(): Promise<Record<string, string>>
  models(): Promise<string[]>
  pluginAdd(spec: string): Promise<void>
  pluginRemove(spec: string): Promise<void>
  pluginList(): Promise<string>
  pluginCheck(spec?: string): Promise<string>
  debugAgents(): Promise<string>
  serviceStatus(): Promise<string>
  serviceRestart(): Promise<void>
}

export const defaultProcessRunner: ProcessRunner = {
  run(executable, args, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES, options) {
    const stdoutFile = options?.stdoutFile
    const appendBounded = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= maxOutputBytes) return current
      const remaining = maxOutputBytes - Buffer.byteLength(current)
      return current + chunk.subarray(0, remaining).toString("utf8")
    }
    return new Promise((resolve, reject) => {
      const grouped = process.platform !== "win32"
      let stdoutFd: number | undefined
      try {
        if (stdoutFile) stdoutFd = openSync(stdoutFile, "w")
      } catch (error) {
        reject(error)
        return
      }
      const child = spawn(executable, [...args], {
        detached: grouped,
        shell: false,
        stdio: ["ignore", stdoutFile ? stdoutFd : "pipe", "pipe"],
      })
      // After spawn the child owns the write end; the parent's copy must be
      // closed so the child's output is not held open by this process.
      if (stdoutFd !== undefined) closeSync(stdoutFd)
      let stdout = ""
      let stderr = ""
      let settled = false
      let timedOut = false
      let forceKill: ReturnType<typeof setTimeout> | undefined
      let hardDeadline: ReturnType<typeof setTimeout> | undefined
      const terminate = (signal: NodeJS.Signals) => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {
          try { child.kill(signal) } catch {}
        }
      }
      const onStdout = (chunk: Buffer) => { stdout = appendBounded(stdout, chunk) }
      const onStderr = (chunk: Buffer) => { stderr = appendBounded(stderr, chunk) }
      const timeoutError = () => {
        const error = new Error(`OpenCode command timed out after ${timeoutMs}ms`) as Error & { code?: string }
        error.code = "ETIMEDOUT"
        return error
      }
      const clearTimers = () => {
        clearTimeout(timer)
        if (forceKill) clearTimeout(forceKill)
        if (hardDeadline) clearTimeout(hardDeadline)
      }
      const settleTimeout = (destroy: boolean) => {
        if (settled) return
        settled = true
        clearTimers()
        if (destroy) {
          child.stderr?.off("data", onStderr)
          child.stderr?.destroy()
          child.stdout?.off("data", onStdout)
          child.stdout?.destroy()
        }
        reject(timeoutError())
      }
      const timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        terminate("SIGTERM")
        forceKill = setTimeout(() => terminate("SIGKILL"), 500)
        forceKill.unref()
        hardDeadline = setTimeout(() => settleTimeout(true), 1_750)
        hardDeadline.unref()
      }, timeoutMs)
      timer.unref()

      if (child.stdout) child.stdout.on("data", onStdout)
      if (child.stderr) child.stderr.on("data", onStderr)
      child.once("error", (error) => {
        clearTimers()
        if (settled) return
        settled = true
        if (timedOut) {
          child.stderr?.off("data", onStderr)
          child.stderr?.destroy()
          child.stdout?.off("data", onStdout)
          child.stdout?.destroy()
        }
        reject(error)
      })
      child.once("close", (code) => {
        clearTimers()
        if (settled) return
        if (timedOut) {
          settleTimeout(false)
          return
        }
        settled = true
        const finish = (stdoutText: string) => resolve({ code: code ?? 1, stdout: stdoutText, stderr })
        if (stdoutFile) {
          // The child owns the write end; its exit guarantees the file is complete.
          try {
            finish(bounded(readFileSync(stdoutFile, "utf8"), maxOutputBytes))
          } catch (error) {
            reject(error)
          }
          return
        }
        finish(stdout)
      })
    })
  },
}

function bounded(value: string, maxOutputBytes = MAX_OUTPUT_BYTES): string {
  return Buffer.from(value).subarray(0, maxOutputBytes).toString("utf8")
}

async function checked(
  runner: ProcessRunner,
  executable: string,
  args: readonly string[],
  timeoutMs?: number,
  maxOutputBytes?: number,
  options?: ProcessRunOptions,
): Promise<string> {
  const result = await runner.run(executable, args, timeoutMs, maxOutputBytes, options)
  if (result.code !== 0) {
    const detail = redactDiagnostic(bounded(result.stderr).trim())
    throw new Error(`OpenCode command exited ${result.code}${detail ? `: ${detail}` : ""}`)
  }
  return bounded(result.stdout, maxOutputBytes)
}

export function parseDebugPaths(output: string): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z0-9_-]*)\s+(.+?)\s*$/i)
    if (!match) continue
    paths[match[1]!] = match[2]!
  }
  if (!paths.config || !isAbsolute(paths.config)) {
    throw new Error("OpenCode did not report an absolute config path")
  }
  return paths
}

export function parseOpenCodeVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|\s)/)?.[1]
}

/**
 * Checks a parsed semver against a supported range of the form "2.0.*"
 * (any patch within the major.minor) or an exact "2.0.2". Prerelease tags
 * never satisfy a range that omits one.
 */
export function satisfiesOpenCodeRange(version: string | undefined, range: string): boolean {
  if (!version) return false
  const [prerelease] = version.split("-").slice(1)
  if (prerelease) return false
  if (!range.includes("*")) return version === range
  const [rangeMajor, rangeMinor] = range.split(".").slice(0, 2)
  const [major, minor] = version.split(".").slice(0, 2)
  return major === rangeMajor && minor === rangeMinor
}

/**
 * OpenCode 2.0.2 `debug agents` prints the full agent definitions (prompts
 * included, hundreds of kilobytes), not the flat ID list older builds used.
 * The bounded CLI read cannot carry that payload, so collapse it to the
 * whitespace-separated agent IDs the doctor matcher expects.
 */
export function parseAgentIdentifiers(output: string): string {
  try {
    const parsed = JSON.parse(output) as unknown
    if (!Array.isArray(parsed)) return output.trim()
    return parsed
      .map((entry) => (entry && typeof entry === "object" && "id" in entry ? String((entry as { id: unknown }).id) : ""))
      .filter(Boolean)
      .join(" ")
  } catch {
    return output.trim()
  }
}

function createClient(executable: string, runner: ProcessRunner): OpenCodeClient {
  return {
    executable,
    async version() {
      return (await checked(runner, executable, ["--version"])).trim()
    },
    async debugPaths() {
      return parseDebugPaths(await checked(runner, executable, ["debug", "paths"]))
    },
    async models() {
      return (await checked(runner, executable, ["models"], 30_000)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    },
    async pluginAdd(spec) {
      await checked(runner, executable, ["plugin", "add", spec], 60_000)
    },
    async pluginRemove(spec) {
      await checked(runner, executable, ["plugin", "remove", spec])
    },
    pluginList() {
      return checked(runner, executable, ["plugin", "list"])
    },
    pluginCheck(spec) {
      return checked(runner, executable, spec ? ["plugin", "check", spec] : ["plugin", "check"], 30_000)
    },
    async debugAgents() {
      // OpenCode 2.0.3 truncates piped stdout, so drain the payload through a
      // temp file; the pipe budget would collapse the JSON before parsing.
      const directory = mkdtempSync(join(tmpdir(), "gvozd-agents-"))
      const stdoutFile = join(directory, "agents.out")
      try {
        const raw = await checked(runner, executable, ["debug", "agents"], 60_000, AGENT_OUTPUT_BYTES, { stdoutFile })
        return parseAgentIdentifiers(raw)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    serviceStatus() {
      return checked(runner, executable, ["service", "status"])
    },
    async serviceRestart() {
      await checked(runner, executable, ["service", "restart"], 30_000)
    },
  }
}

export async function findOpenCode(runner: ProcessRunner = defaultProcessRunner): Promise<OpenCodeClient> {
  const failures: string[] = []
  for (const executable of ["opencode2", "opencode"] as const) {
    try {
      await checked(runner, executable, ["--version"])
      return createClient(executable, runner)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`OpenCode V2 was not found. Tried opencode2 and opencode. ${failures.join("; ")}`)
}

import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"
import { redactDiagnostic } from "../runtime-events"

const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export interface ProcessRunner {
  run(executable: string, args: readonly string[], timeoutMs?: number): Promise<ProcessResult>
}

export interface OpenCodeClient {
  executable: string
  version(): Promise<string>
  debugPaths(): Promise<Record<string, string>>
  models(): Promise<string[]>
  pluginAdd(spec: string): Promise<void>
  pluginList(): Promise<string>
  pluginCheck(spec?: string): Promise<string>
  debugAgents(): Promise<string>
  serviceStatus(): Promise<string>
  serviceRestart(): Promise<void>
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current)
  return current + chunk.subarray(0, remaining).toString("utf8")
}

export const defaultProcessRunner: ProcessRunner = {
  run(executable, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const grouped = process.platform !== "win32"
      const child = spawn(executable, [...args], {
        detached: grouped,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
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
          child.stdout.off("data", onStdout)
          child.stderr.off("data", onStderr)
          child.stdout.destroy()
          child.stderr.destroy()
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

      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)
      child.once("error", (error) => {
        clearTimers()
        if (settled) return
        settled = true
        if (timedOut) {
          child.stdout.off("data", onStdout)
          child.stderr.off("data", onStderr)
          child.stdout.destroy()
          child.stderr.destroy()
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
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })
  },
}

function bounded(value: string): string {
  return Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES).toString("utf8")
}

async function checked(runner: ProcessRunner, executable: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  const result = await runner.run(executable, args, timeoutMs)
  if (result.code !== 0) {
    const detail = redactDiagnostic(bounded(result.stderr).trim())
    throw new Error(`OpenCode command exited ${result.code}${detail ? `: ${detail}` : ""}`)
  }
  return bounded(result.stdout)
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
    pluginList() {
      return checked(runner, executable, ["plugin", "list"])
    },
    pluginCheck(spec) {
      return checked(runner, executable, spec ? ["plugin", "check", spec] : ["plugin", "check"], 30_000)
    },
    debugAgents() {
      return checked(runner, executable, ["debug", "agents"])
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

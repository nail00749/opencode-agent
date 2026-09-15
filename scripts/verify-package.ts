import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { PACKAGE_VERSION } from "../src/core/release-metadata"
import { redactDiagnostic } from "../src/shared/runtime-events"

const MAX_OUTPUT_BYTES = 64 * 1024
const projectRoot = join(import.meta.dir, "..")
const temporary = mkdtempSync(join(tmpdir(), "agent-gvozd-package-verify-"))
const cache = join(temporary, "npm-cache")

function allowedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { npm_config_cache: cache }
  for (const name of [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT",
    "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function run(executable: string, args: readonly string[], cwd: string, label: string, timeout = 60_000): string {
  const result = spawnSync(executable, [...args], {
    cwd,
    env: allowedEnvironment(),
    shell: false,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL") {
      throw new Error(`${label} timed out after ${timeout}ms`)
    }
    throw new Error(`${label} failed to start: ${redactDiagnostic(result.error)}`)
  }
  if (result.status !== 0) {
    const detail = redactDiagnostic(result.stderr || "")
    throw new Error(`${label} exited ${result.status ?? "without status"}${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout || ""
}

try {
  const output = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], projectRoot, "npm package creation")
  const payload = JSON.parse(output) as Array<{ filename?: string; files?: Array<{ path: string }> }>
  const paths = payload[0]?.files?.map((file) => file.path).sort() ?? []
  const exact = new Set(["package.json", "README.md", "LICENSE"])
  const allowed = (path: string) => exact.has(path) || path.startsWith("dist/") || path.startsWith("defaults/")
  const unexpected = paths.filter((path) => !allowed(path))
  if (unexpected.length > 0) throw new Error(`Unexpected npm package files: ${unexpected.join(", ")}`)
  for (const required of ["dist/index.js", "dist/cli.js", "package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required)) throw new Error(`Required npm package file is missing: ${required}`)
  }

  const filename = payload[0]?.filename
  if (!filename) throw new Error("npm pack did not report an archive filename")
  const consumer = join(temporary, "consumer")
  mkdirSync(consumer)
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n')
  run("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", join(temporary, filename)], consumer, "isolated package installation", 120_000)
  const installed = join(consumer, "node_modules", "@nail00749", "agent-gvozd")
  const plugin = await import(pathToFileURL(join(installed, "dist", "index.js")).href)
  if (!plugin.default || plugin.default.id !== "agent-gvozd") throw new Error("Packed plugin import has an invalid default export")
  const version = run("node", [join(installed, "dist", "cli.js"), "--version"], consumer, "packed CLI version check").trim()
  if (version !== PACKAGE_VERSION) throw new Error(`Packed CLI reported unexpected version: ${redactDiagnostic(version)}`)
  console.log(`Verified and imported ${paths.length} npm package files`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

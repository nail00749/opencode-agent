import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { accessSync, constants, createReadStream, existsSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { PACKAGE_NAME, SUPPORTED_OPENCODE_VERSION } from "../src/release-metadata"
import { redactDiagnostic } from "../src/runtime-events"
import { computeProjectTrustToken, PROJECT_TRUST_ENV } from "../src/project-trust"

const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

function blocked(message: string): never {
  throw new Error(`BLOCKED: ${message}`)
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) blocked(`${name} must be provisioned by the protected gvozd-live environment`)
  return value
}

function validateDigest(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) blocked(`${name} must be an exact SHA-256 digest`)
  return value.toLowerCase()
}

interface FileIdentity {
  dev: number
  ino: number
  mode: number
  uid: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface AttestedFile {
  path: string
  label: string
  expectedDigest: string
  identity: FileIdentity
  policy: "protected-executable" | "workflow-package"
}

function identity(path: string, label: string): FileIdentity {
  if (!isAbsolute(path) || !existsSync(path)) blocked(`${label} must be an existing absolute path`)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) blocked(`${label} must be a regular non-symlink file`)
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", resolve)
  })
  return hash.digest("hex")
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function assertRunnerCannotWrite(path: string, label: string): void {
  const uid = process.getuid?.()
  if (uid === undefined) return
  if (uid === 0) blocked("the live gate runner must not run as root")
  let writable = true
  try {
    accessSync(path, constants.W_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") writable = false
    else blocked(`${label} changed while write access was being checked`)
  }
  if (writable) blocked(`${label} must not be writable by the runner`)
}

function validateProvisionedDirectoryChain(path: string, label: string): void {
  let current = resolve(path)
  while (true) {
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) blocked(`${label} must contain no symlink or non-directory components`)
    if ((stat.mode & 0o022) !== 0) blocked(`${label} must contain no group- or world-writable directories`)
    const uid = process.getuid?.()
    if (uid !== undefined && stat.uid === uid) blocked(`${label} must be owned by a trusted provisioner, not the runner`)
    assertRunnerCannotWrite(current, label)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function validateProtectedExecutable(path: string, label: string, current: FileIdentity): void {
  if (realpathSync(path) !== resolve(path)) blocked(`${label} path must be canonical and contain no symlink components`)
  validateProvisionedDirectoryChain(dirname(path), `${label} directory chain`)
  if ((current.mode & 0o222) !== 0) blocked(`${label} must have no owner, group, or world write bits`)
  if (process.platform !== "win32" && (current.mode & 0o111) === 0) blocked(`${label} must be executable`)
  try { accessSync(path, constants.X_OK) }
  catch { blocked(`${label} must be executable by the runner`) }
  const uid = process.getuid?.()
  if (uid !== undefined) {
    if (current.uid === uid) blocked(`${label} must be owned by a trusted provisioner, not the runner account`)
  }
  assertRunnerCannotWrite(path, label)
}

function validateWorkflowPackage(label: string, current: FileIdentity): void {
  if ((current.mode & 0o022) !== 0) blocked(`${label} must not be group- or world-writable`)
  const uid = process.getuid?.()
  if (uid !== undefined && current.uid !== uid) blocked(`${label} must be owned by the workflow runner account`)
}

async function inspectAttestedFile(
  path: string,
  expectedDigest: string,
  label: string,
  policy: AttestedFile["policy"],
): Promise<FileIdentity> {
  const before = identity(path, label)
  if (policy === "protected-executable") validateProtectedExecutable(path, label, before)
  else validateWorkflowPackage(label, before)
  if (await sha256(path) !== expectedDigest) {
    blocked(`${label} SHA-256 does not match its expected digest`)
  }
  const after = identity(path, label)
  if (!sameIdentity(before, after)) blocked(`${label} changed while its digest was being verified`)
  if (policy === "protected-executable") validateProtectedExecutable(path, label, after)
  else validateWorkflowPackage(label, after)
  return after
}

async function attestFile(
  path: string,
  expected: string,
  label: string,
  policy: AttestedFile["policy"],
): Promise<AttestedFile> {
  const expectedDigest = validateDigest(expected, `${label} digest`)
  return { path, label, expectedDigest, policy, identity: await inspectAttestedFile(path, expectedDigest, label, policy) }
}

async function revalidateAttestedFile(file: AttestedFile): Promise<void> {
  const current = await inspectAttestedFile(file.path, file.expectedDigest, file.label, file.policy)
  if (!sameIdentity(file.identity, current)) blocked(`${file.label} changed after initial attestation`)
}

function validateSafePath(value: string): string {
  const entries = value.split(delimiter)
  if (entries.length === 0 || entries.some((entry) => entry === "")) {
    blocked("GVOZD_LIVE_SAFE_PATH must contain only nonempty path entries")
  }
  for (const entry of entries) {
    if (!isAbsolute(entry) || !existsSync(entry)) blocked(`safe PATH entry must be an existing absolute directory: ${entry}`)
    if (realpathSync(entry) !== resolve(entry)) blocked(`safe PATH entry must be canonical and contain no symlink components: ${entry}`)
    validateProvisionedDirectoryChain(entry, `safe PATH entry ${entry}`)
  }
  return entries.join(delimiter)
}

function appendBounded(current: string, chunk: Buffer): string {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current)
  return remaining <= 0 ? current : current + chunk.subarray(0, remaining).toString("utf8")
}

async function run(
  executable: string,
  args: readonly string[],
  label: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32"
    const child = spawn(executable, [...args], { cwd, env, detached: grouped, shell: false, stdio: ["ignore", "pipe", "pipe"] })
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
    const timeoutError = () => Object.assign(new Error(`LIVE FAILURE: ${label} timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })
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
      reject(new Error(`LIVE FAILURE: ${label} could not ${timedOut ? "terminate" : "start"}: ${redactDiagnostic(error)}`))
    })
    child.once("close", (code) => {
      clearTimers()
      if (settled) return
      if (timedOut) {
        settleTimeout(false)
        return
      }
      settled = true
      if (code !== 0) reject(new Error(`LIVE FAILURE: ${label} exited ${code}${stderr ? `: ${redactDiagnostic(stderr)}` : ""}`))
      else resolve(stdout)
    })
  })
}

async function runAttested(
  file: AttestedFile,
  args: readonly string[],
  label: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  await revalidateAttestedFile(file)
  return run(file.path, args, label, cwd, env, timeoutMs)
}

if (process.env.GVOZD_LIVE !== "1") blocked("live compatibility is opt-in and requires GVOZD_LIVE=1")
const executable = required("GVOZD_LIVE_OPENCODE")
const executableDigest = required("GVOZD_LIVE_OPENCODE_SHA256")
const driver = required("GVOZD_LIVE_HOST_DRIVER")
const driverDigest = required("GVOZD_LIVE_HOST_DRIVER_SHA256")
const packagePath = required("GVOZD_LIVE_PACKAGE_PATH")
const packageDigest = required("GVOZD_LIVE_PACKAGE_SHA256")
const safePath = validateSafePath(required("GVOZD_LIVE_SAFE_PATH"))
if (!packagePath.endsWith(".tgz")) blocked("local package artifact must be an npm .tgz produced by the workflow")
const executableFile = await attestFile(executable, executableDigest, "OpenCode executable", "protected-executable")
const driverFile = await attestFile(driver, driverDigest, "host driver", "protected-executable")
const packageFile = await attestFile(packagePath, packageDigest, "local package artifact", "workflow-package")

const sandbox = mkdtempSync(join(tmpdir(), "agent-gvozd-live-"))
const home = join(sandbox, "home")
const xdg = join(sandbox, "xdg")
const project = join(sandbox, "project")
mkdirSync(home)
mkdirSync(xdg)
mkdirSync(join(project, ".git"), { recursive: true })
mkdirSync(join(project, ".opencode", "agents"), { recursive: true })
mkdirSync(join(project, "docs", ".gvozd"), { recursive: true })
mkdirSync(join(xdg, "opencode", "gvozd"), { recursive: true })
writeFileSync(join(project, ".opencode", "agents", "master.md"), '---\ndescription: "untransformed-live-agent"\nmode: primary\n---\n\nUntransformed prompt.\n')
writeFileSync(join(project, "docs", ".gvozd", "project-prompt.md"), "LIVE PROJECT OVERRIDE\n")
writeFileSync(join(project, "docs", ".gvozd", "config.jsonc"), JSON.stringify({ agents: { master: { description: "live-project-override", prompt: "project-prompt.md" } } }, null, 2))
writeFileSync(join(xdg, "opencode", "gvozd", "config.jsonc"), JSON.stringify({ agents: { master: { description: "live-global-override" } } }, null, 2))
const projectTrustToken = computeProjectTrustToken(project)

const environment: NodeJS.ProcessEnv = {
  PATH: safePath,
  HOME: home,
  XDG_CONFIG_HOME: xdg,
  TMPDIR: sandbox,
  TMP: sandbox,
  TEMP: sandbox,
  GVOZD_OPENCODE_CONFIG_ROOT: join(xdg, "opencode"),
  [PROJECT_TRUST_ENV]: projectTrustToken,
}

try {
  const version = await runAttested(executableFile, ["--version"], "OpenCode version check", project, environment)
  const reportedVersion = version.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|\s)/)?.[1]
  if (reportedVersion !== SUPPORTED_OPENCODE_VERSION) blocked(`expected exact OpenCode ${SUPPORTED_OPENCODE_VERSION}`)
  await revalidateAttestedFile(packageFile)
  await runAttested(executableFile, ["plugin", "add", packagePath], "local plugin installation", project, environment, 120_000)
  await runAttested(executableFile, ["service", "restart"], "OpenCode service restart", project, environment)
  const plugins = await runAttested(executableFile, ["plugin", "list"], "plugin activation check", project, environment)
  if (!plugins.includes(PACKAGE_NAME)) throw new Error(`LIVE FAILURE: ${PACKAGE_NAME} is not active after local artifact installation`)
  await revalidateAttestedFile(packageFile)
  await runAttested(executableFile, ["plugin", "check", packagePath], "plugin health check", project, environment)
  const paths = await runAttested(executableFile, ["debug", "paths"], "config path check", project, environment)
  if (!paths.includes(join(xdg, "opencode"))) throw new Error("LIVE FAILURE: OpenCode ignored the isolated config root")
  await revalidateAttestedFile(executableFile)
  const output = await runAttested(driverFile, [
    "--opencode", executable,
    "--project", project,
    "--config-root", join(xdg, "opencode"),
    "--expect-project-description", "live-project-override",
    "--expect-global-description", "live-global-override",
    "--scenarios", "edit-resource-mapping,mcp-refresh,lease-lifecycle",
  ], "trusted host integration driver", project, environment, 120_000)
  let result: Record<string, unknown>
  try { result = JSON.parse(output) as Record<string, unknown> }
  catch { throw new Error("LIVE FAILURE: host driver must emit one bounded JSON object") }
  for (const check of ["pluginActivation", "projectOverride", "editResourceMapping", "mcpRefresh", "leaseLifecycle"]) {
    if (result[check] !== true) throw new Error(`LIVE FAILURE: host driver did not prove ${check}`)
  }
  console.log(`Live OpenCode ${SUPPORTED_OPENCODE_VERSION} compatibility verified in an isolated sandbox`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

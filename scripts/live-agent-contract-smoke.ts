import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import type * as Service from "@opencode/client/service"
import { assertIdentity, awaitPlugin, isolatedEndpoint, locationQuery, request, sessionData } from "./live-native-claim-transport"
import { loadConfig } from "../src/core/config"
import { renderAgent } from "../src/core/agent-generation"
import { createExclusiveFile } from "../src/shared/fs"
import { secureCanonicalPath } from "../src/shared/secure-path"
import { redactDiagnostic } from "../src/shared/runtime-events"
import { appendBounded } from "../src/shared/text"

// Real installed host/catalog/tools; deterministic model and disposable local
// Git only. The rejection below is fixture input, not a real user rejection.
const temporaryBase = "/private/var/folders/c7/y5zsbttd01q68wnp_szwwqmm0000gn/T/opencode"
const executable = "/Users/nailuyltyev/.bun/bin/opencode"
const repository = resolve(import.meta.dir, "..")
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
check(process.platform === "darwin", "This installed-host smoke requires the macOS sandbox")
secureCanonicalPath(temporaryBase)
const root = mkdtempSync(join(temporaryBase, "agent-contract-"))
const project = join(root, "project")
const configRoot = join(root, "config", "opencode")
const profile = join(root, "sandbox.sb")
const trace = join(root, "git.trace")
const environment = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  TMPDIR: join(root, "tmp"), GVOZD_OPENCODE_CONFIG_ROOT: configRoot,
  OPENCODE_DISABLE_MODELS_FETCH: "true", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_TRACE: trace,
}
type Tool = { function: { name: string; description?: string; parameters: { properties?: Record<string, unknown> } } }
type Message = { role: string; content?: string | { text?: string }[] }
type Body = { tools?: Tool[]; messages: Message[] }
type Call = { name: string; arguments: Record<string, unknown> }
type Pending = { id: string; sessionID: string; action: string; resources: string[]; source?: { type: string } }
const stages = new Map<string, number>()
const observed = new Map<string, string[]>()
const completed = new Set<string>()
const forced = "git push --force-with-lease remote.git HEAD:main"
const paused = "git add fixture.txt"
let leasePath = ""
let leaseID = ""
let writerActive = false
let writerResponse: ServerResponse | undefined
let fixtureError: unknown
let host: ReturnType<typeof spawn> | undefined
let endpoint: Service.Endpoint | undefined
let logs = ""
let phase = "preparation"
let actualForceRequests = 0
let activeMutationRequests = 0
let normalApprovalRequests = 0
function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactDiagnostic(endpoint?.auth?.password ? message.replaceAll(endpoint.auth.password, "[redacted]") : message)
}
function text(message: Message): string {
  return typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("\n")
}
function result(body: Body): string { return text(body.messages.filter((message) => message.role === "tool").at(-1) ?? { role: "tool" }) }
function execute(code: string): Call { return { name: "execute", arguments: { code } } }
function shell(body: Body, command: string): Call {
  const tool = body.tools?.find((entry) => /(?:^|_)(?:shell|bash)$/.test(entry.function.name))
  const schema = tool?.function.parameters.properties ?? {}
  check(tool && "command" in schema, `Unsupported offered native shell schema: ${JSON.stringify(body.tools)}`)
  return { name: tool.function.name, arguments: { command, description: "Disposable contract smoke", ...( "workdir" in schema ? { workdir: project } : {}) } }
}
function child(body: Body, agent: string, marker: string): Call {
  const tool = body.tools?.find((entry) => entry.function.name === "subagent")
  check(tool && "agent" in (tool.function.parameters.properties ?? {}), "Native subagent catalog absent")
  return { name: tool.function.name, arguments: { agent, prompt: `CONTRACT_${marker}`, description: "Isolated agent contract smoke" } }
}
function git(...args: string[]): string {
  const ran = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/usr/bin/git", ...args], { cwd: project, env: environment, encoding: "utf8", timeout: 10_000 })
  check(ran.status === 0, `Disposable Git command failed: ${args[0]} ${diagnostic(ran.stderr)}`)
  return ran.stdout.trim()
}
function next(body: Body): Call | "hold" | undefined {
  const marker = [...body.messages.filter((message) => message.role === "user").map(text).join("\n").matchAll(/CONTRACT_(normal-parent|lease-parent|active-parent|normal|active|writer)/g)].at(-1)?.[1]
  if (!marker) { check(!body.tools?.length, "Unidentified primary model request"); return undefined }
  const stage = stages.get(marker) ?? 0
  check(stage < 9, "Fixture turn budget exceeded")
  stages.set(marker, stage + 1)
  observed.set(marker, (body.tools ?? []).map((entry) => entry.function.name))
  console.log(JSON.stringify({ scenario: marker, turn: stage, offeredTools: observed.get(marker) }))
  const previous = result(body)
  if (marker === "normal-parent" || marker === "active-parent") {
    if (stage === 0) return child(body, "git", marker === "normal-parent" ? "normal" : "active")
    check(completed.has(marker === "normal-parent" ? "normal" : "active"), "Git child scenario did not finish")
    completed.add(marker)
    return undefined
  }
  if (marker === "lease-parent") {
    if (stage === 0) return execute('return search({query:"gvozd lease",limit:10}).items.filter(({description}) => /reserve.*exact project files/i.test(description)).map(({path,description}) => ({path,description}))')
    if (stage === 1) {
      const found = previous.match(/"path"\s*:\s*"([^"\n]+)"/g) ?? []
      check(found.length === 1, "Lease catalog discovery was ambiguous")
      leasePath = JSON.parse(`{${found[0]}}`).path
      return execute(`return ${leasePath}({operation:"reserve",agent:"back-fast",label:"active writer smoke",files:["lease-target.txt"]})`)
    }
    if (stage === 2) {
      leaseID = previous.match(/"leaseId"\s*:\s*"([^"\n]+)"/)?.[1] ?? ""
      check(leaseID, "Native reservation returned no ID")
      return child(body, "back-fast", "writer")
    }
    completed.add(marker)
    return undefined
  }
  if (marker === "writer") {
    if (stage === 0) {
      check(observed.get(marker)?.includes("gvozd_claim"), "Writer native claim absent")
      return { name: "gvozd_claim", arguments: { leaseId: leaseID } }
    }
    check(previous.includes(leaseID) && previous.includes("active"), "Writer did not claim native lease")
    writerActive = true
    return "hold"
  }
  check(!observed.get(marker)?.includes("gvozd_claim"), "Git received writer claim")
  check(!observed.get(marker)?.some((name) => /(?:^|_)(?:edit|patch|write)$/.test(name)), "Readonly Git received native mutation tool")
  if (marker === "normal") {
    if (stage === 0) return shell(body, "git add fixture.txt")
    if (stage === 1) { check(git("diff", "--cached", "--name-only") === "fixture.txt", "Native Git staging failed"); return shell(body, "git commit -m fixture") }
    if (stage === 2) { check(git("log", "-1", "--format=%s") === "fixture", "Native Git commit failed"); return shell(body, "git push remote.git HEAD:main") }
    if (stage === 3) {
      check(git("rev-parse", "HEAD") === git("--git-dir=remote.git", "rev-parse", "refs/heads/main"), "Native local bare push failed")
      check(normalApprovalRequests === 0, "Ordinary Git required approval")
      return shell(body, forced)
    }
    check(stage === 4 && /reject|denied|not allowed|permission/i.test(previous), "Forced push rejection was not returned")
    check(actualForceRequests === 1, "Native forced push did not produce exactly one approval request")
    check(!readFileSync(trace, "utf8").includes("push --force"), "A forced push reached the actual Git executable")
    completed.add(marker)
    return undefined
  }
  check(writerActive, "Active Git scenario ran without active writer lease")
  if (stage === 0) return shell(body, "git status --short")
  if (stage === 1) { check(!/reject|denied/i.test(previous), "Active readonly baseline failed"); return shell(body, paused) }
  if (stage === 2) { check(/reject|denied|permission/i.test(previous), "Active ordinary mutation did not pause"); return shell(body, forced) }
  check(stage === 3 && /denied|not allowed|permission/i.test(previous), "Active forced push was not hard-denied")
  check(activeMutationRequests === 1 && actualForceRequests === 1, "Active lease escalation or never-escalate boundary changed")
  completed.add(marker)
  return undefined
}
function reply(response: ServerResponse, call?: Call): void {
  const delta = call ? { tool_calls: [{ index: 0, id: `fixture-${Date.now()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: "Contract smoke complete." }
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`)
}
const fixture = createServer(async (incoming, response) => {
  try {
    check(incoming.url === "/v1/chat/completions", "Unexpected model route")
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of incoming) { size += chunk.length; check(size <= 2_000_000, "Model request exceeds bound"); chunks.push(Buffer.from(chunk)) }
    const call = next(JSON.parse(Buffer.concat(chunks).toString()) as Body)
    if (call === "hold") { writerResponse = response; return }
    reply(response, call)
  } catch (error) { fixtureError ??= error; response.writeHead(500); response.end("Fixture assertion failed") }
})
async function api(path: string, method = "GET", body?: unknown, empty = false): Promise<any> {
  check(endpoint, "Disposable endpoint missing")
  return request(endpoint, path, method, body, empty, async (url, init) => {
    const response = await fetch(url, init)
    if (response.status !== 200 && response.status !== 204) {
      const detail = (await response.clone().text()).slice(0, 1_000)
      throw new Error(`Disposable host API ${url.pathname} returned ${response.status}: ${diagnostic(detail)}`)
    }
    return response
  })
}
async function pending(): Promise<Pending[]> {
  const value = await api(`/api/permission/request${locationQuery(project)}`)
  check(Array.isArray(value.data), "Unsupported host permission envelope")
  return value.data
}
async function wait(condition: () => boolean, allow: "none" | "force" | "active" = "none", timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (fixtureError) throw fixtureError
    check(host?.exitCode === null && Date.now() < deadline, `${phase} host exited or timed out`)
    for (const permission of await pending()) {
      const command = permission.resources.length === 1 ? permission.resources[0] : undefined
      check(permission.action === "shell" && permission.source?.type === "tool" && typeof command === "string", `Native permission omitted exact shell command resource/tool source: ${diagnostic(JSON.stringify(permission))}`)
      if (allow === "force" && command === forced) actualForceRequests++
      else if (allow === "active" && command === paused) activeMutationRequests++
      else { normalApprovalRequests++; throw new Error(`Unexpected permission request: ${permission.action} ${diagnostic(command)}`) }
      console.log(JSON.stringify({ approval: "exact native command rejected once", command, action: permission.action, resources: permission.resources }))
      await api(`/api/session/${permission.sessionID}/permission/${permission.id}/reply`, "POST", { decision: "reject", message: "Deterministic disposable fixture rejection; never retry" }, true)
    }
    await Bun.sleep(100)
  }
}
try {
  for (const path of [project, configRoot, environment.HOME, environment.XDG_DATA_HOME, environment.XDG_CACHE_HOME, environment.XDG_STATE_HOME, environment.TMPDIR, join(configRoot, "gvozd"), join(project, ".opencode", "agents")]) mkdirSync(path, { recursive: true, mode: 0o700 })
  createExclusiveFile(profile, `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "${root}") (literal "/dev/null")) (deny network*) (allow network* (local ip "localhost:*") (remote ip "localhost:*"))`)
  git("init", "-b", "main")
  git("init", "--bare", "remote.git")
  createExclusiveFile(join(project, "fixture.txt"), "baseline\n")
  createExclusiveFile(join(project, "lease-target.txt"), "lease baseline\n")
  const resolved = loadConfig(project, { configRoot, includeProject: false })
  const agents = ["master", "git", "back-fast"]
  for (const agent of agents) createExclusiveFile(join(project, ".opencode", "agents", `${agent}.md`), renderAgent(resolved.agents[agent]!, agent))
  await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done))
  const address = fixture.address()
  check(address && typeof address !== "string", "Loopback model listener missing")
  const registration = join(project, ".opencode", "plugins", "agent-gvozd")
  mkdirSync(registration, { recursive: true, mode: 0o700 })
  createExclusiveFile(join(registration, "package.json"), JSON.stringify({ type: "module", main: "index.js" }))
  createExclusiveFile(join(registration, "index.js"), `export { default } from ${JSON.stringify(join(repository, "dist", "index.js"))}\n`)
  createExclusiveFile(join(configRoot, "opencode.json"), JSON.stringify({ update: "disable", share: "disabled", snapshots: false, warming: false, plugins: [registration], providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "disposable-fixture" }, models: { fixture: { capabilities: { tools: true, input: ["text"], output: ["text"] } } } } }, model: "fixture/fixture" }))
  createExclusiveFile(join(configRoot, "gvozd", "config.jsonc"), JSON.stringify({ agents: Object.fromEntries(agents.map((agent) => [agent, { models: ["fixture/fixture"] }])) }))
  const versionResult = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, executable, "--version"], { cwd: project, env: environment, encoding: "utf8", timeout: 10_000 })
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`
  check(versionResult.status === 0 && /(?:^|\s)v?2\.0\.24(?:$|\s)/.test(versionOutput), `Required installed OpenCode 2.0.24 unavailable: ${diagnostic(versionOutput)}`)
  const version = "2.0.24"
  host = spawn("/usr/bin/sandbox-exec", ["-f", profile, executable, "serve", "--service", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: project, env: environment, stdio: ["ignore", "pipe", "pipe"] })
  host.stdout?.on("data", (chunk) => { logs = appendBounded(logs, chunk, 65_536) })
  host.stderr?.on("data", (chunk) => { logs = appendBounded(logs, chunk, 65_536) })
  host.once("error", (error) => { fixtureError ??= error })
  const serviceFile = join(environment.XDG_STATE_HOME, "opencode", "service.json")
  const deadline = Date.now() + 15_000
  while (!endpoint && Date.now() < deadline) {
    check(host.exitCode === null, "Disposable host exited before registration")
    if (existsSync(serviceFile)) { secureCanonicalPath(serviceFile); endpoint = isolatedEndpoint(JSON.parse(readFileSync(serviceFile, "utf8")), host.pid!, version) }
    if (!endpoint) await Bun.sleep(100)
  }
  check(endpoint, "Private service registration missing")
  assertIdentity(await api("/api/info"), host.pid!, version)
  await awaitPlugin(() => api(`/api/plugin${locationQuery(project)}`), () => check(host?.exitCode === null, "Host exited during activation"))
  // Source-proven against the installed executable's bundled protocol: unlike
  // the ambient protocol package, 2.0.24 requires {decision}, not {reply}.
  console.log(JSON.stringify({ preflight: "passed", hostVersion: version, confinement: "disposable macOS write-bound sandbox + loopback only", permissionRoutes: "installed executable bundled session.permission.reply payload decision: once/always/reject" }))
  async function prompt(marker: string): Promise<string> {
    const created = sessionData(await api("/api/session", "POST", { title: marker, agent: "master", model: { providerID: "fixture", id: "fixture" }, location: { directory: project } }))
    check(typeof created.id === "string", "Host session ID absent")
    await api(`/api/session/${created.id}/prompt`, "POST", { text: `CONTRACT_${marker}` })
    return created.id
  }
  // Evaluate the actual host force policy before allowing the model to issue
  // the native force tool call: this request never executes a command.
  const probe = sessionData(await api("/api/session", "POST", { title: "permission-only safety probe", agent: "git", model: { providerID: "fixture", id: "fixture" }, location: { directory: project } }))
  const forcePolicy = await api(`/api/session/${probe.id}/permission`, "POST", { agent: "git", action: "shell", resources: [forced], save: [] })
  check(forcePolicy.data?.effect === "ask", "Host force policy was not ask; refusing native force scenario")
  await api(`/api/session/${probe.id}/permission/${forcePolicy.data.id}/reply`, "POST", { decision: "reject" }, true)
  const editPolicy = await api(`/api/session/${probe.id}/permission`, "POST", { agent: "git", action: "edit", resources: [join(project, "fixture.txt")], save: [] })
  check(editPolicy.data?.effect === "deny" && readFileSync(join(project, "fixture.txt"), "utf8") === "baseline\n", "Host readonly edit guard failed")
  phase = "normal native staging commit local push and force ask/reject"
  const normal = await prompt("normal-parent")
  await wait(() => completed.has("normal-parent"), "force")
  await api(`/api/experimental/session/${normal}/wait`, "POST", {}, true)
  phase = "active writer native claim"
  const writer = await prompt("lease-parent")
  await wait(() => writerActive)
  phase = "active Git baseline pause and force deny"
  const active = await prompt("active-parent")
  await wait(() => completed.has("active-parent"), "active")
  await api(`/api/experimental/session/${active}/wait`, "POST", {}, true)
  check(writerResponse, "Held writer response missing")
  reply(writerResponse)
  writerResponse = undefined
  await wait(() => completed.has("lease-parent"))
  await api(`/api/experimental/session/${writer}/wait`, "POST", {}, true)
  check((await pending()).length === 0, "Pending fixture approvals left over")
  const executed = readFileSync(trace, "utf8")
  check(!executed.includes("push --force"), "Force reached actual Git executable")
  const stagingExecutions = [...executed.matchAll(/built-in: git add fixture\.txt(?:\n|$)/g)].length
  check(stagingExecutions === 1, "Rejected active staging was executed or normal staging trace missing")
  console.log(JSON.stringify({ result: "passed", hostVersion: version, normalApprovalRequests, actualForceRequests, activeMutationRequests, stagingExecutions, readonlyNativeEditCatalog: "absent", readonlyHostEditPermission: "deny", forceExecution: false, assertions: [...completed], productionMutations: false }))
} catch (error) {
  console.error(JSON.stringify({ result: "blocked", phase, diagnostic: diagnostic(error), completed: [...completed] }))
  for (const line of logs.split("\n").filter((line) => /error|failed/i.test(line)).slice(-5)) console.error(diagnostic(line))
  process.exitCode = 1
} finally {
  writerResponse?.destroy()
  if (host && host.exitCode === null) {
    const closed = new Promise<void>((done) => host!.once("close", () => done()))
    host.kill("SIGTERM")
    const timer = setTimeout(() => host?.kill("SIGKILL"), 1_000)
    await closed
    clearTimeout(timer)
  }
  fixture.closeAllConnections()
  await new Promise<void>((done) => fixture.close(() => done()))
  rmSync(root, { recursive: true, force: true })
  check(!existsSync(root), "Disposable cleanup failed")
  console.log(JSON.stringify({ cleanup: "passed", privateProjectConfigDataCacheStateHomeServiceRemoved: true, productionMutations: false }))
}

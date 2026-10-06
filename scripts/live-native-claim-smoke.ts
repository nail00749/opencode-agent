import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import * as Service from "@opencode/client/service"
import { assertIdentity, awaitPlugin, isolatedEndpoint, locationQuery, request, sessionData } from "./live-native-claim-transport"
import { loadConfig } from "../src/core/config"
import { renderAgent } from "../src/core/agent-generation"
import { createExclusiveFile } from "../src/shared/fs"
import { secureCanonicalPath } from "../src/shared/secure-path"
import { redactDiagnostic } from "../src/shared/runtime-events"
import { appendBounded } from "../src/shared/text"

// Installed-host acceptance, not a replacement catalog/lease implementation.
// The fixture supplies deterministic model replies; every tool runs in OpenCode.
const executable = "/Users/nailuyltyev/.bun/bin/opencode"
const temporaryBase = "/private/var/folders/c7/y5zsbttd01q68wnp_szwwqmm0000gn/T/opencode"
const repository = resolve(import.meta.dir, "..")
const agents = ["master", "cartographer", "docs", "back-fast", "explorer"] as const
const writers = ["cartographer", "docs", "back-fast"] as const
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
check(process.platform === "darwin", "This installed-host smoke requires the macOS sandbox")
secureCanonicalPath(temporaryBase)
const root = mkdtempSync(join(temporaryBase, "native-claim-"))
const project = join(root, "project")
const config = join(root, "config", "opencode")
const serviceFile = join(root, "state", "opencode", "service.json")
const environment = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  TMPDIR: join(root, "tmp"), GVOZD_OPENCODE_CONFIG_ROOT: config,
  OPENCODE_DISABLE_MODELS_FETCH: "true",
}
type Tool = { function: { name: string; description?: string; parameters: { properties?: Record<string, unknown> } } }
type Message = { role: string; content?: string | { type: string; text?: string }[] }
type ModelRequest = { tools?: Tool[]; messages: Message[] }
type Call = { name: string; arguments: Record<string, unknown> }
type Entry = { path: string; description: string }
const observed = new Map<string, string[]>()
const stages = new Map<string, number>()
const results = new Map<string, { claimed: boolean; denied: number; edited: boolean }>()
let foreign: Record<string, string> | undefined
let foreignResponse: ServerResponse | undefined
let leasePath = ""
let reservations: Record<string, { own: string; wrong: string }> | undefined
let fixtureError: unknown
let logs = ""
let host: ReturnType<typeof spawn> | undefined
let endpoint: Service.Endpoint | undefined
let phase = "fixture preparation"
function diagnostic(error: unknown): string {
  // Never print the disposable service registration or authentication headers.
  const message = error instanceof Error ? error.message : String(error)
  const password = endpoint?.auth?.password
  return redactDiagnostic(password ? message.replaceAll(password, "[redacted]") : message)
}
function text(message: Message): string {
  return typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("\n")
}
function lastResult(body: ModelRequest): string {
  return text(body.messages.filter((message) => message.role === "tool").at(-1) ?? { role: "tool" })
}
function objects(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return []
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(objects)]
}
function resultObjects(value: string): Record<string, unknown>[] {
  // Results may have a host-rendered prefix/fence. Parse JSON values without
  // evaluating model output; no session exports or ambient context are logged.
  const found: Record<string, unknown>[] = []
  for (let start = 0; start < value.length; start++) {
    if (value[start] !== "{" && value[start] !== "[") continue
    let depth = 0
    let quoted = false
    let escaped = false
    for (let end = start; end < value.length; end++) {
      const char = value[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === "{" || char === "[") depth++
      else if (char === "}" || char === "]") depth--
      if (depth !== 0) continue
      try { found.push(...objects(JSON.parse(value.slice(start, end + 1)))) } catch {}
      start = end
      break
    }
  }
  return found
}
function target(agent: string, outside = false): string {
  return join(project, "docs", ".gvozd", "knowledge", `${agent}-${outside ? "outside" : "reserved"}.md`)
}
function execute(code: string): Call { return { name: "execute", arguments: { code } } }
function mutation(body: ModelRequest, path: string, replacement: string): Call {
  const edit = body.tools?.find((tool) => /(?:^|_)edit$/.test(tool.function.name))
  check(edit, "Host did not offer its native edit tool")
  const schema = edit.function.parameters.properties ?? {}
  check("path" in schema && "oldString" in schema && "newString" in schema, `Unsupported offered native edit schema: ${JSON.stringify(schema)}`)
  return { name: edit.function.name, arguments: { path, oldString: "baseline", newString: replacement } }
}
function discoverPaths(result: string): void {
  const entries = resultObjects(result).filter((entry) => typeof entry.path === "string" && typeof entry.description === "string") as unknown as Entry[]
  leasePath = entries.find((entry) => /reserve.*exact project files/i.test(entry.description))?.path ?? ""
  check(leasePath, "Required lease catalog path missing")
  console.log(JSON.stringify({ catalog: "actual host search", leasePath }))
}
function subagent(body: ModelRequest, agent: string, prompt: string): Call {
  const tool = body.tools?.find((entry) => entry.function.name === "subagent")
  const schema = tool?.function.parameters.properties ?? {}
  check(tool && "agent" in schema && "prompt" in schema && "description" in schema, "Unsupported native subagent schema")
  return { name: tool.function.name, arguments: { agent, description: "native claim smoke", prompt } }
}
function next(body: ModelRequest): Call | "hold" | undefined {
  const userText = body.messages.filter((message) => message.role === "user").map(text).join("\n")
  const marker = [...userText.matchAll(/NATIVE_SMOKE_(foreign|master|cartographer|docs|back-fast|explorer)(?: LEASE (\S+) WRONG (\S+) FOREIGN (\S+))?/g)].at(-1)
  // Auxiliary title requests are not acceptance evidence and get plain text.
  if (!marker) { check(!body.tools?.length, "Unidentified primary fixture request"); return undefined }
  const agent = marker[1]!
  const stage = stages.get(agent) ?? 0
  check(stage < 12, "Fixture model turn budget exceeded")
  stages.set(agent, stage + 1)
  const names = (body.tools ?? []).map((tool) => tool.function.name)
  observed.set(agent, names)
  console.log(JSON.stringify({ scenario: agent, turn: stage, offeredTools: names }))
  const result = lastResult(body)
  if (agent === "master" || agent === "foreign") {
    check(names.includes("execute"), "Master gateway absent")
    if (stage === 0) return execute('return search({query:"gvozd lease",limit:10}).items.map(({path,description}) => ({path,description}))')
    if (stage === 1) discoverPaths(result)
    if (agent === "foreign") {
      if (stage === 1) {
        return execute(`return {foreign: {${writers.map((writer) => `${JSON.stringify(writer)}: await ${leasePath}({operation:"reserve",agent:${JSON.stringify(writer)},label:"foreign parent",files:[${JSON.stringify(`docs/.gvozd/knowledge/${writer}-foreign.md`)}]})`).join(",")}}}`)
      }
      const returned = resultObjects(result).find((value) => value.foreign)?.foreign
      check(returned && typeof returned === "object", `Foreign parent reservations failed: ${diagnostic(result)}`)
      foreign = Object.fromEntries(writers.map((writer) => {
        const lease = (returned as Record<string, { leaseId: string }>)[writer]
        check(lease?.leaseId, "Foreign parent reservation ID missing")
        return [writer, lease.leaseId]
      }))
      return "hold"
    }
    if (stage === 1) {
      check(foreign, "Foreign parent execution not live")
      return execute(`const reservations = {}; ${writers.map((writer) => {
        const wrongAgent = writer === "docs" ? "cartographer" : "docs"
        return `const own_${writer.replaceAll("-", "_")} = await ${leasePath}({operation:"reserve",agent:${JSON.stringify(writer)},label:"native smoke",files:[${JSON.stringify(`docs/.gvozd/knowledge/${writer}-reserved.md`)}]}); const wrong_${writer.replaceAll("-", "_")} = await ${leasePath}({operation:"reserve",agent:${JSON.stringify(wrongAgent)},label:"wrong assignee",files:[${JSON.stringify(`docs/.gvozd/knowledge/${writer}-decoy.md`)}]}); reservations[${JSON.stringify(writer)}] = {own: own_${writer.replaceAll("-", "_")}.leaseId, wrong: wrong_${writer.replaceAll("-", "_")}.leaseId};`
      }).join(" ")} return {reservations}`)
    }
    if (stage === 2) {
      reservations = resultObjects(result).find((entry) => entry.reservations)?.reservations as typeof reservations
      check(reservations && writers.every((writer) => reservations?.[writer]?.own && reservations[writer]?.wrong), "Native parent reservations missing")
    }
    const index = stage - 2
    if (index < writers.length) {
      const writer = writers[index]!
      check(reservations && foreign, "Native reservation state missing")
      return subagent(body, writer, `NATIVE_SMOKE_${writer} LEASE ${reservations[writer]!.own} WRONG ${reservations[writer]!.wrong} FOREIGN ${foreign[writer]}`)
    }
    if (index === writers.length) return subagent(body, "explorer", "NATIVE_SMOKE_explorer")
    check(writers.every((writer) => results.get(writer)?.edited), "Writer tasks did not complete")
    check(observed.has("explorer"), "Readonly task did not execute")
    return undefined
  }
  check(!names.includes("gvozd_lease"), `${agent} received coordinator reservation tool`)
  if (agent === "explorer") {
    check(!names.includes("gvozd_claim"), "Readonly agent received direct claim tool")
    return undefined
  }
  check(names.includes("gvozd_claim"), `${agent} direct native claim absent`)
  if (agent !== "back-fast") check(!names.includes("execute"), `${agent} received forbidden gateway`)
  else check(names.includes("execute"), "BackFast control gateway absent")
  const own = marker[2]
  const wrong = marker[3]
  const otherParent = marker[4]
  check(own && wrong && otherParent && ![own, wrong, otherParent].includes("undefined"), "Parent native reservations did not return IDs")
  const state = results.get(agent) ?? { claimed: false, denied: 0, edited: false }
  results.set(agent, state)
  if (stage === 0) return mutation(body, target(agent), "unclaimed write")
  if (stage === 1) {
    check(/denied|no active|permission|not allowed/i.test(result), "Preclaim native edit was not denied")
    check(readFileSync(target(agent), "utf8") === "baseline\n", "Preclaim edit changed target")
    state.denied++
    return { name: "gvozd_claim", arguments: { leaseId: wrong } }
  }
  if (stage === 2) {
    check(/assigned/i.test(result), `Wrong assignee claim did not fail: ${diagnostic(result)}`)
    state.denied++
    return { name: "gvozd_claim", arguments: { leaseId: otherParent } }
  }
  if (stage === 3) {
    check(/parent/i.test(result), `Wrong parent claim did not fail: ${diagnostic(result)}`)
    state.denied++
    return { name: "gvozd_claim", arguments: { leaseId: own } }
  }
  if (stage === 4) {
    check(/active/.test(result) && result.includes(own), `Native claim failed: ${diagnostic(result)}`)
    state.claimed = true
    return mutation(body, target(agent), "claimed write")
  }
  if (stage === 5) {
    check(readFileSync(target(agent), "utf8") === "claimed write\n", `Reserved native edit failed: ${diagnostic(result)}`)
    state.edited = true
    return mutation(body, target(agent, true), "outside write")
  }
  check(stage === 6, "Unexpected fixture model turn")
  check(/denied|outside|permission|not allowed|lease/i.test(result), "Outside native edit was not denied")
  check(readFileSync(target(agent, true), "utf8") === "baseline\n", "Outside edit changed target")
  state.denied++
  return undefined
}
function reply(response: ServerResponse, call?: Call): void {
  const delta = call ? { tool_calls: [{ index: 0, id: `fixture-${Date.now()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: "Native smoke scenario complete." }
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`)
}
const fixture = createServer(async (request, response) => {
  try {
    check(request.url === "/v1/chat/completions", "Unexpected fixture provider route")
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      check(size <= 2_000_000, "Fixture request exceeded limit")
      chunks.push(Buffer.from(chunk))
    }
    const call = next(JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest)
    if (call === "hold") { foreignResponse = response; return }
    reply(response, call)
  } catch (error) {
    fixtureError ??= error
    response.writeHead(500)
    response.end("deterministic fixture assertion failed")
  }
})
async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  check(address && typeof address !== "string", "Loopback listener missing")
  return address.port
}
async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  check(endpoint, "Disposable authenticated endpoint missing")
  return request(endpoint, path, method, body, path.endsWith("/wait"))
}
async function waitFor(condition: () => boolean, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (fixtureError) throw fixtureError
    check(host?.exitCode === null, "Disposable host exited unexpectedly")
    check(Date.now() < deadline, `${label} timed out`)
    await Bun.sleep(100)
  }
}
try {
  for (const path of [project, join(project, ".git"), config, environment.HOME, environment.XDG_DATA_HOME, environment.XDG_CACHE_HOME, environment.XDG_STATE_HOME, environment.TMPDIR, join(config, "gvozd"), join(project, ".opencode", "agents"), join(project, "docs", ".gvozd", "knowledge")]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const resolved = loadConfig(project, { configRoot: config, includeProject: false })
  for (const agent of agents) createExclusiveFile(join(project, ".opencode", "agents", `${agent}.md`), renderAgent(resolved.agents[agent]!))
  for (const writer of writers) for (const outside of [false, true]) createExclusiveFile(target(writer, outside), "baseline\n")
  const providerPort = await listen(fixture)
  createExclusiveFile(join(config, "opencode.json"), JSON.stringify({
    update: "disable", share: "disabled", snapshots: false, warming: false,
    plugins: [join(project, ".opencode", "plugins", "agent-gvozd")],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "disposable-fixture" }, models: { fixture: { capabilities: { tools: true, input: ["text"], output: ["text"] } } } } },
    model: "fixture/fixture",
  }))
  createExclusiveFile(join(config, "gvozd", "config.jsonc"), JSON.stringify({ agents: Object.fromEntries(agents.map((agent) => [agent, { models: ["fixture/fixture"] }])) }))
  // 2.0.24 resolves directory entrypoints using Node's resolver, which does
  // not infer index.ts. Keep this registration entirely inside the fixture.
  const registration = join(project, ".opencode", "plugins", "agent-gvozd")
  mkdirSync(registration, { recursive: true, mode: 0o700 })
  createExclusiveFile(join(registration, "package.json"), JSON.stringify({ type: "module", main: "index.js" }))
  createExclusiveFile(join(registration, "index.js"), `export { default } from ${JSON.stringify(join(repository, "dist", "index.js"))}\n`)
  const profile = join(root, "sandbox.sb")
  createExclusiveFile(profile, `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "${root}") (literal "/dev/null")) (deny network*) (allow network* (local ip "localhost:*") (remote ip "localhost:*"))`)
  const versionResult = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, executable, "--version"], { cwd: project, env: environment, encoding: "utf8", timeout: 10_000 })
  check(versionResult.status === 0, "Installed host version command failed")
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`
  const version = versionOutput.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?=$|\s)/)?.[1]
  check(version, `Installed host did not report its version: ${diagnostic(versionOutput)}`)
  phase = "authenticated service preflight"
  host = spawn("/usr/bin/sandbox-exec", ["-f", profile, executable, "serve", "--service", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: project, env: environment, stdio: ["ignore", "pipe", "pipe"] })
  host.stdout?.on("data", (chunk) => { logs = appendBounded(logs, chunk, 65_536) })
  host.stderr?.on("data", (chunk) => { logs = appendBounded(logs, chunk, 65_536) })
  host.once("error", (error) => { fixtureError ??= error })
  const deadline = Date.now() + 15_000
  while (!endpoint && Date.now() < deadline) {
    check(host.exitCode === null, "Disposable service exited before registration")
    if (existsSync(serviceFile)) {
      // Inspect only this private registration. Never use ensure(), stop(),
      // or fallback global discovery; the older SDK probes the wrong route.
      secureCanonicalPath(serviceFile)
      const info = JSON.parse(readFileSync(serviceFile, "utf8")) as { url: string; pid: number }
      const url = new URL(info.url)
      check(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname), "Disposable registration advertised non-loopback transport")
      check(info.pid === host.pid, "Disposable registration PID differs from spawned host")
      endpoint = isolatedEndpoint(info, host.pid!, version)
    }
    if (!endpoint) await Bun.sleep(100)
  }
  check(endpoint, "Private registration did not find the isolated service")
  const health = await api("/api/info")
  assertIdentity(health, host.pid!, version)
  const location = locationQuery(project)
  // Installed Plugin.list returns its initial [] before the background
  // supervisor activates. The GET endpoint is not an activation barrier.
  const active = await awaitPlugin(() => api(`/api/plugin${location}`), () => {
    if (fixtureError) throw fixtureError
    check(host?.exitCode === null, "Disposable host exited during activation")
  })
  const roster = await api(`/api/agent${location}`)
  for (const agent of agents) check(objects(roster).some((entry) => entry.id === agent || entry.name === agent), `Seeded host agent absent: ${agent}`)
  console.log(JSON.stringify({ preflight: "passed", hostVersion: version, healthPIDMatchesSpawn: true, plugin: { id: active.id, state: active.state, source: active.source }, seededAgents: agents, auth: "private registration + official Service.headers", identityRoute: "/api/info" }))
  async function prompt(title: string, marker: string): Promise<string> {
    const session = await api("/api/session", "POST", { title, agent: "master", model: { providerID: "fixture", id: "fixture" }, location: { directory: project } })
    const id = sessionData(session).id
    check(typeof id === "string", "Host session creation returned no ID")
    await api(`/api/session/${id}/prompt`, "POST", { text: marker })
    return id
  }
  phase = "foreign parent native reservations"
  await prompt("Foreign parent smoke", "NATIVE_SMOKE_foreign")
  await waitFor(() => foreign !== undefined, phase)
  phase = "native child claim and mutation assertions"
  const parentID = await prompt("Native claim smoke", "NATIVE_SMOKE_master")
  await waitFor(() => (stages.get("master") ?? 0) >= 7, phase, 60_000)
  for (const writer of writers) check(results.get(writer)?.claimed && results.get(writer)?.edited && results.get(writer)?.denied === 4, `${writer} native assertions incomplete`)
  check(observed.has("explorer"), "Readonly native visibility assertion incomplete")
  if (foreignResponse) { reply(foreignResponse); foreignResponse = undefined }
  await api(`/api/experimental/session/${parentID}/wait`, "POST", {})
  console.log(JSON.stringify({ result: "passed", hostVersion: version, offeredTools: Object.fromEntries(observed), nativeResults: Object.fromEntries(results), asserted: ["parent native reservation", "direct claim", "strict roles no execute", "preclaim edit denied unchanged", "wrong assignee denied", "wrong parent denied", "reserved native edit succeeded", "out-of-lease denied unchanged", "BackFast control", "readonly no claim"] }))
} catch (error) {
  console.error(JSON.stringify({ result: "blocked", phase, diagnostic: diagnostic(error), observedTools: Object.fromEntries(observed), completedAssertions: Object.fromEntries(results) }))
  for (const line of logs.split("\n").filter((line) => /error|failed/i.test(line)).slice(-5)) console.error(diagnostic(line))
  process.exitCode = 1
} finally {
  foreignResponse?.destroy()
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
  check(!existsSync(root), "Disposable host cleanup failed")
  console.log(JSON.stringify({ cleanup: "passed", disposableProjectConfigDataCacheStateHomeServiceRemoved: true, productionMutations: false }))
}

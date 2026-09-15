import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const PERMISSION_ERROR_PATTERN = /permission|denied|rejected/i
const MAX_TEXT_LENGTH = 4000
const MAX_SUMMARY_LENGTH = 200
const MAX_ERROR_LENGTH = 160

/** One tool call distilled from an assistant message part. */
export interface AnalyzedToolCall {
  readonly tool: string
  readonly status: string
  /** Primary human summary: command, file path, pattern, or URL. */
  readonly summary: string
  readonly error?: string
  /** True when the failure looks permission-related. */
  readonly permission: boolean
  readonly time: number
}

/** One conversation turn in the report. */
export interface AnalyzedEntry {
  readonly kind: "user" | "assistant" | "system" | "synthetic" | "skill" | "shell" | "other"
  readonly id: string
  readonly time: number
  /** Agent that produced an assistant message. */
  readonly agent?: string
  /** Model ref rendered as provider/model. */
  readonly model?: string
  /** Message text (user input or assistant output). */
  readonly text?: string
  /** Skill activated by a skill message. */
  readonly skill?: string
  /** Direct command from a shell message. */
  readonly command?: string
  readonly tools: readonly AnalyzedToolCall[]
}

/** Permission-relevant failures grouped by tool. */
export interface AnalyzedPermissionDenial {
  readonly tool: string
  readonly count: number
  readonly samples: readonly string[]
}

export interface AnalyzedSession {
  readonly id: string
  readonly title: string
  readonly agent?: string
  readonly model?: string
  readonly parentID?: string
  readonly projectID: string
  readonly outcome?: string
  readonly cost: number
  readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number }
  readonly time: { readonly created: number; readonly updated: number }
  readonly entries: readonly AnalyzedEntry[]
  readonly toolCounts: Readonly<Record<string, number>>
  readonly totalToolCalls: number
  readonly errors: readonly { tool: string; message: string; permission: boolean; time: number }[]
  /** Tool failures that look permission-related, grouped by tool. */
  readonly permissionDenials: readonly AnalyzedPermissionDenial[]
}

/** Minimal structural view of the server's session info response. */
export interface AnalyzedSessionInfo {
  readonly id: string
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly providerID?: string; readonly id?: string }
  readonly parentID?: string
  readonly projectID: string
  readonly outcome?: string
  readonly cost?: number
  readonly tokens?: {
    readonly input?: number
    readonly output?: number
    readonly cache?: { readonly read?: number }
  }
  readonly time?: { readonly created?: number; readonly updated?: number }
}

/** Minimal structural view of one message from the server's message list. */
export interface AnalyzedMessage {
  readonly id: string
  readonly type: string
  readonly time?: { readonly created?: number }
  readonly text?: string
  readonly agent?: string
  readonly model?: { readonly providerID?: string; readonly id?: string }
  readonly skill?: string
  readonly name?: string
  readonly command?: string
  readonly content?: readonly {
    readonly type: string
    readonly name?: string
    readonly text?: string
    readonly state?: {
      readonly status?: string
      readonly input?: Record<string, unknown>
      readonly error?: unknown
    }
    readonly time?: { readonly created?: number }
  }[]
}

/** Extracts the primary human summary from a tool call input. */
export function toolSummary(input: Record<string, unknown>): string {
  const command = input.command
  if (typeof command === "string") return command.replace(/\s+/g, " ").trim()
  for (const key of ["filePath", "path", "file", "url", "pattern", "query", "skill", "description"]) {
    const value = input[key]
    if (typeof value === "string" && value !== "") return value
  }
  return ""
}

export function analyzeToolCall(part: {
  name?: string
  state?: { status?: string; input?: Record<string, unknown>; error?: unknown }
  time?: { created?: number }
}): AnalyzedToolCall {
  const input = part.state?.input ?? {}
  const rawError = part.state?.error
  const message = typeof rawError === "string"
    ? rawError
    : (rawError as { message?: string } | undefined)?.message ?? ""
  const errorType = (rawError as { type?: string } | undefined)?.type ?? ""
  const error = message === "" ? undefined : message.replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH)
  return {
    tool: part.name ?? "(unknown)",
    status: part.state?.status ?? "unknown",
    summary: toolSummary(input).slice(0, MAX_SUMMARY_LENGTH),
    error,
    permission: PERMISSION_ERROR_PATTERN.test(`${errorType} ${message}`),
    time: part.time?.created ?? 0,
  }
}

function collectEntries(messages: readonly AnalyzedMessage[]): AnalyzedEntry[] {
  const entries: AnalyzedEntry[] = []
  for (const message of messages) {
    const tools: AnalyzedToolCall[] = []
    let text: string | undefined
    if (message.type === "assistant") {
      for (const part of message.content ?? []) {
        if (part.type === "tool") tools.push(analyzeToolCall(part))
        else if (part.type === "text" && typeof part.text === "string" && part.text !== "") {
          text = text === undefined ? part.text : `${text}\n${part.text}`
        }
      }
    } else if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
      text = message.text
    } else if (message.type === "skill") {
      text = message.text
    }
    const kind = message.type === "assistant" || message.type === "user" || message.type === "system"
      || message.type === "synthetic" || message.type === "skill" || message.type === "shell"
      ? message.type
      : "other"
    entries.push({
      kind,
      id: message.id,
      time: message.time?.created ?? 0,
      agent: message.agent,
      model: message.model ? `${message.model.providerID ?? ""}/${message.model.id ?? ""}` : undefined,
      text: text === undefined ? undefined : text.slice(0, MAX_TEXT_LENGTH),
      skill: message.type === "skill" ? message.name || message.skill : undefined,
      command: message.type === "shell" ? message.command : undefined,
      tools,
    })
  }
  return entries
}

export function collectPermissionDenials(entries: readonly AnalyzedEntry[]): AnalyzedPermissionDenial[] {
  const byTool = new Map<string, { count: number; samples: Set<string> }>()
  for (const entry of entries) {
    for (const call of entry.tools) {
      if (call.status !== "error" || !call.permission) continue
      const current = byTool.get(call.tool) ?? { count: 0, samples: new Set<string>() }
      current.count += 1
      current.samples.add(call.summary === "" ? "(no input)" : call.summary)
      byTool.set(call.tool, current)
    }
  }
  return [...byTool.entries()]
    .map(([tool, value]) => ({ tool, count: value.count, samples: [...value.samples].slice(0, 5) }))
    .sort((left, right) => right.count - left.count || left.tool.localeCompare(right.tool))
}

export function analyzeSession(info: AnalyzedSessionInfo, messages: readonly AnalyzedMessage[]): AnalyzedSession {
  const entries = collectEntries(messages)
  const toolCounts = new Map<string, number>()
  const errors: { tool: string; message: string; permission: boolean; time: number }[] = []
  for (const entry of entries) {
    for (const call of entry.tools) {
      toolCounts.set(call.tool, (toolCounts.get(call.tool) ?? 0) + 1)
      if (call.status === "error") {
        errors.push({ tool: call.tool, message: call.error ?? "", permission: call.permission, time: call.time })
      }
    }
  }
  errors.sort((left, right) => right.time - left.time)
  const tokens = info.tokens ?? {}
  return {
    id: info.id,
    title: info.title ?? "(untitled)",
    agent: info.agent,
    model: info.model ? `${info.model.providerID ?? ""}/${info.model.id ?? ""}` : undefined,
    parentID: info.parentID,
    projectID: info.projectID,
    outcome: info.outcome,
    cost: info.cost ?? 0,
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
    },
    time: { created: info.time?.created ?? 0, updated: info.time?.updated ?? 0 },
    entries,
    toolCounts: Object.fromEntries(
      [...toolCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    ),
    totalToolCalls: [...toolCounts.values()].reduce((sum, count) => sum + count, 0),
    errors: errors.slice(0, 20),
    permissionDenials: collectPermissionDenials(entries),
  }
}

function headerLines(session: AnalyzedSession): string[] {
  const lines = [
    `# Session: ${session.title}`,
    "",
    `- **Session ID**: \`${session.id}\``,
    `- **Project**: \`${session.projectID}\``,
  ]
  if (session.agent) lines.push(`- **Primary agent**: ${session.agent}`)
  if (session.model) lines.push(`- **Model**: ${session.model}`)
  if (session.parentID) lines.push(`- **Parent session**: \`${session.parentID}\``)
  if (session.outcome) lines.push(`- **Outcome**: ${session.outcome}`)
  lines.push(`- **Time**: ${new Date(session.time.created).toISOString()} → ${new Date(session.time.updated).toISOString()}`)
  lines.push(`- **Cost**: $${session.cost.toFixed(2)} (input ${session.tokens.input}, output ${session.tokens.output}, cache read ${session.tokens.cacheRead})`)
  lines.push(`- **Tool calls**: ${session.totalToolCalls}`)
  return lines
}

function usageLines(session: AnalyzedSession): string[] {
  const tools = Object.entries(session.toolCounts)
  if (tools.length === 0) return []
  return ["", "## Tool usage", "", ...tools.map(([tool, count]) => `- ${tool}: ${count}`)]
}

function errorLines(session: AnalyzedSession): string[] {
  if (session.errors.length === 0) return []
  return [
    "",
    "## Errors",
    "",
    ...session.errors.map((error) => `- \`${error.tool}\`${error.permission ? " (permission)" : ""}: ${error.message}`),
  ]
}

function denialLines(session: AnalyzedSession): string[] {
  if (session.permissionDenials.length === 0) return []
  return [
    "",
    "## Permission denials",
    "",
    ...session.permissionDenials.map((denial) =>
      `- \`${denial.tool}\` ×${denial.count}: ${denial.samples.join(" | ")}`),
  ]
}

function timelineLines(session: AnalyzedSession): string[] {
  const lines = ["", "## Timeline", ""]
  for (const entry of session.entries) {
    const time = new Date(entry.time).toISOString()
    if (entry.kind === "user") {
      lines.push(`### user · ${time}`, "", entry.text ?? "(no text)", "")
      continue
    }
    if (entry.kind === "assistant") {
      lines.push(`### assistant${entry.agent ? ` (${entry.agent})` : ""} · ${time}`)
      if (entry.model) lines.push("", `Model: ${entry.model}`)
      lines.push("")
      for (const call of entry.tools) {
        const status = call.status === "completed" ? "✓" : call.status === "error" ? "✗" : "…"
        lines.push(`- ${status} \`${call.tool}\`${call.summary ? ` — ${call.summary}` : ""}${call.error ? ` → ${call.error}` : ""}`)
      }
      if (entry.text !== undefined) lines.push("", entry.text, "")
      continue
    }
    if (entry.kind === "skill") {
      lines.push(`- skill \`${entry.skill ?? "?"}\` · ${time}`)
      continue
    }
    if (entry.kind === "shell") {
      lines.push(`- shell: ${entry.command ?? "(no command)"} · ${time}`)
      continue
    }
    lines.push(`- ${entry.kind} · ${time}`)
  }
  return lines
}

/** Renders the analyzed session as a Markdown report for agents and humans. */
export function renderAnalyzeMarkdown(session: AnalyzedSession): string {
  return [
    ...headerLines(session),
    ...usageLines(session),
    ...errorLines(session),
    ...denialLines(session),
    ...timelineLines(session),
    "",
  ].join("\n")
}

export function reportPath(directory: string, sessionID: string, format: "markdown" | "json"): string {
  return join(directory, `gvozd-${sessionID}.${format === "markdown" ? "md" : "json"}`)
}

/** Writes the report file and returns its path. */
export function writeAnalyzeReport(directory: string, session: AnalyzedSession, format: "markdown" | "json"): string {
  mkdirSync(directory, { recursive: true })
  const path = reportPath(directory, session.id, format)
  const body = format === "markdown" ? renderAnalyzeMarkdown(session) : `${JSON.stringify(session, null, 2)}\n`
  writeFileSync(path, body)
  return path
}

export interface OpenCodeApi {
  /** Fetches one parsed JSON payload from the OpenCode HTTP API. */
  apiJson(path: string): Promise<unknown>
}

const MESSAGE_PAGE_SIZE = 200
const MAX_PAGES = 200

/** Fetches every message page for a session, oldest first. */
export async function fetchSessionMessages(api: OpenCodeApi, sessionID: string): Promise<AnalyzedMessage[]> {
  const all: AnalyzedMessage[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    // The cursor carries its own order; the API rejects cursor+order.
    const query = new URLSearchParams(page === 0 ? { limit: String(MESSAGE_PAGE_SIZE), order: "asc" } : { limit: String(MESSAGE_PAGE_SIZE), cursor: cursor! })
    const payload = await api.apiJson(`/api/session/${encodeURIComponent(sessionID)}/message?${query.toString()}`)
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new Error(`OpenCode returned an unexpected message payload for ${sessionID}`)
    }
    const { data, cursor: next } = payload as { data: AnalyzedMessage[]; cursor?: { next?: string | null } }
    all.push(...data)
    cursor = next?.next ?? undefined
    if (!cursor) return all
  }
  throw new Error(`OpenCode session ${sessionID} exceeds the ${MAX_PAGES * MESSAGE_PAGE_SIZE} message analyze limit`)
}

/** Fetches session metadata or fails with a recognizable error. */
export async function fetchSessionInfo(api: OpenCodeApi, sessionID: string): Promise<AnalyzedSessionInfo> {
  const payload = await api.apiJson(`/api/session/${encodeURIComponent(sessionID)}`)
  const info = (payload as { data?: AnalyzedSessionInfo }).data
  if (typeof info !== "object" || info === null || typeof info.id !== "string") {
    throw new Error(`OpenCode session not found: ${sessionID}`)
  }
  return info
}
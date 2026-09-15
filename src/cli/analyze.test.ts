import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  analyzeSession,
  analyzeToolCall,
  fetchSessionMessages,
  fetchSessionInfo,
  reportPath,
  renderAnalyzeMarkdown,
  toolSummary,
  writeAnalyzeReport,
  type AnalyzedMessage,
  type AnalyzedSessionInfo,
  type OpenCodeApi,
} from "./analyze"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "gvozd-analyze-"))
  roots.push(root)
  return root
}

const info: AnalyzedSessionInfo = {
  id: "ses_test123",
  title: "Refactor layers",
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6-sol" },
  projectID: "proj_1",
  outcome: "succeeded",
  cost: 2.5,
  tokens: { input: 1000, output: 200, cache: { read: 5000 } },
  time: { created: Date.UTC(2026, 8, 15, 10, 0, 0), updated: Date.UTC(2026, 8, 15, 12, 0, 0) },
}

function userMessage(text: string): AnalyzedMessage {
  return { id: "msg_u1", type: "user", time: { created: Date.UTC(2026, 8, 15, 10, 0, 1) }, text }
}

function assistantMessage(tools: AnalyzedMessage["content"], textParts?: string[]): AnalyzedMessage {
  return {
    id: "msg_a1",
    type: "assistant",
    time: { created: Date.UTC(2026, 8, 15, 10, 0, 2) },
    agent: "back-fast",
    model: { providerID: "openai", id: "gpt-5.6-luna" },
    content: [
      ...(tools ?? []),
      ...(textParts?.map((text) => ({ type: "text", text })) ?? []),
    ],
  }
}

describe("toolSummary", () => {
  test("prefers the command and collapses whitespace", () => {
    expect(toolSummary({ command: "bun   test\n  src/x" })).toBe("bun test src/x")
  })

  test("falls through path-like keys and returns empty for opaque inputs", () => {
    expect(toolSummary({ filePath: "src/a.ts", other: 1 })).toBe("src/a.ts")
    expect(toolSummary({ nested: { deep: true } })).toBe("")
  })
})

describe("analyzeToolCall", () => {
  test("distills status, summary, and timing", () => {
    const call = analyzeToolCall({
      name: "shell",
      state: { status: "completed", input: { command: "bun test" } },
      time: { created: 1234 },
    })
    expect(call.tool).toBe("shell")
    expect(call.status).toBe("completed")
    expect(call.summary).toBe("bun test")
    expect(call.permission).toBe(false)
    expect(call.time).toBe(1234)
  })

  test("flags permission-shaped errors from message text and error type", () => {
    const denied = analyzeToolCall({
      name: "shell",
      state: { status: "error", input: { command: "git push" }, error: { message: "denied by lease enforcement" } },
    })
    expect(denied.permission).toBe(true)
    const plain = analyzeToolCall({
      name: "shell",
      state: { status: "error", input: { command: "exit 1" }, error: { message: "exit code 1" } },
    })
    expect(plain.permission).toBe(false)
  })

  test("keeps structured error messages bounded", () => {
    const call = analyzeToolCall({
      name: "edit",
      state: { status: "error", input: {}, error: { message: "x".repeat(400) } },
    })
    expect(call.error?.length).toBe(160)
  })
})

describe("collectPermissionDenials", () => {
  test("groups permission failures by tool with bounded samples", () => {
    const entries = analyzeSession(info, [
      userMessage("go"),
      assistantMessage([
        { type: "tool", name: "shell", state: { status: "error", input: { command: "git reset --hard" }, error: { message: "denied: destructive git" } } },
        { type: "tool", name: "shell", state: { status: "error", input: { command: "git clean" }, error: { message: "denied: destructive git" } } },
        { type: "tool", name: "shell", state: { status: "error", input: { command: "rm -rf /" }, error: { message: "exit code 1" } } },
      ]),
    ]).permissionDenials
    expect(entries).toEqual([{ tool: "shell", count: 2, samples: ["git reset --hard", "git clean"] }])
  })
})

describe("analyzeSession", () => {
  test("counts tools, collects errors newest-first, and renders entries", () => {
    const session = analyzeSession(info, [
      userMessage("давай рефактор"),
      assistantMessage([
        { type: "tool", name: "read", state: { status: "completed", input: { filePath: "src/a.ts" } } },
        { type: "tool", name: "edit", state: { status: "completed", input: { filePath: "src/a.ts" } } },
      ], ["Done"]),
      assistantMessage([
        { type: "tool", name: "shell", state: { status: "error", input: { command: "bun test" }, error: { message: "exit code 1" } } },
      ]),
    ])
    expect(session.title).toBe("Refactor layers")
    expect(session.toolCounts).toEqual({ read: 1, edit: 1, shell: 1 })
    expect(session.totalToolCalls).toBe(3)
    expect(session.errors).toHaveLength(1)
    expect(session.errors[0]?.tool).toBe("shell")
    expect(session.entries[0]?.kind).toBe("user")
    expect(session.entries[0]?.text).toBe("давай рефактор")
    expect(session.entries[1]?.agent).toBe("back-fast")
    expect(session.entries[1]?.model).toBe("openai/gpt-5.6-luna")
    expect(session.cost).toBe(2.5)
    expect(session.tokens.cacheRead).toBe(5000)
  })

  test("bounds oversized text", () => {
    const long = "x".repeat(10_000)
    const session = analyzeSession(info, [userMessage(long)])
    expect(session.entries[0]?.text?.length).toBe(4000)
  })
})

describe("renderAnalyzeMarkdown", () => {
  test("renders header, usage, denials, and a timeline", () => {
    const session = analyzeSession(info, [
      userMessage("почему тесты падают"),
      assistantMessage([
        { type: "tool", name: "shell", state: { status: "error", input: { command: "bun test" }, error: { message: "denied: destructive git" } } },
      ], ["found it"]),
    ])
    const markdown = renderAnalyzeMarkdown(session)
    expect(markdown).toContain("# Session: Refactor layers")
    expect(markdown).toContain("- **Session ID**: `ses_test123`")
    expect(markdown).toContain("## Tool usage")
    expect(markdown).toContain("## Permission denials")
    expect(markdown).toContain("`shell` ×1: bun test")
    expect(markdown).toContain("### user ·")
    expect(markdown).toContain("почему тесты падают")
    expect(markdown).toContain("### assistant (back-fast) ·")
    expect(markdown).toContain("- ✗ `shell` — bun test → denied: destructive git")
    expect(markdown).toContain("found it")
  })

  test("omits empty sections", () => {
    const markdown = renderAnalyzeMarkdown(analyzeSession(info, [userMessage("hi")]))
    expect(markdown).not.toContain("## Errors")
    expect(markdown).not.toContain("## Tool usage")
    expect(markdown).not.toContain("## Permission denials")
  })
})

describe("fetchSessionInfo and fetchSessionMessages", () => {
  function apiWith(responses: Record<string, unknown>): OpenCodeApi {
    return {
      async apiJson(path) {
        const hit = responses[path]
        if (hit === undefined) throw new Error(`unexpected path ${path}`)
        return hit
      },
    }
  }

  test("fetches session info and unwraps the data envelope", async () => {
    const info2 = await fetchSessionInfo(apiWith({ "/api/session/ses_x": { data: info } }), "ses_x")
    expect(info2.id).toBe("ses_test123")
    await expect(fetchSessionInfo(apiWith({ "/api/session/ses_x": { data: null } }), "ses_x")).rejects.toThrow("not found")
  })

  test("follows cursors across pages oldest-first", async () => {
    const page1 = {
      data: [{ id: "msg_1", type: "user" }],
      cursor: { next: "cursor-2" },
    }
    const page2 = {
      data: [{ id: "msg_2", type: "assistant" }],
      cursor: { next: null },
    }
    const api = apiWith({
      "/api/session/ses_x/message?limit=200&order=asc": page1,
      "/api/session/ses_x/message?limit=200&cursor=cursor-2": page2,
    })
    const messages = await fetchSessionMessages(api, "ses_x")
    expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
  })

  test("rejects an unexpected payload shape", async () => {
    await expect(fetchSessionMessages(apiWith({ "/api/session/ses_x/message?limit=200&order=asc": { nope: true } }), "ses_x"))
      .rejects.toThrow("unexpected message payload")
  })
})

describe("writeAnalyzeReport", () => {
  test("writes markdown by default-named path and returns it", () => {
    const directory = workspace()
    const session = analyzeSession(info, [userMessage("hi")])
    const path = writeAnalyzeReport(directory, session, "markdown")
    expect(path).toBe(reportPath(directory, "ses_test123", "markdown"))
    expect(existsSync(path)).toBe(true)
    const body = readFileSync(path, "utf8")
    expect(body).toContain("# Session: Refactor layers")
  })

  test("writes a JSON report when requested", () => {
    const directory = workspace()
    const session = analyzeSession(info, [userMessage("hi")])
    const path = writeAnalyzeReport(directory, session, "json")
    expect(path.endsWith(".json")).toBe(true)
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { id: string; entries: unknown[] }
    expect(parsed.id).toBe("ses_test123")
    expect(parsed.entries).toHaveLength(1)
  })
})
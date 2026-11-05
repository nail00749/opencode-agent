import { describe, expect, test } from "bun:test"
import type { AccessExplanation } from "../core/access-explanation"
import { EMPTY_INSIGHTS, type SessionInsights } from "./insights"
import {
  adoptSessionFetch,
  agentForSession,
  buildSidebar,
  classifyFetch,
  defaultExpanded,
  explanationPlanForSession,
  explanationRequests,
  formatExplanation,
  insightsForSession,
  joinSidebarText,
  toggleSection,
  type SidebarInput,
} from "./sidebar-model"

function input(overrides: Partial<SidebarInput> = {}): SidebarInput {
  return {
    expanded: defaultExpanded(),
    version: "0.12.11",
    sessionID: "ses-test",
    now: 10_000,
    insights: EMPTY_INSIGHTS,
    agents: [{ id: "master", model: "openai/gpt-6-sol", disabled: false, primary: true }],
    mode: { status: "loading" },
    fileGuard: { status: "loading" },
    leases: { status: "loading" },
    hostTasks: { status: "unavailable" },
    explanations: { status: "loading" },
    ...overrides,
  }
}

const explanation: AccessExplanation = {
  sessionID: "ses-test",
  agent: "master",
  action: "edit",
  resources: ["src/a.ts"],
  kind: "preview",
  observationID: null,
  nativeOutcome: "unknown",
  nextStep: "inspect-policy",
  evidence: [{
    source: "permission",
    basis: "preview",
    resource: "src/a.ts",
    effect: "deny",
    code: "RULE_MATCH",
    matchedRule: { action: "edit", resource: "src/*", effect: "deny" },
    nextStep: "inspect-policy",
  }],
}

describe("grouped sidebar model", () => {
  test("builds the six sections independently", () => {
    const expanded = toggleSection(toggleSection(defaultExpanded(), "ACCESS"), "TASKS")
    const sections = buildSidebar(input({ expanded }))
    expect(sections.map((section) => section.id)).toEqual(["GVOZD", "TASKS", "AGENTS", "SKILLS", "ACCESS", "CONTEXT"])
    expect(sections.map((section) => section.expanded)).toEqual([true, true, false, false, true, false])
    expect(sections.find((section) => section.id === "GVOZD")?.actions.map((action) => action.id)).toEqual(["open-menu"])
    expect(sections.filter((section) => section.id !== "GVOZD").every((section) => section.actions.length === 0)).toBe(true)
  })

  test("failed leases, approvals, and context never become confirmed zeros", () => {
    const failed = buildSidebar(input({
      insights: { ...EMPTY_INSIGHTS, messageAvailability: "unavailable", permissionAvailability: "unavailable", sessionAvailability: "unavailable" },
      mode: { status: "unavailable" },
      fileGuard: { status: "unavailable" },
      leases: { status: "unavailable" },
      explanations: { status: "unavailable" },
    }))
    const text = joinSidebarText(failed)
    expect(text).toContain("leases: unavailable")
    expect(text).toContain("pending approvals: unavailable")
    expect(text).toContain("context unavailable")
    expect(text).toContain("host tasks unavailable")
    expect(text).not.toContain("leases: 0")
    expect(text).not.toContain("pending approvals: none")
    expect(text).not.toContain("context empty")
    expect(text).not.toContain("no pending approvals")
    expect(text).not.toContain("$0.00")
    expect(text).not.toContain("0 tok")
    expect(text.toLowerCase()).not.toContain("vault")
    expect(text.toLowerCase()).not.toContain("ssh")
  })

  test("distinguishes loading, stale, and confirmed empty", () => {
    expect(classifyFetch("loading", undefined, undefined, () => false).status).toBe("loading")
    expect(classifyFetch("error", undefined, undefined, (value: readonly string[]) => value.length === 0).status).toBe("unavailable")
    expect(classifyFetch("error", undefined, ["cached"], () => false)).toEqual({ status: "stale", value: ["cached"] })
    expect(classifyFetch("ready", [], undefined, (value: readonly string[]) => value.length === 0).status).toBe("empty")
    const stale = buildSidebar(input({
      leases: { status: "stale", value: [] },
      insights: { ...EMPTY_INSIGHTS, permissionAvailability: "stale", messageAvailability: "ready", sessionAvailability: "ready" },
    }))
    expect(joinSidebarText(stale)).toContain("leases: 0 (stale)")
    expect(joinSidebarText(stale)).toContain("pending approvals: 0 (stale)")
  })

  test("shows explanation evidence and a non-executing next step", () => {
    const lines = formatExplanation(explanation).map((entry) => entry.text)
    expect(lines).toContain("native: unknown")
    expect(lines).toContain("preview is not authorization")
    expect(lines).toContain("permission · deny · RULE_MATCH · src/a.ts")
    expect(lines).toContain("rule edit src/* deny")
    expect(lines).toContain("next: inspect policy")
    const access = buildSidebar(input({ explanations: { status: "ready", value: [explanation] } }))
      .find((section) => section.id === "ACCESS")
    expect(access?.actions).toEqual([])
    expect(access?.lines.map((entry) => entry.text)).toContain("read only · does not approve, execute, or change policy")
  })

  test("does not invent an agent or a host task", () => {
    expect(explanationRequests({ sessionID: "ses-test", agent: undefined, availability: "ready", pending: [{ id: "1", action: "edit", resources: ["a.ts"] }] }).status).toBe("unavailable")
    expect(explanationRequests({ sessionID: "ses-test", agent: "master", availability: "unavailable", pending: undefined }).requests).toEqual([])
    const evidenced = buildSidebar(input({ hostTasks: { status: "ready", value: [{ id: "t1", title: "Fix sidebar", status: "open" }] } }))
    expect(joinSidebarText(evidenced)).toContain("open · Fix sidebar")
  })

  test("preserves unknown cost and tokens on agent detail rows", () => {
    const sections = buildSidebar(input({
      insights: {
        ...EMPTY_INSIGHTS,
        sessionAvailability: "ready",
        tree: [{ sessionID: "ses-test", agent: "master", status: "running", isRoot: true }],
      },
    }))
    const text = joinSidebarText(sections)
    expect(text).toContain("● master · running")
    expect(text).toContain("cost unknown · tokens unknown")
    expect(text).not.toContain("$0.00")
  })
})

describe("session switch", () => {
  const sessionA: SessionInsights = {
    ...EMPTY_INSIGHTS,
    sessionAvailability: "ready",
    permissionAvailability: "ready",
    messageAvailability: "ready",
    tree: [{ sessionID: "ses-a", agent: "master", status: "running", isRoot: true, model: "openai/gpt-6-sol" }],
    permissions: [{ id: "p1", action: "edit", resource: "src/a.ts", extraResources: 0, pending: true }],
  }
  const explanation = {
    sessionID: "ses-a",
    agent: "master",
    action: "edit",
    resources: ["src/a.ts"],
    kind: "observed" as const,
    observationID: "obs-a",
    nativeOutcome: "deny" as const,
    nextStep: "inspect-policy" as const,
    evidence: [],
  }

  test("session B does not keep session A's mode, agent, or explanation", () => {
    expect(insightsForSession("ses-b", "ses-a", sessionA)).toBe(EMPTY_INSIGHTS)
    expect(agentForSession("ses-b", sessionA)).toBeUndefined()
    expect(adoptSessionFetch("ses-b", "ses-a", { status: "ready", value: { label: "mode: trusted", policy: "shell=allow" } }).status).toBe("loading")
    const plan = explanationPlanForSession({
      sessionID: "ses-b",
      insights: sessionA,
      insightsSessionID: "ses-a",
      pending: [{ id: "p1", action: "edit", resources: ["src/a.ts"] }],
      pendingSessionID: "ses-a",
    })
    expect(plan).toEqual({ status: "unavailable", requests: [] })
    expect(plan.requests).not.toContainEqual(expect.objectContaining({ agent: "master" }))
    const text = joinSidebarText(buildSidebar(input({
      sessionID: "ses-b",
      expanded: { GVOZD: true, TASKS: true, AGENTS: true, SKILLS: true, ACCESS: true, CONTEXT: true },
      agents: [{ id: "back-fast", primary: false, disabled: false }],
      insights: insightsForSession("ses-b", "ses-a", sessionA),
      mode: adoptSessionFetch("ses-b", undefined, { status: "ready", value: { label: "mode: trusted", policy: "shell=allow" } }),
      explanations: { status: "unavailable" },
    })))
    expect(text).not.toContain("master")
    expect(text).not.toContain("trusted")
    expect(text).not.toContain("src/a.ts")
    expect(text).not.toContain("shell=allow")
    expect(text).not.toContain(explanation.observationID)
  })

  test("a family tree keeps the matching root agent and rejects another session's root", () => {
    const family: SessionInsights = {
      ...EMPTY_INSIGHTS,
      sessionAvailability: "ready",
      permissionAvailability: "ready",
      tree: [
        { sessionID: "ses-b", agent: "back-deep", status: "running", isRoot: true },
        { sessionID: "ses-c", agent: "front-deep", status: "idle", isRoot: false },
      ],
    }
    expect(insightsForSession("ses-b", "ses-b", family)).toBe(family)
    expect(agentForSession("ses-b", insightsForSession("ses-b", "ses-b", family))).toBe("back-deep")
    const owned = explanationPlanForSession({
      sessionID: "ses-b",
      insights: family,
      insightsSessionID: "ses-b",
      pending: [{ id: "p", action: "edit", resources: ["src/b.ts"] }],
      pendingSessionID: "ses-b",
    })
    expect(owned.requests.map((request) => request.agent)).toEqual(["back-deep"])
    const foreign: SessionInsights = {
      ...family,
      tree: [
        { sessionID: "ses-a", agent: "master", status: "running", isRoot: true },
        { sessionID: "ses-c", agent: "front-deep", status: "idle", isRoot: false },
      ],
    }
    expect(explanationPlanForSession({
      sessionID: "ses-b",
      insights: foreign,
      insightsSessionID: "ses-a",
      pending: [{ id: "p", action: "edit", resources: ["src/a.ts"] }],
      pendingSessionID: "ses-a",
    }).requests).toEqual([])
  })

  test("a failed refetch does not explain a cached permission list with the previous agent", () => {
    const failed: SessionInsights = {
      ...EMPTY_INSIGHTS,
      sessionAvailability: "unavailable",
      permissionAvailability: "unavailable",
      messageAvailability: "unavailable",
    }
    const plan = explanationPlanForSession({
      sessionID: "ses-b",
      insights: failed,
      insightsSessionID: "ses-b",
      pending: [{ id: "p1", action: "edit", resources: ["src/a.ts"] }],
      pendingSessionID: "ses-a",
    })
    expect(plan.status).toBe("unavailable")
    expect(plan.requests).toEqual([])
    expect(agentForSession("ses-b", failed)).toBeUndefined()
    expect(adoptSessionFetch("ses-b", "ses-b", { status: "unavailable" }).status).toBe("unavailable")
    const text = joinSidebarText(buildSidebar(input({
      sessionID: "ses-b",
      expanded: { GVOZD: true, TASKS: false, AGENTS: true, SKILLS: false, ACCESS: true, CONTEXT: true },
      agents: [{ id: "back-fast", primary: false, disabled: false }],
      insights: failed,
      mode: { status: "unavailable" },
      explanations: { status: "unavailable" },
    })))
    expect(text).toContain("mode: unavailable")
    expect(text).toContain("explanation unavailable")
    expect(text).not.toContain("master")
    expect(text).not.toContain("src/a.ts")
    expect(text).not.toContain("leases: 0")
  })
})

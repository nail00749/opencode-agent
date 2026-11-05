import { describe, expect, test } from "bun:test"
import type { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
// @ts-expect-error client runtime, see sidebar.tsx
import { createSignal } from "solid-js/dist/solid.js"
import type { AccessExplanation } from "../core/access-explanation"
import { EMPTY_INSIGHTS } from "./insights"
import { GroupedSidebarView } from "./sidebar"
import { buildSidebar, defaultExpanded, type SidebarInput, type SidebarSection } from "./sidebar-model"

function viewInput(): Omit<SidebarInput, "expanded"> {
  return {
    version: "0.12.11",
    sessionID: "ses-test",
    now: 10_000,
    insights: {
      ...EMPTY_INSIGHTS,
      messageAvailability: "unavailable",
      permissionAvailability: "unavailable",
      sessionAvailability: "unavailable",
    },
    agents: undefined,
    mode: { status: "unavailable" },
    fileGuard: { status: "unavailable" },
    leases: { status: "unavailable" },
    hostTasks: { status: "unavailable" },
    explanations: { status: "unavailable" },
  }
}

const collapsed: Record<SidebarSection, boolean> = {
  GVOZD: false,
  TASKS: false,
  AGENTS: false,
  SKILLS: false,
  ACCESS: false,
  CONTEXT: false,
}

describe("grouped sidebar interactions", () => {
  test("toggles one section without opening the others or an approval control", async () => {
    const headers = new Map<SidebarSection, BoxRenderable>()
    const bodies = new Map<SidebarSection, BoxRenderable>()
    let opened = 0
    let toggled = ""
    const setup = await testRender(
      () => (
        <GroupedSidebarView
          input={viewInput()}
          heading="#22d3ee"
          muted="#808080"
          text="#ffffff"
          success="#22c55e"
          error="#ef4444"
          initialExpanded={collapsed}
          onOpenMenu={() => opened++}
          onToggled={(section) => { toggled = section }}
          onHeader={(section, node) => headers.set(section, node)}
          onBody={(section, node) => bodies.set(section, node)}
        />
      ),
      { width: 72, height: 24 },
    )
    try {
      await setup.renderOnce()
      const closed = setup.captureCharFrame()
      expect(closed).toContain("ACCESS")
      expect(closed).not.toContain("file-guard:")
      expect(closed).not.toContain("Open Gvozd menu")

      const access = headers.get("ACCESS")
      if (!access) throw new Error("ACCESS header was not mounted")
      await setup.mockMouse.pressDown(1, 4)
      expect(setup.renderer.currentFocusedRenderable).toBe(access)
      await setup.mockMouse.release(1, 4)
      expect(toggled).toBe("ACCESS")
      const body = bodies.get("ACCESS")
      expect(body?.visible).toBe(true)
      await setup.renderOnce()
      const open = setup.captureCharFrame()
      expect(open).toContain("file-guard: unavailable")
      expect(open).toContain("leases: unavailable")
      expect(open).toContain("pending approvals: unavailable")
      expect(open).toContain("read only")
      expect(open).not.toContain("host tasks unavailable")
      expect(open).not.toContain("Approve")
      expect(opened).toBe(0)
      setup.mockInput.pressEnter()
      await setup.flush()
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain("file-guard:")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("rewrites the chevron, summary, and body after mount when input changes", async () => {
    const [input, setInput] = createSignal(viewInput())
    const setup = await testRender(
      () => (
        <GroupedSidebarView
          input={input}
          heading="#22d3ee"
          muted="#808080"
          text="#ffffff"
          success="#22c55e"
          error="#ef4444"
          initialExpanded={collapsed}
          onOpenMenu={() => undefined}
        />
      ),
      { width: 72, height: 28 },
    )
    try {
      await setup.renderOnce()
      const initial = setup.captureCharFrame()
      expect(initial).toContain("▶ GVOZD  v0.12.11")
      expect(initial).toContain("▶ ACCESS  unavailable")
      expect(initial).not.toContain("▼ ACCESS")

      setInput({
        ...viewInput(),
        version: "9.9.9",
        mode: { status: "ready", value: { label: "mode: strict", policy: "shell=ask" } },
        fileGuard: { status: "ready", value: { shellEscalation: "deny" } },
      })
      await setup.renderOnce()
      const updated = setup.captureCharFrame()
      expect(updated).toContain("▶ GVOZD  v9.9.9")
      expect(updated).not.toContain("v0.12.11")

      await setup.mockMouse.pressDown(1, 4)
      await setup.mockMouse.release(1, 4)
      await setup.renderOnce()
      const open = setup.captureCharFrame()
      expect(open).toContain("▼ ACCESS")
      expect(open).not.toContain("▶ ACCESS")
      expect(open).toContain("mode: strict")
      expect(open).toContain("file-guard: deny")
      expect(open).not.toContain("mode: unavailable")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("paints the read-only disclaimer when the explanation body exceeds 12 lines", async () => {
    const evidence = {
      source: "permission" as const,
      basis: "preview" as const,
      resource: "src/a.ts",
      effect: "deny" as const,
      code: "RULE_MATCH",
      matchedRule: { action: "edit", resource: "src/*", effect: "deny" as const },
      nextStep: "inspect-policy" as const,
    }
    const explanations: AccessExplanation[] = Array.from({ length: 4 }, (_, index) => ({
      sessionID: "ses-test",
      agent: "back-deep",
      action: "edit",
      resources: [`src/file-${index}.ts`],
      kind: "preview",
      observationID: null,
      nativeOutcome: "unknown",
      nextStep: "inspect-policy",
      evidence: [evidence],
    }))
    const input = viewInput()
    const longInput: Omit<SidebarInput, "expanded"> = {
      ...input,
      explanations: { status: "ready", value: explanations },
    }
    const access = buildSidebar({ ...longInput, expanded: { ...defaultExpanded(), ACCESS: true } }).find((section) => section.id === "ACCESS")
    expect(access?.lines.length).toBeGreaterThan(12)
    expect(access?.lines.at(-1)?.text).toContain("read only")
    const setup = await testRender(
      () => (
        <GroupedSidebarView
          input={longInput}
          heading="#22d3ee"
          muted="#808080"
          text="#ffffff"
          success="#22c55e"
          error="#ef4444"
          initialExpanded={{ ...defaultExpanded(), ACCESS: true }}
          onOpenMenu={() => undefined}
        />
      ),
      { width: 80, height: 48 },
    )
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("read only · does not approve, execute, or change policy")
      expect(frame).toContain("src/file-3.ts")
    } finally {
      setup.renderer.destroy()
    }
  })
})

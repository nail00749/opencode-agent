import { describe, expect, test } from "bun:test"
import {
  cycleSessionPermissionEffect,
  goalDecisionFor,
  modeDecisionFor,
  sessionOverrideDecision,
  sessionPermissionAction,
} from "./session-permissions"
import { modePermissions } from "../rpc/trusted-mode"

describe("sessionPermissionAction", () => {
  test("maps shell variants, edits, skills, and namespaced MCP tools", () => {
    expect(sessionPermissionAction("shell")).toBe("shell")
    expect(sessionPermissionAction("bash")).toBe("shell")
    expect(sessionPermissionAction("edit")).toBe("edit")
    expect(sessionPermissionAction("write")).toBe("edit")
    expect(sessionPermissionAction("patch")).toBe("edit")
    expect(sessionPermissionAction("skill")).toBe("skill")
    expect(sessionPermissionAction("context7_search", ["context7"])).toBe("mcp")
  })

  test("returns undefined for unmapped actions and unknown MCP prefixes", () => {
    expect(sessionPermissionAction("read")).toBeUndefined()
    expect(sessionPermissionAction("webfetch")).toBeUndefined()
    // A namespaced action only counts as MCP when a known server owns it.
    expect(sessionPermissionAction("unknown_search", ["context7"])).toBeUndefined()
  })
})

describe("sessionOverrideDecision", () => {
  test("passes through each effect and labels the originating category", () => {
    expect(sessionOverrideDecision("allow", "edit", ["src/a.ts"])).toEqual({
      effect: "allow",
      message: expect.stringContaining("edit = allow"),
    })
    expect(sessionOverrideDecision("ask", "shell", ["bun test"])).toEqual({
      effect: "ask",
      message: expect.stringContaining("shell = ask"),
    })
    expect(sessionOverrideDecision("deny", "skill", ["planner"])).toEqual({
      effect: "deny",
      message: expect.stringContaining("skill = deny"),
    })
  })

  test("treats inherit and absence as no override", () => {
    expect(sessionOverrideDecision("inherit", "edit", ["src/a.ts"])).toBeUndefined()
    expect(sessionOverrideDecision(undefined, "edit", ["src/a.ts"])).toBeUndefined()
  })

  test("never lets a shell override widen a destructive command to allow or ask", () => {
    // The guard must survive even an explicit session "allow".
    for (const override of ["allow", "ask"] as const) {
      const decision = sessionOverrideDecision(override, "shell", ["git push --force origin main"])
      expect(decision?.effect).toBe("deny")
      expect(decision?.message).toContain("Destructive")
      expect(sessionOverrideDecision(override, "shell", ["git reset --hard HEAD~1"])?.effect).toBe("deny")
      expect(sessionOverrideDecision(override, "shell", ["git rebase main"])?.effect).toBe("deny")
    }
    // An explicit deny stays deny and reports the normal override message.
    expect(sessionOverrideDecision("deny", "shell", ["git push --force"])?.effect).toBe("deny")
  })

  test("allows ordinary commands to take the override", () => {
    expect(sessionOverrideDecision("allow", "shell", ["bun test"])?.effect).toBe("allow")
    // A read-only git command is not in the never-escalate set.
    expect(sessionOverrideDecision("allow", "shell", ["git status --short"])?.effect).toBe("allow")
    // Recovery forms are legitimate cleanup and may escalate.
    expect(sessionOverrideDecision("ask", "shell", ["git rebase --abort"])?.effect).toBe("ask")
  })

  test("one destructive command blocks the whole multi-command call", () => {
    const decision = sessionOverrideDecision("allow", "shell", ["git status", "git clean -fdx"])
    expect(decision?.effect).toBe("deny")
  })
})

describe("goalDecisionFor", () => {
  test("stays silent without an active goal or outside the goal family", () => {
    expect(goalDecisionFor(false, true, "shell", ["bun test"])).toBeUndefined()
    expect(goalDecisionFor(true, false, "shell", ["bun test"])).toBeUndefined()
    expect(goalDecisionFor(false, false, "edit", ["src/a.ts"])).toBeUndefined()
  })

  test("allows shell, edit, skill, and MCP while the family goal is active", () => {
    expect(goalDecisionFor(true, true, "shell", ["bun test"])?.effect).toBe("allow")
    expect(goalDecisionFor(true, true, "bash", ["bun run typecheck"])?.effect).toBe("allow")
    expect(goalDecisionFor(true, true, "edit", ["src/a.ts"])?.effect).toBe("allow")
    expect(goalDecisionFor(true, true, "skill", ["planner"])?.effect).toBe("allow")
    expect(goalDecisionFor(true, true, "context7_search", ["query"], ["context7"])?.effect).toBe("allow")
  })

  test("keeps destructive shell denied even with an active goal", () => {
    expect(goalDecisionFor(true, true, "shell", ["git reset --hard HEAD~1"])?.effect).toBe("deny")
    expect(goalDecisionFor(true, true, "shell", ["git push --force origin main"])?.effect).toBe("deny")
    expect(goalDecisionFor(true, true, "bash", ["git clean -fdx"])?.effect).toBe("deny")
    const mixed = goalDecisionFor(true, true, "shell", ["git status", "git clean -fdx"])
    expect(mixed?.effect).toBe("deny")
  })

  test("ignores actions outside the goal categories", () => {
    expect(goalDecisionFor(true, true, "read", ["docs/a.md"])).toBeUndefined()
    expect(goalDecisionFor(true, true, "unknown_search", ["q"], ["context7"])).toBeUndefined()
  })
})

describe("cycleSessionPermissionEffect", () => {
  test("advances inherit -> allow -> ask -> deny -> inherit", () => {
    expect(cycleSessionPermissionEffect(undefined)).toBe("allow")
    expect(cycleSessionPermissionEffect("inherit")).toBe("allow")
    expect(cycleSessionPermissionEffect("allow")).toBe("ask")
    expect(cycleSessionPermissionEffect("ask")).toBe("deny")
    expect(cycleSessionPermissionEffect("deny")).toBe("inherit")
  })
})

describe("modeDecisionFor", () => {
  test("returns undefined when the posture has no matching rule", () => {
    expect(modeDecisionFor(modePermissions("balanced"), "shell", ["git push --force"])).toBeUndefined()
  })

  test("trusted allows ordinary shell and edits but keeps destructive git denied", () => {
    const trusted = modePermissions("trusted")
    expect(modeDecisionFor(trusted, "shell", ["bun test"])).toBe("allow")
    expect(modeDecisionFor(trusted, "edit", ["src/a.ts"])).toBe("allow")
    expect(modeDecisionFor(trusted, "shell", ["git push --force origin main"])).toBe("deny")
    // Last-match-wins recovery form re-opens after the blanket rebase deny.
    expect(modeDecisionFor(trusted, "shell", ["git rebase --abort"])).toBe("allow")
  })

  test("strict asks for every shell command and edit", () => {
    const strict = modePermissions("strict")
    expect(modeDecisionFor(strict, "shell", ["bun test"])).toBe("ask")
    expect(modeDecisionFor(strict, "bash", ["bun test"])).toBe("ask")
    expect(modeDecisionFor(strict, "edit", ["src/a.ts"])).toBe("ask")
    // Destructive commands stay denied even under strict.
    expect(modeDecisionFor(strict, "shell", ["git reset --hard"])).toBe("deny")
    expect(modeDecisionFor(strict, "bash", ["git reset --hard"])).toBe("deny")
  })

  test("a posture cannot widen destructive shell to allow", () => {
    // Even a hand-built allow-everything posture is clamped for destructive
    // families, matching the session-override safety invariant.
    const permissive = [{ action: "shell", resource: "*", effect: "allow" as const }]
    expect(modeDecisionFor(permissive, "shell", ["git clean -fd"])).toBe("deny")
  })
})

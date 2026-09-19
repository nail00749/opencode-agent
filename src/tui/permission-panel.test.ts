import { describe, expect, test } from "bun:test"
import { checkboxFor, nextOverrides, sessionPermissionStatus, summarizeOverrides, toggleRows } from "./permission-panel"
import { SESSION_PERMISSION_ACTIONS } from "../core/session-permissions"

describe("permission panel rows", () => {
  test("renders one unchecked row per category when nothing is overridden", () => {
    const rows = toggleRows({})
    expect(rows.map((row) => row.action)).toEqual([...SESSION_PERMISSION_ACTIONS])
    expect(rows.every((row) => row.checkbox === "[ ]")).toBe(true)
    expect(rows.every((row) => row.effect === "inherit")).toBe(true)
  })

  test("checks exactly the overridden rows and describes the effect", () => {
    const rows = toggleRows({ shell: "deny", edit: "allow" })
    const byAction = Object.fromEntries(rows.map((row) => [row.action, row]))
    expect(byAction.shell!.checkbox).toBe("[x]")
    expect(byAction.shell!.display).toContain("shell commands (session family) — deny")
    expect(byAction.edit!.checkbox).toBe("[x]")
    expect(byAction.skill!.checkbox).toBe("[ ]")
    expect(byAction.mcp!.checkbox).toBe("[ ]")
  })

  test("shows the effective permission and where it comes from", () => {
    const trusted = Object.fromEntries(toggleRows({}, "trusted").map((row) => [row.action, row]))
    expect(trusted.shell).toMatchObject({ effective: "allow", source: "trusted mode" })
    expect(trusted.edit).toMatchObject({ effective: "allow", source: "trusted mode" })
    expect(trusted.skill).toMatchObject({ effective: "agent policy", source: "inherited" })

    const overridden = Object.fromEntries(toggleRows({ shell: "deny", mcp: "ask" }, "balanced").map((row) => [row.action, row]))
    expect(overridden.shell).toMatchObject({ effective: "deny", source: "session family override" })
    expect(overridden.mcp).toMatchObject({ effective: "ask", source: "session override" })
  })

  test("checkboxFor only marks real overrides", () => {
    expect(checkboxFor("inherit")).toBe("[ ]")
    expect(checkboxFor("allow")).toBe("[x]")
    expect(checkboxFor("ask")).toBe("[x]")
    expect(checkboxFor("deny")).toBe("[x]")
  })
})

describe("nextOverrides", () => {
  test("sets a category without disturbing the others", () => {
    expect(nextOverrides({ shell: "deny" }, "edit", "ask")).toEqual({ shell: "deny", edit: "ask" })
  })

  test("removes a category when it returns to inherit", () => {
    const next = nextOverrides({ shell: "deny", edit: "ask" }, "shell", "inherit")
    expect(next).toEqual({ edit: "ask" })
    expect("shell" in next).toBe(false)
  })

  test("does not mutate the input object", () => {
    const original = { shell: "deny" as const }
    const next = nextOverrides(original, "edit", "allow")
    expect(original).toEqual({ shell: "deny" })
    expect(next).not.toBe(original)
  })
})

describe("summarizeOverrides", () => {
  test("reports none when everything inherits", () => {
    expect(summarizeOverrides({})).toBe("none (agent policy decides)")
  })

  test("lists overrides in the canonical category order", () => {
    expect(summarizeOverrides({ mcp: "deny", shell: "allow" })).toBe("shell=allow, mcp=deny")
  })
})

describe("sessionPermissionStatus", () => {
  test("makes the shell approval state visible without opening a panel", () => {
    expect(sessionPermissionStatus("balanced", {})).toBe("mode: balanced · shell: agent policy")
    expect(sessionPermissionStatus("balanced", { shell: "allow" })).toBe("mode: balanced · shell: allow (family grant; destructive denied)")
    expect(sessionPermissionStatus("trusted", {})).toBe("mode: trusted · shell: allow (lease guard applies)")
    expect(sessionPermissionStatus("strict", {})).toBe("mode: strict · shell: ask")
  })
})

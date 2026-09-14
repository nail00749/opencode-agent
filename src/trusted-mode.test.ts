import { describe, expect, test } from "bun:test"
import { modePermissions, TRUST_MODES } from "./trusted-mode"

describe("modePermissions", () => {
  test("trusted allows shell and edits, then re-asserts destructive denies last", () => {
    const rules = modePermissions("trusted")
    const effects = rules.map((rule) => rule.effect)
    expect(effects.slice(0, 2)).toEqual(["allow", "allow"])
    expect(effects[effects.length - 1]).toBe("deny")
    const lastDeny = rules[rules.length - 1]!
    expect(lastDeny.resource).toBe("git restore*")
  })

  test("balanced contributes no extra rules; strict asks for shell and edits", () => {
    expect(modePermissions("balanced")).toEqual([])
    expect(modePermissions("strict")).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
    ])
  })
})

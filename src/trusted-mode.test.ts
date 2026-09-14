import { describe, expect, test } from "bun:test"
import { modePermissions, TRUST_MODES } from "./trusted-mode"
import { wildcardMatch } from "./agent-permissions"

describe("modePermissions", () => {
  test("trusted allows shell and edits, then re-asserts destructive denies", () => {
    const rules = modePermissions("trusted")
    const effects = rules.map((rule) => rule.effect)
    expect(effects.slice(0, 2)).toEqual(["allow", "allow"])
    // The trailing abort/continue allows intentionally re-open recovery
    // forms after the blanket rebase deny; every destructive deny stays.
    const denyResources = rules.filter((rule) => rule.effect === "deny").map((rule) => rule.resource)
    expect(denyResources).toContain("git push --force*")
    expect(denyResources).toContain("git reset --hard*")
    expect(denyResources).toContain("git rebase*")
    expect(denyResources).toContain("git restore*")
  })

  test("trusted still allows rebase abort and continue after the rebase deny", () => {
    const rules = modePermissions("trusted")
    // Last-match-wins: a recovery form must resolve to allow, a rewrite to deny.
    const resolve = (command: string): string => {
      let effect: string | undefined
      for (const rule of rules) {
        if (wildcardMatch(rule.resource, `git rebase ${command}`)) effect = rule.effect
      }
      return effect!
    }
    expect(resolve("--abort")).toBe("allow")
    expect(resolve("--continue")).toBe("allow")
    expect(resolve("main")).toBe("deny")
    expect(resolve("interactive")).toBe("deny")
  })

  test("balanced contributes no extra rules; strict asks for shell and edits", () => {
    expect(modePermissions("balanced")).toEqual([])
    expect(modePermissions("strict")).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
    ])
  })
})

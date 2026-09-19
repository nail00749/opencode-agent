import { describe, expect, test } from "bun:test"
import { modePermissions } from "./trusted-mode"
import { wildcardMatch } from "../core/agent-permissions"

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

  test("trusted keeps every never-escalate family denied, including env-prefixed commands", () => {
    const rules = modePermissions("trusted")
    const resolve = (command: string): string | undefined => {
      let effect: string | undefined
      for (const rule of rules) {
        if (rule.action === "shell" && wildcardMatch(rule.resource, command)) effect = rule.effect
      }
      return effect
    }
    for (const command of [
      "git push --force origin main",
      "git reset --hard",
      "sudo apt update",
      "rm -rf /tmp/data",
      "mkfs.ext4 /dev/sda",
      "dd if=/dev/zero of=/dev/sda",
      "chmod -R 777 /etc",
      "FOO=bar sudo apt update",
      "FOO=bar BAR=baz git reset --hard",
    ]) {
      expect(resolve(command)).toBe("deny")
    }

    // Last-match-wins: bookkeeping forms re-open after the rebase denial.
    expect(resolve("git rebase --abort")).toBe("allow")
    expect(resolve("git rebase --continue")).toBe("allow")
    expect(resolve("git rebase --quit")).toBe("allow")
    expect(resolve("git rebase main")).toBe("deny")
  })

  test("balanced contributes no extra rules; strict asks for shell and edits", () => {
    expect(modePermissions("balanced")).toEqual([])
    const strict = modePermissions("strict")
    expect(strict.slice(0, 2)).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
    ])
    expect(strict).toContainEqual({ action: "shell", resource: "sudo*", effect: "deny" })
    expect(strict).toContainEqual({ action: "shell", resource: "git rebase --abort*", effect: "ask" })
  })
})

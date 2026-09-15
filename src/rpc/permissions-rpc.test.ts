import { describe, expect, test } from "bun:test"
import { evaluateEffect, evaluateInput, GvozdLeases } from "./permissions-rpc"
import type { PermissionRule } from "../core/config"

const rules: PermissionRule[] = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "git diff *", effect: "allow" },
  { action: "shell", resource: "git reset --hard*", effect: "deny" },
  { action: "edit", resource: "*", effect: "deny" },
]

describe("evaluateEffect", () => {
  test("last matching rule wins", () => {
    expect(evaluateEffect(rules, "shell", "git diff HEAD")).toEqual({ effect: "allow", matchedRule: 'shell git diff *' })
    expect(evaluateEffect(rules, "shell", "git reset --hard HEAD~1")).toEqual({ effect: "deny", matchedRule: 'shell git reset --hard*' })
    expect(evaluateEffect(rules, "shell", "cargo test *")).toEqual({ effect: "ask", matchedRule: 'shell *' })
    expect(evaluateEffect(rules, "edit", "src/a.ts")).toEqual({ effect: "deny", matchedRule: 'edit *' })
  })

  test("unknown when nothing matches", () => {
    expect(evaluateEffect(rules, "browser", "*")).toEqual({ effect: "unknown", matchedRule: null })
  })

  test("mirrors wildcardMatch semantics (trailing star does not match the bare command)", () => {
    expect(evaluateEffect(rules, "shell", "git diff").effect).toBe("ask")
  })
})

describe("evaluateInput", () => {
  test("expands each resource into one result row", () => {
    const output = evaluateInput(rules, {
      agent: "review-deep",
      checks: [{ action: "shell", resources: ["git diff --stat", "npm publish"] }],
    })
    expect(output.results).toHaveLength(2)
    expect(output.results[0]).toMatchObject({ effect: "allow" })
    expect(output.results[1]).toMatchObject({ effect: "ask" })
  })

  test("unknown agent evaluates to unknown effects", () => {
    const output = evaluateInput(undefined, { agent: "ghost", checks: [{ action: "shell", resources: ["ls"] }] })
    expect(output.results[0]).toEqual({ action: "shell", resource: "ls", effect: "unknown", matchedRule: null })
  })
})

describe("GvozdLeases definition", () => {
  test("declares a list method with the lease snapshot output schema", () => {
    const method = GvozdLeases.methods.list!
    expect(method.input).toMatchObject({ type: "object" })
    const output = method.output as { type: string; properties: { leases: { items: { required: readonly string[] } } } }
    expect(output.properties.leases.items.required).toEqual(
      ["leaseId", "parentSessionID", "agent", "label", "state", "files", "expiresAt", "lastActivityAt"],
    )
  })
})

import { describe, expect, test } from "bun:test"
import { buildAccessExplanation } from "../core/access-explanation"
import {
  composeBlockMessage,
  createAccessObservationLog,
  decideAccess,
  explainFromFacts,
  foreignRulesFromPermissions,
  matchedForeignRule,
  observationCorrelates,
  orderDecisionEvidence,
  parseAccessExplanationInput,
  unknownAccessFact,
  type AccessFact,
} from "./access-explanation"

const leaseDeny: AccessFact = {
  source: "lease",
  resource: "src/a.ts",
  effect: "deny",
  code: "OUT_OF_SCOPE",
  matchedRule: null,
  nextStep: "ask-coordinator",
  decisive: true,
}
const approval: AccessFact = {
  source: "trust-mode",
  resource: null,
  effect: "ask",
  code: "EXPLICIT_SHELL_DECISION",
  matchedRule: null,
  nextStep: "request-approval",
  decisive: false,
}

describe("access explanation producer", () => {
  test("places the applied blocker last so an approval hint cannot hide a lease deny", () => {
    const evidence = orderDecisionEvidence([leaseDeny, approval], "observed")
    expect(evidence.at(-1)).toMatchObject({ source: "lease", code: "OUT_OF_SCOPE", effect: "deny" })
    const explanation = buildAccessExplanation(
      { sessionID: "s", agent: "back-fast", action: "edit", resources: ["src/a.ts"], observationID: "obs" },
      evidence,
    )
    expect(explanation.nextStep).toBe("ask-coordinator")
    expect(explanation.nativeOutcome).toBe("unknown")
  })

  test("does not infer the winner from a message that mentions another effect", async () => {
    const decision = await decideAccess({
      preview: false,
      sessionID: "child",
      agent: "back-fast",
      action: "shell",
      resources: ["bun install"],
      incomingEffect: "allow",
      mcpServers: [],
      mode: "balanced",
      override: "ask",
      configured: { disabled: false, fileLease: "writer", skills: [], mcp: [], permissions: [] },
      traceLease: () => ({
        handled: true,
        effect: "deny",
        message: "approval was requested but the lease guard denied this",
        fact: leaseDeny,
      }),
      goalActive: () => false,
      native: { readable: false, rule: null },
    })
    expect(decision.effect).toBe("deny")
    expect(decision.evidence.at(-1)).toMatchObject({ source: "lease", code: "OUT_OF_SCOPE" })
    expect(decision.evidence.some((item) => item.source === "native-host")).toBe(false)
    const explanation = buildAccessExplanation(
      { sessionID: "child", agent: "back-fast", action: "shell", resources: ["bun install"], observationID: "obs" },
      decision.evidence,
    )
    expect(explanation.nextStep).toBe("ask-coordinator")
  })

  test("redacts secrets and appends static guidance without executing anything", () => {
    const message = composeBlockMessage("failed token=super-secret https://user:pass@example.test/a", "OUT_OF_SCOPE", "deny")
    expect(message).not.toContain("super-secret")
    expect(message).not.toContain("user:pass")
    expect(message).toContain("extend the lease with the exact file")
    expect(message.length).toBeLessThan(500)
    expect(() => parseAccessExplanationInput({
      sessionID: "s",
      agent: "back-fast",
      action: "edit",
      resources: ["src/a.ts"],
      execute: true,
    })).toThrow("does not execute")
  })

  test("missing and mismatched observations stay unknown instead of becoming denials", () => {
    const input = { sessionID: "s", agent: "back-fast", action: "edit", resources: ["src/a.ts"], observationID: "missing" }
    const missing = explainFromFacts(input, [unknownAccessFact("OBSERVATION_MISSING")], "observed")
    expect(missing).toMatchObject({ evidence: [{ source: "unknown", effect: "unknown", code: "OBSERVATION_MISSING" }], nativeOutcome: "unknown" })
    expect(missing.evidence.some((item) => item.effect === "deny")).toBe(false)
    const log = createAccessObservationLog()
    const id = log.record({ sessionID: "s", agent: "back-fast", action: "edit", resources: ["src/a.ts"], evidence: missing.evidence })
    expect(observationCorrelates(log.get(id)!, { ...input, observationID: id })).toBe(true)
    expect(observationCorrelates(log.get(id)!, { ...input, resources: ["src/b.ts"] })).toBe(false)
    log.close()
    expect(log.get(id)).toBeUndefined()
  })

  test("native and foreign evidence require a readable block and an observed unchanged effect", () => {
    expect(foreignRulesFromPermissions([
      { action: "gvozd.session-policy", resource: "begin:balanced:inherit", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ])).toBeUndefined()
    const readable = matchedForeignRule([
      { action: "read", resource: "private/**", effect: "deny" },
      { action: "gvozd.session-policy", resource: "begin:strict:inherit", effect: "deny" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "gvozd.session-policy", resource: "end", effect: "deny" },
    ], "read", ["private/a.ts"])
    expect(readable).toEqual({ readable: true, rule: { action: "read", resource: "private/**", effect: "deny" } })
    expect(matchedForeignRule(undefined, "read", ["private/a.ts"])).toEqual({ readable: false, rule: null })
  })
})

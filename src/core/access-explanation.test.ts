import { describe, expect, test } from "bun:test"
import { buildAccessExplanation, type AccessEvidence, type AccessExplanationInput } from "./access-explanation"

const input: AccessExplanationInput = { sessionID: "s1", agent: "back-deep", action: "edit", resources: ["src/a.ts"] }
const permission: AccessEvidence = {
  source: "permission", basis: "preview", resource: "src/a.ts", effect: "allow", code: "RULE_MATCH",
  matchedRule: { action: "edit", resource: "src/*", effect: "allow" }, nextStep: "none",
}

describe("access explanation evidence", () => {
  test("preview preserves exact matched rule but never promises native authorization", () => {
    const output = buildAccessExplanation(input, [permission, { ...permission, source: "native-host" }])
    expect(output).toMatchObject({ kind: "preview", observationID: null, nativeOutcome: "unknown", nextStep: "inspect-host" })
    expect(output.evidence[0]?.matchedRule).toEqual(permission.matchedRule)
    expect(output.evidence[0]?.matchedRule).not.toBe(permission.matchedRule)
    expect(output.resources).not.toBe(input.resources)
  })

  test("trust-mode and lease observations identify their own causes, not the host outcome", () => {
    const evidence: AccessEvidence[] = [
      { ...permission, basis: "observed", source: "trust-mode", effect: "ask", matchedRule: null, code: "MODE_ASK", nextStep: "request-approval" },
      { ...permission, basis: "observed", source: "lease", effect: "deny", matchedRule: null, code: "OUT_OF_SCOPE", nextStep: "ask-coordinator" },
    ]
    const output = buildAccessExplanation({ ...input, observationID: "o1" }, evidence)
    expect(output).toMatchObject({ kind: "observed", observationID: "o1", nativeOutcome: "unknown", nextStep: "ask-coordinator" })
    expect(output.evidence).toEqual(evidence)
  })

  test("only observed native-host evidence establishes a native outcome", () => {
    const native: AccessEvidence = { ...permission, basis: "observed", source: "native-host", effect: "deny", matchedRule: null, code: "HOST_DENIED", nextStep: "inspect-host" }
    expect(buildAccessExplanation(input, [native]).evidence).toEqual([])
    expect(buildAccessExplanation({ ...input, observationID: "o1" }, [permission, native]).nativeOutcome).toBe("deny")
  })

  test("missing observations and unattributed failures stay unknown without invented rules", () => {
    const request = { ...input, observationID: "missing" }
    expect(buildAccessExplanation(request, [])).toMatchObject({ evidence: [], nativeOutcome: "unknown", nextStep: "inspect-host" })
    const unknown: AccessEvidence = { ...permission, source: "unknown", basis: "observed", effect: "unknown", matchedRule: null, code: "UNATTRIBUTED", nextStep: "inspect-host" }
    expect(buildAccessExplanation(request, [unknown]).evidence).toEqual([unknown])
  })
})

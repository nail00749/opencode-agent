import { describe, expect, test } from "bun:test"
import {
  ADVISORY_DEEP_THRESHOLD,
  ADVISORY_ESCALATE_THRESHOLD,
  buildEscalationGatePreset,
  buildReviewDepthPreset,
  buildTierTriagePreset,
  isAdvisoryDeep,
  isAdvisoryEscalation,
  scanSecretLikeKeys,
} from "./jev-presets"
import { parseJevInput } from "./jev"

function assertSecretFree(value: unknown): void {
  const text = JSON.stringify(value).toLowerCase()
  for (const banned of ["secret", "token", "password", "apikey", "api_key", "credential", "private_key"]) {
    expect(text).not.toContain(banned)
  }
}

describe("jev presets", () => {
  test("tier triage builds a fast-vs-deep choice", () => {
    const preset = buildTierTriagePreset({
      summary: "rename a local helper",
      filesChanged: 1,
      riskSignals: ["none"],
    })
    expect(parseJevInput(preset)).toEqual(preset)
    const question = preset.questions.tier
    expect(question?.type).toBe("choice")
    if (question?.type === "choice") {
      expect(Object.keys(question.criteria).sort()).toEqual(["deep", "fast"])
    }
    assertSecretFree(preset.state)
  })

  test("review depth builds a fast-vs-deep choice", () => {
    const preset = buildReviewDepthPreset({
      summary: "two-file bugfix diff",
      filesChanged: 2,
      riskSignals: ["touches auth check"],
    })
    expect(parseJevInput(preset)).toEqual(preset)
    const question = preset.questions.reviewDepth
    expect(question?.type).toBe("choice")
    if (question?.type === "choice") {
      expect(Object.keys(question.criteria).sort()).toEqual(["deep", "fast"])
    }
    assertSecretFree(preset.state)
  })

  test("escalation gate builds a noul question", () => {
    const preset = buildEscalationGatePreset({
      summary: "second fix round still failing",
      fixRoundsUsed: 2,
      riskSignals: ["repeat failure"],
    })
    expect(parseJevInput(preset)).toEqual(preset)
    expect(preset.questions.escalate?.type).toBe("noul")
    assertSecretFree(preset.state)
  })

  test("advisory thresholds gate escalation advice", () => {
    expect(ADVISORY_ESCALATE_THRESHOLD).toBeGreaterThan(0)
    expect(ADVISORY_ESCALATE_THRESHOLD).toBeLessThanOrEqual(1)
    expect(ADVISORY_DEEP_THRESHOLD).toBeGreaterThan(0)
    expect(ADVISORY_DEEP_THRESHOLD).toBeLessThanOrEqual(1)
    expect(isAdvisoryEscalation(ADVISORY_ESCALATE_THRESHOLD)).toBe(true)
    expect(isAdvisoryEscalation(ADVISORY_ESCALATE_THRESHOLD - 0.01)).toBe(false)
  })

  test("advisory deep gates the deep-tier hint", () => {
    expect(isAdvisoryDeep("deep", ADVISORY_DEEP_THRESHOLD)).toBe(true)
    expect(isAdvisoryDeep("deep", ADVISORY_DEEP_THRESHOLD - 0.01)).toBe(false)
    expect(isAdvisoryDeep("fast", 0.99)).toBe(false)
  })

  test("secret-like key scan flags key names only, never values", () => {
    expect(scanSecretLikeKeys({ summary: "ok", filesChanged: 1, riskSignals: ["none"] })).toEqual([])
    expect(scanSecretLikeKeys(null)).toEqual([])
    expect(scanSecretLikeKeys({ ApiKey: "v" })).toEqual(["ApiKey"])
    expect(
      scanSecretLikeKeys({
        summary: "x",
        auth: { apiToken: "abc", nested: { dbPassword: "hunter2" } },
        items: [{ clientSecret: "s" }],
      }),
    ).toEqual(["auth.apiToken", "auth.nested.dbPassword", "items.0.clientSecret"])
    // Secret-looking values under clean keys are not flagged.
    expect(scanSecretLikeKeys({ note: "sk-live-supersecret-token", count: 3 })).toEqual([])
  })
})

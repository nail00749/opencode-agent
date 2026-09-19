import { describe, expect, test } from "bun:test"
import {
  JEV_PROVIDER_DEFAULTS,
  jevStatus,
  normalizeJevAnswers,
  parseJevInput,
  resolveJevConfig,
  validateJevBaseUrl,
} from "./jev"

describe("Jev configuration", () => {
  test("defaults disabled with the recommended direct provider settings", () => {
    expect(resolveJevConfig(undefined)).toEqual({
      enabled: false,
      globalEnabled: false,
      provider: "typesafe",
      ...JEV_PROVIDER_DEFAULTS.typesafe,
      allowedAgents: ["master", "master-trusted", "planner", "researcher"],
    })
  })

  test("a project can disable but cannot enable the global kill switch", () => {
    expect(resolveJevConfig({ enabled: false }, { enabled: true }).enabled).toBe(false)
    expect(resolveJevConfig({ enabled: true }, { enabled: false }).enabled).toBe(false)
    expect(resolveJevConfig({ enabled: true }, { provider: "vercel" })).toMatchObject({
      enabled: true,
      globalEnabled: true,
      provider: "vercel",
    })
  })

  test("validates remote and localhost base URLs", () => {
    expect(validateJevBaseUrl("https://example.com/proxy/path")).toBeUndefined()
    expect(validateJevBaseUrl("http://localhost:3000/api")).toBeUndefined()
    expect(validateJevBaseUrl("http://127.0.0.1:8787")).toBeUndefined()
    expect(validateJevBaseUrl("http://example.com")).toContain("HTTPS")
    expect(validateJevBaseUrl("https://user:secret@example.com")).toContain("credentials")
    expect(validateJevBaseUrl("https://example.com/api?key=secret")).toContain("query")
    expect(validateJevBaseUrl("https://example.com/api#fragment")).toContain("fragment")
  })

  test("projects a secret-free runtime status", () => {
    const config = resolveJevConfig({ enabled: true, apiKeyEnv: "CUSTOM_JEV_KEY" })
    expect(jevStatus(config, { CUSTOM_JEV_KEY: "super-secret" })).toEqual({
      enabled: true,
      globalEnabled: true,
      provider: "typesafe",
      model: "jev-latest",
      baseUrlHost: "api.typesafe.ai",
      customBaseUrl: false,
      apiKeyEnv: "CUSTOM_JEV_KEY",
      credentialPresent: true,
      allowedAgents: ["master", "master-trusted", "planner", "researcher"],
      toolAvailable: true,
    })
  })
})

describe("Jev evaluation contract", () => {
  const input = {
    state: { ticket: "charged twice" },
    questions: {
      urgent: { type: "noul" as const, instructions: "Is this urgent?" },
      route: {
        type: "choice" as const,
        instructions: "Where should this go?",
        criteria: { billing: null, support: "technical issues" },
      },
      severity: {
        type: "score" as const,
        instructions: "How severe?",
        criteria: ["low", "high"],
      },
    },
  }

  test("parses bounded typed questions and rejects invalid inputs", () => {
    expect(parseJevInput(input)).toEqual(input)
    expect(() => parseJevInput({ ...input, questions: {} })).toThrow("1 to 32")
    expect(() => parseJevInput({ ...input, state: "x".repeat(256 * 1024 + 1) })).toThrow("256 KiB")
    expect(() => parseJevInput({
      ...input,
      questions: { urgent: { type: "noul", instructions: "x".repeat(512 * 1024) } },
    })).toThrow("512 KiB")
    expect(() => parseJevInput({
      ...input,
      questions: { route: { type: "choice", instructions: "route", criteria: { only: null } } },
    })).toThrow("2 to 255")
    expect(() => parseJevInput({ ...input, state: { invalid: Number.NaN } })).toThrow("finite")
    expect(() => parseJevInput({ ...input, state: { invalid: new Date() } })).toThrow("plain JSON")
  })

  test("normalizes direct and Vercel answers without inventing optional fields", () => {
    expect(normalizeJevAnswers(input.questions, {
      urgent: { type: "boolean", probability: 0.8 },
      route: { type: "choice", choice: "billing", probabilities: { billing: 0.9, support: 0.1 } },
      severity: { type: "score", score: 1 },
    })).toEqual({
      urgent: { type: "noul", noul: 0.8 },
      route: { type: "choice", choice: "billing", probabilities: { billing: 0.9, support: 0.1 } },
      severity: { type: "score", score: 1, legend: { "0": "low", "1": "high" } },
    })
    expect(normalizeJevAnswers(input.questions, {
      urgent: { type: "noul", noul: 0.7 },
      route: { type: "choice", choice: "support", confidence: 0.8, probabilities: { billing: 0.2, support: 0.8 } },
      severity: { type: "score", score: 0.6, confidence: 0.7, probabilities: { "0": 0.4, "1": 0.6 } },
    })).toEqual({
      urgent: { type: "noul", noul: 0.7 },
      route: { type: "choice", choice: "support", confidence: 0.8, probabilities: { billing: 0.2, support: 0.8 } },
      severity: {
        type: "score",
        score: 0.6,
        legend: { "0": "low", "1": "high" },
        confidence: 0.7,
        probabilities: { "0": 0.4, "1": 0.6 },
      },
    })
  })

  test("fails closed on mismatched IDs, types, ranges, and probability keys", () => {
    expect(() => normalizeJevAnswers(input.questions, {})).toThrow("IDs")
    expect(() => normalizeJevAnswers({ urgent: input.questions.urgent }, {
      urgent: { type: "noul", noul: 2 },
    })).toThrow("noul")
    expect(() => normalizeJevAnswers({ route: input.questions.route }, {
      route: { type: "choice", choice: "billing", probabilities: { billing: 1 } },
    })).toThrow("probability keys")
  })
})

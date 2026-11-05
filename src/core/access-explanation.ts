import type { PermissionRule } from "./config"

export type AccessEffect = "allow" | "ask" | "deny" | "unknown"
export type AccessEvidenceSource = "permission" | "trust-mode" | "lease" | "native-host" | "unknown"
export type AccessNextStep = "none" | "request-approval" | "ask-coordinator" | "inspect-policy" | "inspect-host" | "retry-preview"

/** Identifies one exact check. Resources are data, never commands to execute. */
export interface AccessExplanationInput {
  sessionID: string
  agent: string
  action: string
  resources: readonly string[]
  /** Absent means preview; present selects server-recorded evidence, not error text. */
  observationID?: string
}

export interface AccessEvidence {
  source: AccessEvidenceSource
  basis: "preview" | "observed"
  /** null means a batch-wide cause; otherwise the exact checked resource. */
  resource: string | null
  effect: AccessEffect
  /** Stable producer-owned reason code, never raw tool output or diagnostics. */
  code: string
  /** Actual matched rule only; null for inferred, unavailable, or non-rule causes. */
  matchedRule: PermissionRule | null
  nextStep: AccessNextStep
}

export interface AccessExplanation {
  sessionID: string
  agent: string
  action: string
  resources: readonly string[]
  kind: "preview" | "observed"
  observationID: string | null
  evidence: readonly AccessEvidence[]
  /** Only authoritative native-host evidence can establish the final outcome. */
  nativeOutcome: AccessEffect
  nextStep: AccessNextStep
}

/**
 * Producers supply structured facts from the deciding layer, never attribution
 * inferred from an error message. A missing observation is unknown, not denial.
 * Consumers display each layer separately; an allow preview is not authorization.
 * Observation lookup must correlate session, agent, action and resources on the
 * server. This builder does not authenticate or retrieve observations.
 */
export function buildAccessExplanation(
  input: AccessExplanationInput,
  evidence: readonly AccessEvidence[],
): AccessExplanation {
  const kind = input.observationID === undefined ? "preview" : "observed"
  const facts = evidence.filter((item) => item.basis === kind)
  const native = kind === "observed"
    ? facts.findLast((item) => item.source === "native-host")
    : undefined
  return {
    sessionID: input.sessionID,
    agent: input.agent,
    action: input.action,
    resources: [...input.resources],
    kind,
    observationID: input.observationID ?? null,
    evidence: facts.map((item) => ({ ...item, matchedRule: item.matchedRule ? { ...item.matchedRule } : null })),
    nativeOutcome: native?.effect ?? "unknown",
    nextStep: facts.findLast((item) => item.effect === "deny" || item.effect === "ask")?.nextStep
      ?? (native ? native.nextStep : "inspect-host"),
  }
}

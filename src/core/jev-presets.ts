import type { JevInput } from "./jev"

// Advisory thresholds for interpreting `gvozd_jev` answers. Jev output is a
// hint only: it never authorizes edits, shell, deployment, merging, or
// dismissing review findings. Master still decides from source evidence; a
// score at or above the threshold merely suggests the corresponding route.

/** Noul at or above this value suggests escalation (advisory only). */
export const ADVISORY_ESCALATE_THRESHOLD = 0.7

/** A "deep" choice at or above this confidence suggests the deep tier (advisory only). */
export const ADVISORY_DEEP_THRESHOLD = 0.6

// Secret-free states: summaries, counts, and risk labels only. Never put
// file contents, tokens, credentials, URLs with query strings, or command
// output into a Jev state; Jev is a narrow semantic judge, not a data pipe.
// Callers may check key names with `scanSecretLikeKeys` before sending, but
// preset builders never call it automatically: scanning stays an explicit
// caller-side step (advisory discipline), never a hidden gate.

/** Shared secret-free scope shape for the fast-vs-deep choice presets. */
export interface ScopeSummaryState {
  readonly summary: string
  readonly filesChanged: number
  readonly riskSignals: readonly string[]
}

/** Tier triage uses the shared scope shape. */
export type TierTriageState = ScopeSummaryState

/** Review depth uses the shared scope shape. */
export type ReviewDepthState = ScopeSummaryState

export interface EscalationGateState {
  readonly summary: string
  readonly fixRoundsUsed: number
  readonly riskSignals: readonly string[]
}

/** Tier triage: fast-vs-deep choice for an implementation scope. */
export function buildTierTriagePreset(state: TierTriageState): JevInput {
  return {
    state: {
      summary: state.summary,
      filesChanged: state.filesChanged,
      riskSignals: [...state.riskSignals],
    },
    questions: {
      tier: {
        type: "choice",
        instructions: "Which implementation tier fits this scope?",
        criteria: {
          fast: "small, localized, well-specified, low-risk change with a clear seam",
          deep: "ambiguous, cross-module, architectural, or failure-risky work needing deep analysis",
        },
      },
    },
  }
}

/** Review depth: fast-vs-deep choice for reviewing a finished diff. */
export function buildReviewDepthPreset(state: ReviewDepthState): JevInput {
  return {
    state: {
      summary: state.summary,
      filesChanged: state.filesChanged,
      riskSignals: [...state.riskSignals],
    },
    questions: {
      reviewDepth: {
        type: "choice",
        instructions: "Which review depth fits this finished diff?",
        criteria: {
          fast: "small, focused, low-risk diff suitable for a quick review pass",
          deep: "material, high-risk, cross-module, or security-sensitive diff needing deep review",
        },
      },
    },
  }
}

/** Escalation gating: noul likelihood that the current route is stuck. */
export function buildEscalationGatePreset(state: EscalationGateState): JevInput {
  return {
    state: {
      summary: state.summary,
      fixRoundsUsed: state.fixRoundsUsed,
      riskSignals: [...state.riskSignals],
    },
    questions: {
      escalate: {
        type: "noul",
        instructions: "Is this work stuck on its current route and in need of escalation?",
        criteria: {
          true: `escalate (advisory): noul at or above ${ADVISORY_ESCALATE_THRESHOLD} suggests escalating`,
          false: "keep the current route",
        },
      },
    },
  }
}

/** Applies ADVISORY_ESCALATE_THRESHOLD to a noul answer (advisory only). */
export function isAdvisoryEscalation(noul: number): boolean {
  return noul >= ADVISORY_ESCALATE_THRESHOLD
}

/** Applies ADVISORY_DEEP_THRESHOLD to a fast-vs-deep choice answer (advisory only). */
export function isAdvisoryDeep(choice: string, confidence: number): boolean {
  return choice === "deep" && confidence >= ADVISORY_DEEP_THRESHOLD
}

const SECRET_LIKE_KEY_PARTS = ["key", "token", "secret", "password", "credential", "authorization"] as const

function isSecretLikeKeyName(name: string): boolean {
  const lower = name.toLowerCase()
  return SECRET_LIKE_KEY_PARTS.some((part) => lower.includes(part))
}

/**
 * Caller-side guard: returns dotted paths of keys whose *name* looks
 * secret-like (case-insensitive substring on the key name only). Values are
 * never inspected, so a secret-looking value under a clean key is not
 * flagged. Preset builders never call this automatically; call it explicitly
 * before sending a state to Jev.
 */
export function scanSecretLikeKeys(state: unknown): string[] {
  const hits: string[] = []
  const seen = new Set<object>()
  function walk(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      if (seen.has(value)) return
      seen.add(value)
      for (let index = 0; index < value.length; index++) {
        walk(value[index], path === "" ? `${index}` : `${path}.${index}`)
      }
      return
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return
      seen.add(value)
      for (const name of Object.keys(value)) {
        const childPath = path === "" ? name : `${path}.${name}`
        if (isSecretLikeKeyName(name)) hits.push(childPath)
        walk((value as Record<string, unknown>)[name], childPath)
      }
    }
  }
  walk(state, "")
  return hits
}

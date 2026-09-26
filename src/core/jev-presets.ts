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

export interface TierTriageState {
  readonly summary: string
  readonly filesChanged: number
  readonly riskSignals: readonly string[]
}

export interface ReviewDepthState {
  readonly summary: string
  readonly filesChanged: number
  readonly riskSignals: readonly string[]
}

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

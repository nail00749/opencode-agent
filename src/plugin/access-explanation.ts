import { randomUUID } from "node:crypto"
import { matchingMcpServers, explicitMcpAccess, hasMcpServerAccess, wildcardMatch } from "../core/agent-permissions"
import {
  buildAccessExplanation,
  type AccessEffect,
  type AccessEvidence,
  type AccessEvidenceSource,
  type AccessExplanation,
  type AccessExplanationInput,
  type AccessNextStep,
} from "../core/access-explanation"
import type { PermissionRule } from "../core/config"
import {
  goalDecisionFor,
  modeDecisionFor,
  modeOverrideFor,
  sessionOverrideDecision,
  sessionPermissionAction,
  type SessionOverrideDecision,
  type SessionPermissionEffect,
} from "../core/session-permissions"
import { isVerificationMutation, shellMustNotEscalate } from "../core/tool-permissions"
import { modePermissions, type TrustMode } from "../rpc/trusted-mode"
import { redactDiagnostic } from "../shared/runtime-events"

const OWNED_ACTIONS = new Set(["gvozd.session-policy", "gvozd.session-overrides"])
const OBSERVATION_LIMIT = 128
const REASON_LIMIT = 240

/**
 * Internal decision fact. `decisive` is set by the branch that enforcement
 * actually applied, never by comparing the final effect or parsing a message.
 * It is stripped before the frozen RPC evidence schema.
 */
export interface AccessFact {
  source: AccessEvidenceSource
  resource: string | null
  effect: AccessEffect
  code: string
  matchedRule: PermissionRule | null
  nextStep: AccessNextStep
  decisive: boolean
}

export interface LeaseAccessTrace {
  handled: boolean
  effect: "allow" | "ask" | "deny"
  message?: string
  fact?: AccessFact
}

export interface DecideAccessAgent {
  disabled: boolean
  fileLease?: "coordinator" | "writer" | "readonly"
  skills: readonly string[]
  mcp: readonly string[]
  permissions: readonly PermissionRule[]
}

export interface NativeAccessRead {
  /** False when the host permissions could not be read. Do not invent a rule. */
  readable: boolean
  rule: PermissionRule | null
}

export interface DecideAccessInput {
  preview: boolean
  sessionID: string
  agent?: string
  action: string
  resources: readonly string[]
  incomingEffect: "allow" | "ask" | "deny"
  mcpServers: readonly string[]
  /** Enforcement-only. Preview must omit this so explanation cannot refresh host MCP state. */
  refreshMcpServers?: () => Promise<readonly string[]>
  mode: TrustMode
  override?: SessionPermissionEffect
  configured?: DecideAccessAgent
  /**
   * `authorize` is true only for enforcement. Implementations must call
   * `inspectMutation` when it is false and must not sweep or refresh then.
   */
  traceLease: (authorize: boolean) => LeaseAccessTrace
  /**
   * Read after the lease guard. Enforcement may expire the goal here; preview
   * callbacks must only read.
   */
  goalActive: () => boolean
  native: NativeAccessRead
}

export interface AccessDecision {
  effect?: "allow" | "ask" | "deny"
  message?: string
  evidence: AccessEvidence[]
}

interface ObservationRecord {
  id: string
  sessionID: string
  agent: string
  action: string
  resources: readonly string[]
  evidence: readonly AccessEvidence[]
}

export interface AccessObservationLog {
  record(input: Omit<ObservationRecord, "id">): string
  get(id: string): ObservationRecord | undefined
  close(): void
}

const ASK_GUIDANCE = "Use the existing approval prompt. Approval is a one-time user decision; do not retry, escalate, or execute a different command."
const STOP_GUIDANCE = "Stop. Protected destructive commands stay denied. Do not escalate, rewrite the command, or request a mode switch."
const RETURN_GUIDANCE = "Return this work to the coordinator or a writer. Do not switch mode, claim a lease, or mutate files."
const CLAIM_GUIDANCE = "Ask the coordinator to reserve or reassign the exact files, then claim that lease before editing. Do not edit until the claim succeeds."
const EXTEND_GUIDANCE = "Ask the coordinator to extend the lease with the exact file. Do not write outside the leased files."
const CONFLICT_GUIDANCE = "Coordinate with the coordinator to change the split or serialize the work. Do not release another lease or take the file."

const DENY_GUIDANCE: Record<string, string> = {
  READONLY_ROLE: RETURN_GUIDANCE,
  READONLY_VERIFICATION_MUTATION: RETURN_GUIDANCE,
  NO_ACTIVE_LEASE: CLAIM_GUIDANCE,
  LEASE_EXPIRED: CLAIM_GUIDANCE,
  OUT_OF_SCOPE: EXTEND_GUIDANCE,
  FILE_CONFLICT: CONFLICT_GUIDANCE,
  DESTRUCTIVE_CLAMP: STOP_GUIDANCE,
  SHELL_NEVER_ESCALATE: STOP_GUIDANCE,
  GOAL_DENY: STOP_GUIDANCE,
  UNCONFIGURED_AGENT: "These edits stay paused while writer leases are active. Coordinate through the coordinator; do not claim a lease or switch mode.",
  NO_AGENT_IDENTITY: "Stop. The write is denied without an agent identity. Do not retry with a guessed identity.",
  SKILL_SCOPE: "This skill is outside the agent scope. Ask the coordinator to change the assignment; do not grant access.",
  MCP_SCOPE: "This MCP server is outside the agent scope. Ask the coordinator to change the assignment; do not grant access.",
  MCP_AMBIGUOUS: "Stop. The MCP prefix is ambiguous. Fix the server configuration; do not guess a server.",
  SESSION_POSTURE: "Session posture denies this action. Ask the coordinator if the posture should change; do not switch mode yourself.",
  SESSION_OVERRIDE: "The session override denies this action. Do not bypass it or switch mode.",
  EXPLICIT_SHELL_DECISION: "The explicit shell decision denies this command. Do not escalate or switch mode.",
  SHELL_ESCALATION_DENY: "Stop. Shell escalation is disabled. Do not execute the command or switch mode.",
  INVALID_PATH: "Stop. The path is not an exact leasable file. Do not rewrite it into a pattern or bypass the lease.",
}

export function guidanceFor(code: string, effect: AccessEffect): string {
  if (code === "DESTRUCTIVE_CLAMP" || code === "SHELL_NEVER_ESCALATE" || code === "GOAL_DENY") return STOP_GUIDANCE
  if (effect === "ask") return ASK_GUIDANCE
  if (effect !== "deny") return ""
  return DENY_GUIDANCE[code] ?? "Stop. Do not bypass this denial, switch mode, release a lease, or execute the blocked action."
}

export function nextStepFor(code: string, effect: AccessEffect): AccessNextStep {
  if (effect === "allow" || effect === "unknown" || code === "FOREIGN_RULE" || code === "HOST_EFFECT") {
    return effect === "allow" ? "none" : "inspect-host"
  }
  if (code === "DESTRUCTIVE_CLAMP" || code === "SHELL_NEVER_ESCALATE" || code === "GOAL_DENY" || code === "SHELL_ESCALATION_DENY" || code === "NO_AGENT_IDENTITY" || code === "INVALID_PATH" || code === "MCP_AMBIGUOUS") {
    return "none"
  }
  if (effect === "ask") return "request-approval"
  if (code === "SESSION_POSTURE" || code === "SESSION_OVERRIDE" || code === "EXPLICIT_SHELL_DECISION" || code === "SKILL_SCOPE" || code === "MCP_SCOPE") {
    return "inspect-policy"
  }
  return "ask-coordinator"
}

/** Redact and bound untrusted reason text, then append a static next step. */
export function composeBlockMessage(reason: string, code: string, effect: AccessEffect): string {
  const safe = redactDiagnostic(reason).slice(0, REASON_LIMIT)
  const guidance = guidanceFor(code, effect)
  return guidance ? `${safe} ${guidance}` : safe
}

export function unknownAccessFact(code: string): AccessFact {
  return {
    source: "unknown",
    resource: null,
    effect: "unknown",
    code,
    matchedRule: null,
    nextStep: "inspect-host",
    decisive: false,
  }
}

/**
 * The frozen helper recommends the last ask/deny. Identify the branch that
 * enforcement applied first, then place that blocker last so an earlier or
 * later approval hint cannot hide a lease deny.
 */
export function orderDecisionEvidence(facts: readonly AccessFact[], basis: "preview" | "observed"): AccessEvidence[] {
  const ranked = facts.map((fact) => ({ ...fact }))
  const winnerAt = ranked.findIndex((fact) => fact.decisive && (fact.effect === "deny" || fact.effect === "ask"))
  if (winnerAt >= 0) {
    const [winner] = ranked.splice(winnerAt, 1)
    ranked.push(winner!)
  }
  return ranked.map((fact) => ({
    source: fact.source,
    basis,
    resource: fact.resource,
    effect: fact.effect,
    code: fact.code,
    matchedRule: fact.matchedRule ? { ...fact.matchedRule } : null,
    nextStep: fact.nextStep,
  }))
}

export function explainFromFacts(
  input: AccessExplanationInput,
  facts: readonly AccessFact[],
  basis: "preview" | "observed",
): AccessExplanation {
  return buildAccessExplanation(input, orderDecisionEvidence(facts, basis))
}

function isOwnedBegin(rule: PermissionRule): boolean {
  return OWNED_ACTIONS.has(rule.action) && rule.effect === "deny" && rule.resource.startsWith("begin:")
}

function isOwnedEnd(rule: PermissionRule, action: string): boolean {
  return rule.action === action && rule.effect === "deny" && rule.resource === "end"
}

/**
 * Foreign rules are those outside a well-formed Gvozd-owned block. A begin
 * without an end is unreadable, not an invitation to guess which rules are foreign.
 */
export function foreignRulesFromPermissions(permissions: readonly PermissionRule[] | undefined): PermissionRule[] | undefined {
  if (!permissions) return undefined
  const foreign: PermissionRule[] = []
  for (let index = 0; index < permissions.length; index++) {
    const rule = permissions[index]!
    if (!isOwnedBegin(rule)) {
      foreign.push(rule)
      continue
    }
    const end = permissions.findIndex((candidate, candidateIndex) => candidateIndex > index && isOwnedEnd(candidate, rule.action))
    if (end < 0) return undefined
    index = end
  }
  return foreign
}

export function matchedForeignRule(
  permissions: readonly PermissionRule[] | undefined,
  action: string,
  resources: readonly string[],
): NativeAccessRead {
  const foreign = foreignRulesFromPermissions(permissions)
  if (!foreign) return { readable: false, rule: null }
  const targets = resources.length > 0 ? resources : ["*"]
  let matched: PermissionRule | null = null
  for (const resource of targets) {
    let last: PermissionRule | undefined
    for (const rule of foreign) {
      if (wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, resource)) last = rule
    }
    if (!last) return { readable: true, rule: null }
    if (matched && (matched.action !== last.action || matched.resource !== last.resource || matched.effect !== last.effect)) {
      return { readable: true, rule: null }
    }
    matched = last
  }
  return { readable: true, rule: matched ? { ...matched } : null }
}

function resourceOf(resources: readonly string[]): string | null {
  return resources.length === 1 ? resources[0]! : null
}

function fact(
  source: AccessEvidenceSource,
  effect: AccessEffect,
  code: string,
  resources: readonly string[],
  matchedRule: PermissionRule | null,
  decisive: boolean,
): AccessFact {
  return {
    source,
    resource: resourceOf(resources),
    effect,
    code,
    matchedRule: matchedRule ? { ...matchedRule } : null,
    nextStep: nextStepFor(code, effect),
    decisive,
  }
}

function blockMessage(reason: string, code: string, effect: "allow" | "ask" | "deny"): string | undefined {
  if (effect === "allow") return reason
  return composeBlockMessage(reason, code, effect)
}

interface Applied {
  effect?: "allow" | "ask" | "deny"
  message?: string
  facts: AccessFact[]
  stopped: boolean
}

function assign(state: Applied, item: AccessFact, message: string | undefined, stop: boolean): void {
  for (const existing of state.facts) existing.decisive = false
  state.facts.push(item)
  state.effect = item.effect === "unknown" ? state.effect : item.effect
  state.message = message
  state.stopped = stop
}

function finish(input: DecideAccessInput, state: Applied): AccessDecision {
  const changed = state.effect !== undefined
  const foreignAgrees = input.native.rule?.effect === input.incomingEffect
  if (!input.preview && input.native.readable && !changed) {
    state.facts.push(fact(
      "native-host",
      input.incomingEffect,
      foreignAgrees ? "FOREIGN_RULE" : "HOST_EFFECT",
      input.resources,
      foreignAgrees ? input.native.rule : null,
      false,
    ))
  } else if (input.preview && input.native.readable && input.native.rule) {
    state.facts.push(fact("native-host", input.native.rule.effect, "FOREIGN_RULE", input.resources, input.native.rule, false))
  }
  return {
    ...(state.effect ? { effect: state.effect, message: state.message } : {}),
    evidence: orderDecisionEvidence(state.facts, input.preview ? "preview" : "observed"),
  }
}

function shellOverrideCode(override: SessionPermissionEffect | undefined, decision: SessionOverrideDecision): string {
  if (override !== "deny" && decision.effect === "deny") return "DESTRUCTIVE_CLAMP"
  return "EXPLICIT_SHELL_DECISION"
}

function postureCode(action: string, resources: readonly string[], mode: TrustMode): { effect: "allow" | "ask" | "deny" | undefined; code: string; rule: PermissionRule | null } {
  const rules = modePermissions(mode)
  const effect = modeDecisionFor(rules, action, resources)
  if (!effect) return { effect: undefined, code: "SESSION_POSTURE", rule: null }
  const underlying = modeOverrideFor(rules, action, resources)
  const clamped = sessionPermissionAction(action) === "shell"
    && shellMustNotEscalate(resources)
    && underlying !== undefined
    && underlying !== "deny"
    && effect === "deny"
  if (clamped || (effect === "deny" && sessionPermissionAction(action) === "shell" && shellMustNotEscalate(resources))) {
    return { effect, code: "DESTRUCTIVE_CLAMP", rule: null }
  }
  return { effect, code: "SESSION_POSTURE", rule: lastMatchingRule(rules, action, resources) }
}

function lastMatchingRule(rules: readonly PermissionRule[], action: string, resources: readonly string[]): PermissionRule | null {
  const targets = resources.length > 0 ? resources : ["*"]
  let selected: PermissionRule | undefined
  for (const resource of targets) {
    let matched: PermissionRule | undefined
    for (const rule of rules) {
      if (wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, resource)) matched = rule
    }
    if (matched?.effect === "deny") return { ...matched }
    if (!selected && matched) selected = matched
  }
  return selected ? { ...selected } : null
}

/**
 * Same control order as the permission hook. Preview callers must supply a
 * lease trace that only inspects, and must not pass mutation callbacks.
 */
export async function decideAccess(input: DecideAccessInput): Promise<AccessDecision> {
  const state: Applied = { facts: [], stopped: false }
  const resources = input.resources
  const category = sessionPermissionAction(input.action, input.mcpServers)
  const overrideDecision = sessionOverrideDecision(input.override, input.action, resources)
  if (category === "shell" && input.agent && input.configured?.fileLease === "readonly" && isVerificationMutation(resources)) {
    const item = fact("permission", "deny", "READONLY_VERIFICATION_MUTATION", resources, null, true)
    assign(state, item, blockMessage("Read-only verification cannot use mutating command options", item.code, "deny"), true)
    return finish(input, state)
  }
  if (category === "shell" && overrideDecision && overrideDecision.effect !== "ask") {
    const code = shellOverrideCode(input.override, overrideDecision)
    const item = fact("trust-mode", overrideDecision.effect, code, resources, null, true)
    assign(state, item, blockMessage(overrideDecision.message, code, overrideDecision.effect), true)
    return finish(input, state)
  }
  const lease = input.traceLease(!input.preview)
  if (lease.fact && !lease.handled) state.facts.push({ ...lease.fact, decisive: false })
  if (lease.handled) {
    // The ask was computed and bypassed only when it is not an early return.
    // Keep it visible, but the applied lease branch remains the recommendation.
    if (category === "shell" && overrideDecision?.effect === "ask") {
      state.facts.push(fact("trust-mode", "ask", "EXPLICIT_SHELL_DECISION", resources, null, false))
    }
    const item = fact("lease", lease.effect, lease.fact?.code ?? "LEASE_GUARD", resources, lease.fact?.matchedRule ?? null, true)
    assign(state, item, lease.message, true)
    return finish(input, state)
  }
  const configured = input.configured
  if (configured && !configured.disabled) {
    if (input.action === "skill") {
      const allowed = new Set(configured.skills)
      if (resources.some((resource) => !allowed.has(resource))) {
        const item = fact("permission", "deny", "SKILL_SCOPE", resources, null, true)
        assign(state, item, blockMessage(`Agent ${input.agent} cannot use this skill`, item.code, "deny"), false)
      }
    } else {
      let servers = input.mcpServers
      let matchingServers = matchingMcpServers(input.action, servers)
      if (!input.preview && matchingServers.length === 0 && input.action.includes("_") && input.refreshMcpServers) {
        servers = await input.refreshMcpServers()
        matchingServers = matchingMcpServers(input.action, servers)
      }
      if (matchingServers.length > 1) {
        const item = fact("permission", "deny", "MCP_AMBIGUOUS", resources, null, true)
        assign(state, item, blockMessage(`MCP action has an ambiguous server prefix: ${matchingServers.join(", ")}`, item.code, "deny"), true)
        return finish(input, state)
      }
      if (matchingServers.length === 1
        && !matchingServers.some((server) => hasMcpServerAccess(configured.mcp, server))
        && !explicitMcpAccess({ permissions: [...configured.permissions] }, input.action, resources)) {
        const item = fact("permission", "deny", "MCP_SCOPE", resources, null, true)
        assign(state, item, blockMessage(`Agent ${input.agent} cannot use this MCP server`, item.code, "deny"), false)
      }
    }
  }
  if (state.stopped) return finish(input, state)
  if (overrideDecision && overrideDecision.effect === "deny") {
    const code = shellOverrideCode(input.override, overrideDecision)
    const item = fact("trust-mode", "deny", code === "DESTRUCTIVE_CLAMP" ? code : "SESSION_OVERRIDE", resources, null, true)
    assign(state, item, blockMessage(overrideDecision.message, item.code, "deny"), true)
    return finish(input, state)
  }
  const posture = postureCode(input.action, resources, input.mode)
  if (posture.effect === "deny") {
    const item = fact("trust-mode", "deny", posture.code, resources, posture.rule, true)
    assign(state, item, blockMessage("Session posture denies this action", posture.code, "deny"), true)
    return finish(input, state)
  }
  // Goal expiry is owned by the enforcement callback. It runs only after the
  // lease guard and deny clamps above, so a goal cannot widen those blocks.
  const goalActive = input.goalActive()
  const goalDecision = goalDecisionFor(goalActive, true, input.action, resources, input.mcpServers)
  if (goalDecision && goalDecision.effect === "deny") {
    const item = fact("trust-mode", "deny", "GOAL_DENY", resources, null, true)
    assign(state, item, blockMessage(goalDecision.message, item.code, "deny"), true)
    return finish(input, state)
  }
  if (overrideDecision) {
    const item = fact("trust-mode", overrideDecision.effect, "SESSION_OVERRIDE", resources, null, true)
    assign(state, item, blockMessage(overrideDecision.message, "SESSION_OVERRIDE", overrideDecision.effect), true)
    return finish(input, state)
  }
  if (goalDecision) {
    const item = fact("trust-mode", goalDecision.effect, "GOAL_MODE", resources, null, true)
    assign(state, item, goalDecision.effect === "allow" ? goalDecision.message : blockMessage(goalDecision.message, "GOAL_MODE", goalDecision.effect), true)
    return finish(input, state)
  }
  if (posture.effect) {
    const item = fact("trust-mode", posture.effect, "SESSION_POSTURE", resources, posture.rule, true)
    const reason = `Session posture: ${posture.effect}`
    assign(state, item, blockMessage(reason, "SESSION_POSTURE", posture.effect), false)
  }
  return finish(input, state)
}

export function parseAccessExplanationInput(raw: unknown): AccessExplanationInput {
  if (!raw || typeof raw !== "object") throw new Error("Access explanation input must be an object")
  const value = raw as Record<string, unknown>
  if ("execute" in value || "error" in value || "diagnostic" in value) {
    throw new Error("Access explanation does not execute commands or accept diagnostics")
  }
  const { sessionID, agent, action, resources, observationID } = value
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new Error("sessionID is required")
  if (typeof agent !== "string" || agent.length === 0) throw new Error("agent is required")
  if (typeof action !== "string" || action.length === 0) throw new Error("action is required")
  if (!Array.isArray(resources) || resources.some((item) => typeof item !== "string")) {
    throw new Error("resources must be an array of strings")
  }
  if (observationID !== undefined && (typeof observationID !== "string" || observationID.length === 0)) {
    throw new Error("observationID must be a non-empty string")
  }
  return {
    sessionID,
    agent,
    action,
    resources: [...resources],
    ...(typeof observationID === "string" ? { observationID } : {}),
  }
}

export function createAccessObservationLog(): AccessObservationLog {
  const records = new Map<string, ObservationRecord>()
  const order: string[] = []
  let closed = false
  return {
    record(input) {
      if (closed) throw new Error("Access observation log is closed")
      const id = `gvxobs_${randomUUID()}`
      records.set(id, {
        id,
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.action,
        resources: [...input.resources],
        evidence: input.evidence.map((item) => ({
          ...item,
          matchedRule: item.matchedRule ? { ...item.matchedRule } : null,
        })),
      })
      order.push(id)
      while (order.length > OBSERVATION_LIMIT) {
        const removed = order.shift()
        if (removed) records.delete(removed)
      }
      return id
    },
    get(id) {
      if (closed) return undefined
      const found = records.get(id)
      if (!found) return undefined
      return {
        ...found,
        resources: [...found.resources],
        evidence: found.evidence.map((item) => ({
          ...item,
          matchedRule: item.matchedRule ? { ...item.matchedRule } : null,
        })),
      }
    },
    close() {
      closed = true
      records.clear()
      order.length = 0
    },
  }
}

export function observationCorrelates(record: Pick<ObservationRecord, "sessionID" | "agent" | "action" | "resources">, input: AccessExplanationInput): boolean {
  return record.sessionID === input.sessionID
    && record.agent === input.agent
    && record.action === input.action
    && record.resources.length === input.resources.length
    && record.resources.every((resource, index) => resource === input.resources[index])
}

import { Rpc } from "@opencode/plugin/rpc"
import { wildcardMatch as match } from "./agent-permissions"
import type { PermissionRule } from "./config"

/**
 * JSON-Schema-only RPC so the definition stays dependency-free.
 * Evaluates which effect the agent-gvozd ruleset would produce for a
 * hypothetical tool call — the "dry run" behind the /gvozd debug panel.
 */
export const GvozdPermissions = Rpc.define({
  id: "gvozd-permissions",
  events: {},
  methods: {
    evaluate: {
      input: {
        type: "object",
        properties: {
          agent: { type: "string" },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                resources: { type: "array", items: { type: "string" } },
              },
              required: ["action", "resources"],
              additionalProperties: false,
            },
          },
        },
        required: ["agent", "checks"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                resource: { type: "string" },
                effect: { type: "string", enum: ["allow", "ask", "deny", "unknown"] },
                matchedRule: { type: ["string", "null"] },
              },
              required: ["action", "resource", "effect", "matchedRule"],
              additionalProperties: false,
            },
          },
        },
        required: ["results"],
        additionalProperties: false,
      },
    },
  },
})

/**
 * Lease snapshot RPC: the TUI lease panel lists active and reserved leases
 * with owners, files, and remaining TTL so coordination is observable.
 */
export const GvozdLeases = Rpc.define({
  id: "gvozd-leases",
  events: {},
  methods: {
    list: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          leases: {
            type: "array",
            items: {
              type: "object",
              properties: {
                leaseId: { type: "string" },
                parentSessionID: { type: "string" },
                sessionID: { type: "string" },
                agent: { type: "string" },
                label: { type: "string" },
                state: { type: "string", enum: ["reserved", "active"] },
                files: { type: "array", items: { type: "string" } },
                expiresAt: { type: "number" },
                lastActivityAt: { type: "number" },
              },
              required: ["leaseId", "parentSessionID", "agent", "label", "state", "files", "expiresAt", "lastActivityAt"],
              additionalProperties: false,
            },
          },
        },
        required: ["leases"],
        additionalProperties: false,
      },
    },
  },
})

export interface LeaseSnapshotEntry {
  leaseId: string
  parentSessionID: string
  sessionID?: string
  agent: string
  label: string
  state: "reserved" | "active"
  files: string[]
  expiresAt: number
  lastActivityAt: number
}

export interface LeaseListOutput {
  leases: LeaseSnapshotEntry[]
}

export interface EvaluateInput {
  agent: string
  checks: { action: string; resources: readonly string[] }[]
}

export interface EvaluateOutput {
  results: {
    action: string
    resource: string
    effect: "allow" | "ask" | "deny" | "unknown"
    matchedRule: string | null
  }[]
}

/**
 * Replicates the OpenCode last-match-wins permission evaluation for a
 * hypothetical call. Shares wildcardMatch from agent-permissions.ts so the
 * dry run agrees with real enforcement (single implementation).
 */
export function evaluateEffect(
  rules: readonly PermissionRule[],
  action: string,
  resource: string,
): { effect: "allow" | "ask" | "deny" | "unknown"; matchedRule: string | null } {
  let matched: PermissionRule | undefined
  for (const rule of rules) {
    if (match(rule.action, action) && match(rule.resource, resource)) matched = rule
  }
  if (!matched) return { effect: "unknown", matchedRule: null }
  return { effect: matched.effect, matchedRule: `${matched.action} ${matched.resource}` }
}

export function evaluateInput(
  agentRules: readonly PermissionRule[] | undefined,
  input: EvaluateInput,
): EvaluateOutput {
  const results = input.checks.flatMap((request) =>
    (request.resources.length > 0 ? request.resources : ["*"]).map((resource) => {
      const evaluation = agentRules
        ? evaluateEffect(agentRules, request.action, resource)
        : { effect: "unknown" as const, matchedRule: null }
      return {
        action: request.action,
        resource,
        effect: evaluation.effect,
        matchedRule: evaluation.matchedRule,
      }
    }),
  )
  return { results }
}

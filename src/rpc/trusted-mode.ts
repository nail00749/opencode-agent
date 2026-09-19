import { Rpc } from "@opencode/plugin/rpc"
import type { SessionPermissionOverrides } from "../core/session-permissions"
import { SESSION_PERMISSION_EFFECTS } from "../core/session-permissions"
import { shellNeverEscalateRules } from "../core/tool-permissions"

/** Session permission postures the mode RPC can switch between. */
export const TRUST_MODES = ["balanced", "trusted", "strict"] as const
export type TrustMode = (typeof TRUST_MODES)[number]

/** One session-scoped permission rule for a mode. */
export interface ModePermissionRule {
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
}

/**
 * OpenCode V2 persists command permissions as `bash`, while some plugin API
 * surfaces report the same tool category as `shell`. Keep both aliases in the
 * session rules so native child-session inheritance and the evaluate-hook
 * fallback enforce the same posture.
 */
export const SHELL_PERMISSION_ACTIONS = ["shell", "bash"] as const

export function isShellPermissionAction(action: string): boolean {
  return (SHELL_PERMISSION_ACTIONS as readonly string[]).includes(action)
}

function withShellPermissionAliases(rules: readonly ModePermissionRule[]): ModePermissionRule[] {
  return rules.flatMap((rule) => rule.action === "shell"
    ? [rule, { ...rule, action: "bash" }]
    : [rule])
}

export const GvozdMode = Rpc.define({
  id: "gvozd-mode",
  events: {},
  methods: {
    set: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          mode: { type: "string", enum: [...TRUST_MODES] },
        },
        required: ["sessionID", "mode"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          mode: { type: "string", enum: [...TRUST_MODES] },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    },
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          mode: { type: "string", enum: [...TRUST_MODES] },
          overrides: {
            type: "object",
            properties: {
              shell: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              edit: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              skill: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              mcp: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
            },
            additionalProperties: false,
          },
        },
        required: ["mode", "overrides"],
        additionalProperties: false,
      },
    },
    setOverrides: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          overrides: {
            type: "object",
            properties: {
              shell: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              edit: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              skill: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              mcp: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
            },
            additionalProperties: false,
          },
        },
        required: ["sessionID", "overrides"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          overrides: {
            type: "object",
            properties: {
              shell: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              edit: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              skill: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
              mcp: { type: "string", enum: [...SESSION_PERMISSION_EFFECTS] },
            },
            additionalProperties: false,
          },
        },
        required: ["overrides"],
        additionalProperties: false,
      },
    },
  },
})

export interface ModeSetInput {
  sessionID: string
  mode: TrustMode
}

export interface ModeGetInput {
  sessionID: string
}

export interface ModeOutput {
  mode: TrustMode
  overrides?: SessionPermissionOverrides
}

export interface ModeSetOverridesInput {
  sessionID: string
  overrides: SessionPermissionOverrides
}

export interface ModeSetOverridesOutput {
  overrides: SessionPermissionOverrides
}

/**
 * Session-scoped rules per mode. They evaluate after the agent's rules with
 * last-match-wins, so "trusted" re-appends the protected denies after its
 * broad allows to keep destructive Git operations denied.
 */
export function modePermissions(mode: TrustMode): ModePermissionRule[] {
  if (mode === "trusted") {
    return [
      { action: "shell", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "bash", resource: "*", effect: "allow" },
      // Session rules come after agent rules, so re-assert every protected
      // shell family last. Recovery forms are appended by the helper after
      // the blanket rebase denial.
      ...withShellPermissionAliases(shellNeverEscalateRules()),
    ]
  }
  if (mode === "strict") {
    return [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "bash", resource: "*", effect: "ask" },
      ...withShellPermissionAliases(shellNeverEscalateRules("ask")),
    ]
  }
  return []
}

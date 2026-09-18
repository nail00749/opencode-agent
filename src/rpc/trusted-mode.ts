import { Rpc } from "@opencode/plugin/rpc"
import type { SessionPermissionOverrides } from "../core/session-permissions"
import { SESSION_PERMISSION_EFFECTS } from "../core/session-permissions"

/** Session permission postures the mode RPC can switch between. */
export const TRUST_MODES = ["balanced", "trusted", "strict"] as const
export type TrustMode = (typeof TRUST_MODES)[number]

/** One session-scoped permission rule for a mode. */
export interface ModePermissionRule {
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
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
      // Session rules come after agent rules, so re-assert the protected
      // deny set last: a trusted session still cannot force-push, rewrite
      // history, or wipe untracked files without an explicit per-command ask.
      { action: "shell", resource: "git push --force*", effect: "deny" },
      { action: "shell", resource: "git push -f*", effect: "deny" },
      { action: "shell", resource: "git reset --hard*", effect: "deny" },
      { action: "shell", resource: "git clean*", effect: "deny" },
      { action: "shell", resource: "git filter-branch*", effect: "deny" },
      { action: "shell", resource: "git filter-repo*", effect: "deny" },
      { action: "shell", resource: "git rebase*", effect: "deny" },
      { action: "shell", resource: "git checkout --*", effect: "deny" },
      { action: "shell", resource: "git restore*", effect: "deny" },
      // Recovery from an interrupted rebase is legitimate bookkeeping, not a
      // rewrite; last-match-wins lets these trailing allows re-open exactly
      // the abort/continue forms after the blanket rebase deny.
      { action: "shell", resource: "git rebase --abort*", effect: "allow" },
      { action: "shell", resource: "git rebase --continue*", effect: "allow" },
    ]
  }
  if (mode === "strict") {
    return [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
    ]
  }
  return []
}

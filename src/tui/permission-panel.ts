import {
  SESSION_PERMISSION_ACTIONS,
  type SessionPermissionAction,
  type SessionPermissionEffect,
  type SessionPermissionOverrides,
} from "../core/session-permissions"
import type { TrustMode } from "../rpc/trusted-mode"

/**
 * Presentation logic for the session permission toggle panel, kept out of the
 * JSX so it can be unit-tested without a renderer.
 */

export interface ToggleRow {
  readonly action: SessionPermissionAction
  readonly label: string
  readonly effect: SessionPermissionEffect
  /** Rendered checkbox glyph: `[x]` when overridden, `[ ]` when inheriting. */
  readonly checkbox: string
  /** Human-readable line shown in the select list. */
  readonly display: string
}

const LABELS: Record<SessionPermissionAction, string> = {
  shell: "shell commands",
  edit: "file edits",
  skill: "skills",
  mcp: "MCP servers",
}

const EFFECT_HINTS: Record<SessionPermissionEffect, string> = {
  inherit: "agent policy decides",
  allow: "allow without asking",
  ask: "ask for approval",
  deny: "block outright",
}

export function checkboxFor(effect: SessionPermissionEffect): string {
  return effect === "inherit" ? "[ ]" : "[x]"
}

/** Builds one row per toggle category in a stable order. */
export function toggleRows(overrides: SessionPermissionOverrides): ToggleRow[] {
  return SESSION_PERMISSION_ACTIONS.map((action) => {
    const effect = overrides[action] ?? "inherit"
    return {
      action,
      label: LABELS[action],
      effect,
      checkbox: checkboxFor(effect),
      display: `${checkboxFor(effect)} ${LABELS[action]} — ${effect} (${EFFECT_HINTS[effect]})`,
    }
  })
}

/** Applies one category's next value, returning a new overrides object. */
export function nextOverrides(
  overrides: SessionPermissionOverrides,
  action: SessionPermissionAction,
  effect: SessionPermissionEffect,
): SessionPermissionOverrides {
  const next: SessionPermissionOverrides = { ...overrides }
  if (effect === "inherit") delete next[action]
  else next[action] = effect
  return next
}

/** Short summary for the panel header, e.g. "shell=deny, edit=allow". */
export function summarizeOverrides(overrides: SessionPermissionOverrides): string {
  const entries = SESSION_PERMISSION_ACTIONS
    .filter((action) => overrides[action] !== undefined)
    .map((action) => `${action}=${overrides[action]}`)
  return entries.length > 0 ? entries.join(", ") : "none (agent policy decides)"
}

/** Compact sidebar status that keeps the effective shell posture visible. */
export function sessionPermissionStatus(mode: TrustMode, overrides: SessionPermissionOverrides): string {
  const shell = overrides.shell ?? (mode === "trusted" ? "allow" : mode === "strict" ? "ask" : "agent policy")
  return `mode: ${mode} · shell: ${shell}`
}

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
  readonly effective: Exclude<SessionPermissionEffect, "inherit"> | "agent policy"
  readonly source: "session family override" | "session override" | "trusted mode" | "strict mode" | "inherited"
  /** Rendered checkbox glyph: `[x]` when overridden, `[ ]` when inheriting. */
  readonly checkbox: string
  /** Human-readable line shown in the select list. */
  readonly display: string
}

const LABELS: Record<SessionPermissionAction, string> = {
  shell: "shell commands (session family)",
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
export function toggleRows(overrides: SessionPermissionOverrides, mode: TrustMode = "balanced"): ToggleRow[] {
  return SESSION_PERMISSION_ACTIONS.map((action) => {
    const effect = overrides[action] ?? "inherit"
    const modeEffect = (action === "shell" || action === "edit")
      ? mode === "trusted" ? "allow" : mode === "strict" ? "ask" : undefined
      : undefined
    const effective = effect === "inherit" ? modeEffect ?? "agent policy" : effect
    const source = effect !== "inherit"
      ? action === "shell" ? "session family override" : "session override"
      : modeEffect ? mode === "trusted" ? "trusted mode" : "strict mode" : "inherited"
    return {
      action,
      label: LABELS[action],
      effect,
      effective,
      source,
      checkbox: checkboxFor(effect),
      display: `${checkboxFor(effect)} ${LABELS[action]} — ${effective} (${source}; ${EFFECT_HINTS[effect]})`,
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
  if (overrides.shell === "allow") return `mode: ${mode} · shell: allow (family grant; destructive denied)`
  return `mode: ${mode} · shell: ${shell}${shell === "allow" ? " (lease guard applies)" : ""}`
}

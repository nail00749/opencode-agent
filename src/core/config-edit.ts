import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { assertRegularFile, atomicWrite, setJsonc, snapshot, type FileSnapshot } from "../shared/config-file"

/**
 * Pure editing of the managed global Gvozd config file (`gvozd/config.jsonc`
 * under the OpenCode config root). Merges agent/lease patches into the
 * existing JSONC with comments preserved, then writes atomically. Security
 * invariants live in `shared/config-file.ts`.
 */

export interface GlobalEditPreflight {
  readonly configPath: string
  readonly base: string
  readonly configSnapshot: FileSnapshot
}

/** Captures the managed global config target before any edit is applied. */
export function preflightGlobalEdit(configRoot: string): { configPath: string; base: string; configSnapshot: FileSnapshot } {
  const configPath = join(configRoot, "gvozd", "config.jsonc")
  if (existsSync(configPath)) {
    assertRegularFile(configPath, "Global Gvozd config")
  }
  const base = existsSync(configPath) ? readFileSync(configPath, "utf8") : '{\n  "$schema": "./schema.json",\n  "agents": {}\n}\n'
  return { configPath, base, configSnapshot: snapshot(configPath) }
}

export interface AgentEditPatch {
  readonly id: string
  readonly models?: readonly string[]
  readonly disabled?: boolean
}

export interface LeaseEditPatch {
  readonly reservationTtlMinutes?: number
  readonly activeTtlMinutes?: number
  readonly shellEscalation?: "ask" | "deny"
}

/**
 * Renders the next managed global config source from the current base and a
 * validated patch. Throws on malformed base or patch values; callers own
 * schema validation before calling here.
 */
export function editGlobalConfig(base: string, agents: readonly AgentEditPatch[], lease: LeaseEditPatch | undefined): string {
  let updated = base
  for (const patch of agents) {
    if (patch.models !== undefined) updated = setJsonc(updated, ["agents", patch.id, "models"], [...patch.models])
    if (patch.disabled !== undefined) updated = setJsonc(updated, ["agents", patch.id, "disabled"], patch.disabled)
  }
  if (lease?.reservationTtlMinutes !== undefined) {
    updated = setJsonc(updated, ["lease", "reservationTtlMinutes"], lease.reservationTtlMinutes)
  }
  if (lease?.activeTtlMinutes !== undefined) {
    updated = setJsonc(updated, ["lease", "activeTtlMinutes"], lease.activeTtlMinutes)
  }
  if (lease?.shellEscalation !== undefined) {
    updated = setJsonc(updated, ["lease", "shellEscalation"], lease.shellEscalation)
  }
  return updated
}

/** Applies one validated patch to the managed global config, atomically. */
export function applyGlobalEdit(
  globalConfigDirectory: string,
  patch: { agents: readonly AgentEditPatch[]; lease: LeaseEditPatch },
  expected?: FileSnapshot,
): string {
  const configPath = join(globalConfigDirectory, "config.jsonc")
  // Snapshot BEFORE reading the base: the write then refuses if anything
  // changed the file between this read and the atomic replace, so a patch
  // can never silently drop a concurrent external edit.
  const identity = expected ?? snapshot(configPath)
  const base = identity.exists && identity.bytes !== undefined ? identity.bytes : '{\n  "$schema": "./schema.json",\n  "agents": {}\n}\n'
  const next = editGlobalConfig(base, patch.agents, patch.lease)
  atomicWrite(configPath, next.endsWith("\n") ? next : `${next}\n`, identity)
  return next
}
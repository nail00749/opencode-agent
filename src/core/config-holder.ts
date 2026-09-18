import { applyGlobalEdit, type AgentEditPatch, type LeaseEditPatch } from "./config-edit"
import { loadConfig, type LoadConfigOptions, type ResolvedConfig } from "./config"

/**
 * Holds the server-side resolved configuration so RPC handlers can read the
 * fresh state, apply persistent patches to the managed global file, and
 * trigger agent reloads against it. `loadConfig` runs once during plugin
 * setup; the host never re-runs it, so persistence flows need an explicit
 * reload through this holder.
 */
export interface ConfigHolder {
  /** Currently held resolved configuration. */
  readonly get: () => ResolvedConfig
  /** Replaces the held value with a caller-built configuration. */
  readonly set: (config: ResolvedConfig) => void
  /** Re-reads the layered configuration from disk and replaces the held value. */
  readonly reload: () => ResolvedConfig
  /** Applies one validated agent/lease patch to the managed global file. */
  readonly patch: (agents: readonly AgentEditPatch[], lease: LeaseEditPatch) => ResolvedConfig
}

export function createConfigHolder(projectDirectory: string, options: LoadConfigOptions = {}): ConfigHolder {
  const reload = (): ResolvedConfig => loadConfig(projectDirectory, options)
  let current = reload()
  return {
    get: () => current,
    set: (config) => {
      current = config
    },
    reload,
    patch: (agents, lease) => {
      applyGlobalEdit(current.globalConfigDirectory, { agents, lease })
      current = reload()
      return current
    },
  }
}

/** Adapts an existing resolved configuration (tests, dry runs) to the holder. */
export function configHolderOf(initial: ResolvedConfig): ConfigHolder {
  let current = initial
  return {
    get: () => current,
    set: (config) => {
      current = config
    },
    reload: () => current,
    // Persistent patching writes the managed global file and re-reads the
    // layered configuration; the adapter has no reload parameters, so it
    // refuses instead of pretending the held value is fresh.
    patch: () => {
      throw new Error("Persistent config patching requires createConfigHolder")
    },
  }
}

export type { AgentEditPatch, LeaseEditPatch } from "./config-edit"
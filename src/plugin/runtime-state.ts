import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { FileLeaseManager, type FileLeaseManagerOptions } from "../core/file-leases"
import type { SessionPermissionOverrides } from "../core/session-permissions"
import type { GoalFamilyRecord } from "../rpc/goal-mode"

// Locations in one OpenCode host share ownership. Separate hosts remain outside
// the cooperative lease contract; unloading one location must not revoke another.
const leases = new Map<string, { manager: FileLeaseManager; users: number }>()

export function acquireLeaseManager(options: FileLeaseManagerOptions) {
  const key = realpathSync(options.projectRoot)
  let entry = leases.get(key)
  if (!entry) {
    entry = { manager: new FileLeaseManager(options), users: 0 }
    leases.set(key, entry)
  }
  entry.users++
  let released = false
  return {
    manager: entry.manager,
    release() {
      if (released) return
      released = true
      if (--entry.users === 0) {
        entry.manager.clear()
        leases.delete(key)
      }
    },
  }
}

interface SessionRuntimeState {
  goals: Map<string, GoalFamilyRecord>
  overrides: Map<string, SessionPermissionOverrides>
  families: Map<string, string>
  intentClock: Map<string, number>
  polling: boolean
  policyQueues: Map<string, Promise<void>>
}

const sessions = new Map<string, { state: SessionRuntimeState; users: number }>()

export function acquireSessionRuntime(directory: string, restore: () => Map<string, GoalFamilyRecord>) {
  const key = resolve(directory)
  let entry = sessions.get(key)
  if (!entry) {
    entry = { users: 0, state: {
      goals: restore(), overrides: new Map(), families: new Map(), intentClock: new Map(), polling: false, policyQueues: new Map(),
    } }
    sessions.set(key, entry)
  }
  entry.users++
  let released = false
  return {
    state: entry.state,
    dispose() {
      if (released) return
      released = true
      if (--entry.users === 0) sessions.delete(key)
    },
  }
}

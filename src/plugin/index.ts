import { Agent, Model, Plugin } from "@opencode/plugin"
import { buildAgentPermissions, explicitMcpAccess, matchingMcpServers } from "../core/agent-permissions"
import { join } from "node:path"
import { createConfigHolder, type ConfigHolder, type JevEditPatch, type LeaseEditPatch } from "../core/config-holder"
import { GvozdLeases, GvozdPermissions, evaluateInput, type EvaluateInput, type LeaseListOutput } from "../rpc/permissions-rpc"
import { GvozdConfig, configPatchSchema, type ConfigGetOutput, type ConfigPatchOutput } from "../rpc/config-rpc"
import { GvozdRoster, type RosterListOutput } from "../rpc/roster-rpc"
import {
  GvozdMode,
  isShellPermissionAction,
  modePermissions,
  SHELL_PERMISSION_ACTIONS,
  type ModeGetInput,
  type ModePermissionRule,
  type ModeSetInput,
  type ModeSetOverridesInput,
  type TrustMode,
} from "../rpc/trusted-mode"
import {
  modeDecisionFor,
  sessionOverrideDecision,
  sessionPermissionAction,
  type SessionPermissionOverrides,
} from "../core/session-permissions"
import { installFileLeaseRuntime } from "./file-lease-plugin"
import { resolveCaseInsensitiveFilesystem } from "../core/file-leases"
import { disposeResources, startRuntimeEventLoop } from "../shared/runtime-events"
import { parseOpenCodeVersion, satisfiesOpenCodeRange } from "../core/version"
import { SUPPORTED_OPENCODE_VERSION } from "../core/release-metadata"
import { jevStatus } from "../core/jev"
import { installJevRuntime } from "./jev-plugin"

function selectModel(models: string[], available: Awaited<ReturnType<Plugin.Context["catalog"]["model"]["list"]>>["data"]): Model.Ref {
  const configured = models.map((model) => Model.Ref.parse(model))
  const selected = configured.find((candidate) => {
    const match = available.find(
      (model) => model.enabled && model.providerID === candidate.providerID && model.id === candidate.id,
    )
    if (!match) return false
    return candidate.variant === undefined || match.variants.some((variant) => variant.id === candidate.variant)
  })
  return selected ?? configured[0]!
}

type ModelListData = Awaited<ReturnType<Plugin.Context["catalog"]["model"]["list"]>>["data"]

/**
 * OpenCode 2.0.4 split the catalog domain into top-level `model` and
 * `provider` domains and removed `ctx.catalog`; 2.0.2–2.0.3 hosts only expose
 * `ctx.catalog.model`. Both surfaces return the same `{ data }` envelope, and
 * reading whichever one the host provides keeps one build working across the
 * supported 2.0.* range. A host with neither surface degrades to unvalidated
 * configured model refs instead of failing setup.
 */
async function listModels(ctx: Plugin.Context, diagnostic: (message: string) => void): Promise<ModelListData> {
  const flat = ctx as unknown as { model?: { list(): Promise<{ data: ModelListData }> } }
  if (typeof flat.model?.list === "function") return (await flat.model.list()).data
  if (typeof ctx.catalog?.model?.list === "function") return (await ctx.catalog.model.list()).data
  diagnostic("agent-gvozd: host exposes no model catalog; agent models fall back to configured refs")
  return []
}

/**
 * Emits a diagnostic when the host advertises a version outside the supported
 * range. This is advisory only: the plugin adapts to the API surface it is
 * actually handed (see `listModels`), so a newer in-range host is not failed
 * merely because a version string looks unexpected. It exists so an out-of-
 * range host produces a clear message instead of an obscure crash.
 */
function reportHostVersion(ctx: Plugin.Context, diagnostic: (message: string) => void): void {
  const version = parseOpenCodeVersion(ctx.app?.version ?? "")
  if (version && !satisfiesOpenCodeRange(version, SUPPORTED_OPENCODE_VERSION)) {
    diagnostic(
      `agent-gvozd: OpenCode ${version} is outside the supported ${SUPPORTED_OPENCODE_VERSION} range; `
      + "the plugin will adapt to the available API but compatibility is not guaranteed",
    )
  }
}

type AgentTransformCallback = Parameters<Plugin.Context["agent"]["transform"]>[0]
type AgentTransformEditor = Parameters<AgentTransformCallback>[0]

interface SessionFamilyResolver {
  resolve(sessionID: string): Promise<string>
  remember(sessionID: string, parentID?: string): void
}

const NATIVE_POLICY_ACTION = "gvozd.session-policy"
const NATIVE_POLICY_END: ModePermissionRule = {
  action: NATIVE_POLICY_ACTION,
  resource: "end",
  effect: "deny",
}

interface NativePolicyState {
  mode: TrustMode
  shell?: NonNullable<SessionPermissionOverrides["shell"]>
}

function nativePolicyBegin(state: NativePolicyState): ModePermissionRule {
  return {
    action: NATIVE_POLICY_ACTION,
    resource: `begin:${state.mode}:${state.shell ?? "inherit"}`,
    effect: "deny",
  }
}

function parseNativePolicyBegin(rule: ModePermissionRule): NativePolicyState | undefined {
  if (rule.action !== NATIVE_POLICY_ACTION || rule.effect !== "deny") return undefined
  const match = /^begin:(balanced|trusted|strict):(allow|ask|deny|inherit)$/.exec(rule.resource)
  if (!match) return undefined
  const mode = match[1] as TrustMode
  const shell = match[2] as NonNullable<SessionPermissionOverrides["shell"]>
  return shell === "inherit" ? { mode } : { mode, shell }
}

function samePermissionRule(left: ModePermissionRule, right: ModePermissionRule): boolean {
  return left.action === right.action && left.resource === right.resource && left.effect === right.effect
}

/**
 * Replace only the Gvozd-owned rule block. The markers survive plugin reloads,
 * while rules authored by the user or another plugin stay byte-for-byte and in
 * the same order outside the block.
 */
function findNativePolicyBlock(permissions: readonly ModePermissionRule[]): {
  start: number
  end: number
  state: NativePolicyState
} | undefined {
  for (let start = 0; start < permissions.length; start++) {
    const state = parseNativePolicyBegin(permissions[start]!)
    if (!state) continue
    const end = permissions.findIndex(
      (rule, index) => index > start && samePermissionRule(rule, NATIVE_POLICY_END),
    )
    if (end >= 0) return { start, end, state }
  }
  return undefined
}

function replaceNativePolicyBlock(
  permissions: readonly ModePermissionRule[],
  rules: readonly ModePermissionRule[],
  state: NativePolicyState,
): ModePermissionRule[] {
  const block = findNativePolicyBlock(permissions)
  const before = block ? permissions.slice(0, block.start) : permissions
  const after = block ? permissions.slice(block.end + 1) : []
  if (rules.length === 0) return [...before, ...after]
  return [...before, nativePolicyBegin(state), ...rules, NATIVE_POLICY_END, ...after]
}

function nativePolicyRules(
  mode: TrustMode,
  shell: SessionPermissionOverrides["shell"],
): ModePermissionRule[] {
  const rules = modePermissions(mode)
  if (!shell || shell === "inherit") return rules
  const nonShell = rules.filter((rule) => !isShellPermissionAction(rule.action))
  const broadShellRules = SHELL_PERMISSION_ACTIONS.map((action) => ({
    action,
    resource: "*",
    effect: shell,
  }))
  if (shell === "deny") return [...nonShell, ...broadShellRules]
  const protectedShell = modePermissions(shell === "ask" ? "strict" : "trusted").filter(
    (rule) => isShellPermissionAction(rule.action) && rule.resource !== "*",
  )
  return [
    ...nonShell,
    ...broadShellRules,
    ...protectedShell,
  ]
}

function createSessionFamilyResolver(ctx: Plugin.Context): SessionFamilyResolver {
  const roots = new Map<string, string>()
  const parents = new Map<string, string>()

  const remember = (sessionID: string, parentID?: string): void => {
    if (!parentID) return
    parents.set(sessionID, parentID)
    roots.delete(sessionID)
    const root = roots.get(parentID)
    if (root) roots.set(sessionID, root)
  }

  const resolve = async (sessionID: string): Promise<string> => {
    const known = roots.get(sessionID)
    if (known) return known
    if (typeof ctx.session.get !== "function") return sessionID

    const visited: string[] = []
    const seen = new Set<string>()
    let current = sessionID
    try {
      while (!seen.has(current)) {
        seen.add(current)
        visited.push(current)
        const cached = roots.get(current)
        if (cached) {
          for (const id of visited) roots.set(id, cached)
          return cached
        }
        const knownParent = parents.get(current)
        if (knownParent) {
          current = knownParent
          continue
        }
        const session = await ctx.session.get({ sessionID: current })
        const parentID = session.parentID ? String(session.parentID) : undefined
        if (!parentID) {
          for (const id of visited) roots.set(id, current)
          return current
        }
        current = parentID
      }
    } catch {
      // A failed lookup must not accidentally broaden a grant. Falling back to
      // the exact session preserves the old prompt behavior until lookup works.
    }
    return sessionID
  }

  return { resolve, remember }
}

export function applyAgentConfiguration(
  agents: AgentTransformEditor,
  config: ConfigHolder,
  models: Awaited<ReturnType<Plugin.Context["catalog"]["model"]["list"]>>["data"],
  mcpServers: string[],
): void {
  const held = config.get()
  for (const [id, configured] of Object.entries(held.agents)) {
    if (configured.disabled) {
      agents.remove(id as Agent.ID)
      continue
    }
    if (!agents.get(id as Agent.ID)) continue
    agents.update(id as Agent.ID, (agent) => {
      if (configured.promptContent === undefined) {
        throw new Error(`Agent ${id} is missing its immutable prompt snapshot (${configured.prompt})`)
      }
      agent.description = configured.description
      agent.mode = configured.mode
      agent.system = configured.promptContent.trim()
      agent.model = selectModel(configured.models, models)
      agent.permissions = buildAgentPermissions(configured, mcpServers)
    })
  }
  if (agents.get(held.defaultAgent as Agent.ID)) agents.default(held.defaultAgent as Agent.ID)
}

export default Plugin.define({
  id: "agent-gvozd",
  async setup(ctx) {
    const caseInsensitive = resolveCaseInsensitiveFilesystem(process.env)
    const config = createConfigHolder(ctx.location.project.directory, { env: process.env })
    const diagnostic = (message: string) => console.error(message)
    reportHostVersion(ctx, diagnostic)
    const mcp = await ctx.mcp.list()
    let mcpServers = mcp.data.map((server) => server.name)
    let models = await listModels(ctx, diagnostic)
    const resources: Array<{ dispose(): Promise<void> | void }> = []
    // Session-scoped permission state. Declared outside the RPC block so the
    // evaluate hook can consult it even on hosts without an RPC surface.
    const familyModes = new Map<string, TrustMode>()
    const sessionOverrides = new Map<string, SessionPermissionOverrides>()
    const familyShellOverrides = new Map<string, NonNullable<SessionPermissionOverrides["shell"]>>()
    const sessionFamilies = createSessionFamilyResolver(ctx)
    const nativeSession = ctx.session as unknown as {
      get(input: { sessionID: string }): Promise<{ permissions?: readonly ModePermissionRule[] }>
      update?: (input: { sessionID: string; permissions: readonly ModePermissionRule[] }) => Promise<unknown>
    }
    const hydratedFamilies = new Set<string>()
    const familyPolicyQueues = new Map<string, Promise<void>>()

    const serializeFamilyPolicy = async <T>(familyID: string, task: () => Promise<T>): Promise<T> => {
      const previous = familyPolicyQueues.get(familyID) ?? Promise.resolve()
      const run = previous.catch(() => undefined).then(task)
      const tail = run.then(() => undefined, () => undefined)
      familyPolicyQueues.set(familyID, tail)
      try {
        return await run
      } finally {
        if (familyPolicyQueues.get(familyID) === tail) familyPolicyQueues.delete(familyID)
      }
    }

    const applyNativeState = (familyID: string, state?: NativePolicyState): void => {
      if (!state || state.mode === "balanced") familyModes.delete(familyID)
      else familyModes.set(familyID, state.mode)
      if (state?.shell) familyShellOverrides.set(familyID, state.shell)
      else familyShellOverrides.delete(familyID)
    }

    const hydrateFamilyPolicy = async (familyID: string): Promise<void> => {
      if (hydratedFamilies.has(familyID)) return
      if (typeof nativeSession.update !== "function") {
        hydratedFamilies.add(familyID)
        return
      }
      const current = await nativeSession.get({ sessionID: familyID })
      applyNativeState(familyID, findNativePolicyBlock(current.permissions ?? [])?.state)
      hydratedFamilies.add(familyID)
    }

    const familyPolicy = async (sessionID: string): Promise<NativePolicyState & { familyID: string }> => {
      const familyID = await sessionFamilies.resolve(sessionID)
      return serializeFamilyPolicy(familyID, async () => {
        await hydrateFamilyPolicy(familyID)
        return {
          familyID,
          mode: familyModes.get(familyID) ?? "balanced",
          ...(familyShellOverrides.get(familyID) ? { shell: familyShellOverrides.get(familyID) } : {}),
        }
      })
    }

    const effectiveOverrides = (
      sessionID: string,
      shell?: NonNullable<SessionPermissionOverrides["shell"]>,
    ): SessionPermissionOverrides => {
      const exact = sessionOverrides.get(sessionID) ?? {}
      return shell ? { ...exact, shell } : { ...exact }
    }

    const syncFamilyPolicy = async (familyID: string, state: NativePolicyState): Promise<void> => {
      const rules = nativePolicyRules(state.mode, state.shell)
      // OpenCode 2.0.8 persists session rules and copies them into every new
      // child session. This is the authoritative path for family grants: the
      // child starts with shell=allow before its first tool can ask.
      if (typeof nativeSession.update !== "function") return
      const current = await nativeSession.get({ sessionID: familyID })
      await nativeSession.update({
        sessionID: familyID,
        permissions: replaceNativePolicyBlock(current.permissions ?? [], rules, state),
      })
    }

    const reconcileFamilyPolicy = async (familyID: string): Promise<void> => {
      if (typeof nativeSession.update !== "function") return
      hydratedFamilies.delete(familyID)
      await hydrateFamilyPolicy(familyID)
    }
    try {
      const fileLeases = await installFileLeaseRuntime(ctx, config, { caseInsensitive })
      resources.push(fileLeases)
      const jevRuntime = await installJevRuntime(ctx, config, { env: process.env })
      resources.push(jevRuntime)
      // Older plugin hosts may not expose the RPC surface; the dry run is an
      // enhancement, so absence degrades to skipping registration.
      if (ctx.rpc && typeof ctx.rpc.register === "function") {
        const modeRpc = await ctx.rpc.register(GvozdMode, {
          set: async (raw) => {
            const input = raw as unknown as ModeSetInput
            const familyID = await sessionFamilies.resolve(input.sessionID)
            return serializeFamilyPolicy(familyID, async () => {
              await hydrateFamilyPolicy(familyID)
              const next: NativePolicyState = {
                mode: input.mode,
                ...(familyShellOverrides.get(familyID) ? { shell: familyShellOverrides.get(familyID) } : {}),
              }
              try {
                await syncFamilyPolicy(familyID, next)
              } catch (error) {
                try {
                  await reconcileFamilyPolicy(familyID)
                } catch {
                  // Keep the previously hydrated state when the host cannot
                  // confirm whether a failed update committed.
                }
                throw error
              }
              applyNativeState(familyID, next)
              return { mode: input.mode }
            })
          },
          get: async (raw) => {
            const input = raw as unknown as ModeGetInput
            const state = await familyPolicy(input.sessionID)
            return {
              mode: state.mode,
              overrides: effectiveOverrides(input.sessionID, state.shell),
            }
          },
          setOverrides: async (raw) => {
            const input = raw as unknown as ModeSetOverridesInput
            // Drop inherit entries so the map only holds real deviations.
            const overrides: SessionPermissionOverrides = {}
            for (const [action, effect] of Object.entries(input.overrides)) {
              if (effect && effect !== "inherit") {
                overrides[action as keyof SessionPermissionOverrides] = effect
              }
            }
            const familyID = await sessionFamilies.resolve(input.sessionID)
            const shell = overrides.shell
            delete overrides.shell
            return serializeFamilyPolicy(familyID, async () => {
              await hydrateFamilyPolicy(familyID)
              const previousShell = familyShellOverrides.get(familyID)
              const next: NativePolicyState = {
                mode: familyModes.get(familyID) ?? "balanced",
                ...(shell ? { shell } : {}),
              }
              if (shell !== previousShell) {
                try {
                  await syncFamilyPolicy(familyID, next)
                } catch (error) {
                  try {
                    await reconcileFamilyPolicy(familyID)
                  } catch {
                    // Keep the last confirmed in-memory state if the native
                    // writer cannot be read back after an ambiguous failure.
                  }
                  throw error
                }
                applyNativeState(familyID, next)
              }
              if (Object.keys(overrides).length === 0) sessionOverrides.delete(input.sessionID)
              else sessionOverrides.set(input.sessionID, overrides)
              return { overrides: effectiveOverrides(input.sessionID, shell) }
            })
          },
        })
        resources.push(modeRpc)
        const leasesRpc = await ctx.rpc.register(GvozdLeases, {
          list: async () => {
            const output: LeaseListOutput = {
              leases: fileLeases.manager.snapshot().map((lease) => ({
                leaseId: lease.leaseId,
                parentSessionID: lease.parentSessionID,
                ...(lease.sessionID ? { sessionID: lease.sessionID } : {}),
                agent: lease.agent,
                label: lease.label,
                state: lease.state,
                files: [...lease.files],
                expiresAt: lease.expiresAt,
                lastActivityAt: lease.lastActivityAt,
              })),
            }
            return output
          },
        })
        resources.push(leasesRpc)
        const permissionRpc = await ctx.rpc.register(GvozdPermissions, {
          evaluate: async (raw) => {
            const input = raw as unknown as EvaluateInput
            const agent = config.get().agents[input.agent]
            return evaluateInput(agent && !agent.disabled ? agent.permissions : undefined, input)
          },
        })
        resources.push(permissionRpc)
        const rosterRpc = await ctx.rpc.register(GvozdRoster, {
          list: async () => {
            const output: RosterListOutput = {
              entries: Object.entries(config.get().agents)
                .filter(([, agent]) => !agent.disabled)
                .map(([id, agent]) => ({
                  id,
                  primary: agent.mode === "primary",
                  model: agent.models[0],
                  disabled: false,
                })),
            }
            return output
          },
        })
        resources.push(rosterRpc)
        const configRpc = await ctx.rpc.register(GvozdConfig, {
          get: async (): Promise<ConfigGetOutput> => {
            const resolved = config.get()
            return {
              projectRoot: resolved.projectRoot,
              agents: Object.entries(resolved.agents).map(([id, agent]) => ({
                id,
                models: [...agent.models],
                disabled: agent.disabled,
              })),
              lease: {
                reservationTtlMs: resolved.lease.reservationTtlMs,
                activeTtlMs: resolved.lease.activeTtlMs,
                shellEscalation: resolved.lease.shellEscalation,
              },
              jev: jevStatus(resolved.jev, process.env),
            }
          },
          patch: async (raw): Promise<ConfigPatchOutput> => {
            // Validate before writing: a malformed patch must not touch the file.
            const parsed = configPatchSchema.safeParse(raw)
            if (!parsed.success) {
              throw new Error(`Invalid gvozd config patch: ${parsed.error.issues[0]?.message ?? "unknown"}`)
            }
            const agents = (parsed.data.agents ?? []).map((agent) => ({
              id: agent.id,
              models: agent.models,
              disabled: agent.disabled,
            }))
            const lease: LeaseEditPatch = parsed.data.lease ?? {}
            const jev: JevEditPatch = parsed.data.jev ?? {}
            // Global layer only — the managed user-owned file; project-layer
            // edits stay behind the CLI setup flow and trust token.
            const fresh = config.patch(agents, lease, jev)
            jevRuntime.runtime.refresh()
            // Agents replay transforms against the new holder value.
            await ctx.agent.reload()
            return {
              configPath: join(fresh.globalConfigDirectory, "config.jsonc"),
              rejected: [],
            }
          },
        })
        resources.push(configRpc)
      }
      const agentTransform = await ctx.agent.transform((agents) => {
        applyAgentConfiguration(agents, config, models, mcpServers)
      })
      resources.push(agentTransform)
      const permissionHook = await ctx.permission.hook("evaluate", async (event) => {
        const state = await familyPolicy(event.sessionID)
        const category = sessionPermissionAction(event.action, mcpServers)
        const override = category === "shell"
          ? state.shell
          : category ? sessionOverrides.get(event.sessionID)?.[category] : undefined
        const overrideDecision = sessionOverrideDecision(override, event.action, event.resources)
        const modeEffect = modeDecisionFor(modePermissions(state.mode), event.action, event.resources)

        // An explicit family-wide shell grant intentionally bypasses writer
        // lease prompts. Shell does not expose the files it may mutate, so this
        // is a user-selected tradeoff; never-escalate commands are still
        // clamped to deny by `sessionOverrideDecision` before reaching here.
        if (category === "shell" && overrideDecision && overrideDecision.effect !== "ask") {
          event.effect = overrideDecision.effect
          event.message = overrideDecision.message
          return
        }

        // Structured mutations remain protected by file leases. Shell without
        // an explicit family grant also keeps the normal lease policy.
        if (fileLeases.enforcePermission(event)) return

        // Agent-specific policy first. Only configured Gvozd agents carry
        // skills/MCP scoping; other primaries and host built-ins are untouched
        // here and still receive the session posture below.
        const configured = event.agent ? config.get().agents[event.agent] : undefined
        if (configured && !configured.disabled) {
          if (event.action === "skill") {
            const allowed = new Set(configured.skills)
            if (event.resources.some((resource) => !allowed.has(resource))) {
              event.effect = "deny"
              event.message = `Agent ${event.agent} cannot use this skill`
            }
          } else {
            let matchingServers = matchingMcpServers(event.action, mcpServers)
            if (matchingServers.length === 0 && event.action.includes("_")) {
              const mcp = await ctx.mcp.list()
              mcpServers = mcp.data.map((server) => server.name)
              matchingServers = matchingMcpServers(event.action, mcpServers)
            }
            if (matchingServers.length > 1) {
              // An ambiguous prefix is a configuration error, not a policy
              // choice, so no session toggle may resolve it.
              event.effect = "deny"
              event.message = `MCP action has an ambiguous server prefix: ${matchingServers.join(", ")}`
              return
            }
            if (matchingServers.length === 1
              && !matchingServers.some((server) => configured.mcp.includes(server))
              && !explicitMcpAccess(configured, event.action, event.resources)) {
              event.effect = "deny"
              event.message = `Agent ${event.agent} cannot use this MCP server`
            }
          }
        }

        // Session posture and per-category toggles evaluate last, matching the
        // host's last-match-wins ordering: an explicit user grant re-opens
        // what agent policy denied. `sessionOverrideDecision`/`modeDecisionFor`
        // clamp the never-escalate shell families so a toggle can never widen
        // a destructive command.
        if (overrideDecision && overrideDecision.effect === "deny") {
          event.effect = "deny"
          event.message = overrideDecision.message
          return
        }
        if (modeEffect === "deny") {
          event.effect = "deny"
          event.message = "Session posture denies this action"
          return
        }
        if (overrideDecision) {
          event.effect = overrideDecision.effect
          event.message = overrideDecision.message
          return
        }
        if (modeEffect) {
          event.effect = modeEffect
          event.message = `Session posture: ${modeEffect}`
        }
      })
      resources.push(permissionHook)
      // Resolve ancestry before the model can request tools. Calling
      // `session.get` for the first time from inside a permission evaluation
      // can race the host's child-session persistence and incorrectly fall
      // back to the exact child, losing the parent's shell grant for that
      // first command. Context runs earlier and makes the permission path a
      // cache-only lookup in the normal subagent lifecycle.
      const familyContext = await ctx.session.hook("context", async (event) => {
        await familyPolicy(String(event.sessionID))
      })
      resources.push(familyContext)
      const eventLoop = startRuntimeEventLoop({
        subscribe: (signal) => ctx.event.subscribe({ signal }),
        diagnostic,
        async handle(event) {
          if (event.type === "session.created" || event.type === "session.forked") {
            const data = event.data as { sessionID?: unknown; parentID?: unknown }
            if (typeof data.sessionID === "string") {
              sessionFamilies.remember(
                data.sessionID,
                typeof data.parentID === "string" ? data.parentID : undefined,
              )
            }
          }
          fileLeases.handleEvent(event)
          if (event.type === "mcp.status.changed") {
            const mcp = await ctx.mcp.list()
            const next = mcp.data.map((server) => server.name)
            if (next.length === mcpServers.length && next.every((server, index) => server === mcpServers[index])) return
            mcpServers = next
            await ctx.agent.reload()
          }
          // 2.0.2–2.0.3 emit one catalog refresh; 2.0.4+ split it into
          // model- and provider-scoped events. The wider match is string-based
          // because the pinned 2.0.2 event union predates the new names.
          const type: string = event.type
          if (type === "catalog.updated" || type === "model.updated" || type === "provider.updated") {
            models = await listModels(ctx, diagnostic)
            await ctx.agent.reload()
          }
        },
      })
      resources.push(eventLoop)
      return async () => disposeResources(resources, diagnostic)
    } catch (error) {
      try {
        await disposeResources(resources, diagnostic)
      } catch {}
      throw error
    }
  },
})

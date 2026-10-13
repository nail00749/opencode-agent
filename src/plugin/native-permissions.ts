import type { Plugin } from "@opencode/plugin"

type RulesWriter = Plugin.Context["permission"]["rules"]
type RulesInput = Parameters<RulesWriter>[0]

type NativePermissionContext = {
  session?: Partial<Pick<Plugin.Context["session"], "get">> & {
    // Some later 2.0.x hosts moved this writer to session.update. It is
    // optional compatibility, not part of the installed 2.0.2 SDK contract.
    update?: (input: RulesInput) => Promise<unknown>
  }
  permission?: Partial<Pick<Plugin.Context["permission"], "rules">>
}

export function nativePermissions(ctx: NativePermissionContext) {
  const session = ctx.session
  const permission = ctx.permission
  // Both writers replace the whole ruleset. Without a reader, using either
  // one would silently discard user/other-plugin rules.
  if (typeof session?.get !== "function") return undefined
  const get = session.get.bind(session)
  if (typeof permission?.rules === "function") {
    return { get, write: permission.rules.bind(permission) }
  }
  if (typeof session.update === "function") {
    return { get, write: session.update.bind(session) }
  }
  return undefined
}

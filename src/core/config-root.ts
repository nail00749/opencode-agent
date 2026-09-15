import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export const GVOZD_CONFIG_ROOT_ENV = "GVOZD_OPENCODE_CONFIG_ROOT"

export interface ConfigRootResolution {
  path: string
  source: "explicit" | typeof GVOZD_CONFIG_ROOT_ENV | "XDG_CONFIG_HOME" | "APPDATA" | "platform-default"
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  return resolve(path)
}

export function resolveOpenCodeConfigRootContract(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  explicitRoot?: string,
): ConfigRootResolution {
  if (explicitRoot) return { path: absolute(explicitRoot, "OpenCode config root"), source: "explicit" }
  const override = env[GVOZD_CONFIG_ROOT_ENV]
  if (override) {
    return { path: absolute(override, GVOZD_CONFIG_ROOT_ENV), source: GVOZD_CONFIG_ROOT_ENV }
  }
  if (env.XDG_CONFIG_HOME) {
    return { path: join(absolute(env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME"), "opencode"), source: "XDG_CONFIG_HOME" }
  }
  if (platform === "win32" && env.APPDATA) {
    return { path: join(env.APPDATA, "opencode"), source: "APPDATA" }
  }
  return { path: join(home, ".config", "opencode"), source: "platform-default" }
}

export function resolveOpenCodeConfigRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  explicitRoot?: string,
): string {
  return resolveOpenCodeConfigRootContract(env, platform, home, explicitRoot).path
}

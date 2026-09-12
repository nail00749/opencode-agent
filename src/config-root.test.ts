import { describe, expect, test } from "bun:test"
import {
  GVOZD_CONFIG_ROOT_ENV,
  resolveOpenCodeConfigRoot,
  resolveOpenCodeConfigRootContract,
} from "./config-root"
import {
  CONFIG_SCHEMA_VERSION,
  PACKAGE_NAME,
  PACKAGE_SPEC,
  PACKAGE_VERSION,
  SUPPORTED_OPENCODE_VERSION,
} from "./release-metadata"

describe("OpenCode config root contract", () => {
  test("uses explicit root before every environment convention", () => {
    const env = {
      [GVOZD_CONFIG_ROOT_ENV]: "/env/gvozd",
      XDG_CONFIG_HOME: "/env/xdg",
      APPDATA: "/env/appdata",
    }
    expect(resolveOpenCodeConfigRootContract(env, "linux", "/home/user", "/explicit/root")).toEqual({
      path: "/explicit/root",
      source: "explicit",
    })
  })

  test("uses the Gvozd runtime override before platform variables", () => {
    const resolution = resolveOpenCodeConfigRootContract({
      [GVOZD_CONFIG_ROOT_ENV]: "/runtime/root",
      XDG_CONFIG_HOME: "/xdg",
    }, "linux", "/home/user")
    expect(resolution).toEqual({ path: "/runtime/root", source: GVOZD_CONFIG_ROOT_ENV })
  })

  test("resolves XDG, APPDATA, and the platform fallback", () => {
    expect(resolveOpenCodeConfigRootContract({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/user")).toEqual({
      path: "/xdg/opencode",
      source: "XDG_CONFIG_HOME",
    })
    expect(resolveOpenCodeConfigRootContract({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toEqual({
      path: "C:\\Users\\u\\AppData\\Roaming/opencode",
      source: "APPDATA",
    })
    expect(resolveOpenCodeConfigRoot({}, "darwin", "/Users/u")).toBe("/Users/u/.config/opencode")
  })

  test("rejects relative explicit and XDG roots", () => {
    expect(() => resolveOpenCodeConfigRoot({}, "linux", "/home/u", "relative/root")).toThrow("absolute")
    expect(() => resolveOpenCodeConfigRoot({ XDG_CONFIG_HOME: "relative" }, "linux", "/home/u")).toThrow("absolute")
  })
})

test("release metadata exposes one package and host compatibility contract", () => {
  expect(PACKAGE_NAME).toBe("@nail00749/agent-gvozd")
  expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  expect(PACKAGE_SPEC).toBe(`${PACKAGE_NAME}@${PACKAGE_VERSION}`)
  expect(SUPPORTED_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  expect(CONFIG_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
})

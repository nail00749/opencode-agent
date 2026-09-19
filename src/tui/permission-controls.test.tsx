import { describe, expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js"
import { PermissionControls } from "./index"
import type { SessionPermissionAction, SessionPermissionEffect } from "../core/session-permissions"

function renderControls(onEffect: (action: SessionPermissionAction, effect: SessionPermissionEffect) => void) {
  const context = {
    theme: {
      text: { default: "#ffffff", muted: "#888888" },
      status: { success: "#00ff00" },
    },
  } as unknown as Context
  return createComponent(PluginContextProvider, {
    value: context,
    get children() {
      return createComponent(PermissionControls, {
        state: { mode: "balanced", overrides: { shell: "allow" } },
        busy: false,
        onEffect,
      })
    },
  })
}

describe("permission controls", () => {
  test("show effective state and apply a clicked explicit value", async () => {
    const selected: Array<[SessionPermissionAction, SessionPermissionEffect]> = []
    const setup = await testRender(() => renderControls((action, effect) => selected.push([action, effect])), {
      width: 90,
      height: 24,
    })
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("shell ALLOW  <- session family override")
      expect(frame).toContain("* allow")

      const lines = frame.split("\n")
      const y = lines.findIndex((line) => line.includes("inherit") && line.includes("* allow") && line.includes("deny"))
      expect(y).toBeGreaterThanOrEqual(0)
      const x = lines[y]!.indexOf("deny") + 1
      await setup.mockMouse.release(x, y)
      expect(selected).toEqual([["shell", "deny"]])
    } finally {
      setup.renderer.destroy()
    }
  })
})

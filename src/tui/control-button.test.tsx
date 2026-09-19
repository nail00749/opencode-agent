import { describe, expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js"
import { ControlButton, ControlNavigationContext } from "./control-button"
import { createControlNavigation, controlNavigationCommands } from "./control-navigation"

const context = {
  theme: {
    text: { default: "#ffffff", muted: "#888888" },
    status: { success: "#00ff00" },
  },
} as unknown as Context

describe("control button", () => {
  test("shows focus, navigates past disabled controls, and activates the selection", async () => {
    const selected: string[] = []
    const navigation = createControlNavigation()
    const setup = await testRender(
      () => createComponent(PluginContextProvider, {
        value: context,
        get children() {
          return createComponent(ControlNavigationContext.Provider, {
            value: { navigation },
            get children() {
              return (
                <box flexDirection="row" gap={1}>
                  <ControlButton label="First" autoFocus onAction={() => selected.push("first")} />
                  <ControlButton label="Disabled" disabled onAction={() => selected.push("disabled")} />
                  <ControlButton label="Last" onAction={() => selected.push("last")} />
                </box>
              )
            },
          })
        },
      }),
      { width: 60, height: 5 },
    )
    try {
      await setup.renderOnce()
      expect(setup.renderer.currentFocusedRenderable).not.toBeNull()
      const firstFocused = setup.renderer.currentFocusedRenderable
      expect(setup.captureCharFrame()).toContain("x Disabled")

      const tab = controlNavigationCommands(navigation).find((command) => command.bind === "tab")
      expect(tab).toBeDefined()
      await tab!.run()
      await setup.flush()
      await setup.renderOnce()
      expect(setup.renderer.currentFocusedRenderable).not.toBe(firstFocused)

      setup.mockInput.pressEnter()
      await setup.flush()
      expect(selected).toEqual(["last"])
    } finally {
      setup.renderer.destroy()
    }
  })
})

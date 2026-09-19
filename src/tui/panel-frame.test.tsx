import { describe, expect, test } from "bun:test"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapLayer, PanelInput } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js"
import { PanelFrame } from "./panel-frame"

function panelFixture() {
  let layer: KeymapLayer | undefined
  let closes = 0
  const context = {
    keymap: {
      layer(input: () => KeymapLayer) {
        layer = input()
      },
    },
    theme: { text: { muted: "#888888" } },
  } as unknown as Context
  const panel: PanelInput = {
    name: "gvozd.leases",
    sessionID: "ses-test",
    width: 80,
    presentation: "fullscreen",
    focused: true,
    focus() {},
    close() { closes++ },
    toggleFullscreen() {},
  }
  return {
    context,
    panel,
    layer: () => layer,
    closes: () => closes,
  }
}

function renderPanel(fixture: ReturnType<typeof panelFixture>, controlsHint?: string) {
  return createComponent(PluginContextProvider, {
    value: fixture.context,
    get children() {
      return createComponent(PanelFrame, {
        panel: fixture.panel,
        controlsHint,
        get children() {
          return <text>leases</text>
        },
      })
    },
  })
}

describe("Gvozd panel frame", () => {
  test("shows the loaded plugin version and close hint", async () => {
    const fixture = panelFixture()
    const setup = await testRender(() => renderPanel(fixture), { width: 40, height: 6 })
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toMatch(/gvozd v\d+\.\d+\.\d+/)
      expect(frame).toContain("Esc — close")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("closes the focused panel on escape", async () => {
    const fixture = panelFixture()
    const setup = await testRender(() => renderPanel(fixture), { width: 40, height: 6 })
    try {
      await setup.renderOnce()
      const layer = fixture.layer()
      expect(typeof layer?.enabled).toBe("function")
      if (typeof layer?.enabled !== "function") throw new Error("panel keymap layer is not reactive")
      expect(layer.enabled()).toBe(true)
      const command = layer?.commands?.find((entry) => entry.bind === "escape")
      expect(command).toBeDefined()
      if (!command) throw new Error("escape command is missing")

      await command.run()
      expect(fixture.closes()).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("shows panel-specific interaction help", async () => {
    const fixture = panelFixture()
    const setup = await testRender(
      () => renderPanel(fixture, "Tab / arrows — move · Enter / Space — activate · Esc — close"),
      { width: 80, height: 6 },
    )
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("Tab / arrows — move · Enter / Space — activate · Esc — close")
    } finally {
      setup.renderer.destroy()
    }
  })
})

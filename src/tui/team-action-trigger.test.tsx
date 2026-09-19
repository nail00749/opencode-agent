import { describe, expect, test } from "bun:test"
import type { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { TeamActionTrigger } from "./team-action-trigger"

describe("team action trigger", () => {
  test("opens actions after mouse release instead of the opening mouse press", async () => {
    let opened = 0
    const setup = await testRender(
      () => (
        <TeamActionTrigger onAction={() => opened++}>
          <text>gvozd</text>
        </TeamActionTrigger>
      ),
      { width: 20, height: 5 },
    )
    try {
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("gvozd")

      await setup.mockMouse.pressDown(1, 0)
      expect(opened).toBe(0)

      await setup.mockMouse.release(1, 0)
      expect(opened).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("activates with Enter after receiving focus", async () => {
    let opened = 0
    let trigger: BoxRenderable | undefined
    const setup = await testRender(
      () => (
        <TeamActionTrigger
          ref={(node) => { trigger = node }}
          border
          focusedBorderColor="#00ff00"
          onAction={() => opened++}
        >
          <text>open control center</text>
        </TeamActionTrigger>
      ),
      { width: 30, height: 5 },
    )
    try {
      await setup.renderOnce()
      await setup.mockMouse.pressDown(1, 0)
      expect(trigger).toBeDefined()
      if (!trigger) throw new Error("action trigger ref was not assigned")
      expect(setup.renderer.currentFocusedRenderable).toBe(trigger)
      setup.mockInput.pressEnter()
      await setup.flush()
      expect(opened).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })
})

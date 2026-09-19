import { describe, expect, test } from "bun:test"
import { createControlNavigation, controlNavigationCommands } from "./control-navigation"

function navigationFixture(disabled: readonly boolean[] = [false, false, false]) {
  let focused = -1
  const revealed: number[] = []
  const navigation = createControlNavigation()
  const registrations = disabled.map((isDisabled, index) => navigation.register({
    disabled: () => isDisabled,
    focus: () => { focused = index },
    focused: () => focused === index,
    reveal: () => { revealed.push(index) },
  }))
  return { navigation, registrations, focused: () => focused, revealed }
}

describe("control navigation", () => {
  test("cycles forward and backward through enabled controls", () => {
    const fixture = navigationFixture([false, true, false])

    fixture.navigation.move(1)
    expect(fixture.focused()).toBe(0)
    fixture.navigation.move(1)
    expect(fixture.focused()).toBe(2)
    fixture.navigation.move(1)
    expect(fixture.focused()).toBe(0)
    fixture.navigation.move(-1)
    expect(fixture.focused()).toBe(2)
    expect(fixture.revealed).toEqual([0, 2, 0, 2])
  })

  test("removes controls from the navigation order on cleanup", () => {
    const fixture = navigationFixture()
    fixture.registrations[0]!.unregister()

    fixture.navigation.move(1)
    expect(fixture.focused()).toBe(1)
  })

  test("maps Tab and arrow keys to navigation and prevents host handling", async () => {
    const fixture = navigationFixture()
    const commands = controlNavigationCommands(fixture.navigation)
    let prevented = 0
    const event = { preventDefault: () => { prevented++ } }

    await commands.find((command) => command.bind === "tab")!.run(undefined, event as never)
    expect(fixture.focused()).toBe(0)
    await commands.find((command) => command.bind === "down")!.run(undefined, event as never)
    expect(fixture.focused()).toBe(1)
    await commands.find((command) => command.bind === "shift+tab")!.run(undefined, event as never)
    expect(fixture.focused()).toBe(0)
    expect(prevented).toBe(3)
  })
})

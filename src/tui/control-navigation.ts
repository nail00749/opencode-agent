import type { KeymapCommand } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

export interface ControlNavigationItem {
  readonly disabled: () => boolean
  readonly focus: () => void
  readonly focused: () => boolean
  readonly reveal?: () => void
}

export interface ControlNavigationRegistration {
  select(): void
  selected(): boolean
  unregister(): void
}

export interface ControlNavigation {
  register(item: ControlNavigationItem): ControlNavigationRegistration
  move(direction: -1 | 1): void
}

export function createControlNavigation(): ControlNavigation {
  const items: ControlNavigationItem[] = []
  const [selected, setSelected] = createSignal<ControlNavigationItem>()
  const select = (item: ControlNavigationItem | undefined) => {
    const previous = selected()
    if (previous === item) return
    setSelected(item)
  }
  return {
    register(item) {
      items.push(item)
      return {
        select() {
          select(item)
        },
        selected() {
          return selected() === item
        },
        unregister() {
          const index = items.indexOf(item)
          if (index >= 0) items.splice(index, 1)
          if (selected() === item) select(undefined)
        },
      }
    },
    move(direction) {
      const enabled = items.filter((item) => !item.disabled())
      if (enabled.length === 0) return
      const currentSelection = selected()
      const selectedIndex = currentSelection ? enabled.indexOf(currentSelection) : -1
      const current = selectedIndex >= 0 ? selectedIndex : enabled.findIndex((item) => item.focused())
      const next = current < 0
        ? direction > 0 ? 0 : enabled.length - 1
        : (current + direction + enabled.length) % enabled.length
      const target = enabled[next]!
      select(target)
      target.focus()
      target.reveal?.()
    },
  }
}

function navigationCommand(
  navigation: ControlNavigation,
  bind: string,
  direction: -1 | 1,
): KeymapCommand {
  return {
    bind,
    run: (_input, event) => {
      event?.preventDefault()
      navigation.move(direction)
    },
  }
}

export function controlNavigationCommands(navigation: ControlNavigation): readonly KeymapCommand[] {
  return [
    navigationCommand(navigation, "tab", 1),
    navigationCommand(navigation, "shift+tab", -1),
    navigationCommand(navigation, "down", 1),
    navigationCommand(navigation, "right", 1),
    navigationCommand(navigation, "up", -1),
    navigationCommand(navigation, "left", -1),
  ]
}

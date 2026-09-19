import { createContext, onCleanup, onMount, useContext } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import { usePlugin } from "@opencode/plugin/tui"
import { themeColor } from "./insights"
import { TeamActionTrigger } from "./team-action-trigger"
import type { ControlNavigation } from "./control-navigation"

export interface ControlNavigationScope {
  readonly navigation: ControlNavigation
  readonly reveal?: (control: BoxRenderable) => void
}

export const ControlNavigationContext = createContext<ControlNavigationScope>()

export function ControlButton(props: {
  label: string
  active?: boolean
  disabled?: boolean
  autoFocus?: boolean
  onAction: () => void
}) {
  const context = usePlugin()
  const scope = useContext(ControlNavigationContext)
  let control: BoxRenderable | undefined
  const registration = scope?.navigation.register({
    disabled: () => Boolean(props.disabled),
    focus: () => control?.focus(),
    focused: () => Boolean(control?.focused),
    reveal: () => { if (control) scope.reveal?.(control) },
  })
  if (props.autoFocus) registration?.select()
  onCleanup(() => registration?.unregister())
  onMount(() => {
    queueMicrotask(() => {
      if (!props.autoFocus) return
      registration?.select()
      control?.focus()
    })
  })

  const color = () => props.disabled
    ? themeColor(context.theme, ["text", "muted"])
    : props.active
      ? themeColor(context.theme, ["status", "success"])
      : themeColor(context.theme, ["text", "default"])
  return (
    <TeamActionTrigger
      ref={(node) => { control = node }}
      border
      borderColor={color()}
      focusedBorderColor={themeColor(context.theme, ["status", "success"])}
      paddingX={1}
      focused={props.autoFocus}
      disabled={props.disabled}
      onFocusChange={(focused) => { if (focused) registration?.select() }}
      onAction={() => {
        registration?.select()
        props.onAction()
      }}
    >
      <text fg={color()}>{`${props.disabled ? "x" : props.active ? "*" : " "} ${props.label}`}</text>
    </TeamActionTrigger>
  )
}

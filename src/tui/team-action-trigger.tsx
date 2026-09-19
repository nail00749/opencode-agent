import type { JSX } from "@opentui/solid"
import type { BoxRenderable, KeyEvent } from "@opentui/core"

export function TeamActionTrigger(props: {
  children: JSX.Element
  onAction: () => void
  ref?: (node: BoxRenderable) => void
  border?: boolean
  borderColor?: string
  focusedBorderColor?: string
  paddingX?: number
  focused?: boolean
  disabled?: boolean
  onFocusChange?: (focused: boolean) => void
}) {
  const activateFromKeyboard = (event: KeyEvent) => {
    if (props.disabled) return
    if (event.name !== "return" && event.name !== "linefeed" && event.name !== "space") return
    event.preventDefault()
    event.stopPropagation()
    props.onAction()
  }
  return (
    <box
      ref={props.ref}
      flexDirection="column"
      focusable
      focused={props.focused}
      border={props.border}
      borderColor={props.borderColor}
      focusedBorderColor={props.focusedBorderColor}
      paddingX={props.paddingX}
      on:focused={() => props.onFocusChange?.(true)}
      on:blurred={() => props.onFocusChange?.(false)}
      onMouseDown={(event) => { if (props.disabled) event.preventDefault() }}
      onMouseUp={() => { if (!props.disabled) props.onAction() }}
      onKeyDown={activateFromKeyboard}
    >
      {props.children}
    </box>
  )
}

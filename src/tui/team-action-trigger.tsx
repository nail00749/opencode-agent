import type { JSX } from "@opentui/solid"
import type { KeyEvent } from "@opentui/core"

export function TeamActionTrigger(props: { children: JSX.Element; onAction: () => void }) {
  const activateFromKeyboard = (event: KeyEvent) => {
    if (event.name !== "return" && event.name !== "linefeed" && event.name !== "space") return
    event.preventDefault()
    props.onAction()
  }
  return (
    <box flexDirection="column" focusable onMouseUp={props.onAction} onKeyDown={activateFromKeyboard}>
      {props.children}
    </box>
  )
}

import type { JSX } from "@opentui/solid"

export function TeamActionTrigger(props: { children: JSX.Element; onAction: () => void }) {
  return (
    <box flexDirection="column" onMouseUp={props.onAction}>
      {props.children}
    </box>
  )
}

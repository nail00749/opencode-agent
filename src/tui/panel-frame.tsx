import type { JSX } from "@opentui/solid"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { usePlugin } from "@opencode/plugin/tui"
import { PACKAGE_VERSION } from "../core/release-metadata"
import { themeColor } from "./insights"

export function PanelFrame(props: { panel: PanelInput; children: JSX.Element }) {
  const context = usePlugin()
  context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    priority: 100,
    commands: [{ bind: "escape", run: () => props.panel.close() }],
  }))
  return (
    <box flexDirection="column" height="100%">
      <text fg={themeColor(context.theme, ["text", "muted"])}>{`gvozd v${PACKAGE_VERSION}`}</text>
      <box flexGrow={1} minHeight={0}>
        {props.children}
      </box>
      <text fg={themeColor(context.theme, ["text", "muted"])}>Esc — close</text>
    </box>
  )
}

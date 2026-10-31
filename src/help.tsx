import { TextAttributes, type RGBA } from "@opentui/core"
import { For } from "solid-js"

/** The host's dialog-surface tokens the help reads; `ctx.theme` arrives untyped (see `Theme` in palette.ts). */
export type DialogTheme = {
  text: { base: RGBA; muted: RGBA; action: { primary: { focused: RGBA } } }
  background: { action: { primary: { focused: RGBA } } }
}

/** Panel keys, worded as in the README's Keys table. */
const KEYS = [
  ["↑/↓ j/k", "Move"],
  ["enter", "Open session, or fold a heading"],
  ["u", "Mark read/unread"],
  ["a / l", "Move to Active / Later"],
  ["x", "Close row (never deletes)"],
  ["r", "Refresh"],
  ["d", "Refresh details"],
  ["esc", "Close panel"],
] as const

/**
 * The panel's key reference, laid out like OpenCode's own alert: bold title with a muted `esc`, side padding of
 * three cells, and an `ok` button. Keys are muted, as shortcuts are in the command palette.
 */
export function HelpDialog(props: { theme: DialogTheme; open: string; close: () => void }) {
  const muted = () => props.theme.text.muted
  const base = () => props.theme.text.base
  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={base()}>
          Switchboard
        </text>
        <text fg={muted()} flexShrink={0} onMouseUp={props.close}>
          esc
        </text>
      </box>
      <text>
        <span style={{ fg: base() }}>Open with </span>
        <span style={{ fg: muted() }}>{props.open}</span>
        <span style={{ fg: base() }}> or </span>
        <span style={{ fg: muted() }}>/switchboard</span>
      </text>
      <box paddingLeft={2}>
        <For each={KEYS}>
          {([key, action]) => (
            <box flexDirection="row">
              <text fg={muted()} width={12} flexShrink={0}>
                {key}
              </text>
              <text fg={base()}>{action}</text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="flex-end">
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={props.theme.background.action.primary.focused}
          onMouseUp={props.close}
        >
          <text fg={props.theme.text.action.primary.focused}>ok</text>
        </box>
      </box>
    </box>
  )
}

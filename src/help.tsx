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
  ["←/→", "Fold / unfold heading"],
  ["u", "Mark read/unread"],
  ["a / l", "Move to Active / Later"],
  ["x", "Close session or project"],
  ["esc", "Close panel when focused"],
] as const

/** The commands that work outside the panel, whose shortcuts the help shows, by keymap command ID. */
export const HELP_COMMANDS = {
  open: "opencode-switchboard.open",
  left: "pane.focus.left",
  right: "pane.focus.right",
  close: "opencode-switchboard.close-current",
} as const

/** Each command's shortcut as the keymap formats it, with the user's leader. An unbound command has none. */
export type HelpShortcuts = Partial<Record<keyof typeof HELP_COMMANDS, string>>

/** Reads every shortcut from the keymap; it never substitutes a default key for an unbound command. */
export function helpShortcuts(shortcuts: (id: string) => readonly string[]): HelpShortcuts {
  return Object.fromEntries(
    Object.entries(HELP_COMMANDS).flatMap(([name, id]) => {
      const key = shortcuts(id)[0]
      return key ? [[name, key]] : []
    }),
  )
}

/** A sentence in base text, with its keys muted. */
type Line = { text: string; key?: boolean }[]

function introLines(keys: HelpShortcuts): Line[] {
  const lines: Line[] = [
    [
      { text: "Open with " },
      ...(keys.open ? [{ text: keys.open, key: true }, { text: " or " }] : []),
      { text: "/switchboard", key: true },
    ],
  ]
  const panes = [keys.left, keys.right].filter((key) => key !== undefined)
  if (panes.length)
    lines.push([
      { text: "Switch panes with " },
      ...panes.flatMap((key, index) => [...(index ? [{ text: " and " }] : []), { text: key, key: true }]),
    ])
  // Works from either pane without focusing the panel, so it belongs here rather than with the panel keys.
  if (keys.close) lines.push([{ text: "Close the current session with " }, { text: keys.close, key: true }])
  return lines
}

/**
 * The panel's key reference, laid out like OpenCode's own alert: bold title with a muted `esc`, side padding of
 * three cells, and an `ok` button. Keys are muted, as shortcuts are in the command palette.
 */
export function HelpDialog(props: { theme: DialogTheme; shortcuts: HelpShortcuts; close: () => void }) {
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
      <box>
        <For each={introLines(props.shortcuts)}>
          {(line) => (
            <text>
              <For each={line}>
                {(part) => <span style={{ fg: part.key ? muted() : base() }}>{part.text}</span>}
              </For>
            </text>
          )}
        </For>
      </box>
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

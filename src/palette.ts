import type { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { tint, type Palette } from "./panel"

export type Theme = Plugin.Context["theme"]

/** The panel's colors on its surface: the raised side panel, or the base background fullscreen. */
export function palette(theme: Theme, surface: "panel" | "fullscreen"): Palette {
  const base = surface === "panel" ? theme.background.raised.base : theme.background.base
  // Row fills are flattened onto the surface, as in the native rail, so titles fade into them.
  // A transparent fill stays the bare surface, which is itself transparent in the system theme.
  const flatten = (fill: RGBA) => (fill.a === 0 ? base : tint(base, fill, fill.a))
  return {
    text: theme.text.base,
    muted: theme.text.muted,
    detail: tint(theme.text.muted, base, 0.35),
    background: base,
    // The native tab rail's fills: action hover for a hovered row, a step below the raised surface for the current one.
    hover: flatten(theme.background.action.primary.hovered),
    selected: flatten(theme.decrease(theme.background.raised.base)),
    unread: theme.hue.accent[200],
    attention: theme.hue.accent[200],
    running: theme.hue.interactive[200],
    error: theme.text.feedback.error.base,
  }
}

import type { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { tint, type Palette } from "./panel"

export type Theme = Plugin.Context["theme"]

/** The panel's colors on its surface: the raised side panel, or the base background fullscreen. */
export function palette(theme: Theme, surface: "panel" | "fullscreen"): Palette {
  const base = surface === "panel" ? theme.background.raised.base : theme.background.base
  // The native rail's row fills, flattened onto the surface (as its `pulseBackground`) so titles fade into them.
  // A transparent fill stays the bare surface, which is itself transparent in the system theme.
  const flatten = (fill: RGBA) => (fill.a === 0 ? base : tint(base, fill, fill.a))
  return {
    text: theme.text.base,
    muted: theme.text.muted,
    detail: tint(theme.text.muted, base, 0.35),
    background: base,
    // One step above the surface: on the raised side panel, `raised.high` is too close to show.
    hover: flatten(surface === "panel" ? theme.background.raised.max : theme.background.raised.high),
    selected: flatten(theme.background.action.primary.selected),
    unread: theme.hue.accent[200],
    attention: theme.hue.accent[200],
    running: theme.hue.interactive[200],
    error: theme.text.feedback.error.base,
  }
}

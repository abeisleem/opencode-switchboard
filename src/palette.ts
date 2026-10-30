import type { RGBA } from "@opentui/core"
import { tint, type Palette } from "./panel"

/**
 * The host theme tokens the panel reads. `@opencode/plugin` types `ctx.theme` through
 * `@opencode/theme/tui`, which is not installed, so it arrives as `any`; this keeps those reads checked.
 */
export type Theme = {
  text: { base: RGBA; muted: RGBA; feedback: { error: { base: RGBA } } }
  background: {
    base: RGBA
    raised: { base: RGBA }
    action: { primary: { hovered: RGBA } }
  }
  hue: { accent: Record<200, RGBA>; interactive: Record<200, RGBA> }
  decrease(color: RGBA, amount?: number): RGBA
  /** The tokens retuned for a raised surface; `dialog` is the one the host's side panels and dialogs use. */
  surface(name: "dialog"): Theme
}

/** The panel's colors on its surface: the raised side panel, or the base background fullscreen. */
export function palette(theme: Theme, surface: "panel" | "fullscreen"): Palette {
  // On the raised surface the base theme's hover equals the surface itself; its `dialog` tokens step above it.
  const tokens = surface === "panel" ? theme.surface("dialog") : theme
  const base = tokens.background.base
  // Row fills are flattened onto the surface, as in the native rail, so titles fade into them.
  // A transparent fill stays the bare surface, which is itself transparent in the system theme.
  const flatten = (fill: RGBA) => (fill.a === 0 ? base : tint(base, fill, fill.a))
  return {
    text: tokens.text.base,
    muted: tokens.text.muted,
    detail: tint(tokens.text.muted, base, 0.35),
    background: base,
    // The native tab rail's fills: action hover for a hovered row, a step below the raised surface for the current one.
    hover: flatten(tokens.background.action.primary.hovered),
    selected: flatten(tokens.decrease(tokens.background.raised.base)),
    unread: tokens.hue.accent[200],
    attention: tokens.hue.accent[200],
    running: tokens.hue.interactive[200],
    error: tokens.text.feedback.error.base,
  }
}

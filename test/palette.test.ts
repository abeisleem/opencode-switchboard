import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { palette, type Theme } from "../src/palette"

const color = (hex: string) => RGBA.fromHex(hex)
const darker = color("#1b1d2b")
const theme = {
  text: { base: color("#c0caf5"), muted: color("#737aa2"), feedback: { error: { base: color("#f7768e") } } },
  background: {
    base: color("#1a1b26"),
    raised: { base: color("#1e202f"), high: color("#24283b"), max: color("#414868") },
    action: { primary: { hovered: color("#222435"), selected: RGBA.fromValues(0, 0, 0, 0) } },
  },
  hue: { accent: { 200: color("#ff9e64") }, interactive: { 200: color("#7aa2f7") } },
  decrease: () => darker,
} as unknown as Theme

test("rows use the native tab rail's hover and current fills", () => {
  for (const surface of ["panel", "fullscreen"] as const) {
    const colors = palette(theme, surface)
    expect(colors.hover).toEqual(theme.background.action.primary.hovered)
    expect(colors.selected).toEqual(darker)
  }
})

test("the side panel sits on the raised surface and fullscreen on the base", () => {
  expect(palette(theme, "panel").background).toEqual(theme.background.raised.base)
  expect(palette(theme, "fullscreen").background).toEqual(theme.background.base)
})

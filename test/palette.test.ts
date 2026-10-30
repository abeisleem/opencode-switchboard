import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { palette, type Theme } from "../src/palette"

const color = (hex: string) => RGBA.fromHex(hex)
const theme = {
  text: { base: color("#c0caf5"), muted: color("#737aa2"), feedback: { error: { base: color("#f7768e") } } },
  background: {
    base: color("#1a1b26"),
    raised: { base: color("#24283b"), high: color("#24283b"), max: color("#414868") },
    action: { primary: { selected: color("#292e42") } },
  },
  hue: { accent: { 200: color("#ff9e64") }, interactive: { 200: color("#7aa2f7") } },
} as unknown as Theme

test("the side panel's hover fill steps above its raised surface", () => {
  const colors = palette(theme, "panel")
  expect(colors.background).toEqual(theme.background.raised.base)
  // `raised.high` can equal the raised surface; the hover must still show on it.
  expect(colors.hover).toEqual(theme.background.raised.max)
  expect(colors.hover).not.toEqual(colors.background)
})

test("fullscreen keeps the base surface and its raised.high hover fill", () => {
  const colors = palette(theme, "fullscreen")
  expect(colors.background).toEqual(theme.background.base)
  expect(colors.hover).toEqual(theme.background.raised.high)
})

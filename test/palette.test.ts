import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { palette, type Theme } from "../src/palette"

const color = (hex: string) => RGBA.fromHex(hex)
// Shaped like a converted v1 theme: the base theme's hover equals the raised surface.
const raised = color("#1e2030")
const darker = color("#222436")
function theme(base: RGBA, hovered: RGBA, dialog?: Theme): Theme {
  const self: Theme = {
    text: {
      base: color("#c8d3f5"),
      muted: color("#828bb8"),
      feedback: { error: { base: color("#ff757f") } },
    },
    background: { base, raised: { base: raised }, action: { primary: { hovered } } },
    hue: { accent: { 200: color("#ff966c") }, interactive: { 200: color("#82aaff") } },
    decrease: () => darker,
    surface: () => dialog ?? self,
  }
  return self
}
const dialog = theme(raised, color("#222436"))
const main = theme(color("#1a1b26"), raised, dialog)

test("the side panel takes its surface and hover from the theme's raised dialog tokens", () => {
  const colors = palette(main, "panel")
  expect(colors.background).toEqual(raised)
  // The base theme's hover would equal this surface; the dialog hover steps above it.
  expect(colors.hover).toEqual(dialog.background.action.primary.hovered)
  expect(colors.hover).not.toEqual(colors.background)
  expect(colors.selected).toEqual(darker)
})

test("fullscreen keeps the base theme's surface and hover", () => {
  const colors = palette(main, "fullscreen")
  expect(colors.background).toEqual(main.background.base)
  expect(colors.hover).toEqual(main.background.action.primary.hovered)
})

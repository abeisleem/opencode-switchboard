import { expect, test } from "bun:test"
import { rgbToHex, RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { DEMO_PALETTE as palette, Demo } from "../src/demo"
import { tint } from "../src/panel"

test("panel mirrors the native rail: left indicators, no header, footer help only", async () => {
  const app = await testRender(() => <Demo />, { width: 100, height: 38 })
  try {
    await app.renderOnce()
    const screen = app.captureCharFrame()
    // One blank row of padding sits above the first project.
    expect(screen.split("\n")[0]!.trim()).toBe("")
    expect(screen.split("\n")[1]).toContain("▾ api-server")
    for (const removed of ["Needs you", "Search", "[f]", "[p]", ">", "Enter fold"])
      expect(screen).not.toContain(removed)
    expect(screen).toMatch(/ • Diagnose reconnect/)
    expect(screen).toMatch(/ \? Choose navigation/)
    expect(screen).toMatch(/ ⠋ Check service health/)
    expect(screen).toMatch(/\? help *\n?$/)
    // Rows are separated by one blank line, as in the native rail.
    expect(screen).toMatch(/Check service health[^\n]*\n *\n *• Diagnose reconnect/)
    // `u` on the highlighted row toggles its unread indicator.
    await app.mockInput.pressArrow("down")
    await app.mockInput.pressArrow("down")
    app.mockInput.pressKey("u")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toMatch(/• Diagnose reconnect/)
    app.resize(46, 26)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("? help")
    await Bun.write("artifacts/preview-narrow.txt", app.captureCharFrame())
    await Bun.write("artifacts/preview.txt", screen)
  } finally {
    await app.dispose()
  }
})

test("a and l move the highlighted session between Active and the Later fold", async () => {
  const app = await testRender(() => <Demo />, { width: 60, height: 30 })
  try {
    await app.renderOnce()
    await app.mockInput.pressArrow("down")
    app.mockInput.pressKey("l")
    await app.renderOnce()
    expect(app.captureCharFrame()).toMatch(/▾ api-server[^]*▾ Later[^\n]*\n *\n *\S +Check service health/)
    app.mockInput.pressKey("a")
    await app.renderOnce()
    expect(app.captureCharFrame()).toMatch(/▾ api-server[^\n]*\n *\n *\S +Check service health/)
  } finally {
    await app.dispose()
  }
})

test("long titles clip to the available width instead of wrapping or overrunning the close slot", async () => {
  const app = await testRender(() => <Demo />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    const screen = app.captureCharFrame()
    // 26 columns - 1 right padding - 3 indicator - 2 close (gap, ✕) = 20 title cells.
    expect(screen).toContain("Review provider conf")
    expect(screen).not.toContain("Review provider confi")
  } finally {
    await app.dispose()
  }
})

/** The cell at (x, y) of the last frame, with its colors as hex. */
function cell(app: Awaited<ReturnType<typeof testRender>>, x: number, y: number) {
  let left = 0
  for (const span of app.captureSpans().lines[y]!.spans) {
    if (x < left + span.width) {
      const index = x - left
      return {
        char: Array.from(span.text)[index],
        fg: rgbToHex(span.fg),
        bg: rgbToHex(span.bg),
        bold: Boolean(span.attributes & TextAttributes.BOLD),
      }
    }
    left += span.width
  }
  throw new Error(`no cell at ${x},${y}`)
}

const lineOf = (app: Awaited<ReturnType<typeof testRender>>, text: string) =>
  app
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes(text))

test("the cursor and hovered rows get the theme's muted hover fill, keeping status colors", async () => {
  const app = await testRender(() => <Demo />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    // The keyboard cursor starts on the first project heading.
    expect(cell(app, 3, 1)).toMatchObject({ char: "a", fg: palette.text, bg: palette.hover, bold: false })
    expect(cell(app, 24, 1).bg).toBe(palette.hover)
    expect(cell(app, 25, 1).bg).not.toBe(palette.hover)
    const y = lineOf(app, "Review provider")
    expect(cell(app, 3, y)).toMatchObject({ fg: palette.muted, bold: false })
    await app.mockMouse.moveTo(8, y)
    await app.renderOnce()
    // The whole row is filled, the title brightens without bold, and the indicator keeps its color.
    for (let x = 0; x < 25; x++) expect(cell(app, x, y).bg).toBe(palette.hover)
    expect(cell(app, 1, y)).toMatchObject({ char: "•", fg: palette.unread })
    expect(cell(app, 3, y)).toMatchObject({ char: "R", fg: palette.text, bold: false })
    // The overflowing title fades into the hover fill, not the panel background.
    expect(cell(app, 22, y).fg).toBe(
      rgbToHex(tint(RGBA.fromHex(palette.text), RGBA.fromHex(palette.hover), 0.92)),
    )
    // Hovering moved the cursor too, so the heading is no longer lit.
    expect(cell(app, 3, 1)).toMatchObject({ fg: palette.muted, bold: false })
    expect(cell(app, 3, 1).bg).not.toBe(palette.hover)
    // The conversation being viewed keeps a bold title, as the native rail's selected tab.
    expect(cell(app, 3, lineOf(app, "Inbox panel"))).toMatchObject({
      char: "I",
      fg: palette.text,
      bold: true,
    })
    // As in the native rail, hovering the current row keeps its selected fill.
    const current = lineOf(app, "Inbox panel")
    await app.mockMouse.moveTo(8, current)
    await app.renderOnce()
    expect(cell(app, 3, current)).toMatchObject({
      char: "I",
      fg: palette.text,
      bg: palette.selected,
      bold: true,
    })
  } finally {
    await app.dispose()
  }
})

test("the close ✕ has a gap before it and the panel padding after it, and the title stops before it", async () => {
  const app = await testRender(() => <Demo />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    let y = lineOf(app, "Review provider")
    await app.mockMouse.moveTo(8, y)
    await app.renderOnce()
    const line = app.captureCharFrame().split("\n")[y]!
    // Title, gap, ✕, then the panel's right padding.
    expect(line).toBe(" • Review provider conf ✕ ")
    const x = line.indexOf("✕")
    expect(cell(app, x, y).fg).toBe(palette.muted)
    // Pointing at the ✕ brightens it and keeps the row hovered.
    await app.mockMouse.moveTo(x, y)
    await app.renderOnce()
    expect(cell(app, x, y)).toMatchObject({ char: "✕", fg: palette.text, bg: palette.hover })
    expect(cell(app, 3, y).bg).toBe(palette.hover)
    // The gap before the ✕ belongs to the row: clicking it opens the session.
    await app.mockMouse.click(x - 1, y)
    await app.renderOnce()
    expect(cell(app, 3, y).bold).toBe(true)
    expect(app.captureCharFrame()).toContain("Review provider")
    // Clicking the ✕ closes the session.
    await app.mockMouse.click(x, y)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Review provider")
  } finally {
    await app.dispose()
  }
})

test("running sessions animate their indicator", async () => {
  const app = await testRender(() => <Demo />, { width: 60, height: 30 })
  try {
    await app.renderOnce()
    const first = app.captureCharFrame().match(/ (\S) Check service health/)?.[1]
    expect(first).toBe("⠋")
    await Bun.sleep(200)
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame().match(/ (\S) Check service health/)?.[1]).not.toBe(first)
  } finally {
    await app.dispose()
  }
})

test("a highlighted overflowing title scrolls left after a pause, then returns to its start", async () => {
  const app = await testRender(() => <Demo />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    const y = lineOf(app, "Review provider")
    const title = () => app.captureCharFrame().split("\n")[y]!.slice(3, 23)
    expect(title()).toBe("Review provider conf")
    await app.mockMouse.moveTo(8, y)
    await app.renderOnce()
    // Still at rest during the initial pause.
    expect(title()).toBe("Review provider conf")
    await Bun.sleep(600 + 80 * 3 + 40)
    await app.renderOnce()
    // A few cells in (exact ticks vary): the start has scrolled away, revealing the end.
    expect(title()).not.toStartWith("Review")
    expect(title()).toContain("provider config")
    // Leaving the row resets the title.
    await app.mockMouse.moveTo(8, lineOf(app, "Choose navigation"))
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[y]!.slice(3, 23)).toBe("Review provider conf")
  } finally {
    await app.dispose()
  }
})

test("over the new-session screen no row is current", async () => {
  const app = await testRender(() => <Demo current={null} />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    const y = lineOf(app, "Inbox panel")
    expect(cell(app, 3, y)).toMatchObject({ char: "I", fg: palette.muted, bold: false })
    expect(cell(app, 3, y).bg).not.toBe(palette.selected)
  } finally {
    await app.dispose()
  }
})

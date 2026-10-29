import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Demo } from "../src/demo"

test("panel mirrors the native rail: left indicators, no header, footer help only", async () => {
  const app = await testRender(() => <Demo />, { width: 100, height: 38 })
  try {
    await app.renderOnce()
    const screen = app.captureCharFrame()
    expect(screen.split("\n")[0]).toContain("▾ api-server")
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
    // 26 columns - 1 right padding - 3 indicator - 2 close slot = 20 title cells.
    expect(screen).toContain("Review provider conf")
    expect(screen).not.toContain("Review provider confi")
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

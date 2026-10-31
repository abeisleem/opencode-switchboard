import { expect, test } from "bun:test"
import { rgbToHex, RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, type JSX } from "solid-js"
import { DEMO_PALETTE as palette, Demo, demoSessions } from "../src/demo"
import { InboxPanel, tint } from "../src/panel"
import { initialState, laterKey } from "../src/model"
import plugin from "../src/tui"

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
    // 26 columns - 3 indicator - 3 close (gap, ✕, padding) = 20 title cells.
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
        underline: Boolean(span.attributes & TextAttributes.UNDERLINE),
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

for (const width of [26, 60]) {
  test(`row fill reaches the allocated right edge without painting its neighbor at ${width} columns`, async () => {
    const boundary = "#465166"
    const app = await testRender(
      () => (
        <box flexDirection="row" width="100%" height="100%">
          <box width={width} flexShrink={0}>
            <Demo />
          </box>
          <box width={1} height="100%" backgroundColor={boundary} />
        </box>
      ),
      { width: width + 1, height: 30 },
    )
    try {
      await app.renderOnce()
      await app.renderOnce()
      const bare = cell(app, 0, 0).bg
      // Keyboard selection paints every allocated cell, including the blank after ✕.
      await app.mockInput.pressArrow("down")
      await app.mockInput.pressArrow("up")
      await app.renderOnce()
      for (let x = 0; x < width; x++) expect(cell(app, x, 1).bg).toBe(palette.hover)
      expect(cell(app, width - 2, 1).char).toBe("✕")
      expect(cell(app, width - 1, 1)).toMatchObject({ char: " ", bg: palette.hover })
      expect(cell(app, width, 1).bg).toBe(boundary)

      const y = lineOf(app, "Index project")
      await app.mockMouse.moveTo(width - 1, y + 1)
      await app.renderOnce()
      // The detail line shares the full-width fill and remains part of the row hit area.
      expect(app.captureCharFrame().split("\n")[y + 1]).toContain("indexer")
      for (let x = 0; x < width; x++) {
        expect(cell(app, x, y).bg).toBe(palette.hover)
        expect(cell(app, x, y + 1).bg).toBe(palette.hover)
      }
      expect(cell(app, width, y).bg).toBe(boundary)
      expect(cell(app, width, y + 1).bg).toBe(boundary)
      await app.mockMouse.moveTo(width, y)
      await app.renderOnce()
      expect(cell(app, width - 1, y).bg).toBe(bare)
      await app.mockMouse.moveTo(width - 1, y)
      await app.renderOnce()
      expect(cell(app, width - 2, y)).toMatchObject({ char: "✕", fg: palette.text, bg: palette.hover })
      expect(cell(app, width - 1, y)).toMatchObject({ char: " ", bg: palette.hover })
      // The final allocated cell still closes the session; it must not open it.
      await app.mockMouse.click(width - 1, y)
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("Index project")
      expect(cell(app, 3, lineOf(app, "Inbox panel")).bold).toBe(true)
    } finally {
      await app.dispose()
    }
  })
}

test("keyboard navigation fills the row while mouse hover and the current session keep their styling", async () => {
  const app = await testRender(() => <Demo />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    const bare = cell(app, 0, 0).bg
    // The keyboard cursor brightens the heading without filling its row.
    expect(cell(app, 3, 1)).toMatchObject({ char: "a", fg: palette.text, bg: bare, bold: false })
    expect(cell(app, 24, 1).bg).toBe(bare)
    await app.mockInput.pressArrow("down")
    await app.renderOnce()
    const keyboardRow = lineOf(app, "Check service")
    for (let x = 0; x < 26; x++) expect(cell(app, x, keyboardRow).bg).toBe(palette.hover)
    expect(cell(app, 1, keyboardRow).fg).toBe(palette.running)
    await app.mockInput.pressArrow("up")
    await app.renderOnce()
    for (let x = 0; x < 26; x++) expect(cell(app, x, 1).bg).toBe(palette.hover)
    expect(cell(app, 3, keyboardRow).bg).toBe(bare)
    const y = lineOf(app, "Review provider")
    expect(cell(app, 3, y)).toMatchObject({ fg: palette.muted, bold: false })
    await app.mockMouse.moveTo(8, y)
    await app.renderOnce()
    // The whole row is filled, the title brightens without bold, and the indicator keeps its color.
    for (let x = 0; x < 26; x++) expect(cell(app, x, y).bg).toBe(palette.hover)
    expect(cell(app, 1, y)).toMatchObject({ char: "•", fg: palette.unread })
    expect(cell(app, 3, y)).toMatchObject({ char: "R", fg: palette.text, bold: false })
    // The overflowing title fades into the hover fill, not the panel background.
    expect(cell(app, 22, y).fg).toBe(
      rgbToHex(tint(RGBA.fromHex(palette.text), RGBA.fromHex(palette.hover), 0.92)),
    )
    // Mouse movement takes over: leaving clears the fill even though the cursor remains on it.
    await app.mockMouse.moveTo(25, y - 1)
    await app.renderOnce()
    for (let x = 0; x < 26; x++) expect(cell(app, x, y).bg).toBe(bare)
    expect(cell(app, 3, y).fg).toBe(palette.text)
    // Hovering moved the cursor too, so the heading is no longer lit.
    expect(cell(app, 3, 1)).toMatchObject({ fg: palette.muted, bold: false })
    expect(cell(app, 3, 1).bg).not.toBe(palette.hover)
    // The conversation being viewed keeps a bold title, as the native rail's selected tab.
    expect(cell(app, 3, lineOf(app, "Inbox panel"))).toMatchObject({
      char: "I",
      fg: palette.text,
      bg: bare,
      bold: true,
    })
    // Neither the title, detail line, nor padded close target fills the current row.
    const current = lineOf(app, "Inbox panel")
    for (const [x, row] of [
      [8, current],
      [8, current + 1],
      [25, current],
    ] as const) {
      await app.mockMouse.moveTo(x, row)
      await app.renderOnce()
      expect(cell(app, 3, current)).toMatchObject({ char: "I", fg: palette.text, bg: bare, bold: true })
      for (let column = 0; column < 26; column++) {
        expect(cell(app, column, current).bg).toBe(bare)
        expect(cell(app, column, current + 1).bg).toBe(bare)
      }
    }
    expect(cell(app, 24, current)).toMatchObject({ char: "✕", fg: palette.text, bg: bare })
  } finally {
    await app.dispose()
  }
})

test("keyboard selection fills detail lines and close padding but never fills the current session", async () => {
  const app = await testRender(() => <Demo />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    for (let step = 0; step < 4; step++) await app.mockInput.pressArrow("down")
    await app.renderOnce()
    const current = lineOf(app, "Inbox panel")
    const bare = cell(app, 25, current).bg
    expect(cell(app, 3, current).bold).toBe(true)
    expect(cell(app, 24, current).char).toBe("✕")
    for (let x = 0; x < 26; x++) {
      expect(cell(app, x, current).bg).toBe(bare)
      expect(cell(app, x, current + 1).bg).toBe(bare)
    }
    for (let step = 0; step < 3; step++) await app.mockInput.pressArrow("down")
    await app.renderOnce()
    const detail = lineOf(app, "Index project")
    expect(cell(app, 24, detail).char).toBe("✕")
    for (let x = 0; x < 26; x++) {
      expect(cell(app, x, detail).bg).toBe(palette.hover)
      expect(cell(app, x, detail + 1).bg).toBe(palette.hover)
    }
    expect(cell(app, 25, detail)).toMatchObject({ char: " ", bg: palette.hover })
    expect(cell(app, 25, detail + 1)).toMatchObject({ char: " ", bg: palette.hover })
  } finally {
    await app.dispose()
  }
})

test("losing focus clears keyboard fill while unfocused mouse hover still works", async () => {
  const [focused, setFocused] = createSignal(true)
  const app = await testRender(() => <Demo focused={focused()} />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    await app.mockInput.pressArrow("down")
    await app.renderOnce()
    const row = lineOf(app, "Check service")
    const bare = cell(app, 0, 0).bg
    expect(cell(app, 3, row).bg).toBe(palette.hover)
    setFocused(false)
    await app.renderOnce()
    expect(cell(app, 3, row).bg).toBe(bare)
    expect(cell(app, 24, row).char).toBe(" ")
    setFocused(true)
    await app.renderOnce()
    expect(cell(app, 3, row).bg).toBe(palette.hover)
    setFocused(false)
    await app.mockMouse.moveTo(8, row)
    await app.renderOnce()
    expect(cell(app, 3, row).bg).toBe(palette.hover)
    await app.mockMouse.moveTo(25, row - 1)
    await app.renderOnce()
    expect(cell(app, 3, row).bg).toBe(bare)
  } finally {
    await app.dispose()
  }
})

test("the close ✕ has a gap before it and highlighted target padding after it", async () => {
  const app = await testRender(() => <Demo />, { width: 26, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    let y = lineOf(app, "Review provider")
    await app.mockMouse.moveTo(8, y)
    await app.renderOnce()
    const line = app.captureCharFrame().split("\n")[y]!
    // Title, gap, ✕, and highlighted target padding at the allocated right edge.
    expect(line).toBe(" • Review provider conf ✕ ")
    const x = line.indexOf("✕")
    expect(cell(app, x, y).fg).toBe(palette.muted)
    expect(cell(app, x + 1, y)).toMatchObject({ char: " ", bg: palette.hover })
    expect(x + 1).toBe(25)
    // Pointing at the ✕ brightens it and keeps the row hovered.
    await app.mockMouse.moveTo(x, y)
    await app.renderOnce()
    expect(cell(app, x, y)).toMatchObject({ char: "✕", fg: palette.text, bg: palette.hover })
    expect(cell(app, 3, y).bg).toBe(palette.hover)
    await app.mockMouse.moveTo(x + 1, y)
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[y]).toBe(line)
    expect(cell(app, x, y).fg).toBe(palette.text)
    // The gap before the ✕ belongs to the row: clicking it opens the session.
    await app.mockMouse.click(x - 1, y)
    await app.renderOnce()
    expect(cell(app, 3, y).bold).toBe(true)
    for (let column = 0; column < 25; column++) expect(cell(app, column, y).bg).toBe(cell(app, 25, y).bg)
    expect(app.captureCharFrame()).toContain("Review provider")
    // Clicking the ✕ closes the session.
    await app.mockMouse.click(x, y)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Review provider")
  } finally {
    await app.dispose()
  }
})

for (const width of [26, 46]) {
  test(`collapsed project badges and close padding stay aligned at ${width} columns`, async () => {
    const app = await testRender(() => <Demo />, { width, height: 30 })
    try {
      await app.renderOnce()
      await app.renderOnce()
      const x = width - 2
      expect(cell(app, x, 1).char).toBe("✕")
      expect(cell(app, x + 1, 1)).toMatchObject({ char: " ", bg: cell(app, 0, 0).bg })
      await app.mockMouse.click(3, 1)
      await app.renderOnce()
      await app.renderOnce()
      const line = app.captureCharFrame().split("\n")[1]!
      expect(line).toContain("▸ api-server")
      expect(line).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1  • 1 ✕ $/)
      expect(cell(app, width - 11, 1)).toMatchObject({ fg: palette.running, bg: palette.hover })
      expect(cell(app, width - 6, 1)).toMatchObject({ char: "•", fg: palette.unread, bg: palette.hover })
      // Resting, hovering the title, and hovering the padded close target keep the same layout.
      await app.mockMouse.moveTo(3, lineOf(app, "dotfiles"))
      await app.renderOnce()
      expect(cell(app, width - 11, 1).fg).toBe(palette.running)
      expect(cell(app, x, 1).char).toBe(" ")
      await app.mockMouse.moveTo(x + 1, 1)
      await app.renderOnce()
      expect(app.captureCharFrame().split("\n")[1]!.slice(-9)).toBe(line.slice(-9))
      expect(cell(app, x, 1)).toMatchObject({ char: "✕", fg: palette.text, bg: palette.hover })
      expect(cell(app, x + 1, 1)).toMatchObject({ char: " ", bg: palette.hover })
      expect(x + 1).toBe(width - 1)
      // The trailing highlighted cell belongs to close, not to the heading's collapse action.
      await app.mockMouse.click(x + 1, 1)
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("api-server")
    } finally {
      await app.dispose()
    }
  })
}

test("session details end with the title before the padded close target", async () => {
  const app = await testRender(() => <Demo />, { width: 17, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    const y = lineOf(app, "Inbox pane")
    await app.mockMouse.moveTo(3, y)
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[y]).toMatch(/^ \S Inbox panel ✕ $/)
    expect(app.captureCharFrame().split("\n")[y + 1]).toBe("   inbox-panel   ")
    expect(cell(app, 13, y).fg).toBe(palette.text)
    for (let x = 14; x < 17; x++) {
      expect(cell(app, x, y + 1)).toMatchObject({ char: " ", bg: cell(app, 16, y + 1).bg })
    }
  } finally {
    await app.dispose()
  }
})

test("overflowing session details fade before the padded close target", async () => {
  const app = await testRender(() => <Demo />, { width: 16, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    const y = lineOf(app, "Inbox pane")
    await app.mockMouse.moveTo(3, y)
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[y]).toMatch(/^ \S Inbox pane ✕ $/)
    expect(app.captureCharFrame().split("\n")[y + 1]).toBe("   inbox-pane   ")
    expect(cell(app, 12, y).fg).toBe(
      rgbToHex(tint(RGBA.fromHex(palette.text), RGBA.fromHex(palette.background), 0.92)),
    )
    for (let x = 13; x < 16; x++) {
      expect(cell(app, x, y + 1)).toMatchObject({ char: " ", bg: cell(app, 15, y + 1).bg })
    }
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
    expect(title()).toBe("Review provider conf")
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
    expect(cell(app, 3, y).bg).toBe(cell(app, 25, y).bg)
  } finally {
    await app.dispose()
  }
})

test("native session renames refresh mounted rows without waiting for the poll", async () => {
  const state = initialState()
  state.revision = 1
  state.projects.work = { name: "Work", open: true, sessions: ["session"] }
  let title = "Original title"
  let reads = 0
  let open!: () => Promise<void>
  let render!: () => JSX.Element
  let cleanup!: ReturnType<typeof plugin.setup>
  const listeners = new Map<string, () => void>()
  const color = RGBA.fromHex("#c0caf5")
  const noop = () => {}
  // Only host capabilities used by setup and the mounted fullscreen panel are needed here.
  const context = {
    options: {},
    location: { directory: "/work" },
    client: {
      rpc: () => ({ snapshot: async () => state, events: { on: () => noop } }),
      project: { list: async () => [{ id: "work", name: "Work", canonical: "/work" }] },
      session: {
        active: async () => ({}),
        list: async () => {
          reads++
          return {
            data: [{ id: "session", projectID: "work", title, location: { directory: "/work" }, time: {} }],
            cursor: {},
          }
        },
      },
      permission: { request: { list: async () => ({ data: [] }) } },
      form: { list: async () => ({ data: [] }) },
    },
    data: {
      on: (type: string, listener: () => void) => {
        listeners.set(type, listener)
        return () => listeners.delete(type)
      },
      session: {
        family: () => [],
        status: () => "idle",
        pending: { list: () => [] },
        permission: { list: () => undefined },
        form: { list: () => undefined },
        get: () => undefined,
      },
    },
    storage: {
      memory: (_key: string, options: { initial: unknown }) => [options.initial, noop],
      store: (_key: string, options: { initial: unknown }) => [options.initial, noop],
    },
    theme: {
      text: { base: color, muted: color, feedback: { error: { base: color } } },
      background: { base: color, raised: { base: color }, action: { primary: { hovered: color } } },
      hue: { accent: { 200: color }, interactive: { 200: color } },
      decrease: (value: RGBA) => value,
    },
    ui: {
      router: {
        current: () => ({ type: "plugin", name: "switchboard" }),
        register: (route: { render: () => JSX.Element }) => {
          render = route.render
          return noop
        },
      },
      slot: () => noop,
      panel: { open: () => true, current: () => undefined },
      tabs: { enabled: () => false },
    },
    keymap: {
      layer: (factory: () => { commands: { id?: string; run: () => Promise<void> }[] }) => {
        for (const command of factory().commands) {
          if (command.id === "opencode-switchboard.open") open = command.run
        }
      },
    },
  } as unknown as Plugin.Context
  const app = await testRender(
    () => {
      cleanup = plugin.setup(context)
      return render()
    },
    { width: 60, height: 20 },
  )
  try {
    listeners.get("session.renamed")?.()
    expect(reads).toBe(0)
    await open()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Original title")

    title = "Renamed from session list"
    listeners.get("session.renamed")?.()
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(title)
    expect(app.captureCharFrame()).not.toContain("Original title")
  } finally {
    await (
      await cleanup
    )?.()
    expect(listeners.has("session.renamed")).toBe(false)
    await app.dispose()
  }
})

for (const width of [26, 46]) {
  test(`project and session spinners share frames and colors; a folded Later stays quiet at ${width} columns`, async () => {
    const sessions = demoSessions()
    const state = initialState()
    for (const session of sessions) {
      const project = (state.projects[session.project] ??= {
        name: session.projectName,
        open: true,
        sessions: [],
      })
      project.sessions.push(session.id)
    }
    for (const id of ["index", "keys", "theme"]) state.sessions[id] = { placement: "later", unread: false }
    state.collapsed = ["api-server", laterKey("dotfiles")]
    const noop = () => {}
    const app = await testRender(
      () => (
        <InboxPanel
          state={state}
          sessions={sessions}
          colors={palette}
          error=""
          loading={false}
          focused={false}
          act={noop}
          open={noop}
          refresh={noop}
          close={noop}
          help={noop}
          diagnostics={noop}
        />
      ),
      { width, height: 20 },
    )
    try {
      await app.renderOnce()
      await app.renderOnce()
      const lines = () => app.captureCharFrame().split("\n")
      const before = lines()
      expect(before[1]).toContain("▸ api-server")
      expect(before[3]).toContain("▾ dotfiles")
      // Parked work never badges its Later heading, folded or not.
      expect(before[12]!.trim()).toBe("▸ Later · 3")
      expect(before[1]).toContain("⠋ 1  • 1")
      expect(cell(app, before[1]!.indexOf("⠋"), 1).fg).toBe(palette.running)
      expect(before[2]!.trim()).toBe("")
      // Both locations use the same animation clock and stay on one text baseline.
      expect(before[5]).toContain("⠋ Inbox panel")
      await Bun.sleep(200)
      await app.renderOnce()
      await app.renderOnce()
      const after = lines()
      expect(after[5]).not.toContain("⠋ Inbox panel")
      expect(after[5]).toContain("Inbox panel")
      const frame = after[5]!.match(/(\S) Inbox panel/)![1]!
      expect(after[1]).toContain(`${frame} 1  • 1`)
      expect(after[1]!.replace(frame, "⠋")).toBe(before[1])
      for (const y of [2, 3, 12, 13]) expect(after[y]).toBe(before[y])
    } finally {
      await app.dispose()
    }
  })
}

test("group spinners animate when every running session is hidden in a collapsed project", async () => {
  const app = await testRender(() => <Demo />, { width: 46, height: 20 })
  try {
    await app.renderOnce()
    await app.mockMouse.click(3, lineOf(app, "api-server"))
    await app.renderOnce()
    await app.mockMouse.click(3, lineOf(app, "dotfiles"))
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Check service health")
    expect(app.captureCharFrame()).not.toContain("Inbox panel")
    const mark = () =>
      app
        .captureCharFrame()
        .split("\n")[1]!
        .match(/(\S) 1  • 1/)![1]!
    const before = mark()
    expect("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏").toContain(before)
    await Bun.sleep(200)
    await app.renderOnce()
    await app.renderOnce()
    expect(mark()).not.toBe(before)
  } finally {
    await app.dispose()
  }
})

test("project headings read as underlined directories, with triangles dim until the row is lit", async () => {
  const app = await testRender(() => <Demo focused={false} />, { width: 46, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    const y = lineOf(app, "api-server")
    const name = "api-server/"
    expect(app.captureCharFrame().split("\n")[y]).toContain(`▾ ${name}`)
    expect(cell(app, 1, y)).toMatchObject({ char: "▾", fg: palette.detail, underline: false })
    for (let x = 3; x < 3 + name.length; x++)
      expect(cell(app, x, y)).toMatchObject({ fg: palette.muted, underline: true, bold: false })
    expect(cell(app, 3 + name.length, y).underline).toBe(false)
    // Later is a plain muted label: no underline or slash, and a count only once folded.
    const later = lineOf(app, "Later")
    expect(app.captureCharFrame().split("\n")[later]!.trim()).toBe("▾ Later")
    expect(cell(app, 3, later)).toMatchObject({ char: "▾", fg: palette.detail })
    expect(cell(app, 5, later)).toMatchObject({ char: "L", fg: palette.muted, underline: false })
    // Hovering brightens the triangle with the label.
    await app.mockMouse.moveTo(8, y)
    await app.renderOnce()
    expect(cell(app, 1, y).fg).toBe(palette.text)
    expect(cell(app, 3, y)).toMatchObject({ fg: palette.text, underline: true })
    await app.mockMouse.moveTo(8, later)
    await app.renderOnce()
    expect(cell(app, 3, later).fg).toBe(palette.text)
    expect(cell(app, 5, later).fg).toBe(palette.text)
    await app.mockMouse.click(8, later)
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[later]!.trim()).toBe("▸ Later · 2")
  } finally {
    await app.dispose()
  }
})

test("sessions under Later put their indicator under the Later triangle, beside the title", async () => {
  const app = await testRender(() => <Demo focused={false} />, { width: 46, height: 30 })
  try {
    await app.renderOnce()
    await app.renderOnce()
    const lines = app.captureCharFrame().split("\n")
    expect(lines[lineOf(app, "Review provider")]).toStartWith(" • Review provider")
    const parked = lineOf(app, "Revisit keybindings")
    expect(lines[parked]).toStartWith("   • Revisit keybindings")
    expect(cell(app, 3, lineOf(app, "Later")).char).toBe("▾")
    expect(cell(app, 3, parked)).toMatchObject({ char: "•", fg: palette.unread })
    // Titles and worktree lines keep their columns.
    const theme = lineOf(app, "Theme experiments")
    expect(lines[theme]).toStartWith("     Theme experiments")
    expect(lines[theme + 1]).toStartWith("     theme")
  } finally {
    await app.dispose()
  }
})

test("folded project badges take session-row colors and keep a gap after a long faded name", async () => {
  const name = "customer-analytics-platform-monorepo"
  const base = demoSessions()[0]!
  const make = (id: string, status: "Question" | "Running" | "Ready", idle: number) => ({
    ...base,
    id,
    title: id,
    status,
    idle,
    running: status === "Running",
    project: "long",
    projectName: name,
  })
  const sessions = [make("ask", "Question", 0), make("run", "Running", 0), make("done", "Ready", 2)]
  const state = initialState()
  state.projects.long = { name, open: true, sessions: sessions.map((session) => session.id) }
  state.collapsed = ["long"]
  const noop = () => {}
  const app = await testRender(
    () => (
      <InboxPanel
        state={state}
        sessions={sessions}
        colors={palette}
        error=""
        loading={false}
        focused={false}
        act={noop}
        open={noop}
        refresh={noop}
        close={noop}
        help={noop}
        diagnostics={noop}
      />
    ),
    { width: 36, height: 10 },
  )
  try {
    await app.renderOnce()
    await app.renderOnce()
    const line = app.captureCharFrame().split("\n")[1]!
    // The name and its slash fade out together, a blank cell before the first badge.
    expect(line).not.toContain("/")
    expect(line).toMatch(/▸ customer-analy\S* \? 1  ⠋ 1  • 1/)
    const at = line.indexOf("?")
    expect(cell(app, at - 2, 1).underline).toBe(true)
    expect(cell(app, at - 1, 1)).toMatchObject({ char: " ", underline: false })
    expect(cell(app, at, 1).fg).toBe(palette.attention)
    expect(cell(app, at + 2, 1)).toMatchObject({ char: "1", fg: palette.muted })
    expect(cell(app, line.indexOf("⠋"), 1).fg).toBe(palette.running)
    expect(cell(app, line.indexOf("•"), 1).fg).toBe(palette.unread)
  } finally {
    await app.dispose()
  }
})

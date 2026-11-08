import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import {
  MouseButton,
  RGBA,
  TextAttributes,
  type BoxRenderable,
  type MouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  rowDetail,
  rowProject,
  rows,
  section,
  unread,
  type Action,
  type Badge,
  type Placement,
  type Row,
  type Session,
  type State,
} from "./model"
import { reconcileSelection, rowKey, type SelectionMemory } from "./selection"
import { RowMenu, type MenuColors, type MenuControls, type MenuItem } from "./menu"
import { FilePath } from "./file-path"

/** Muted rows, matching hover/keyboard fills, and a bold current title on the bare surface. */
export type Palette = {
  /** Titles of the hovered or cursor row and of the conversation being viewed. */
  text: string | RGBA
  /** Resting titles and headings. */
  muted: string | RGBA
  /** Secondary line (worktree), dimmer than muted titles. */
  detail: string | RGBA
  /** The panel surface, which overflowing titles fade into. */
  background: string | RGBA
  /** A non-current hovered or keyboard-selected row. Opaque, so titles can fade into it. */
  hover: string | RGBA
  /** The row a right-click menu acts on, while the menu is open; distinct from hover. Opaque. */
  target: string | RGBA
  menu: MenuColors
  unread: string | RGBA
  attention: string | RGBA
  running: string | RGBA
  error: string | RGBA
}

const rgba = (color: string | RGBA) => (typeof color === "string" ? RGBA.fromHex(color) : color)

/** Same blend as the native rail's `tint`. */
export function tint(base: RGBA, overlay: RGBA, alpha: number) {
  const mix = (a: number, b: number) => Math.round((a + (b - a) * alpha) * 255)
  return RGBA.fromInts(mix(base.r, overlay.r), mix(base.g, overlay.g), mix(base.b, overlay.b))
}

const FADE_WIDTH = 4
const cellWidth = (value: string) => (typeof Bun === "undefined" ? value.length : Bun.stringWidth(value))

const MARQUEE_GAP = " · "
const MARQUEE_DELAY = 600
const MARQUEE_INTERVAL = 80

/**
 * One line clipped to its measured width; when it overflows, the last cells fade into the
 * background as in the native rail. With `scroll`, an overflowing line scrolls left once
 * through a ` · ` loop after a short pause, with timing matching the native tab marquee.
 */
function FadeText(props: {
  text: string
  fg: string | RGBA
  background: string | RGBA
  bold?: boolean
  underline?: boolean
  scroll?: boolean
}) {
  let box: BoxRenderable | undefined
  const [width, setWidth] = createSignal(0)
  const [offset, setOffset] = createSignal(0)
  const overflows = createMemo(() => cellWidth(props.text) > width())
  createEffect(
    on(
      () => Boolean(props.scroll) && overflows() && width() > FADE_WIDTH * 2,
      (active) => {
        if (!active) return
        const cycle = Array.from(props.text + MARQUEE_GAP).length
        let interval: ReturnType<typeof setInterval> | undefined
        const delay = setTimeout(() => {
          setOffset(1)
          interval = setInterval(
            () =>
              setOffset((value) => {
                if (value + 1 < cycle) return value + 1
                clearInterval(interval)
                return 0
              }),
            MARQUEE_INTERVAL,
          )
        }, MARQUEE_DELAY)
        onCleanup(() => {
          clearTimeout(delay)
          clearInterval(interval)
          setOffset(0)
        })
      },
    ),
  )
  const source = createMemo(() => {
    if (offset() === 0) return props.text
    const loop = Array.from(props.text + MARQUEE_GAP)
    return [...loop.slice(offset()), ...loop].join("")
  })
  const visible = createMemo(
    () => {
      const result: string[] = []
      let used = 0
      for (const part of Array.from(source())) {
        used += cellWidth(part)
        if (used > width()) return { parts: result, overflows: true }
        result.push(part)
      }
      return { parts: result, overflows: false }
    },
    undefined,
    // Same text at the same width: keep the old result so the spans are not rebuilt.
    { equals: (a, b) => a?.overflows === b.overflows && a.parts.join("") === b.parts.join("") },
  )
  // Only edge cells fade, so render the middle as one plain string and the edges as a few spans.
  const lead = createMemo(() => (offset() > 0 ? visible().parts.slice(0, FADE_WIDTH) : []))
  const middle = createMemo(() => visible().parts.slice(lead().length, -FADE_WIDTH).join(""))
  const tail = createMemo(() => visible().parts.slice(-FADE_WIDTH))
  const fade = (index: number) => {
    const fg = rgba(props.fg)
    return tint(fg, rgba(props.background), 0.2 + (0.72 * index) / (FADE_WIDTH - 1))
  }
  const tailFades = createMemo(() => tail().map((_, index) => fade(index)))
  const leadFades = createMemo(() => lead().map((_, index) => fade(FADE_WIDTH - 1 - index)))
  return (
    <box
      ref={box}
      flexGrow={1}
      flexBasis={0}
      minWidth={0}
      height={1}
      overflow="hidden"
      onSizeChange={() => setWidth(box?.width ?? 0)}
    >
      <text
        selectable={false}
        fg={props.fg}
        wrapMode="none"
        attributes={
          (props.bold ? TextAttributes.BOLD : 0) | (props.underline ? TextAttributes.UNDERLINE : 0) ||
          undefined
        }
      >
        <Show when={visible().overflows && width() > FADE_WIDTH} fallback={props.text}>
          <Index each={lead()}>
            {(part, index) => <span style={{ fg: leadFades()[index] }}>{part()}</span>}
          </Index>
          {middle()}
          <Index each={tail()}>
            {(part, index) => <span style={{ fg: tailFades()[index] }}>{part()}</span>}
          </Index>
        </Show>
      </text>
    </box>
  )
}

/** OpenCode's own tab spinner frames and cadence. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_INTERVAL = 80
/** Lines rendered beyond each edge of the window, so a small scroll finds its rows already built. */
const OVERSCAN = 2

/** A row's lines: a session with a worktree line takes two. Rows sit one blank line apart. */
const rowHeight = (row: Row) => (rowDetail(row) ? 2 : 1)

/** A mouse-down handler that runs only for the left button; other buttons pass through untouched. */
const left = (run: () => void) => (event: MouseEvent) => {
  if (event.button === MouseButton.LEFT) run()
}

export type PanelProps = {
  state: State
  sessions: Session[]
  colors: Palette
  error: string
  /** A muted footer line for a condition that fixes itself, such as reconnecting; an error replaces it. */
  notice?: string
  /**
   * The footer's resting line, as OpenCode's sidebar footer: `<directory>:<branch>`, or the directory alone without
   * git. An error or a notice replaces it.
   */
  location?: string
  loading: boolean
  /** Whether the panel has keyboard focus; clicks while unfocused leave focus where it is. */
  focused: boolean
  act: (action: Action) => void
  /** The conversation this TUI shows, drawn bold; null on the new-session screen. */
  current: string | null
  /** Open a session; the host then focuses its conversation. */
  open: (session: Session) => void
  /**
   * Opens the new-session screen of a project, by its key. Without it, `n` does nothing and project headings have
   * no menu.
   */
  newSession?: (project: string) => void
  close: () => void
  help: () => void
  diagnostics: () => void
  selectionMemory?: SelectionMemory
  keys?: (actions: {
    next: () => void
    previous: () => void
    enter: () => void
    unread: () => void
    /** Parks the highlighted session, or unparks it if parked; does nothing on a heading. */
    park: () => void
    /** Folds or unfolds the highlighted heading; does nothing on a session row. */
    fold: (folded: boolean) => void
    /** Opens the new-session screen of the highlighted row's project. */
    newSession: () => void
    remove: () => void
    /** Moves the cursor to a row key (see rowKey). */
    reveal: (key: string) => void
  }) => void
  /** Binds the right-click menu's keys while it is open (see RowMenu); without it the menu takes the mouse only. */
  menuKeys?: (controls: MenuControls) => void
}

export function InboxPanel(props: PanelProps) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const restored = props.selectionMemory ? { ...props.selectionMemory } : undefined
  const owner = Symbol("inbox panel")
  if (props.selectionMemory) props.selectionMemory.owner = owner
  const [requested, setRequested] = createSignal<{ key: string }>()
  const [hovered, setHovered] = createSignal<string>()
  const [keyboardHighlight, setKeyboardHighlight] = createSignal(false)
  let scroll: ScrollBoxRenderable | undefined
  let disposed = false
  const items = createMemo(() => rows(props.sessions, props.state))
  const selection = createMemo<{
    items: Row[]
    key: string
    index: number
    request: { key: string } | undefined
    pending: boolean
  }>((previous) => {
    const request = requested()
    const next = items()
    const remembered = previous ?? restored
    const key = request && request !== previous?.request ? request.key : (remembered?.key ?? "")
    const index = reconcileSelection(remembered?.items ?? [], next, key, remembered?.index ?? 0)
    const id = key.startsWith("session:") ? key.slice("session:".length) : undefined
    const pending = Boolean(
      id &&
        !props.sessions.some((session) => session.id === id) &&
        (props.loading ||
          !props.sessions.length ||
          Object.values(props.state.projects).some(
            (project) => project.open && project.sessions.includes(id),
          )),
    )
    return {
      items: next.length ? next : (remembered?.items ?? []),
      key: pending ? key : next[index] ? rowKey(next[index]!) : "",
      index,
      request,
      pending,
    }
  })
  const cursor = () => selection().index
  const current = () => items()[cursor()]
  const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key, i) => key === b[i])
  const keys = createMemo(() => items().map(rowKey), [], { equals: sameKeys })
  const entries = createMemo(() => new Map(items().map((row, index) => [rowKey(row), { row, index }])))
  /** Each row's first line in the scrolled content, and the content's height, from the known row heights. */
  const layout = createMemo(() => {
    const tops: number[] = []
    let line = 0
    for (const row of items()) {
      tops.push(line)
      line += rowHeight(row) + 1
    }
    return { tops, height: Math.max(0, line - 1) }
  })
  // The scroll position, kept as the scrollbox reports it; see the window below.
  const [scrollTop, setScrollTop] = createSignal(0)
  // The scrollbox's height once laid out. Only the spinner reads it: a change during layout must not add rows.
  const [viewportHeight, setViewportHeight] = createSignal(0)
  /** The first visible line. The scrollbox clamps its position when the content shrinks; clamp here first. */
  const shownTop = () => {
    const height = untrack(() => (scroll && !scroll.isDestroyed ? scroll.viewport.height : 0))
    return Math.max(0, Math.min(scrollTop(), layout().height - height))
  }
  /** Whether a row's lines meet `[from, to)`. */
  const meets = (index: number, from: number, to: number) => {
    const top = layout().tops[index]!
    return top < to && top + rowHeight(items()[index]!) > from
  }
  type Span = { first: number; last: number }
  const sameSpan = (a: Span, b: Span) => a.first === b.first && a.last === b.last
  /**
   * The rows that can be on screen: mounting the panel, which the host does on every session switch, builds only
   * these. The window spans the terminal's height, which no viewport exceeds, so it never waits on a layout pass.
   */
  const needed = createMemo(
    () => {
      const from = shownTop() - OVERSCAN
      const to = shownTop() + dimensions().height + OVERSCAN
      const count = items().length
      let first = 0
      while (first < count && !meets(first, from, to)) first++
      let last = first
      while (last + 1 < count && meets(last + 1, from, to)) last++
      return { first, last: first < count ? last : first - 1 }
    },
    { first: 0, last: -1 },
    { equals: sameSpan },
  )
  // The renderer routes pointer events by the last frame's layout, so a burst of wheel events between two frames
  // must not lose the row under the pointer: until the next frame, the window only grows as it moves. A jump far
  // away (the cursor moving by key) starts afresh.
  const [frames, setFrames] = createSignal(0)
  let pruned = 0
  const span = createMemo<Span>(
    (before) => {
      const next = needed()
      if (frames() !== pruned) {
        pruned = frames()
        return next
      }
      const overlap = next.first <= before.last + 1 && before.first <= next.last + 1
      if (!overlap || next.last < next.first || before.last < before.first) return next
      return { first: Math.min(next.first, before.first), last: Math.max(next.last, before.last) }
    },
    { first: 0, last: -1 },
    { equals: sameSpan },
  )
  const prune = () => {
    if (!disposed && !sameSpan(span(), needed())) setFrames((count) => count + 1)
  }
  createEffect(
    on(needed, () => {
      renderer.off("frame", prune)
      renderer.once("frame", prune)
    }),
  )
  const windowKeys = createMemo(() => keys().slice(span().first, span().last + 1), [], { equals: sameKeys })
  // Blank lines that stand in for the rows outside the window, so the content keeps its height and scroll range.
  // The column's gap adds the line between a spacer and its neighbor row.
  const above = () => (span().first > 0 ? layout().tops[span().first]! - 1 : 0)
  const below = () => {
    const { last } = span()
    if (last < 0 || last >= items().length - 1) return 0
    return layout().height - (layout().tops[last]! + rowHeight(items()[last]!)) - 1
  }
  function keepVisible() {
    if (!scroll || cursor() < 0 || selection().pending || !scroll.viewport.height) return
    // Use the known row heights: newly reconciled renderables can still have
    // an old/zero layout here, which would incorrectly scroll back to the top.
    const top = layout().tops[cursor()]!
    const bottom = top + rowHeight(current()!)
    if (top < scroll.scrollTop) scroll.scrollTo(top)
    else if (bottom > scroll.scrollTop + scroll.viewport.height)
      scroll.scrollTo(bottom - scroll.viewport.height)
  }
  let restoring = Boolean(restored && (restored.scrollTop > 0 || restored.index > 0))
  function restoreViewport() {
    if (
      disposed ||
      !restoring ||
      selection().pending ||
      cursor() < 0 ||
      !scroll?.viewport.height ||
      !scroll.scrollHeight
    )
      return
    restoring = false
    scroll.scrollTo(restored!.scrollTop)
    keepVisible()
  }
  // The content's native layout is ready after the first frame. Avoid mutating
  // scroll state from a layout-size callback, which can re-enter the host layout.
  function scheduleRestore() {
    if (restoring && !selection().pending && cursor() >= 0) {
      renderer.off("frame", restoreViewport)
      renderer.once("frame", restoreViewport)
    }
  }
  createEffect(
    on(
      () => `${selection().key}\n${selection().index}\n${selection().pending}`,
      () => {
        keepVisible()
        scheduleRestore()
      },
    ),
  )
  onMount(scheduleRestore)
  onMount(() => {
    // The scrollbar reports every position change synchronously: a wheel, a scrollTo, or a clamp.
    const bar = scroll!.verticalScrollBar
    const moved = (event: { position: number }) => setScrollTop(event.position)
    bar.on("change", moved)
    onCleanup(() => bar.off("change", moved))
    setScrollTop(scroll!.scrollTop)
  })
  function remember() {
    if (!props.selectionMemory || props.selectionMemory.owner !== owner) return
    const selected = selection()
    Object.assign(props.selectionMemory, {
      items: selected.items,
      key: selected.key,
      index: selected.index,
      scrollTop:
        !selected.pending && scroll && !scroll.isDestroyed
          ? scroll.scrollTop
          : props.selectionMemory.scrollTop,
    })
  }
  onCleanup(() => {
    disposed = true
    renderer.off("frame", prune)
    renderer.off("frame", restoreViewport)
    remember()
  })
  function step(amount: number) {
    setKeyboardHighlight(true)
    setHovered(undefined)
    const row = items()[Math.max(0, Math.min(items().length - 1, cursor() + amount))]
    if (row) setRequested({ key: rowKey(row) })
    remember()
  }
  function enter() {
    const row = current()
    // Capture intent before an action can mount another host panel.
    remember()
    if (row?.kind === "heading") props.act({ type: "collapse", key: row.key })
    if (row?.kind === "session") props.open(row.session)
  }
  // Session actions shared by the keys (on the cursor row) and the right-click menu (on the clicked row). Each sends
  // the target state, not a toggle, so a repeated press or a second client cannot flip it back.
  function markRead(row: Row | undefined) {
    if (row?.kind === "session")
      props.act(
        unread(row.session, props.state)
          ? { type: "read", sessionID: row.session.id, observed: row.session.idle }
          : { type: "unread", sessionID: row.session.id },
      )
  }
  function park(row: Row | undefined) {
    if (row?.kind !== "session") return
    const placement: Placement = section(row.session, props.state) === "parked" ? "active" : "parked"
    props.act({ type: "place", sessionID: row.session.id, placement })
  }
  function newSession(row: Row | undefined) {
    const project = row && rowProject(row)
    if (project !== undefined) props.newSession?.(project)
  }
  /** The right-click menu: the row it acts on (by key) and where the pointer was. */
  const [menu, setMenu] = createSignal<{ key: string; x: number; y: number }>()
  /** Set when the menu closes, until the pointer moves; see `hover`. */
  let pointerStill = false
  function closeMenu() {
    pointerStill = true
    setMenu(undefined)
  }
  /**
   * A row's menu items, labeled with what each will do: a session's two, or New session on a project heading.
   * A Parked heading has none.
   */
  function menuItems(row: Row): MenuItem[] {
    if (row.kind === "heading")
      return row.depth === 0 && props.newSession
        ? [{ label: "New session", hint: "n", run: () => newSession(row) }]
        : []
    return [
      {
        label: unread(row.session, props.state) ? "Mark read" : "Mark unread",
        hint: "u",
        run: () => markRead(row),
      },
      {
        label: section(row.session, props.state) === "parked" ? "Unpark" : "Park",
        hint: "p",
        run: () => park(row),
      },
    ]
  }
  // Built from the row as it is now, so a label and its action never disagree; a vanished row closes the menu.
  const menuTarget = createMemo(() => {
    const open = menu()
    const row = open && entries().get(open.key)?.row
    const items = row ? menuItems(row) : []
    return open && items.length ? { ...open, items } : undefined
  })
  // Forget a closed menu's row, so it cannot reopen if that row comes back.
  createEffect(() => {
    if (menu() && !menuTarget()) closeMenu()
  })
  props.keys?.({
    next: () => step(1),
    previous: () => step(-1),
    enter: () => enter(),
    unread: () => markRead(current()),
    park: () => park(current()),
    fold: (folded) => {
      const row = current()
      // Always sent, even when the heading already looks that way: the shown state can lag behind the server.
      if (row?.kind === "heading") props.act({ type: "fold", key: row.key, folded })
    },
    newSession: () => newSession(current()),
    reveal: (key) => {
      setRequested({ key })
      remember()
    },
    remove: () => {
      const row = current()
      if (row?.kind === "heading" && row.depth === 0) props.act({ type: "project-close", project: row.key })
      if (row?.kind === "session") props.act({ type: "session-remove", sessionID: row.session.id })
    },
  })
  // One clock drives session spinners and activity summarized by collapsed headings. It ticks only while one of
  // them is on screen: not scrolled out of view, and not hidden in a fold (folded rows are not in `items`).
  const animating = createMemo(() => {
    const from = shownTop()
    const to = from + (viewportHeight() || dimensions().height)
    return items().some(
      (row, index) =>
        (row.kind === "heading"
          ? row.badges.some((badge) => badge.kind === "running")
          : row.session.running || row.session.status === "Queued") && meets(index, from, to),
    )
  })
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (!animating()) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER.length), SPINNER_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })
  const activity = () => SPINNER[frame()]!
  function badgeSymbol(kind: Badge["kind"]) {
    if (kind === "running") return activity()
    if (kind === "attention") return "?"
    return "•"
  }
  /** The native rail's left indicator: approval, question, activity, error, or unread. */
  function indicator(session: Session): [string, string | RGBA] {
    if (session.status === "Approval") return ["!", props.colors.attention]
    if (session.status === "Question") return ["?", props.colors.attention]
    if (session.running || session.status === "Queued") return [activity(), props.colors.running]
    if (session.status === "Error") return ["×", props.colors.error]
    if (unread(session, props.state)) return ["•", props.colors.unread]
    if (session.attention) return ["~", props.colors.muted]
    return ["", props.colors.muted]
  }
  const [locationWidth, setLocationWidth] = createSignal(0)
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingTop={1}>
      <scrollbox
        ref={scroll}
        flexGrow={1}
        minHeight={0}
        onSizeChange={() => setViewportHeight(scroll?.height ?? 0)}
      >
        <Show
          when={items().length}
          fallback={
            <text selectable={false} fg={props.colors.muted} paddingLeft={3}>
              {props.loading ? "Loading…" : "No open projects. Open one with Ctrl+O."}
            </text>
          }
        >
          <box flexDirection="column" gap={1}>
            <Show when={above()}>{(height) => <box height={height()} flexShrink={0} />}</Show>
            <For each={windowKeys()}>
              {(key) => {
                // Rows keep their identity across refreshes; only what changed re-renders.
                // Keep the last entry so a row being removed never reads a missing one.
                let last = entries().get(key)!
                const entry = createMemo(() => (last = entries().get(key) ?? last), last, {
                  equals: (a, b) => a.index === b.index && JSON.stringify(a.row) === JSON.stringify(b.row),
                })
                const index = () => entry().index
                // Cursor and hover both brighten text and expose the close target.
                const lit = createMemo(() => hovered() === key || (props.focused && cursor() === index()))
                const current = () => key === `session:${props.current}`
                // The row an open right-click menu acts on; it keeps its own fill until the menu closes.
                const targeted = () => menuTarget()?.key === key
                // Mouse movement takes over from keyboard navigation; the current row stays bold only.
                const fill = () =>
                  targeted()
                    ? props.colors.target
                    : !current() && lit() && (keyboardHighlight() || hovered() === key)
                      ? props.colors.hover
                      : undefined
                const background = () => fill() ?? props.colors.background
                const hover = (event: MouseEvent) => {
                  setKeyboardHighlight(false)
                  setHovered(key)
                  // After a menu closes, the row under a still pointer is hovered again; only a real move
                  // follows it with the cursor, so closing the menu never moves the cursor.
                  if (event.type === "move") pointerStill = false
                  // As in native lists, pointing at a row in the focused panel moves the cursor there.
                  if (props.focused && !pointerStill && selection().key !== key) setRequested({ key })
                }
                const [closeHovered, setCloseHovered] = createSignal(false)
                /**
                 * A fixed-width close target (the `✕` and the cell after it), always laid out so hovering it
                 * neither shifts nor unhovers the row. The blank cell before it belongs to the row, so the
                 * title stops short of the `✕` and clicking past a title's end opens the row.
                 */
                const close = (run: () => void) => (
                  <text
                    selectable={false}
                    marginLeft={1}
                    width={2}
                    flexShrink={0}
                    fg={closeHovered() ? props.colors.text : props.colors.muted}
                    onMouseOver={() => setCloseHovered(true)}
                    onMouseOut={() => setCloseHovered(false)}
                    onMouseDown={(event) => {
                      // Other buttons fall through to the row, which applies the same rule.
                      if (event.button !== MouseButton.LEFT) return
                      event.stopPropagation()
                      if (lit()) run()
                    }}
                  >
                    {/* Under an open menu the ✕ cannot be clicked, so its row does not show it. */}
                    {lit() && !targeted() ? "✕" : ""}
                  </text>
                )
                const heading = () => entry().row as Extract<Row, { kind: "heading" }>
                const headingColor = () => (lit() || targeted() ? props.colors.text : props.colors.muted)
                const item = () => entry().row as Extract<Row, { kind: "session" }>
                const session = () => item().session
                const indent = () => (item().depth - 1) * 2
                const out = () => {
                  setKeyboardHighlight(false)
                  if (hovered() === key) setHovered(undefined)
                }
                const down = (event: MouseEvent) => {
                  // A right-click opens the row's menu, if it has one (a Parked heading does not). It never
                  // moves the cursor or opens anything, and the host never sees it: focus stays where it is,
                  // and OpenCode does not act on it.
                  if (event.button === MouseButton.RIGHT) {
                    event.preventDefault()
                    event.stopPropagation()
                    if (menuItems(entry().row).length) setMenu({ key, x: event.x, y: event.y })
                    return
                  }
                  // The host focuses the panel on mouse down; an unfocused click acts without stealing focus.
                  if (!props.focused) event.stopPropagation()
                  // Only the left button opens a session or flips a fold.
                  if (event.button !== MouseButton.LEFT) return
                  setRequested({ key })
                  enter()
                }
                // A one-line row lays its parts out in the row's own box, with no inner box: each row costs a few
                // renderables, and the host builds every visible row again on each session switch.
                if (key.startsWith("heading:"))
                  return (
                    <box
                      flexDirection="row"
                      alignItems="center"
                      height={1}
                      paddingLeft={1 + heading().depth * 2}
                      backgroundColor={fill()}
                      onMouseMove={hover}
                      onMouseOver={hover}
                      onMouseOut={out}
                      onMouseDown={down}
                    >
                      {/* A control, not content: dim until the row is lit. */}
                      <text
                        selectable={false}
                        width={2}
                        flexShrink={0}
                        fg={lit() ? props.colors.text : props.colors.detail}
                      >
                        {heading().closed ? "▸ " : "▾ "}
                      </text>
                      {/* A project reads as a directory: underlined, with a trailing `/` that fades with it. */}
                      <FadeText
                        text={heading().depth === 0 ? `${heading().title}/` : heading().title}
                        fg={headingColor()}
                        background={background()}
                        underline={heading().depth === 0}
                        scroll={lit()}
                      />
                      <Show when={heading().badges.length}>
                        {/* The margin keeps a faded name off the first badge. */}
                        <box
                          flexDirection="row"
                          alignItems="center"
                          height={1}
                          flexShrink={0}
                          gap={2}
                          marginLeft={1}
                        >
                          <For each={heading().badges}>
                            {(badge) => (
                              <box flexDirection="row" alignItems="center" height={1} gap={1}>
                                {/* Symbols take their session-row colors; counts stay with the heading. */}
                                <text selectable={false} width={1} height={1} fg={props.colors[badge.kind]}>
                                  {badgeSymbol(badge.kind)}
                                </text>
                                <text selectable={false} height={1} fg={headingColor()}>
                                  {badge.count}
                                </text>
                              </box>
                            )}
                          </For>
                        </box>
                      </Show>
                      {heading().depth === 0
                        ? close(() => props.act({ type: "project-close", project: heading().key }))
                        : null}
                    </box>
                  )
                const detail = () => rowDetail(item())
                const line = () => (
                  <>
                    {/* Indicators keep their status colors on the hover fill. */}
                    <text
                      selectable={false}
                      width={3 + indent()}
                      flexShrink={0}
                      fg={indicator(session())[1]}
                      wrapMode="none"
                    >
                      {/* A nested row's indicator sits under its heading's triangle, beside the title. */}
                      {`${" ".repeat(indent())}${indicator(session())[0].padStart(2)} `}
                    </text>
                    {/* As in the native rail: bright when hovered or current, bold only when current. */}
                    <FadeText
                      text={session().title}
                      fg={lit() || targeted() || current() ? props.colors.text : props.colors.muted}
                      background={background()}
                      bold={current()}
                      scroll={lit()}
                    />
                    {close(() => props.act({ type: "session-remove", sessionID: session().id }))}
                  </>
                )
                return (
                  <box
                    flexDirection={detail() ? "column" : "row"}
                    height={detail() ? 2 : 1}
                    backgroundColor={fill()}
                    onMouseMove={hover}
                    onMouseOver={hover}
                    onMouseOut={out}
                    onMouseDown={down}
                  >
                    <Show when={detail()} fallback={line()}>
                      {(detail) => (
                        <>
                          <box flexDirection="row" height={1}>
                            {line()}
                          </box>
                          {/* Ends where the title does, before the close target and its gap. */}
                          <box flexDirection="row" height={1} paddingLeft={3 + indent()} paddingRight={3}>
                            <FadeText text={detail()} fg={props.colors.detail} background={background()} />
                          </box>
                        </>
                      )}
                    </Show>
                  </box>
                )
              }}
            </For>
            <Show when={below()}>{(height) => <box height={height()} flexShrink={0} />}</Show>
          </box>
        </Show>
      </scrollbox>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} gap={1}>
        <box
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          overflow="hidden"
          onSizeChange={function (this: BoxRenderable) {
            // As the prompt footer sizes its location: measured, then applied after layout.
            const width = this.width
            queueMicrotask(() => setLocationWidth(width))
          }}
        >
          {/* The location rests here; an error or a notice replaces it while it lasts. */}
          <Show
            when={props.error || props.notice}
            fallback={
              <Show when={props.location}>
                {/* Plain text: OpenCode's click menu cannot reach its workspace manager from a focused panel. */}
                {(label) => (
                  <FilePath value={label()} maxWidth={locationWidth()} fg={rgba(props.colors.muted)} />
                )}
              </Show>
            }
          >
            <text
              selectable={false}
              wrapMode="none"
              fg={props.error ? props.colors.error : props.colors.muted}
              onMouseDown={left(props.diagnostics)}
            >
              {props.error ? `! ${props.error}` : (props.notice ?? "")}
            </text>
          </Show>
        </box>
        <text selectable={false} flexShrink={0} onMouseDown={left(props.help)}>
          <span style={{ fg: props.colors.muted }}>?</span>
          <span style={{ fg: props.colors.text }}> help</span>
        </text>
      </box>
      <Show when={menuTarget()}>
        {(target) => (
          <RowMenu
            x={target().x}
            y={target().y}
            items={target().items}
            colors={props.colors.menu}
            close={closeMenu}
            keys={props.menuKeys}
          />
        )}
      </Show>
    </box>
  )
}

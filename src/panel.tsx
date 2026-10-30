import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from "solid-js"
import { RGBA, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  rowDetail,
  rows,
  section,
  unread,
  type Action,
  type Placement,
  type Row,
  type Session,
  type State,
} from "./model"
import { reconcileSelection, rowKey, type SelectionMemory } from "./selection"

/** Muted rows, a hover fill for non-current rows, and a bold current title on the bare surface. */
export type Palette = {
  /** Titles of the hovered or cursor row and of the conversation being viewed. */
  text: string | RGBA
  /** Resting titles and headings. */
  muted: string | RGBA
  /** Secondary line (worktree), dimmer than muted titles. */
  detail: string | RGBA
  /** The panel surface, which overflowing titles fade into. */
  background: string | RGBA
  /** A non-current row under the mouse. Opaque, so titles can fade into it. */
  hover: string | RGBA
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
        attributes={props.bold ? TextAttributes.BOLD : undefined}
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

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export type PanelProps = {
  state: State
  sessions: Session[]
  colors: Palette
  error: string
  loading: boolean
  /** Whether the panel has keyboard focus; clicks while unfocused leave focus where it is. */
  focused: boolean
  act: (action: Action) => void
  /** The conversation this client shows; null on the new-session screen. Defaults to the shared selection. */
  current?: string | null
  /** Open a session; the host then focuses its conversation. */
  open: (session: Session) => void
  refresh: () => void
  close: () => void
  help: () => void
  diagnostics: () => void
  selectionMemory?: SelectionMemory
  keys?: (actions: {
    next: () => void
    previous: () => void
    enter: () => void
    unread: () => void
    place: (placement: Placement) => void
    remove: () => void
    /** Moves the cursor to a row key (see rowKey). */
    reveal: (key: string) => void
  }) => void
}

export function InboxPanel(props: PanelProps) {
  const renderer = useRenderer()
  const restored = props.selectionMemory ? { ...props.selectionMemory } : undefined
  const owner = Symbol("inbox panel")
  if (props.selectionMemory) props.selectionMemory.owner = owner
  const [requested, setRequested] = createSignal<{ key: string }>()
  const [hovered, setHovered] = createSignal<string>()
  let scroll: ScrollBoxRenderable | undefined
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
  function keepVisible() {
    if (!scroll || cursor() < 0 || selection().pending || !scroll.viewport.height) return
    // Use the known row heights: newly reconciled renderables can still have
    // an old/zero layout here, which would incorrectly scroll back to the top.
    const top = items()
      .slice(0, cursor())
      .reduce((sum, row) => sum + (rowDetail(row) ? 3 : 2), 0)
    const bottom = top + (rowDetail(current()!) ? 2 : 1)
    if (top < scroll.scrollTop) scroll.scrollTo(top)
    else if (bottom > scroll.scrollTop + scroll.viewport.height)
      scroll.scrollTo(bottom - scroll.viewport.height)
  }
  let restoring = Boolean(restored && (restored.scrollTop > 0 || restored.index > 0))
  let disposed = false
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
    renderer.off("frame", restoreViewport)
    remember()
  })
  function step(amount: number) {
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
  props.keys?.({
    next: () => step(1),
    previous: () => step(-1),
    enter: () => enter(),
    unread: () => {
      const row = current()
      if (row?.kind === "session")
        props.act(
          unread(row.session, props.state)
            ? { type: "read", sessionID: row.session.id, observed: row.session.idle }
            : { type: "unread", sessionID: row.session.id },
        )
    },
    place: (placement) => {
      const row = current()
      if (row?.kind === "session" && section(row.session, props.state) !== placement)
        props.act({ type: "place", sessionID: row.session.id, placement })
    },
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
  const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key, i) => key === b[i])
  const keys = createMemo(() => items().map(rowKey), [], { equals: sameKeys })
  const entries = createMemo(() => new Map(items().map((row, index) => [rowKey(row), { row, index }])))
  // Animate only for running rows on screen, not every running session the catalog knows.
  const animating = createMemo(() =>
    items().some((row) => row.kind === "session" && (row.session.running || row.session.status === "Queued")),
  )
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (!animating()) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER.length), 80)
    onCleanup(() => clearInterval(timer))
  })
  /** The native rail's left indicator: approval, question, activity, error, or unread. */
  function indicator(session: Session): [string, string | RGBA] {
    if (session.status === "Approval") return ["!", props.colors.attention]
    if (session.status === "Question") return ["?", props.colors.attention]
    if (session.running || session.status === "Queued") return [SPINNER[frame()]!, props.colors.running]
    if (session.status === "Error") return ["×", props.colors.error]
    if (unread(session, props.state)) return ["•", props.colors.unread]
    if (session.attention) return ["~", props.colors.muted]
    return ["", props.colors.muted]
  }
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingRight={1} paddingTop={1}>
      <scrollbox ref={scroll} flexGrow={1} minHeight={0}>
        <Show
          when={items().length}
          fallback={
            <text selectable={false} fg={props.colors.muted} paddingLeft={3}>
              {props.loading ? "Loading…" : "No open projects. Open one with Ctrl+O."}
            </text>
          }
        >
          <box flexDirection="column" gap={1}>
            <For each={keys()}>
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
                const current = () =>
                  key === `session:${props.current === undefined ? props.state.selected : props.current}`
                // The current conversation is bold only; other rows fill only under the mouse.
                const fill = () => (!current() && hovered() === key ? props.colors.hover : undefined)
                const background = () => fill() ?? props.colors.background
                const hover = () => {
                  setHovered(key)
                  // As in native lists, pointing at a row in the focused panel moves the cursor there.
                  if (props.focused && selection().key !== key) setRequested({ key })
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
                      event.stopPropagation()
                      if (lit()) run()
                    }}
                  >
                    {lit() ? "✕" : ""}
                  </text>
                )
                const heading = () => entry().row as Extract<Row, { kind: "heading" }>
                const item = () => entry().row as Extract<Row, { kind: "session" }>
                const session = () => item().session
                const indent = () => (item().depth - 1) * 2
                return (
                  <box
                    flexDirection="column"
                    height={rowDetail(entry().row) ? 2 : 1}
                    backgroundColor={fill()}
                    onMouseMove={hover}
                    onMouseOver={hover}
                    onMouseOut={() => {
                      if (hovered() === key) setHovered(undefined)
                    }}
                    onMouseDown={(event) => {
                      // The host focuses the panel on mouse down; an unfocused click acts without stealing focus.
                      if (!props.focused) event.stopPropagation()
                      setRequested({ key })
                      enter()
                    }}
                  >
                    {key.startsWith("heading:") ? (
                      <box flexDirection="row" height={1} paddingLeft={1 + heading().depth * 2}>
                        <text
                          selectable={false}
                          width={2}
                          flexShrink={0}
                          fg={lit() ? props.colors.text : props.colors.muted}
                        >
                          {heading().closed ? "▸ " : "▾ "}
                        </text>
                        <FadeText
                          text={heading().title}
                          fg={lit() ? props.colors.text : props.colors.muted}
                          background={background()}
                          scroll={lit()}
                        />
                        <Show when={heading().badges}>
                          <text selectable={false} fg={lit() ? props.colors.text : props.colors.muted}>
                            {heading().badges}
                          </text>
                        </Show>
                        {heading().depth === 0
                          ? close(() => props.act({ type: "project-close", project: heading().key }))
                          : null}
                      </box>
                    ) : (
                      <>
                        <box flexDirection="row" height={1}>
                          {/* Indicators keep their status colors on the hover fill. */}
                          <text
                            selectable={false}
                            width={3 + indent()}
                            flexShrink={0}
                            fg={indicator(session())[1]}
                            wrapMode="none"
                          >
                            {`${indicator(session())[0].padStart(2)} ${" ".repeat(indent())}`}
                          </text>
                          {/* As in the native rail: bright when hovered or current, bold only when current. */}
                          <FadeText
                            text={session().title}
                            fg={lit() || current() ? props.colors.text : props.colors.muted}
                            background={background()}
                            bold={current()}
                            scroll={lit()}
                          />
                          {close(() => props.act({ type: "session-remove", sessionID: session().id }))}
                        </box>
                        <Show when={rowDetail(item())}>
                          {(detail) => (
                            // Ends where the title does, before the close target and its gap.
                            <box flexDirection="row" height={1} paddingLeft={3 + indent()} paddingRight={3}>
                              <FadeText text={detail()} fg={props.colors.detail} background={background()} />
                            </box>
                          )}
                        </Show>
                      </>
                    )}
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </scrollbox>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1}>
        <text
          selectable={false}
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
          fg={props.colors.error}
          onMouseDown={props.diagnostics}
        >
          {props.error ? `! ${props.error}` : ""}
        </text>
        <text selectable={false} onMouseDown={props.help}>
          <span style={{ fg: props.colors.muted }}>?</span>
          <span style={{ fg: props.colors.text }}> help</span>
        </text>
      </box>
    </box>
  )
}

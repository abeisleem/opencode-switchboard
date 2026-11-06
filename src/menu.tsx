import { createSignal, For } from "solid-js"
import { BoxRenderable, MouseButton, type RGBA } from "@opentui/core"
import { Portal, useTerminalDimensions } from "@opentui/solid"

/** One menu entry: what it does, and the panel key that does the same. */
export type MenuItem = { label: string; hint: string; run: () => void }

/** The native tab menu's colors: a raised surface, a higher one under the pointer or keyboard. */
export type MenuColors = {
  background: string | RGBA
  selected: string | RGBA
  text: string | RGBA
  hint: string | RGBA
}

/** What the host's `menu` keymap mode drives while the menu is open. */
export type MenuControls = {
  /** The items, each closing the menu before it acts. */
  items: () => MenuItem[]
  close: () => void
  /** Runs the highlighted item, if any. */
  run: () => void
  /** Moves the highlight down (1) or up (-1). */
  move: (delta: 1 | -1) => void
}

const cellWidth = (value: string) => (typeof Bun === "undefined" ? value.length : Bun.stringWidth(value))

/**
 * A right-click menu at the pointer, as OpenCode's tab and diff-file menus: a full-screen overlay closes it on an
 * outside click, a right-click on the menu closes it, and a left mouse up runs an item.
 */
export function RowMenu(props: {
  x: number
  y: number
  items: MenuItem[]
  colors: MenuColors
  close: () => void
  /** Called once while the menu is mounted, to bind its keys; cleanups registered there run when it closes. */
  keys?: (controls: MenuControls) => void
}) {
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal<number>()
  const run = (index: number) => {
    const item = props.items[index]
    if (!item) return
    props.close()
    item.run()
  }
  const items = () => props.items.map((item, index) => ({ ...item, run: () => run(index) }))
  props.keys?.({
    items,
    close: props.close,
    run: () => {
      const index = selected()
      if (index !== undefined) run(index)
    },
    move: (delta) => {
      const count = props.items.length
      if (!count) return
      const index = selected()
      setSelected(index === undefined ? (delta > 0 ? 0 : count - 1) : (index + delta + count) % count)
    },
  })
  // Label, two cells of gap, the key, and a cell of padding on each side.
  const labelWidth = () => Math.max(0, ...props.items.map((item) => cellWidth(item.label)))
  const hintWidth = () => Math.max(0, ...props.items.map((item) => cellWidth(item.hint)))
  const width = () => Math.min(dimensions().width, labelWidth() + 2 + hintWidth() + 2)
  const height = () => Math.min(props.items.length, dimensions().height)
  const top = () => Math.max(0, Math.min(props.y + 1, dimensions().height - height()))
  const left = () => Math.max(0, Math.min(props.x, dimensions().width - width()))
  return (
    <Portal
      ref={(container) => {
        if (!(container instanceof BoxRenderable)) return
        // Portal's wrapper must also escape root flow, not follow the full-height app.
        container.position = "absolute"
        container.left = 0
        container.top = 0
        container.zIndex = 2600
      }}
    >
      <box
        id="switchboard-row-menu-overlay"
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        zIndex={2600}
        onMouseDown={(event) => {
          props.close()
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <box
          id="switchboard-row-menu"
          position="absolute"
          flexDirection="column"
          left={left()}
          top={top()}
          width={width()}
          height={height()}
          backgroundColor={props.colors.background}
          onMouseDown={(event) => {
            if (event.button === MouseButton.RIGHT) props.close()
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <For each={props.items}>
            {(item, index) => (
              <box
                flexDirection="row"
                height={1}
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                gap={2}
                backgroundColor={selected() === index() ? props.colors.selected : undefined}
                onMouseOver={() => setSelected(index())}
                onMouseOut={() => setSelected(undefined)}
                onMouseUp={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (event.button === MouseButton.LEFT) run(index())
                }}
              >
                <text
                  flexGrow={1}
                  minWidth={0}
                  fg={props.colors.text}
                  selectable={false}
                  wrapMode="none"
                  truncate
                >
                  {item.label}
                </text>
                {/* The panel key for the same action, muted and right-aligned as the command palette shows them. */}
                <text flexShrink={0} fg={props.colors.hint} selectable={false} wrapMode="none">
                  {item.hint}
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
    </Portal>
  )
}

import { createSignal, onCleanup } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { InboxPanel, type Palette, type PanelProps } from "./panel"
import type { MenuControls } from "./menu"
import { initialState, reduce, type Session } from "./model"
import { RECONNECTING } from "./error-text"

export function demoSessions(): Session[] {
  return [
    ["inbox", "Inbox panel", "dotfiles", "inbox-panel", "Running", 0],
    ["navigation", "Choose navigation", "dotfiles", "main", "Question", 1],
    ["provider", "Review provider config", "dotfiles", "main", "Ready", 2],
    ["index", "Index project files", "dotfiles", "indexer", "Running", 0],
    ["keys", "Revisit keybindings", "dotfiles", "main", "Ready", 3],
    ["theme", "Theme experiments", "dotfiles", "theme", "Idle", 0],
    ["health", "Check service health", "api-server", "main", "Running", 0],
    ["reconnect", "Diagnose reconnect", "api-server", "main", "Interrupted", 4],
  ].map(([id, title, project, detail, status, idle]) => ({
    id: String(id),
    title: String(title),
    project: String(project),
    projectName: String(project),
    detail: String(detail),
    directory: `/demo/${project}/${detail}`,
    status: status as Session["status"],
    idle: Number(idle),
    viewed: 0,
    running: status === "Running",
  }))
}

export const DEMO_PALETTE = {
  text: "#c0caf5",
  muted: "#737aa2",
  detail: "#545c7e",
  background: "#1f2335",
  hover: "#292e42",
  target: "#313c5c",
  menu: { background: "#1e2030", selected: "#2f334d", text: "#c0caf5", hint: "#737aa2" },
  unread: "#ff9e64",
  attention: "#ff9e64",
  running: "#7aa2f7",
  error: "#f7768e",
} satisfies Palette

/** The demo sessions' projects, with one unread and two parked sessions. */
export function demoState(sessions = demoSessions()) {
  const seed = initialState()
  for (const session of sessions) {
    const project = (seed.projects[session.project] ??= {
      name: session.projectName,
      open: true,
      sessions: [],
    })
    project.sessions.push(session.id)
  }
  seed.sessions = {
    navigation: { placement: "active", unread: true },
    keys: { placement: "parked", unread: true },
    theme: { placement: "parked", unread: false },
  }
  return seed
}

export function Demo(props: { current?: string | null; focused?: boolean } = {}) {
  const renderer = useRenderer()
  const sessions = demoSessions()
  const [state, setState] = createSignal(demoState(sessions))
  // The conversation this demo "shows", as a TUI's route would.
  const [shown, setShown] = createSignal<string | null>("inbox")
  // Footer states to compare: `r` toggles the reconnecting line, `e` an error (which replaces it).
  const [reconnecting, setReconnecting] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  let actions: Parameters<NonNullable<PanelProps["keys"]>>[0]
  // A stand-in for OpenCode's `menu` keymap mode: while a right-click menu is open, keys go to it alone.
  let menu: MenuControls | undefined
  useKeyboard((event) => {
    if (menu) {
      if (event.name === "escape" || (event.ctrl && event.name === "c")) menu.close()
      else if (event.name === "return") menu.run()
      else if (event.name === "down" || event.name === "j") menu.move(1)
      else if (event.name === "up" || event.name === "k") menu.move(-1)
      else
        menu
          .items()
          .find((item) => item.hint === event.name)
          ?.run()
      return
    }
    if (props.focused === false) return
    if (event.name === "down" || event.name === "j") actions.next()
    if (event.name === "up" || event.name === "k") actions.previous()
    if (event.name === "return") actions.enter()
    if (event.name === "left") actions.fold(true)
    if (event.name === "right") actions.fold(false)
    if (event.name === "u") actions.unread()
    if (event.name === "p") actions.park()
    if (event.name === "x") actions.remove()
    if (event.name === "r") setReconnecting(!reconnecting())
    if (event.name === "e") setFailed(!failed())
    if (event.name === "escape" || event.name === "q") renderer.destroy()
  })
  return (
    <box flexDirection="column" width="100%" height="100%">
      <InboxPanel
        state={state()}
        sessions={sessions}
        error={failed() ? "Not saved: no connection to the server" : ""}
        notice={reconnecting() ? RECONNECTING : ""}
        location="~/repos/dotfiles:inbox-panel"
        loading={false}
        focused={props.focused ?? true}
        current={props.current === undefined ? shown() : props.current}
        colors={DEMO_PALETTE}
        act={(action) => setState(reduce(state(), action))}
        open={(session) => {
          setState(
            reduce(
              state(),
              { type: "visit", sessionID: session.id, observed: session.idle },
              { project: session.project, name: session.projectName, sessions: [session.id] },
            ),
          )
          setShown(session.id)
        }}
        close={() => renderer.destroy()}
        help={() => {}}
        diagnostics={() => {}}
        keys={(value) => {
          actions = value
        }}
        menuKeys={(controls) => {
          menu = controls
          onCleanup(() => {
            if (menu === controls) menu = undefined
          })
        }}
      />
    </box>
  )
}

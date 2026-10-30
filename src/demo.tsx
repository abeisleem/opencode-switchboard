import { createSignal } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { InboxPanel, type Palette, type PanelProps } from "./panel"
import { initialState, reduce, type Session } from "./model"

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
  selected: "#1f2335",
  unread: "#ff9e64",
  attention: "#ff9e64",
  running: "#7aa2f7",
  error: "#f7768e",
} satisfies Palette

export function Demo(props: { current?: string | null } = {}) {
  const renderer = useRenderer()
  const sessions = demoSessions()
  const seed = initialState()
  for (const session of sessions) {
    const project = (seed.projects[session.project] ??= {
      name: session.projectName,
      open: true,
      sessions: [],
    })
    project.sessions.push(session.id)
  }
  seed.selected = "inbox"
  seed.recent = ["inbox", "provider"]
  seed.sessions = {
    navigation: { placement: "active", unread: true },
    keys: { placement: "later", unread: true },
    theme: { placement: "later", unread: false },
  }
  const [state, setState] = createSignal(seed)
  let actions: Parameters<NonNullable<PanelProps["keys"]>>[0]
  useKeyboard((event) => {
    if (event.name === "down" || event.name === "j") actions.next()
    if (event.name === "up" || event.name === "k") actions.previous()
    if (event.name === "return") actions.enter()
    if (event.name === "u") actions.unread()
    if (event.name === "a") actions.place("active")
    if (event.name === "l") actions.place("later")
    if (event.name === "x") actions.remove()
    if (event.name === "escape" || event.name === "q") renderer.destroy()
  })
  return (
    <box flexDirection="column" width="100%" height="100%">
      <InboxPanel
        state={state()}
        sessions={sessions}
        error=""
        loading={false}
        focused
        current={props.current}
        colors={DEMO_PALETTE}
        act={(action) => setState(reduce(state(), action))}
        open={(session) =>
          setState(
            reduce(
              state(),
              { type: "select", sessionID: session.id, observed: session.idle },
              { project: session.project, name: session.projectName, sessions: [session.id] },
            ),
          )
        }
        refresh={() => {}}
        close={() => renderer.destroy()}
        help={() => {}}
        diagnostics={() => {}}
        keys={(value) => {
          actions = value
        }}
      />
    </box>
  )
}

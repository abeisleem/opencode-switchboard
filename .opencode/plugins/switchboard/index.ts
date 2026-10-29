// Development entry: OpenCode auto-loads this directory, so the plugin runs from source.
// The published package instead loads `.`/`./tui` from package.json (dist/tui.js).
export { default } from "../../../src/server"

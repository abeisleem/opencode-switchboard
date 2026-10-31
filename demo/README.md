# Demo video

Records the switchboard in a private, throwaway OpenCode and renders the launch video and README GIFs. Nothing
from your own OpenCode setup appears: [opencode-drive](https://www.npmjs.com/package/opencode-drive) gives the
run its own config, database, and home directory, and a simulated model answers every prompt.

This directory is not part of the published package.

## Requirements

- OpenCode 2.2 on `PATH` as `opencode`
- `ffmpeg` on `PATH`
- Bun

## Run

```sh
cd demo
bun install
bun run record   # builds the panel, records ~/.cache/opencode-switchboard-demo/recordings/…
bun run render   # renders the newest recording to out/switchboard.mp4
```

`bun run render path/to/recording-….jsonl` renders a specific recording.

## Files

- `fixture.ts`: the invented projects and sessions, one for every row state the panel draws.
- `record.ts`: seeds the switchboard over its RPC, then plays the scenes at a human pace with real key
  presses. Each scene starts with a recording mark (`open`, `finished`, `later`, …).
- `render.ts`: redraws the recorded terminal at 1080p with a camera that follows the scenes, keycaps for the
  recorded key presses, a caption per mark, and title and end cards.

Recordings live outside the repository because the recording OpenCode reloads the plugin whenever a file under
it changes, which stalls the switchboard mid-take.

`bun run record` drops inherited `OPENCODE_*` variables: when run from inside OpenCode, an inherited
`OPENCODE_CLI_CONFIG_CONTENT` would load that machine's own TUI plugins into the demo.

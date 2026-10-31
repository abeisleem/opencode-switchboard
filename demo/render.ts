// Renders a recording from `record.ts` into the launch video and README GIFs. Run `bun run render`; see README.md.
import { readdirSync, statSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { GlobalFonts, createCanvas, type SKRSContext2D } from "@napi-rs/canvas"
import {
  CellHeight,
  CellWidth,
  DimAlpha,
  TextStyle,
  baselineOffset,
  drawBlockGlyph,
} from "opencode-drive/frame"
import { loadAnnotations, loadKeypresses, replayRecording } from "opencode-drive/recording"

const assets = resolve(import.meta.dir, "node_modules/opencode-drive/assets/fonts")
const MONO = "Commit Mono"
const STACK = `"${MONO}", "Noto Symbols", "Noto Symbols 2", "Noto Math"`
for (const face of ["400-Regular", "700-Regular", "400-Italic", "700-Italic"])
  GlobalFonts.registerFromPath(join(assets, `commit-mono/CommitMono-${face}.otf`), MONO)
GlobalFonts.registerFromPath(join(assets, "noto/NotoSansSymbols.ttf"), "Noto Symbols")
GlobalFonts.registerFromPath(join(assets, "noto/NotoSansSymbols2-Regular.ttf"), "Noto Symbols 2")
GlobalFonts.registerFromPath(join(assets, "noto/NotoSansMath-Regular.ttf"), "Noto Math")

const WIDTH = 1920
const HEIGHT = 1080
const FPS = 30
const out = resolve(import.meta.dir, "out")
/**
 * Where `bun run record` keeps recordings. Outside the repository: the recording OpenCode reloads the plugin
 * whenever a file under it changes, which would stall the switchboard mid-recording.
 */
const recordings = join(homedir(), ".cache/opencode-switchboard-demo/recordings")

/** The newest recording in `out/`, unless a timeline path is given. */
function timeline() {
  if (process.argv[2]) return resolve(process.argv[2])
  const found: { path: string; time: number }[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/^recording-[0-9a-f-]+\.jsonl$/.test(entry.name))
        found.push({ path, time: statSync(path).mtimeMs })
    }
  }
  walk(recordings)
  const newest = found.sort((a, b) => b.time - a.time)[0]
  if (!newest) throw new Error("No recording found; run `bun run record` first")
  return newest.path
}

const color = (value: number | readonly number[], opacity = 1) =>
  typeof value === "number"
    ? `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`
    : `rgba(${value[0]}, ${value[1]}, ${value[2]}, ${(value[3]! / 255) * opacity})`

type Frame = Awaited<ReturnType<typeof replayRecording>>[number]["frame"]

/** Draws a captured terminal frame in its native 10×20 cell geometry; the caller's transform scales it crisply. */
function drawTerminal(context: SKRSContext2D, frame: Frame) {
  context.textAlign = "center"
  context.textBaseline = "alphabetic"
  frame.lines.forEach((line, row) => {
    let column = 0
    for (const span of line.spans) {
      const inverse = Boolean(span.attributes & TextStyle.inverse)
      const y = row * CellHeight
      context.fillStyle = color(inverse ? span.fg : span.bg)
      // Overlap neighbors by a hair so scaled cells leave no seams.
      context.fillRect(column * CellWidth - 0.25, y - 0.25, span.width * CellWidth + 0.5, CellHeight + 0.5)
      if (span.attributes & TextStyle.invisible) {
        column += span.width
        continue
      }
      const italic = span.attributes & TextStyle.italic ? "italic " : ""
      const weight = span.attributes & TextStyle.bold ? "700 " : "400 "
      const font = `${italic}${weight}16px ${STACK}`
      context.font = font
      context.fillStyle = color(inverse ? span.bg : span.fg, span.attributes & TextStyle.dim ? DimAlpha : 1)
      const baseline = baselineOffset(context as never, font)
      let remaining = span.width
      for (const char of span.text) {
        const cells = Math.min(Math.max(1, Bun.stringWidth(char)), remaining)
        const x = column * CellWidth
        if (!drawBlockGlyph(context as never, char, x, y, cells))
          context.fillText(char, x + (cells * CellWidth) / 2, y + baseline, cells * CellWidth)
        if (span.attributes & TextStyle.underline) context.fillRect(x, y + 17, cells * CellWidth, 1)
        column += cells
        remaining -= cells
      }
      column += Math.max(0, remaining)
    }
  })
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

/** A view of the terminal: `zoom` 1 shows it whole; the focus point (0–1) stays fixed on screen as it zooms. */
type Camera = { zoom: number; fx: number; fy: number }
const WIDE: Camera = { zoom: 1, fx: 0.5, fy: 0.5 }
/** Pushed in toward the panel, keeping the right edge and top row in place. */
const PANEL: Camera = { zoom: 1.2, fx: 1, fy: 0 }

/** Eases from one camera to the next over `duration` ms starting at each key's `at`. */
function cameraTrack(keys: { at: number; camera: Camera }[], duration = 750) {
  return (t: number): Camera => {
    let current = keys[0]!.camera
    for (let index = 1; index < keys.length; index++) {
      const key = keys[index]!
      if (t < key.at) break
      const progress = ease(clamp((t - key.at) / duration))
      const from = current
      current = {
        zoom: from.zoom + (key.camera.zoom - from.zoom) * progress,
        fx: from.fx + (key.camera.fx - from.fx) * progress,
        fy: from.fy + (key.camera.fy - from.fy) * progress,
      }
    }
    return current
  }
}
type Keypress = { atMs: number; label: string }
const ARROWS: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→" }

/** The stage backdrop, rendered once. Light noise dithers the gradients so the encoder does not band them. */
const backdrop = (() => {
  const canvas = createCanvas(WIDTH, HEIGHT)
  const context = canvas.getContext("2d")
  const gradient = context.createLinearGradient(0, 0, WIDTH, HEIGHT)
  gradient.addColorStop(0, "#0f1018")
  gradient.addColorStop(1, "#1b1e2e")
  context.fillStyle = gradient
  context.fillRect(0, 0, WIDTH, HEIGHT)
  const glow = context.createRadialGradient(
    WIDTH * 0.78,
    HEIGHT * 0.15,
    0,
    WIDTH * 0.78,
    HEIGHT * 0.15,
    WIDTH * 0.6,
  )
  glow.addColorStop(0, "rgba(122, 162, 247, 0.14)")
  glow.addColorStop(1, "rgba(122, 162, 247, 0)")
  context.fillStyle = glow
  context.fillRect(0, 0, WIDTH, HEIGHT)
  const pixels = context.getImageData(0, 0, WIDTH, HEIGHT)
  let seed = 7
  for (let index = 0; index < pixels.data.length; index += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const noise = ((seed >> 16) % 7) - 3
    pixels.data[index] = clamp(pixels.data[index]! + noise, 0, 255)
    pixels.data[index + 1] = clamp(pixels.data[index + 1]! + noise, 0, 255)
    pixels.data[index + 2] = clamp(pixels.data[index + 2]! + noise, 0, 255)
  }
  context.putImageData(pixels, 0, 0)
  return canvas
})()

function drawBackground(context: SKRSContext2D) {
  context.drawImage(backdrop, 0, 0)
}

/** KeyCastr-style keycaps for the presses of the last 1.2 s, newest last. */
function drawKeys(context: SKRSContext2D, keypresses: Keypress[], t: number) {
  const recent = keypresses.filter((key) => key.atMs <= t && t < key.atMs + 1200).slice(-3)
  if (!recent.length) return
  context.save()
  context.font = `700 30px ${STACK}`
  context.textAlign = "center"
  context.textBaseline = "middle"
  const caps = recent.map((key) => {
    const age = t - key.atMs
    const opacity = clamp(age / 90) * clamp((1200 - age) / 250)
    const scale = 0.85 + 0.15 * ease(clamp(age / 140))
    const parts = key.label.split(" + ").map((part) => ARROWS[part] ?? part)
    return {
      parts,
      opacity,
      scale,
      widths: parts.map((part) => Math.max(64, context.measureText(part).width + 44)),
    }
  })
  const plus = 34
  const gap = 26
  const total =
    caps.reduce(
      (sum, cap) => sum + cap.widths.reduce((a, b) => a + b, 0) + plus * (cap.parts.length - 1),
      0,
    ) +
    gap * (caps.length - 1)
  let x = (WIDTH - total) / 2
  const y = HEIGHT - 118
  const height = 70
  for (const cap of caps) {
    context.globalAlpha = cap.opacity
    cap.parts.forEach((part, index) => {
      const width = cap.widths[index]!
      context.save()
      context.translate(x + width / 2, y + height / 2)
      context.scale(cap.scale, cap.scale)
      context.shadowColor = "rgba(0, 0, 0, 0.55)"
      context.shadowBlur = 24
      context.shadowOffsetY = 8
      context.fillStyle = "rgba(26, 27, 38, 0.92)"
      context.beginPath()
      context.roundRect(-width / 2, -height / 2, width, height, 14)
      context.fill()
      context.shadowColor = "transparent"
      context.strokeStyle = "rgba(192, 202, 245, 0.28)"
      context.lineWidth = 2
      context.stroke()
      context.fillStyle = "#e0e6ff"
      context.fillText(part, 0, 2)
      context.restore()
      x += width
      if (index < cap.parts.length - 1) {
        context.fillStyle = "rgba(192, 202, 245, 0.7)"
        context.fillText("+", x + plus / 2, y + height / 2)
        x += plus
      }
    })
    x += gap
  }
  context.restore()
}

/** The terminal window: rounded, shadowed, with a title bar. Returns the content rectangle. */
const WINDOW = { x: 120, y: 0, width: 1680, bar: 40, radius: 16 }
function drawWindow(context: SKRSContext2D, contentHeight: number, title: string) {
  const { x, width, bar, radius } = WINDOW
  const height = bar + contentHeight
  const y = Math.round((HEIGHT - height) / 2)
  context.save()
  context.shadowColor = "rgba(0, 0, 0, 0.6)"
  context.shadowBlur = 70
  context.shadowOffsetY = 24
  context.fillStyle = "#16161e"
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
  context.fill()
  context.restore()
  for (const [index, fill] of ["#f7768e", "#e0af68", "#9ece6a"].entries()) {
    context.fillStyle = fill
    context.beginPath()
    context.arc(x + 26 + index * 24, y + bar / 2, 7, 0, Math.PI * 2)
    context.fill()
  }
  context.font = `400 18px ${STACK}`
  context.textAlign = "center"
  context.textBaseline = "middle"
  context.fillStyle = "#737aa2"
  context.fillText(title, x + width / 2, y + bar / 2)
  return { x, y: y + bar, width, height: contentHeight }
}

async function main() {
  const path = timeline()
  console.error(`Rendering ${path}`)
  const [samples, marks, keypresses] = await Promise.all([
    replayRecording(path, { fps: 60 }),
    loadAnnotations(path),
    loadKeypresses(path),
  ])
  const at = (label: string) => marks.find((mark) => mark.label === label)?.atMs
  const start = at("open")! - 300
  const end = at("end")! + 600
  const source = (t: number) => start + t
  const sampleAt = (time: number) => {
    let found = samples[0]!
    for (const sample of samples) {
      if (sample.sourceAtMs > time) break
      found = sample
    }
    return found.frame
  }
  const first = samples[0]!.frame
  const terminalWidth = first.cols * CellWidth
  const terminalHeight = first.rows * CellHeight
  const scale = WINDOW.width / terminalWidth
  const contentHeight = terminalHeight * scale

  // One move: a gentle push toward the panel once it opens, held to the end.
  const opened = keypresses.find((key) => key.atMs >= at("open")! && key.label === "I")!.atMs
  const camera = cameraTrack([
    { at: 0, camera: WIDE },
    { at: opened - start + 400, camera: PANEL },
  ])

  const FADE_MS = 400
  const duration = end - start
  const canvas = createCanvas(WIDTH, HEIGHT)
  const context = canvas.getContext("2d")

  function renderBody(target: SKRSContext2D, t: number) {
    const time = source(t)
    drawBackground(target)
    const content = drawWindow(target, contentHeight, "orbit-web — opencode")
    const view = camera(t)
    target.save()
    target.beginPath()
    target.roundRect(content.x, content.y, content.width, content.height, [
      0,
      0,
      WINDOW.radius,
      WINDOW.radius,
    ])
    target.clip()
    const zoom = scale * view.zoom
    // Keep the focus point where it sits in the unzoomed view.
    const focusX = view.fx * terminalWidth
    const focusY = view.fy * terminalHeight
    target.translate(content.x + focusX * scale, content.y + focusY * scale)
    target.scale(zoom, zoom)
    target.translate(-focusX, -focusY)
    drawTerminal(target, sampleAt(time))
    target.restore()
    drawKeys(target, keypresses, time)
  }

  await mkdir(out, { recursive: true })
  const video = join(out, "switchboard.mp4")
  const ffmpeg = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${WIDTH}x${HEIGHT}`,
      "-r",
      String(FPS),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "17",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      video,
    ],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  )
  const frames = Math.ceil((duration / 1000) * FPS)
  for (let index = 0; index < frames; index++) {
    const t = (index / FPS) * 1000
    renderBody(context, t)
    // Short fades from and to black.
    const shade = 1 - clamp(t / FADE_MS) * clamp((duration - t) / FADE_MS)
    if (shade > 0) {
      context.fillStyle = `rgba(0, 0, 0, ${shade})`
      context.fillRect(0, 0, WIDTH, HEIGHT)
    }
    ffmpeg.stdin.write(canvas.data())
    // Wait for ffmpeg to drain the frame; otherwise Bun buffers every 8 MB frame in memory.
    await ffmpeg.stdin.flush()
    if (index % 150 === 0) console.error(`frame ${index}/${frames}`)
  }
  await ffmpeg.stdin.end()
  if ((await ffmpeg.exited) !== 0) throw new Error("ffmpeg failed")
  console.error(`Wrote ${video} (${(duration / 1000).toFixed(1)} s)`)

  // README GIFs: one beat each, cut from the video so they match it frame for frame.
  const videoAt = (time: number) => (time - start) / 1000
  const gifs = [
    // After the push-in settles and the keycap fades, before the first arrow: one 800 ms spinner cycle, so it
    // loops seamlessly.
    { name: "states", from: videoAt(opened + 1250), seconds: 0.8 },
    { name: "later", from: videoAt(at("later")!), to: videoAt(at("unread")!) },
    { name: "unread", from: videoAt(at("unread")!), to: videoAt(at("folded")!) },
    { name: "folded", from: videoAt(at("folded")!), to: videoAt(at("end")!) },
  ]
  for (const gif of gifs) {
    const length = gif.seconds ?? gif.to! - gif.from
    const path = join(out, `switchboard-${gif.name}.gif`)
    const result = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-ss",
      gif.from.toFixed(3),
      "-t",
      length.toFixed(3),
      "-i",
      video,
      "-filter_complex",
      "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
      path,
    ])
    if (result.exitCode !== 0) throw new Error(`GIF ${gif.name}: ${result.stderr.toString()}`)
    console.error(`Wrote ${path} (${length.toFixed(1)} s, ${(Bun.file(path).size / 1e6).toFixed(1)} MB)`)
  }
}

await main()

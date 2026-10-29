import {
  parseColor,
  Renderable,
  RGBA,
  type ColorInput,
  type OptimizedBuffer,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core"
import { extend } from "@opentui/solid"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type Options = RenderableOptions<InboxSpinnerRenderable> & { color?: ColorInput; interval?: number }

/**
 * A one-cell spinner that repaints itself without relayout, like OpenCode's native
 * spinner. Animating by changing text content instead marks layout dirty, so every
 * frame re-measures the whole screen (including long transcripts) and input stalls.
 */
export class InboxSpinnerRenderable extends Renderable {
  private _color: RGBA
  private interval: number
  private index = 0
  private elapsed = 0
  private updatedFrame = -1
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: RenderContext, options: Options = {}) {
    super(ctx, { ...options, width: 1, height: 1 })
    this._color = parseColor(options.color ?? RGBA.defaultForeground())
    this.interval = options.interval ?? 80
  }

  set color(value: ColorInput) {
    this._color = parseColor(value)
    this.requestRender()
  }

  protected override onUpdate(deltaTime: number) {
    const frameId = (this._ctx as { frameId?: number }).frameId ?? 0
    // Count time only across consecutive frames, not idle gaps before the spinner appeared.
    if (this.updatedFrame === frameId - 1) this.elapsed += deltaTime
    this.updatedFrame = frameId
    const steps = Math.floor(this.elapsed / this.interval)
    this.index = (this.index + steps) % SPINNER_FRAMES.length
    this.elapsed -= steps * this.interval
    if (this.timer !== undefined) return
    // A timer requests the next paint; hidden or culled nodes get no onUpdate, so it stops with them.
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.requestRender()
      },
      Math.max(0, this.interval - this.elapsed),
    )
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    buffer.drawText(SPINNER_FRAMES[this.index]!, this.screenX, this.screenY, this._color)
  }

  protected override destroySelf() {
    clearTimeout(this.timer)
    this.timer = undefined
    super.destroySelf()
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    inbox_spinner: typeof InboxSpinnerRenderable
  }
}

extend({ inbox_spinner: InboxSpinnerRenderable })

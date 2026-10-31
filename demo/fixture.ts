// The demo's invented projects and sessions. Every row state the switchboard draws appears here.

export type Behavior =
  /** Finishes with `reply`; unread until someone opens it. */
  | "finished"
  /** Finishes, then the switchboard marks it read. */
  | "read"
  /** Streams a little, then keeps working for the rest of the recording. */
  | "running"
  /** Finishes, then asks the user a question. */
  | "question"
  /** Finishes, then waits for permission to run a command. */
  | "approval"
  /** The model call fails. */
  | "failed"

export type DemoSession = {
  title: string
  prompt: string
  reply: string
  behavior: Behavior
  later?: boolean
  /** Runs in a git worktree of the project with this branch name. */
  worktree?: string
}

export type DemoProject = {
  name: string
  /** Folded in the panel when the video starts. */
  folded?: boolean
  laterFolded?: boolean
  sessions: DemoSession[]
}

/** The session the TUI shows when the video starts. */
export const CURRENT = "Fix flaky checkout test"

export const projects: DemoProject[] = [
  {
    name: "orbit-web",
    laterFolded: true,
    sessions: [
      {
        title: CURRENT,
        prompt: "The checkout e2e test fails about one run in ten. Find out why and fix it.",
        reply:
          "Found it. The test clicked **Pay** before the Stripe iframe finished loading, so the click sometimes " +
          "landed on nothing.\n\n- Wait for the `payment-ready` event instead of a fixed 500 ms sleep\n" +
          "- Ran the suite 200 times: 200 passes\n\nThe flake is gone.",
        behavior: "read",
      },
      {
        title: "Passkey login flow",
        prompt: "Build the passkey login flow on the passkeys branch.",
        reply: "Wiring up `navigator.credentials.get()` and the WebAuthn challenge endpoint…",
        behavior: "running",
        worktree: "passkeys",
      },
      {
        title: "Pick a passkey library",
        prompt: "Which passkey library should we use?",
        reply: "I compared the three maintained options. One decision is yours before I continue.",
        behavior: "question",
      },
      {
        title: "Bump Next.js to 16",
        prompt: "Upgrade Next.js to 16 and fix whatever breaks.",
        reply: "",
        behavior: "failed",
      },
      {
        title: "Polish dark mode",
        prompt: "Tidy up the dark mode colors.",
        reply: "Dark mode now uses the design tokens everywhere. Contrast passes WCAG AA.",
        behavior: "read",
        later: true,
      },
      {
        title: "Audit bundle size",
        prompt: "Why is the main bundle 2 MB?",
        reply:
          "Two culprits: a full `lodash` import and an unused chart library. Removing both saves 1.3 MB.",
        behavior: "finished",
        later: true,
      },
    ],
  },
  {
    name: "nebula-api",
    sessions: [
      {
        title: "Rate-limit the gateway",
        prompt: "Add per-key rate limiting to the API gateway.",
        reply: "Adding a token bucket per API key in Redis. Writing the middleware now…",
        behavior: "running",
      },
      {
        title: "Run DB migration",
        prompt: "Apply the pending migrations to staging.",
        reply: "The migration adds an index on `orders.customer_id`. I need your OK to run it.",
        behavior: "approval",
      },
      {
        title: "Explain the p95 spike",
        prompt: "Why did p95 latency spike at 3 a.m.?",
        reply:
          "The nightly report job held a lock on `orders` for 40 seconds.\n\n" +
          "- p95 jumped from 120 ms to 2.4 s while it ran\n- Moving the job to the read replica fixes it\n\n" +
          "Want me to make that change?",
        behavior: "finished",
      },
    ],
  },
  {
    name: "pixel-forge",
    folded: true,
    sessions: [
      {
        title: "Shader hot reload",
        prompt: "Make shaders reload without restarting.",
        reply: "Watching the shader directory and recompiling on change…",
        behavior: "running",
      },
      {
        title: "Pick a color space",
        prompt: "Which color space should the renderer use?",
        reply: "Linear sRGB or Display P3? I need you to choose.",
        behavior: "question",
      },
      {
        title: "Profile frame drops",
        prompt: "Why does the editor drop frames when zoomed in?",
        reply: "Texture uploads on the main thread. Moved them to a worker: 60 fps again.",
        behavior: "finished",
      },
      {
        title: "Export sprite sheets",
        prompt: "Add sprite sheet export.",
        reply: "Sprite sheets export as PNG plus a JSON atlas.",
        behavior: "finished",
      },
    ],
  },
]

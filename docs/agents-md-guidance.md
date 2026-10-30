# What belongs in AGENTS.md

Research note behind this repo's `AGENTS.md`, from primary sources checked on 2026-10-30. Each claim cites its
source. Items marked **Unverified** could not be confirmed.

## Sources

| Key  | Source                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| [A]  | AGENTS.md convention: https://agents.md                                                                                         |
| [O2] | OpenCode V2, Instructions: https://opencode.ai/v2/docs/instructions/                                                            |
| [O1] | OpenCode V1, Rules: https://opencode.ai/docs/rules/                                                                             |
| [X]  | OpenAI Codex, Custom instructions with AGENTS.md: https://developers.openai.com/codex/guides/agents-md                          |
| [CM] | Claude Code, How Claude remembers your project: https://code.claude.com/docs/en/memory                                          |
| [CB] | Claude Code, Best practices: https://code.claude.com/docs/en/best-practices                                                     |
| [W]  | Author's skill `writing-for-agents` (`~/.agents/skills/writing-for-agents/SKILL.md`, local only). It takes precedence on style. |

## How the file is loaded

- AGENTS.md is plain Markdown with no required fields or headings [A].
- OpenCode V2 loads the global `~/.config/opencode/AGENTS.md`, then every `AGENTS.md` from the workspace up to
  the project root. It combines them and does not resolve conflicts [O2].
- OpenCode V2 recognizes `AGENTS.md` only; it does not fall back to `CLAUDE.md` [O2]. (V1 did [O1].)
- OpenCode V2 notices edits to an upward-discovered `AGENTS.md` during a session and sends an instruction
  update before the next request [O2].
- Codex concatenates files from the project root down to the working directory and stops at 32 KiB by default
  (`project_doc_max_bytes`) [X].
- Claude Code reads `AGENTS.md` when no `CLAUDE.md` or `CLAUDE.local.md` is on the path (v2.1.277 or later)
  [CM].
- Instruction files are context, not enforcement. A rule with zero exceptions belongs in a hook or permission
  setting [CM][CB].

## What to put in it

- It is a "README for agents": build steps, tests, and conventions that would clutter a README [A].
- Commands first. The most useful lines are the exact commands that confirm work: typecheck, tests, and how to
  run a single test file [CB]. OpenCode's `/init` targets build, lint, and test commands, their order, and
  focused verification steps [O1].
- Only what the agent cannot work out from the code: misleading code, decisions that live outside the repo,
  and corrections given twice [CB]. Architecture and setup quirks only where filenames do not show them [O1].
- Leave out architecture and file layout the agent can read itself [CB]. Treat `package.json`, config, and the
  directory tree as the source of truth; restate them only when the lookup is expensive. Cache the unwritten
  convention, the reason behind a choice, and the gotcha no config confesses [W].
- Commit and PR rules, security gotchas, and deployment steps belong here too [A].
- For a rule an agent must apply with judgment, state the behavior, the reason, and the safe path or exception
  [X].

## How to write it

- Short. Claude Code recommends under 200 lines per file; longer files reduce adherence [CM]. Every line costs
  attention on every task [CB][W].
- Concrete and checkable: "Run `npm test` before committing", not "Test your changes" [CM].
- Group related rules under headings and bullets; avoid dense paragraphs [CM]. Keep a concept's rules and
  caveats under one heading (co-location) [W].
- Consistent: contradictory lines make the agent pick one arbitrarily [CM].
- Plain wording. Capitals and "IMPORTANT" mostly cause over-application; a missed line means the file is too
  long [CB].
- State the target behavior. Use a prohibition only as a hard guardrail, paired with the positive target [W].
- One meaning, one place. Do not duplicate the README [A][W].
- Delete no-ops: lines the model already obeys by default [W].
- Treat it as living documentation and prune stale lines [A][W].

## Unverified

- [A] says agents read the nearest `AGENTS.md` and the closest one wins. OpenCode V2 instead combines all
  files without resolving conflicts [O2]. Precedence differs by tool; this repo has one file, so it does not
  matter here.
- [A] says agents run listed test commands automatically. Not confirmed per tool. This repo gates its slow
  checks explicitly instead.
- No byte or line limit is documented for OpenCode V2 [O2].

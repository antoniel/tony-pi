# tony-pi

Personal configuration for the [Pi](https://github.com/earendil-works/pi-coding-agent) coding
agent: extensions, skills, a support script, and config examples.

```bash
git clone https://github.com/antoniel/tony-pi.git
```

This repository is **sanitized for publication**. Everything that can carry private work or
machine-local state — sessions, missions, run history, credentials, model catalogs, caches and
host-specific integrations — is excluded via [`.gitignore`](./.gitignore) and was never committed.
See [Safety & secret policy](#safety--secret-policy).

## Layout

```
.
├── extensions/                 # Pi extensions, auto-loaded from ~/.pi/agent/extensions/*.ts
│   ├── tool-intent-display.ts  # required "intent" label per tool call + rolling transcript ring
│   ├── side-chat.ts            # /side forked side chat in an overlay panel
│   ├── token-rate.ts           # live tokens/second status segment
│   └── orca-*.ts               # (ignored) host-managed Orca integration, not portable
├── skills/                     # Pi skills, discovered from ~/.pi/agent/skills/<name>/SKILL.md
│   ├── multitask/SKILL.md
│   ├── verify-implementation/SKILL.md
│   └── tldraw-offline/SKILL.md # third-party, installed by tldraw Desktop
├── scripts/
│   └── reapply-ring-patch.sh   # companion patch required by tool-intent-display.ts
├── npm/
│   ├── package.json            # declares the pi-subagents dependency
│   └── package-lock.json
├── keybindings.json            # frees ctrl+o for the intent extension
├── settings.example.json       # sanitized settings template (real settings.json is ignored)
└── .gitignore
```

## Safety & secret policy

The default Pi home directory accumulates data that must never be published. This repo treats the
whole directory as **deny by default** and ignores:

| Path | Why |
| --- | --- |
| `sessions/`, `run-history.jsonl` | Full conversations; can quote client code, internal project names, credentials pasted by error. |
| `missions/` | Orchestration state and briefs for private work. |
| `auth.json`, `trust.json`, `models.json` | Provider credentials and tokens. |
| `models-store.json`, `mcp-cache.json`, `cache/` | Generated catalogs/caches, machine-local. |
| `settings.json` | Contains machine-local package paths (e.g. a local `pi-unreal` checkout). Use `settings.example.json`. |
| `extensions/orca-*.ts` | Generated for this machine's Orca install; references host env and tokens. |
| `bin/`, `npm/node_modules/`, `git/` | Machine-specific binaries and downloaded packages. |

Rules of thumb before committing anything new:

1. Never `git add -A` from `~/.pi/agent` without the ignore list in place.
2. Keep credentials in environment variables or `auth.json`, never in extension source.
3. Prefer `$HOME` over absolute `/Users/<name>` paths in skills and scripts.
4. Scan the staged diff for secrets before the first public push:
   `git diff --cached | grep -niE 'sk-|gh[pous]_|Bearer |api[_-]?key|password'`.

## Extensions

### `extensions/tool-intent-display.ts`

Forces the model to describe **what each tool call is for**, then renders a compact transcript.

- Wraps Pi's built-in `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls` tools and adds a
  required `intent` string parameter (1–80 chars). The parameter is display-only: it is stripped
  before the real tool executes.
- Tolerates misspelled intent keys (`inputent`, `intnet`, `Intent`, …) by edit distance / pattern
  matching, so a bad label never fails a call. Keys the tool itself declares are never treated as
  aliases.
- Three detail levels, cycled with **ctrl+o**:
  - `intent` — only the intent line and the tool name;
  - `normal` — the tool's own call/result renderer, collapsed;
  - `extended` — full arguments and output, plus Pi's native tool expansion state.
- **Rolling window ("ring")**: keeps the last `N` items (default 8, counting thinking runs and tool
  calls together, in transcript order) visible; older ones are hidden from the transcript without
  touching the session. User messages and assistant text are never counted or hidden.
  - **ctrl+shift+e** toggles between the ring and the full transcript; the status toast reads
    `Transcript: last N items (thinking + tools)`.
  - `/ring <n>` (e.g. `/ring 4`), `/ring all`, `/ring off` change the window size.
- Tool rows are hidden through normal renderers (`renderShell: "self"` + an empty component).
  Collapsed **thinking** runs are plain `Text` inside Pi's `AssistantMessageComponent`, which no
  extension hook can hide — that requires the companion patch in
  [`scripts/reapply-ring-patch.sh`](#scriptsreapply-ring-patchsh), which makes the component consult
  `globalThis.__piThinkingRing`. Without the patch, tool calls still ring; thinking stays visible.

### `extensions/side-chat.ts`

A forked "side chat" that runs beside the main conversation.

- `/side` forks the current session at the leaf and opens a panel on the right (38% width, needs
  ≥80 columns, TUI mode only).
- `/side tree` lets you pick any entry in the session tree as the fork point.
- `/side close` (or ctrl+/) closes/focuses the panel.
- The fork is created with `SessionManager.createBranchedSession` and served by a child `pi` process
  over `RpcClient` (`--session <forkPath>`), with `PI_SIDE_CHAT_CHILD=1` to prevent recursive side
  chats.
- The panel streams assistant text, shows `tool_execution_start` rows using the tool's `intent`
  argument when present (pairs with `tool-intent-display.ts`), and aborts/cleans up on session
  switch, fork or shutdown.

### `extensions/token-rate.ts`

A status-bar segment with generation speed.

- During streaming: samples generated characters every 500 ms, converts to tokens (~4 chars/token),
  and shows an EWMA-smoothed (0.65) `≈ N tok/s` rate.
- After the message: shows the exact average from `usage.output`.
- Clears itself on session/turn start, errors and aborts.

### Excluded: `extensions/orca-*.ts`

`orca-agent-status.ts`, `orca-prefill.ts` and `orca-titlebar-spinner.ts` integrate with a local Orca
install (env tokens, unix sockets, Windows/WSL bridges). They are host-managed, machine-specific and
therefore ignored — not part of this public repo.

## Skills

Skills live in `~/.pi/agent/skills/<name>/SKILL.md` and are loaded on demand by Pi when the task
matches their description.

- **`multitask`** — turns the assistant into a coordinator that delegates substantial work to
  background worker agents (via the `pi-subagents` package) so long tasks don't block follow-up
  routing. One coherent worker by default; sibling workers only for genuinely independent streams.
- **`verify-implementation`** — a disciplined mode for building an evidence-grounded correctness
  case (intent contract → system facts → obligations → proposed change → reconciliation) before or
  after editing code. Modes: preflight, implement, audit.
- **`tldraw-offline`** — *third-party* skill installed by tldraw Desktop
  (`installed-by:tldraw-desktop-agent-skills`). Operates the user's local tldraw canvas app over its
  local HTTP server (`http://localhost:7236`, port/token from
  `$HOME/Library/Application Support/tldraw/server.json`). Absolute paths were rewritten to `$HOME`
  for portability. It expects the helper `sh "$HOME/skills/tldraw-offline/tq"`, which ships with the
  app, not with this repo.

## Configuration

- **`settings.example.json`** — sanitized template. Copy to `settings.json` (ignored) and adjust.
  The real file adds machine-local entries such as local package checkouts under `packages`.
- **`keybindings.json`** — remaps Pi's `app.tools.expand` to `ctrl+shift+o`, because `ctrl+o` is
  claimed by `tool-intent-display.ts`.
- **`npm/`** — declares the `pi-subagents` dependency used by the `multitask` skill. Install with
  `npm install` inside `npm/`; `node_modules/` stays ignored.

## How the pieces interact

```
                 ctrl+o / ctrl+shift+e / /ring
 tool-intent-display.ts ──────────────┐
        │  adds args.intent            │ requires
        ▼                             ▼
 side-chat.ts shows intent rows   scripts/reapply-ring-patch.sh
        │                             │ patches Pi's AssistantMessageComponent
        │                             ▼
        │                        globalThis.__piThinkingRing
        ▼
 keybindings.json (frees ctrl+o)

 token-rate.ts (independent status segment)
 multitask skill ──uses──► npm/pi-subagents
```

## Install / bootstrap

The repo mirrors the layout of `~/.pi/agent`. Two safe options:

**A. Clone elsewhere and symlink (keeps the live dir intact):**

```bash
git clone <repo-url> ~/dotfiles/pi-agent-config
ln -s ~/dotfiles/pi-agent-config/extensions ~/.pi/agent/extensions
ln -s ~/dotfiles/pi-agent-config/skills     ~/.pi/agent/skills
ln -s ~/dotfiles/pi-agent-config/scripts    ~/.pi/agent/scripts
cp ~/dotfiles/pi-agent-config/settings.example.json ~/.pi/agent/settings.json
```

**B. Clone directly into a fresh Pi home:**

```bash
git clone <repo-url> ~/.pi/agent
cd ~/.pi/agent/npm && npm install
~/.pi/agent/scripts/reapply-ring-patch.sh
cp settings.example.json settings.json   # then edit
```

Restart Pi after installing extensions or applying the patch.

## `scripts/reapply-ring-patch.sh`

Pi renders collapsed thinking blocks inside its bundled `AssistantMessageComponent`, which no
extension hook can reach. This script finds the installed chunk that contains
`thinkingVisibilityOverrides`, backs it up to `<chunk>.ring-orig`, and applies three anchored string
replacements so the component consults `globalThis.__piThinkingRing`.

- Idempotent; prints `already patched` when nothing to do.
- `--restore` puts the backup back.
- **The patch is lost on every `pi update`** — re-run the script afterwards and restart Pi.
- The anchors are tied to a Pi version; if the script reports `anchor found 0 times`, update the
  replacement strings for the new bundle.

## License & attribution

No license has been chosen yet — pick one (e.g. MIT) before publishing.

`skills/tldraw-offline/SKILL.md` is third-party content installed by tldraw Desktop and is included
here only for reference; its license belongs to its authors. All other files are personal
configuration.

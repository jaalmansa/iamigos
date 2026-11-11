# IAmigos

**Your AI coding agents, at a glance.** IAmigos puts a tiny pixel-art critter in the GNOME
top bar for every running **Claude Code** or **OpenCode** session. Each one shows what its
agent is doing right now (working, waiting for your permission, asking you something, done…)
so you can stop switching terminals just to check.

<p align="center">
  <img src="docs/img/topbar.svg" alt="The GNOME top bar with five IAmigos critters and the session menu open" width="780">
</p>

- **One critter per session.** The same project always gets the same character, and a
  second session in that project gets a different colour.
- **Click to jump.** Open the menu and pick a session to focus its terminal window, including
  the right **zellij** or **tmux** tab and pane.
- **No daemon, no network.** The agents write a small JSON file per session; the extension
  watches the folder.

## What each state means

| | State | What you see | When |
|:-:|---|---|---|
| <img src="docs/img/states/idle.svg" width="90" alt="idle"> | **Idle** | Standing still | Session just opened, nothing sent yet |
| <img src="docs/img/states/working.svg" width="90" alt="working"> | **Working** | Hops, white `…` | You sent a prompt; the agent is thinking or running tools |
| <img src="docs/img/states/permission.svg" width="90" alt="permission"> | **Needs permission** | Orange background, blinking `!` | The agent is waiting for you to approve a tool call |
| <img src="docs/img/states/asking.svg" width="90" alt="asking"> | **Asking you** | Brown background, blinking `?` | The agent asked you a question or wants a plan approved |
| <img src="docs/img/states/compacting.svg" width="90" alt="compacting"> | **Compacting** | Shakes, purple `…` | The conversation is being compacted |
| <img src="docs/img/states/done.svg" width="90" alt="done"> | **Done** | Green border, ✓ | The agent finished its turn; your move |
| <img src="docs/img/states/background.svg" width="90" alt="background"> | **Background** | Slow cyan `…` | Turn finished, but a background shell is still running (Claude Code only) |
| <img src="docs/img/states/asleep.svg" width="90" alt="asleep"> | **Asleep** | Eyes closed, floating `z` | Done or idle for 10 minutes without you coming back |
| <img src="docs/img/states/error.svg" width="90" alt="error"> | **Error** | Red border, ✗ | The turn failed (API error, crash…) |
| <img src="docs/img/states/closed.svg" width="90" alt="closed"> | **Closed** | Greyed out, then gone after 30 s | The session ended or its process disappeared |

States come from these agent events:

| State | Claude Code hook | OpenCode event |
|---|---|---|
| Idle | `SessionStart` | `session.created` |
| Working | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`… | `session.status` (busy), `permission.replied`, `question.replied` |
| Needs permission | `PermissionRequest`, `Notification` (permission prompt) | `permission.asked` |
| Asking you | `PreToolUse` for `AskUserQuestion` / `ExitPlanMode`, `Notification` (elicitation) | `question.asked` |
| Compacting | `PreCompact` | `session.next.compaction.started` |
| Done | `Stop` | `session.idle` |
| Error | `StopFailure` | `session.error` |
| Closed | `SessionEnd`, or the process no longer exists | `session.deleted`, or the process no longer exists |

**Background** and **Asleep** are worked out by the extension itself: it looks for live
background shells under the agent's process, and at how long the session has been done.

### The characters

<p align="center">
  <img src="docs/img/characters.svg" alt="The eight characters: blob, robot, michi, seta, pajaro, fantasma, cactus and pulpo">
</p>

Each project gets one of eight characters in one of eight colours, picked from a hash of
its folder.

## Install

Requirements: Linux with **GNOME Shell 48–50**, **Node 18+**, and **python3** (used by the
Claude Code hook).

```bash
npx iamigos install
```

Then **log out and back in**. On Wayland, GNOME only loads new extensions, or new versions
of an extension, at login.

```bash
npx iamigos status              # what is installed and whether GNOME sees it
npx iamigos@latest install      # update (safe to run again at any time)
npx iamigos uninstall
```

`install` does the following:

| What | Where |
|---|---|
| GNOME extension (and marks it enabled) | `~/.local/share/gnome-shell/extensions/iamigos@iamigos` |
| Claude Code hook script | `~/.local/bin/iamigos-hook` |
| Hook registration for each event | `~/.claude/settings.json` (it saves a backup to `settings.json.iamigos.bak` first) |
| OpenCode plugin, if `~/.config/opencode` exists | `~/.config/opencode/plugins/iamigos.ts` |

Your other hooks and settings are left untouched, and `uninstall` removes only what
IAmigos added.

## How it works

```
Claude Code ── hooks/iamigos-hook (python) ─┐
                                             ├─► ~/.local/state/iamigos/sessions/<agent>-<id>.json
OpenCode ───── opencode/iamigos.ts (plugin) ─┘                 │ Gio.FileMonitor
                                                               ▼
                                         gnome-extension/iamigos@iamigos (GJS)
```

The only contract is one JSON file per session, written atomically:

```json
{"v":1,"agent":"claude","id":"…","state":"working","detail":"Bash",
 "cwd":"/home/me/project","project":"project","pid":12345,
 "mux":{"kind":"zellij","session":"work","pane":"1"},
 "started":1731350000.1,"since":1731350100.2,"updated":1731350100.2}
```

- `state`: one of `idle`, `working`, `permission`, `asking`, `compacting`, `done`, `error`, `closed`.
- `detail`: the tool involved, if any (shown in the menu for permission, asking and error).
- `pid`: the agent's process, used to detect crashed sessions and to find its window.
- `mux`: where the session lives inside zellij or tmux, if it does. It is `null` in a plain terminal.

Any other front end, such as an AppIndicator or a macOS or Windows tray app, could read the
same folder.

### Finding the right window

When you click a session, the extension follows the agent's parent processes until it
reaches a window. Inside **zellij** or **tmux** the agent runs under the multiplexer's
server, which is not a child of any window. In that case the extension focuses the terminal
running the multiplexer client and then switches to the session's tab and pane.

If neither works, it falls back to a window whose title contains the project name, and then
to the most recently used terminal.

## Development

```bash
git clone https://github.com/jaalmansa/iamigos && cd iamigos
npm run dev-install          # like install, but symlinks to the repo instead of copying
```

Log out and back in after changing the extension; the hook and the OpenCode plugin are
picked up at once.

| Command | What it does |
|---|---|
| `tools/demo.sh` / `tools/demo.sh --clean` | Creates fake sessions in every state (and removes them) |
| `node tools/readme-images.mjs` | Regenerates the images in `docs/img/` from `sprites.js` |
| `node tools/preview.mjs` | Writes `docs/sprites.html`: every character × state × colour |
| `npm run pack-extension` | Builds the extension zip in `dist/` |
| `journalctl -f -o cat /usr/bin/gnome-shell \| grep -i iamigos` | Shows the extension's logs |

Characters are plain text grids in `gnome-extension/iamigos@iamigos/sprites.js`, so adding
one is a matter of drawing 12×11 characters.

### Releasing

```bash
npm version patch            # bumps package.json, commits and tags vX.Y.Z
git push --follow-tags
```

The `release` GitHub Actions workflow checks that the tag matches `package.json`, publishes
to npm (repository secret `NPM_TOKEN`), and creates a GitHub Release with the extension zip.

## Known limitations

- Linux and GNOME Shell 48–50 only for now.
- The extension's own text (menu labels) is in Spanish.
- zellij 0.43 has no "focus pane by id" action, so IAmigos walks through tabs and panes until
  it finds the right one. You may see them flash for a moment.
- Detecting background shells only works with Claude Code.

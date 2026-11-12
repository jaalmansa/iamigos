import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { basename, join } from "node:path"

// IAmigos — OpenCode plugin.
// Turns session events into states and writes them to
// $XDG_STATE_HOME/iamigos/sessions/opencode-<sessionID>.json

// Where the session lives inside zellij/tmux, so the extension can jump to its pane.
function muxInfo() {
  const e = process.env
  if (e.ZELLIJ_SESSION_NAME && e.ZELLIJ_PANE_ID)
    return { kind: "zellij", session: e.ZELLIJ_SESSION_NAME, pane: e.ZELLIJ_PANE_ID }
  if (e.TMUX && e.TMUX_PANE) return { kind: "tmux", socket: e.TMUX.split(",")[0], pane: e.TMUX_PANE }
  return null
}

// Which terminal tab/pane the session lives in (same as the Claude hook): its TTY on
// macOS (Terminal.app and iTerm2 find the tab by it), WezTerm's pane, kitty's window.
function termInfo() {
  const e = process.env
  const term: Record<string, string> = {}
  if (e.WEZTERM_PANE) term.wezterm_pane = e.WEZTERM_PANE
  if (e.KITTY_WINDOW_ID) {
    term.kitty_window = e.KITTY_WINDOW_ID
    if (e.KITTY_LISTEN_ON) term.kitty_listen = e.KITTY_LISTEN_ON
  }
  if (process.platform === "darwin") {
    const tty = spawnSync("ps", ["-o", "tty=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000 }).stdout?.trim()
    if (tty && tty !== "?" && tty !== "??") term.tty = tty.startsWith("/dev/") ? tty : `/dev/${tty}`
  }
  return Object.keys(term).length ? term : null
}

const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "iamigos", "sessions")

type State = "idle" | "working" | "permission" | "asking" | "compacting" | "done" | "error" | "closed"

type Extra = {
  turn?: "start" | "end"
  tokens?: number
  model?: string
  subagents?: (subs: Sub[]) => Sub[]
}
type Sub = { id: string; type: string; since: number }

export const IAmigosPlugin: Plugin = async ({ directory }) => {
  // Child sessions (subagents): no critter of their own, shown as mini critters of the parent.
  const parentOf = new Map<string, string>()
  const cwd = directory || process.cwd()

  // state = null → only updates the extras and leaves the state as it was.
  const write = (sid: string | undefined, state: State | null, detail = "", extra: Extra = {}) => {
    if (!sid || parentOf.has(sid)) return
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const path = join(STATE_DIR, `opencode-${sid}.json`)
      let prev: Record<string, any> = {}
      try {
        prev = JSON.parse(readFileSync(path, "utf8"))
      } catch {}
      if (!state && !prev.state) return
      const now = Date.now() / 1000
      const st = state ?? prev.state
      const data = {
        v: 1,
        agent: "opencode",
        id: sid,
        state: st,
        detail: state ? detail : (prev.detail ?? ""),
        cwd,
        project: basename(cwd) || "?",
        pid: process.pid,
        mux: prev.mux ?? muxInfo(),
        term: prev.term ?? termInfo(),
        turn_started: extra.turn === "start" ? now : (prev.turn_started ?? null),
        turn_ended: extra.turn === "start" ? null : extra.turn === "end" ? now : (prev.turn_ended ?? null),
        tokens: extra.tokens ?? prev.tokens ?? null,
        model: extra.model ?? prev.model ?? null,
        subagents: extra.subagents ? extra.subagents(prev.subagents ?? []) : (prev.subagents ?? []),
        started: prev.started ?? now,
        since: prev.state !== st ? now : (prev.since ?? now),
        updated: now,
      }
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, path)
    } catch {
      // never break OpenCode because of this
    }
  }

  const prevState = (sid: string) => {
    try {
      return JSON.parse(readFileSync(join(STATE_DIR, `opencode-${sid}.json`), "utf8")).state
    } catch {
      return undefined
    }
  }
  const dropSub = (parent: string, child: string) =>
    write(parent, null, "", { subagents: (s) => s.filter((x) => x.id !== child) })

  return {
    // Tool in use, for the menu.
    "tool.execute.before": async (input) => {
      if (input?.sessionID && !parentOf.has(input.sessionID)) write(input.sessionID, "working", input.tool ?? "")
    },
    event: async ({ event }) => {
      const e = event as { type: string; properties: any }
      const p = e.properties ?? {}
      switch (e.type) {
        case "session.created":
        case "session.updated":
          if (p.info?.parentID) {
            if (!parentOf.has(p.info.id)) {
              parentOf.set(p.info.id, p.info.parentID)
              const sub = { id: p.info.id, type: p.info.title ?? "", since: Date.now() / 1000 }
              write(p.info.parentID, null, "", { subagents: (s) => [...s.filter((x) => x.id !== sub.id), sub] })
            }
          } else if (e.type === "session.created") write(p.info?.id, "idle")
          break
        case "session.status": {
          const parent = parentOf.get(p.sessionID)
          if (parent && p.status?.type === "idle") dropSub(parent, p.sessionID)
          if (p.status?.type === "busy") {
            const fresh = prevState(p.sessionID) !== "working"
            write(p.sessionID, "working", "", fresh ? { turn: "start" } : {})
          } else if (p.status?.type === "retry") write(p.sessionID, "working", p.status.message ?? "retry")
          break
        }
        case "session.idle": {
          const parent = parentOf.get(p.sessionID)
          if (parent) dropSub(parent, p.sessionID)
          write(p.sessionID, "done", "", { turn: "end" })
          break
        }
        case "message.updated": {
          // Context in use = what went into the assistant's last response.
          const m = p.info
          if (m?.role === "assistant" && m.tokens) {
            const tk = m.tokens
            const tokens = (tk.input ?? 0) + (tk.cache?.read ?? 0) + (tk.cache?.write ?? 0)
            if (tokens > 0) write(m.sessionID, null, "", { tokens, model: m.modelID })
          }
          break
        }
        case "permission.asked":
        case "permission.updated":
          write(p.sessionID, "permission", p.title ?? p.permission ?? "")
          break
        case "question.asked":
          write(p.sessionID, "asking")
          break
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
        case "session.compacted":
          write(p.sessionID, "working")
          break
        case "session.next.compaction.started":
          write(p.sessionID, "compacting")
          break
        case "session.error": {
          const name = p.error?.name ?? ""
          if (name === "MessageAbortedError") write(p.sessionID, "done", "aborted")
          else write(p.sessionID, "error", String(p.error?.data?.message ?? name).slice(0, 200))
          break
        }
        case "session.deleted": {
          const parent = parentOf.get(p.info?.id)
          if (parent) dropSub(parent, p.info.id)
          else write(p.info?.id, "closed")
          break
        }
      }
    },
  }
}

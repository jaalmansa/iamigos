import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

// IAmigos — plugin de OpenCode.
// Traduce los eventos de sesión a estados y los escribe en
// $XDG_STATE_HOME/iamigos/sessions/opencode-<sessionID>.json

// Dónde vive la sesión dentro de zellij/tmux, para que la extensión salte a su panel.
function muxInfo() {
  const e = process.env
  if (e.ZELLIJ_SESSION_NAME && e.ZELLIJ_PANE_ID)
    return { kind: "zellij", session: e.ZELLIJ_SESSION_NAME, pane: e.ZELLIJ_PANE_ID }
  if (e.TMUX && e.TMUX_PANE) return { kind: "tmux", socket: e.TMUX.split(",")[0], pane: e.TMUX_PANE }
  return null
}

const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "iamigos", "sessions")

type State = "idle" | "working" | "permission" | "asking" | "compacting" | "done" | "error" | "closed"

export const IAmigosPlugin: Plugin = async ({ directory }) => {
  const children = new Set<string>() // subsesiones (subagentes): no se muestran
  const cwd = directory || process.cwd()

  const write = (sid: string | undefined, state: State, detail = "") => {
    if (!sid || children.has(sid)) return
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const path = join(STATE_DIR, `opencode-${sid}.json`)
      let prev: Record<string, any> = {}
      try {
        prev = JSON.parse(readFileSync(path, "utf8"))
      } catch {}
      const now = Date.now() / 1000
      const data = {
        v: 1,
        agent: "opencode",
        id: sid,
        state,
        detail,
        cwd,
        project: basename(cwd) || "?",
        pid: process.pid,
        mux: prev.mux ?? muxInfo(),
        started: prev.started ?? now,
        since: prev.state !== state ? now : (prev.since ?? now),
        updated: now,
      }
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, path)
    } catch {
      // nunca romper OpenCode por esto
    }
  }

  return {
    event: async ({ event }) => {
      const e = event as { type: string; properties: any }
      const p = e.properties ?? {}
      switch (e.type) {
        case "session.created":
        case "session.updated":
          if (p.info?.parentID) children.add(p.info.id)
          else if (e.type === "session.created") write(p.info?.id, "idle")
          break
        case "session.status":
          if (p.status?.type === "busy") write(p.sessionID, "working")
          else if (p.status?.type === "retry") write(p.sessionID, "working", p.status.message ?? "retry")
          break
        case "session.idle":
          write(p.sessionID, "done")
          break
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
        case "session.deleted":
          write(p.info?.id, "closed")
          break
      }
    },
  }
}

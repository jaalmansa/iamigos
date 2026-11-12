// IAmigos desktop — the session files and what each one shows. The same flow
// as the GNOME extension's _reload()/_refresh(), without the drawing.
// No Electron imports, so it can be tested with Node.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {CLOSED_LINGER, assignLooks, isUrgent, layoutBar, liveSubagents, viewOf} from './shared/view.js';

// Same folder as the agents write to, on every platform.
export function stateDir(env = process.env) {
    return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'iamigos', 'sessions');
}

export class SessionStore {
    // platform: {isAlive(pid), backgroundShells(pid)} (both synchronous)
    constructor(dir, platform) {
        this.dir = dir;
        this.platform = platform;
        this.sessions = new Map();   // file name -> data
        this.goneAt = new Map();     // file name -> when its process died
        this.firstLoad = true;
    }

    // Reads every session file again. On the first read, sessions whose process
    // is already gone are old ones (e.g. from before logging out): they are
    // dropped without showing them as closed.
    reload() {
        const seen = new Set();
        let names = [];
        try {
            names = fs.readdirSync(this.dir).filter(n => n.endsWith('.json'));
        } catch {
            // the folder does not exist yet
        }
        for (const name of names) {
            try {
                this.sessions.set(name, JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')));
                seen.add(name);
            } catch {
                // half-written or corrupt file: ignore it
            }
        }
        for (const name of [...this.sessions.keys()]) {
            if (!seen.has(name))
                this.sessions.delete(name);
        }
    }

    // What to show now. settings: get(key) like Settings.
    // Returns {order, inBar, hidden, rows: Map name -> {s, view, urgent, subs, project, ordinal}}.
    snapshot(now, settings) {
        const shown = {claude: settings.get('show-claude'), opencode: settings.get('show-opencode')};
        const sleepSecs = settings.get('sleep-minutes') * 60;
        const waitSecs = settings.get('long-wait-seconds');
        const names = [];
        const views = new Map();

        for (const [name, s] of this.sessions) {
            if (shown[s.agent] === false)
                continue;
            const alive = s.state === 'closed' || this.platform.isAlive(s.pid);
            if (!alive && !this.goneAt.has(name))
                this.goneAt.set(name, this.firstLoad ? 0 : now);
            const view = viewOf(s, now, {
                alive,
                hasBackground: () => this.platform.backgroundShells(s.pid) > 0,
                sleepSecs,
            });
            if (view === 'closed' && now - (this.goneAt.get(name) ?? s.since) > CLOSED_LINGER) {
                this.forget(name);
                continue;
            }
            views.set(name, view);
            names.push(name);
        }
        this.firstLoad = false;

        const {visible, inBar, hidden} = layoutBar(names, this.sessions, settings.get('max-pets'));
        const looks = assignLooks(inBar, this.sessions);
        const subsOn = settings.get('show-subagents');
        const rows = new Map();
        for (const name of visible) {
            const s = this.sessions.get(name);
            const view = views.get(name);
            rows.set(name, {
                s, view,
                urgent: isUrgent(view, s, now, waitSecs),
                subs: subsOn && view !== 'closed' ? liveSubagents(s, now).length : 0,
                ...(looks.get(name) ?? {project: s.cwd || s.project || s.id, ordinal: 0}),
            });
        }
        return {order: visible, inBar, hidden, rows};
    }

    // A closed session that has been shown long enough: its file goes too.
    forget(name) {
        try {
            fs.unlinkSync(path.join(this.dir, name));
        } catch {
            // already gone
        }
        this.sessions.delete(name);
        this.goneAt.delete(name);
    }
}

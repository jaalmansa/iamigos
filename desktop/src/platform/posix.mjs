// IAmigos desktop — macOS (and Linux, for development): the process table from
// ps, background shells, and jumping to the session's terminal and pane.

import path from 'node:path';

import {TERMINAL_RE, ancestors, backgroundShellCount, jumpToPane, pickMuxClients} from '../shared/procs.js';
import {cachedTable, isAlive, runner} from './common.mjs';

// Apps started from the Dock or at login do not get the shell's PATH: add the
// usual places for tmux and zellij (Homebrew, MacPorts, Nix, ~/.local/bin, cargo).
export function withToolPath(env, home) {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/run/current-system/sw/bin',
        path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.nix-profile', 'bin')];
    const have = (env.PATH ?? '').split(':').filter(Boolean);
    return {...env, PATH: [...have, ...extra.filter(p => !have.includes(p))].join(':')};
}

// `ps -A -o pid=,ppid=,command=` → [{pid, ppid, argv}]. argv is the command split on
// spaces: good enough for the program name and for spotting a shell snapshot.
export function parsePs(out) {
    const procs = [];
    for (const line of (out ?? '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (m)
            procs.push({pid: Number(m[1]), ppid: Number(m[2]), argv: m[3].trim().split(/\s+/).filter(Boolean)});
    }
    return procs;
}

// The .app bundle a process belongs to (/Applications/iTerm.app/Contents/MacOS/iTerm2 → /Applications/iTerm.app).
export function appBundleOf(argv) {
    const cmd = (argv ?? []).join(' ');
    const m = cmd.match(/^(.*?\.app)\/Contents\/MacOS\//);
    return m ? m[1] : null;
}

// The terminal app to bring forward: the first .app among the session's ancestors
// (or the multiplexer client's), else any running terminal app.
export function pickTerminalApp(procs, session) {
    const byPid = new Map(procs.map(p => [p.pid, p]));
    const parentOf = pid => byPid.get(pid)?.ppid ?? 0;
    const chain = [...ancestors(session.pid, parentOf)];
    if (session.mux?.kind) {
        for (const client of pickMuxClients(procs, session.mux.kind))
            chain.push(...ancestors(client, parentOf));
    }
    for (const pid of chain) {
        const app = appBundleOf(byPid.get(pid)?.argv);
        if (app)
            return {pid, app};
    }
    const any = procs.find(p => {
        const app = appBundleOf(p.argv);
        return app && TERMINAL_RE.test(path.basename(app));
    });
    return any ? {pid: any.pid, app: appBundleOf(any.argv)} : null;
}

export function createPosixPlatform({env = process.env, home, isMac = process.platform === 'darwin'} = {}) {
    const run = runner(withToolPath(env, home ?? env.HOME ?? ''));
    const table = cachedTable(async () => {
        const out = await run(['ps', '-A', '-o', 'pid=,ppid=,command=']);
        return out == null ? null : parsePs(out);
    });

    return {
        isAlive,
        backgroundShells: pid => (pid ? backgroundShellCount(table.get(), pid) : 0),
        update: () => table.refresh(),

        async focus(session) {
            const procs = await table.refresh(true);
            const target = pickTerminalApp(procs, session);
            if (target && isMac) {
                // System Events can raise that very process (asks once for Automation
                // permission); `open -a` brings the app forward otherwise.
                const raised = await run(['osascript', '-e',
                    `tell application "System Events" to set frontmost of (first process whose unix id is ${target.pid}) to true`]);
                if (raised == null)
                    await run(['open', '-a', target.app]);
            }
            await jumpToPane(session.mux, run).catch(() => {});
        },
    };
}

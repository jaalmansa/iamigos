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

// AppleScript that selects the tab whose TTY is `tty` in Terminal.app or iTerm2 (null
// for other apps: they have no way to find a tab by TTY).
export function tabScript(app, tty) {
    if (!tty || !/^\/dev\/tty[\w.]+$/.test(tty))
        return null;
    const name = path.basename(app ?? '', '.app');
    if (name === 'Terminal') {
        return ['tell application "Terminal"',
            'repeat with w in windows', 'repeat with t in tabs of w',
            `if tty of t is "${tty}" then`,
            'set selected of t to true', 'set index of w to 1', 'return',
            'end if', 'end repeat', 'end repeat', 'end tell'].join('\n');
    }
    if (name === 'iTerm' || name === 'iTerm2') {
        return ['tell application "iTerm2"',
            'repeat with w in windows', 'repeat with t in tabs of w', 'repeat with s in sessions of t',
            `if tty of s is "${tty}" then`,
            'tell w to select', 'tell t to select', 'tell s to select', 'return',
            'end if', 'end repeat', 'end repeat', 'end repeat', 'end tell'].join('\n');
    }
    return null;
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
                // `set frontmost` only makes the app active: its windows can stay behind
                // others or minimized. So bring the app forward with `open -a` (which also
                // follows it to its Space), then use System Events (asks once for Automation
                // permission) to un-minimize and raise its front window.
                await run(['open', '-a', target.app]);
                const tab = session.mux?.pane ? null : tabScript(target.app, session.term?.tty);
                if (tab)
                    await run(['osascript', '-e', tab]);
                await run(['osascript', '-e', [
                    'tell application "System Events"',
                    `set p to first process whose unix id is ${target.pid}`,
                    'set frontmost of p to true',
                    'try',
                    'set w to window 1 of p',
                    'if value of attribute "AXMinimized" of w is true then set value of attribute "AXMinimized" of w to false',
                    'perform action "AXRaise" of w',
                    'end try',
                    'end tell',
                ].join('\n')]);
            }
            await jumpToPane(session.mux, run, session.term).catch(() => {});
        },
    };
}

// IAmigos — finding a session's window and pane from a table of processes.
// No GNOME imports: each platform builds the table its own way (/proc, ps,
// Win32_Process) and the rules are shared, and tested with Node.
//
// A process is {pid, ppid, argv} (argv: array of strings, may be empty).

// Window classes / process names that are terminals or editors with one.
export const TERMINAL_RE = /alacritty|kitty|ghostty|wezterm|foot|konsole|tilix|ptyxis|terminal|warp|iterm|code|cursor|zed/i;

const baseName = p => String(p ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '');

// The session's process and its ancestors (at most 16 levels).
export function ancestors(pid, parentOf) {
    const set = new Set();
    for (let p = pid, i = 0; p > 1 && i < 16; p = parentOf(p), i++)
        set.add(p);
    return set;
}

// Under zellij/tmux the agent runs under a server that is not a child of the
// terminal: the right window is the one running a client of that multiplexer.
// The server (zellij --server, or the daemonized tmux) has no window among its
// ancestors, so including tmux's does no harm.
export function pickMuxClients(procs, kind) {
    return procs
        .filter(p => p.argv?.length && baseName(p.argv[0]) === kind && !p.argv.includes('--server'))
        .map(p => p.pid);
}

// A shell Claude Code left running after its turn (background Bash): it sources
// a shell snapshot. MCP servers are children of claude too, but do not look like that.
export function isBackgroundShell(cmdline) {
    return /[\\/]\.claude[\\/]shell-snapshots[\\/]/.test(cmdline);
}

export function backgroundShellCount(procs, pid) {
    return procs.filter(p => p.ppid === pid && isBackgroundShell((p.argv ?? []).join(' '))).length;
}

// zellij 0.43 has no "focus pane by id", so walk through it: every tab and,
// inside it, focus-next-pane until list-clients shows the pane.
// `run(argv)` runs a command and resolves to its stdout, or null if it fails.
async function zellijFocusPane(run, session, pane) {
    const z = (...args) => run(['zellij', '-s', session, 'action', ...args]);
    const focused = async () => ((await z('list-clients')) ?? '').split('\n')[1]?.split(/\s+/)[1];
    const target = `terminal_${pane}`;

    if (await focused() === target)
        return;
    const tabs = ((await z('query-tab-names')) ?? '').split('\n').filter(Boolean).length;
    for (let t = 1; t <= tabs; t++) {
        await z('go-to-tab', String(t));
        const first = await focused();
        let cur = first;
        for (let i = 0; i < 30; i++) {
            if (cur === target)
                return;
            await z('focus-next-pane');
            cur = await focused();
            if (cur === first)
                break;              // went all the way round the tab
        }
    }
}

async function tmuxFocusPane(run, socket, pane) {
    await run(['tmux', '-S', socket, 'switch-client', '-t', pane]);
    await run(['tmux', '-S', socket, 'select-window', '-t', pane, ';', 'select-pane', '-t', pane]);
}

// Jumps to the zellij/tmux pane the session lives in (does nothing outside them).
export function jumpToPane(mux, run) {
    if (!mux?.pane)
        return Promise.resolve();
    if (mux.kind === 'zellij' && mux.session)
        return zellijFocusPane(run, mux.session, String(mux.pane));
    if (mux.kind === 'tmux' && mux.socket)
        return tmuxFocusPane(run, mux.socket, String(mux.pane));
    return Promise.resolve();
}

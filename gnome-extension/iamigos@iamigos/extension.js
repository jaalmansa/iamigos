// IAmigos — GNOME Shell extension.
// Shows a pixel-art critter in the top bar for every running Claude Code or
// OpenCode session, reading the JSON files their hooks write.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    CHARACTERS, BADGES, SPRITE_W, SPRITE_H,
    makePalette, greyPalette, pickLook, lowestEyeRows, shade,
} from './sprites.js';
import {setLanguage, t} from './i18n.js';

const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'iamigos', 'sessions']);

// Everything else (size, timings, language…) comes from the preferences (GSettings).
const CLOSED_LINGER = 30;      // s a closed session stays visible before it is removed
const TICK_MS = 200;           // animation
const REFRESH_EVERY = 25;      // ticks between process checks (5 s)
const SUBAGENT_STALE = 3 * 3600; // s: a subagent with no SubagentStop for this long is considered gone
const MAX_MINIS = 4;           // most subagent mini critters drawn

const AGENT_LABELS = {claude: 'Claude', opencode: 'OpenCode'};

const TERMINAL_RE = /alacritty|kitty|ghostty|wezterm|foot|konsole|tilix|ptyxis|terminal|warp|code|cursor|zed/i;

const decoder = new TextDecoder();

function parentPid(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        const txt = decoder.decode(bytes);
        return parseInt(txt.slice(txt.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {
        return 0;
    }
}

function ancestors(pid) {
    const set = new Set();
    for (let p = pid, i = 0; p > 1 && i < 16; p = parentPid(p), i++)
        set.add(p);
    return set;
}

// Shells Claude Code leaves running after the turn ends (background Bash).
// They are direct children of claude that source a shell snapshot; MCP servers
// are children of claude too, but do not look like that.
function backgroundShells(pid) {
    if (!pid)
        return 0;
    const kids = [];
    try {
        const tasks = Gio.File.new_for_path(`/proc/${pid}/task`)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = tasks.next_file(null))) {
            const [, bytes] = GLib.file_get_contents(`/proc/${pid}/task/${info.get_name()}/children`);
            kids.push(...decoder.decode(bytes).trim().split(/\s+/).filter(Boolean));
        }
        tasks.close(null);
    } catch {
        return 0;
    }
    return kids.filter(k => readCmdline(k).join(' ').includes('/.claude/shell-snapshots/')).length;
}

function isAlive(pid) {
    return !pid || GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
}

function formatAge(secs) {
    if (secs < 60)
        return `${Math.floor(secs)} s`;
    if (secs < 3600)
        return `${Math.floor(secs / 60)} min`;
    return `${Math.floor(secs / 3600)} h ${Math.floor(secs % 3600 / 60)} min`;
}

function formatTokens(n) {
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3)
        return `${Math.round(n / 1e3)}k`;
    return String(n);
}

// Git branch of a folder, reading .git/HEAD directly (without running git).
// Also works for worktrees, where .git is a "gitdir: …" file.
function gitBranch(cwd) {
    let dir = cwd;
    for (let i = 0; dir && i < 40; i++) {
        const dotGit = GLib.build_filenamev([dir, '.git']);
        try {
            let gitDir = dotGit;
            if (GLib.file_test(dotGit, GLib.FileTest.IS_REGULAR)) {
                const [, raw] = GLib.file_get_contents(dotGit);
                const target = decoder.decode(raw).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
                if (!target)
                    return null;
                gitDir = GLib.path_is_absolute(target) ? target : GLib.build_filenamev([dir, target]);
            } else if (!GLib.file_test(dotGit, GLib.FileTest.IS_DIR)) {
                const parent = GLib.path_get_dirname(dir);
                dir = parent === dir ? null : parent;
                continue;
            }
            const [, head] = GLib.file_get_contents(GLib.build_filenamev([gitDir, 'HEAD']));
            const txt = decoder.decode(head).trim();
            return txt.startsWith('ref: refs/heads/') ? txt.slice(16) : txt.slice(0, 7);
        } catch {
            return null;
        }
    }
    return null;
}

// Live subagents of a session (very old entries are ignored).
function liveSubagents(s, now) {
    return (Array.isArray(s.subagents) ? s.subagents : [])
        .filter(x => x && (!x.since || now - x.since < SUBAGENT_STALE));
}

function readCmdline(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        return decoder.decode(bytes).split('\0').filter(Boolean);
    } catch {
        return [];
    }
}

// Under zellij/tmux the agent runs under a server that is a child of systemd,
// not of the terminal: the right window is the one running a client of that multiplexer.
function muxClientPids(kind) {
    const out = [];
    const dir = Gio.File.new_for_path('/proc');
    const it = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = it.next_file(null))) {
        const pid = parseInt(info.get_name());
        if (!pid)
            continue;
        const argv = readCmdline(pid);
        if (!argv.length || GLib.path_get_basename(argv[0]) !== kind)
            continue;
        // The server (zellij --server, or the daemonized tmux) is a child of systemd:
        // none of its ancestors is a window, so it does no harm.
        if (argv.includes('--server'))
            continue;
        out.push(pid);
    }
    it.close(null);
    return out;
}

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Runs a command without blocking GNOME Shell; returns its stdout, or null if it fails.
async function run(argv) {
    try {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [out] = await proc.communicate_utf8_async(null, null);
        return proc.get_successful() ? out : null;
    } catch {
        return null;
    }
}

// zellij 0.43 has no "focus pane by id", so walk through it: every tab and,
// inside it, focus-next-pane until list-clients shows the pane.
async function zellijFocusPane(session, pane) {
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

async function tmuxFocusPane(socket, pane) {
    await run(['tmux', '-S', socket, 'switch-client', '-t', pane]);
    await run(['tmux', '-S', socket, 'select-window', '-t', pane, ';', 'select-pane', '-t', pane]);
}

// Jumps to the zellij/tmux pane the session lives in.
function jumpToPane(mux) {
    if (!mux?.pane)
        return;
    const job = mux.kind === 'zellij' && mux.session ? zellijFocusPane(mux.session, String(mux.pane))
        : mux.kind === 'tmux' && mux.socket ? tmuxFocusPane(mux.socket, String(mux.pane))
        : null;
    job?.catch(e => console.warn(`[IAmigos] could not jump to the pane: ${e.message}`));
}

// Finds the session's window: by PID (or by the zellij/tmux client), by title,
// or else the most recent terminal. Then jumps to the multiplexer pane.
function focusSession(session) {
    const wins = global.get_window_actors()
        .map(a => a.meta_window)
        .filter(w => w && !w.skip_taskbar)
        .sort((a, b) => b.get_user_time() - a.get_user_time());

    const mux = session.mux;
    const anc = ancestors(session.pid);
    if (mux?.kind)
        muxClientPids(mux.kind).forEach(p => ancestors(p).forEach(a => anc.add(a)));

    const inTree = wins.filter(w => anc.has(w.get_pid()));
    const muxName = (mux?.session || '').toLowerCase();
    const project = (session.project || '').toLowerCase();
    const titled = text => text && (w => (w.get_title() || '').toLowerCase().includes(text));
    const win =
        (muxName && inTree.find(titled(muxName))) ??
        inTree[0] ??
        (project && wins.find(titled(project))) ??
        wins.find(w => TERMINAL_RE.test(w.get_wm_class() || ''));

    if (win)
        Main.activateWindow(win);
    jumpToPane(mux);
}

const Pet = GObject.registerClass(
class IAmigosPet extends St.Bin {
    _init(project, ordinal, pixel) {
        super._init({style_class: 'iamigos-pet', y_align: Clutter.ActorAlign.CENTER});

        this._grey = greyPalette();
        this._view = null;
        this._urgent = false;
        this._subs = 0;
        this.frame = 0;
        this.setLook(project, ordinal);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._px = pixel * scale;
        this._mpx = Math.max(1, Math.floor(pixel / 2)) * scale;   // pixel of the mini critters
        const height = (SPRITE_H + 1) * this._px;
        this._miniRows = Math.max(1, Math.floor((height + this._mpx) / ((SPRITE_H + 1) * this._mpx)));

        this._area = new St.DrawingArea({width: (SPRITE_W + 3) * this._px, height});
        this._area.connect('repaint', area => this._paint(area));
        this._mini = new St.DrawingArea({width: 0, height, visible: false});
        this._mini.connect('repaint', area => this._paintMinis(area));

        const box = new St.BoxLayout();
        box.add_child(this._area);
        box.add_child(this._mini);
        this.set_child(box);
    }

    // Same project → same critter. The 2nd, 3rd… session of a project changes colour.
    setLook(project, ordinal) {
        if (project === this._project && ordinal === this._ordinal)
            return;
        this._project = project;
        this._ordinal = ordinal;
        const look = pickLook(project, ordinal);
        this._grid = shade(CHARACTERS[look.character]);
        this._eyeRows = lowestEyeRows(this._grid);
        this._palette = makePalette(look.hue);
        this._area?.queue_repaint();
        this._mini?.queue_repaint();
    }

    setView(view, urgent) {
        if (view === this._view && urgent === this._urgent)
            return;
        if (this._view)
            this.remove_style_class_name(this._view);
        this._view = view;
        this.add_style_class_name(view);
        this._urgent = urgent;
        if (urgent)
            this.add_style_class_name('urgent');
        else
            this.remove_style_class_name('urgent');
        this._area.queue_repaint();
        this._mini.queue_repaint();
    }

    // Number of live subagents: drawn as mini critters on the right.
    setSubagents(n) {
        n = Math.min(n, MAX_MINIS);
        if (n === this._subs)
            return;
        this._subs = n;
        const cols = Math.ceil(n / this._miniRows);
        this._mini.width = cols * (SPRITE_W + 1) * this._mpx;
        this._mini.visible = n > 0;
        this._mini.queue_repaint();
    }

    tick(frame) {
        this.frame = frame;
        if (this._urgent || ['working', 'compacting', 'background', 'asleep', 'permission', 'asking'].includes(this._view))
            this._area.queue_repaint();
        if (this._subs)
            this._mini.queue_repaint();
    }

    _sprite(cr, px, ox, oy, pal, alpha, eyesClosed) {
        this._grid.forEach((row, y) => {
            [...row].forEach((ch, x) => {
                if (ch === '.')
                    return;
                let key = ch;
                if (ch === 'e' && eyesClosed)
                    key = this._eyeRows[x] === y ? 'd' : 'b';
                const rgb = pal[key];
                cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], alpha);
                cr.rectangle((ox + x) * px, (oy + y) * px, px, px);
                cr.fill();
            });
        });
    }

    _paint(area) {
        const cr = area.get_context();
        const px = this._px;
        const view = this._view;
        const f = this.frame;
        const pal = view === 'closed' ? this._grey : this._palette;
        const alpha = view === 'closed' ? 0.6 : 1;
        const eyesClosed = view === 'asleep' || view === 'closed';

        let ox = 0, oy = 1;
        if (view === 'working' && f % 4 < 2)
            oy = 0;                         // hops
        if (view === 'compacting' || this._urgent)
            ox = f % 2;                     // shakes (compacting, or waiting for too long)

        const dot = (x, y, rgb, a = 1) => {
            cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], a);
            cr.rectangle(x * px, y * px, px, px);
            cr.fill();
        };

        this._sprite(cr, px, ox, oy, pal, alpha, eyesClosed);

        // State indicator in the top right corner.
        const cols = SPRITE_W + 3;
        if (view === 'working' || view === 'compacting' || view === 'background') {
            const rgb = {working: [1, 1, 1], compacting: [0.75, 0.6, 1], background: [0.35, 0.8, 1]}[view];
            const n = Math.floor(f / (view === 'background' ? 4 : 2)) % 4;
            for (let i = 0; i < n; i++)
                dot(cols - 5 + i * 2, 0, rgb);
        } else if (BADGES[view]) {
            const badge = BADGES[view];
            const rgb = makePalette(badge.color).b;
            const w = badge.rows[0].length;
            const lift = view === 'asleep' ? Math.floor(f / 5) % 2 : 0;
            // Blinks; twice as fast when it has been waiting for too long.
            const blink = (view === 'permission' || view === 'asking') &&
                (this._urgent ? f % 2 : Math.floor(f / 3) % 2);
            if (!blink) {
                badge.rows.forEach((row, y) => {
                    [...row].forEach((ch, x) => {
                        if (ch === 'x')
                            dot(cols - w + x, y + 1 - lift, rgb);
                    });
                });
            }
        }

        cr.$dispose();
    }

    // Mini critters: the same character, smaller, hopping out of step.
    _paintMinis(area) {
        const cr = area.get_context();
        const px = this._mpx;
        for (let i = 0; i < this._subs; i++) {
            const col = Math.floor(i / this._miniRows), row = i % this._miniRows;
            const hop = (this.frame + i * 2) % 4 < 2 ? 0 : 1;
            this._sprite(cr, px, col * (SPRITE_W + 1), row * (SPRITE_H + 1) + hop, this._palette, 0.9, false);
        }
        cr.$dispose();
    }
});

const Indicator = GObject.registerClass(
class IAmigosIndicator extends PanelMenu.Button {
    _init(settings, openPrefs) {
        super._init(0.5, 'IAmigos', false);
        this._settings = settings;
        this._openPrefs = openPrefs;

        this._box = new St.BoxLayout({style_class: 'iamigos-box'});
        this.add_child(this._box);
        this._more = new St.Label({style_class: 'iamigos-more', y_align: Clutter.ActorAlign.CENTER, visible: false});

        this._sessions = new Map();   // file name -> data
        this._pets = new Map();       // file name -> Pet
        this._goneAt = new Map();     // file name -> when its process died
        this._views = new Map();      // file name -> state shown
        this._frame = 0;

        // Settings: a new size means rebuilding the critters; anything else, a refresh.
        this._settingsIds = [
            settings.connect('changed::pixel-size', () => this._clearPets()),
            settings.connect('changed::language', () => {
                setLanguage(settings.get_string('language'));
                this._refresh();
            }),
            settings.connect('changed', () => this._refresh()),
        ];

        GLib.mkdir_with_parents(STATE_DIR, 0o755);
        this._dir = Gio.File.new_for_path(STATE_DIR);
        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._scheduleReload());

        this.menu.actor.add_style_class_name('iamigos-menu');
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._buildMenu();
        });

        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._frame++;
            for (const pet of this._pets.values())
                pet.tick(this._frame);
            if (this._frame % REFRESH_EVERY === 0)
                this._refresh();
            return GLib.SOURCE_CONTINUE;
        });

        // On the first read, sessions whose process is already gone are old ones
        // (e.g. from before logging out): drop them without showing them as closed.
        this._firstLoad = true;
        this._reload();
        this._firstLoad = false;
    }

    _scheduleReload() {
        if (this._reloadId)
            return;
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._reloadId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reload() {
        const seen = new Set();
        try {
            const en = this._dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                if (!name.endsWith('.json'))
                    continue;
                try {
                    const [, bytes] = this._dir.get_child(name).load_contents(null);
                    this._sessions.set(name, JSON.parse(decoder.decode(bytes)));
                    seen.add(name);
                } catch {
                    // half-written or corrupt file: ignore it
                }
            }
            en.close(null);
        } catch (e) {
            console.warn(`[IAmigos] could not read ${STATE_DIR}: ${e.message}`);
        }
        for (const name of [...this._sessions.keys()]) {
            if (!seen.has(name))
                this._sessions.delete(name);
        }
        this._refresh();
    }

    _clearPets() {
        for (const pet of this._pets.values())
            pet.destroy();
        this._pets.clear();
        this._refresh();
    }

    _viewOf(name, s, now) {
        let view = s.state;
        if (view !== 'closed' && !isAlive(s.pid)) {
            if (!this._goneAt.has(name))
                this._goneAt.set(name, this._firstLoad ? 0 : now);
            view = 'closed';
        }
        if ((view === 'done' || view === 'idle') && s.agent === 'claude' && backgroundShells(s.pid) > 0)
            view = 'background';   // turn finished, but something is still running
        const sleep = this._settings.get_int('sleep-minutes') * 60;
        if ((view === 'done' || view === 'idle') && sleep > 0 && now - s.since > sleep)
            view = 'asleep';
        return view;
    }

    // Has been waiting for your permission or answer for too long.
    _isUrgent(view, s, now) {
        const wait = this._settings.get_int('long-wait-seconds');
        return wait > 0 && (view === 'permission' || view === 'asking') && now - s.since > wait;
    }

    _refresh() {
        const now = Date.now() / 1000;
        const visible = [];

        const shown = {
            claude: this._settings.get_boolean('show-claude'),
            opencode: this._settings.get_boolean('show-opencode'),
        };
        for (const [name, s] of this._sessions) {
            if (shown[s.agent] === false)
                continue;
            const view = this._viewOf(name, s, now);
            if (view === 'closed') {
                const closedAt = this._goneAt.get(name) ?? s.since;
                if (now - closedAt > CLOSED_LINGER) {
                    this._forget(name);
                    continue;
                }
            }
            this._views.set(name, view);
            visible.push(name);
        }

        visible.sort((a, b) => (this._sessions.get(a).started ?? 0) - (this._sessions.get(b).started ?? 0));

        // With more sessions than the maximum, the last ones are grouped into "+N".
        const max = this._settings.get_int('max-pets');
        const inBar = max > 0 ? visible.slice(0, max) : visible;
        const hidden = visible.length - inBar.length;
        const subsOn = this._settings.get_boolean('show-subagents');
        const pixel = this._settings.get_int('pixel-size');

        for (const [name, pet] of this._pets) {
            if (!inBar.includes(name)) {
                pet.destroy();
                this._pets.delete(name);
            }
        }
        const perProject = new Map();
        inBar.forEach((name, i) => {
            const s = this._sessions.get(name);
            const project = s.cwd || s.project || s.id;
            const ordinal = perProject.get(project) ?? 0;
            perProject.set(project, ordinal + 1);

            let pet = this._pets.get(name);
            if (!pet) {
                pet = new Pet(project, ordinal, pixel);
                this._pets.set(name, pet);
                this._box.add_child(pet);
            }
            pet.setLook(project, ordinal);
            this._box.set_child_at_index(pet, i);
            const view = this._views.get(name);
            pet.setView(view, this._isUrgent(view, s, now));
            pet.setSubagents(subsOn && view !== 'closed' ? liveSubagents(s, now).length : 0);
        });

        if (this._more.get_parent() !== this._box)
            this._box.add_child(this._more);
        this._box.set_child_at_index(this._more, inBar.length);
        this._more.text = `+${hidden}`;
        this._more.visible = hidden > 0;

        this.visible = visible.length > 0;
        this._order = visible;

        // GNOME does not open an empty menu (PopupMenu.open() returns if isEmpty()),
        // so it has to be built before the click; it is rebuilt on open to update the
        // ages. While open it is left alone, so it does not flicker.
        if (!this.menu.isOpen)
            this._buildMenu();
    }

    _forget(name) {
        try {
            this._dir.get_child(name).delete(null);
        } catch {
            // already gone: nothing to delete
        }
        this._sessions.delete(name);
        this._goneAt.delete(name);
        this._views.delete(name);
    }

    _buildMenu() {
        this.menu.removeAll();
        const now = Date.now() / 1000;
        const names = this._order ?? [];
        const details = this._settings.get_boolean('menu-details');

        if (!names.length)
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(t('menu.empty'), {reactive: false}));

        for (const name of names) {
            const s = this._sessions.get(name);
            if (s)
                this.menu.addMenuItem(this._sessionItem(s, this._views.get(name) ?? s.state, now, details));
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem(t('menu.preferences'));
        prefs.connect('activate', () => this._openPrefs());
        this.menu.addMenuItem(prefs);
    }

    // One session: "project · state · age" and, below, the details.
    _sessionItem(s, view, now, details) {
        const item = new PopupMenu.PopupBaseMenuItem();
        const text = new St.BoxLayout({vertical: true, x_expand: true});

        const why = s.detail && ['permission', 'asking', 'error'].includes(view) ? ` (${s.detail})` : '';
        const urgent = this._isUrgent(view, s, now) ? '⚠ ' : '';
        const title = new St.Label({
            text: `${urgent}${s.project}  ·  ${t(`state.${view}`)}${why}  ·  ${formatAge(now - s.since)}`,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);

        if (details) {
            const line = this._details(s, view, now);
            if (line) {
                const sub = new St.Label({text: line, style_class: 'iamigos-details'});
                sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                text.add_child(sub);
            }
        }
        item.add_child(text);

        item.add_child(new St.Label({
            text: AGENT_LABELS[s.agent] ?? s.agent,
            style_class: 'iamigos-agent-tag',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        item.connect('activate', () => focusSession(s));
        return item;
    }

    // Tool · turn · branch · context · subagents (whatever is known).
    _details(s, view, now) {
        const parts = [];
        if (view === 'working' && s.detail)
            parts.push(s.detail);
        if (s.turn_started) {
            if (view === 'working' || view === 'compacting' || view === 'permission' || view === 'asking')
                parts.push(t('menu.turn', formatAge(now - s.turn_started)));
            else if (s.turn_ended && s.turn_ended >= s.turn_started)
                parts.push(t('menu.lastTurn', formatAge(s.turn_ended - s.turn_started)));
        }
        const branch = s.cwd ? gitBranch(s.cwd) : null;
        if (branch)
            parts.push(`⎇ ${branch}`);
        if (s.tokens) {
            const model = s.model ? ` (${String(s.model).replace(/^claude-/, '')})` : '';
            parts.push(t('menu.tokens', formatTokens(s.tokens)) + model);
        }
        const subs = liveSubagents(s, now);
        if (subs.length && view !== 'closed') {
            const kinds = [...new Set(subs.map(x => x.type).filter(Boolean))].join(', ');
            parts.push((subs.length === 1 ? t('menu.subagent') : t('menu.subagents', subs.length)) + (kinds ? `: ${kinds}` : ''));
        }
        return parts.join('  ·  ');
    }

    destroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._tickId = this._reloadId = 0;
        this._monitor?.cancel();
        this._monitor = null;
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;
        super.destroy();
    }
});

export default class IAmigosExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        setLanguage(this._settings.get_string('language'));
        this._addIndicator();
        this._positionId = this._settings.connect('changed::panel-position', () => {
            this._indicator?.destroy();
            this._addIndicator();
        });
    }

    _addIndicator() {
        this._indicator = new Indicator(this._settings, () => this.openPreferences());
        const box = this._settings.get_string('panel-position');
        Main.panel.addToStatusArea(this.uuid, this._indicator, box === 'right' ? 0 : -1, box);
    }

    disable() {
        if (this._positionId)
            this._settings.disconnect(this._positionId);
        this._positionId = 0;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}

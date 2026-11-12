// IAmigos — GNOME Shell extension.
// Shows a pixel-art critter in the top bar for every running Claude Code or
// OpenCode session, reading the JSON files their hooks write.
//
// What each session shows, how it is drawn and how its window is found are in
// view.js, paint.js and procs.js (shared with the macOS/Windows desktop app).

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

import {SPRITE_W, SPRITE_H} from './sprites.js';
import {setLanguage, t} from './i18n.js';
import {Combo, TIERS} from './whip.js';
import {
    AGENT_LABELS, CLOSED_LINGER, MAX_MINIS,
    assignLooks, detailsLine, isUrgent, layoutBar, liveSubagents, sessionTitle, viewOf,
} from './view.js';
import {COLS, ROWS, WHIP_COLS, WHIP_ROWS, CRACK_FRAMES, isAnimated, makeLook, miniPixels, petPixels, whipPixels} from './paint.js';
import {TERMINAL_RE, ancestors, isBackgroundShell, jumpToPane, pickMuxClients} from './procs.js';

const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'iamigos', 'sessions']);

// Everything else (size, timings, language…) comes from the preferences (GSettings).
const TICK_MS = 200;           // animation
const REFRESH_EVERY = 25;      // ticks between process checks (5 s)

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

// Shells Claude Code left running after the turn ended (background Bash):
// direct children of claude (procs.js decides which ones).
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
    return kids.filter(k => isBackgroundShell(readCmdline(k).join(' '))).length;
}

function isAlive(pid) {
    return !pid || GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
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

function readCmdline(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        return decoder.decode(bytes).split('\0').filter(Boolean);
    } catch {
        return [];
    }
}

// Clients of a multiplexer (zellij/tmux): the processes whose window is the terminal running it.
function muxClientPids(kind) {
    const procs = [];
    const it = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = it.next_file(null))) {
        const pid = parseInt(info.get_name());
        if (pid)
            procs.push({pid, argv: readCmdline(pid)});
    }
    it.close(null);
    return pickMuxClients(procs, kind);
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

// Finds the session's window: by PID (or by the zellij/tmux client), by title,
// or else the most recent terminal. Then jumps to the multiplexer pane.
function focusSession(session) {
    const wins = global.get_window_actors()
        .map(a => a.meta_window)
        .filter(w => w && !w.skip_taskbar)
        .sort((a, b) => b.get_user_time() - a.get_user_time());

    const mux = session.mux;
    const anc = ancestors(session.pid, parentPid);
    if (mux?.kind)
        muxClientPids(mux.kind).forEach(p => ancestors(p, parentPid).forEach(a => anc.add(a)));

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
    jumpToPane(mux, run, session.term).catch(e => console.warn(`[IAmigos] could not jump to the pane: ${e.message}`));
}

// Draws pixels from paint.js: [x, y, rgb, alpha] in sprite pixels of `px` screen pixels.
function drawPixels(cr, px, pixels) {
    for (const [x, y, rgb, a] of pixels) {
        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], a);
        cr.rectangle(x * px, y * px, px, px);
        cr.fill();
    }
}

const Pet = GObject.registerClass(
class IAmigosPet extends St.Bin {
    _init(project, ordinal, pixel) {
        // Reactive for the hover hint; a left click jumps to its session (Indicator._routeClicks).
        super._init({
            style_class: 'iamigos-pet', y_align: Clutter.ActorAlign.CENTER,
            reactive: true, track_hover: true,
        });

        this._view = null;
        this._urgent = false;
        this._subs = 0;
        this.frame = 0;
        this._whipAt = -Infinity;      // frame of the last lash
        this._rushUntil = -1;          // runs faster until this frame
        this.setLook(project, ordinal);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._px = pixel * scale;
        this._mpx = Math.max(1, Math.floor(pixel / 2)) * scale;   // pixel of the mini critters
        const height = ROWS * this._px;
        this._miniRows = Math.max(1, Math.floor((height + this._mpx) / ((SPRITE_H + 1) * this._mpx)));

        this._area = new St.DrawingArea({width: COLS * this._px, height});
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
        this._look = makeLook(project, ordinal);
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

    // A lash: flinches for a moment, then runs faster for `rush` ticks.
    whip(frame, rush) {
        this.frame = frame;
        this._whipAt = frame;
        this._rushUntil = Math.max(this._rushUntil, frame + rush);
        this._area.queue_repaint();
    }

    tick(frame) {
        this.frame = frame;
        if (isAnimated(this._view, this._urgent, frame, this._rushUntil))
            this._area.queue_repaint();
        if (this._subs)
            this._mini.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const {body, over} = petPixels(this._look, this._view, this.frame,
            {urgent: this._urgent, whipAt: this._whipAt, rushUntil: this._rushUntil});
        drawPixels(cr, this._px, body);
        drawPixels(cr, this._px, over);
        cr.$dispose();
    }

    // Mini critters: the same character, smaller, hopping out of step.
    _paintMinis(area) {
        const cr = area.get_context();
        drawPixels(cr, this._mpx, miniPixels(this._look, this._subs, this.frame, this._miniRows));
        cr.$dispose();
    }
});

// The whip, to the right of the critters: a left click lashes all of them (Indicator._routeClicks).
const WhipButton = GObject.registerClass(
class IAmigosWhipButton extends St.Bin {
    _init(pixel) {
        super._init({
            style_class: 'iamigos-whip', y_align: Clutter.ActorAlign.CENTER,
            reactive: true, track_hover: true,
        });
        this._crackAt = -Infinity;
        this._frame = 0;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._px = pixel * scale;
        this._area = new St.DrawingArea({width: WHIP_COLS * this._px, height: WHIP_ROWS * this._px});
        this._area.connect('repaint', area => this._paint(area));
        this.set_child(this._area);
    }

    crack(frame) {
        this._frame = this._crackAt = frame;
        this._area.queue_repaint();
    }

    tick(frame) {
        this._frame = frame;
        if (frame - this._crackAt <= CRACK_FRAMES)
            this._area.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        drawPixels(cr, this._px, whipPixels(this._frame, this._crackAt));
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
        // The combo floats under the whip, above the windows, and outside the
        // panel button: it takes no room in the bar (the whip does not move
        // while you click) and lets clicks through (no menu by accident).
        this._comboLabel = new St.Label({style_class: 'iamigos-combo', visible: false, reactive: false});
        this._comboLabel.set_pivot_point(0.5, 0.5);
        Main.uiGroup.add_child(this._comboLabel);
        this._combo = new Combo();
        this._whipButton = null;

        this._sessions = new Map();   // file name -> data
        this._pets = new Map();       // file name -> Pet
        this._goneAt = new Map();     // file name -> when its process died
        this._views = new Map();      // file name -> state shown
        this._frame = 0;

        // Settings: a new size means rebuilding the critters; anything else, a refresh.
        this._settingsIds = [
            settings.connect('changed::pixel-size', () => {
                this._whipButton?.destroy();
                this._whipButton = null;
                this._clearPets();
            }),
            settings.connect('changed::language', () => {
                setLanguage(settings.get_string('language'));
                this._refresh();
            }),
            // The whip counters change on every lash: no need to refresh for them.
            settings.connect('changed', (_s, key) => {
                if (!key.startsWith('whip-'))
                    this._refresh();
            }),
        ];

        GLib.mkdir_with_parents(STATE_DIR, 0o755);
        this._dir = Gio.File.new_for_path(STATE_DIR);
        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._scheduleReload());

        this.menu.actor.add_style_class_name('iamigos-menu');
        this._routeClicks();
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._buildMenu();
        });

        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._frame++;
            for (const pet of this._pets.values())
                pet.tick(this._frame);
            this._whipButton?.tick(this._frame);
            if (this._comboLabel.visible && !this._combo.visible(Date.now() / 1000))
                this._comboLabel.visible = false;
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
        const alive = s.state === 'closed' || isAlive(s.pid);
        if (!alive && !this._goneAt.has(name))
            this._goneAt.set(name, this._firstLoad ? 0 : now);
        return viewOf(s, now, {
            alive,
            hasBackground: () => backgroundShells(s.pid) > 0,
            sleepSecs: this._settings.get_int('sleep-minutes') * 60,
        });
    }

    // Has been waiting for your permission or answer for too long.
    _isUrgent(view, s, now) {
        return isUrgent(view, s, now, this._settings.get_int('long-wait-seconds'));
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

        // With more sessions than the maximum, the last ones are grouped into "+N".
        const {inBar, hidden, visible: ordered} =
            layoutBar(visible, this._sessions, this._settings.get_int('max-pets'));
        const subsOn = this._settings.get_boolean('show-subagents');
        const pixel = this._settings.get_int('pixel-size');

        for (const [name, pet] of this._pets) {
            if (!inBar.includes(name)) {
                pet.destroy();
                this._pets.delete(name);
            }
        }
        const looks = assignLooks(inBar, this._sessions);
        inBar.forEach((name, i) => {
            const s = this._sessions.get(name);
            const {project, ordinal} = looks.get(name);

            let pet = this._pets.get(name);
            if (!pet)
                pet = this._addPet(name, project, ordinal, pixel);
            pet.setLook(project, ordinal);
            this._box.set_child_at_index(pet, i);
            const view = this._views.get(name);
            pet.setView(view, this._isUrgent(view, s, now));
            pet.setSubagents(subsOn && view !== 'closed' ? liveSubagents(s, now).length : 0);
        });

        if (this._more.get_parent() !== this._box)
            this._box.add_child(this._more);
        this._box.set_child_at_index(this._more, inBar.length);

        // Whip to the right of everything, then the combo flying out of it.
        const whipOn = this._settings.get_boolean('show-whip');
        if (whipOn && !this._whipButton) {
            this._whipButton = new WhipButton(pixel);
            this._whipButton.accessible_name = t('whip.button');
            this._box.add_child(this._whipButton);
        } else if (!whipOn && this._whipButton) {
            this._whipButton.destroy();
            this._whipButton = null;
        }
        if (this._whipButton)
            this._box.set_child_at_index(this._whipButton, inBar.length + 1);
        if (!whipOn)
            this._comboLabel.visible = false;
        this._more.text = `+${hidden}`;
        this._more.visible = hidden > 0;

        this.visible = visible.length > 0;
        this._order = ordered;

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
        const lashes = this._settings.get_int('whip-total');
        if (lashes > 0 && this._settings.get_boolean('show-whip')) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                t('whip.stats', lashes, this._settings.get_int('whip-best')), {reactive: false}));
        }
        const prefs = new PopupMenu.PopupMenuItem(t('menu.preferences'));
        prefs.connect('activate', () => this._openPrefs());
        this.menu.addMenuItem(prefs);
    }

    // The bar is a PanelMenu.Button: any press on it toggles the menu (from
    // vfunc_event in GNOME 48, from a ClickGesture in 49+; both call
    // menu.toggle()). Here only a right click opens it: a left click on a
    // critter or on the whip runs its action, and anywhere else (between
    // critters, on "+N") does nothing. The keyboard still opens it.
    _routeClicks() {
        const toggle = this.menu.toggle.bind(this.menu);
        this.menu.toggle = () => {
            const action = this._clickAction(Clutter.get_current_event());
            if (!action)
                return toggle();
            if (this.menu.isOpen)
                this.menu.close();
            return action();
        };
    }

    // What a press does instead of toggling the menu, or null to toggle it.
    _clickAction(event) {
        const type = event?.type();
        const button = type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE
            ? event.get_button()
            : type === Clutter.EventType.TOUCH_BEGIN ? Clutter.BUTTON_PRIMARY : 0;
        if (!button || button === Clutter.BUTTON_SECONDARY)
            return null;                    // right click or keyboard: the menu
        const nothing = () => {};
        if (button !== Clutter.BUTTON_PRIMARY)
            return nothing;
        const target = global.stage.get_event_actor(event);
        if (!target)
            return nothing;
        if (this._whipButton?.contains(target))
            return () => this._whip();
        for (const [name, pet] of this._pets) {
            if (pet.contains(target)) {
                return () => {
                    const s = this._sessions.get(name);
                    if (s)
                        focusSession(s);
                };
            }
        }
        return nothing;
    }

    _addPet(name, project, ordinal, pixel) {
        const pet = new Pet(project, ordinal, pixel);
        this._pets.set(name, pet);
        this._box.add_child(pet);
        return pet;
    }

    // Centred under the whip, kept inside its monitor.
    _placeCombo() {
        const whip = this._whipButton;
        const label = this._comboLabel;
        if (!whip)
            return;
        const [wx, wy] = whip.get_transformed_position();
        const [ww, wh] = whip.get_transformed_size();
        const [, lw] = label.get_preferred_width(-1);
        const monitor = Main.layoutManager.findMonitorForActor(whip) ?? Main.layoutManager.primaryMonitor;
        const gap = 4;
        let x = wx + ww / 2 - lw / 2;
        if (monitor)
            x = Math.max(monitor.x + gap, Math.min(x, monitor.x + monitor.width - lw - gap));
        label.set_position(Math.round(x), Math.round(wy + wh + gap));
    }

    // One lash to every critter that is still alive.
    _whip() {
        const now = Date.now() / 1000;
        const hit = this._combo.hit(now);
        for (const [name, pet] of this._pets) {
            if (this._views.get(name) !== 'closed')
                pet.whip(this._frame, hit.tier.rush);
        }

        this._whipButton?.crack(this._frame);

        this._settings.set_int('whip-total', this._settings.get_int('whip-total') + 1);
        if (hit.count > this._settings.get_int('whip-best'))
            this._settings.set_int('whip-best', hit.count);

        const label = this._comboLabel;
        for (const tier of TIERS) {
            if (tier.key)
                label.remove_style_class_name(`tier-${tier.key}`);
        }
        if (hit.count < 2) {
            label.visible = false;
            return;
        }
        if (hit.tier.key)
            label.add_style_class_name(`tier-${hit.tier.key}`);
        label.text = hit.milestone && hit.tier.key ? `x${hit.count} ${t(`whip.${hit.tier.key}`)}` : `x${hit.count}`;
        this._placeCombo();
        label.visible = true;
        // Arcade punch: a pop on every lash, a big one on every milestone.
        label.remove_all_transitions();
        label.set_scale(hit.milestone ? 1.8 : 1.3, hit.milestone ? 1.8 : 1.3);
        label.ease({
            scale_x: 1, scale_y: 1,
            duration: hit.milestone ? 400 : 180,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    // One session: "project · state · age" and, below, the details.
    _sessionItem(s, view, now, details) {
        const item = new PopupMenu.PopupBaseMenuItem();
        const text = new St.BoxLayout({vertical: true, x_expand: true});

        const title = new St.Label({
            text: sessionTitle(s, view, now, this._settings.get_int('long-wait-seconds'), t),
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
        return detailsLine(s, view, now, s.cwd ? gitBranch(s.cwd) : null, t);
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
        this._comboLabel?.destroy();
        this._comboLabel = null;
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

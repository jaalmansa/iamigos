// IAmigos — extensión de GNOME Shell.
// Muestra en la barra superior un bicho pixel art por cada sesión activa de
// Claude Code u OpenCode, leyendo los ficheros JSON que escriben sus hooks.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    CHARACTERS, BADGES, SPRITE_W, SPRITE_H,
    makePalette, greyPalette, pickLook, lowestEyeRows, shade,
} from './sprites.js';

const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'iamigos', 'sessions']);

const SLEEP_AFTER = 10 * 60;   // s en "done"/"idle" antes de dormirse
const CLOSED_LINGER = 30;      // s que se ve una sesión cerrada antes de quitarla
const PIXEL = 2;               // tamaño de cada píxel del sprite
const TICK_MS = 200;           // animación
const REFRESH_EVERY = 25;      // ticks entre comprobaciones de procesos (5 s)

const STATE_LABELS = {
    idle: 'esperando',
    working: 'trabajando',
    permission: 'pide permiso',
    asking: 'te pregunta',
    compacting: 'compactando',
    done: 'terminado',
    background: 'en segundo plano',
    asleep: 'durmiendo',
    error: 'error',
    closed: 'cerrada',
};

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

// Shells que Claude Code deja corriendo tras terminar el turno (Bash en segundo
// plano). Son hijos directos de claude que cargan un shell-snapshot; los MCP
// también cuelgan de claude, pero no tienen esa forma.
function backgroundShells(pid) {
    if (!pid)
        return 0;
    let kids = [];
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

function readCmdline(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        return decoder.decode(bytes).split('\0').filter(Boolean);
    } catch {
        return [];
    }
}

// Con zellij/tmux el agente cuelga de un servidor hijo de systemd, no de la
// terminal: la ventana buena es la que contiene un cliente de ese multiplexor.
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
        // El servidor (zellij --server, o el tmux demonizado) cuelga de systemd:
        // sus ancestros no tocan ninguna ventana, así que no estorba.
        if (argv.includes('--server'))
            continue;
        out.push(pid);
    }
    it.close(null);
    return out;
}

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Ejecuta un comando sin bloquear GNOME Shell; devuelve su stdout o null si falla.
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

// zellij 0.43 no tiene «enfocar panel por id», así que se recorre: cada pestaña
// y, dentro de ella, focus-next-pane hasta que list-clients muestre el panel.
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
                break;              // ya dimos la vuelta a la pestaña
        }
    }
}

async function tmuxFocusPane(socket, pane) {
    await run(['tmux', '-S', socket, 'switch-client', '-t', pane]);
    await run(['tmux', '-S', socket, 'select-window', '-t', pane, ';', 'select-pane', '-t', pane]);
}

// Salta al panel de zellij/tmux donde vive la sesión.
function jumpToPane(mux) {
    if (!mux?.pane)
        return;
    const job = mux.kind === 'zellij' && mux.session ? zellijFocusPane(mux.session, String(mux.pane))
        : mux.kind === 'tmux' && mux.socket ? tmuxFocusPane(mux.socket, String(mux.pane))
        : null;
    job?.catch(e => console.warn(`[IAmigos] no se pudo saltar al panel: ${e.message}`));
}

// Busca la ventana de la sesión: por PID (o por el cliente de zellij/tmux), por
// título y, si no, la terminal más reciente. Después salta al panel del multiplexor.
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
    _init(project, ordinal) {
        super._init({style_class: 'iamigos-pet', y_align: Clutter.ActorAlign.CENTER});

        this._grey = greyPalette();
        this._view = null;
        this.frame = 0;
        this.setLook(project, ordinal);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._px = PIXEL * scale;
        this._area = new St.DrawingArea({
            width: (SPRITE_W + 3) * this._px,
            height: (SPRITE_H + 1) * this._px,
        });
        this._area.connect('repaint', area => this._paint(area));
        this.set_child(this._area);
    }

    // Mismo proyecto → mismo bicho. La 2.ª, 3.ª… sesión del proyecto cambia de color.
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
    }

    setView(view) {
        if (view === this._view)
            return;
        if (this._view)
            this.remove_style_class_name(this._view);
        this._view = view;
        this.add_style_class_name(view);
        this._area.queue_repaint();
    }

    tick(frame) {
        this.frame = frame;
        if (['working', 'compacting', 'background', 'asleep', 'permission', 'asking'].includes(this._view))
            this._area.queue_repaint();
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
            oy = 0;                         // da saltitos
        if (view === 'compacting')
            ox = f % 2;                     // tiembla mientras compacta

        const dot = (x, y, rgb, a = 1) => {
            cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], a);
            cr.rectangle(x * px, y * px, px, px);
            cr.fill();
        };

        this._grid.forEach((row, y) => {
            [...row].forEach((ch, x) => {
                if (ch === '.')
                    return;
                let key = ch;
                if (ch === 'e' && eyesClosed)
                    key = this._eyeRows[x] === y ? 'd' : 'b';
                dot(ox + x, oy + y, pal[key], alpha);
            });
        });

        // Indicador de estado en la esquina superior derecha.
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
            const blink = (view === 'permission' || view === 'asking') && Math.floor(f / 3) % 2;
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
});

const Indicator = GObject.registerClass(
class IAmigosIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'IAmigos', false);

        this._box = new St.BoxLayout({style_class: 'iamigos-box'});
        this.add_child(this._box);

        this._sessions = new Map();   // fichero -> datos
        this._pets = new Map();       // fichero -> Pet
        this._goneAt = new Map();     // fichero -> instante en que murió el proceso
        this._views = new Map();      // fichero -> estado mostrado
        this._frame = 0;

        GLib.mkdir_with_parents(STATE_DIR, 0o755);
        this._dir = Gio.File.new_for_path(STATE_DIR);
        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => this._scheduleReload());

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

        this._reload();
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
                    // fichero a medio escribir o corrupto: se ignora
                }
            }
            en.close(null);
        } catch (e) {
            console.warn(`[IAmigos] no se pudo leer ${STATE_DIR}: ${e.message}`);
        }
        for (const name of [...this._sessions.keys()]) {
            if (!seen.has(name))
                this._sessions.delete(name);
        }
        this._refresh();
    }

    _viewOf(name, s, now) {
        let view = s.state;
        if (view !== 'closed' && !isAlive(s.pid)) {
            if (!this._goneAt.has(name))
                this._goneAt.set(name, now);
            view = 'closed';
        }
        if ((view === 'done' || view === 'idle') && s.agent === 'claude' && backgroundShells(s.pid) > 0)
            view = 'background';   // turno terminado, pero sigue algo corriendo
        if ((view === 'done' || view === 'idle') && now - s.since > SLEEP_AFTER)
            view = 'asleep';
        return view;
    }

    _refresh() {
        const now = Date.now() / 1000;
        const visible = [];

        for (const [name, s] of this._sessions) {
            const view = this._viewOf(name, s, now);
            if (view === 'closed') {
                const closedAt = s.state === 'closed' ? s.since : this._goneAt.get(name);
                if (now - closedAt > CLOSED_LINGER) {
                    this._forget(name);
                    continue;
                }
            }
            this._views.set(name, view);
            visible.push(name);
        }

        visible.sort((a, b) => (this._sessions.get(a).started ?? 0) - (this._sessions.get(b).started ?? 0));

        for (const [name, pet] of this._pets) {
            if (!visible.includes(name)) {
                pet.destroy();
                this._pets.delete(name);
            }
        }
        const perProject = new Map();
        visible.forEach((name, i) => {
            const s = this._sessions.get(name);
            const project = s.cwd || s.project || s.id;
            const ordinal = perProject.get(project) ?? 0;
            perProject.set(project, ordinal + 1);

            let pet = this._pets.get(name);
            if (!pet) {
                pet = new Pet(project, ordinal);
                this._pets.set(name, pet);
                this._box.add_child(pet);
            }
            pet.setLook(project, ordinal);
            this._box.set_child_at_index(pet, i);
            pet.setView(this._views.get(name));
        });

        this.visible = visible.length > 0;
    }

    _forget(name) {
        try {
            this._dir.get_child(name).delete(null);
        } catch {}
        this._sessions.delete(name);
        this._goneAt.delete(name);
        this._views.delete(name);
    }

    _buildMenu() {
        this.menu.removeAll();
        const now = Date.now() / 1000;
        const names = [...this._pets.keys()];

        if (!names.length) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Sin sesiones activas', {reactive: false}));
            return;
        }

        for (const name of names) {
            const s = this._sessions.get(name);
            if (!s)
                continue;
            const view = this._views.get(name) ?? s.state;
            const detail = s.detail && ['permission', 'asking', 'error'].includes(view) ? ` (${s.detail})` : '';
            const label = `${s.project}  ·  ${STATE_LABELS[view] ?? view}${detail}  ·  ${formatAge(now - s.since)}`;
            const item = new PopupMenu.PopupMenuItem(label);
            item.label.clutter_text.set_ellipsize(3 /* Pango.EllipsizeMode.END */);
            const tag = new St.Label({
                text: AGENT_LABELS[s.agent] ?? s.agent,
                style_class: 'iamigos-agent-tag',
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(tag);
            item.connect('activate', () => focusSession(s));
            this.menu.addMenuItem(item);
        }
    }

    destroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._tickId = this._reloadId = 0;
        this._monitor?.cancel();
        this._monitor = null;
        super.destroy();
    }
});

export default class IAmigosExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

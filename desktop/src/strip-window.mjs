// IAmigos desktop — Windows: the floating strip of critters. A small frameless
// window, always on top, above the taskbar by default and draggable anywhere.
// The main process draws the image; the page only shows it and reports clicks.

import {BrowserWindow, ipcMain, screen} from 'electron';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAD = 6;          // css px around the critters
const COMBO_BAND = 30;  // css px above them, where the combo floats
const MARGIN = 8;       // css px from the edge of the work area

export class Strip {
    // settings: Settings; onClick(xDevicePx, button); onMenu()
    constructor({settings, onClick, onMenu}) {
        this.settings = settings;
        this.size = {w: 0, h: 0};
        this.win = new BrowserWindow({
            width: 200, height: 60, show: false,
            frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
            skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
            webPreferences: {
                preload: path.join(HERE, 'strip', 'preload.cjs'),
                contextIsolation: true, sandbox: true,
            },
        });
        this.win.setAlwaysOnTop(true, 'screen-saver');
        // Clicks go through the transparent parts; the page turns them back on over the critters.
        this.win.setIgnoreMouseEvents(true, {forward: true});
        this.win.loadFile(path.join(HERE, 'strip', 'index.html'));
        this.ready = new Promise(resolve => this.win.webContents.once('did-finish-load', resolve));

        const mine = e => e.sender === this.win.webContents;
        this.handlers = {
            'strip:click': (e, x, button) => mine(e) && (button === 2 ? onMenu() : onClick(x * this.scale(), button)),
            'strip:hover': (e, over) => mine(e) && this.win.setIgnoreMouseEvents(!over, {forward: true}),
            'strip:drag-start': e => {
                if (!mine(e))
                    return;
                this.drag = {cursor: screen.getCursorScreenPoint(), pos: this.win.getPosition()};
            },
            'strip:drag-move': e => {
                if (!mine(e) || !this.drag)
                    return;
                const c = screen.getCursorScreenPoint();
                this.win.setPosition(this.drag.pos[0] + c.x - this.drag.cursor.x, this.drag.pos[1] + c.y - this.drag.cursor.y);
            },
            'strip:drag-end': e => {
                if (!mine(e) || !this.drag)
                    return;
                this.drag = null;
                this.settings.set('strip-position', this.anchorOf(this.win.getBounds()));
            },
        };
        for (const [channel, fn] of Object.entries(this.handlers))
            ipcMain.on(channel, fn);
    }

    scale() {
        return screen.getDisplayMatching(this.win.getBounds()).scaleFactor;
    }

    // The point the strip hangs from (its bottom edge: left, center or right,
    // as in the preferences), so it grows away from the screen edge.
    align() {
        return this.settings.get('panel-position');
    }

    anchorOf(b) {
        const x = {left: b.x, center: b.x + b.width / 2, right: b.x + b.width}[this.align()] ?? b.x + b.width;
        return {x: Math.round(x), y: b.y + b.height};
    }

    defaultAnchor() {
        const wa = screen.getPrimaryDisplay().workArea;
        const x = {left: wa.x + MARGIN, center: wa.x + wa.width / 2}[this.align()] ?? wa.x + wa.width - MARGIN;
        return {x: Math.round(x), y: wa.y + wa.height - MARGIN};
    }

    anchor() {
        const saved = this.settings.get('strip-position');
        const onScreen = saved && screen.getAllDisplays().some(d => {
            const wa = d.workArea;
            return saved.x >= wa.x && saved.x <= wa.x + wa.width && saved.y >= wa.y && saved.y <= wa.y + wa.height + MARGIN;
        });
        return onScreen ? saved : this.defaultAnchor();
    }

    place() {
        const {w, h} = this.size;
        const a = this.anchor();
        const x = {left: a.x, center: a.x - w / 2}[this.align()] ?? a.x - w;
        this.win.setBounds({x: Math.round(x), y: Math.round(a.y - h), width: w, height: h});
    }

    // Back to its default place (after the position setting changes, or from the menu).
    reset() {
        this.settings.set('strip-position', null);
        this.place();
    }

    // frame: {png, width, height (device px), scale, combo: {text, tier, x (device px)} | null}
    async update(frame) {
        const w = Math.ceil(frame.width / frame.scale) + 2 * PAD;
        const h = Math.ceil(frame.height / frame.scale) + 2 * PAD + COMBO_BAND;
        if (w !== this.size.w || h !== this.size.h) {
            this.size = {w, h};
            this.place();
        }
        await this.ready;
        this.win.webContents.send('strip:frame', {
            url: `data:image/png;base64,${frame.png.toString('base64')}`,
            width: frame.width / frame.scale, height: frame.height / frame.scale,
            pad: PAD, band: COMBO_BAND,
            combo: frame.combo && {...frame.combo, x: frame.combo.x / frame.scale},
        });
    }

    show() {
        if (!this.win.isVisible())
            this.win.showInactive();
    }

    hide() {
        if (this.win.isVisible())
            this.win.hide();
    }

    toggle(canShow) {
        if (this.win.isVisible())
            this.hide();
        else if (canShow)
            this.show();
    }

    destroy() {
        for (const [channel, fn] of Object.entries(this.handlers))
            ipcMain.removeListener(channel, fn);
        this.win.destroy();
    }
}

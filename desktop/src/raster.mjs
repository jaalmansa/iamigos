// IAmigos desktop — draws the critters into PNG images: the strip of critters
// (macOS menu bar, Windows floating strip) and the Windows tray icon.
// No Electron imports, so it can be tested with Node.
//
// All sizes are in device pixels; `scale` is the display's scale factor.

import zlib from 'node:zlib';

import {SPRITE_W, SPRITE_H} from './shared/sprites.js';
import {COLS, ROWS, WHIP_COLS, WHIP_ROWS, boxOf, miniPixels, petPixels, whipPixels} from './shared/paint.js';
import {MAX_MINIS} from './shared/view.js';

// --- A tiny RGBA canvas -------------------------------------------------------

export class Canvas {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);   // straight alpha
    }

    // Source-over blending of one device pixel (rgb in 0..1).
    blend(x, y, rgb, a = 1) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0)
            return;
        const i = (y * this.width + x) * 4;
        const d = this.data;
        const da = d[i + 3] / 255;
        const oa = a + da * (1 - a);
        for (let c = 0; c < 3; c++)
            d[i + c] = Math.round((rgb[c] * 255 * a + d[i + c] * da * (1 - a)) / oa);
        d[i + 3] = Math.round(oa * 255);
    }

    rect(x, y, w, h, rgb, a = 1) {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++)
                this.blend(xx, yy, rgb, a);
        }
    }

    // A rounded box with an optional fill and border (bw thick).
    roundRect(x, y, w, h, r, fill, border, bw) {
        const inside = (px, py, inset) => {
            const rr = Math.max(0, r - inset);
            const cx = Math.min(Math.max(px, x + inset + rr), x + w - 1 - inset - rr);
            const cy = Math.min(Math.max(py, y + inset + rr), y + h - 1 - inset - rr);
            return px >= x + inset && px < x + w - inset && py >= y + inset && py < y + h - inset &&
                (px - cx) ** 2 + (py - cy) ** 2 <= rr * rr + rr;
        };
        for (let py = y; py < y + h; py++) {
            for (let px = x; px < x + w; px++) {
                if (!inside(px, py, 0))
                    continue;
                if (border && !inside(px, py, bw))
                    this.blend(px, py, border);
                else if (fill)
                    this.blend(px, py, fill);
            }
        }
    }

    // Pixels from paint.js ([x, y, rgb, alpha] in sprite pixels) at (ox, oy), `p` device px each.
    pixels(list, ox, oy, p) {
        for (const [x, y, rgb, a] of list)
            this.rect(ox + x * p, oy + y * p, p, p, rgb, a);
    }

    png() {
        return encodePng(this.width, this.height, this.data);
    }
}

export function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// --- PNG ----------------------------------------------------------------------

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf)
        c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

export function encodePng(width, height, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);              // 8 bits, RGBA, no interlace
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++)
        Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// --- "+N" in a 3×5 pixel font -------------------------------------------------

const GLYPHS = {
    '+': ['...', '.x.', 'xxx', '.x.', '...'],
    0: ['xxx', 'x.x', 'x.x', 'x.x', 'xxx'],
    1: ['.x.', 'xx.', '.x.', '.x.', 'xxx'],
    2: ['xxx', '..x', 'xxx', 'x..', 'xxx'],
    3: ['xxx', '..x', '.xx', '..x', 'xxx'],
    4: ['x.x', 'x.x', 'xxx', '..x', '..x'],
    5: ['xxx', 'x..', 'xxx', '..x', 'xxx'],
    6: ['xxx', 'x..', 'xxx', 'x.x', 'xxx'],
    7: ['xxx', '..x', '.x.', '.x.', '.x.'],
    8: ['xxx', 'x.x', 'xxx', 'x.x', 'xxx'],
    9: ['xxx', 'x.x', 'xxx', '..x', 'xxx'],
};
const TEXT_RGB = hexRgb('#c8c8d0');

export function textPixels(text) {
    const out = [];
    [...text].forEach((ch, i) => {
        (GLYPHS[ch] ?? []).forEach((row, y) => {
            [...row].forEach((c, x) => {
                if (c === 'x')
                    out.push([i * 4 + x, y, TEXT_RGB, 1]);
            });
        });
    });
    return out;
}

// --- The strip ----------------------------------------------------------------

// Device pixels per sprite pixel. On macOS the strip must fit in the menu bar.
export function pixelFor(pixelSize, scale, maxHeight = Infinity) {
    const border = Math.max(1, Math.round(scale));
    const fit = Math.floor((maxHeight - 2 * border) / ROWS);
    return Math.max(1, Math.min(Math.round(pixelSize * scale), fit));
}

// Where everything goes. pets: [{name, look, view, urgent, subs, whipAt, rushUntil}].
// Returns {width, height, items: [{kind: 'pet'|'more'|'whip', x, w, ...}]}.
export function layoutStrip({pets, hidden = 0, whip = true, p, scale}) {
    const border = Math.max(1, Math.round(scale));
    const padX = Math.max(1, Math.round(scale));
    const gap = Math.round(3 * scale);
    const mpx = Math.max(1, Math.floor(p / 2));
    const height = ROWS * p + 2 * border;
    const miniRows = Math.max(1, Math.floor((ROWS * p + mpx) / ((SPRITE_H + 1) * mpx)));

    const items = [];
    let x = 0;
    const add = item => {
        if (items.length)
            x += gap;
        items.push({...item, x});
        x += item.w;
    };
    for (const pet of pets) {
        const subs = Math.min(pet.subs ?? 0, MAX_MINIS);
        const miniW = Math.ceil(subs / miniRows) * (SPRITE_W + 1) * mpx;
        add({kind: 'pet', ...pet, subs, miniW, w: 2 * (border + padX) + COLS * p + miniW});
    }
    if (hidden > 0) {
        const text = `+${hidden}`;
        add({kind: 'more', text, w: (text.length * 4 - 1) * p + 2 * padX});
    }
    if (whip)
        add({kind: 'whip', w: WHIP_COLS * p + 2 * Math.round(2 * scale)});
    return {width: Math.max(1, x), height, items, p, mpx, miniRows, border, padX};
}

// Draws one frame of the strip. Returns {png, width, height, items}.
export function renderStrip(model, frame, crackAt = -Infinity) {
    const layout = layoutStrip(model);
    const {height, p, mpx, miniRows, border, padX} = layout;
    const canvas = new Canvas(layout.width, height);
    const radius = Math.round(3 * model.scale);

    for (const item of layout.items) {
        if (item.kind === 'pet') {
            const box = boxOf(item.view, item.urgent);
            if (box.bg || box.border) {
                canvas.roundRect(item.x, 0, item.w, height, radius,
                    box.bg && hexRgb(box.bg), box.border && hexRgb(box.border), border);
            }
            const ox = item.x + border + padX;
            const {body, over} = petPixels(item.look, item.view, frame,
                {urgent: item.urgent, whipAt: item.whipAt, rushUntil: item.rushUntil});
            canvas.pixels(body, ox, border, p);
            canvas.pixels(over, ox, border, p);
            if (item.subs)
                canvas.pixels(miniPixels(item.look, item.subs, frame, miniRows), ox + COLS * p, border, mpx);
        } else if (item.kind === 'more') {
            canvas.pixels(textPixels(item.text), item.x + padX, Math.round((height - 5 * p) / 2), p);
        } else {
            const top = Math.round((height - WHIP_ROWS * p) / 2);
            canvas.pixels(whipPixels(frame, crackAt), item.x + Math.round(2 * model.scale), top, p);
        }
    }
    return {png: canvas.png(), width: layout.width, height, items: layout.items};
}

// What is at x (device pixels): the item, or null between them.
export function hitTest(items, x) {
    return items.find(it => x >= it.x && x < it.x + it.w) ?? null;
}

// --- Windows tray icon --------------------------------------------------------

// One critter in a size×size square (16 at 100 %), its box colour as the background.
export function renderIcon(pet, frame, size) {
    const canvas = new Canvas(size, size);
    const p = Math.max(1, Math.floor(size / COLS));
    if (pet) {
        const box = boxOf(pet.view, pet.urgent);
        if (box.bg)
            canvas.roundRect(0, 0, size, size, Math.round(size / 5), hexRgb(box.bg), null, 0);
        const ox = Math.floor((size - COLS * p) / 2), oy = Math.floor((size - ROWS * p) / 2);
        const {body, over} = petPixels(pet.look, pet.view, frame, {urgent: pet.urgent});
        canvas.pixels(body, ox, oy, p);
        canvas.pixels(over, ox, oy, p);
        if (box.border && !box.bg)
            canvas.rect(0, size - p, size, p, hexRgb(box.border));
    }
    return canvas.png();
}

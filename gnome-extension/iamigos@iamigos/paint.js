// IAmigos — every frame of a critter, as a list of pixels. No GNOME imports:
// the GNOME extension draws them with Cairo, the desktop app (macOS/Windows)
// into a bitmap, and tools/readme-images.mjs into SVG.
//
// A pixel is [x, y, rgb, alpha], with rgb as [r, g, b] in 0..1 and x/y in
// sprite pixels inside a box of COLS × ROWS.

import {
    CHARACTERS, BADGES, SPRITE_W, SPRITE_H, WHIP_MARK, WHIP_ICON,
    makePalette, greyPalette, pickLook, lowestEyeRows, shade, lashPixels, tint,
} from './sprites.js';

export const COLS = SPRITE_W + 3;       // the sprite + room for the state indicator
export const ROWS = SPRITE_H + 1;       // the sprite + room to hop
export const HURT_FRAMES = 3;           // ticks a whipped critter flinches
export const CRACK_FRAMES = 2;          // ticks the whip button shows its spark
export const WHIP_COLS = WHIP_ICON.rows[0].length;
export const WHIP_ROWS = WHIP_ICON.rows.length + 1;

const LASH = lashPixels();
const WHITE = [1, 1, 1];
const DOTS = {working: [1, 1, 1], compacting: [0.75, 0.6, 1], background: [0.35, 0.8, 1]};

// Background and border of the critter's box per state (same as stylesheet.css).
export const BOX = {
    permission: {bg: '#f07b1d', border: '#f07b1d'},
    asking: {bg: '#5a2f12', border: '#f07b1d'},
    done: {border: '#4cd964'},
    error: {border: '#ff4d4d'},
};
export const URGENT_BORDER = '#ffd23f';

export function boxOf(view, urgent) {
    const box = BOX[view] ?? {};
    return urgent ? {...box, border: URGENT_BORDER} : box;
}

// Everything needed to draw one session's critter.
export function makeLook(project, ordinal = 0) {
    return lookOf(pickLook(project, ordinal));
}

export function lookOf({character, hue}) {
    const grid = shade(CHARACTERS[character]);
    const palette = makePalette(hue);
    return {
        character, hue, grid,
        eyes: lowestEyeRows(grid),
        palette,
        hurt: tint(palette, '#ff3b30', 0.45),
        grey: greyPalette(),
    };
}

// The sprite alone, at (ox, oy).
export function spritePixels(look, pal, alpha, eyesClosed, ox = 0, oy = 0) {
    const out = [];
    look.grid.forEach((row, y) => {
        [...row].forEach((ch, x) => {
            if (ch === '.')
                return;
            let key = ch;
            if (ch === 'e' && eyesClosed)
                key = look.eyes[x] === y ? 'd' : 'b';
            out.push([ox + x, oy + y, pal[key], alpha]);
        });
    });
    return out;
}

function badgePixels(rows, color, dx, dy, out) {
    const rgb = makePalette(color).b;
    const w = rows[0].length;
    rows.forEach((row, y) => {
        [...row].forEach((ch, x) => {
            if (ch === 'x')
                out.push([COLS - w + x + dx, y + dy, rgb, 1]);
        });
    });
}

// One frame of a critter, split into the body and the state indicator (`over`).
//   f          animation tick (one every 200 ms)
//   urgent     waiting for you for too long: shakes and blinks faster
//   whipAt     tick of the last lash; rushUntil: hops twice as fast until this tick
export function petPixels(look, view, f, {urgent = false, whipAt = -Infinity, rushUntil = -1} = {}) {
    const sinceLash = f - whipAt;
    const hurt = view !== 'closed' && sinceLash < HURT_FRAMES;
    let pal = view === 'closed' ? look.grey : look.palette;
    const alpha = view === 'closed' ? 0.6 : 1;
    let eyesClosed = view === 'asleep' || view === 'closed';

    let ox = 0, oy = 1;
    if (view === 'working' && f % 4 < 2)
        oy = 0;                         // hops
    if (view !== 'closed' && f <= rushUntil)
        oy = f % 2;                     // whipped: hops twice as fast
    if (view === 'compacting' || urgent)
        ox = f % 2;                     // shakes (compacting, or waiting for too long)
    if (hurt) {                         // flinches, squeezes its eyes, flashes red
        ox = [2, 0, 1][sinceLash];
        eyesClosed = true;
        if (sinceLash === 0)
            pal = look.hurt;
    }

    const body = spritePixels(look, pal, alpha, eyesClosed, ox, oy);

    // The lash itself, fading on the next tick.
    if (hurt && sinceLash < 2)
        LASH.forEach(([x, y]) => body.push([ox + x, oy + y, WHITE, sinceLash ? 0.45 : 0.95]));

    // State indicator in the top right corner (an anger mark while it hurts).
    const over = [];
    if (hurt) {
        badgePixels(WHIP_MARK.rows, WHIP_MARK.color, 0, 0, over);
    } else if (DOTS[view]) {
        const n = Math.floor(f / (view === 'background' ? 4 : 2)) % 4;
        for (let i = 0; i < n; i++)
            over.push([COLS - 5 + i * 2, 0, DOTS[view], 1]);
    } else if (BADGES[view]) {
        const lift = view === 'asleep' ? Math.floor(f / 5) % 2 : 0;
        // Blinks; twice as fast when it has been waiting for too long.
        const blink = (view === 'permission' || view === 'asking') &&
            (urgent ? f % 2 : Math.floor(f / 3) % 2);
        if (!blink)
            badgePixels(BADGES[view].rows, BADGES[view].color, 0, 1 - lift, over);
    }
    return {body, over};
}

// Does the critter change between ticks? (if not, there is no need to repaint it)
export function isAnimated(view, urgent, f, rushUntil = -1) {
    return urgent || f <= rushUntil + 1 ||
        ['working', 'compacting', 'background', 'asleep', 'permission', 'asking'].includes(view);
}

// Mini critters (subagents): `n` of them in `rows` rows, hopping out of step.
// Coordinates in mini pixels.
export function miniPixels(look, n, f, rows) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const col = Math.floor(i / rows), row = i % rows;
        const hop = (f + i * 2) % 4 < 2 ? 0 : 1;
        out.push(...spritePixels(look, look.palette, 0.9, false, col * (SPRITE_W + 1), row * (SPRITE_H + 1) + hop));
    }
    return out;
}

const WHIP_RGB = Object.fromEntries(Object.entries(WHIP_ICON.colors).map(([k, hex]) => [k, makePalette(hex).b]));

// The whip button, WHIP_COLS × WHIP_ROWS. It jerks up and sparks as it cracks.
export function whipPixels(f, crackAt = -Infinity) {
    const cracking = f - crackAt < CRACK_FRAMES;
    const oy = cracking ? 0 : 1;
    const out = [];
    WHIP_ICON.rows.forEach((row, y) => {
        [...row].forEach((ch, x) => {
            if (ch === '.' || (ch === 'x' && !cracking))
                return;
            out.push([x, y + oy, WHIP_RGB[ch], 1]);
        });
    });
    return out;
}

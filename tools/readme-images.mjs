#!/usr/bin/env -S node --no-warnings
// Generates the README images (animated SVGs) straight from the extension's sprites:
//   docs/img/states/<state>.svg   one per state, animated like in the top bar
//   docs/img/topbar.svg           top bar with several sessions + the dropdown menu
//   docs/img/characters.svg       every character
//
//   node tools/readme-images.mjs
//
// The frame logic mirrors IAmigosPet._paint() in extension.js: keep both in sync.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CHARACTERS, HUES, BADGES, SPRITE_W, SPRITE_H, makePalette, greyPalette, lowestEyeRows, shade}
    from '../gnome-extension/iamigos@iamigos/sprites.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'img');
const TICK_MS = 200;                      // same as the extension
const COLS = SPRITE_W + 3, ROWS = SPRITE_H + 1;

// stylesheet.css: background / border colour of the pet box per state.
const BOX = {
    permission: {bg: '#f07b1d', border: '#f07b1d'},
    asking: {bg: '#5a2f12', border: '#f07b1d'},
    done: {border: '#4cd964'},
    error: {border: '#ff4d4d'},
};
// How many ticks until the animation repeats.
const PERIOD = {working: 8, compacting: 8, background: 16, asleep: 10, permission: 6, asking: 6};

const hex = c => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

// Pixels [x, y, colour, alpha] of one frame, split into the body and the status
// indicator so each layer can be animated on its own (same rules as _paint()).
function frame(look, view, f) {
    const pal = view === 'closed' ? greyPalette() : makePalette(look.hue);
    const alpha = view === 'closed' ? 0.6 : 1;
    const eyesClosed = view === 'asleep' || view === 'closed';
    let ox = 0, oy = 1;
    if (view === 'working' && f % 4 < 2)
        oy = 0;
    if (view === 'compacting')
        ox = f % 2;

    const px = [];
    look.grid.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === '.')
            return;
        const key = ch === 'e' && eyesClosed ? (look.eyes[x] === y ? 'd' : 'b') : ch;
        px.push([ox + x, oy + y, hex(pal[key]), alpha]);
    }));

    const ov = [];
    if (view === 'working' || view === 'compacting' || view === 'background') {
        const c = {working: '#ffffff', compacting: '#bf99ff', background: '#59ccff'}[view];
        const n = Math.floor(f / (view === 'background' ? 4 : 2)) % 4;
        for (let i = 0; i < n; i++)
            ov.push([COLS - 5 + i * 2, 0, c, 1]);
    } else if (BADGES[view]) {
        const b = BADGES[view];
        const w = b.rows[0].length;
        const lift = view === 'asleep' ? Math.floor(f / 5) % 2 : 0;
        const blink = (view === 'permission' || view === 'asking') && Math.floor(f / 3) % 2;
        if (!blink) {
            b.rows.forEach((row, y) => [...row].forEach((ch, x) => {
                if (ch === 'x')
                    ov.push([COLS - w + x, y + 1 - lift, b.color, 1]);
            }));
        }
    }
    return {body: px, over: ov};
}

let uid = 0;
// One pet (box + animated sprite) as an SVG fragment at (x, y), `s` screen px per sprite px.
function pet(look, view, x, y, s) {
    const id = `p${uid++}`;
    const pad = s / 2, border = Math.max(1, s / 2);
    const w = COLS * s + 2 * pad, h = ROWS * s + 2 * pad;
    const box = BOX[view] ?? {};
    const out = [`<g transform="translate(${x} ${y})">`];
    out.push(`<rect x="${border / 2}" y="${border / 2}" width="${w - border}" height="${h - border}" rx="${s * 2.5}"`
        + ` fill="${box.bg ?? 'none'}" stroke="${box.border ?? 'none'}" stroke-width="${border}"/>`);

    const period = PERIOD[view] ?? 1;
    const T = period * TICK_MS;
    const frames = Array.from({length: period}, (_, f) => frame(look, view, f));
    const draw = pixels => pixels.map(([px, py, c, a]) =>
        `<rect x="${pad + px * s}" y="${pad + py * s}" width="${s}" height="${s}" fill="${c}"${a < 1 ? ` opacity="${a}"` : ''}/>`).join('');

    // Each layer: consecutive identical frames are merged into one segment, which
    // is only visible during its slice of the cycle.
    const css = [];
    for (const layer of ['body', 'over']) {
        const segs = [];
        frames.forEach((fr, f) => {
            const svg = draw(fr[layer]);
            if (segs.length && segs.at(-1).svg === svg)
                segs.at(-1).len++;
            else
                segs.push({svg, start: f, len: 1});
        });
        if (segs.length === 1) {
            out.push(segs[0].svg);
            continue;
        }
        segs.forEach((sg, i) => {
            if (!sg.svg)
                return;
            const cls = `${id}${layer[0]}${i}`;
            const a = (100 * sg.start / period).toFixed(2), b = (100 * (sg.start + sg.len) / period).toFixed(2);
            css.push(`.${cls}{animation:${cls} ${T}ms step-end infinite}`
                + `@keyframes ${cls}{0%{visibility:hidden}${a}%{visibility:visible}${b}%{visibility:hidden}}`);
            out.push(`<g class="${cls}">${sg.svg}</g>`);
        });
    }
    if (css.length)
        out.splice(2, 0, `<style>${css.join('')}</style>`);
    out.push('</g>');
    return {svg: out.join(''), w, h};
}

const look = (character, hue) => {
    const grid = shade(CHARACTERS[character]);
    return {grid, eyes: lowestEyeRows(grid), hue};
};

const svgDoc = (w, h, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>\n`;

function write(rel, content) {
    const path = join(OUT, rel);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, content);
    console.log(`→ docs/img/${rel}`);
}

// --- One image per state ------------------------------------------------------
const STATES = ['idle', 'working', 'permission', 'asking', 'compacting', 'done',
    'background', 'asleep', 'error', 'closed'];
const PANEL = '#1d1d20';
{
    const S = 5, M = 10;
    STATES.forEach((st, i) => {
        uid = 0;
        const names = Object.keys(CHARACTERS);
        const p = pet(look(names[i % names.length], HUES[(i * 3) % HUES.length]), st, M, M, S);
        const W = p.w + 2 * M, H = p.h + 2 * M;
        write(`states/${st}.svg`, svgDoc(W, H, `<rect width="${W}" height="${H}" rx="12" fill="${PANEL}"/>${p.svg}`));
    });
}

// --- Top bar + dropdown menu --------------------------------------------------
{
    uid = 0;
    const S = 3;
    const sessions = [
        {c: 'robot', hue: HUES[1], view: 'working', label: 'api-server  ·  trabajando  ·  2 min', agent: 'Claude'},
        {c: 'michi', hue: HUES[0], view: 'permission', label: 'web-app  ·  pide permiso (Bash)  ·  12 s', agent: 'Claude'},
        {c: 'pulpo', hue: HUES[4], view: 'asking', label: 'infra  ·  te pregunta (AskUserQuestion)  ·  1 min', agent: 'Claude'},
        {c: 'seta', hue: HUES[3], view: 'done', label: 'docs  ·  terminado  ·  4 min', agent: 'OpenCode'},
        {c: 'blob', hue: HUES[2], view: 'asleep', label: 'scripts  ·  durmiendo  ·  1 h 5 min', agent: 'Claude'},
    ];
    const W = 780, BAR = 50, GAP = 4;
    const parts = [];
    let x = 0;
    const pets = sessions.map(s => {
        const p = pet(look(s.c, s.hue), s.view, 0, 0, S);
        x += p.w + GAP;
        return p;
    });
    const total = x - GAP;
    let px = W - 24 - total;
    const startX = px;
    for (const p of pets) {
        const y = (BAR - p.h) / 2;
        parts.push(p.svg.replace('translate(0 0)', `translate(${px} ${y})`));
        px += p.w + GAP;
    }

    const font = `font-family="Cantarell, 'Noto Sans', 'Segoe UI', system-ui, sans-serif"`;
    const ROW = 36, MX = 290, MW = W - MX - 12, MY = BAR + 8, MH = sessions.length * ROW + 16;
    const menu = [
        `<rect x="${MX}" y="${MY}" width="${MW}" height="${MH}" rx="12" fill="#2a2a2e" stroke="#3a3a40"/>`,
        // the little arrow that points at the indicator
        `<path d="M${startX + total / 2 - 8} ${MY + 0.5} l8 -8 l8 8z" fill="#2a2a2e"/>`,
        `<rect x="${MX + 6}" y="${MY + 8 + ROW}" width="${MW - 12}" height="${ROW}" rx="8" fill="#3a3a40"/>`,
        ...sessions.map((s, i) => {
            const ty = MY + 8 + i * ROW + ROW / 2 + 5;
            return `<text x="${MX + 20}" y="${ty}" ${font} font-size="14" fill="#ececec">${s.label}</text>`
                + `<text x="${MX + MW - 20}" y="${ty}" ${font} font-size="11.5" fill="#9a9aa2" text-anchor="end">${s.agent}</text>`;
        }),
    ];

    const H = MY + MH + 12;
    write('topbar.svg', svgDoc(W, H, [
        `<rect width="${W}" height="${H}" rx="14" fill="#141416"/>`,
        `<rect width="${W}" height="${BAR}" rx="14" fill="#000"/><rect y="${BAR - 14}" width="${W}" height="14" fill="#000"/>`,
        `<text x="${W / 2}" y="${BAR / 2 + 5}" ${font} font-size="14" font-weight="bold" fill="#ececec" text-anchor="middle">11 nov 10:42</text>`,
        `<g shape-rendering="geometricPrecision">${menu.join('')}</g>`,
        ...parts,
    ].join('')));
}

// --- Characters gallery -------------------------------------------------------
{
    uid = 0;
    const S = 5, M = 14, GAP = 14;
    const names = Object.keys(CHARACTERS);
    const font = `font-family="ui-monospace, 'DejaVu Sans Mono', monospace"`;
    const parts = [];
    let x = M, h = 0;
    names.forEach((n, i) => {
        const p = pet(look(n, HUES[i % HUES.length]), 'idle', x, M, S);
        parts.push(p.svg, `<text x="${x + p.w / 2}" y="${M + p.h + 18}" ${font} font-size="12" fill="#9a9aa2" text-anchor="middle">${n}</text>`);
        x += p.w + GAP;
        h = p.h;
    });
    const W = x - GAP + M, H = M + h + 30;
    write('characters.svg', svgDoc(W, H, `<rect width="${W}" height="${H}" rx="12" fill="${PANEL}"/>${parts.join('')}`));
}

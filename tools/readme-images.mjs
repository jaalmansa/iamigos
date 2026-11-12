#!/usr/bin/env -S node --no-warnings
// Generates the README images (animated SVGs) straight from the extension's sprites:
//   docs/img/states/<state>.svg   one per state, animated like in the top bar
//   docs/img/topbar.svg           top bar with several sessions, the whip + the session menu
//   docs/img/characters.svg       every character
//
//   node tools/readme-images.mjs
//
// The frames come from paint.js, the same code the extension draws with.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CHARACTERS, HUES, SPRITE_W, SPRITE_H, WHIP_ICON} from '../gnome-extension/iamigos@iamigos/sprites.js';
import {BOX, COLS, ROWS, lookOf, petPixels, spritePixels} from '../gnome-extension/iamigos@iamigos/paint.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'img');
const TICK_MS = 200;                      // same as the extension
// How many ticks until the animation repeats.
const PERIOD = {working: 8, compacting: 8, background: 16, asleep: 10, permission: 6, asking: 6};

const hex = c => `#${c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

// Pixels [x, y, colour, alpha] of one frame, split into the body and the status
// indicator so each layer can be animated on its own.
function frame(look, view, f) {
    const {body, over} = petPixels(look, view, f);
    const toHex = ([x, y, rgb, a]) => [x, y, hex(rgb), a];
    return {body: body.map(toHex), over: over.map(toHex)};
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

const look = (character, hue) => lookOf({character, hue});

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
// Mini critter (a subagent): the same sprite, smaller, without the state box.
function mini(lk, x, y, s) {
    return spritePixels(lk, lk.palette, 1, false)
        .map(([gx, gy, rgb]) => `<rect x="${x + gx * s}" y="${y + gy * s}" width="${s}" height="${s}" fill="${hex(rgb)}"/>`)
        .join('');
}

{
    uid = 0;
    const S = 3;
    const sessions = [
        {c: 'robot', hue: HUES[1], view: 'working', subs: 2, agent: 'Claude',
            title: 'api-server  ·  working  ·  2 min',
            details: 'Bash  ·  turn 3 min  ·  ⎇ main  ·  84k context (opus-5-5)  ·  2 subagents: Explore, Plan'},
        {c: 'cat', hue: HUES[0], view: 'permission', agent: 'Claude',
            title: 'web-app  ·  needs permission (Bash)  ·  12 s',
            details: 'turn 1 min  ·  ⎇ feature/login  ·  41k context (sonnet-5-5)'},
        {c: 'octopus', hue: HUES[4], view: 'asking', agent: 'Claude',
            title: 'infra  ·  asking you (AskUserQuestion)  ·  1 min',
            details: 'turn 4 min  ·  ⎇ main  ·  126k context (opus-5-5)'},
        {c: 'mushroom', hue: HUES[3], view: 'done', agent: 'OpenCode',
            title: 'docs  ·  done  ·  4 min',
            details: 'last turn 2 min  ·  ⎇ docs  ·  18k context'},
        {c: 'blob', hue: HUES[2], view: 'asleep', agent: 'Claude',
            title: 'scripts  ·  asleep  ·  1 h 5 min',
            details: 'last turn 6 min  ·  ⎇ main'},
    ];
    const W = 780, BAR = 50, GAP = 4, MS = 1.5;   // MS: mini critter pixel
    const miniW = (SPRITE_W + 1) * MS;
    const pets = sessions.map(s => ({s, p: pet(look(s.c, s.hue), s.view, 0, 0, S)}));
    const width = ({s, p}) => p.w + (s.subs ? miniW * Math.ceil(s.subs / 2) : 0);
    const whipW = (SPRITE_W + 1) * S;   // the whip, to the right of the critters
    const total = pets.reduce((sum, item) => sum + width(item) + GAP, -GAP) + GAP + whipW;
    const parts = [];
    let px = W - 24 - total;
    const startX = px;
    for (const item of pets) {
        const {s, p} = item;
        const y = (BAR - p.h) / 2;
        parts.push(p.svg.replace('translate(0 0)', `translate(${px} ${y})`));
        for (let i = 0; i < (s.subs ?? 0); i++) {
            const mx = px + p.w + Math.floor(i / 2) * miniW;
            const my = y + 1 + (i % 2) * (SPRITE_H + 1) * MS;
            parts.push(mini(look(s.c, s.hue), mx, my, MS));
        }
        px += width(item) + GAP;
    }
    const whipY = (BAR - (SPRITE_H + 1) * S) / 2 + S;
    WHIP_ICON.rows.forEach((row, gy) => [...row].forEach((ch, gx) => {
        if (ch !== '.' && ch !== 'x')      // x: the spark, only while it cracks
            parts.push(`<rect x="${px + S + gx * S}" y="${whipY + gy * S}" width="${S}" height="${S}" fill="${WHIP_ICON.colors[ch]}"/>`);
    }));

    const font = `font-family="Cantarell, 'Noto Sans', 'Segoe UI', system-ui, sans-serif"`;
    const ROW = 50, PAD = 8, PREFS = 40, STATS = 34;
    const MX = 250, MW = W - MX - 12, MY = BAR + 8;
    const MH = PAD + sessions.length * ROW + 9 + STATS + PREFS + PAD;
    const sepY = MY + PAD + sessions.length * ROW + 4;
    const menu = [
        `<rect x="${MX}" y="${MY}" width="${MW}" height="${MH}" rx="12" fill="#2a2a2e" stroke="#3a3a40"/>`,
        // the little arrow that points at the indicator
        `<path d="M${startX + (total - whipW) / 2 - 8} ${MY + 0.5} l8 -8 l8 8z" fill="#2a2a2e"/>`,
        // hovered row
        `<rect x="${MX + 6}" y="${MY + PAD + ROW}" width="${MW - 12}" height="${ROW}" rx="8" fill="#3a3a40"/>`,
        ...sessions.map((s, i) => {
            const top = MY + PAD + i * ROW;
            return `<text x="${MX + 20}" y="${top + 21}" ${font} font-size="14" fill="#ececec">${s.title}</text>`
                + `<text x="${MX + 20}" y="${top + 39}" ${font} font-size="11.5" fill="#9a9aa2">${s.details}</text>`
                + `<text x="${MX + MW - 20}" y="${top + 30}" ${font} font-size="11.5" fill="#9a9aa2" text-anchor="end">${s.agent}</text>`;
        }),
        `<rect x="${MX + 14}" y="${sepY}" width="${MW - 28}" height="1" fill="#45454c"/>`,
        `<text x="${MX + 20}" y="${sepY + 5 + STATS / 2 + 5}" ${font} font-size="14" fill="#8a8a92">Lashes: 340  ·  best combo x27</text>`,
        `<text x="${MX + 20}" y="${sepY + 5 + STATS + PREFS / 2 + 5}" ${font} font-size="14" fill="#ececec">Preferences</text>`,
    ];

    const H = MY + MH + 12;
    write('topbar.svg', svgDoc(W, H, [
        `<rect width="${W}" height="${H}" rx="14" fill="#141416"/>`,
        `<rect width="${W}" height="${BAR}" rx="14" fill="#000"/><rect y="${BAR - 14}" width="${W}" height="14" fill="#000"/>`,
        `<text x="${W / 2 - 120}" y="${BAR / 2 + 5}" ${font} font-size="14" font-weight="bold" fill="#ececec" text-anchor="middle">Nov 11  10:42</text>`,
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

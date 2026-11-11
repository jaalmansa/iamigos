#!/usr/bin/env -S node --no-warnings
// Genera docs/sprites.html con todos los personajes × estados y la paleta de colores,
// leyendo los diseños directamente de la extensión (sprites.js).
//   node tools/preview.mjs   →  abre docs/sprites.html en el navegador
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CHARACTERS, HUES, BADGES, SPRITE_W, makePalette, greyPalette, lowestEyeRows, shade}
    from '../gnome-extension/iamigos@iamigos/sprites.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'sprites.html');
const PX = 6;
const STATES = ['idle', 'working', 'permission', 'asking', 'compacting', 'done', 'asleep', 'error', 'closed'];
const BG = {permission: '#f07b1d', asking: '#5a2f12'};
const BORDER = {permission: '#f07b1d', asking: '#f07b1d', done: '#4cd964', error: '#ff4d4d'};
const rgb = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;

function pet(name, hue, state) {
    const grid = shade(CHARACTERS[name]);
    const eyes = lowestEyeRows(grid);
    const pal = state === 'closed' ? greyPalette() : makePalette(hue);
    const shut = state === 'asleep' || state === 'closed';
    const cols = SPRITE_W + 3;
    const r = [];
    grid.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === '.')
            return;
        const k = ch === 'e' && shut ? (eyes[x] === y ? 'd' : 'b') : ch;
        r.push(`<rect x="${x * PX}" y="${(y + 1) * PX}" width="${PX}" height="${PX}" fill="${rgb(pal[k])}"${state === 'closed' ? ' opacity=".6"' : ''}/>`);
    }));
    const badge = BADGES[state];
    if (badge) {
        const w = badge.rows[0].length;
        badge.rows.forEach((row, y) => [...row].forEach((ch, x) => {
            if (ch === 'x')
                r.push(`<rect x="${(cols - w + x) * PX}" y="${(y + 1) * PX}" width="${PX}" height="${PX}" fill="${badge.color}"/>`);
        }));
    }
    if (state === 'working' || state === 'compacting') {
        for (let i = 0; i < 3; i++)
            r.push(`<rect x="${(cols - 5 + i * 2) * PX}" y="0" width="${PX}" height="${PX}" fill="${state === 'working' ? '#fff' : '#bf99ff'}"/>`);
    }
    const W = cols * PX, H = (grid.length + 1) * PX;
    return `<div class="pet" style="background:${BG[state] ?? 'transparent'};border-color:${BORDER[state] ?? 'transparent'}">
<svg width="${W}" height="${H}" shape-rendering="crispEdges">${r.join('')}</svg></div>`;
}

const names = Object.keys(CHARACTERS);
const stateTable = `<table><tr><th></th>${STATES.map(s => `<th>${s}</th>`).join('')}</tr>
${names.map((n, i) => `<tr><th>${n}</th>${STATES.map(s => `<td>${pet(n, HUES[i * 2 % HUES.length], s)}</td>`).join('')}</tr>`).join('\n')}</table>`;
const colorTable = `<table><tr><th></th>${HUES.map(h => `<th><code>${h}</code></th>`).join('')}</tr>
${names.map(n => `<tr><th>${n}</th>${HUES.map(h => `<td>${pet(n, h, 'idle')}</td>`).join('')}</tr>`).join('\n')}</table>`;

const html = `<!doctype html><meta charset="utf-8"><title>IAmigos · sprites</title>
<style>
body{background:#1e1e24;color:#ddd;font:14px system-ui,sans-serif;margin:24px}
h1{font-size:20px}h2{font-size:15px;margin-top:32px;color:#aaa}
table{border-collapse:separate;border-spacing:10px}th{font-weight:500;color:#999;text-align:center}
.pet{display:inline-block;border:3px solid transparent;border-radius:12px;padding:4px}
</style>
<h1>IAmigos · sprites</h1>
<p>Generado desde <code>gnome-extension/iamigos@iamigos/sprites.js</code>. Edita las rejillas y vuelve a ejecutar <code>node tools/preview.mjs</code>.</p>
<h2>Personajes × estados</h2>${stateTable}
<h2>Personajes × colores</h2>${colorTable}`;

mkdirSync(dirname(OUT), {recursive: true});
writeFileSync(OUT, html);
console.log(`→ ${OUT}`);

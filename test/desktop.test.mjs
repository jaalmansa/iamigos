// The desktop app (macOS/Windows), everything that does not need Electron:
// drawing, sessions, preferences, menu, process tables and git.
// Needs desktop/src/shared/ (npm test runs desktop/scripts/sync-shared.mjs first).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {afterEach, beforeEach, describe, test} from 'node:test';

import {Canvas, encodePng, hitTest, layoutStrip, pixelFor, renderIcon, renderStrip, textPixels}
    from '../desktop/src/raster.mjs';
import {DEFAULTS, Settings} from '../desktop/src/settings.mjs';
import {resolveLanguage, setLanguage, t} from '../desktop/src/i18n.mjs';
import {SessionStore, stateDir} from '../desktop/src/sessions.mjs';
import {menuTemplate} from '../desktop/src/menu.mjs';
import {appBundleOf, parsePs, pickTerminalApp, withToolPath} from '../desktop/src/platform/posix.mjs';
import {focusScript, parseCim} from '../desktop/src/platform/win32.mjs';
import {cachedTable, isAlive} from '../desktop/src/platform/common.mjs';
import {gitBranch} from '../desktop/src/git.mjs';
import {makeLook, ROWS} from '../gnome-extension/iamigos@iamigos/paint.js';

let tmp;
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iamigos-desktop-'));
});
afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

// Width, height and RGBA pixels of a PNG made by encodePng (no filters).
function decodePng(png) {
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const idat = [];
    for (let i = 8; i < png.length;) {
        const len = png.readUInt32BE(i);
        if (png.toString('latin1', i + 4, i + 8) === 'IDAT')
            idat.push(png.subarray(i + 8, i + 8 + len));
        i += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const at = (x, y) => [...raw.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 5 + x * 4)];
    return {width, height, at};
}

const pet = (name, view = 'idle', extra = {}) =>
    ({name, look: makeLook(`/w/${name}`), view, urgent: false, subs: 0, whipAt: -Infinity, rushUntil: -1, ...extra});

describe('raster', () => {
    test('PNG round trip', () => {
        const c = new Canvas(3, 2);
        c.blend(1, 1, [1, 0, 0], 1);
        c.blend(2, 0, [0, 0, 1], 0.5);
        const img = decodePng(encodePng(c.width, c.height, c.data));
        assert.deepEqual([img.width, img.height], [3, 2]);
        assert.deepEqual(img.at(1, 1), [255, 0, 0, 255]);
        assert.deepEqual(img.at(2, 0), [0, 0, 255, 128]);
        assert.deepEqual(img.at(0, 0), [0, 0, 0, 0]);
    });

    test('blending over an opaque pixel keeps it opaque', () => {
        const c = new Canvas(1, 1);
        c.blend(0, 0, [0, 0, 0], 1);
        c.blend(0, 0, [1, 1, 1], 0.5);
        assert.deepEqual([...c.data], [128, 128, 128, 255]);
    });

    test('the sprite pixel shrinks to fit the menu bar', () => {
        assert.equal(pixelFor(2, 1), 2);
        assert.equal(pixelFor(2, 2), 4);
        assert.equal(pixelFor(2, 2, 44), 3, '22 pt on a Retina screen');
        assert.equal(pixelFor(4, 1, 22), 1);
        assert.equal(pixelFor(1, 1, 5), 1, 'never below one pixel');
    });

    test('layout: critters, +N and the whip, left to right, with gaps', () => {
        const layout = layoutStrip({pets: [pet('a'), pet('b', 'working', {subs: 2})], hidden: 3, whip: true, p: 2, scale: 1});
        assert.deepEqual(layout.items.map(i => i.kind), ['pet', 'pet', 'more', 'whip']);
        assert.ok(layout.items[1].w > layout.items[0].w, 'the minis make room');
        for (let i = 1; i < layout.items.length; i++)
            assert.ok(layout.items[i].x >= layout.items[i - 1].x + layout.items[i - 1].w);
        assert.equal(layout.height, ROWS * 2 + 2);
        assert.equal(layout.items[2].text, '+3');
    });

    test('clicks land on the right item', () => {
        const {items} = layoutStrip({pets: [pet('a'), pet('b')], whip: true, p: 2, scale: 1});
        assert.equal(hitTest(items, items[0].x + 1).name, 'a');
        assert.equal(hitTest(items, items[1].x + items[1].w - 1).name, 'b');
        assert.equal(hitTest(items, items[2].x + 2).kind, 'whip');
        assert.equal(hitTest(items, items[1].x - 1), null, 'between critters');
    });

    test('a frame is a PNG of the layout size, with the permission background', () => {
        const out = renderStrip({pets: [pet('a', 'permission')], whip: false, p: 2, scale: 1}, 0);
        const img = decodePng(out.png);
        assert.deepEqual([img.width, img.height], [out.width, out.height]);
        assert.deepEqual(img.at(out.width >> 1, 1).slice(0, 3), [0xf0, 0x7b, 0x1d], 'orange box');
    });

    test('the +N font has every digit', () => {
        assert.equal(textPixels('+0123456789').length > 0, true);
        for (const d of '0123456789')
            assert.ok(textPixels(d).length >= 5, d);
    });

    test('tray icon: a square, empty without sessions', () => {
        const empty = decodePng(renderIcon(null, 0, 16));
        assert.deepEqual([empty.width, empty.height], [16, 16]);
        assert.deepEqual(empty.at(8, 8), [0, 0, 0, 0]);
        const icon = decodePng(renderIcon(pet('a', 'asking'), 0, 32));
        assert.equal(icon.width, 32);
        assert.equal(icon.at(0, 16)[3], 255, 'brown background for asking');
    });
});

describe('settings', () => {
    test('defaults, persisted changes, and bad values ignored', () => {
        const file = path.join(tmp, 'settings.json');
        const s = new Settings(file);
        assert.equal(s.get('pixel-size'), DEFAULTS['pixel-size']);
        const seen = [];
        s.onChange((k, v) => seen.push([k, v]));
        s.set('pixel-size', 3);
        s.set('pixel-size', 3);
        assert.deepEqual(seen, [['pixel-size', 3]]);
        assert.equal(new Settings(file).get('pixel-size'), 3);

        fs.writeFileSync(file, JSON.stringify({'pixel-size': 'huge', 'show-whip': false, 'strip-position': {x: 1, y: 2}}));
        const again = new Settings(file);
        assert.equal(again.get('pixel-size'), 2);
        assert.equal(again.get('show-whip'), false);
        assert.deepEqual(again.get('strip-position'), {x: 1, y: 2});
    });

    test('a corrupt file means the defaults', () => {
        const file = path.join(tmp, 'settings.json');
        fs.writeFileSync(file, '{nope');
        assert.equal(new Settings(file).get('language'), 'auto');
    });
});

describe('i18n', () => {
    test('auto follows the system languages', () => {
        assert.equal(resolveLanguage('auto', ['es-ES', 'en-US']), 'es');
        assert.equal(resolveLanguage('auto', ['fr-FR']), 'en');
        assert.equal(resolveLanguage('en', ['es-ES']), 'en');
        setLanguage('es');
        assert.equal(t('menu.more', 3), '+3 más');
        setLanguage('en');
    });
});

describe('sessions', () => {
    const settings = new Map(Object.entries(DEFAULTS));
    const cfg = {get: k => settings.get(k)};
    const write = (name, data) => fs.writeFileSync(path.join(tmp, name), JSON.stringify(data));
    const NOW = Date.now() / 1000;
    const alive = new Set([100, 200]);
    const platform = {isAlive: pid => !pid || alive.has(pid), backgroundShells: pid => (pid === 200 ? 1 : 0)};

    test('the state folder is the same as the agents\' on every platform', () => {
        assert.equal(stateDir({XDG_STATE_HOME: '/x'}), path.join('/x', 'iamigos', 'sessions'));
        assert.equal(stateDir({}), path.join(os.homedir(), '.local', 'state', 'iamigos', 'sessions'));
    });

    test('views, order, background shells and urgent sessions', () => {
        write('claude-a.json', {agent: 'claude', state: 'working', pid: 100, cwd: '/w/a', project: 'a', started: 2, since: NOW});
        write('claude-b.json', {agent: 'claude', state: 'done', pid: 200, cwd: '/w/b', project: 'b', started: 1, since: NOW});
        write('opencode-c.json', {agent: 'opencode', state: 'permission', pid: 100, cwd: '/w/a', project: 'a', started: 3, since: NOW - 999});
        write('broken.json', '{');
        fs.writeFileSync(path.join(tmp, 'broken.json'), '{');
        const store = new SessionStore(tmp, platform);
        store.reload();
        const snap = store.snapshot(NOW, cfg);
        assert.deepEqual(snap.order, ['claude-b.json', 'claude-a.json', 'opencode-c.json']);
        assert.equal(snap.rows.get('claude-b.json').view, 'background');
        assert.equal(snap.rows.get('opencode-c.json').urgent, true);
        assert.equal(snap.rows.get('opencode-c.json').ordinal, 1, 'second session of /w/a');
    });

    test('dead sessions from before start are dropped at once, new ones linger', () => {
        write('claude-old.json', {agent: 'claude', state: 'working', pid: 999, started: 1, since: NOW});
        const store = new SessionStore(tmp, platform);
        store.reload();
        assert.deepEqual(store.snapshot(NOW, cfg).order, []);
        assert.ok(!fs.existsSync(path.join(tmp, 'claude-old.json')), 'its file is removed');

        write('claude-new.json', {agent: 'claude', state: 'working', pid: 998, started: 1, since: NOW});
        store.reload();
        assert.equal(store.snapshot(NOW, cfg).rows.get('claude-new.json').view, 'closed');
        assert.deepEqual(store.snapshot(NOW + 31, cfg).order, []);
    });

    test('hidden agents and the +N counter', () => {
        for (let i = 0; i < 5; i++)
            write(`claude-${i}.json`, {agent: 'claude', state: 'idle', pid: 0, started: i, since: NOW});
        write('opencode-x.json', {agent: 'opencode', state: 'idle', pid: 0, started: 9, since: NOW});
        settings.set('max-pets', 3);
        settings.set('show-opencode', false);
        const store = new SessionStore(tmp, platform);
        store.reload();
        const snap = store.snapshot(NOW, cfg);
        settings.set('max-pets', DEFAULTS['max-pets']);
        settings.set('show-opencode', true);
        assert.equal(snap.order.length, 5);
        assert.equal(snap.inBar.length, 3);
        assert.equal(snap.hidden, 2);
    });
});

describe('menu', () => {
    const settings = {values: {...DEFAULTS}, get(k) {
        return this.values[k];
    }, set(k, v) {
        this.values[k] = v;
    }};
    const s = {agent: 'claude', state: 'working', detail: 'Bash', project: 'R&D', cwd: '/w/rd', since: 0, turn_started: 1};
    const ctx = isMac => ({
        snapshot: {order: ['x'], rows: new Map([['x', {s, view: 'working', urgent: false}]])},
        now: 120, settings, t, isMac, branchOf: () => 'main',
        loginItem: {get: () => true, set: () => {}},
        actions: {focus: () => {}, quit: () => {}, resetStrip: () => {}},
    });

    test('macOS: details as a sublabel, no strip position', () => {
        const items = menuTemplate(ctx(true));
        assert.match(items[0].label, /^R&D {2}· {2}working {2}· {2}2 min {3}Claude$/);
        assert.equal(items[0].sublabel, 'Bash  ·  turn 1 min  ·  ⎇ main');
        const prefs = items.find(i => i.submenu).submenu;
        assert.ok(!prefs.some(i => i.label === t('app.stripPosition')));
    });

    test('Windows: details on a second line, & escaped, strip position', () => {
        const items = menuTemplate(ctx(false));
        assert.match(items[0].label, /^R&&D/);
        assert.equal(items[1].enabled, false);
        assert.match(items[1].label, /Bash/);
        const prefs = items.find(i => i.submenu).submenu;
        assert.ok(prefs.some(i => i.label === t('app.stripPosition')));
    });

    test('preferences change the settings', () => {
        const prefs = menuTemplate(ctx(true)).find(i => i.submenu).submenu;
        prefs.find(i => i.label === t('prefs.pixelSize')).submenu.find(i => i.label === '4').click();
        assert.equal(settings.get('pixel-size'), 4);
        prefs.find(i => i.label === t('prefs.whip')).click();
        assert.equal(settings.get('show-whip'), false);
    });

    test('empty, and the whip stats', () => {
        settings.values['whip-total'] = 12;
        settings.values['show-whip'] = true;
        const items = menuTemplate({...ctx(true), snapshot: {order: [], rows: new Map()}});
        assert.equal(items[0].label, t('menu.empty'));
        assert.ok(items.some(i => i.label === t('whip.stats', 12, 0)));
    });
});

describe('platform', () => {
    test('ps output', () => {
        const procs = parsePs(`  1     0 /sbin/launchd
  501   1 /Applications/iTerm.app/Contents/MacOS/iTerm2 -psn
  600 501 -zsh
  700 600 /Users/me/.local/bin/claude
  garbage
`);
        assert.deepEqual(procs.map(p => p.pid), [1, 501, 600, 700]);
        assert.deepEqual(procs[2], {pid: 600, ppid: 501, argv: ['-zsh']});
        assert.equal(appBundleOf(procs[1].argv), '/Applications/iTerm.app');
        assert.equal(appBundleOf(procs[3].argv), null);
        assert.deepEqual(pickTerminalApp(procs, {pid: 700}), {pid: 501, app: '/Applications/iTerm.app'});
    });

    test('inside tmux the terminal is the client\'s', () => {
        const procs = parsePs(`  1 0 /sbin/launchd
  50 1 tmux new -d
  700 50 claude
  501 1 /Applications/Ghostty.app/Contents/MacOS/ghostty
  600 501 tmux attach
  800 1 /Applications/Safari.app/Contents/MacOS/Safari
`);
        assert.deepEqual(pickTerminalApp(procs, {pid: 700, mux: {kind: 'tmux'}}), {pid: 501, app: '/Applications/Ghostty.app'});
        assert.deepEqual(pickTerminalApp(procs, {pid: 999}), {pid: 501, app: '/Applications/Ghostty.app'},
            'unknown process: any terminal app, not Safari');
    });

    test('Homebrew and friends are added to PATH once', () => {
        const env = withToolPath({PATH: '/usr/bin:/opt/homebrew/bin'}, '/Users/me');
        const parts = env.PATH.split(':');
        assert.equal(parts[0], '/usr/bin');
        assert.equal(parts.filter(p => p === '/opt/homebrew/bin').length, 1);
        assert.ok(parts.includes('/Users/me/.local/bin'));
    });

    test('Win32_Process JSON', () => {
        const procs = parseCim(JSON.stringify([
            {ProcessId: 4, ParentProcessId: 0, Name: 'System', CommandLine: null},
            {ProcessId: 10, ParentProcessId: 4, Name: 'bash.exe', CommandLine: 'bash -c source /c/Users/me/.claude/shell-snapshots/x.sh'},
        ]));
        assert.deepEqual(procs[0], {pid: 4, ppid: 0, argv: ['System']});
        assert.equal(procs[1].argv[1].includes('shell-snapshots'), true);
        assert.equal(parseCim(JSON.stringify({ProcessId: 1, ParentProcessId: 0, Name: 'x'})).length, 1, 'a single object');
        assert.equal(parseCim('not json'), null);
    });

    test('the focus script quotes the project name', () => {
        const script = focusScript([700, 600, 501], "it's");
        assert.match(script, /@\(700, 600, 501\)/);
        assert.match(script, /\$title = 'it''s'/);
    });

    test('isAlive and the cached process table', async () => {
        assert.equal(isAlive(process.pid), true);
        assert.equal(isAlive(0), true);
        assert.equal(isAlive(2 ** 22 + 12345), false);
        let reads = 0;
        const table = cachedTable(async () => [{pid: ++reads}], 60_000);
        await table.refresh();
        await table.refresh();
        assert.equal(reads, 1);
        await table.refresh(true);
        assert.deepEqual(table.get(), [{pid: 2}]);
    });
});

describe('git', () => {
    test('branch, detached HEAD and worktrees', () => {
        const repo = path.join(tmp, 'repo');
        fs.mkdirSync(path.join(repo, '.git'), {recursive: true});
        fs.mkdirSync(path.join(repo, 'src', 'deep'), {recursive: true});
        fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
        assert.equal(gitBranch(path.join(repo, 'src', 'deep')), 'feature/x');
        fs.writeFileSync(path.join(repo, '.git', 'HEAD'), '0123456789abcdef\n');
        assert.equal(gitBranch(repo), '0123456');

        const wt = path.join(tmp, 'wt');
        const wtGit = path.join(repo, '.git', 'worktrees', 'wt');
        fs.mkdirSync(wtGit, {recursive: true});
        fs.mkdirSync(wt);
        fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/other\n');
        fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
        assert.equal(gitBranch(wt), 'other');
        assert.equal(gitBranch(path.parse(tmp).root), null);
    });
});

// Installer tests (bin/iamigos.mjs).
//
// Each test runs the installer with a throwaway HOME and fake versions of every
// GNOME command it calls (gnome-extensions, gsettings, glib-compile-schemas,
// gnome-shell), first in PATH, so the real desktop is never touched.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'iamigos.mjs');
const UUID = 'iamigos@iamigos';

let home, fake, gsettingsDb;

// gsettings backed by a plain file: key=value lines.
const FAKE_GSETTINGS = `#!/bin/sh
db="$IAMIGOS_TEST_GSETTINGS"
[ -f "$db" ] || printf "enabled-extensions=['other@x']\\ndisabled-extensions=[]\\ndisable-user-extensions=false\\n" > "$db"
if [ "$1" = get ]; then
  v=$(grep "^$3=" "$db" | cut -d= -f2-); [ "$v" = "[]" ] && v="@as []"; echo "$v"
else
  grep -v "^$3=" "$db" > "$db.n"; echo "$3=$4" >> "$db.n"; mv "$db.n" "$db"
fi
`;

function writeFake(name, body) {
    const p = path.join(fake, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
}

function run(...args) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: {
            PATH: `${fake}:${process.env.PATH}`,
            HOME: home,
            XDG_DATA_HOME: path.join(home, '.local', 'share'),
            XDG_CONFIG_HOME: path.join(home, '.config'),
            IAMIGOS_TEST_GSETTINGS: gsettingsDb,
        },
    });
    return {code: r.status, out: r.stdout + r.stderr};
}

const settingsPath = () => path.join(home, '.claude', 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
const extDir = () => path.join(home, '.local', 'share', 'gnome-shell', 'extensions', UUID);
const hookPath = () => path.join(home, '.local', 'bin', 'iamigos-hook');
const gsetting = key => fs.readFileSync(gsettingsDb, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];

// Events that point at our hook in settings.json.
function hookedEvents(cfg) {
    return Object.entries(cfg.hooks ?? {})
        .filter(([, groups]) => groups.some(g => g.hooks.some(h => h.command === hookPath())))
        .map(([ev]) => ev);
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'iamigos-home-'));
    fake = path.join(home, 'fakebin');
    gsettingsDb = path.join(home, 'gsettings.db');
    fs.mkdirSync(fake);
    fs.mkdirSync(path.join(home, '.claude'));
    // The shell does not know the extension yet (new install on Wayland).
    writeFake('gnome-extensions', '#!/bin/sh\nexit 2\n');
    writeFake('gsettings', FAKE_GSETTINGS);
    writeFake('glib-compile-schemas', '#!/bin/sh\ntouch "$1/gschemas.compiled"\n');
    writeFake('gnome-shell', '#!/bin/sh\necho "GNOME Shell 50.1"\n');
});

afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

describe('install', () => {
    test('copies the extension and the hook, and compiles the schema', () => {
        const r = run('install');
        assert.equal(r.code, 0, r.out);
        assert.ok(fs.existsSync(path.join(extDir(), 'extension.js')));
        assert.ok(fs.existsSync(path.join(extDir(), 'schemas', 'gschemas.compiled')));
        assert.ok(!fs.lstatSync(extDir()).isSymbolicLink(), 'should be a copy, not a link');
        assert.equal(fs.statSync(hookPath()).mode & 0o111, 0o111, 'hook must be executable');
    });

    test('registers the hook for every event, once', () => {
        run('install');
        run('install');   // idempotent
        const cfg = readSettings();
        const events = hookedEvents(cfg);
        assert.ok(events.includes('Stop') && events.includes('SubagentStop'));
        for (const ev of events) {
            const ours = cfg.hooks[ev].filter(g => g.hooks.some(h => h.command === hookPath()));
            assert.equal(ours.length, 1, `${ev} registered more than once`);
        }
    });

    test('keeps the user\'s own settings and hooks, and leaves a backup', () => {
        const before = {model: 'opus', hooks: {Stop: [{matcher: '', hooks: [{type: 'command', command: 'mine'}]}]}};
        fs.writeFileSync(settingsPath(), JSON.stringify(before));
        run('install');
        const cfg = readSettings();
        assert.equal(cfg.model, 'opus');
        assert.ok(cfg.hooks.Stop.some(g => g.hooks.some(h => h.command === 'mine')));
        assert.deepEqual(JSON.parse(fs.readFileSync(`${settingsPath()}.iamigos.bak`, 'utf8')), before);
    });

    test('refuses to touch an invalid settings.json', () => {
        fs.writeFileSync(settingsPath(), '{ not json');
        const r = run('install');
        assert.notEqual(r.code, 0);
        assert.equal(fs.readFileSync(settingsPath(), 'utf8'), '{ not json');
    });

    test('marks the extension as enabled without duplicating it', () => {
        fs.writeFileSync(gsettingsDb, "enabled-extensions=['other@x']\ndisabled-extensions=['iamigos@iamigos']\n");
        run('install');
        run('install');
        assert.equal(gsetting('enabled-extensions'), "['other@x', 'iamigos@iamigos']");
        assert.equal(gsetting('disabled-extensions'), '[]');
    });

    test('installs the OpenCode plugin only if OpenCode is there', () => {
        const plugin = path.join(home, '.config', 'opencode', 'plugins', 'iamigos.ts');
        run('install');
        assert.ok(!fs.existsSync(plugin));
        fs.mkdirSync(path.join(home, '.config', 'opencode'), {recursive: true});
        run('install');
        assert.ok(fs.existsSync(plugin));
    });

    test('--link symlinks to the repository', () => {
        run('install', '--link');
        assert.equal(fs.readlinkSync(extDir()), path.join(ROOT, 'gnome-extension', UUID));
        assert.equal(fs.readlinkSync(hookPath()), path.join(ROOT, 'hooks', 'iamigos-hook'));
    });

    test('replaces an old symlink with a copy', () => {
        run('install', '--link');
        run('install');
        assert.ok(!fs.lstatSync(extDir()).isSymbolicLink());
        assert.ok(fs.existsSync(path.join(ROOT, 'gnome-extension', UUID, 'extension.js')),
            'must not delete the repository through the old link');
    });
});

describe('uninstall', () => {
    test('removes everything it added and nothing else', () => {
        const before = {model: 'opus', hooks: {Stop: [{matcher: '', hooks: [{type: 'command', command: 'mine'}]}]}};
        fs.writeFileSync(settingsPath(), JSON.stringify(before));
        fs.mkdirSync(path.join(home, '.config', 'opencode'), {recursive: true});
        run('install');
        const r = run('uninstall');
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(readSettings(), before);
        assert.ok(!fs.existsSync(extDir()));
        assert.ok(!fs.existsSync(hookPath()));
        assert.ok(!fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'iamigos.ts')));
        assert.equal(gsetting('enabled-extensions'), "['other@x']");
    });

    test('works when nothing is installed', () => {
        const r = run('uninstall');
        assert.equal(r.code, 0, r.out);
    });
});

describe('cli', () => {
    test('status reports what is installed', () => {
        run('install');
        const r = run('status');
        assert.equal(r.code, 0);
        assert.match(r.out, /copied/);
        assert.match(r.out, /15\/15/);
    });

    test('unknown command exits with an error', () => {
        assert.equal(run('nope').code, 1);
        assert.equal(run('--help').code, 0);
    });
});

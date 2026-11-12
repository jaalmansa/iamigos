// Installer tests (bin/iamigos.mjs).
//
// Each test runs the installer with a throwaway HOME and fake versions of every
// GNOME command it calls (gnome-extensions, gsettings, glib-compile-schemas,
// gnome-shell), first in PATH, so the real desktop is never touched.
// IAMIGOS_PLATFORM makes it behave as on Linux, macOS or Windows; the macOS and
// Windows app comes from a local folder (IAMIGOS_APP_SOURCE) and is never started.

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

let home, fake, gsettingsDb, appSource;

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

const WINDOWS = process.platform === 'win32';
// The fake commands are shell scripts: the GNOME tests cannot run on Windows.
const posixOnly = {skip: WINDOWS && 'needs a POSIX shell for the fake commands'};

function runAs(platform, ...args) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: {
            ...(WINDOWS ? process.env : {}),
            PATH: `${fake}${path.delimiter}${process.env.PATH}`,
            HOME: home,
            USERPROFILE: home,
            LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
            XDG_DATA_HOME: path.join(home, '.local', 'share'),
            XDG_CONFIG_HOME: path.join(home, '.config'),
            IAMIGOS_TEST_GSETTINGS: gsettingsDb,
            IAMIGOS_PLATFORM: platform,
            IAMIGOS_APP_SOURCE: appSource,
            IAMIGOS_NO_LAUNCH: '1',
        },
    });
    return {code: r.status, out: r.stdout + r.stderr};
}

const run = (...args) => runAs('linux', ...args);

const settingsPath = () => path.join(home, '.claude', 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
const extDir = () => path.join(home, '.local', 'share', 'gnome-shell', 'extensions', UUID);
const hookPath = () => path.join(home, '.local', 'bin', 'iamigos-hook');
const gsetting = key => fs.readFileSync(gsettingsDb, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];

// Events that point at our hook in settings.json (on Windows, with a Python prefix).
const isOurs = h => h.command === hookPath() || h.command.includes(hookPath().split(path.sep).join('/'));
function hookedEvents(cfg) {
    return Object.entries(cfg.hooks ?? {})
        .filter(([, groups]) => groups.some(g => g.hooks.some(isOurs)))
        .map(([ev]) => ev);
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'iamigos-home-'));
    fake = path.join(home, 'fakebin');
    gsettingsDb = path.join(home, 'gsettings.db');
    fs.mkdirSync(fake);
    fs.mkdirSync(path.join(home, '.claude'));
    // An unpacked desktop app, as if it came from the release zip.
    appSource = path.join(home, 'unpacked-app');
    fs.mkdirSync(appSource);
    fs.writeFileSync(path.join(appSource, 'IAmigos.exe'), '');
    // The shell does not know the extension yet (new install on Wayland).
    writeFake('gnome-extensions', '#!/bin/sh\nexit 2\n');
    writeFake('gsettings', FAKE_GSETTINGS);
    writeFake('glib-compile-schemas', '#!/bin/sh\ntouch "$1/gschemas.compiled"\n');
    writeFake('gnome-shell', '#!/bin/sh\necho "GNOME Shell 50.1"\n');
});

afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

describe('install', posixOnly, () => {
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

describe('uninstall', posixOnly, () => {
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

describe('cli', posixOnly, () => {
    test('status reports what is installed', () => {
        run('install');
        const r = run('status');
        assert.equal(r.code, 0);
        assert.match(r.out, /copied/);
        assert.match(r.out, /15\/15/);
    });

    test('status reads GNOME\'s state whatever the system language', () => {
        // Like gnome-extensions on a Spanish system: translated unless LC_ALL=C.
        writeFake('gnome-extensions', `#!/bin/sh
[ "$1" = info ] || exit 2
if [ "$LC_ALL" = C ]; then echo "  State: ACTIVE"; else echo "  Estado: ACTIVE"; fi
`);
        run('install');
        assert.match(run('status').out, /GNOME\s+ACTIVE/);
    });

    test('unknown command exits with an error', () => {
        assert.equal(run('nope').code, 1);
        assert.equal(run('--help').code, 0);
    });
});

describe('macOS and Windows', () => {
    const macApp = () => path.join(home, 'Applications', 'IAmigos.app');
    const winApp = () => path.join(home, 'AppData', 'Local', 'Programs', 'IAmigos');

    test('macOS: the hook, the app, and no GNOME', () => {
        const r = runAs('darwin', 'install');
        assert.equal(r.code, 0, r.out);
        assert.ok(fs.existsSync(path.join(macApp(), 'IAmigos.exe')), 'app copied from the local source');
        assert.ok(!fs.existsSync(extDir()));
        assert.equal(hookedEvents(readSettings()).length, 15);
        assert.ok(readSettings().hooks.Stop[0].hooks[0].command === hookPath(), 'runs the script by its shebang');
        assert.match(runAs('darwin', 'status').out, /15\/15/);
    });

    test('Windows: the hook command calls Python with a forward-slash path', () => {
        const r = runAs('win32', 'install');
        assert.equal(r.code, 0, r.out);
        assert.ok(fs.existsSync(path.join(winApp(), 'IAmigos.exe')));
        const cmd = readSettings().hooks.Stop[0].hooks[0].command;
        assert.match(cmd, /^(py -3|python|python3) "[^"\\]*iamigos-hook"$/);
        assert.equal(hookedEvents(readSettings()).length, 15);
    });

    test('Windows: prefers the py launcher', posixOnly, () => {
        writeFake('py', '#!/bin/sh\n[ "$1" = -3 ] && echo "Python 3.12.0"\n');
        runAs('win32', 'install');
        assert.match(readSettings().hooks.Stop[0].hooks[0].command, /^py -3 "/);
    });

    test('Windows: install twice keeps one hook per event, uninstall leaves settings clean', () => {
        const before = {model: 'opus', hooks: {Stop: [{matcher: '', hooks: [{type: 'command', command: 'mine'}]}]}};
        fs.writeFileSync(settingsPath(), JSON.stringify(before));
        runAs('win32', 'install');
        runAs('win32', 'install');
        const cfg = readSettings();
        assert.equal(cfg.hooks.Stop.filter(g => g.hooks.some(isOurs)).length, 1);
        const r = runAs('win32', 'uninstall');
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(readSettings(), before);
        assert.ok(!fs.existsSync(winApp()));
        assert.ok(!fs.existsSync(hookPath()));
    });

    test('--no-app installs only the hook', () => {
        const r = runAs('darwin', 'install', '--no-app');
        assert.equal(r.code, 0, r.out);
        assert.ok(!fs.existsSync(macApp()));
        assert.ok(fs.existsSync(hookPath()));
    });

    test('an unknown platform is refused', () => {
        const r = runAs('aix', 'install');
        assert.equal(r.code, 1);
        assert.match(r.out, /not on aix/);
    });
});

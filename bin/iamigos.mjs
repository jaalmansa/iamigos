#!/usr/bin/env node
// IAmigos — installer (Linux + GNOME, macOS, Windows).
//
//   npx iamigos install      the Claude Code hook, the OpenCode plugin and the front end:
//                            the GNOME extension on Linux, the IAmigos app on macOS/Windows
//   npx iamigos uninstall    removes all of it (keeps a backup of ~/.claude/settings.json)
//   npx iamigos status       shows what is installed
//
// --link (development): symlinks instead of copying, to edit the repo and see the changes.
//                       On macOS/Windows it skips the app: run it with `cd desktop && npm start`.
// --no-app (macOS/Windows): only the hook and the plugin.
//
// Environment (development and tests):
//   IAMIGOS_APP_SOURCE   a local app zip, or an already unpacked app folder, instead of
//                        downloading it from the GitHub Release
//   IAMIGOS_NO_LAUNCH=1  do not start or stop the app
//   IAMIGOS_PLATFORM     pretend to be another platform (linux, darwin, win32)

import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
const REPO = 'jaalmansa/iamigos';
const PLATFORM = process.env.IAMIGOS_PLATFORM || process.platform;
const HOME = os.homedir();
const UUID = 'iamigos@iamigos';
const XDG_DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

const SRC = {
    ext: path.join(PKG, 'gnome-extension', UUID),
    hook: path.join(PKG, 'hooks', 'iamigos-hook'),
    opencode: path.join(PKG, 'opencode', 'iamigos.ts'),
};
const DST = {
    ext: path.join(XDG_DATA, 'gnome-shell', 'extensions', UUID),
    // Fixed path outside the npx cache: this is the one written to settings.json.
    hook: path.join(HOME, '.local', 'bin', 'iamigos-hook'),
    opencodeDir: path.join(XDG_CONFIG, 'opencode'),
    opencode: path.join(XDG_CONFIG, 'opencode', 'plugins', 'iamigos.ts'),
    claudeDir: path.join(HOME, '.claude'),
    settings: path.join(HOME, '.claude', 'settings.json'),
};

// The desktop app (macOS/Windows): where it goes and how its process is called.
const APP = {
    darwin: {
        dir: path.join(HOME, 'Applications', 'IAmigos.app'),
        exe: path.join(HOME, 'Applications', 'IAmigos.app', 'Contents', 'MacOS', 'IAmigos'),
        process: 'IAmigos',
        asset: 'mac',
    },
    win32: {
        dir: path.join(LOCAL_APPDATA, 'Programs', 'IAmigos'),
        exe: path.join(LOCAL_APPDATA, 'Programs', 'IAmigos', 'IAmigos.exe'),
        process: 'IAmigos.exe',
        asset: 'win',
    },
}[PLATFORM];

const EVENTS = [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification',
    'PreCompact', 'PostCompact', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
];

const ok = msg => console.log(`✓ ${msg}`);
const warn = msg => console.log(`! ${msg}`);
const launchAllowed = () => process.env.IAMIGOS_NO_LAUNCH !== '1';

function sh(cmd, args) {
    const r = spawnSync(cmd, args, {encoding: 'utf8'});
    return r.error ? null : {code: r.status, out: (r.stdout || '').trim()};
}

const exists = p => fs.existsSync(p) || isSymlink(p);
function isSymlink(p) {
    try {
        return fs.lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

function remove(p) {
    fs.rmSync(p, {recursive: true, force: true});
}

// Copies (or symlinks with --link), replacing whatever was there, old symlink included.
function place(src, dst, link, mode) {
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    remove(dst);
    if (link) {
        fs.symlinkSync(src, dst);
        return;
    }
    fs.cpSync(src, dst, {recursive: true});
    if (mode)
        fs.chmodSync(dst, mode);
}

// --- Claude Code hook ---------------------------------------------------------

// Forward slashes: Claude Code runs hooks through a shell (Git Bash on Windows),
// and Python accepts them on every platform.
const hookPathForShell = () => DST.hook.split(path.sep).join('/');

// Windows does not run a script by its shebang: the command calls Python itself.
// Returns null when there is no Python.
function pythonCommand() {
    for (const [cmd, args] of [['py', ['-3']], ['python', []], ['python3', []]]) {
        const r = sh(cmd, [...args, '--version']);
        if (r?.code === 0)
            return [cmd, ...args].join(' ');
    }
    return null;
}

function hookCommand() {
    if (PLATFORM !== 'win32')
        return DST.hook;
    return `${pythonCommand() ?? 'python'} "${hookPathForShell()}"`;
}

// Ours, whatever Python prefix it was written with.
const isOurHook = h => typeof h.command === 'string' &&
    (h.command === DST.hook || h.command.includes(hookPathForShell()) || h.command.includes(DST.hook));

// Adds or removes the hook for every event in ~/.claude/settings.json.
// Always saves a backup to settings.json.iamigos.bak first.
function claudeSettings(action) {
    let cfg = {};
    if (fs.existsSync(DST.settings)) {
        const raw = fs.readFileSync(DST.settings, 'utf8');
        try {
            cfg = JSON.parse(raw);
        } catch (e) {
            throw new Error(`${DST.settings} is not valid JSON (${e.message}); leaving it alone.`, {cause: e});
        }
        fs.writeFileSync(`${DST.settings}.iamigos.bak`, raw);
    } else if (action === 'remove') {
        return false;
    }

    const cmd = action === 'add' ? hookCommand() : null;
    const hooks = cfg.hooks ??= {};
    for (const ev of EVENTS) {
        const groups = (hooks[ev] ?? []).filter(g => !(g.hooks ?? []).some(isOurHook));
        if (action === 'add')
            groups.push({matcher: '', hooks: [{type: 'command', command: cmd, timeout: 5}]});
        if (groups.length)
            hooks[ev] = groups;
        else
            delete hooks[ev];
    }
    if (!Object.keys(hooks).length)
        delete cfg.hooks;

    fs.mkdirSync(path.dirname(DST.settings), {recursive: true});
    const tmp = `${DST.settings}.iamigos.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    fs.renameSync(tmp, DST.settings);
    return true;
}

// --- GNOME (Linux) ------------------------------------------------------------

// GNOME's extension lists (gsettings org.gnome.shell). Changing them directly works
// even before the shell sees the extension: it loads it at the next login.
function extensionList(key) {
    const r = sh('gsettings', ['get', 'org.gnome.shell', key]);
    if (!r || r.code !== 0)
        return null;
    return [...r.out.matchAll(/'([^']*)'/g)].map(m => m[1]);
}

function setExtensionList(key, list) {
    const value = `[${list.map(u => `'${u}'`).join(', ')}]`;
    return sh('gsettings', ['set', 'org.gnome.shell', key, value])?.code === 0;
}

// Returns true if the extension ends up marked as enabled.
function markEnabled(enable) {
    const enabled = extensionList('enabled-extensions');
    const disabled = extensionList('disabled-extensions');
    if (!enabled)
        return false;
    if (disabled?.includes(UUID))
        setExtensionList('disabled-extensions', disabled.filter(u => u !== UUID));
    const has = enabled.includes(UUID);
    if (enable && !has)
        return setExtensionList('enabled-extensions', [...enabled, UUID]);
    if (!enable && has)
        return !setExtensionList('enabled-extensions', enabled.filter(u => u !== UUID));
    return has;
}

function shellVersion() {
    const v = sh('gnome-shell', ['--version'])?.out.match(/(\d+)\./);
    return v ? v[1] : null;
}

function checkGnome() {
    const version = shellVersion();
    const supported = JSON.parse(fs.readFileSync(path.join(SRC.ext, 'metadata.json'), 'utf8'))['shell-version'];
    if (!version)
        warn('gnome-shell not found: the extension is installed anyway, but it needs GNOME to show up.');
    else if (!supported.includes(version))
        warn(`Your GNOME Shell is ${version} and the extension is tested on ${supported.join(', ')}; it may not load.`);
}

function installGnome(link) {
    checkGnome();
    const wasInstalled = exists(DST.ext);

    place(SRC.ext, DST.ext, link);
    ok(`extension   → ${DST.ext}${link ? ' (link)' : ''}`);
    // The preferences schema is compiled where GNOME looks for it
    // (with --link, inside the repo; gschemas.compiled is in .gitignore).
    const schemas = path.join(link ? SRC.ext : DST.ext, 'schemas');
    if (sh('glib-compile-schemas', [schemas])?.code !== 0)
        warn('Could not compile the preferences schema (is glib-compile-schemas missing?).');
    return wasInstalled;
}

// If the shell already knows it, it is enabled right away; if not (new extension
// on Wayland), it is marked as enabled and GNOME loads it at the next login.
function enableGnome(wasInstalled) {
    const live = sh('gnome-extensions', ['enable', UUID])?.code === 0;
    const marked = markEnabled(true);
    if (live && !wasInstalled) {
        ok('extension enabled');
    } else if (live) {
        ok('extension updated: log out and back in to load the new version.');
    } else if (marked) {
        ok('extension enabled: it will show up after you log out and back in.');
    } else {
        warn('Could not enable the extension. Log out, log back in and run:');
        console.log(`  gnome-extensions enable ${UUID}`);
    }
    if (sh('gsettings', ['get', 'org.gnome.shell', 'disable-user-extensions'])?.out === 'true')
        warn('User extensions are disabled; turn them on in the Extensions app.');
}

// --- Desktop app (macOS/Windows) ----------------------------------------------

const assetName = () => `IAmigos-${VERSION}-${APP.asset}-${process.arch}.zip`;
const assetUrl = () => `https://github.com/${REPO}/releases/download/v${VERSION}/${assetName()}`;

async function download(url, file) {
    const res = await fetch(url, {redirect: 'follow'});
    if (!res.ok)
        throw new Error(`could not download ${url} (HTTP ${res.status})`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// Unpacks the app zip into its folder. Downloaded with fetch (not a browser), the
// zip carries no quarantine flag, so macOS opens the app even though it is not signed.
function unzip(zip, tmpDir) {
    const out = path.join(tmpDir, 'app');
    fs.mkdirSync(out);
    const r = PLATFORM === 'darwin'
        ? sh('ditto', ['-x', '-k', zip, out])
        : sh('tar', ['-xf', zip, '-C', out]);
    if (r?.code !== 0)
        throw new Error(`could not unpack ${zip}`);
    // The macOS zip holds IAmigos.app; the Windows one, the app's files (maybe in a folder).
    if (PLATFORM === 'darwin')
        return path.join(out, 'IAmigos.app');
    const entries = fs.readdirSync(out);
    const inFolder = entries.length === 1 && path.join(out, entries[0]);
    return inFolder && fs.existsSync(path.join(inFolder, path.basename(APP.exe))) ? inFolder : out;
}

function stopApp() {
    if (!launchAllowed())
        return;
    if (PLATFORM === 'win32')
        sh('taskkill', ['/IM', APP.process, '/F']);
    else
        sh('pkill', ['-x', APP.process]);
}

function appRunning() {
    if (PLATFORM === 'win32')
        return (sh('tasklist', ['/FI', `IMAGENAME eq ${APP.process}`, '/NH'])?.out ?? '').includes(APP.process);
    return sh('pgrep', ['-x', APP.process])?.code === 0;
}

function startApp(...args) {
    if (!launchAllowed())
        return;
    const child = spawn(APP.exe, args, {detached: true, stdio: 'ignore'});
    child.on('error', e => warn(`could not start ${APP.exe}: ${e.message}`));
    child.unref();
}

async function installApp() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iamigos-'));
    try {
        let src = process.env.IAMIGOS_APP_SOURCE;
        if (!src) {
            src = path.join(tmp, assetName());
            console.log(`  downloading ${assetUrl()}`);
            await download(assetUrl(), src);
        }
        const unpacked = fs.statSync(src).isDirectory() ? src : unzip(src, tmp);
        stopApp();
        remove(APP.dir);
        fs.mkdirSync(path.dirname(APP.dir), {recursive: true});
        fs.cpSync(unpacked, APP.dir, {recursive: true, verbatimSymlinks: true});
    } finally {
        remove(tmp);
    }
    ok(`app         → ${APP.dir}`);
    // On its first start the app registers itself to start at login.
    startApp();
    const where = PLATFORM === 'darwin' ? 'in the menu bar' : 'in a strip above the taskbar';
    if (launchAllowed())
        ok(`app started: look for the critters ${where}.`);
}

function uninstallApp() {
    if (!exists(APP.dir))
        return;
    // --uninstall: the app removes its login item and quits.
    if (launchAllowed() && fs.existsSync(APP.exe))
        spawnSync(APP.exe, ['--uninstall'], {timeout: 10000});
    stopApp();
    remove(APP.dir);
    ok(`removed ${APP.dir}`);
}

// --- Commands -----------------------------------------------------------------

function checkEnvironment() {
    if (!['linux', 'darwin', 'win32'].includes(PLATFORM))
        throw new Error(`IAmigos works on Linux (GNOME), macOS and Windows, not on ${PLATFORM}.`);
    if (PLATFORM === 'win32' ? !pythonCommand() : !sh('python3', ['--version']))
        warn('Python 3 not found: the Claude Code hook needs it.');
}

async function install(flags) {
    const link = flags.includes('--link');
    checkEnvironment();
    const wasInstalled = PLATFORM === 'linux' ? installGnome(link) : false;

    place(SRC.hook, DST.hook, link, 0o755);
    ok(`hook        → ${DST.hook}${link ? ' (link)' : ''}`);

    if (fs.existsSync(DST.claudeDir)) {
        claudeSettings('add');
        ok(`Claude Code → hooks in ${DST.settings} (backup in .iamigos.bak)`);
    } else {
        warn(`${DST.claudeDir} not found: if you install Claude Code later, run this command again.`);
    }

    if (fs.existsSync(DST.opencodeDir)) {
        place(SRC.opencode, DST.opencode, link);
        ok(`OpenCode    → ${DST.opencode}${link ? ' (link)' : ''}`);
    }

    if (PLATFORM === 'linux')
        enableGnome(wasInstalled);
    else if (link)
        warn('--link does not install the app: run it from the repository with `cd desktop && npm start`.');
    else if (!flags.includes('--no-app'))
        await installApp();
}

function uninstall() {
    if (PLATFORM === 'linux') {
        sh('gnome-extensions', ['disable', UUID]);
        markEnabled(false);
    } else {
        uninstallApp();
    }
    for (const p of [DST.ext, DST.hook, DST.opencode]) {
        if (exists(p)) {
            remove(p);
            ok(`removed ${p}`);
        }
    }
    if (claudeSettings('remove'))
        ok(`hooks removed from ${DST.settings} (backup in .iamigos.bak)`);
    console.log('IAmigos uninstalled. Saved sessions are still in ~/.local/state/iamigos.');
}

function status() {
    const show = (label, p) => {
        const where = isSymlink(p) ? `link → ${fs.readlinkSync(p)}` : exists(p) ? 'copied' : 'not installed';
        console.log(`${label.padEnd(12)} ${where}  (${p})`);
    };
    if (PLATFORM === 'linux')
        show('extension', DST.ext);
    else
        show('app', APP.dir);
    show('hook', DST.hook);
    show('OpenCode', DST.opencode);

    let hooked = 0;
    try {
        const cfg = JSON.parse(fs.readFileSync(DST.settings, 'utf8'));
        hooked = EVENTS.filter(ev => (cfg.hooks?.[ev] ?? []).some(g => (g.hooks ?? []).some(isOurHook))).length;
    } catch {
        // no settings.json (or unreadable): 0 events
    }
    console.log(`${'Claude Code'.padEnd(12)} ${hooked}/${EVENTS.length} events with the hook`);

    if (PLATFORM === 'linux') {
        const info = sh('gnome-extensions', ['info', UUID]);
        const state = info?.out.match(/State:\s*(\S+)/i)?.[1];
        console.log(`${'GNOME'.padEnd(12)} ${state ?? 'not seen (log out and back in?)'}`);
    } else if (exists(APP.dir)) {
        console.log(`${'running'.padEnd(12)} ${appRunning() ? 'yes' : 'no'}`);
    }
}

function usage() {
    console.log(`Usage: iamigos <install|uninstall|status> [--link] [--no-app]

  install     installs the Claude Code hook, the OpenCode plugin and the front end
              (the GNOME extension on Linux, the IAmigos app on macOS and Windows)
  uninstall   removes all of it
  status      shows what is installed
  --link      (development) symlinks to the repository instead of copying
  --no-app    (macOS/Windows) only the hook and the plugin`);
}

const [cmd, ...flags] = process.argv.slice(2);
try {
    if (cmd === 'install') {
        await install(flags);
    } else if (cmd === 'uninstall') {
        uninstall();
    } else if (cmd === 'status') {
        status();
    } else {
        usage();
        process.exitCode = cmd && !['-h', '--help', 'help'].includes(cmd) ? 1 : 0;
    }
} catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
}

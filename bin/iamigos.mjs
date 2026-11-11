#!/usr/bin/env node
// IAmigos — installer (Linux + GNOME).
//
//   npx iamigos install      copies the extension, the Claude Code hook and the OpenCode plugin
//   npx iamigos uninstall    removes all of it (keeps a backup of ~/.claude/settings.json)
//   npx iamigos status       shows what is installed
//
// --link (development): symlinks instead of copying, to edit the repo and see the changes.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const UUID = 'iamigos@iamigos';
const XDG_DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

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

const EVENTS = [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification',
    'PreCompact', 'PostCompact', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
];

const ok = msg => console.log(`✓ ${msg}`);
const warn = msg => console.log(`! ${msg}`);

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

    const cmd = DST.hook;
    const hooks = cfg.hooks ??= {};
    for (const ev of EVENTS) {
        const groups = (hooks[ev] ?? []).filter(g => !(g.hooks ?? []).some(h => h.command === cmd));
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

function checkEnvironment() {
    if (process.platform !== 'linux')
        throw new Error('IAmigos only works on Linux with GNOME Shell for now.');

    const version = shellVersion();
    const supported = JSON.parse(fs.readFileSync(path.join(SRC.ext, 'metadata.json'), 'utf8'))['shell-version'];
    if (!version)
        warn('gnome-shell not found: the extension is installed anyway, but it needs GNOME to show up.');
    else if (!supported.includes(version))
        warn(`Your GNOME Shell is ${version} and the extension is tested on ${supported.join(', ')}; it may not load.`);

    if (!sh('python3', ['--version']))
        warn('python3 not found: the Claude Code hook needs it.');
}

function install(link) {
    checkEnvironment();
    const wasInstalled = exists(DST.ext);

    place(SRC.ext, DST.ext, link);
    ok(`extension   → ${DST.ext}${link ? ' (link)' : ''}`);
    // The preferences schema is compiled where GNOME looks for it
    // (with --link, inside the repo; gschemas.compiled is in .gitignore).
    const schemas = path.join(link ? SRC.ext : DST.ext, 'schemas');
    if (sh('glib-compile-schemas', [schemas])?.code !== 0)
        warn('Could not compile the preferences schema (is glib-compile-schemas missing?).');

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

    // If the shell already knows it, it is enabled right away; if not (new extension
    // on Wayland), it is marked as enabled and GNOME loads it at the next login.
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

function uninstall() {
    sh('gnome-extensions', ['disable', UUID]);
    markEnabled(false);
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
    show('extension', DST.ext);
    show('hook', DST.hook);
    show('OpenCode', DST.opencode);

    let hooked = 0;
    try {
        const cfg = JSON.parse(fs.readFileSync(DST.settings, 'utf8'));
        hooked = EVENTS.filter(ev => (cfg.hooks?.[ev] ?? [])
            .some(g => (g.hooks ?? []).some(h => h.command === DST.hook))).length;
    } catch {
        // no settings.json (or unreadable): 0 events
    }
    console.log(`${'Claude Code'.padEnd(12)} ${hooked}/${EVENTS.length} events with the hook`);

    const info = sh('gnome-extensions', ['info', UUID]);
    const state = info?.out.match(/State:\s*(\S+)/i)?.[1];
    console.log(`${'GNOME'.padEnd(12)} ${state ?? 'not seen (log out and back in?)'}`);
}

function usage() {
    console.log(`Usage: iamigos <install|uninstall|status> [--link]

  install     installs the GNOME extension, the Claude Code hook and the OpenCode plugin
  uninstall   removes all of it
  status      shows what is installed
  --link      (development) symlinks to the repository instead of copying`);
}

const [cmd, ...flags] = process.argv.slice(2);
try {
    if (cmd === 'install') {
        install(flags.includes('--link'));
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

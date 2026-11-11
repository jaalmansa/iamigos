#!/usr/bin/env node
// IAmigos — instalador (Linux + GNOME).
//
//   npx iamigos install      copia la extensión, el hook de Claude Code y el plugin de OpenCode
//   npx iamigos uninstall    lo quita todo (deja una copia de ~/.claude/settings.json)
//   npx iamigos status       qué hay instalado
//
// Opción --link (desarrollo): enlaza en vez de copiar, para editar el repo y ver los cambios.

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
    // Ruta fija y fuera de la caché de npx: es la que queda escrita en settings.json.
    hook: path.join(HOME, '.local', 'bin', 'iamigos-hook'),
    opencodeDir: path.join(XDG_CONFIG, 'opencode'),
    opencode: path.join(XDG_CONFIG, 'opencode', 'plugins', 'iamigos.ts'),
    claudeDir: path.join(HOME, '.claude'),
    settings: path.join(HOME, '.claude', 'settings.json'),
};

const EVENTS = [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification',
    'PreCompact', 'PostCompact', 'Stop', 'StopFailure', 'SubagentStart',
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

// Copia (o enlaza con --link) sustituyendo lo que hubiera, symlink antiguo incluido.
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

// Añade o quita el hook de todos los eventos de ~/.claude/settings.json.
// Siempre deja antes una copia en settings.json.iamigos.bak.
function claudeSettings(action) {
    let cfg = {};
    if (fs.existsSync(DST.settings)) {
        const raw = fs.readFileSync(DST.settings, 'utf8');
        try {
            cfg = JSON.parse(raw);
        } catch (e) {
            throw new Error(`${DST.settings} no es JSON válido (${e.message}); no lo toco.`);
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

// Listas de extensiones de GNOME (gsettings org.gnome.shell). Tocarlas directamente
// sirve aunque la shell aún no vea la extensión: la cargará al volver a iniciar sesión.
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

// Devuelve true si la extensión queda marcada como activa.
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
        throw new Error('IAmigos de momento solo funciona en Linux con GNOME Shell.');

    const version = shellVersion();
    const supported = JSON.parse(fs.readFileSync(path.join(SRC.ext, 'metadata.json'), 'utf8'))['shell-version'];
    if (!version)
        warn('No encuentro gnome-shell: la extensión se copia igualmente, pero sin GNOME no se verá.');
    else if (!supported.includes(version))
        warn(`Tu GNOME Shell es ${version} y la extensión está probada en ${supported.join(', ')}; puede que no cargue.`);

    if (!sh('python3', ['--version']))
        warn('No encuentro python3: el hook de Claude Code lo necesita.');
}

function install(link) {
    checkEnvironment();
    const wasInstalled = exists(DST.ext);

    place(SRC.ext, DST.ext, link);
    ok(`extensión   → ${DST.ext}${link ? ' (enlace)' : ''}`);

    place(SRC.hook, DST.hook, link, 0o755);
    ok(`hook        → ${DST.hook}${link ? ' (enlace)' : ''}`);

    if (fs.existsSync(DST.claudeDir)) {
        claudeSettings('add');
        ok(`Claude Code → hooks en ${DST.settings} (copia en .iamigos.bak)`);
    } else {
        warn(`No encuentro ${DST.claudeDir}: si instalas Claude Code más tarde, vuelve a ejecutar este comando.`);
    }

    if (fs.existsSync(DST.opencodeDir)) {
        place(SRC.opencode, DST.opencode, link);
        ok(`OpenCode    → ${DST.opencode}${link ? ' (enlace)' : ''}`);
    }

    // Si la shell ya la conoce, se activa al momento; si no (extensión nueva en
    // Wayland), queda marcada como activa y GNOME la carga al volver a entrar.
    const live = sh('gnome-extensions', ['enable', UUID])?.code === 0;
    const marked = markEnabled(true);
    if (live && !wasInstalled) {
        ok('extensión activada');
    } else if (live) {
        ok('extensión actualizada: cierra sesión y vuelve a entrar para cargar la versión nueva.');
    } else if (marked) {
        ok('extensión activada: aparecerá cuando cierres sesión y vuelvas a entrar.');
    } else {
        warn('No he podido activar la extensión. Cierra sesión, entra de nuevo y ejecuta:');
        console.log(`  gnome-extensions enable ${UUID}`);
    }
    if (sh('gsettings', ['get', 'org.gnome.shell', 'disable-user-extensions'])?.out === 'true')
        warn('Tienes desactivadas las extensiones de usuario; actívalas en la app Extensiones.');
}

function uninstall() {
    sh('gnome-extensions', ['disable', UUID]);
    markEnabled(false);
    for (const p of [DST.ext, DST.hook, DST.opencode]) {
        if (exists(p)) {
            remove(p);
            ok(`borrado ${p}`);
        }
    }
    if (claudeSettings('remove'))
        ok(`hooks quitados de ${DST.settings} (copia en .iamigos.bak)`);
    console.log('IAmigos desinstalado. Las sesiones guardadas siguen en ~/.local/state/iamigos.');
}

function status() {
    const show = (label, p) => {
        const where = isSymlink(p) ? `enlace → ${fs.readlinkSync(p)}` : exists(p) ? 'copiado' : 'no instalado';
        console.log(`${label.padEnd(12)} ${where}  (${p})`);
    };
    show('extensión', DST.ext);
    show('hook', DST.hook);
    show('OpenCode', DST.opencode);

    let hooked = 0;
    try {
        const cfg = JSON.parse(fs.readFileSync(DST.settings, 'utf8'));
        hooked = EVENTS.filter(ev => (cfg.hooks?.[ev] ?? [])
            .some(g => (g.hooks ?? []).some(h => h.command === DST.hook))).length;
    } catch {}
    console.log(`${'Claude Code'.padEnd(12)} ${hooked}/${EVENTS.length} eventos con el hook`);

    const info = sh('gnome-extensions', ['info', UUID]);
    const state = info?.out.match(/State:\s*(\S+)/i)?.[1];
    console.log(`${'GNOME'.padEnd(12)} ${state ?? 'no la ve (¿falta volver a iniciar sesión?)'}`);
}

function usage() {
    console.log(`Uso: iamigos <install|uninstall|status> [--link]

  install     instala la extensión de GNOME, el hook de Claude Code y el plugin de OpenCode
  uninstall   lo quita todo
  status      muestra qué hay instalado
  --link      (desarrollo) enlaza al repositorio en vez de copiar`);
}

const [cmd, ...flags] = process.argv.slice(2);
try {
    if (cmd === 'install')
        install(flags.includes('--link'));
    else if (cmd === 'uninstall')
        uninstall();
    else if (cmd === 'status')
        status();
    else {
        usage();
        process.exitCode = cmd && !['-h', '--help', 'help'].includes(cmd) ? 1 : 0;
    }
} catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
}

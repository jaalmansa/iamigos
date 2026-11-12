// IAmigos desktop — the app for macOS and Windows.
//
//   macOS    the critters in the menu bar (one status item, like the GNOME top bar)
//   Windows  a floating strip of critters above the taskbar, plus a tray icon with
//            the session that needs you most
//
// It reads the same session files as the GNOME extension, and shares its logic
// (view.js, paint.js, procs.js, whip.js, strings.js) through src/shared/.
//
//   --uninstall   removes the login item and quits (used by `npx iamigos uninstall`)

import {app, Menu, Tray, nativeImage, screen} from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {Combo} from './shared/whip.js';
import {CRACK_FRAMES, isAnimated, makeLook} from './shared/paint.js';
import {urgency} from './shared/view.js';
import {Settings} from './settings.mjs';
import {setLanguage, t} from './i18n.mjs';
import {SessionStore, stateDir} from './sessions.mjs';
import {createPlatform} from './platform/index.mjs';
import {hitTest, pixelFor, renderIcon, renderStrip} from './raster.mjs';
import {menuTemplate} from './menu.mjs';
import {gitBranch} from './git.mjs';

const IS_MAC = process.platform === 'darwin';
const TICK_MS = 200;            // animation
const REFRESH_EVERY = 25;       // ticks between process checks (5 s)
const MENU_BAR_HEIGHT = 22;     // pt: the critters must fit in the macOS menu bar
const ICON_SIZE = 16;           // pt: Windows tray icon

const now = () => Date.now() / 1000;

if (process.argv.includes('--uninstall')) {
    app.whenReady().then(() => {
        app.setLoginItemSettings({openAtLogin: false});
        app.exit(0);
    });
} else if (!app.requestSingleInstanceLock()) {
    app.exit(0);
} else {
    app.dock?.hide();
    // Closing the strip must not quit the app: it lives in the tray / menu bar.
    app.on('window-all-closed', () => {});
    app.whenReady().then(start).catch(e => {
        console.error(`[IAmigos] ${e.stack ?? e}`);
        app.exit(1);
    });
}

async function start() {
    const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    const applyLanguage = () => setLanguage(settings.get('language'), app.getPreferredSystemLanguages());
    applyLanguage();

    // Start at login: set once, on the first start of the installed app; after
    // that it is the user's choice (menu → Preferences → Start at login).
    const loginItem = {
        get: () => app.getLoginItemSettings().openAtLogin,
        set: on => app.setLoginItemSettings({openAtLogin: on}),
    };
    if (app.isPackaged && !settings.get('login-item-set')) {
        loginItem.set(true);
        settings.set('login-item-set', true);
    }

    const platform = createPlatform();
    const dir = stateDir();
    fs.mkdirSync(dir, {recursive: true});
    const store = new SessionStore(dir, platform);

    // --- State ----------------------------------------------------------------
    let snap = {order: [], inBar: [], hidden: 0, rows: new Map()};
    let frame = 0;
    let dirty = true;
    let crackAt = -Infinity;
    const combo = new Combo();
    let comboShown = null;          // {text, tier, milestone}
    const petState = new Map();     // name -> {whipAt, rushUntil}
    const looks = new Map();        // "project\0ordinal" -> look
    let lastStrip = null;           // last image drawn: {width, items, scale}

    const lookFor = (project, ordinal) => {
        const key = `${project}\0${ordinal}`;
        if (!looks.has(key))
            looks.set(key, makeLook(project, ordinal));
        return looks.get(key);
    };

    const pets = () => snap.inBar.map(name => {
        const r = snap.rows.get(name);
        if (!petState.has(name))
            petState.set(name, {whipAt: -Infinity, rushUntil: -1});
        const st = petState.get(name);
        return {name, look: lookFor(r.project, r.ordinal), view: r.view, urgent: r.urgent, subs: r.subs, ...st};
    });

    const refresh = () => {
        snap = store.snapshot(now(), settings);
        for (const name of [...petState.keys()]) {
            if (!snap.rows.has(name))
                petState.delete(name);
        }
        dirty = true;
    };

    const reload = () => {
        store.reload();
        refresh();
    };

    // --- Actions --------------------------------------------------------------
    const focus = s => platform.focus(s).catch(e => console.warn(`[IAmigos] could not jump to the session: ${e.message}`));

    // One lash to every critter that is still alive.
    const whip = () => {
        const hit = combo.hit(now());
        for (const pet of pets()) {
            if (pet.view === 'closed')
                continue;
            const st = petState.get(pet.name);
            st.whipAt = frame;
            st.rushUntil = Math.max(st.rushUntil, frame + hit.tier.rush);
        }
        crackAt = frame;
        settings.set('whip-total', settings.get('whip-total') + 1);
        if (hit.count > settings.get('whip-best'))
            settings.set('whip-best', hit.count);
        comboShown = hit.count < 2 ? null : {
            text: hit.milestone && hit.tier.key ? `x${hit.count} ${t(`whip.${hit.tier.key}`)}` : `x${hit.count}`,
            tier: hit.tier.key,
            milestone: hit.milestone,
        };
        dirty = true;
        render();
    };

    const clickAt = x => {
        const item = lastStrip && hitTest(lastStrip.items, x);
        if (item?.kind === 'whip')
            whip();
        else if (item?.kind === 'pet')
            focus(snap.rows.get(item.name)?.s ?? {});
    };

    const buildMenu = () => {
        refresh();
        return Menu.buildFromTemplate(menuTemplate({
            snapshot: snap, now: now(), settings, t, isMac: IS_MAC, loginItem,
            branchOf: gitBranch,
            actions: {focus, quit: () => app.quit(), resetStrip: () => strip?.reset()},
        }));
    };

    const tooltip = () => {
        if (!snap.order.length)
            return `IAmigos — ${t('menu.empty')}`;
        const lines = snap.order.map(n => {
            const r = snap.rows.get(n);
            return `${r.urgent ? '⚠ ' : ''}${r.s.project} · ${t(`state.${r.view}`)}`;
        });
        // Windows cuts tray tooltips at 127 characters.
        return lines.join('\n').slice(0, 127);
    };

    // --- Front ends -----------------------------------------------------------
    const tray = new Tray(nativeImage.createEmpty());
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    let strip = null;

    if (IS_MAC) {
        // Without this macOS turns fast clicks into 'double-click' (and a third one
        // into nothing), so the whip would stop answering after two lashes.
        tray.setIgnoreDoubleClickEvents(true);
        // Left click: what is under the pointer (a critter jumps to its session,
        // the whip lashes them all). Right click: the menu.
        tray.on('click', (_e, bounds) => {
            if (!lastStrip)
                return;
            const b = bounds ?? tray.getBounds();
            const imageWidth = lastStrip.width / lastStrip.scale;
            const offset = tray.getTitle() ? 2 : Math.max(0, (b.width - imageWidth) / 2);
            const x = (screen.getCursorScreenPoint().x - b.x - offset) * lastStrip.scale;
            // The combo text grows the menu-bar item (leftwards) and moves the whip away from
            // the pointer: a click on that text keeps lashing.
            if (tray.getTitle() && x > lastStrip.width && lastStrip.items.some(it => it.kind === 'whip'))
                whip();
            else
                clickAt(x);
        });
    } else {
        const {Strip} = await import('./strip-window.mjs');
        strip = new Strip({
            settings,
            onClick: (x, button) => button === 0 && clickAt(x),
            onMenu: () => tray.popUpContextMenu(buildMenu()),
        });
        // Left click on the tray icon: show or hide the strip.
        tray.on('click', () => strip.toggle(snap.order.length > 0));
    }

    // --- Drawing --------------------------------------------------------------
    let lastIconKey = '';

    function render() {
        dirty = false;
        const list = pets();
        if (IS_MAC) {
            const scale = screen.getDisplayNearestPoint(tray.getBounds()).scaleFactor || 2;
            const p = pixelFor(settings.get('pixel-size'), scale, MENU_BAR_HEIGHT * scale);
            // Always something to click on, even with no sessions: the whip.
            const out = renderStrip({pets: list, hidden: 0, whip: settings.get('show-whip') || !list.length, p, scale},
                frame, crackAt);
            lastStrip = {...out, scale};
            tray.setImage(nativeImage.createFromBuffer(out.png, {scaleFactor: scale}));
            // "+N" and the combo as text next to the critters: it follows the menu bar's colours.
            const title = comboShown?.text ?? (snap.hidden > 0 ? `+${snap.hidden}` : '');
            if (tray.getTitle() !== title)
                tray.setTitle(title, {fontType: 'monospacedDigit'});
        } else {
            const scale = strip.scale();
            const p = pixelFor(settings.get('pixel-size'), scale);
            const out = renderStrip({pets: list, hidden: snap.hidden, whip: settings.get('show-whip'), p, scale},
                frame, crackAt);
            lastStrip = {...out, scale};
            const whipItem = out.items.find(it => it.kind === 'whip');
            strip.update({
                ...out, scale,
                combo: comboShown && whipItem ? {...comboShown, x: whipItem.x + whipItem.w / 2} : null,
            });
            if (list.length)
                strip.show();
            else
                strip.hide();

            // Tray icon: the session that needs you most.
            const top = snap.order.map(n => snap.rows.get(n))
                .sort((a, b) => urgency(b.view, b.urgent) - urgency(a.view, a.urgent))[0];
            const iconScale = screen.getPrimaryDisplay().scaleFactor;
            const animated = top && isAnimated(top.view, top.urgent, frame);
            const key = top ? `${top.project}|${top.ordinal}|${top.view}|${top.urgent}|${animated ? frame : ''}` : 'none';
            if (key !== lastIconKey) {
                lastIconKey = key;
                const pet = top && {look: lookFor(top.project, top.ordinal), view: top.view, urgent: top.urgent};
                const size = Math.round(ICON_SIZE * iconScale);
                tray.setImage(nativeImage.createFromBuffer(renderIcon(pet, frame, size), {scaleFactor: iconScale}));
            }
        }
        tray.setToolTip(tooltip());
    }

    const animating = () => pets().some(p => p.subs > 0 || isAnimated(p.view, p.urgent, frame, p.rushUntil)) ||
        frame - crackAt <= CRACK_FRAMES + 1;

    // --- Watching -------------------------------------------------------------
    let reloadTimer = null;
    const scheduleReload = () => {
        reloadTimer ??= setTimeout(() => {
            reloadTimer = null;
            reload();
        }, 120);
    };
    try {
        fs.watch(dir, scheduleReload);
    } catch (e) {
        console.warn(`[IAmigos] cannot watch ${dir}: ${e.message}; reading it every 5 s instead`);
    }

    settings.onChange(key => {
        if (key.startsWith('whip-') || key === 'strip-position' || key === 'login-item-set')
            return;
        if (key === 'language')
            applyLanguage();
        if (key === 'panel-position')
            strip?.reset();
        looks.clear();
        refresh();
    });
    screen.on('display-metrics-changed', () => {
        dirty = true;
        strip?.place();
    });

    setInterval(() => {
        frame++;
        if (frame % REFRESH_EVERY === 0) {
            // Re-read in case a change was missed, and refresh the process table
            // (background shells) without blocking the animation.
            platform.update().catch(() => {}).finally(reload);
        }
        if (comboShown && !combo.visible(now())) {
            comboShown = null;
            dirty = true;
        }
        if (dirty || animating())
            render();
    }, TICK_MS);

    await platform.update().catch(() => {});
    reload();
    render();

    // Development: IAMIGOS_CAPTURE=file.png saves what is on screen after 3 s
    // (the strip window, or the menu bar image on macOS).
    const capture = process.env.IAMIGOS_CAPTURE;
    if (capture) {
        setTimeout(async () => {
            const png = strip ? (await strip.win.webContents.capturePage()).toPNG() : lastStrip.png;
            fs.writeFileSync(capture, png);
            console.log(`[IAmigos] captured ${capture}`);
        }, 3000);
    }
}

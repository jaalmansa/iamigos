// IAmigos desktop — the session menu, as an Electron menu template (plain
// objects, so it can be tested with Node). Same content as the GNOME menu, with
// the preferences as submenus instead of a window.

import {AGENT_LABELS, detailsLine, sessionTitle} from './shared/view.js';

// ctx:
//   snapshot     SessionStore.snapshot()
//   now          seconds
//   settings     Settings
//   t            translations
//   branchOf     cwd → git branch or null
//   isMac        macOS shows the details as a sublabel; Windows as a second line
//   loginItem    {get(): bool, set(bool)}
//   actions      {focus(session), quit(), resetStrip()}
export function menuTemplate(ctx) {
    const {snapshot, now, settings, t, isMac, actions} = ctx;
    // On Windows "&" marks a mnemonic.
    const text = s => (isMac ? s : String(s).replace(/&/g, '&&'));
    const items = [];

    if (!snapshot.order.length)
        items.push({label: t('menu.empty'), enabled: false});

    const details = settings.get('menu-details');
    for (const name of snapshot.order) {
        const row = snapshot.rows.get(name);
        if (!row)
            continue;
        const {s, view} = row;
        const title = `${sessionTitle(s, view, now, settings.get('long-wait-seconds'), t)}   ${AGENT_LABELS[s.agent] ?? s.agent}`;
        const line = details ? detailsLine(s, view, now, s.cwd ? ctx.branchOf(s.cwd) : null, t) : '';
        const click = () => actions.focus(s);
        if (isMac) {
            items.push({label: title, sublabel: line || undefined, click});
        } else {
            items.push({label: text(title), click});
            if (line)
                items.push({label: text(`      ${line}`), enabled: false});
        }
    }

    items.push({type: 'separator'});
    const lashes = settings.get('whip-total');
    if (lashes > 0 && settings.get('show-whip'))
        items.push({label: t('whip.stats', lashes, settings.get('whip-best')), enabled: false});
    items.push({label: t('menu.preferences'), submenu: preferences(ctx)});
    items.push({type: 'separator'});
    items.push({label: t('app.quit'), click: actions.quit});
    return items;
}

function preferences({settings, t, isMac, loginItem, actions}) {
    const radio = (key, options) => options.map(([value, label]) => ({
        label, type: 'radio', checked: settings.get(key) === value,
        click: () => settings.set(key, value),
    }));
    const check = (key, label) => ({
        label, type: 'checkbox', checked: settings.get(key),
        click: () => settings.set(key, !settings.get(key)),
    });
    const never = t('app.never');

    return [
        {label: t('prefs.language'), submenu: radio('language', [
            ['auto', t('prefs.language.auto')], ['en', 'English'], ['es', 'Español'],
        ])},
        ...(isMac ? [] : [{label: t('app.stripPosition'), submenu: [
            ...radio('panel-position', [
                ['left', t('prefs.position.left')], ['center', t('prefs.position.center')],
                ['right', t('prefs.position.right')],
            ]),
            {type: 'separator'},
            {label: t('app.stripReset'), click: actions.resetStrip},
        ]}]),
        {label: t('prefs.pixelSize'), submenu: radio('pixel-size', [1, 2, 3, 4].map(n => [n, String(n)]))},
        {label: t('prefs.maxPets'), submenu: radio('max-pets', [
            ...[4, 6, 8, 12].map(n => [n, String(n)]), [0, t('app.noLimit')],
        ])},
        check('show-subagents', t('prefs.subagents')),
        check('menu-details', t('prefs.details')),
        {type: 'separator'},
        {label: t('prefs.sleep'), submenu: radio('sleep-minutes', [
            [0, never], ...[5, 10, 30, 60].map(n => [n, t('app.minutes', n)]),
        ])},
        {label: t('prefs.longWait'), submenu: radio('long-wait-seconds', [
            [0, never], ...[30, 60, 120, 300].map(n => [n, t('app.seconds', n)]),
        ])},
        check('show-whip', t('prefs.whip')),
        {type: 'separator'},
        {label: t('app.agents'), enabled: false},
        check('show-claude', t('prefs.showClaude')),
        check('show-opencode', t('prefs.showOpencode')),
        {type: 'separator'},
        {
            label: t('app.startAtLogin'), type: 'checkbox', checked: loginItem.get(),
            click: () => loginItem.set(!loginItem.get()),
        },
    ];
}

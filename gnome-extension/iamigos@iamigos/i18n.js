// IAmigos — UI text in English and Spanish.
//
// A plain dictionary instead of gettext: two languages, no build step, and the
// language can be changed from the preferences without logging out.
// Shared by extension.js and prefs.js (only uses GLib, which both can load).

import GLib from 'gi://GLib';

import {STRINGS} from './strings.js';

export const LANGUAGES = Object.keys(STRINGS);

// "auto" → first system language we have (es_ES.UTF-8 → es), English otherwise.
export function resolveLanguage(setting) {
    if (STRINGS[setting])
        return setting;
    for (const name of GLib.get_language_names()) {
        const code = name.split(/[_.@]/)[0];
        if (STRINGS[code])
            return code;
    }
    return 'en';
}

let current = resolveLanguage('auto');

export function setLanguage(setting) {
    current = resolveLanguage(setting);
}

// t('menu.more', 3) → "+3 more". Placeholders: %s and %d, in order.
export function t(key, ...args) {
    const text = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
    let i = 0;
    return text.replace(/%[sd]/g, () => String(args[i++] ?? ''));
}

// IAmigos desktop — UI text, from the same strings.js as the GNOME extension.

import {STRINGS} from './shared/strings.js';

export const LANGUAGES = Object.keys(STRINGS);

// "auto" → the first system language we have (es-ES → es), English otherwise.
export function resolveLanguage(setting, systemLanguages = []) {
    if (STRINGS[setting])
        return setting;
    for (const name of systemLanguages) {
        const code = String(name).split(/[-_.@]/)[0].toLowerCase();
        if (STRINGS[code])
            return code;
    }
    return 'en';
}

let current = 'en';

export function setLanguage(setting, systemLanguages) {
    current = resolveLanguage(setting, systemLanguages);
}

// t('menu.more', 3) → "+3 more". Placeholders: %s and %d, in order.
export function t(key, ...args) {
    const text = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
    let i = 0;
    return text.replace(/%[sd]/g, () => String(args[i++] ?? ''));
}

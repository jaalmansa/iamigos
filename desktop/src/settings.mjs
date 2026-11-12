// IAmigos desktop — preferences, with the same keys and defaults as the GNOME
// extension's GSettings schema, kept in a JSON file in the app's data folder.
// No Electron imports, so it can be tested with Node.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
    'language': 'auto',
    'panel-position': 'right',      // Windows: where the strip sits above the taskbar
    'pixel-size': 2,
    'max-pets': 8,
    'sleep-minutes': 10,
    'long-wait-seconds': 120,
    'show-subagents': true,
    'menu-details': true,
    'show-claude': true,
    'show-opencode': true,
    'show-whip': true,
    'whip-total': 0,
    'whip-best': 0,
    // Desktop only
    'strip-position': null,         // Windows: {x, y} once the strip has been dragged
    'login-item-set': false,        // the app registered itself to start at login once
};

export class Settings {
    constructor(file) {
        this.file = file;
        this.values = {...DEFAULTS};
        this.listeners = [];
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const key of Object.keys(DEFAULTS)) {
                if (key in saved && (DEFAULTS[key] === null || typeof saved[key] === typeof DEFAULTS[key]))
                    this.values[key] = saved[key];
            }
        } catch {
            // first start, or an unreadable file: the defaults
        }
    }

    get(key) {
        return this.values[key];
    }

    set(key, value) {
        if (this.values[key] === value)
            return;
        this.values[key] = value;
        this.save();
        for (const fn of this.listeners)
            fn(key, value);
    }

    // fn(key, value) on every change.
    onChange(fn) {
        this.listeners.push(fn);
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), {recursive: true});
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
            fs.renameSync(tmp, this.file);
        } catch (e) {
            console.warn(`[IAmigos] could not save the preferences: ${e.message}`);
        }
    }
}

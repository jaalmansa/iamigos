// IAmigos — preferences window (Adwaita). Runs in its own process, outside GNOME Shell.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {setLanguage, t} from './i18n.js';

export default class IAmigosPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;   // keep it alive as long as the window
        setLanguage(settings.get_string('language'));

        const page = new Adw.PreferencesPage({title: t('prefs.general'), icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // Appearance
        const look = new Adw.PreferencesGroup({title: t('prefs.appearance')});
        page.add(look);
        look.add(choiceRow(settings, 'language', t('prefs.language'), [
            ['auto', t('prefs.language.auto')], ['en', 'English'], ['es', 'Español'],
        ]));
        look.add(choiceRow(settings, 'panel-position', t('prefs.position'), [
            ['left', t('prefs.position.left')], ['center', t('prefs.position.center')], ['right', t('prefs.position.right')],
        ]));
        look.add(spinRow(settings, 'pixel-size', t('prefs.pixelSize'), t('prefs.pixelSize.sub'), 1, 4, 1));
        look.add(spinRow(settings, 'max-pets', t('prefs.maxPets'), t('prefs.maxPets.sub'), 0, 30, 1));
        look.add(switchRow(settings, 'show-subagents', t('prefs.subagents'), t('prefs.subagents.sub')));
        look.add(switchRow(settings, 'menu-details', t('prefs.details'), t('prefs.details.sub')));

        // Behaviour
        const behaviour = new Adw.PreferencesGroup({title: t('prefs.behaviour')});
        page.add(behaviour);
        behaviour.add(spinRow(settings, 'sleep-minutes', t('prefs.sleep'), t('prefs.sleep.sub'), 0, 240, 5));
        behaviour.add(spinRow(settings, 'long-wait-seconds', t('prefs.longWait'), t('prefs.longWait.sub'), 0, 3600, 30));
        behaviour.add(switchRow(settings, 'show-whip', t('prefs.whip'), t('prefs.whip.sub')));

        // Agents
        const agents = new Adw.PreferencesGroup({title: t('prefs.agents')});
        page.add(agents);
        agents.add(switchRow(settings, 'show-claude', t('prefs.showClaude')));
        agents.add(switchRow(settings, 'show-opencode', t('prefs.showOpencode')));
    }
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max, step) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Drop-down for a string key with a fixed list of [value, label] options.
function choiceRow(settings, key, title, options) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(o => o[1]))});
    const sync = () => {
        const i = options.findIndex(o => o[0] === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    return row;
}

// Whip combos: the counting behind the arcade label in the top bar.

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {COMBO_WINDOW, Combo, SHOUT_LINGER, TIERS, tierOf} from '../gnome-extension/iamigos@iamigos/whip.js';
import {SPRITE_H, SPRITE_W, WHIP_ICON, WHIP_MARK, lashPixels, makePalette, tint} from '../gnome-extension/iamigos@iamigos/sprites.js';
import {STRINGS} from '../gnome-extension/iamigos@iamigos/strings.js';

describe('Combo', () => {
    test('lashes within the window chain, a slow one starts over', () => {
        const c = new Combo();
        assert.equal(c.hit(10).count, 1);
        assert.equal(c.hit(10 + COMBO_WINDOW / 2).count, 2);
        assert.equal(c.hit(10 + COMBO_WINDOW).count, 3);
        assert.equal(c.hit(10 + COMBO_WINDOW * 3).count, 1);
    });

    test('every 5 lashes is a milestone, and the tier grows', () => {
        const c = new Combo();
        const hits = Array.from({length: 50}, (_, i) => c.hit(i * 0.1));
        assert.deepEqual(hits.filter(h => h.milestone).map(h => h.count), [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
        assert.equal(hits[3].tier.key, null);
        assert.equal(hits[4].tier.key, 'combo');
        assert.equal(hits[9].tier.key, 'super');
        assert.equal(hits[19].tier.key, 'brutal');
        assert.equal(hits[49].tier.key, 'legend');
        assert.ok(hits[49].tier.rush > hits[0].tier.rush);
    });

    test('the label shows from x2 and lingers a little after the combo ends', () => {
        const c = new Combo();
        c.hit(0);
        assert.equal(c.visible(0), false);
        c.hit(0.5);
        assert.equal(c.visible(0.5), true);
        assert.equal(c.active(0.5 + COMBO_WINDOW + 0.1), false);
        assert.equal(c.visible(0.5 + COMBO_WINDOW + 0.1), true);
        assert.equal(c.visible(0.5 + COMBO_WINDOW + SHOUT_LINGER + 0.1), false);
    });

    test('tiers go from the highest down and cover every count', () => {
        const ats = TIERS.map(t => t.at);
        assert.deepEqual(ats, [...ats].sort((a, b) => b - a));
        assert.equal(tierOf(1).at, 1);
        assert.equal(tierOf(1000).key, 'legend');
    });

    test('every named tier has a shout in every language', () => {
        for (const tier of TIERS.filter(t => t.key)) {
            for (const strings of Object.values(STRINGS))
                assert.ok(strings[`whip.${tier.key}`], tier.key);
        }
    });
});

describe('whip sprites', () => {
    test('the lash stays inside the critter area', () => {
        for (const [x, y] of lashPixels()) {
            assert.ok(x >= 0 && x < SPRITE_W + 3, `x ${x}`);
            assert.ok(y >= 0 && y < SPRITE_H, `y ${y}`);
        }
    });

    test('the anger mark is a rectangular glyph with a valid colour', () => {
        const w = WHIP_MARK.rows[0].length;
        WHIP_MARK.rows.forEach(row => assert.match(row, new RegExp(`^[x.]{${w}}$`)));
        assert.match(WHIP_MARK.color, /^#[0-9a-f]{6}$/i);
    });

    test('the whip button is critter-sized and every pixel has a colour', () => {
        assert.equal(WHIP_ICON.rows.length, SPRITE_H);
        for (const row of WHIP_ICON.rows) {
            assert.equal(row.length, SPRITE_W);
            for (const ch of row.replaceAll('.', ''))
                assert.match(WHIP_ICON.colors[ch] ?? '', /^#[0-9a-f]{6}$/i, ch);
        }
    });

    test('tint keeps every colour of the palette and stays in range', () => {
        const pal = makePalette('#4a7bf0');
        const hurt = tint(pal, '#ff3b30', 0.45);
        assert.deepEqual(Object.keys(hurt).sort(), Object.keys(pal).sort());
        for (const rgb of Object.values(hurt))
            rgb.forEach(v => assert.ok(v >= 0 && v <= 1));
    });
});

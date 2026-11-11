// Sprite and translation data: the extension draws these as-is, so a typo in a
// grid or a missing translation would only show up on screen.

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
    BADGES, CHARACTERS, HUES, SPRITE_H, SPRITE_W,
    hashString, lowestEyeRows, makePalette, pickLook, shade,
} from '../gnome-extension/iamigos@iamigos/sprites.js';
import {STRINGS} from '../gnome-extension/iamigos@iamigos/strings.js';

describe('characters', () => {
    for (const [name, grid] of Object.entries(CHARACTERS)) {
        test(`${name} is ${SPRITE_W}×${SPRITE_H} and only uses known pixels`, () => {
            assert.equal(grid.length, SPRITE_H);
            grid.forEach((row, y) => {
                assert.equal(row.length, SPRITE_W, `row ${y}`);
                assert.match(row, /^[.dbaew]+$/, `row ${y}`);
            });
        });

        test(`${name} has two eyes`, () => {
            const eyeColumns = Object.keys(lowestEyeRows(grid)).map(Number);
            assert.ok(eyeColumns.length >= 2, 'needs at least two eye columns');
        });

        test(`${name} keeps its shape after shading`, () => {
            const shaded = shade(grid);
            assert.equal(shaded.length, SPRITE_H);
            shaded.forEach((row, y) => {
                assert.equal(row.length, SPRITE_W);
                [...row].forEach((ch, x) => {
                    // shade() only turns body pixels into shadow or light
                    if (ch !== grid[y][x])
                        assert.ok(grid[y][x] === 'b' && 'sh'.includes(ch), `(${x},${y})`);
                });
            });
        });
    }
});

describe('palettes and badges', () => {
    test('every palette has a colour for every pixel type', () => {
        for (const hue of HUES) {
            const pal = makePalette(hue);
            for (const key of 'dbaewsh') {
                assert.equal(pal[key].length, 3, `${hue} ${key}`);
                assert.ok(pal[key].every(v => v >= 0 && v <= 1), `${hue} ${key}`);
            }
        }
    });

    test('badges are rectangular grids of x and .', () => {
        for (const [name, badge] of Object.entries(BADGES)) {
            const w = badge.rows[0].length;
            for (const row of badge.rows) {
                assert.equal(row.length, w, name);
                assert.match(row, /^[x.]+$/, name);
            }
            assert.match(badge.color, /^#[0-9a-f]{6}$/i, name);
        }
    });

    test('"closed" has no badge, so it does not look asleep', () => {
        assert.equal(BADGES.closed, undefined);
    });
});

describe('pickLook', () => {
    test('the same project always gets the same character and colour', () => {
        assert.deepEqual(pickLook('/home/me/project'), pickLook('/home/me/project'));
        assert.equal(hashString('abc'), hashString('abc'));
    });

    test('another session of the same project changes colour, not character', () => {
        const first = pickLook('/home/me/project', 0);
        const second = pickLook('/home/me/project', 1);
        assert.equal(second.character, first.character);
        assert.notEqual(second.hue, first.hue);
    });
});

describe('translations', () => {
    const placeholders = text => text.match(/%[sd]/g) ?? [];

    for (const [lang, strings] of Object.entries(STRINGS)) {
        test(`${lang} has exactly the same keys as English`, () => {
            assert.deepEqual(Object.keys(strings).sort(), Object.keys(STRINGS.en).sort());
        });

        test(`${lang} keeps the same placeholders as English`, () => {
            for (const [key, text] of Object.entries(strings))
                assert.deepEqual(placeholders(text), placeholders(STRINGS.en[key]), key);
        });
    }

    test('every state has a label', () => {
        const states = ['idle', 'working', 'permission', 'asking', 'compacting',
            'done', 'background', 'asleep', 'error', 'closed'];
        for (const state of states)
            assert.ok(STRINGS.en[`state.${state}`], state);
    });
});

// IAmigos — original pixel-art sprites, defined as text grids.
//
// Legend:  .  transparent   d  outline           b  body
//          a  accent        e  eye               w  highlight
// (s = shadow and h = light are added by shade()). All are 12×11. The colours of b/a/d come from each session's palette.

export const SPRITE_W = 12;
export const SPRITE_H = 11;

export const CHARACTERS = {
    blob: [
        '............',
        '....dddd....',
        '..ddbbbbdd..',
        '.dbbwbbbbbd.',
        '.dbbbbbbbbd.',
        'dbbebbbbebbd',
        'dbbebbbbebbd',
        'dbbbbbbbbbbd',
        'dbbbbaabbbbd',
        '.dbbbbbbbbd.',
        '..dddddddd..',
    ],
    robot: [
        '.....aa.....',
        '.....dd.....',
        '.dddddddddd.',
        '.dbbbbbbbbd.',
        '.dbeebbeebd.',
        '.dbeebbeebd.',
        '.dbbbbbbbbd.',
        '.dbbaaaabbd.',
        '.dddddddddd.',
        '..dd....dd..',
        '..dd....dd..',
    ],
    cat: [
        '.d........d.',
        '.dd......dd.',
        '.dbd....dbd.',
        '.dbbddddbbd.',
        '.dbbbbbbbbd.',
        '.dbebbbbebd.',
        '.dbbbbbbbbd.',
        '.dbbbaabbbd.',
        '.dbbbbbbbbd.',
        '..dbbbbbbd..',
        '...dddddd...',
    ],
    mushroom: [
        '...dddddd...',
        '..daawaaad..',
        '.daaaaaaaad.',
        'daawaaaawaad',
        'dddddddddddd',
        '..dbbbbbbd..',
        '..dbebbebd..',
        '..dbbbbbbd..',
        '..dbbaabbd..',
        '..dbbbbbbd..',
        '...dddddd...',
    ],
    bird: [
        '.....dd.....',
        '....dbbd....',
        '..ddbbbbdd..',
        '.dbbbbbbbbd.',
        '.dbebbbbebd.',
        '.dbbbaabbbd.',
        'dabbbbbbbbad',
        'dabbwwwwbbad',
        '.dbbwwwwbbd.',
        '..dddddddd..',
        '...aa..aa...',
    ],
    ghost: [
        '....dddd....',
        '..ddbbbbdd..',
        '.dbwbbbbbbd.',
        '.dbbbbbbbbd.',
        '.dbebbbbebd.',
        'ddbebbbbebdd',
        'dbbbbaabbbbd',
        '.dbbbaabbbd.',
        '.dbbbbbbbbd.',
        '.dbbbbbbbbd.',
        '.dbd.dd.dbd.',
    ],
    cactus: [
        '....dddd....',
        '...dbbbbd...',
        '.d.dbbbbd.d.',
        'dbddebbeddbd',
        'dbddebbeddbd',
        'dbbbbaabbbbd',
        '.dddbbbbddd.',
        '...dbbbbd...',
        '..dddddddd..',
        '..daaaaaad..',
        '...dddddd...',
    ],
    octopus: [
        '...dddddd...',
        '..dbbbbbbd..',
        '.dbwbbbbbbd.',
        '.dbbbbbbbbd.',
        '.dbebbbbebd.',
        '.dbebbbbebd.',
        '.dbbbaabbbd.',
        '.dbbbbbbbbd.',
        '.dbdbddbdbd.',
        'db.db..bd.bd',
        'd..d....d..d',
    ],
};

export const CHARACTER_NAMES = Object.keys(CHARACTERS);

// Base hues (body). The outline and accent are derived from each one.
export const HUES = [
    '#e8735a', '#4a7bf0', '#9b6cf0', '#52c96b',
    '#3cc8e0', '#f0c94a', '#f06ca8', '#f0964a',
];

// State indicator glyphs (x = pixel on).
export const BADGES = {
    permission: {color: '#ffd23f', rows: ['x', 'x', 'x', '.', 'x']},
    asking: {color: '#ffffff', rows: ['xx.', '..x', '.x.', '...', '.x.']},
    done: {color: '#4cd964', rows: ['....x', '...x.', 'x.x..', '.x...']},
    error: {color: '#ff4d4d', rows: ['x.x', '.x.', 'x.x']},
    asleep: {color: '#c8c8d0', rows: ['xxxx', '..x.', '.x..', 'xxxx']},
};

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function mix(c, target, t) {
    return c.map((v, i) => v + (target[i] - v) * t);
}

export function makePalette(hueHex) {
    const b = hexToRgb(hueHex);
    return {
        b,
        d: mix(b, [0, 0, 0], 0.55),
        a: mix(b, [1, 1, 1], 0.45),
        s: mix(b, [0, 0, 0], 0.28),   // shadow
        h: mix(b, [1, 1, 1], 0.22),   // light
        e: [0.08, 0.08, 0.1],
        w: [1, 1, 1],
    };
}

export function greyPalette() {
    return makePalette('#5a5a60');
}

// Stable hash (djb2), so a session always gets the same critter.
export function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++)
        h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
}

// The character depends only on the project; ordinal > 0 (another session of the
// same project) shifts the colour so they can be told apart.
export function pickLook(projectKey, ordinal = 0) {
    const h = hashString(projectKey);
    return {
        character: CHARACTER_NAMES[h % CHARACTER_NAMES.length],
        hue: HUES[((h >>> 4) + ordinal * 3) % HUES.length],
    };
}

// Automatic pixel-art shading: in every column, the lowest body pixel becomes
// shadow (s) and the highest becomes light (h). The designs stay simple grids
// and all of them get the same sense of volume.
export function shade(grid) {
    const rows = grid.map(r => [...r]);
    for (let x = 0; x < SPRITE_W; x++) {
        const ys = rows.map((r, y) => (r[x] === 'b' ? y : -1)).filter(y => y >= 0);
        if (ys.length < 3)
            continue;
        rows[ys[ys.length - 1]][x] = 's';
        rows[ys[0]][x] = 'h';
    }
    return rows.map(r => r.join(''));
}

// Lowest row of each column that has an eye (for closed eyes).
export function lowestEyeRows(grid) {
    const out = {};
    grid.forEach((row, y) => {
        [...row].forEach((ch, x) => {
            if (ch === 'e')
                out[x] = y;
        });
    });
    return out;
}

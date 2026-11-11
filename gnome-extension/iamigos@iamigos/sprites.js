// IAmigos — sprites pixel art originales, definidos como rejillas de texto.
//
// Leyenda:  .  transparente   d  contorno           b  cuerpo
//           a  acento         e  ojo               w  brillo
// (s = sombra y h = luz se añaden solos con shade()). Todos miden 12×11. El color de b/a/d sale de la paleta de cada sesión.

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
    michi: [
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
    seta: [
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
    pajaro: [
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
    fantasma: [
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
    pulpo: [
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

// Tonos base (cuerpo). El contorno y el acento se derivan de cada uno.
export const HUES = [
    '#e8735a', '#4a7bf0', '#9b6cf0', '#52c96b',
    '#3cc8e0', '#f0c94a', '#f06ca8', '#f0964a',
];

// Glifos de los indicadores de estado (x = píxel encendido).
export const BADGES = {
    permission: {color: '#ffd23f', rows: ['x', 'x', 'x', '.', 'x']},
    asking: {color: '#ffffff', rows: ['xx.', '..x', '.x.', '...', '.x.']},
    done: {color: '#4cd964', rows: ['....x', '...x.', 'x.x..', '.x...']},
    error: {color: '#ff4d4d', rows: ['x.x', '.x.', 'x.x']},
    asleep: {color: '#c8c8d0', rows: ['xxxx', '..x.', '.x..', 'xxxx']},
    closed: {color: '#808088', rows: ['xxxx', '..x.', '.x..', 'xxxx']},
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
        s: mix(b, [0, 0, 0], 0.28),   // sombra
        h: mix(b, [1, 1, 1], 0.22),   // luz
        e: [0.08, 0.08, 0.1],
        w: [1, 1, 1],
    };
}

export function greyPalette() {
    return makePalette('#5a5a60');
}

// Hash estable (djb2) para que cada sesión tenga siempre el mismo bicho.
export function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++)
        h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
}

// El personaje depende solo del proyecto; ordinal > 0 (otra sesión del mismo
// proyecto) desplaza el color para poder distinguirlas.
export function pickLook(projectKey, ordinal = 0) {
    const h = hashString(projectKey);
    return {
        character: CHARACTER_NAMES[h % CHARACTER_NAMES.length],
        hue: HUES[((h >>> 4) + ordinal * 3) % HUES.length],
    };
}

// Sombreado automático estilo pixel art: en cada columna, el píxel de cuerpo
// más bajo pasa a sombra (s) y el más alto a luz (h). Así los diseños siguen
// siendo rejillas sencillas y todos ganan volumen igual.
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

// Fila más baja de cada columna que contiene un ojo (para los ojos cerrados).
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

// Copies the modules shared with the GNOME extension into src/shared/ (not in
// git): electron-builder only packs what is inside the app folder.
import {copyFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(DESKTOP, '..', 'gnome-extension', 'iamigos@iamigos');
const OUT = join(DESKTOP, 'src', 'shared');

export const SHARED = ['sprites.js', 'strings.js', 'whip.js', 'view.js', 'paint.js', 'procs.js'];

mkdirSync(OUT, {recursive: true});
for (const file of SHARED)
    copyFileSync(join(SRC, file), join(OUT, file));

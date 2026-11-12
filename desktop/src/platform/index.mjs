// IAmigos desktop — the platform layer for this OS.
import os from 'node:os';

import {createPosixPlatform} from './posix.mjs';
import {createWin32Platform} from './win32.mjs';

export function createPlatform(platform = process.platform) {
    return platform === 'win32'
        ? createWin32Platform()
        : createPosixPlatform({home: os.homedir(), isMac: platform === 'darwin'});
}

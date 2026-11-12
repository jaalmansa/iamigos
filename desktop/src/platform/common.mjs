// IAmigos desktop — what every platform shares. No Electron imports.

import {execFile} from 'node:child_process';

// pid 0 / missing = always alive (the demo sessions). EPERM: it exists, it is just not ours.
export function isAlive(pid) {
    if (!pid)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

// Runs a command; resolves to its stdout, or null if it fails. Never rejects.
export function runner(env = process.env) {
    return (argv, {timeout = 10000, input} = {}) => new Promise(resolve => {
        const child = execFile(argv[0], argv.slice(1), {env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true},
            (err, stdout) => resolve(err ? null : stdout));
        if (input != null)
            child.stdin?.end(input);
    });
}

// A process table that is refreshed at most every `ttl` ms.
export function cachedTable(read, ttl = 4000) {
    let table = [];
    let at = 0;
    let pending = null;
    return {
        get: () => table,
        async refresh(force = false) {
            if (!force && Date.now() - at < ttl)
                return table;
            pending ??= read().then(t => {
                if (t)
                    [table, at] = [t, Date.now()];
                pending = null;
                return table;
            });
            return pending;
        },
    };
}

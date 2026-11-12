// IAmigos desktop — git branch of a folder, reading .git/HEAD directly (without
// running git). Also works for worktrees, where .git is a "gitdir: …" file.

import fs from 'node:fs';
import path from 'node:path';

export function gitBranch(cwd) {
    let dir = cwd;
    for (let i = 0; dir && i < 40; i++) {
        const dotGit = path.join(dir, '.git');
        try {
            let gitDir = dotGit;
            const st = fs.statSync(dotGit, {throwIfNoEntry: false});
            if (st?.isFile()) {
                const target = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
                if (!target)
                    return null;
                gitDir = path.resolve(dir, target);
            } else if (!st?.isDirectory()) {
                const parent = path.dirname(dir);
                dir = parent === dir ? null : parent;
                continue;
            }
            const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
            return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
        } catch {
            return null;
        }
    }
    return null;
}

#!/usr/bin/env node
// Runs the Python tests (Claude Code hook) with whatever Python 3 there is:
// python3 on Linux/macOS, py -3 or python on Windows.
import {spawnSync} from 'node:child_process';

const ARGS = ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'];
for (const [cmd, ...pre] of [['python3'], ['py', '-3'], ['python']]) {
    const probe = spawnSync(cmd, [...pre, '--version'], {encoding: 'utf8'});
    if (probe.error || probe.status !== 0 || !/Python 3/.test(probe.stdout + probe.stderr))
        continue;
    const r = spawnSync(cmd, [...pre, ...ARGS], {stdio: 'inherit'});
    process.exit(r.status ?? 1);
}
console.error('Python 3 not found');
process.exit(1);

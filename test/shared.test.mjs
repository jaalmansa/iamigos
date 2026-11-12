// The logic shared by the GNOME extension and the desktop app (macOS/Windows):
// view.js (what each session shows), paint.js (its pixels) and procs.js
// (finding its window and pane).

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
    assignLooks, detailsLine, formatAge, formatTokens, isUrgent, layoutBar,
    liveSubagents, sessionTitle, urgency, viewOf, SUBAGENT_STALE,
} from '../gnome-extension/iamigos@iamigos/view.js';
import {
    COLS, ROWS, HURT_FRAMES, WHIP_COLS, WHIP_ROWS,
    boxOf, isAnimated, makeLook, miniPixels, petPixels, whipPixels,
} from '../gnome-extension/iamigos@iamigos/paint.js';
import {
    ancestors, backgroundShellCount, isBackgroundShell, jumpToPane, pickMuxClients,
} from '../gnome-extension/iamigos@iamigos/procs.js';
import {STRINGS} from '../gnome-extension/iamigos@iamigos/strings.js';

// t() like i18n.js, in English, without GLib.
const t = (key, ...args) => {
    let i = 0;
    return STRINGS.en[key].replace(/%[sd]/g, () => String(args[i++]));
};

const NOW = 10_000;
const session = (over = {}) => ({
    agent: 'claude', id: 'x', state: 'done', project: 'api', cwd: '/w/api',
    pid: 1, started: 0, since: NOW - 30, ...over,
});

describe('view.js', () => {
    test('formatAge and formatTokens', () => {
        assert.equal(formatAge(42.9), '42 s');
        assert.equal(formatAge(125), '2 min');
        assert.equal(formatAge(3900), '1 h 5 min');
        assert.equal(formatTokens(950), '950');
        assert.equal(formatTokens(84213), '84k');
        assert.equal(formatTokens(1_250_000), '1.3M');
    });

    test('a dead process means closed', () => {
        assert.equal(viewOf(session({state: 'working'}), NOW, {alive: false}), 'closed');
        assert.equal(viewOf(session({state: 'working'}), NOW, {alive: true}), 'working');
    });

    test('background shells only count for Claude Code, and only once the turn is over', () => {
        const yes = () => true;
        assert.equal(viewOf(session(), NOW, {hasBackground: yes}), 'background');
        assert.equal(viewOf(session({agent: 'opencode'}), NOW, {hasBackground: yes}), 'done');
        let asked = false;
        viewOf(session({state: 'working'}), NOW, {hasBackground: () => (asked = true)});
        assert.equal(asked, false, 'not even checked while working');
    });

    test('done or idle for too long falls asleep (0 = never)', () => {
        const old = session({since: NOW - 700});
        assert.equal(viewOf(old, NOW, {sleepSecs: 600}), 'asleep');
        assert.equal(viewOf(old, NOW, {sleepSecs: 0}), 'done');
        assert.equal(viewOf(session({state: 'idle', since: NOW - 700}), NOW, {sleepSecs: 600}), 'asleep');
        assert.equal(viewOf(session({state: 'error', since: NOW - 700}), NOW, {sleepSecs: 600}), 'error');
    });

    test('only waiting for you for too long is urgent', () => {
        const s = session({state: 'permission', since: NOW - 200});
        assert.equal(isUrgent('permission', s, NOW, 120), true);
        assert.equal(isUrgent('asking', s, NOW, 120), true);
        assert.equal(isUrgent('working', s, NOW, 120), false);
        assert.equal(isUrgent('permission', s, NOW, 300), false);
        assert.equal(isUrgent('permission', s, NOW, 0), false);
    });

    test('the title shows why it waits and ⚠ when it is urgent', () => {
        const s = session({state: 'permission', detail: 'Bash', since: NOW - 200});
        assert.equal(sessionTitle(s, 'permission', NOW, 120, t), '⚠ api  ·  needs permission (Bash)  ·  3 min');
        assert.equal(sessionTitle(session({detail: 'Bash'}), 'done', NOW, 120, t), 'api  ·  done  ·  30 s');
    });

    test('the details line has whatever is known', () => {
        const s = session({
            state: 'working', detail: 'Bash', turn_started: NOW - 180, tokens: 84213, model: 'claude-opus-5-5',
            subagents: [{id: 'a', type: 'Explore', since: NOW - 5}, {id: 'b', type: 'Plan', since: NOW - 5}],
        });
        assert.equal(detailsLine(s, 'working', NOW, 'main', t),
            'Bash  ·  turn 3 min  ·  ⎇ main  ·  84k context (opus-5-5)  ·  2 subagents: Explore, Plan');
        const done = session({turn_started: NOW - 300, turn_ended: NOW - 180});
        assert.equal(detailsLine(done, 'done', NOW, null, t), 'last turn 2 min');
        assert.equal(detailsLine(session(), 'done', NOW, null, t), '');
    });

    test('very old subagents are ignored', () => {
        const s = session({subagents: [{id: 'a', since: NOW - SUBAGENT_STALE - 1}, {id: 'b', since: NOW - 1}, null]});
        assert.deepEqual(liveSubagents(s, NOW).map(x => x.id), ['b']);
        assert.deepEqual(liveSubagents(session({subagents: 'nope'}), NOW), []);
    });

    test('oldest first, and the rest grouped into +N', () => {
        const sessions = new Map([['c', {started: 3}], ['a', {started: 1}], ['b', {started: 2}]]);
        assert.deepEqual(layoutBar(['c', 'a', 'b'], sessions, 2), {visible: ['a', 'b', 'c'], inBar: ['a', 'b'], hidden: 1});
        assert.equal(layoutBar(['c', 'a', 'b'], sessions, 0).hidden, 0);
    });

    test('a second session of the same project gets the next ordinal', () => {
        const sessions = new Map([
            ['1', {cwd: '/w/api'}], ['2', {cwd: '/w/web'}], ['3', {cwd: '/w/api'}], ['4', {project: 'p'}],
        ]);
        const looks = assignLooks(['1', '2', '3', '4'], sessions);
        assert.deepEqual([...looks.values()], [
            {project: '/w/api', ordinal: 0}, {project: '/w/web', ordinal: 0},
            {project: '/w/api', ordinal: 1}, {project: 'p', ordinal: 0},
        ]);
    });

    test('urgency puts what needs you first', () => {
        const order = ['asleep', 'done', 'working', 'error', 'permission']
            .sort((a, b) => urgency(b, false) - urgency(a, false));
        assert.deepEqual(order, ['permission', 'error', 'working', 'done', 'asleep']);
        assert.ok(urgency('asking', true) > urgency('permission', false));
    });
});

describe('paint.js', () => {
    const look = makeLook('/w/api');
    const inBox = ([x, y]) => x >= 0 && x < COLS && y >= 0 && y < ROWS;

    test('every frame of every state stays inside the box', () => {
        for (const view of ['idle', 'working', 'permission', 'asking', 'compacting', 'done',
            'background', 'asleep', 'error', 'closed']) {
            for (let f = 0; f < 20; f++) {
                for (const urgent of [false, true]) {
                    const {body, over} = petPixels(look, view, f, {urgent, whipAt: f - 1, rushUntil: f + 3});
                    assert.ok(body.length > 0);
                    assert.ok([...body, ...over].every(inBox), `${view} f=${f}`);
                }
            }
        }
    });

    test('working hops; closed is grey and translucent', () => {
        const top = f => Math.min(...petPixels(look, 'working', f).body.map(p => p[1]));
        assert.notEqual(top(0), top(2));
        const closed = petPixels(look, 'closed', 0).body;
        assert.ok(closed.every(p => p[3] === 0.6));
    });

    test('a lash flinches for a few ticks, then it is over', () => {
        const hurt = petPixels(look, 'idle', 10, {whipAt: 10});
        const calm = petPixels(look, 'idle', 10 + HURT_FRAMES, {whipAt: 10});
        assert.ok(hurt.body.length > calm.body.length, 'the lash itself is drawn');
        assert.deepEqual(calm, petPixels(look, 'idle', 10 + HURT_FRAMES));
    });

    test('only animated states need repainting', () => {
        assert.equal(isAnimated('done', false, 5), false);
        assert.equal(isAnimated('done', true, 5), true);
        assert.equal(isAnimated('done', false, 5, 10), true);
        assert.equal(isAnimated('working', false, 5), true);
    });

    test('urgent sessions get a yellow border', () => {
        assert.equal(boxOf('permission', false).border, '#f07b1d');
        assert.equal(boxOf('permission', true).border, '#ffd23f');
        assert.equal(boxOf('permission', true).bg, '#f07b1d');
        assert.deepEqual(boxOf('idle', false), {});
    });

    test('mini critters and the whip', () => {
        assert.equal(miniPixels(look, 0, 0, 2).length, 0);
        assert.ok(miniPixels(look, 3, 0, 2).length > miniPixels(look, 1, 0, 2).length);
        const idle = whipPixels(10), crack = whipPixels(10, 10);
        assert.ok(crack.length > idle.length, 'the spark only shows while it cracks');
        assert.ok([...idle, ...crack].every(([x, y]) => x < WHIP_COLS && y < WHIP_ROWS));
    });
});

describe('procs.js', () => {
    const table = [
        {pid: 10, ppid: 1, argv: ['/usr/bin/zellij', '--server', '/tmp/x']},
        {pid: 11, ppid: 9, argv: ['zellij', 'attach', 'work']},
        {pid: 12, ppid: 9, argv: ['/opt/homebrew/bin/tmux', 'a']},
        {pid: 13, ppid: 9, argv: ['C:\\tools\\tmux.exe']},
        {pid: 14, ppid: 9, argv: []},
        {pid: 20, ppid: 5, argv: ['/bin/bash', '-c', 'source /home/me/.claude/shell-snapshots/s.sh && sleep 99']},
        {pid: 21, ppid: 5, argv: ['node', 'mcp-server.js']},
        {pid: 22, ppid: 6, argv: ['bash', '-c', 'source C:\\Users\\me\\.claude\\shell-snapshots\\s.sh']},
    ];

    test('multiplexer clients, without the server', () => {
        assert.deepEqual(pickMuxClients(table, 'zellij'), [11]);
        assert.deepEqual(pickMuxClients(table, 'tmux'), [12, 13]);
    });

    test('background shells are the snapshot shells under the agent', () => {
        assert.equal(backgroundShellCount(table, 5), 1);
        assert.equal(backgroundShellCount(table, 6), 1);
        assert.equal(isBackgroundShell('node mcp-server.js'), false);
    });

    test('ancestors stop at init and at 16 levels', () => {
        const parents = {5: 4, 4: 3, 3: 1};
        assert.deepEqual([...ancestors(5, p => parents[p] ?? 0)], [5, 4, 3]);
        assert.equal(ancestors(1000, p => p - 1).size, 16);
    });

    test('jumps to the tmux pane, and does nothing in a plain terminal', async () => {
        const calls = [];
        const run = async argv => {
            calls.push(argv.join(' '));
            return '';
        };
        await jumpToPane({kind: 'tmux', socket: '/tmp/tmux-1/default', pane: '%3'}, run);
        assert.deepEqual(calls, [
            'tmux -S /tmp/tmux-1/default switch-client -t %3',
            'tmux -S /tmp/tmux-1/default select-window -t %3 ; select-pane -t %3',
        ]);
        calls.length = 0;
        await jumpToPane(null, run);
        assert.deepEqual(calls, []);
    });

    test('walks the zellij tabs until the pane is focused', async () => {
        let tab = 1, pane = 0;
        const panes = {1: ['terminal_1', 'terminal_2'], 2: ['terminal_3', 'terminal_7']};
        const run = async argv => {
            const action = argv.slice(4);
            if (action[0] === 'list-clients')
                return `CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 ${panes[tab][pane]} claude\n`;
            if (action[0] === 'query-tab-names')
                return 'one\ntwo\n';
            if (action[0] === 'go-to-tab')
                [tab, pane] = [Number(action[1]), 0];
            if (action[0] === 'focus-next-pane')
                pane = (pane + 1) % panes[tab].length;
            return '';
        };
        await jumpToPane({kind: 'zellij', session: 'work', pane: 7}, run);
        assert.equal(panes[tab][pane], 'terminal_7');
    });
});

// OpenCode plugin (opencode/iamigos.ts): feed it events, check the session JSON.
// Node runs the TypeScript file directly (type stripping, Node ≥ 22.18).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, beforeEach, describe, test} from 'node:test';

const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iamigos-oc-'));
const dir = path.join(stateHome, 'iamigos', 'sessions');
let plugin;

// The plugin reads XDG_STATE_HOME (and the multiplexer variables) when loaded.
before(async () => {
    process.env.XDG_STATE_HOME = stateHome;
    delete process.env.ZELLIJ_SESSION_NAME;
    delete process.env.TMUX;
    const {IAmigosPlugin} = await import('../opencode/iamigos.ts');
    plugin = await IAmigosPlugin({directory: '/home/me/project'});
});
after(() => fs.rmSync(stateHome, {recursive: true, force: true}));
beforeEach(() => fs.rmSync(dir, {recursive: true, force: true}));

const emit = (type, properties) => plugin.event({event: {type, properties}});
const read = id => JSON.parse(fs.readFileSync(path.join(dir, `opencode-${id}.json`), 'utf8'));
const exists = id => fs.existsSync(path.join(dir, `opencode-${id}.json`));

describe('opencode plugin', () => {
    test('a new session starts idle, with the project from its directory', async () => {
        await emit('session.created', {info: {id: 's1'}});
        const s = read('s1');
        assert.equal(s.state, 'idle');
        assert.equal(s.agent, 'opencode');
        assert.equal(s.project, 'project');
        assert.equal(s.pid, process.pid);
    });

    test('a turn goes working → done and records its duration', async () => {
        await emit('session.created', {info: {id: 's1'}});
        await emit('session.status', {sessionID: 's1', status: {type: 'busy'}});
        const working = read('s1');
        assert.equal(working.state, 'working');
        assert.ok(working.turn_started);
        assert.equal(working.turn_ended, null);

        await emit('session.idle', {sessionID: 's1'});
        const done = read('s1');
        assert.equal(done.state, 'done');
        assert.equal(done.turn_started, working.turn_started);
        assert.ok(done.turn_ended >= done.turn_started);
    });

    test('the current tool shows up as the detail', async () => {
        await emit('session.created', {info: {id: 's1'}});
        await plugin['tool.execute.before']({tool: 'bash', sessionID: 's1', callID: 'c1'}, {args: {}});
        assert.equal(read('s1').detail, 'bash');
    });

    test('context size comes from the last assistant message', async () => {
        await emit('session.created', {info: {id: 's1'}});
        await emit('message.updated', {info: {
            role: 'assistant', sessionID: 's1', modelID: 'some-model',
            tokens: {input: 1000, output: 50, cache: {read: 20000, write: 500}},
        }});
        const s = read('s1');
        assert.equal(s.tokens, 21500);
        assert.equal(s.model, 'some-model');
        assert.equal(s.state, 'idle', 'token updates must not change the state');
    });

    test('child sessions are shown as subagents of their parent', async () => {
        await emit('session.created', {info: {id: 'p'}});
        await emit('session.created', {info: {id: 'c', parentID: 'p', title: 'explore'}});
        assert.ok(!exists('c'), 'a child session has no critter of its own');
        assert.deepEqual(read('p').subagents.map(x => x.id), ['c']);
        assert.equal(read('p').subagents[0].type, 'explore');

        await emit('session.idle', {sessionID: 'c'});
        assert.deepEqual(read('p').subagents, []);
    });

    test('permission, question, error and abort', async () => {
        await emit('session.created', {info: {id: 's1'}});
        await emit('permission.asked', {sessionID: 's1', title: 'rm -rf build'});
        assert.equal(read('s1').state, 'permission');
        assert.equal(read('s1').detail, 'rm -rf build');

        await emit('permission.replied', {sessionID: 's1'});
        assert.equal(read('s1').state, 'working');

        await emit('question.asked', {sessionID: 's1'});
        assert.equal(read('s1').state, 'asking');

        await emit('session.error', {sessionID: 's1', error: {name: 'APIError', data: {message: 'overloaded'}}});
        assert.equal(read('s1').state, 'error');
        assert.equal(read('s1').detail, 'overloaded');

        await emit('session.error', {sessionID: 's1', error: {name: 'MessageAbortedError'}});
        assert.equal(read('s1').state, 'done');
    });

    test('deleting a session closes it', async () => {
        await emit('session.created', {info: {id: 's1'}});
        await emit('session.deleted', {info: {id: 's1'}});
        assert.equal(read('s1').state, 'closed');
    });

    test('ignores events for unknown sessions instead of failing', async () => {
        await emit('message.updated', {info: {role: 'assistant', sessionID: 'ghost', tokens: {input: 5}}});
        assert.ok(!exists('ghost'));
    });
});

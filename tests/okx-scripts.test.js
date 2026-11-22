const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const okxScripts = require('../lib/okx-scripts.js');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
function fakeChrome(granted, registered = []) {
    const state = { registered: registered.slice(), calls: [] };
    return {
        state,
        runtime: { getManifest: () => manifest },
        permissions: {
            contains: (query, cb) => cb(granted)
        },
        scripting: {
            getRegisteredContentScripts: (filter, cb) => cb(state.registered.filter((s) => filter.ids.includes(s.id))),
            registerContentScripts: (scripts, cb) => {
                state.calls.push('register');
                state.registered.push(...scripts);
                cb();
            },
            unregisterContentScripts: (filter, cb) => {
                state.calls.push('unregister');
                state.registered = state.registered.filter((s) => !filter.ids.includes(s.id));
                cb();
            }
        }
    };
}
test('OKX is optional: never in host_permissions or static content scripts', () => {
    assert.equal(manifest.host_permissions.includes(okxScripts.ORIGIN), false);
    assert.equal(manifest.optional_host_permissions.includes(okxScripts.ORIGIN), true);
    assert.equal(manifest.permissions.includes('scripting'), true);
    const staticMatches = manifest.content_scripts.flatMap((script) => script.matches);
    assert.equal(staticMatches.includes(okxScripts.ORIGIN), false);
});
test('registered scripts mirror the static isolated bundle and exist on disk', () => {
    const [main, isolated] = okxScripts.buildScripts(manifest);
    assert.equal(main.world, 'MAIN');
    assert.equal(main.runAt, 'document_start');
    assert.equal(isolated.world, 'ISOLATED');
    const staticIsolated = manifest.content_scripts.find((script) => script.js.includes('content.js'));
    assert.deepEqual(isolated.js, staticIsolated.js);
    [...main.js, ...isolated.js].forEach((file) => {
        assert.equal(fs.existsSync(path.join(__dirname, '..', file)), true, file);
    });
});
test('granted permission registers once, then stays unchanged', async () => {
    const api = fakeChrome(true);
    assert.equal(await okxScripts.syncRegistration(api), 'registered');
    assert.equal(api.state.registered.length, 2);
    assert.equal(await okxScripts.syncRegistration(api), 'unchanged');
    assert.deepEqual(api.state.calls, ['register']);
});
test('stale registration (old file list) is replaced', async () => {
    const stale = okxScripts.buildScripts(manifest).map((s) => ({ ...s, js: ['old.js'] }));
    const api = fakeChrome(true, stale);
    assert.equal(await okxScripts.syncRegistration(api), 'registered');
    assert.deepEqual(api.state.calls, ['unregister', 'register']);
});
test('revoked permission unregisters; never granted is a no-op', async () => {
    const api = fakeChrome(false, okxScripts.buildScripts(manifest));
    assert.equal(await okxScripts.syncRegistration(api), 'unregistered');
    assert.equal(api.state.registered.length, 0);
    assert.equal(await okxScripts.syncRegistration(fakeChrome(false)), 'absent');
});

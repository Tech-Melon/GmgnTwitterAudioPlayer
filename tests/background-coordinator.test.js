const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { EventCoordinator } = require('../lib/event-coordinator.js');

function createEvent() {
    const listeners = [];
    return {
        listeners,
        addListener(listener) {
            listeners.push(listener);
        }
    };
}

function createBackgroundHarness() {
    const onMessage = createEvent();
    const onInstalled = createEvent();
    const onStorageChanged = createEvent();
    const onRemoved = createEvent();
    const onUpdated = createEvent();
    const sessionState = {};
    let tabsSendHandler = null;

    const chrome = {
        runtime: {
            id: 'test-extension',
            lastError: null,
            onMessage,
            onInstalled,
            getManifest: () => ({ version: '0.0.0-test' }),
            sendMessage(_message, callback) {
                if (callback) callback({ ok: true });
            },
            getContexts: async () => []
        },
        storage: {
            onChanged: onStorageChanged,
            session: {
                get(keys, callback) {
                    const result = {};
                    for (const key of keys) result[key] = sessionState[key];
                    callback(result);
                },
                set(values, callback) {
                    Object.assign(sessionState, structuredClone(values));
                    callback();
                }
            },
            local: {
                get(_keys, callback) { callback({}); },
                set(_values, callback) { if (callback) callback(); }
            }
        },
        tabs: {
            onRemoved,
            onUpdated,
            sendMessage(tabId, message, options, callback) {
                const done = typeof options === 'function' ? options : callback;
                if (!tabsSendHandler) {
                    done({ ok: false });
                    return;
                }
                tabsSendHandler(tabId, message, done);
            }
        },
        offscreen: {
            createDocument: async () => {}
        }
    };

    const context = vm.createContext({
        GmgnEventCoordinator: EventCoordinator,
        chrome,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        structuredClone,
        importScripts() {}
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    vm.runInContext(source, context);

    function dispatch(message, sender) {
        return new Promise((resolve, reject) => {
            const listener = onMessage.listeners[0];
            let settled = false;
            const timeout = setTimeout(() => reject(new Error(`message timeout: ${message.type}`)), 2000);
            const sendResponse = (response) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(response);
            };
            const keepAlive = listener(message, sender, sendResponse);
            if (keepAlive !== true && !settled) sendResponse(undefined);
        });
    }

    return {
        dispatch,
        onUpdated,
        sessionState,
        setTabsSendHandler(handler) {
            tabsSendHandler = handler;
        }
    };
}

test('background accepts completion that arrives before processor acknowledgement', async () => {
    const harness = createBackgroundHarness();
    const sender = { tab: { id: 7 }, documentId: 'doc-7' };
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, sender);

    let processCount = 0;
    harness.setTabsSendHandler((_tabId, message, callback) => {
        if (message.type === 'GMGN_PROCESSOR_PING') {
            callback({ ok: true });
            return;
        }
        processCount += 1;
        harness.dispatch({
            type: 'GMGN_EVENT_COMPLETE',
            eventIds: [message.eventId],
            processorEpoch: message.processorEpoch,
            runtimeState: { globalLastPlayTime: 123 }
        }, sender).then(() => {
            callback({
                ok: true,
                disposition: 'pending',
                runtimeState: { globalLastPlayTime: 123 }
            });
        });
    });

    const event = {
        type: 'GMGN_INGEST_EVENT',
        kind: 'twitter',
        eventId: 'twitter_race',
        payload: { triggers: [{ id: 'alice' }] }
    };
    const first = await harness.dispatch(event, sender);
    const duplicate = await harness.dispatch(event, sender);

    assert.equal(first.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(processCount, 1);

    const snapshot = harness.sessionState.gmgnEventCoordinatorState;
    assert.deepEqual(snapshot.pending, []);
    assert.equal(snapshot.seen[0][0], 'twitter_race');
    assert.deepEqual(snapshot.runtimeState, { globalLastPlayTime: 123 });
});

test('background suppresses semantic twitter duplicates with different raw event ids', async () => {
    const harness = createBackgroundHarness();
    const sender = { tab: { id: 41 }, documentId: 'doc-41' };
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, sender);

    let processDeliveries = 0;
    harness.setTabsSendHandler((_tabId, message, callback) => {
        if (message.type === 'GMGN_PROCESSOR_PING') {
            callback({ ok: true });
            return;
        }
        processDeliveries += 1;
        callback({ ok: true, disposition: 'pending', runtimeState: {} });
    });

    const payload = {
        triggers: [{ id: 'binancezh', tw: 'tweet' }],
        semanticKey: 'twitter_semantic_binancezh_tweet'
    };
    const first = await harness.dispatch({
        type: 'GMGN_INGEST_EVENT',
        kind: 'twitter',
        eventId: 'twitter_raw_a',
        payload
    }, sender);
    const duplicate = await harness.dispatch({
        type: 'GMGN_INGEST_EVENT',
        kind: 'twitter',
        eventId: 'twitter_raw_b',
        payload
    }, sender);

    assert.equal(first.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.semanticDuplicateOf, 'twitter_raw_a');
    assert.equal(processDeliveries, 1);
});

test('background removes pending reservation when every processor rejects', async () => {
    const harness = createBackgroundHarness();
    const sender = { tab: { id: 9 }, documentId: 'doc-9' };
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, sender);
    harness.setTabsSendHandler((_tabId, _message, callback) => callback({ ok: false }));

    const response = await harness.dispatch({
        type: 'GMGN_INGEST_EVENT',
        kind: 'wallet',
        eventId: 'wallet_rejected',
        payload: { item: { h: '0x9', s: 'buy', cnt: 'processed' } }
    }, sender);

    assert.equal(response.ok, false);
    assert.equal(response.error, 'no_available_processor');

    await new Promise((resolve) => setTimeout(resolve, 180));
    const snapshot = harness.sessionState.gmgnEventCoordinatorState;
    assert.deepEqual(snapshot.pending, []);
});

test('a busy processor is not replaced when its ping takes longer than 500ms', async () => {
    const harness = createBackgroundHarness();
    const firstSender = { tab: { id: 21 }, documentId: 'doc-21' };
    const secondSender = { tab: { id: 22 }, documentId: 'doc-22' };
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, firstSender);
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, secondSender);

    let processDeliveries = 0;
    harness.setTabsSendHandler((_tabId, message, callback) => {
        if (message.type === 'GMGN_PROCESSOR_PING') {
            setTimeout(() => callback({ ok: true }), 700);
            return;
        }
        processDeliveries += 1;
        callback({ ok: true, disposition: 'pending', runtimeState: {} });
    });

    const event = {
        type: 'GMGN_INGEST_EVENT',
        kind: 'wallet',
        eventId: 'wallet_busy_processor',
        payload: { item: { h: '0x21', s: 'buy', cnt: 'processed' } }
    };
    await harness.dispatch(event, firstSender);
    const duplicate = await harness.dispatch(event, secondSender);

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.pending, true);
    assert.equal(processDeliveries, 1);
    assert.equal(harness.sessionState.gmgnEventCoordinatorState.processor.tabId, 21);
});

test('authorized playback failure retries the pending event on the same processor', async () => {
    const harness = createBackgroundHarness();
    const sender = { tab: { id: 31 }, documentId: 'doc-31' };
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, sender);

    let processDeliveries = 0;
    harness.setTabsSendHandler((_tabId, message, callback) => {
        if (message.type === 'GMGN_PROCESSOR_PING') {
            callback({ ok: true });
            return;
        }
        processDeliveries += 1;
        callback({ ok: true, disposition: 'pending', runtimeState: { attempt: processDeliveries } });
    });

    await harness.dispatch({
        type: 'GMGN_INGEST_EVENT',
        kind: 'wallet',
        eventId: 'wallet_retry',
        payload: { item: { h: '0x31', s: 'buy', cnt: 'processed' } }
    }, sender);
    const retry = await harness.dispatch({
        type: 'GMGN_EVENT_RETRY',
        eventIds: ['wallet_retry'],
        processorEpoch: 1,
        error: 'media_error',
        runtimeState: { attempt: 1 }
    }, sender);

    assert.equal(retry.ok, true);
    assert.deepEqual(Array.from(retry.retried), ['wallet_retry']);
    assert.equal(processDeliveries, 2);
    assert.equal(harness.sessionState.gmgnEventCoordinatorState.pending.length, 1);
});

test('background ignores non-trade wallet activity before processor coordination', async () => {
    const harness = createBackgroundHarness();
    const sender = { tab: { id: 51 }, documentId: 'doc-51' };
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, sender);

    let processDeliveries = 0;
    harness.setTabsSendHandler((_tabId, _message, callback) => {
        processDeliveries += 1;
        callback({ ok: true, disposition: 'complete', runtimeState: {} });
    });

    const response = await harness.dispatch({
        type: 'GMGN_INGEST_EVENT',
        kind: 'wallet',
        eventId: 'wallet_transfer_out',
        payload: { item: { h: '0x51', s: 'transferOut', cnt: 'processed' } }
    }, sender);

    assert.equal(response.ok, true);
    assert.equal(response.ignored, true);
    assert.equal(processDeliveries, 0);
});

test('discarding the processor immediately replays pending work on another tab', async () => {
    const harness = createBackgroundHarness();
    const firstSender = { tab: { id: 11 }, documentId: 'doc-11' };
    const secondSender = { tab: { id: 12 }, documentId: 'doc-12' };
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, firstSender);

    const deliveries = [];
    harness.setTabsSendHandler((tabId, message, callback) => {
        if (message.type === 'GMGN_PROCESSOR_PING') {
            callback({ ok: true });
            return;
        }
        deliveries.push({ tabId, eventId: message.eventId, replayed: message.replayed === true });
        callback({
            ok: true,
            disposition: tabId === 11 ? 'pending' : 'complete',
            runtimeState: { globalLastPlayTime: tabId }
        });
    });

    await harness.dispatch({
        type: 'GMGN_INGEST_EVENT',
        kind: 'twitter',
        eventId: 'twitter_discard',
        payload: { triggers: [{ id: 'discard-test' }] }
    }, firstSender);
    await harness.dispatch({ type: 'GMGN_REGISTER_MONITOR' }, secondSender);

    harness.onUpdated.listeners[0](11, { discarded: true });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(deliveries, [
        { tabId: 11, eventId: 'twitter_discard', replayed: false },
        { tabId: 12, eventId: 'twitter_discard', replayed: true }
    ]);
    const snapshot = harness.sessionState.gmgnEventCoordinatorState;
    assert.equal(snapshot.processor.tabId, 12);
    assert.deepEqual(snapshot.pending, []);
    assert.equal(snapshot.seen[0][0], 'twitter_discard');
});

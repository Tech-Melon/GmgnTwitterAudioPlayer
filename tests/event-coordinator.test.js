const test = require('node:test');
const assert = require('node:assert/strict');

const { EventCoordinator } = require('../lib/event-coordinator.js');

test('simultaneous duplicate events are admitted once', () => {
    const coordinator = new EventCoordinator();
    const now = 1000;

    assert.equal(coordinator.hasSeen('twitter_same_payload', 'twitter', now), false);
    coordinator.markSeen('twitter_same_payload', 'twitter', now);
    assert.equal(coordinator.hasSeen('twitter_same_payload', 'twitter', now + 1), true);
});

test('twitter and wallet dedup windows expire independently', () => {
    const coordinator = new EventCoordinator({
        twitterTtlMs: 100,
        walletTtlMs: 1000
    });
    coordinator.markSeen('twitter_1', 'twitter', 0);
    coordinator.markSeen('wallet_1', 'wallet', 0);

    assert.equal(coordinator.hasSeen('twitter_1', 'twitter', 101), false);
    assert.equal(coordinator.hasSeen('wallet_1', 'wallet', 101), true);
});

test('default twitter pending window survives a normal audio backlog', () => {
    const coordinator = new EventCoordinator();
    coordinator.markPending('twitter_backlog', 'twitter', { triggers: [] }, 0);

    assert.equal(coordinator.isPending('twitter_backlog', 'twitter', 30000), true);
    assert.equal(coordinator.isPending('twitter_backlog', 'twitter', 120001), false);
});

test('processor remains sticky until explicitly replaced', () => {
    const coordinator = new EventCoordinator();
    const first = coordinator.assignProcessor(10, 'doc-a');
    const same = coordinator.assignProcessor(10, 'doc-a');

    assert.equal(first.epoch, same.epoch);
    assert.equal(coordinator.isProcessor(10, 'doc-a', first.epoch), true);
    assert.equal(coordinator.isProcessor(11, 'doc-b', first.epoch), false);
});

test('processor replacement fences stale tabs with a new epoch', () => {
    const coordinator = new EventCoordinator();
    const first = coordinator.assignProcessor(10, 'doc-a');
    coordinator.clearProcessor(10, 'doc-a');
    const second = coordinator.assignProcessor(11, 'doc-b');

    assert.ok(second.epoch > first.epoch);
    assert.equal(coordinator.isProcessor(10, 'doc-a', first.epoch), false);
    assert.equal(coordinator.isProcessor(11, 'doc-b', second.epoch), true);
});

test('service worker state restores processor and unexpired dedup records', () => {
    const original = new EventCoordinator({ twitterTtlMs: 500 });
    const processor = original.assignProcessor(7, 'doc-restored');
    original.markSeen('twitter_restore', 'twitter', 100);

    const restored = new EventCoordinator({ twitterTtlMs: 500 });
    restored.restore(original.snapshot(200), 200);

    assert.equal(restored.hasSeen('twitter_restore', 'twitter', 300), true);
    assert.equal(restored.isProcessor(7, 'doc-restored', processor.epoch), true);
});

test('pending events block duplicates until completion', () => {
    const coordinator = new EventCoordinator();
    coordinator.markPending('twitter_pending', 'twitter', { triggers: [{ id: 'alice' }] }, 100);

    assert.equal(coordinator.hasSeen('twitter_pending', 'twitter', 101), true);
    assert.equal(coordinator.isPending('twitter_pending', 'twitter', 101), true);
    assert.equal(coordinator.isCompleted('twitter_pending', 'twitter', 101), false);

    coordinator.complete('twitter_pending', 102);
    assert.equal(coordinator.isPending('twitter_pending', 'twitter', 103), false);
    assert.equal(coordinator.isCompleted('twitter_pending', 'twitter', 103), true);
});

test('failed dispatch can remove a pending reservation', () => {
    const coordinator = new EventCoordinator();
    coordinator.markPending('wallet_failed', 'wallet', { item: { h: '0x1' } }, 100);

    assert.equal(coordinator.removePending('wallet_failed'), true);
    assert.equal(coordinator.hasSeen('wallet_failed', 'wallet', 101), false);
    assert.equal(coordinator.removePending('wallet_failed'), false);
});

test('snapshot restores pending payload and processor runtime state', () => {
    const original = new EventCoordinator({ walletTtlMs: 1000 });
    original.markPending('wallet_restore', 'wallet', { item: { h: '0x2' } }, 100);
    original.setRuntimeState({
        globalLastPlayTime: 88,
        walletLastPlayed: [['0x2', true]]
    });

    const restored = new EventCoordinator({ walletTtlMs: 1000 });
    restored.restore(original.snapshot(200), 200);

    assert.deepEqual(restored.getPending(201), [{
        eventId: 'wallet_restore',
        kind: 'wallet',
        payload: { item: { h: '0x2' } },
        timestamp: 100
    }]);
    assert.deepEqual(restored.runtimeState, {
        globalLastPlayTime: 88,
        walletLastPlayed: [['0x2', true]]
    });
});

test('pending work survives processor replacement for replay', () => {
    const coordinator = new EventCoordinator();
    const first = coordinator.assignProcessor(1, 'doc-1');
    coordinator.markPending('twitter_replay', 'twitter', { triggers: [{ id: 'bob' }] }, 100);
    coordinator.clearProcessor(first.tabId, first.documentId);
    const replacement = coordinator.assignProcessor(2, 'doc-2');

    assert.ok(replacement.epoch > first.epoch);
    assert.deepEqual(coordinator.getPending(101).map((record) => record.eventId), ['twitter_replay']);
});

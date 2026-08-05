const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildEventId,
    buildTransactionKey,
    isTokenBlocked,
    buildSingleSpeechParts,
    buildSpeechGroupParts,
    formatSpeechGroup,
    formatCompactSpeechGroups,
    splitFreshItems,
    playResolvedSegmentsInOrder,
    playProgressiveSegmentGroups,
    mergePendingSellConfirm
} = require('../lib/wallet-event.js');

const TX_HASH = '0x598248aac699a257a864f4c3f3ecedab2356fcb5c86a70dc639436713047ceca';

test('different assets in one transaction have different event and state keys', () => {
    const first = {
        h: TX_HASH,
        id: 'MTE0MDg4MDk2MDAwODgwMDAwMg==',
        si: '1140880960008800002',
        ba: '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1',
        bs: 'SPCXB',
        cnt: 'processed'
    };
    const second = {
        h: TX_HASH,
        id: 'MTE0MDg4MDk2MDAwODMwMDAwMA==',
        si: '1140880960008300000',
        ba: '0xad238e7d7207c40d95b4341240eda6284bb17777',
        bs: 'RGERG',
        cnt: 'processed'
    };

    assert.notEqual(buildEventId(first), buildEventId(second));
    assert.notEqual(buildTransactionKey(first), buildTransactionKey(second));
});

test('processed and confirm stages share state but remain separate events', () => {
    const processed = {
        h: TX_HASH,
        id: 'MTE0MDg4MDk2MDAwODgwMDAwMg==',
        ba: '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1',
        cnt: 'processed'
    };
    const confirm = { ...processed, cnt: 'confirm', ooc: 1 };

    assert.equal(buildTransactionKey(processed), buildTransactionKey(confirm));
    assert.notEqual(buildEventId(processed), buildEventId(confirm));
    assert.equal(buildEventId(processed), buildEventId({ ...processed }));
});

test('blocking SPCXB does not block RGERG from the same transaction', () => {
    const blockedSymbols = [' spcxb '];
    const spcxb = { h: TX_HASH, bs: 'SPCXB' };
    const rgerg = { h: TX_HASH, bs: 'RGERG' };

    assert.equal(isTokenBlocked(spcxb, blockedSymbols), true);
    assert.equal(isTokenBlocked({ ...spcxb, bs: 'spcxb' }, blockedSymbols), true);
    assert.equal(isTokenBlocked(rgerg, blockedSymbols), false);
});

test('buy, reduce, and clear use a cached name plus an action-token segment', () => {
    assert.deepEqual(buildSingleSpeechParts({
        rename: '聪明钱',
        action: 'buy',
        tokenSymbol: 'RGERG'
    }), ['聪明钱', '买入RGERG']);
    assert.deepEqual(buildSingleSpeechParts({
        rename: '聪明钱',
        action: 'sell',
        cnt: 'processed',
        tokenSymbol: 'RGERG'
    }), ['聪明钱', '减仓RGERG']);
    assert.deepEqual(buildSingleSpeechParts({
        rename: '聪明钱',
        action: 'sell',
        cnt: 'confirm',
        ooc: 1,
        tokenSymbol: 'RGERG'
    }), ['聪明钱', '清仓RGERG']);
});

test('wallet speech keeps exactly two progressive audio segments', () => {
    assert.deepEqual(buildSingleSpeechParts({
        rename: '聪明钱',
        action: 'buy',
        tokenSymbol: 'GPU'
    }), ['聪明钱', '买入GPU']);
    assert.deepEqual(buildSingleSpeechParts({
        rename: '聪明钱',
        action: 'sell',
        cnt: null,
        ooc: 1,
        tokenSymbol: 'GPU'
    }), ['聪明钱', '清仓GPU']);
});

test('grouped sell fallback retains each token symbol', () => {
    const speech = formatSpeechGroup({
        groupAction: 'sellProcessed',
        tokenSymbol: 'RGERG',
        nameCounts: new Map([['聪明钱', 2]])
    });
    assert.equal(speech, '聪明钱2笔减仓RGERG');
    assert.deepEqual(buildSpeechGroupParts({
        groupAction: 'sellProcessed',
        tokenSymbol: 'RGERG',
        nameCounts: new Map([['聪明钱', 2]])
    }), ['聪明钱2笔', '减仓RGERG']);
});

test('wallet burst summary is bounded to recent groups and names', () => {
    const speech = formatCompactSpeechGroups([
        {
            groupAction: 'buy',
            tokenSymbol: 'OLD',
            nameCounts: new Map([['旧钱包', 2]]),
            itemCount: 2,
            lastQueuedAt: 100
        },
        {
            groupAction: 'sellReduce',
            tokenSymbol: 'CHIP',
            nameCounts: new Map([
                ['阿峰', 3],
                ['狗头', 2],
                ['蚂蚁仓', 1],
                ['鸡Crazy', 1]
            ]),
            itemCount: 7,
            lastQueuedAt: 400
        },
        {
            groupAction: 'buy',
            tokenSymbol: 'NEW',
            nameCounts: new Map([['聪明钱', 1]]),
            itemCount: 1,
            lastQueuedAt: 300
        }
    ], 12, { maxGroups: 2, maxNames: 3 });

    assert.equal(speech, '阿峰3笔、狗头2笔、鸡Crazy等7笔减仓CHIP，聪明钱买入NEW，另4笔异动');
});

test('wallet freshness uses WSS time and enforces a strict upper bound', () => {
    const now = 20_000;
    const result = splitFreshItems([
        { id: 'fresh', wssReceivedAt: 15_001, _queuedAt: 19_000 },
        { id: 'boundary', wssReceivedAt: 14_000, _queuedAt: 19_500 },
        { id: 'queued-fallback', _queuedAt: 15_500 }
    ], now, 6_000);

    assert.deepEqual(result.fresh.map((item) => item.id), ['fresh', 'queued-fallback']);
    assert.deepEqual(result.stale.map((item) => item.id), ['boundary']);
});

test('sequential wallet playback starts cached name before action-token is ready', async () => {
    let resolveActionToken;
    const actionToken = new Promise((resolve) => {
        resolveActionToken = resolve;
    });
    const played = [];
    const playback = playResolvedSegmentsInOrder([
        Promise.resolve('cached-name'),
        actionToken
    ], async (segment) => {
        played.push(segment);
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(played, ['cached-name']);

    resolveActionToken('generated-action-token');
    const result = await playback;
    assert.deepEqual(played, ['cached-name', 'generated-action-token']);
    assert.deepEqual(result, { ok: true, count: 2 });
});

test('progressive wallet playback starts cached name while action-token is generated', async () => {
    let resolveActionToken;
    const actionToken = new Promise((resolve) => {
        resolveActionToken = resolve;
    });
    const playedGroups = [];
    const playback = playProgressiveSegmentGroups([
        Promise.resolve('cached-name'),
        actionToken
    ], async (segments) => {
        playedGroups.push(segments);
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(playedGroups, [['cached-name']]);

    resolveActionToken('generated-action-token');
    const result = await playback;
    assert.deepEqual(playedGroups, [
        ['cached-name'],
        ['generated-action-token']
    ]);
    assert.deepEqual(result, { ok: true, count: 2, playbackGroups: 2 });
});

test('ready action-token is queued before the leading playback job completes', async () => {
    let finishLeadingPlayback;
    const playedGroups = [];
    const playback = playProgressiveSegmentGroups([
        Promise.resolve('cached-name'),
        Promise.resolve('cached-action-token')
    ], async (segments) => {
        playedGroups.push(segments);
        if (playedGroups.length === 1) {
            return new Promise((resolve) => {
                finishLeadingPlayback = () => resolve({ ok: true });
            });
        }
        return { ok: true };
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(playedGroups, [
        ['cached-name'],
        ['cached-action-token']
    ]);

    finishLeadingPlayback();
    assert.deepEqual(await playback, { ok: true, count: 2, playbackGroups: 2 });
});

test('queued processed and confirm stages merge into one final sell announcement', () => {
    const processed = {
        txStateKey: 'tx_asset',
        action: 'sell',
        cnt: 'processed',
        ooc: 0,
        wssReceivedAt: 100,
        _coordinatorEventId: 'processed-event',
        _processingState: 'processing_sell',
        _successState: 'pending_sell'
    };
    const confirm = {
        txStateKey: 'tx_asset',
        action: 'sell',
        cnt: 'confirm',
        ooc: 1,
        wssReceivedAt: 200,
        _coordinatorEventId: 'confirm-event'
    };

    assert.equal(mergePendingSellConfirm(processed, confirm), true);
    assert.equal(processed.cnt, null);
    assert.equal(processed.ooc, 1);
    assert.equal(processed._processingState, 'processing_confirm');
    assert.equal(processed._successState, true);
    assert.deepEqual(processed._coordinatorEventIds, ['processed-event', 'confirm-event']);
});

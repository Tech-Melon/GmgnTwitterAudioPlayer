const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeMessage, resetState, normalizeChain } = require('../lib/debot-wallet.js');
const {
    buildTransactionKey,
    buildSingleSpeechParts,
    mergePendingSellConfirm
} = require('../lib/wallet-event.js');

const WALLET = '0x416034792642c11f4402235b4bcdab2056b1a4b9';
const TOKEN = '0x000000000000000000000000000000000000f6ffff';
const BUY_TX = '0x6fecd19c5cb036d80459ade36ca5dfc0745cf5d3eb15d01d0a8e14ed5771616f';
const SELL_TX = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa805f1eeb';
const CLEAR_TX = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbc81a5d46';

function trackMessage(data, kind) {
    return {
        type: 'socket-event',
        kind: kind === undefined ? 'main' : kind,
        event: 'wallet-track',
        args: [{ data, user_infos: { group_id_list: [73621] } }]
    };
}

function positionMessage(data) {
    return {
        type: 'socket-event',
        kind: 'main',
        event: 'wallet-position-track',
        args: [{ data }]
    };
}

function buyData(overrides) {
    return Object.assign({
        unix_time: 1790839902,
        chain: 'bsc',
        wallet: WALLET,
        token: TOKEN,
        token_symbol: '四',
        op: 'buy',
        volume: '0.7484128828',
        mc: '223096.198',
        token_create_time: 1790830000,
        position_action: '',
        tx_hash: BUY_TX
    }, overrides || {});
}

test.beforeEach(() => {
    resetState();
});

test('chain aliases match the wallet voice catalog', () => {
    assert.equal(normalizeChain('solana'), 'sol');
    assert.equal(normalizeChain('Ethereum'), 'eth');
    assert.equal(normalizeChain('binance'), 'bsc');
    assert.equal(normalizeChain('bsc'), 'bsc');
});

test('wallet-track buy uses the first frame amount and market cap', () => {
    const items = normalizeMessage(trackMessage(buyData()));
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.s, 'buy');
    assert.equal(item.cnt, 'confirm');
    assert.equal(item.n, 'bsc');
    assert.equal(item.m, WALLET);
    assert.equal(item.h, BUY_TX);
    assert.equal(item.bs, '四');
    assert.equal(item.ba, TOKEN);
    assert.equal(item.cu, 0.7484128828);
    assert.equal(item.pu * item.bts / 1000, 223096.198 / 1000);
    assert.equal(item.ts, 1790839902);
    assert.equal(item.bct, 1790830000);
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'ooc'), false);
    assert.deepEqual(buildSingleSpeechParts({
        rename: '测试钱包',
        tokenSymbol: item.bs,
        action: item.s,
        ooc: item.ooc,
        chainSpeakAs: 'BSC'
    }), ['BSC', '测试钱包', '买入四']);
});

test('later open position does not speak the buy again', () => {
    normalizeMessage(trackMessage(buyData()));
    const again = normalizeMessage(positionMessage({
        time: 1790839902,
        chain: 'bsc',
        wallet: WALLET,
        token: TOKEN,
        token_symbol: '四',
        volume: 0.7559726089,
        mc: '223200',
        token_create_time: 1790830000,
        position_action: 'open_position',
        tx_hash: BUY_TX
    }));
    assert.deepEqual(again, []);
});

test('sell waits for the position frame and keeps the first quote', () => {
    const processed = normalizeMessage(trackMessage(buyData({
        op: 'sell',
        volume: 0.3849135688,
        mc: 229479.6247,
        unix_time: 1790839907,
        tx_hash: SELL_TX,
        position_action: ''
    })))[0];
    const confirm = normalizeMessage(positionMessage({
        time: 1790839907,
        chain: 'bsc',
        wallet: WALLET,
        token: TOKEN,
        token_symbol: '四',
        volume: 0.3810644331,
        mc: '229000',
        position_action: 'reduce_position',
        tx_hash: SELL_TX
    }))[0];

    assert.equal(processed.s, 'sell');
    assert.equal(processed.cnt, 'processed');
    assert.equal(Object.prototype.hasOwnProperty.call(processed, 'ooc'), false);
    assert.equal(confirm.cnt, 'confirm');
    assert.equal(confirm.ooc, 0);
    assert.equal(confirm.cu, 0.3849135688);
    assert.equal(confirm.pu, 229479.6247);
    assert.equal(buildTransactionKey(processed), buildTransactionKey(confirm));

    const pending = {
        txStateKey: buildTransactionKey(processed),
        action: 'sell',
        cnt: 'processed',
        ooc: processed.ooc,
        _coordinatorEventId: 'processed'
    };
    const merged = mergePendingSellConfirm(pending, {
        txStateKey: buildTransactionKey(confirm),
        action: 'sell',
        ooc: confirm.ooc,
        _coordinatorEventId: 'confirm'
    });
    assert.equal(merged, true);
    assert.equal(pending.ooc, 0);
    assert.deepEqual(buildSingleSpeechParts({
        rename: '测试钱包',
        tokenSymbol: confirm.bs,
        action: 'sell',
        ooc: pending.ooc,
        chainSpeakAs: 'BSC'
    }), ['BSC', '测试钱包', '减仓四']);
});

test('clear position upgrades the same sell to 清仓', () => {
    const processed = normalizeMessage(trackMessage(buyData({
        op: 'sell',
        volume: 0.3772883611,
        mc: 224933.5917,
        unix_time: 1790839911,
        tx_hash: CLEAR_TX
    })))[0];
    const confirm = normalizeMessage(positionMessage({
        chain: 'bsc',
        wallet: WALLET,
        token: TOKEN,
        token_symbol: '四',
        volume: 0.3735154775,
        mc: 224000,
        time: 1790839911000,
        position_action: 'clear_position',
        tx_hash: CLEAR_TX
    }))[0];
    assert.equal(confirm.ooc, 1);
    assert.equal(confirm.cu, processed.cu);
    assert.equal(confirm.ts, 1790839911);
    assert.equal(buildTransactionKey(processed), buildTransactionKey(confirm));
    assert.deepEqual(buildSingleSpeechParts({
        rename: '测试钱包',
        tokenSymbol: '四',
        action: 'sell',
        ooc: 1,
        chainSpeakAs: 'BSC'
    }), ['BSC', '测试钱包', '清仓四']);
});

test('position-only frames still map when the track frame was missed', () => {
    const open = normalizeMessage(positionMessage({
        chain: 'solana',
        wallet: WALLET,
        token: TOKEN,
        token_symbol: '四',
        volume: 2,
        mc: 1000,
        time: 1790839902,
        position_action: 'increase_position',
        tx_hash: BUY_TX
    }))[0];
    const close = normalizeMessage({
        type: 'socket-event',
        kind: '',
        event: 'wallet-position-track',
        args: [{
            chain: 'bsc',
            wallet: WALLET,
            token: TOKEN,
            token_symbol: '四',
            volume: 1,
            position_action: 'close',
            tx_hash: CLEAR_TX
        }]
    })[0];
    assert.equal(open.s, 'buy');
    assert.equal(open.n, 'sol');
    assert.equal(open.cnt, 'confirm');
    assert.equal(close.s, 'sell');
    assert.equal(close.ooc, 1);
    assert.equal(close.cu, 1);

    resetState();
    const timed = normalizeMessage(positionMessage({
        chain: 'bsc',
        wallet: WALLET,
        token: TOKEN,
        token_symbol: '四',
        volume: 1,
        time: 1790839911000,
        position_action: 'reduce',
        tx_hash: SELL_TX
    }))[0];
    assert.equal(timed.ooc, 0);
    assert.equal(timed.ts, 1790839911);
});

test('transfers, portal frames, and unrelated sockets are ignored', () => {
    assert.deepEqual(normalizeMessage(trackMessage(buyData({ op: 'trans_in' }))), []);
    assert.deepEqual(normalizeMessage(trackMessage(buyData({ op: 'trans_out' }))), []);
    assert.deepEqual(normalizeMessage(trackMessage(buyData({ op: 'burn' }))), []);
    assert.deepEqual(normalizeMessage(trackMessage(buyData(), 'portal')), []);
    assert.deepEqual(normalizeMessage({
        type: 'socket-event',
        kind: 'main',
        event: 'wallet-history-update',
        args: [{ data: buyData() }]
    }), []);
    assert.deepEqual(normalizeMessage({
        type: 'socket-event',
        kind: 'main',
        event: 'monitor-update',
        args: [{ data: buyData() }]
    }), []);
});

test('direct socket.io frames use the same mapping', () => {
    const payload = { data: buyData({ chain: 'ethereum', op: 'buy' }) };
    const raw = '42["wallet-track",' + JSON.stringify(payload) + ']';
    const items = normalizeMessage(raw);
    assert.equal(items.length, 1);
    assert.equal(items[0].n, 'eth');
    assert.equal(items[0].s, 'buy');
    assert.deepEqual(normalizeMessage(raw), []);
});

test('a late track frame does not replay a position that already arrived', () => {
    const first = normalizeMessage(positionMessage({
        chain: 'bsc',
        wallet: WALLET,
        token: TOKEN,
        token_symbol: '四',
        volume: 0.37,
        mc: 1000,
        position_action: 'clear_position',
        tx_hash: CLEAR_TX
    }));
    const late = normalizeMessage(trackMessage(buyData({
        op: 'sell',
        tx_hash: CLEAR_TX,
        volume: 0.4
    })));
    assert.equal(first.length, 1);
    assert.equal(first[0].ooc, 1);
    assert.deepEqual(late, []);
});

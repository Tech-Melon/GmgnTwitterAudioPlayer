const test = require('node:test');
const assert = require('node:assert/strict');
const okx = require('../lib/okx-wallet.js');
const { buildTransactionKey, buildSingleSpeechParts } = require('../lib/wallet-event.js');
const WALLET = 'BXjWHheC8HCC78oFcKHY9DUhZG6ujfXzsnDtXsHiusav';
const TOKEN = '78g2qqHVJCAhEpPCUoaoHmYVakzXevd5ELJt1bi5Gov2';
const TX = '5AGGG5QNCfUemDPQQGqCERyerLPS7vdoDqmSEd9TLAE1pmyuD135PEZU3oD4FDs8wHVNju2BPonFdKafHjNRSxB3';
// 结构取自 2026-11 实测 dex-market-tracker-sm-activity 帧（字段已裁剪）
function record(overrides = {}) {
    return {
        blockTime: 1795251698000,
        chainName: 'SOLANA',
        firstPriceTime: '1795251159000',
        logIndex: 20013,
        marketCap: '17062.859186443111',
        tagList: [['kol', { displayName: 'NicNocNic', name: 'NicNocNic' }]],
        tagTypeList: [2],
        tokenAddress: TOKEN,
        tokenChainId: '501',
        tokenNum: '0.071993',
        tokenSymbol: 'cracken',
        tradeTime: 1795251698000,
        turnover: 4.83612668255,
        txHash: TX,
        userActionType: 5,
        userActionTypeForDisplay: 2,
        walletAddress: WALLET,
        ...overrides
    };
}
function frame(channel, records) {
    return JSON.stringify({ arg: { channel }, data: records });
}
test.beforeEach(() => okx.resetState());
test('sm-activity record maps to unified wallet item', () => {
    const [item] = okx.normalizeMessage(frame('dex-market-tracker-sm-activity', [record()]));
    assert.deepEqual(item, {
        s: 'buy',
        n: 'sol',
        cnt: 'confirm',
        m: WALLET,
        h: TX,
        bs: 'cracken',
        ba: TOKEN,
        cu: 4.83612668255,
        pu: 17062.859186443111,
        bts: 1,
        ts: 1795251698,
        bct: 1795251159
    });
});
test('display action wins over raw action (1/2 buy, 3 reduce, 4 clear)', () => {
    const cases = [
        [{ userActionType: 5, userActionTypeForDisplay: 1 }, 'buy', undefined],
        [{ userActionType: 5, userActionTypeForDisplay: 2 }, 'buy', undefined],
        [{ userActionType: 6, userActionTypeForDisplay: 3 }, 'sell', 0],
        [{ userActionType: 6, userActionTypeForDisplay: 4 }, 'sell', 1]
    ];
    cases.forEach(([actions, s, ooc], index) => {
        const item = okx.toItem(record({ ...actions, txHash: `tx_${index}` }));
        assert.equal(item.s, s);
        assert.equal(item.ooc, ooc);
    });
});
test('raw action is fallback when display is missing', () => {
    assert.equal(okx.toItem(record({ userActionTypeForDisplay: undefined, userActionType: 6 })).s, 'sell');
    assert.equal(okx.toItem(record({ userActionTypeForDisplay: undefined, userActionType: 9 })), null);
});
test('chain id maps and unknown ids fall back to chainName', () => {
    assert.equal(okx.toItem(record({ tokenChainId: '56', chainName: 'BSC' })).n, 'bsc');
    assert.equal(okx.toItem(record({ tokenChainId: '8453', chainName: 'Base' })).n, 'base');
    assert.equal(okx.toItem(record({ tokenChainId: '99901', chainName: 'Elysium' })).n, 'elysium');
});
test('followed-address sidebar channel uses the same parser', () => {
    const items = okx.normalizeMessage(frame('dex-market-tracker-activity-sidebar', [record()]));
    assert.equal(items.length, 1);
});
test('multiple logIndex rows of one tx are announced once', () => {
    const rows = [record({ logIndex: 10005 }), record({ logIndex: 10011, tokenNum: '0.002915' })];
    assert.equal(okx.normalizeMessage(frame('dex-market-tracker-sm-activity', rows)).length, 1);
    assert.equal(okx.normalizeMessage(frame('dex-market-tracker-sm-activity', [record()])).length, 0);
});
test('acks, errors and unrelated channels are ignored', () => {
    assert.deepEqual(okx.normalizeMessage('{"event":"error","msg":"Please log in","code":"60011"}'), []);
    assert.deepEqual(okx.normalizeMessage(frame('dex-market-v3', [record()])), []);
    assert.deepEqual(okx.normalizeMessage('pong'), []);
});
test('item works with existing wallet speech + tx key helpers', () => {
    const item = okx.toItem(record({ userActionType: 6, userActionTypeForDisplay: 4 }));
    assert.equal(buildTransactionKey(item), `sol_${TX}_${TOKEN.toLowerCase()}`);
    const parts = buildSingleSpeechParts({ action: item.s, ooc: item.ooc, rename: 'NicNocNic', tokenSymbol: item.bs });
    assert.deepEqual(parts, ['NicNocNic', '清仓cracken']);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    stableStringify,
    buildEventId,
    buildSemanticKey
} = require('../lib/twitter-event.js');

test('twitter event id ignores outer WSS envelope and object key order', () => {
    const firstData = [{ id: '190001', tw: 'tweet', u: { s: 'binancezh', n: 'Binance' } }];
    const secondData = [{ u: { n: 'Binance', s: 'binancezh' }, tw: 'tweet', id: '190001' }];

    assert.equal(stableStringify(firstData), stableStringify(secondData));
    assert.equal(buildEventId(firstData), buildEventId(secondData));
});

test('different tweet ids from the same account remain distinct', () => {
    const first = [{ id: '190001', tw: 'tweet', u: { s: 'binancezh' } }];
    const second = [{ id: '190002', tw: 'tweet', u: { s: 'binancezh' } }];

    assert.notEqual(buildEventId(first), buildEventId(second));
    assert.equal(
        buildSemanticKey([{ id: 'binancezh', tw: 'tweet' }]),
        buildSemanticKey([{ id: 'binancezh', tw: 'tweet' }])
    );
});

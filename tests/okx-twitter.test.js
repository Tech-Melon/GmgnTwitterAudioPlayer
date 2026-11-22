const test = require('node:test');
const assert = require('node:assert/strict');
const okx = require('../lib/okx-twitter.js');
const twitterEvent = require('../lib/twitter-event.js');
const CHANNEL = 'dex-market-twitter-content-recommanded';
// 结构取自 2026-11 实测 wss://wsdexpri.okx.com/ws/v5/ipublic 帧
function postFrame(overrides = {}) {
    return JSON.stringify({
        arg: { channel: CHANNEL },
        data: [{
            author: {
                authorId: '788088998895026188',
                nickName: 'Leafswan',
                type: 1,
                username: 'Leaf_Swan'
            },
            content: '@0xAvseenko agree with u',
            contentId: '2124065686272290886',
            formatType: 4,
            imageList: [],
            publishTime: '1795251697000',
            ...overrides
        }]
    });
}
function translateFrame(contentId) {
    return JSON.stringify({
        arg: { channel: CHANNEL },
        data: [{ contentId, sourceLanguage: 'ru_RU', translatedContent: 'согласен с вами' }]
    });
}
test.beforeEach(() => okx.resetState());
test('real post frame maps to trigger with lowercase handle', () => {
    const results = okx.inspectMessage(postFrame());
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].trigger, {
        id: 'leaf_swan',
        tw: 'quote',
        name: 'Leafswan',
        tweetId: '2124065686272290886'
    });
});
test('formatType maps 2/4/5/6 and drops unknown', () => {
    const expected = { 2: 'tweet', 4: 'quote', 5: 'repost', 6: 'reply' };
    Object.entries(expected).forEach(([formatType, tw], index) => {
        const results = okx.inspectMessage(postFrame({ formatType: Number(formatType), contentId: `id_${index}` }));
        assert.equal(results[0].trigger.tw, tw);
    });
    assert.deepEqual(okx.inspectMessage(postFrame({ formatType: 9, contentId: 'id_x' })), []);
});
test('translation-only frames never produce events', () => {
    assert.deepEqual(okx.inspectMessage(translateFrame('2124065686272290886')), []);
});
test('same contentId plays once', () => {
    assert.equal(okx.inspectMessage(postFrame()).length, 1);
    assert.equal(okx.inspectMessage(postFrame()).length, 0);
});
test('subscribe ack, pong and other channels are ignored', () => {
    assert.deepEqual(okx.inspectMessage('pong'), []);
    assert.deepEqual(okx.inspectMessage(JSON.stringify({ event: 'subscribe', arg: { channel: CHANNEL }, connId: 'x' })), []);
    assert.deepEqual(okx.inspectMessage(postFrame().replace(CHANNEL, 'dex-market-v3')), []);
});
test('single object data is supported', () => {
    const frame = JSON.parse(postFrame());
    frame.data = frame.data[0];
    assert.equal(okx.inspectMessage(frame).length, 1);
});
test('removed content (approvalStatus 0) is dropped and not marked as seen', () => {
    assert.deepEqual(okx.inspectMessage(postFrame({ approvalStatus: 0 })), []);
    assert.equal(okx.inspectMessage(postFrame({ approvalStatus: 1 })).length, 1);
});
test('follow list url: full list only, search results ignored', () => {
    const base = 'https://web3.okx.com/priapi/v1/dx/market/v2/alert/twitter/alertList';
    assert.equal(okx.isFollowListUrl(`${base}?walletAddress=0xabc&t=1`), true);
    assert.equal(okx.isFollowListUrl('/priapi/v1/dx/market/v2/alert/twitter/alertList?walletAddress=0xabc'), true);
    assert.equal(okx.isFollowListUrl(`${base}?walletAddress=0xabc&twitterHandle=elon`), false);
    assert.equal(okx.isFollowListUrl('https://web3.okx.com/priapi/v1/dx/market/v2/alert/twitter/twitterList'), false);
});
test('follow list body (real alertList shape) maps to lowercase handles', () => {
    const body = {
        code: 0,
        data: {
            alerts: [
                { alertId: 24688, hasAlert: false, hasFollow: true, nickName: 'Star_OKX', tag: 2, twitterHandle: 'star_okx' },
                { hasFollow: true, twitterHandle: '@ElonMusk' },
                { hasFollow: false, twitterHandle: 'gone' }
            ],
            devId: 'x',
            isOwnDevice: true
        }
    };
    assert.deepEqual(okx.parseFollowList(body), ['star_okx', 'elonmusk']);
    assert.equal(okx.parseFollowList({ code: 50001, data: null }), null);
});
test('dispatch detail uses contentId as stable event id', () => {
    const [result] = okx.inspectMessage(postFrame());
    const detail = okx.buildDispatchDetail(result, twitterEvent);
    assert.deepEqual(detail.triggers, [result.trigger]);
    assert.equal(detail.eventId, twitterEvent.buildEventId([{ tweet_id: '2124065686272290886' }]));
    assert.match(detail.semanticKey, /^twitter_semantic_/);
});

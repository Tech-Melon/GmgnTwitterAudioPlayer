const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const okxScripts = require('../lib/okx-scripts.js');
const projectRoot = path.join(__dirname, '..');
const PUBLIC_URL = 'wss://wsdexpri.okx.com:443/ws/v5/ipublic';
const FOLLOW_URL = 'https://web3.okx.com/priapi/v1/dx/market/v2/alert/twitter/alertList?walletAddress=0xabc&t=1';
function createPage({ hidden = false, followBody = null } = {}) {
    const window = new EventTarget();
    const sockets = [];
    class FakeWebSocket extends EventTarget {
        constructor(url) {
            super();
            this.url = url;
            this.readyState = 1;
            this.sent = [];
            sockets.push(this);
        }
        send(data) {
            this.sent.push(data);
        }
        receive(data) {
            this.dispatchEvent(new MessageEvent('message', { data }));
        }
    }
    const document = { visibilityState: hidden ? 'hidden' : 'visible' };
    Object.assign(window, {
        window,
        document,
        WebSocket: FakeWebSocket,
        CustomEvent,
        MessageEvent,
        URL,
        Blob,
        Response,
        DecompressionStream,
        console,
        fetch: async () => new Response(JSON.stringify(followBody || { code: 0, data: { alerts: [] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    });
    const context = vm.createContext(window);
    okxScripts.MAIN_JS.forEach((file) => {
        vm.runInContext(fs.readFileSync(path.join(projectRoot, file), 'utf8'), context, { filename: file });
    });
    const events = { twitter: [], wallet: [], status: [] };
    window.addEventListener('TWITTER_WS_MSG_RECEIVED', (e) => events.twitter.push(e.detail));
    window.addEventListener('GMGN_WALLET_MSG', (e) => events.wallet.push(e.detail));
    window.addEventListener('GMGN_WS_STATUS', (e) => events.status.push(e.detail));
    return { window, document, sockets, events };
}
function syncFilter(window, overrides = {}) {
    window.dispatchEvent(new CustomEvent('GMGN_FILTER_SYNC', {
        detail: {
            ready: true,
            roleKnown: true,
            isProcessor: true,
            master: true,
            twitter: true,
            wallet: true,
            okx: true,
            walletChains: ['sol', 'bsc'],
            blockedTokens: [],
            walletAddrs: ['kolwallet111'],
            twitterIds: ['leaf_swan'],
            ...overrides
        }
    }));
}
function tweetFrame(username, contentId) {
    return JSON.stringify({
        arg: { channel: 'dex-market-twitter-content-recommanded' },
        data: [{ author: { username, nickName: username }, content: 'gm', contentId, formatType: 2 }]
    });
}
function tradeFrame(walletAddress, txHash, extra = {}) {
    return JSON.stringify({
        arg: { channel: 'dex-market-tracker-sm-activity' },
        data: [{
            walletAddress,
            txHash,
            tokenChainId: '501',
            chainName: 'SOLANA',
            tokenAddress: 'TokenMint111',
            tokenSymbol: 'PEPE',
            userActionType: 5,
            userActionTypeForDisplay: 1,
            turnover: 120.5,
            tradeTime: 1795251698000,
            ...extra
        }]
    });
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
test('only OKX dex public/private sockets are hooked', () => {
    const { window, events } = createPage();
    syncFilter(window);
    new window.WebSocket('wss://wsdexpri.okx.com/ws/v5/iprivate/dex').receive(tweetFrame('Leaf_Swan', 'a1'));
    new window.WebSocket('wss://jpushws.okx.com/').receive(tweetFrame('Leaf_Swan', 'a2'));
    assert.equal(events.twitter.length, 0);
});
test('twitter: mapped accounts only, translation frames ignored', () => {
    const { window, events } = createPage();
    syncFilter(window);
    const ws = new window.WebSocket(PUBLIC_URL);
    ws.receive(tweetFrame('Leaf_Swan', 't1'));
    ws.receive(tweetFrame('random_user', 't2'));
    ws.receive(JSON.stringify({
        arg: { channel: 'dex-market-twitter-content-recommanded' },
        data: [{ contentId: 't1', sourceLanguage: 'en', translatedContent: 'gm' }]
    }));
    ws.receive(tweetFrame('Leaf_Swan', 't1'));
    assert.equal(events.twitter.length, 1);
    assert.equal(events.twitter[0].triggers[0].id, 'leaf_swan');
    assert.equal(events.twitter[0].triggers[0].okxFollowed, undefined);
});
test('twitter: OKX followed accounts pass and are flagged for default-sound rules', async () => {
    const { window, events } = createPage({
        followBody: { code: 0, data: { alerts: [{ hasFollow: true, twitterHandle: 'CZ_Binance' }] } }
    });
    syncFilter(window, { twitterIds: [] });
    await window.fetch(FOLLOW_URL);
    await flush();
    const ws = new window.WebSocket(PUBLIC_URL);
    ws.receive(tweetFrame('cz_binance', 'f1'));
    ws.receive(tweetFrame('random_user', 'f2'));
    assert.equal(events.twitter.length, 1);
    assert.equal(events.twitter[0].triggers[0].okxFollowed, true);
});
test('twitter: nothing plays before filter sync (recommended feed is global)', () => {
    const { window, events } = createPage();
    window.dispatchEvent(new CustomEvent('GMGN_CHANNEL_TOGGLE', { detail: { okx: true } }));
    new window.WebSocket(PUBLIC_URL).receive(tweetFrame('Leaf_Swan', 't9'));
    assert.equal(events.twitter.length, 0);
});
test('deflate-raw Blob frames (official WebSocketCore path) are decoded', async () => {
    const { window, events } = createPage();
    syncFilter(window);
    const compressed = zlib.deflateRawSync(Buffer.from(tradeFrame('KolWallet111', 'txz'), 'utf8'));
    new window.WebSocket(PUBLIC_URL).receive(new Blob([compressed]));
    await flush();
    assert.equal(events.wallet.length, 1);
    assert.equal(events.wallet[0].item.h, 'txz');
});
test('wallet: dictionary, chain and block filters apply in MAIN world', () => {
    const { window, events } = createPage();
    syncFilter(window, { blockedTokens: ['doge'] });
    const ws = new window.WebSocket(PUBLIC_URL);
    ws.receive(tradeFrame('KolWallet111', 'tx1'));
    ws.receive(tradeFrame('stranger', 'tx2'));
    ws.receive(tradeFrame('KolWallet111', 'tx3', { tokenChainId: '1', chainName: 'Ethereum' }));
    ws.receive(tradeFrame('KolWallet111', 'tx4', { tokenSymbol: 'DOGE' }));
    assert.equal(events.wallet.length, 1);
    assert.equal(events.wallet[0].__gmgnWalletEnvelope, true);
    assert.equal(events.wallet[0].item.n, 'sol');
});
test('platform switch off or follower tab stays silent', () => {
    const { window, events } = createPage();
    syncFilter(window, { okx: false });
    const ws = new window.WebSocket(PUBLIC_URL);
    ws.receive(tradeFrame('KolWallet111', 'tx5'));
    syncFilter(window, { isProcessor: false });
    ws.receive(tradeFrame('KolWallet111', 'tx6'));
    assert.equal(events.wallet.length, 0);
});
test('hidden tab keeps monitored subscriptions; other channels and visible tabs pass', () => {
    const { window, document } = createPage({ hidden: true });
    syncFilter(window);
    const ws = new window.WebSocket(PUBLIC_URL);
    ws.send('{"op":"unsubscribe","args":[{"channel":"dex-market-twitter-content-recommanded"}]}');
    ws.send('{"op":"unsubscribe","args":[{"channel":"dex-market-tracker-sm-activity"},{"channel":"dex-market-v3"}]}');
    document.visibilityState = 'visible';
    ws.send('{"op":"unsubscribe","args":[{"channel":"dex-market-twitter-content-recommanded"}]}');
    assert.deepEqual(ws.sent.map((frame) => JSON.parse(frame).args.map((arg) => arg.channel)), [
        ['dex-market-v3'],
        ['dex-market-twitter-content-recommanded']
    ]);
});
test('keepalive sends official ping format only when the page is idle', () => {
    const { window } = createPage({ hidden: true });
    syncFilter(window);
    const ws = new window.WebSocket(PUBLIC_URL);
    window.dispatchEvent(new CustomEvent('GMGN_WS_KEEPALIVE'));
    assert.match(ws.sent[0], /^ping\|[0-9a-f]{32}\|\d{13}$/);
    ws.send('ping|page|1');
    window.dispatchEvent(new CustomEvent('GMGN_WS_KEEPALIVE'));
    assert.equal(ws.sent.length, 2);
});
test('keepalive is inert when OKX platform is off', () => {
    const { window } = createPage();
    syncFilter(window, { okx: false });
    const ws = new window.WebSocket(PUBLIC_URL);
    window.dispatchEvent(new CustomEvent('GMGN_WS_KEEPALIVE'));
    assert.equal(ws.sent.length, 0);
});

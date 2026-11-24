const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DEFAULT_TEMPLATE,
    normalizeConfig,
    renderTemplate,
    createTracker
} = require('../lib/multi-wallet-buy.js');

const CFG = { enabled: true, windowSec: 60, minWallets: 3, maxAlerts: 2, cooldownMin: 10 };
const buy = (wallet, now, extra = {}) => ({ key: 'sol_ca1', wallet, name: wallet.toUpperCase(), txKey: `${wallet}_${now}`, now, ...extra });

test('normalizeConfig clamps values and falls back to defaults', () => {
    const cfg = normalizeConfig({ enabled: true, windowSec: 1, minWallets: 99, maxAlerts: 'x', cooldownMin: 0, template: '  ' });
    assert.deepEqual(cfg, {
        enabled: true, windowSec: 10, minWallets: 10, maxAlerts: 3, cooldownMin: 1, template: DEFAULT_TEMPLATE
    });
    assert.equal(normalizeConfig(undefined).enabled, false);
});

test('disabled config never triggers', () => {
    const tracker = createTracker();
    assert.equal(tracker.record({ ...CFG, enabled: false }, buy('a', 1)).triggered, false);
});

test('triggers on the Nth distinct wallet; same wallet counts once', () => {
    const tracker = createTracker();
    assert.equal(tracker.record(CFG, buy('a', 1000)).count, 1);
    assert.equal(tracker.record(CFG, buy('a', 2000)).count, 1);
    assert.equal(tracker.record(CFG, buy('b', 3000)).count, 2);
    const hit = tracker.record(CFG, buy('c', 4000));
    assert.equal(hit.triggered, true);
    assert.equal(hit.count, 3);
    assert.deepEqual(hit.walletNames, ['A', 'B', 'C']);
    assert.equal(hit.alertIndex, 1);
});

test('wallets outside the window expire (sliding window)', () => {
    const tracker = createTracker();
    tracker.record(CFG, buy('a', 0));
    tracker.record(CFG, buy('b', 30000));
    const r = tracker.record(CFG, buy('c', 61000));
    assert.equal(r.triggered, false);
    assert.equal(r.count, 2);
});

test('different CAs are counted separately', () => {
    const tracker = createTracker();
    tracker.record(CFG, buy('a', 1));
    tracker.record(CFG, buy('b', 2));
    assert.equal(tracker.record(CFG, buy('c', 3, { key: 'sol_ca2' })).triggered, false);
});

test('recounts after each alert, then cools down after maxAlerts and resets afterwards', () => {
    const tracker = createTracker();
    ['a', 'b', 'c'].forEach((w, i) => tracker.record(CFG, buy(w, 1000 + i)));
    // 第 4 个钱包不会立刻再播：本轮已清空，需要重新凑满 3 个
    assert.equal(tracker.record(CFG, buy('d', 2000)).triggered, false);
    tracker.record(CFG, buy('a', 2001));
    const second = tracker.record(CFG, buy('b', 2002));
    assert.equal(second.triggered, true);
    assert.equal(second.alertIndex, 2);
    assert.equal(second.cooldownStarted, true);
    const cooling = tracker.record(CFG, buy('e', 3000));
    assert.equal(cooling.reason, 'cooldown');
    // 冷却 10 分钟结束后全部清零
    const afterCooldown = 2002 + 10 * 60 * 1000;
    tracker.record(CFG, buy('a', afterCooldown));
    tracker.record(CFG, buy('b', afterCooldown + 1));
    const again = tracker.record(CFG, buy('c', afterCooldown + 2));
    assert.equal(again.triggered, true);
    assert.equal(again.alertIndex, 1);
});

test('same tx is counted once; retry of the triggering tx replays the alert', () => {
    const tracker = createTracker();
    tracker.record(CFG, buy('a', 1, { txKey: 'tx_a' }));
    assert.equal(tracker.record(CFG, buy('a', 2, { txKey: 'tx_a' })).reason, 'duplicate_tx');
    tracker.record(CFG, buy('b', 3, { txKey: 'tx_b' }));
    assert.equal(tracker.record(CFG, buy('c', 4, { txKey: 'tx_c' })).triggered, true);
    const replay = tracker.record(CFG, buy('c', 5, { txKey: 'tx_c' }));
    assert.equal(replay.triggered, true);
    assert.equal(replay.replay, true);
    assert.equal(replay.alertIndex, 1);
});

test('serialize/restore keeps counting state across playback tabs', () => {
    const a = createTracker();
    a.record(CFG, buy('a', 1));
    a.record(CFG, buy('b', 2));
    const b = createTracker();
    b.restore(JSON.parse(JSON.stringify(a.serialize())));
    assert.equal(b.record(CFG, buy('c', 3)).triggered, true);
});

test('renderTemplate fills variables and keeps plain text as-is', () => {
    const vars = { token: 'PEPE', count: 3, wallet: '张三', walletNames: ['李四', '王五', '张三'], chain: 'SOL', windowSec: 60 };
    assert.equal(renderTemplate('', vars), 'SOL张三等3个钱包同时买入PEPE，请留意');
    assert.equal(renderTemplate('{wallets}在{window}内买入{token}', vars), '李四、王五、张三在1分钟内买入PEPE');
    assert.equal(renderTemplate('注意聪明钱抱团', vars), '注意聪明钱抱团');
    const many = { ...vars, walletNames: ['a', 'b', 'c', 'd', 'e', 'f'] };
    assert.equal(renderTemplate('{wallets}', many), 'a、b、c、d、e等');
});

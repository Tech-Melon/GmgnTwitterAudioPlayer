(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnOkxWallet = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';
    // OKX Web3 钱包追踪：
    // - 关注地址：wss://wsdexpri.okx.com/ws/v5/iprivate  dex-market-tracker-activity-sidebar / dex-market-tracker-activity
    // - KOL/聪明钱：wss://wsdexpri.okx.com/ws/v5/ipublic dex-market-tracker-sm-activity
    // 三个频道由同一套前端渲染逻辑消费，记录结构一致（walletAddress/tokenAddress/txHash/userActionTypeForDisplay...）
    const CHANNELS = Object.freeze([
        'dex-market-tracker-activity-sidebar',
        'dex-market-tracker-activity',
        'dex-market-tracker-sm-activity'
    ]);
    const CHANNEL_SET = new Set(CHANNELS);
    // OKX tokenChainId → 插件链 ID；未列出的链回退到 chainName（如 SOLANA→sol、BSC→bsc）
    const CHAIN_IDS = Object.freeze({
        501: 'sol',
        1: 'eth',
        56: 'bsc',
        8453: 'base',
        196: 'xlayer',
        195: 'tron'
    });
    const CHAIN_ALIASES = Object.freeze({
        solana: 'sol',
        ethereum: 'eth',
        binance: 'bsc',
        binancesmartchain: 'bsc',
        bnbchain: 'bsc'
    });
    // userActionTypeForDisplay：1 新建仓 / 2 加仓 / 3 减仓 / 4 清仓
    // userActionType（兜底）：5 买入 / 6 卖出
    const DISPLAY_ACTIONS = Object.freeze({
        1: { s: 'buy' },
        2: { s: 'buy' },
        3: { s: 'sell', ooc: 0 },
        4: { s: 'sell', ooc: 1 }
    });
    const RAW_ACTIONS = Object.freeze({
        5: { s: 'buy' },
        6: { s: 'sell', ooc: 0 }
    });
    const MAX_SEEN = 1000;
    const seen = new Map();
    function resetState() {
        seen.clear();
    }
    function normalizeChain(chain) {
        const normalized = String(chain || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        return CHAIN_ALIASES[normalized] || normalized;
    }
    function resolveChain(record) {
        const mapped = CHAIN_IDS[String(record.tokenChainId == null ? '' : record.tokenChainId).trim()];
        if (mapped) return mapped;
        return normalizeChain(record.chainName);
    }
    function toNumber(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string' || !value.trim()) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    function toUnixSeconds(value) {
        const parsed = toNumber(value);
        if (parsed == null || parsed <= 0) return null;
        return parsed > 1e12 ? Math.floor(parsed / 1000) : Math.floor(parsed);
    }
    function resolveAction(record) {
        return DISPLAY_ACTIONS[Number(record.userActionTypeForDisplay)]
            || RAW_ACTIONS[Number(record.userActionType)]
            || null;
    }
    function remember(key) {
        seen.delete(key);
        seen.set(key, true);
        while (seen.size > MAX_SEEN) {
            seen.delete(seen.keys().next().value);
        }
    }
    function parseFrame(input) {
        if (input && typeof input === 'object') return input;
        if (typeof input !== 'string') return null;
        if (input.indexOf('dex-market-tracker-') === -1 || input.indexOf('"txHash"') === -1) return null;
        try {
            return JSON.parse(input);
        } catch (error) {
            return null;
        }
    }
    /** 单条 OKX 交易记录 → 插件统一钱包 item；无法识别返回 null */
    function toItem(record) {
        if (!record || typeof record !== 'object') return null;
        const action = resolveAction(record);
        if (!action) return null;
        const chain = resolveChain(record);
        const wallet = String(record.walletAddress || '').trim();
        const tx = String(record.txHash || '').trim();
        const symbol = String(record.tokenSymbol || '').trim();
        const token = String(record.tokenAddress || record.tokenContractAddress || '').trim();
        if (!chain || !wallet || !tx || !symbol) return null;
        const item = {
            s: action.s,
            n: chain,
            cnt: 'confirm',
            m: wallet,
            h: tx,
            bs: symbol,
            ba: token || symbol
        };
        if (action.ooc === 0 || action.ooc === 1) item.ooc = action.ooc;
        const turnover = toNumber(record.turnover);
        if (turnover != null) item.cu = turnover;
        const marketCap = toNumber(record.marketCap);
        if (marketCap != null && marketCap > 0) {
            item.pu = marketCap;
            item.bts = 1;
        }
        const ts = toUnixSeconds(record.tradeTime != null ? record.tradeTime : record.blockTime);
        if (ts != null) item.ts = ts;
        const bct = toUnixSeconds(record.firstPriceTime);
        if (bct != null) item.bct = bct;
        return item;
    }
    /** 同一 tx 可能因多个 logIndex 推多条；按 链+tx+钱包+代币 只保留首条 */
    function dedupeKey(item) {
        return [item.n, item.h, item.m, item.ba].map((part) => String(part).toLowerCase()).join('_');
    }
    function normalizeMessage(input) {
        const frame = parseFrame(input);
        if (!frame || frame.event || !frame.arg || !CHANNEL_SET.has(frame.arg.channel)) return [];
        const list = Array.isArray(frame.data) ? frame.data : (frame.data ? [frame.data] : []);
        const items = [];
        list.forEach((record) => {
            const item = toItem(record);
            if (!item) return;
            const key = dedupeKey(item);
            if (seen.has(key)) return;
            remember(key);
            items.push(item);
        });
        return items;
    }
    return {
        CHANNELS,
        CHAIN_IDS,
        normalizeChain,
        toItem,
        normalizeMessage,
        resetState
    };
});

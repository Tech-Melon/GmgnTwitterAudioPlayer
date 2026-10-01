(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnDebotWallet = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';

    const TRACK_EVENT = 'wallet-track';
    const POSITION_EVENT = 'wallet-position-track';
    const CHAIN_ALIASES = {
        solana: 'sol',
        ethereum: 'eth',
        binance: 'bsc',
        binancesmartchain: 'bsc'
    };
    const BUY_ACTIONS = {
        open_position: true,
        increase_position: true,
        open: true,
        add: true
    };
    const REDUCE_ACTIONS = {
        reduce_position: true,
        reduce: true
    };
    const CLEAR_ACTIONS = {
        clear_position: true,
        close: true
    };
    const MAX_SEEN = 500;

    const quotes = new Map();
    const seen = new Map();

    function resetState() {
        quotes.clear();
        seen.clear();
    }

    function normalizeChain(chain) {
        const normalized = String(chain || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        return CHAIN_ALIASES[normalized] || normalized;
    }

    function parseJson(value) {
        if (value && typeof value === 'object') return value;
        if (typeof value !== 'string' || !value) return null;
        try {
            return JSON.parse(value);
        } catch (error) {
            return null;
        }
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
        if (parsed > 1e12) return Math.floor(parsed / 1000);
        return Math.floor(parsed);
    }

    function remember(map, key, value) {
        if (!key) return;
        map.delete(key);
        map.set(key, value);
        while (map.size > MAX_SEEN) {
            const oldest = map.keys().next().value;
            map.delete(oldest);
        }
    }

    function tradeKey(data) {
        const chain = normalizeChain(data && data.chain);
        const tx = String(data && data.tx_hash || '').trim().toLowerCase();
        const wallet = String(data && data.wallet || '').trim().toLowerCase();
        const token = String(data && data.token || '').trim().toLowerCase();
        if (!chain || !tx || !wallet || !token) return '';
        return chain + '_' + tx + '_' + wallet + '_' + token;
    }

    function tradeData(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
        const nested = payload.data;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            if (nested.tx_hash || nested.wallet || nested.op || nested.position_action) return nested;
        }
        if (payload.tx_hash || payload.wallet || payload.op || payload.position_action) return payload;
        return null;
    }

    function stageFor(eventName, data) {
        if (eventName === TRACK_EVENT) {
            const op = String(data.op || '').trim().toLowerCase();
            if (op === 'buy') return { s: 'buy', cnt: 'confirm' };
            if (op === 'sell') return { s: 'sell', cnt: 'processed' };
            return null;
        }
        if (eventName !== POSITION_EVENT) return null;
        const action = String(data.position_action || '').trim().toLowerCase();
        if (BUY_ACTIONS[action]) return { s: 'buy', cnt: 'confirm' };
        if (REDUCE_ACTIONS[action]) return { s: 'sell', cnt: 'confirm', ooc: 0 };
        if (CLEAR_ACTIONS[action]) return { s: 'sell', cnt: 'confirm', ooc: 1 };
        return null;
    }

    function quoteFrom(data) {
        return {
            cu: toNumber(data.volume),
            mc: toNumber(data.mc),
            ts: toUnixSeconds(data.unix_time != null ? data.unix_time : data.time),
            bct: toUnixSeconds(data.token_create_time),
            bs: String(data.token_symbol || '').trim()
        };
    }

    function buildItem(data, stage, eventName, key) {
        const chain = normalizeChain(data.chain);
        const wallet = String(data.wallet || '').trim();
        const token = String(data.token || '').trim();
        const tx = String(data.tx_hash || '').trim();
        if (!chain || !wallet || !token || !tx) return null;

        let quote = quoteFrom(data);
        if (!quote.bs) return null;
        if (eventName === TRACK_EVENT) {
            remember(quotes, key, quote);
        } else if (quotes.has(key)) {
            const first = quotes.get(key);
            quote = {
                cu: first.cu != null ? first.cu : quote.cu,
                mc: first.mc != null ? first.mc : quote.mc,
                ts: first.ts != null ? first.ts : quote.ts,
                bct: first.bct != null ? first.bct : quote.bct,
                bs: first.bs || quote.bs
            };
        }

        const item = {
            s: stage.s,
            n: chain,
            cnt: stage.cnt,
            m: wallet,
            h: tx,
            bs: quote.bs,
            ba: token
        };
        if (quote.cu != null) item.cu = quote.cu;
        if (quote.mc != null && quote.mc > 0) {
            item.pu = quote.mc;
            item.bts = 1;
        }
        if (quote.ts != null) item.ts = quote.ts;
        if (quote.bct != null) item.bct = quote.bct;
        if (stage.ooc === 0 || stage.ooc === 1) item.ooc = stage.ooc;
        return item;
    }

    function normalizeTrade(eventName, payload) {
        const data = tradeData(payload);
        if (!data) return null;
        const stage = stageFor(eventName, data);
        const key = tradeKey(data);
        if (!stage || !key) return null;
        const state = seen.get(key) || {};
        if (stage.s === 'buy') {
            if (state.buy) return null;
        } else if (stage.cnt === 'processed') {
            if (state.sellProcessed || state.sellConfirm) return null;
        } else if (state.sellConfirm) {
            return null;
        }

        const item = buildItem(data, stage, eventName, key);
        if (!item) return null;
        if (stage.s === 'buy') state.buy = true;
        else if (stage.cnt === 'processed') state.sellProcessed = true;
        else state.sellConfirm = true;
        remember(seen, key, state);
        return item;
    }

    function itemsFromEvent(eventName, args) {
        const name = String(eventName || '');
        if (name !== TRACK_EVENT && name !== POSITION_EVENT) return [];
        const list = Array.isArray(args) ? args : [args];
        const item = normalizeTrade(name, parseJson(list[0]));
        return item ? [item] : [];
    }

    function inspectWorkerMessage(message) {
        if (!message || typeof message !== 'object') return [];
        if (message.type !== 'socket-event') return [];
        if (message.kind && message.kind !== 'main') return [];
        return itemsFromEvent(message.event, message.args);
    }

    function inspectEngineIoFrame(raw) {
        if (typeof raw !== 'string') return [];
        if (raw.indexOf(TRACK_EVENT) === -1 && raw.indexOf(POSITION_EVENT) === -1) return [];
        if (raw.charCodeAt(0) !== 52 || raw.charCodeAt(1) !== 50) return [];
        let index = 2;
        while (index < raw.length) {
            const code = raw.charCodeAt(index);
            if (code < 48 || code > 57) break;
            index += 1;
        }
        if (raw.charAt(index) === '/') {
            const comma = raw.indexOf(',', index);
            if (comma === -1) return [];
            index = comma + 1;
        }
        const parsed = parseJson(raw.slice(index));
        if (!Array.isArray(parsed)) return [];
        return itemsFromEvent(parsed[0], parsed.slice(1));
    }

    function normalizeMessage(input) {
        if (input == null) return [];
        if (typeof input === 'string') return inspectEngineIoFrame(input);
        if (typeof input !== 'object') return [];
        if (input.type === 'socket-event' || input.event) return inspectWorkerMessage(input);
        return [];
    }

    return {
        TRACK_EVENT,
        POSITION_EVENT,
        normalizeChain,
        normalizeMessage,
        resetState
    };
});

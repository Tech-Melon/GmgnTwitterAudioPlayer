(function () {
    if (window.__DEBOT_AUDIO_INJECT_ACTIVE === true) return;
    window.__DEBOT_AUDIO_INJECT_ACTIVE = true;
    const injectionGeneration = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    window.__DEBOT_AUDIO_INJECT_GENERATION = injectionGeneration;
    window.__GMGN_DEBUG_LOGGING = window.__GMGN_DEBUG_LOGGING === true;
    const debugLog = (...args) => {
        if (window.__GMGN_DEBUG_LOGGING === true) console.log(...args);
    };

    debugLog('🚀 [GMGN 盯盘伴侣] Debot 注入已启动');

    window.__GMGN_AUDIO_ENABLED = window.__GMGN_AUDIO_ENABLED !== false;
    window.__GMGN_ENABLE_TWITTER = window.__GMGN_ENABLE_TWITTER !== false;
    window.__GMGN_ENABLE_WALLET = window.__GMGN_ENABLE_WALLET !== false;
    window.__GMGN_ENABLE_DEBOT = window.__GMGN_ENABLE_DEBOT === true;
    window.__GMGN_FILTER = window.__GMGN_FILTER || {
        ready: false,
        roleKnown: false,
        isProcessor: false,
        master: true,
        twitter: true,
        wallet: true,
        walletChains: null,
        blockedTokens: new Set(),
        walletAddrs: null
    };

    window.addEventListener('GMGN_AUDIO_TOGGLE', function (e) {
        window.__GMGN_AUDIO_ENABLED = !!(e.detail && e.detail.enabled);
    });
    window.addEventListener('GMGN_DEBUG_TOGGLE', function (e) {
        window.__GMGN_DEBUG_LOGGING = !!(e.detail && e.detail.enabled);
    });
    window.addEventListener('GMGN_CHANNEL_TOGGLE', function (e) {
        const d = e.detail || {};
        if (typeof d.master === 'boolean') window.__GMGN_AUDIO_ENABLED = d.master;
        if (typeof d.twitter === 'boolean') window.__GMGN_ENABLE_TWITTER = d.twitter;
        if (typeof d.wallet === 'boolean') window.__GMGN_ENABLE_WALLET = d.wallet;
        if (typeof d.debot === 'boolean') window.__GMGN_ENABLE_DEBOT = d.debot;
        const filter = window.__GMGN_FILTER;
        if (filter) {
            if (typeof d.master === 'boolean') filter.master = d.master;
            if (typeof d.twitter === 'boolean') filter.twitter = d.twitter;
            if (typeof d.wallet === 'boolean') filter.wallet = d.wallet;
            if (typeof d.debot === 'boolean') filter.debot = d.debot;
        }
    });
    window.addEventListener('GMGN_FILTER_SYNC', function (e) {
        const d = e.detail || {};
        const normalize = window.GmgnDebotWallet && typeof window.GmgnDebotWallet.normalizeChain === 'function'
            ? window.GmgnDebotWallet.normalizeChain
            : function (value) { return String(value || '').trim().toLowerCase(); };
        const nextChains = Array.isArray(d.walletChains)
            ? new Set(d.walletChains.map((chain) => normalize(chain)).filter(Boolean))
            : null;
        const nextBlocked = new Set(
            (Array.isArray(d.blockedTokens) ? d.blockedTokens : [])
                .map((token) => String(token || '').trim().toLowerCase())
                .filter(Boolean)
        );
        const nextAddrs = Array.isArray(d.walletAddrs)
            ? new Set(d.walletAddrs.map((addr) => String(addr || '').trim().toLowerCase()).filter(Boolean))
            : null;
        window.__GMGN_FILTER = {
            ready: d.ready !== false,
            roleKnown: d.roleKnown === true,
            isProcessor: d.isProcessor === true,
            master: d.master !== false,
            twitter: d.twitter !== false,
            wallet: d.wallet !== false,
            gmgn: d.gmgn !== false,
            debot: d.debot === true,
            walletChains: nextChains && nextChains.size > 0 ? nextChains : null,
            blockedTokens: nextBlocked,
            walletAddrs: nextAddrs && nextAddrs.size > 0 ? nextAddrs : null
        };
        if (typeof d.master === 'boolean') window.__GMGN_AUDIO_ENABLED = d.master;
        if (typeof d.twitter === 'boolean') window.__GMGN_ENABLE_TWITTER = d.twitter;
        if (typeof d.wallet === 'boolean') window.__GMGN_ENABLE_WALLET = d.wallet;
        if (typeof d.debot === 'boolean') window.__GMGN_ENABLE_DEBOT = d.debot;
    });

    function isSilentFollower() {
        const filter = window.__GMGN_FILTER;
        return !!(filter
            && filter.ready === true
            && filter.roleKnown === true
            && filter.isProcessor !== true);
    }

    function canEmitTwitter() {
        if (window.__DEBOT_AUDIO_INJECT_GENERATION !== injectionGeneration) return false;
        if (!window.__GMGN_AUDIO_ENABLED) return false;
        if (window.__GMGN_ENABLE_TWITTER === false) return false;
        if (window.__GMGN_ENABLE_DEBOT !== true) return false;
        if (isSilentFollower()) return false;
        return true;
    }

    function canEmitWallet() {
        if (window.__DEBOT_AUDIO_INJECT_GENERATION !== injectionGeneration) return false;
        if (!window.__GMGN_AUDIO_ENABLED) return false;
        if (window.__GMGN_ENABLE_WALLET === false) return false;
        if (window.__GMGN_ENABLE_DEBOT !== true) return false;
        if (isSilentFollower()) return false;
        return true;
    }

    function shouldDropWalletItem(item) {
        if (!item || (item.s !== 'buy' && item.s !== 'sell')) return true;
        const filter = window.__GMGN_FILTER;
        if (!filter || filter.ready !== true) return false;
        const normalize = window.GmgnDebotWallet && typeof window.GmgnDebotWallet.normalizeChain === 'function'
            ? window.GmgnDebotWallet.normalizeChain
            : function (value) { return String(value || '').trim().toLowerCase(); };
        if (filter.walletChains) {
            const chain = normalize(item.n);
            if (!chain || !filter.walletChains.has(chain)) return true;
        }
        if (filter.blockedTokens && filter.blockedTokens.size > 0) {
            const token = String(item.bs || '').trim().toLowerCase();
            if (token && filter.blockedTokens.has(token)) return true;
        }
        if (filter.walletAddrs) {
            const maker = String(item.m || '').trim().toLowerCase();
            if (!maker || !filter.walletAddrs.has(maker)) return true;
        }
        return false;
    }

    function emitWallet(input) {
        if (!canEmitWallet()) return;
        const api = window.GmgnDebotWallet;
        if (!api || typeof api.normalizeMessage !== 'function') return;
        let items = [];
        try {
            items = api.normalizeMessage(input);
        } catch (error) {
            console.error('❌ [GMGN 盯盘伴侣 - Debot] 钱包解析异常:', error);
            return;
        }
        if (!Array.isArray(items) || items.length === 0) return;
        const wssReceivedAt = Date.now();
        items.forEach((item) => {
            if (shouldDropWalletItem(item)) return;
            debugLog('✅ [GMGN 盯盘伴侣 - Debot] 钱包事件', item.s, item.cnt, item.bs);
            window.dispatchEvent(new CustomEvent('GMGN_WALLET_MSG', {
                detail: {
                    __gmgnWalletEnvelope: true,
                    item,
                    wssReceivedAt
                }
            }));
        });
    }

    function emitTwitter(result) {
        if (!result || !canEmitTwitter()) return;
        const api = window.GmgnDebotTwitter;
        if (!api || typeof api.buildDispatchDetail !== 'function') return;
        const detail = api.buildDispatchDetail(result, window.GmgnTwitterEvent);
        if (!detail || !Array.isArray(detail.triggers) || detail.triggers.length === 0) return;
        debugLog('✅ [GMGN 盯盘伴侣 - Debot] 推特事件', detail.triggers);
        window.dispatchEvent(new CustomEvent('TWITTER_WS_MSG_RECEIVED', { detail }));
    }

    function inspectAndEmit(input) {
        const api = window.GmgnDebotTwitter;
        if (!api || typeof api.inspectMessage !== 'function') return;
        try {
            const result = api.inspectMessage(input);
            if (result) emitTwitter(result);
        } catch (error) {
            console.error('❌ [GMGN 盯盘伴侣 - Debot] 解析异常:', error);
        }
    }

    function shouldHookSharedWorker(scriptURL, options) {
        const name = options && typeof options === 'object'
            ? String(options.name || '')
            : (typeof options === 'string' ? options : '');
        if (name === 'portal-ws-shared') return true;
        return String(scriptURL || '').indexOf('sharedSocketWorker') !== -1;
    }

    function wrapPort(port) {
        if (!port || port.__gmgnDebotPortHooked) return;
        port.__gmgnDebotPortHooked = true;
        let assignedOnMessage = null;
        try {
            Object.defineProperty(port, 'onmessage', {
                configurable: true,
                enumerable: true,
                get() {
                    return assignedOnMessage;
                },
                set(fn) {
                    assignedOnMessage = typeof fn === 'function' ? fn : null;
                }
            });
        } catch (error) {
            assignedOnMessage = null;
        }
        port.addEventListener('message', function (event) {
            const data = event && event.data;
            inspectAndEmit(data);
            emitWallet(data);
            if (typeof assignedOnMessage === 'function') {
                assignedOnMessage.call(port, event);
            }
        });
    }

    if (typeof window.SharedWorker === 'function' && !window.__DEBOT_ORIGINAL_SHARED_WORKER) {
        const OriginalSharedWorker = window.SharedWorker;
        window.__DEBOT_ORIGINAL_SHARED_WORKER = OriginalSharedWorker;
        const HookedSharedWorker = function (scriptURL, options) {
            const worker = options !== undefined
                ? new OriginalSharedWorker(scriptURL, options)
                : new OriginalSharedWorker(scriptURL);
            try {
                if (shouldHookSharedWorker(scriptURL, options)) wrapPort(worker.port);
            } catch (error) {
                // 包装失败不影响 Debot 自身连接
            }
            return worker;
        };
        HookedSharedWorker.prototype = OriginalSharedWorker.prototype;
        try {
            Object.setPrototypeOf(HookedSharedWorker, OriginalSharedWorker);
        } catch (error) {
            /* ignore */
        }
        window.SharedWorker = HookedSharedWorker;
    }

    function isDebotPortalWs(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
            const host = String(parsed.hostname || '').toLowerCase();
            if (host !== 'debot.ai' && !host.endsWith('.debot.ai')) return false;
            return parsed.pathname.indexOf('portal-ws') !== -1;
        } catch (error) {
            const lower = url.toLowerCase();
            return lower.indexOf('debot.ai') !== -1 && lower.indexOf('portal-ws') !== -1;
        }
    }

    function isDebotTradeWs(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
            return String(parsed.hostname || '').toLowerCase() === 'sgws.debot.ai';
        } catch (error) {
            return url.toLowerCase().indexOf('sgws.debot.ai') !== -1;
        }
    }

    if (!window.__DEBOT_ORIGINAL_WS) {
        window.__DEBOT_ORIGINAL_WS = window.WebSocket;
    }
    const OriginalWebSocket = window.__DEBOT_ORIGINAL_WS;
    if (typeof OriginalWebSocket === 'function' && !OriginalWebSocket.__gmgnDebotWsHooked) {
        const HookedWebSocket = function (url, protocols) {
            const ws = protocols !== undefined
                ? new OriginalWebSocket(url, protocols)
                : new OriginalWebSocket(url);
            const hookTwitter = isDebotPortalWs(url);
            const hookWallet = isDebotTradeWs(url);
            if (!hookTwitter && !hookWallet) return ws;
            if (hookTwitter) debugLog('🔗 [GMGN 盯盘伴侣 - Debot] 捕获 portal WebSocket:', url);
            if (hookWallet) debugLog('🔗 [GMGN 盯盘伴侣 - Debot] 捕获钱包 WebSocket:', url);
            ws.addEventListener('message', function (event) {
                if (typeof event.data !== 'string') return;
                if (hookTwitter) inspectAndEmit(event.data);
                if (hookWallet) emitWallet(event.data);
            });
            return ws;
        };
        HookedWebSocket.prototype = OriginalWebSocket.prototype;
        HookedWebSocket.__gmgnDebotWsHooked = true;
        ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((key) => {
            try {
                HookedWebSocket[key] = OriginalWebSocket[key];
            } catch (error) {
                /* ignore */
            }
        });
        try {
            Object.setPrototypeOf(HookedWebSocket, OriginalWebSocket);
        } catch (error) {
            /* ignore */
        }
        window.WebSocket = HookedWebSocket;
    }
})();

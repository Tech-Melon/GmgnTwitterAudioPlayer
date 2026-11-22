(function () {
    if (window.__OKX_AUDIO_INJECT_ACTIVE === true) return;
    window.__OKX_AUDIO_INJECT_ACTIVE = true;
    const injectionGeneration = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    window.__OKX_AUDIO_INJECT_GENERATION = injectionGeneration;
    window.__GMGN_DEBUG_LOGGING = window.__GMGN_DEBUG_LOGGING === true;
    const debugLog = (...args) => {
        if (window.__GMGN_DEBUG_LOGGING === true) console.log(...args);
    };
    debugLog('🚀 [GMGN 盯盘伴侣] OKX 注入已启动');
    window.__GMGN_AUDIO_ENABLED = window.__GMGN_AUDIO_ENABLED !== false;
    window.__GMGN_ENABLE_TWITTER = window.__GMGN_ENABLE_TWITTER !== false;
    window.__GMGN_ENABLE_WALLET = window.__GMGN_ENABLE_WALLET !== false;
    window.__GMGN_ENABLE_OKX = window.__GMGN_ENABLE_OKX === true;
    window.__GMGN_FILTER = window.__GMGN_FILTER || {
        ready: false,
        roleKnown: false,
        isProcessor: false,
        master: true,
        twitter: true,
        wallet: true,
        walletChains: null,
        blockedTokens: new Set(),
        walletAddrs: null,
        twitterIds: null
    };
    // OKX「我的关注」推特账号（来自页面自己拉取的 alertList 响应），等价 GMGN 的关注流
    let okxFollowed = new Set();
    // 页面隐藏 20 分钟后会退订推特/钱包追踪频道（官方 hiddenFreezeDelay=12e5），后台标签页因此静音
    const PROTECTED_CHANNELS = new Set([
        'dex-market-twitter-content-recommanded',
        'dex-market-tracker-activity-sidebar',
        'dex-market-tracker-activity',
        'dex-market-tracker-sm-activity'
    ]);
    // ── 保活与健康监测（对齐 GMGN inject.js）───────────────────────────
    // 后台标签页定时器被强节流，页面自身 5s 一次的 ping 会失效；SW 每 ~10s 触发 GMGN_WS_KEEPALIVE，
    // 仅当该连接超过 KEEPALIVE_IDLE_MS 无页面出站时才代发官方格式心跳 ping|<uuid32>|<ts>
    const KEEPALIVE_IDLE_MS = 12000;
    const WS_DISCONNECT_ALERT_MS = 60000;
    const WS_SILENT_ALERT_MS = 90000;
    const monitoredSockets = new Set();
    const wsHealth = { everOpen: false, lastOpenAt: 0, lastFrameAt: 0, unhealthy: false };
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
        if (typeof d.okx === 'boolean') window.__GMGN_ENABLE_OKX = d.okx;
    });
    function normalizeChain(value) {
        const api = window.GmgnOkxWallet;
        return api && typeof api.normalizeChain === 'function'
            ? api.normalizeChain(value)
            : String(value || '').trim().toLowerCase();
    }
    function toLowerSet(list, mapper) {
        if (!Array.isArray(list)) return null;
        return new Set(list.map((value) => mapper(value)).filter(Boolean));
    }
    window.addEventListener('GMGN_FILTER_SYNC', function (e) {
        const d = e.detail || {};
        const lower = (value) => String(value || '').trim().toLowerCase();
        const nextChains = toLowerSet(d.walletChains, normalizeChain);
        const nextAddrs = toLowerSet(d.walletAddrs, lower);
        const nextTwitter = toLowerSet(d.twitterIds, (value) => lower(value).replace(/^@+/, ''));
        window.__GMGN_FILTER = {
            ready: d.ready !== false,
            roleKnown: d.roleKnown === true,
            isProcessor: d.isProcessor === true,
            master: d.master !== false,
            twitter: d.twitter !== false,
            wallet: d.wallet !== false,
            okx: d.okx === true,
            walletChains: nextChains && nextChains.size > 0 ? nextChains : null,
            blockedTokens: toLowerSet(d.blockedTokens, lower) || new Set(),
            walletAddrs: nextAddrs && nextAddrs.size > 0 ? nextAddrs : null,
            // 推荐流是全站内容：未同步或为空时只放行 OKX 关注账号
            twitterIds: nextTwitter || new Set()
        };
        if (typeof d.master === 'boolean') window.__GMGN_AUDIO_ENABLED = d.master;
        if (typeof d.twitter === 'boolean') window.__GMGN_ENABLE_TWITTER = d.twitter;
        if (typeof d.wallet === 'boolean') window.__GMGN_ENABLE_WALLET = d.wallet;
        if (typeof d.okx === 'boolean') window.__GMGN_ENABLE_OKX = d.okx;
    });
    function isSilentFollower() {
        const filter = window.__GMGN_FILTER;
        return !!(filter
            && filter.ready === true
            && filter.roleKnown === true
            && filter.isProcessor !== true);
    }
    function isCurrentGeneration() {
        return window.__OKX_AUDIO_INJECT_GENERATION === injectionGeneration;
    }
    function canEmit(channelFlag) {
        if (!isCurrentGeneration()) return false;
        if (!window.__GMGN_AUDIO_ENABLED) return false;
        if (window[channelFlag] === false) return false;
        if (window.__GMGN_ENABLE_OKX !== true) return false;
        if (isSilentFollower()) return false;
        return true;
    }
    /** 白名单 = 已绑定铃声账号 ∪ OKX 关注账号；推荐流里的陌生账号一律不播 */
    function resolveTwitterAudience(trigger) {
        const filter = window.__GMGN_FILTER;
        if (!filter || filter.ready !== true) return null;
        const mapped = filter.twitterIds instanceof Set && filter.twitterIds.has(trigger.id);
        const followed = okxFollowed.has(trigger.id);
        if (!mapped && !followed) return null;
        return { followed };
    }
    function shouldDropWalletItem(item) {
        const filter = window.__GMGN_FILTER;
        if (!filter || filter.ready !== true) return false;
        if (filter.walletChains && !filter.walletChains.has(normalizeChain(item.n))) return true;
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
    function emitTwitter(raw) {
        if (!canEmit('__GMGN_ENABLE_TWITTER')) return;
        const api = window.GmgnOkxTwitter;
        if (!api || typeof api.inspectMessage !== 'function') return;
        let results = [];
        try {
            results = api.inspectMessage(raw);
        } catch (error) {
            console.error('❌ [GMGN 盯盘伴侣 - OKX] 推特解析异常:', error);
            return;
        }
        results.forEach((result) => {
            const audience = resolveTwitterAudience(result.trigger);
            if (!audience) return;
            // okxFollowed=true 时 content 按 GMGN 关注流处理（遵循「未绑定也播默认音」开关）
            if (audience.followed) result.trigger.okxFollowed = true;
            const detail = api.buildDispatchDetail(result, window.GmgnTwitterEvent);
            if (!detail) return;
            debugLog('✅ [GMGN 盯盘伴侣 - OKX] 推特事件', detail.triggers);
            window.dispatchEvent(new CustomEvent('TWITTER_WS_MSG_RECEIVED', { detail }));
        });
    }
    function emitWallet(raw) {
        if (!canEmit('__GMGN_ENABLE_WALLET')) return;
        const api = window.GmgnOkxWallet;
        if (!api || typeof api.normalizeMessage !== 'function') return;
        let items = [];
        try {
            items = api.normalizeMessage(raw);
        } catch (error) {
            console.error('❌ [GMGN 盯盘伴侣 - OKX] 钱包解析异常:', error);
            return;
        }
        if (!items.length) return;
        const wssReceivedAt = Date.now();
        items.forEach((item) => {
            if (shouldDropWalletItem(item)) return;
            debugLog('✅ [GMGN 盯盘伴侣 - OKX] 钱包事件', item.s, item.ooc, item.bs);
            window.dispatchEvent(new CustomEvent('GMGN_WALLET_MSG', {
                detail: { __gmgnWalletEnvelope: true, item, wssReceivedAt }
            }));
        });
    }
    function handleText(raw) {
        if (typeof raw !== 'string' || raw.length < 32 || raw.charCodeAt(0) !== 123) return;
        if (raw.indexOf('dex-market-twitter-content-recommanded') !== -1) {
            emitTwitter(raw);
            return;
        }
        if (raw.indexOf('dex-market-tracker-') !== -1) emitWallet(raw);
    }
    /** 官方 WebSocketCore：Blob 帧为 deflate-raw 压缩的 UTF-8 文本，需要先解压 */
    function inflateBinary(data) {
        if (typeof DecompressionStream !== 'function' || typeof Blob !== 'function') return;
        const blob = data instanceof Blob ? data : new Blob([data]);
        new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw')))
            .text()
            .then(handleText)
            .catch(() => { /* 非压缩/损坏帧：页面自身也会丢弃 */ });
    }
    function handleFrame(data) {
        if (typeof data === 'string') {
            handleText(data);
            return;
        }
        if (!data) return;
        const isBinary = (typeof Blob === 'function' && data instanceof Blob)
            || data instanceof ArrayBuffer
            || ArrayBuffer.isView(data);
        if (isBinary && (window.__GMGN_ENABLE_OKX === true)) inflateBinary(data);
    }
    // ── 「我的关注」：被动读取页面自己的 alertList 响应 ─────────────────
    function updateFollowList(body) {
        const api = window.GmgnOkxTwitter;
        if (!api || typeof api.parseFollowList !== 'function') return;
        const handles = api.parseFollowList(body);
        if (!handles) return;
        okxFollowed = new Set(handles);
        debugLog(`👥 [GMGN 盯盘伴侣 - OKX] 关注账号已同步 (${okxFollowed.size})`);
    }
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function' && !originalFetch.__gmgnOkxFetchHooked) {
        const hookedFetch = function (input) {
            const promise = originalFetch.apply(this, arguments);
            try {
                const api = window.GmgnOkxTwitter;
                const url = typeof input === 'string' ? input : (input && input.url);
                if (api && typeof api.isFollowListUrl === 'function' && api.isFollowListUrl(url)) {
                    promise.then((response) => {
                        if (!response || !response.ok) return;
                        response.clone().json().then(updateFollowList).catch(() => { /* ignore */ });
                    }).catch(() => { /* 页面自己处理请求失败 */ });
                }
            } catch (error) {
                /* 不影响页面请求 */
            }
            return promise;
        };
        hookedFetch.__gmgnOkxFetchHooked = true;
        window.fetch = hookedFetch;
    }
    // ── WebSocket hook ───────────────────────────────────────────────
    function generateUuid() {
        let text = '';
        for (let index = 0; index < 32; index += 1) text += '0123456789abcdef'[Math.floor(Math.random() * 16)];
        return text;
    }
    function isPageHidden() {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }
    /**
     * 后台标签页的冻结退订：只拦 PROTECTED_CHANNELS，其他频道原样放行。
     * 回到前台时页面会先退订再重订，此时 document 已可见，不会被拦。
     */
    function filterHiddenUnsubscribe(data) {
        if (typeof data !== 'string' || data.indexOf('"unsubscribe"') === -1) return data;
        if (window.__GMGN_ENABLE_OKX !== true || !isPageHidden()) return data;
        let frame;
        try {
            frame = JSON.parse(data);
        } catch (error) {
            return data;
        }
        if (!frame || frame.op !== 'unsubscribe' || !Array.isArray(frame.args)) return data;
        const kept = frame.args.filter((arg) => !(arg && PROTECTED_CHANNELS.has(arg.channel)));
        if (kept.length === frame.args.length) return data;
        debugLog('🛡️ [GMGN 盯盘伴侣 - OKX] 后台标签页保留订阅，已拦截退订');
        if (kept.length === 0) return null;
        return JSON.stringify({ ...frame, args: kept });
    }
    window.addEventListener('GMGN_WS_KEEPALIVE', function () {
        if (!isCurrentGeneration() || window.__GMGN_ENABLE_OKX !== true) return;
        const now = Date.now();
        let openCount = 0;
        monitoredSockets.forEach((ws) => {
            if (ws.readyState === 1) {
                openCount += 1;
                const lastPageSendAt = ws.__gmgnOkxLastPageSendAt || 0;
                if (lastPageSendAt && (now - lastPageSendAt) < KEEPALIVE_IDLE_MS) return;
                try {
                    ws.__gmgnOkxOriginalSend(`ping|${generateUuid()}|${now}`);
                } catch (error) {
                    /* 心跳失败不影响页面 */
                }
            } else if (ws.readyState === 3) {
                monitoredSockets.delete(ws);
            }
        });
        if (openCount > 0) wsHealth.lastOpenAt = now;
        const disconnectedTooLong = openCount === 0
            && wsHealth.lastOpenAt > 0
            && (now - wsHealth.lastOpenAt) > WS_DISCONNECT_ALERT_MS;
        const silentTooLong = openCount > 0
            && wsHealth.lastFrameAt > 0
            && (now - wsHealth.lastFrameAt) > WS_SILENT_ALERT_MS;
        const unhealthy = wsHealth.everOpen && (disconnectedTooLong || silentTooLong);
        if (unhealthy !== wsHealth.unhealthy) {
            wsHealth.unhealthy = unhealthy;
            window.dispatchEvent(new CustomEvent('GMGN_WS_STATUS', { detail: { healthy: !unhealthy } }));
            debugLog(`🩺 [GMGN 盯盘伴侣 - OKX] 推送连接状态: ${unhealthy ? '异常' : '恢复'}`);
        }
    });
    /** 仅拦截 wsdexpri.okx.com 的 /ws/v5/ipublic 与 /ws/v5/iprivate（不含 /iprivate/dex） */
    function isOkxDexWs(url) {
        try {
            const parsed = new URL(String(url));
            if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return false;
            if (String(parsed.hostname).toLowerCase() !== 'wsdexpri.okx.com') return false;
            const path = parsed.pathname.replace(/\/+$/, '');
            return path === '/ws/v5/ipublic' || path === '/ws/v5/iprivate';
        } catch (error) {
            return false;
        }
    }
    function attachSocket(ws) {
        const originalSend = ws.send.bind(ws);
        ws.__gmgnOkxOriginalSend = originalSend;
        ws.send = function (data) {
            const next = filterHiddenUnsubscribe(data);
            if (next === null) return undefined;
            ws.__gmgnOkxLastPageSendAt = Date.now();
            return originalSend(next);
        };
        monitoredSockets.add(ws);
        ws.addEventListener('open', function () {
            wsHealth.everOpen = true;
            wsHealth.lastOpenAt = Date.now();
            wsHealth.lastFrameAt = Date.now();
        });
        ws.addEventListener('close', function () {
            monitoredSockets.delete(ws);
        });
        ws.addEventListener('message', function (event) {
            wsHealth.lastFrameAt = Date.now();
            handleFrame(event.data);
        });
    }
    if (!window.__OKX_ORIGINAL_WS) {
        window.__OKX_ORIGINAL_WS = window.WebSocket;
    }
    const OriginalWebSocket = window.__OKX_ORIGINAL_WS;
    if (typeof OriginalWebSocket === 'function' && !OriginalWebSocket.__gmgnOkxWsHooked) {
        const HookedWebSocket = function (url, protocols) {
            const ws = protocols !== undefined
                ? new OriginalWebSocket(url, protocols)
                : new OriginalWebSocket(url);
            if (!isOkxDexWs(url)) return ws;
            debugLog('🔗 [GMGN 盯盘伴侣 - OKX] 捕获 WebSocket:', url);
            attachSocket(ws);
            return ws;
        };
        HookedWebSocket.prototype = OriginalWebSocket.prototype;
        HookedWebSocket.__gmgnOkxWsHooked = true;
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

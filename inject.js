(function () {
    if (window.__GMGN_AUDIO_INJECT_ACTIVE === true) return;
    window.__GMGN_AUDIO_INJECT_ACTIVE = true;
    const injectionGeneration = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    window.__GMGN_AUDIO_INJECT_GENERATION = injectionGeneration;
    window.__GMGN_DEBUG_LOGGING = false;
    const debugLog = (...args) => {
        if (window.__GMGN_DEBUG_LOGGING === true) console.log(...args);
    };

    debugLog(`🚀 [GMGN 盯盘伴侣] Inject.js 已启动 (轻量过滤版)`);

    // 🛡️ 幂等保护：扩展热更新时 inject.js 会被多次注入
    // 必须始终使用真正的原生 WebSocket，而不是上一次注入留下的代理
    if (!window.__GMGN_ORIGINAL_WS) {
        window.__GMGN_ORIGINAL_WS = window.WebSocket;
    }
    const OriginalWebSocket = window.__GMGN_ORIGINAL_WS;

    const PROTECTED_CHANNELS = new Set([
        'twitter_user_monitor_basic',
        'following_wallet_activity'
    ]);

    // ════════════════════════════════════════════════════════
    // 🫀 WSS 保活与健康监测
    // 后台标签页定时器被 Chrome 强节流（1 次/分钟），GMGN 页面自身的
    // 心跳会失效导致服务端断线（推特/钱包推送时断时续直至全停）。
    // 扩展消息不受节流：SW 每 ~10s 触发 GMGN_WS_KEEPALIVE。
    // 仅当该连接超过 KEEPALIVE_IDLE_MS 无页面出站时才代发心跳，
    // 避免与 GMGN 自带心跳撞车、抬高右下角延迟检测。
    // ════════════════════════════════════════════════════════
    const monitoredSockets = new Set();
    const WS_DISCONNECT_ALERT_MS = 60000;  // 无存活推送连接超过 1 分钟判定异常
    const WS_SILENT_ALERT_MS = 90000;      // 连接看似存活但 90s 无任何帧判定僵死
    const KEEPALIVE_IDLE_MS = 12000;       // 覆盖主通道 5s / 账号通道 10s 心跳
    const wsHealth = {
        everEligible: false,
        lastEligibleOpenAt: 0,
        lastFrameAt: 0,
        unhealthy: false
    };

    /** 标记该 socket 为「用户推送连接」（订阅/心跳协议帧或监控频道消息出现过） */
    function markSocketKeepaliveEligible(ws) {
        if (ws.__gmgnKeepaliveEligible) return;
        ws.__gmgnKeepaliveEligible = true;
        const now = Date.now();
        wsHealth.everEligible = true;
        if (!wsHealth.lastEligibleOpenAt) wsHealth.lastEligibleOpenAt = now;
        if (!wsHealth.lastFrameAt) wsHealth.lastFrameAt = now;
    }

    function buildKeepaliveFrame() {
        return JSON.stringify({
            action: 'heartbeat',
            channel: 'ping',
            data: { client_ts: Date.now() }
        });
    }

    window.addEventListener('GMGN_WS_KEEPALIVE', function () {
        if (window.__GMGN_AUDIO_INJECT_GENERATION !== injectionGeneration) return;
        const now = Date.now();
        let openEligible = 0;
        monitoredSockets.forEach(function (ws) {
            if (ws.readyState === 1 && ws.__gmgnKeepaliveEligible) {
                openEligible += 1;
                const lastPageSendAt = ws.__gmgnLastPageSendAt || 0;
                if (lastPageSendAt && (now - lastPageSendAt) < KEEPALIVE_IDLE_MS) return;
                try {
                    if (ws.__gmgnOriginalSend) ws.__gmgnOriginalSend(buildKeepaliveFrame());
                } catch (e) {
                    // 心跳失败不影响页面自身逻辑
                }
            } else if (ws.readyState === 3) {
                monitoredSockets.delete(ws);
            }
        });
        if (openEligible > 0) wsHealth.lastEligibleOpenAt = now;

        const disconnectedTooLong = openEligible === 0
            && wsHealth.lastEligibleOpenAt > 0
            && (now - wsHealth.lastEligibleOpenAt) > WS_DISCONNECT_ALERT_MS;
        const silentTooLong = openEligible > 0
            && wsHealth.lastFrameAt > 0
            && (now - wsHealth.lastFrameAt) > WS_SILENT_ALERT_MS;
        const unhealthy = wsHealth.everEligible && (disconnectedTooLong || silentTooLong);
        if (unhealthy !== wsHealth.unhealthy) {
            wsHealth.unhealthy = unhealthy;
            window.dispatchEvent(new CustomEvent('GMGN_WS_STATUS', {
                detail: { healthy: !unhealthy }
            }));
            debugLog(`🩺 [GMGN 盯盘伴侣 - Inject] 推送连接状态: ${unhealthy ? '异常' : '恢复'}`);
        }
    });

    // 钱包播报必需字段：丢弃头像/URL/无关数值，降低 CustomEvent 克隆成本
    const WALLET_KEEP_KEYS = [
        's', 'n', 'cnt', 'm', 'h', 'bs', 'ba', 'a',
        'cu', 'au', 'pu', 'bts', 'bct', 'ts', 'ooc',
        'id', 'si', 'nm'
    ];

    function hashWsPayload(value) {
        let hash = 2166136261;
        for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    window.__GMGN_AUDIO_ENABLED = true;
    window.__GMGN_ENABLE_TWITTER = true;
    window.__GMGN_ENABLE_WALLET = true;
    window.__GMGN_WS_BLOCKLIST = window.__GMGN_WS_BLOCKLIST instanceof Set
        ? window.__GMGN_WS_BLOCKLIST
        : new Set();

    // 轻量过滤状态（由 content 同步）。ready=false 时不做字典/链过滤，避免启动窗口漏报。
    window.__GMGN_FILTER = {
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
        const filter = window.__GMGN_FILTER;
        if (filter) {
            if (typeof d.master === 'boolean') filter.master = d.master;
            if (typeof d.twitter === 'boolean') filter.twitter = d.twitter;
            if (typeof d.wallet === 'boolean') filter.wallet = d.wallet;
        }
        debugLog('🎚️ [GMGN 盯盘伴侣 - Inject] 通道开关:', {
            master: window.__GMGN_AUDIO_ENABLED,
            twitter: window.__GMGN_ENABLE_TWITTER,
            wallet: window.__GMGN_ENABLE_WALLET
        });
    });

    window.addEventListener('GMGN_WS_BLOCKLIST', function (e) {
        const channels = (e.detail && Array.isArray(e.detail.channels)) ? e.detail.channels : [];
        const next = new Set();
        channels.forEach((ch) => {
            if (typeof ch !== 'string') return;
            const name = ch.trim();
            if (!name || PROTECTED_CHANNELS.has(name)) return;
            next.add(name);
        });
        window.__GMGN_WS_BLOCKLIST = next;
        debugLog(`🛡️ [GMGN 盯盘伴侣 - Inject] WSS 屏蔽列表已更新 (${next.size}):`, Array.from(next));
    });

    window.addEventListener('GMGN_FILTER_SYNC', function (e) {
        const d = e.detail || {};
        const nextChains = Array.isArray(d.walletChains)
            ? new Set(d.walletChains.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean))
            : null;
        const nextBlocked = new Set(
            (Array.isArray(d.blockedTokens) ? d.blockedTokens : [])
                .map((t) => String(t || '').trim().toLowerCase())
                .filter(Boolean)
        );
        const nextAddrs = Array.isArray(d.walletAddrs)
            ? new Set(d.walletAddrs.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean))
            : null;
        window.__GMGN_FILTER = {
            ready: d.ready !== false,
            roleKnown: d.roleKnown === true,
            isProcessor: d.isProcessor === true,
            master: d.master !== false,
            twitter: d.twitter !== false,
            wallet: d.wallet !== false,
            walletChains: nextChains && nextChains.size > 0 ? nextChains : null,
            blockedTokens: nextBlocked,
            walletAddrs: nextAddrs && nextAddrs.size > 0 ? nextAddrs : null
        };
        if (typeof d.master === 'boolean') window.__GMGN_AUDIO_ENABLED = d.master;
        if (typeof d.twitter === 'boolean') window.__GMGN_ENABLE_TWITTER = d.twitter;
        if (typeof d.wallet === 'boolean') window.__GMGN_ENABLE_WALLET = d.wallet;
        debugLog('🎛️ [GMGN 盯盘伴侣 - Inject] 过滤状态同步:', {
            isProcessor: window.__GMGN_FILTER.isProcessor,
            chains: window.__GMGN_FILTER.walletChains ? window.__GMGN_FILTER.walletChains.size : 0,
            blocked: window.__GMGN_FILTER.blockedTokens.size,
            wallets: window.__GMGN_FILTER.walletAddrs ? window.__GMGN_FILTER.walletAddrs.size : 0
        });
    });

    function isGmgnMonitorWsUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
            const host = String(parsed.hostname || '').toLowerCase();
            return host === 'ws.gmgn.ai'
                || host === 'gmgn.ai'
                || host.endsWith('.gmgn.ai');
        } catch (error) {
            const lower = url.toLowerCase();
            return lower.includes('gmgn.ai') && (lower.includes('/ws') || lower.includes('ws.'));
        }
    }

    function slimWalletItem(item) {
        if (!item || typeof item !== 'object') return null;
        const slim = {};
        for (let i = 0; i < WALLET_KEEP_KEYS.length; i++) {
            const key = WALLET_KEEP_KEYS[i];
            const value = item[key];
            if (value === undefined || value === null || value === '') continue;
            slim[key] = value;
        }
        return slim.s ? slim : null;
    }

    function normalizeChainId(chain) {
        const normalized = String(chain || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        if (normalized === 'solana') return 'sol';
        if (normalized === 'ethereum') return 'eth';
        if (normalized === 'binance' || normalized === 'binancesmartchain') return 'bsc';
        return normalized;
    }

    function shouldDropWalletItem(item) {
        if (!item || (item.s !== 'buy' && item.s !== 'sell')) return true;
        const filter = window.__GMGN_FILTER;
        if (!filter || filter.ready !== true) return false;

        if (filter.walletChains) {
            const chain = normalizeChainId(item.n);
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

    /**
     * 解析 subscribe 消息中的 channel 名
     * 兼容：纯 JSON / 前缀数字帧 / Socket.IO 风格
     */
    function extractSubscribeChannel(raw) {
        if (typeof raw !== 'string' || raw.length === 0) return null;
        if (raw.indexOf('subscribe') === -1) return null;

        try {
            let payloadStr = raw.replace(/^\d+/, '');
            if (!payloadStr) return null;
            let parsed = JSON.parse(payloadStr);
            if (Array.isArray(parsed) && parsed.length >= 2) parsed = parsed[1];
            if (typeof parsed === 'string') parsed = JSON.parse(parsed);
            if (parsed && parsed.action === 'subscribe' && typeof parsed.channel === 'string') {
                return parsed.channel;
            }
        } catch (e) {
            // 非 JSON 或解析失败：不拦截
        }
        return null;
    }

    function looksLikeWalletTrade(raw) {
        // 快速路径：未出现 buy/sell 字面量则无需 JSON.parse
        return raw.indexOf('"s":"buy"') !== -1
            || raw.indexOf('"s":"sell"') !== -1
            || raw.indexOf('"s": "buy"') !== -1
            || raw.indexOf('"s": "sell"') !== -1;
    }

    window.WebSocket = function (url, protocols) {
        const monitorThisSocket = isGmgnMonitorWsUrl(url);
        if (monitorThisSocket) {
            debugLog(`🔗 [GMGN 盯盘伴侣 - Inject] 捕获 GMGN WebSocket:`, url);
        }
        const ws = protocols !== undefined
            ? new OriginalWebSocket(url, protocols)
            : new OriginalWebSocket(url);

        // 非 GMGN 业务 WS（Intercom 等）：不挂监听、不改 send
        if (!monitorThisSocket) return ws;

        const originalSend = ws.send.bind(ws);
        ws.__gmgnOriginalSend = originalSend;
        monitoredSockets.add(ws);
        ws.addEventListener('close', function () {
            monitoredSockets.delete(ws);
        });
        ws.send = function (data) {
            const channel = extractSubscribeChannel(data);
            if (channel && window.__GMGN_WS_BLOCKLIST && window.__GMGN_WS_BLOCKLIST.has(channel)) {
                debugLog(`🚫 [GMGN 盯盘伴侣 - Inject] 已拦截 WSS 订阅: ${channel}`);
                return;
            }
            // 页面发出 subscribe/heartbeat 协议帧 → 该 socket 是用户推送连接。
            // lastPageSendAt 只记页面出站（本包装器），代发走 originalSend 不会更新。
            if (typeof data === 'string' && data.indexOf('"action":') !== -1) {
                ws.__gmgnLastPageSendAt = Date.now();
                markSocketKeepaliveEligible(ws);
            }
            return originalSend(data);
        };

        ws.addEventListener('message', function (event) {
            if (window.__GMGN_AUDIO_INJECT_GENERATION !== injectionGeneration) return;
            const wssReceivedAt = Date.now();
            // 健康记录须先于任何开关过滤：即便播报被关闭也要维持保活监测
            if (typeof event.data === 'string') {
                if (!ws.__gmgnKeepaliveEligible && (
                    event.data.indexOf('"channel":"pong"') !== -1
                    || event.data.indexOf('twitter_user_monitor_basic') !== -1
                    || event.data.indexOf('following_wallet_activity') !== -1
                )) {
                    markSocketKeepaliveEligible(ws);
                }
                if (ws.__gmgnKeepaliveEligible) wsHealth.lastFrameAt = wssReceivedAt;
            }
            if (!window.__GMGN_AUDIO_ENABLED) return;

            // 非 Processor Tab：MAIN 世界直接丢弃，避免 N 倍 CustomEvent + content 处理
            // roleKnown 之前不按角色丢弃，避免注册完成前的启动空窗漏报
            const filter = window.__GMGN_FILTER;
            if (filter
                && filter.ready === true
                && filter.roleKnown === true
                && filter.isProcessor !== true) return;

            if (typeof event.data !== 'string') return;
            const isTwitter = event.data.includes('twitter_user_monitor_basic');
            const isWallet = event.data.includes('following_wallet_activity');
            if (!isTwitter && !isWallet) return;
            if (isTwitter && !window.__GMGN_ENABLE_TWITTER) return;
            if (isWallet && !window.__GMGN_ENABLE_WALLET) return;
            if (isWallet && !looksLikeWalletTrade(event.data)) return;

            try {
                let payloadStr = event.data.replace(/^\d+/, '');
                if (!payloadStr) return;
                let parsed = JSON.parse(payloadStr);

                if (Array.isArray(parsed) && parsed.length >= 2) parsed = parsed[1];
                if (typeof parsed === 'string') parsed = JSON.parse(parsed);

                if (parsed && parsed.channel === 'twitter_user_monitor_basic' && parsed.data && Array.isArray(parsed.data)) {
                    if (!window.__GMGN_ENABLE_TWITTER) return;

                    const triggersMap = new Map();
                    parsed.data.forEach((tweetData) => {
                        if (!tweetData) return;
                        const actionType = tweetData.tw || 'unknown';
                        if (tweetData.u && tweetData.u.s) {
                            triggersMap.set(tweetData.u.s, {
                                actionType,
                                displayName: tweetData.u.n || tweetData.u.s
                            });
                        }
                    });

                    if (triggersMap.size > 0) {
                        const triggersArray = Array.from(triggersMap).map(([id, data]) => ({
                            id,
                            tw: data.actionType,
                            name: data.displayName
                        }));

                        window.dispatchEvent(new CustomEvent('TWITTER_WS_MSG_RECEIVED', {
                            detail: {
                                triggers: triggersArray,
                                eventId: window.GmgnTwitterEvent
                                    ? window.GmgnTwitterEvent.buildEventId(parsed.data)
                                    : `twitter_${hashWsPayload(JSON.stringify(parsed.data))}`,
                                semanticKey: window.GmgnTwitterEvent
                                    ? window.GmgnTwitterEvent.buildSemanticKey(triggersArray)
                                    : `twitter_semantic_${hashWsPayload(JSON.stringify(triggersArray))}`
                            }
                        }));
                    }
                } else if (parsed && parsed.channel === 'following_wallet_activity' && parsed.data && Array.isArray(parsed.data)) {
                    if (!window.__GMGN_ENABLE_WALLET) return;
                    parsed.data.forEach((item) => {
                        if (shouldDropWalletItem(item)) return;
                        const slim = slimWalletItem(item);
                        if (!slim) return;
                        window.dispatchEvent(new CustomEvent('GMGN_WALLET_MSG', {
                            detail: {
                                __gmgnWalletEnvelope: true,
                                item: slim,
                                wssReceivedAt
                            }
                        }));
                    });
                }
            } catch (error) {
                console.error('❌ [GMGN 盯盘伴侣 - Inject] 数据解析异常:', error);
            }
        });

        return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => {
        try {
            window.WebSocket[k] = OriginalWebSocket[k];
        } catch (e) { /* ignore */ }
    });
})();

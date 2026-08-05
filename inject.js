(function () {
    if (window.__GMGN_AUDIO_INJECT_ACTIVE === true) return;
    window.__GMGN_AUDIO_INJECT_ACTIVE = true;
    const injectionGeneration = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    window.__GMGN_AUDIO_INJECT_GENERATION = injectionGeneration;
    window.__GMGN_DEBUG_LOGGING = false;
    const debugLog = (...args) => {
        if (window.__GMGN_DEBUG_LOGGING === true) console.log(...args);
    };

    // 动态拼接版本号 (由于改为 world: MAIN 注入，无法直接读取 script.dataset，改为静态显示)
    debugLog(`🚀 [GMGN 盯盘伴侣] Inject.js 已启动 (注入机制优化版)`);

    // 🛡️ 幂等保护：扩展热更新时 inject.js 会被多次注入
    // 必须始终使用真正的原生 WebSocket，而不是上一次注入留下的代理
    // 否则会形成「代理套代理」导致信号丢失或重复
    if (!window.__GMGN_ORIGINAL_WS) {
        window.__GMGN_ORIGINAL_WS = window.WebSocket; // 首次注入：保存原生构造函数
    }
    const OriginalWebSocket = window.__GMGN_ORIGINAL_WS; // 始终引用真正的原生 WS

    // 插件自身依赖的频道，禁止误拦
    const PROTECTED_CHANNELS = new Set([
        'twitter_user_monitor_basic',
        'following_wallet_activity'
    ]);

    function hashWsPayload(value) {
        let hash = 2166136261;
        for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    window.__GMGN_AUDIO_ENABLED = true;       // 总开关
    window.__GMGN_ENABLE_TWITTER = true;      // 推特通道
    window.__GMGN_ENABLE_WALLET = true;       // 钱包通道
    window.__GMGN_WS_BLOCKLIST = window.__GMGN_WS_BLOCKLIST instanceof Set
        ? window.__GMGN_WS_BLOCKLIST
        : new Set();

    window.addEventListener('GMGN_AUDIO_TOGGLE', function (e) {
        window.__GMGN_AUDIO_ENABLED = !!(e.detail && e.detail.enabled);
    });

    window.addEventListener('GMGN_DEBUG_TOGGLE', function (e) {
        window.__GMGN_DEBUG_LOGGING = !!(e.detail && e.detail.enabled);
    });

    // content.js 同步：总开关 + 推特/钱包通道（修复单独关通道仍派发事件）
    window.addEventListener('GMGN_CHANNEL_TOGGLE', function (e) {
        const d = e.detail || {};
        if (typeof d.master === 'boolean') window.__GMGN_AUDIO_ENABLED = d.master;
        if (typeof d.twitter === 'boolean') window.__GMGN_ENABLE_TWITTER = d.twitter;
        if (typeof d.wallet === 'boolean') window.__GMGN_ENABLE_WALLET = d.wallet;
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

    /**
     * 解析 subscribe 消息中的 channel 名
     * 兼容：纯 JSON / 前缀数字帧 / Socket.IO 风格
     */
    function extractSubscribeChannel(raw) {
        if (typeof raw !== 'string' || raw.length === 0) return null;
        // 快速路径：非 subscribe 直接跳过
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

    window.WebSocket = function (url, protocols) {
        debugLog(`🔗 [GMGN 盯盘伴侣 - Inject] 成功捕获 WebSocket 连接创建:`, url);
        const ws = new OriginalWebSocket(url, protocols);

        // ── 出站：拦截黑名单频道的 subscribe ──
        const originalSend = ws.send.bind(ws);
        ws.send = function (data) {
            const channel = extractSubscribeChannel(data);
            if (channel && window.__GMGN_WS_BLOCKLIST && window.__GMGN_WS_BLOCKLIST.has(channel)) {
                debugLog(`🚫 [GMGN 盯盘伴侣 - Inject] 已拦截 WSS 订阅: ${channel}`);
                return;
            }
            return originalSend(data);
        };

        // ── 入站：仅监听推特 / 钱包监控频道 ──
        ws.addEventListener('message', function (event) {
            // 热更新或重复注入后，旧代际监听器立即失效，避免同一 WSS 被重复转发。
            if (window.__GMGN_AUDIO_INJECT_GENERATION !== injectionGeneration) return;
            const wssReceivedAt = Date.now();
            if (!window.__GMGN_AUDIO_ENABLED) return;
            if (typeof event.data !== 'string') return;
            const isTwitter = event.data.includes('twitter_user_monitor_basic');
            const isWallet = event.data.includes('following_wallet_activity');
            if (!isTwitter && !isWallet) return;
            // 通道级拦截：关推特/钱包时不再向 content 派发
            if (isTwitter && !window.__GMGN_ENABLE_TWITTER) return;
            if (isWallet && !window.__GMGN_ENABLE_WALLET) return;

            try {
                let payloadStr = event.data.replace(/^\d+/, '');
                if (!payloadStr) return;
                let parsed = JSON.parse(payloadStr);

                if (Array.isArray(parsed) && parsed.length >= 2) parsed = parsed[1];
                if (typeof parsed === 'string') parsed = JSON.parse(parsed);

                if (parsed && parsed.channel === 'twitter_user_monitor_basic' && parsed.data && Array.isArray(parsed.data)) {
                    if (!window.__GMGN_ENABLE_TWITTER) return;

                    const triggersMap = new Map();

                    parsed.data.forEach(tweetData => {
                        if (!tweetData) return;
                        const actionType = tweetData.tw || 'unknown';

                        // 🎯 核心修正：提取推特 ID (u.s) 和显示名称 (u.n)，用于 TTS 播报
                        if (tweetData.u && tweetData.u.s) {
                            triggersMap.set(tweetData.u.s, {
                                actionType: actionType,
                                displayName: tweetData.u.n || tweetData.u.s // 优先使用显示名称，降级使用 ID
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
                    parsed.data.forEach(item => {
                        // 仅买入/卖出会触发播报；transferOut 等高频状态在 MAIN World 就地丢弃。
                        if (!item || (item.s !== 'buy' && item.s !== 'sell')) return;
                        // 取消 cnt === "processed" 的过滤，交由 content.js 基于 txHash 进行去重，防止部分交易只有 confirm 导致漏播
                        window.dispatchEvent(new CustomEvent('GMGN_WALLET_MSG', {
                            detail: {
                                __gmgnWalletEnvelope: true,
                                item,
                                wssReceivedAt
                            }
                        }));
                    });
                }
            } catch (error) {
                console.error("❌ [GMGN 盯盘伴侣 - Inject] 数据解析异常:", error, event.data);
            }
        });

        return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    // 保留静态常量（CONNECTING/OPEN/CLOSING/CLOSED）
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => {
        try {
            window.WebSocket[k] = OriginalWebSocket[k];
        } catch (e) { /* ignore */ }
    });
})();

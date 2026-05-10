(function () {
    // 🌟 新增：读取注入当前脚本的 script 标签上的版本号
    const version = document.currentScript ? document.currentScript.dataset.extVersion : '未知版本';

    // 动态拼接版本号
    console.log(`🚀 [GMGN 盯盘伴侣] Inject.js 已启动 (v${version})`);

    // 🛡️ 幂等保护：扩展热更新时 inject.js 会被多次注入
    // 必须始终使用真正的原生 WebSocket，而不是上一次注入留下的代理
    // 否则会形成「代理套代理」导致信号丢失或重复
    if (!window.__GMGN_ORIGINAL_WS) {
        window.__GMGN_ORIGINAL_WS = window.WebSocket; // 首次注入：保存原生构造函数
    }
    const OriginalWebSocket = window.__GMGN_ORIGINAL_WS; // 始终引用真正的原生 WS

    window.__GMGN_AUDIO_ENABLED = true;
    window.addEventListener('GMGN_AUDIO_TOGGLE', function (e) {
        window.__GMGN_AUDIO_ENABLED = e.detail.enabled;
    });

    window.WebSocket = function (url, protocols) {
        const ws = new OriginalWebSocket(url, protocols);

        ws.addEventListener('message', function (event) {
            if (!window.__GMGN_AUDIO_ENABLED) return;
            if (typeof event.data !== 'string') return;
            const isTwitter = event.data.includes('twitter_user_monitor_basic');
            const isWallet = event.data.includes('following_wallet_activity');
            if (!isTwitter && !isWallet) return;

            try {
                let payloadStr = event.data.replace(/^\d+/, '');
                if (!payloadStr) return;
                let parsed = JSON.parse(payloadStr);

                if (Array.isArray(parsed) && parsed.length >= 2) parsed = parsed[1];
                if (typeof parsed === 'string') parsed = JSON.parse(parsed);

                if (parsed && parsed.channel === 'twitter_user_monitor_basic' && parsed.data && Array.isArray(parsed.data)) {

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
                            detail: { triggers: triggersArray }
                        }));
                    }
                } else if (parsed && parsed.channel === 'following_wallet_activity' && parsed.data && Array.isArray(parsed.data)) {
                    parsed.data.forEach(item => {
                        // 取消 cnt === "processed" 的过滤，交由 content.js 基于 txHash 进行去重，防止部分交易只有 confirm 导致漏播
                        window.dispatchEvent(new CustomEvent('GMGN_WALLET_MSG', {
                            detail: item
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
})();
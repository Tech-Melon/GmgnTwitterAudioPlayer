(function () {
    // 🌟 新增：读取注入当前脚本的 script 标签上的版本号
    const version = document.currentScript ? document.currentScript.dataset.extVersion : '未知版本';

    // 动态拼接版本号
    console.log(`🚀 [GMGN 盯盘伴侣] Inject.js 已启动 (v${version})`);

    const OriginalWebSocket = window.WebSocket;

    window.__GMGN_AUDIO_ENABLED = true;
    window.addEventListener('GMGN_AUDIO_TOGGLE', function (e) {
        window.__GMGN_AUDIO_ENABLED = e.detail.enabled;
    });

    window.WebSocket = function (url, protocols) {
        const ws = new OriginalWebSocket(url, protocols);

        ws.addEventListener('message', function (event) {
            if (!window.__GMGN_AUDIO_ENABLED) return;
            if (typeof event.data !== 'string') return;
            if (!event.data.includes('twitter_user_monitor_basic')) return;

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
                }
            } catch (error) {
                console.error("❌ [GMGN 盯盘伴侣 - Inject] 数据解析异常:", error, event.data);
            }
        });

        return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
})();
(function () {
    console.log("🚀 [GMGN 盯盘伴侣] Inject.js 已启动 (v1.2.1)");

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

                        // 🎯 核心修正：只提取主动发起动作的推特 ID (u.s)，彻底忽略被动提及 (su.s)
                        if (tweetData.u && tweetData.u.s) {
                            triggersMap.set(tweetData.u.s, actionType);
                        }
                    });

                    if (triggersMap.size > 0) {
                        const triggersArray = Array.from(triggersMap).map(([id, tw]) => ({ id, tw }));

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
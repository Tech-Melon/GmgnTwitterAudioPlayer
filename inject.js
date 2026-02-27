(function () {
    console.log("🚀 [GMGN 盯盘伴侣] Inject.js 已启动 (v1.1.0 极致性能版)");

    const OriginalWebSocket = window.WebSocket;

    window.__GMGN_AUDIO_ENABLED = true;
    window.addEventListener('GMGN_AUDIO_TOGGLE', function (e) {
        window.__GMGN_AUDIO_ENABLED = e.detail.enabled;
    });

    window.WebSocket = function (url, protocols) {
        const ws = new OriginalWebSocket(url, protocols);

        ws.addEventListener('message', function (event) {
            // 1. 开关拦截
            if (!window.__GMGN_AUDIO_ENABLED) return;
            // 2. 类型拦截（过滤掉 Blob/ArrayBuffer 等二进制流）
            if (typeof event.data !== 'string') return;

            // 🌟 性能核心防线：O(n) 级字符串快速检索
            // 只放行明确包含目标频道的字符串，杜绝无关数据的解析开销
            if (!event.data.includes('twitter_user_monitor_basic')) return;

            try {
                // 🌟 性能优化：使用 replace 替代正则捕获组，更高效地剔除 Socket.io 前缀 (如 "42")
                let payloadStr = event.data.replace(/^\d+/, '');

                if (!payloadStr) return;

                // 只有闯过前面关卡的数据，才允许进行昂贵的反序列化操作
                let parsed = JSON.parse(payloadStr);

                // 解包 Socket.io 数组格式: ["event_name", {payload}]
                if (Array.isArray(parsed) && parsed.length >= 2) {
                    parsed = parsed[1];
                }

                // 处理可能存在的双重序列化
                if (typeof parsed === 'string') {
                    parsed = JSON.parse(parsed);
                }

                // 精确的业务级条件判断
                if (parsed && parsed.channel === 'twitter_user_monitor_basic' && parsed.data && Array.isArray(parsed.data)) {

                    const idsToTrigger = new Set();

                    parsed.data.forEach(tweetData => {
                        if (!tweetData) return;

                        // 定位动作发起者 (u.s)
                        if (tweetData.u && tweetData.u.s) {
                            idsToTrigger.add(tweetData.u.s);
                        }
                    });

                    if (idsToTrigger.size > 0) {
                        const targetIds = Array.from(idsToTrigger);
                        console.log("📣 [GMGN 盯盘伴侣 - Inject] 捕获并发起广播:", targetIds);

                        // 分发事件到 content.js 的任务队列中
                        window.dispatchEvent(new CustomEvent('TWITTER_WS_MSG_RECEIVED', {
                            detail: { twitterIds: targetIds }
                        }));
                    }
                }
            } catch (error) {
                // 只有针对确实包含目标频道的、却解析失败的异形数据，才打印错误
                console.error("❌ [GMGN 盯盘伴侣 - Inject] 数据解析异常:", error, event.data);
            }
        });

        return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
})();
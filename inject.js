(function () {
    const OriginalWebSocket = window.WebSocket;

    window.__GMGN_AUDIO_ENABLED = true;
    window.addEventListener('GMGN_AUDIO_TOGGLE', function (e) {
        window.__GMGN_AUDIO_ENABLED = e.detail.enabled;
    });

    window.WebSocket = function (url, protocols) {
        const ws = new OriginalWebSocket(url, protocols);

        ws.addEventListener('message', function (event) {
            if (!window.__GMGN_AUDIO_ENABLED) return;

            // 🌟 恢复：严格只监听 twitter_user_monitor_basic 频道，不浪费性能
            if (typeof event.data === 'string' &&
                event.data.includes('twitter_user_monitor_basic') &&
                event.data.includes('"s":')) {

                try {
                    let jsonStr = event.data;
                    const prefixMatch = jsonStr.match(/^(\d+)(.*)/);
                    if (prefixMatch && prefixMatch[2]) {
                        jsonStr = prefixMatch[2];
                        if (jsonStr.startsWith('[')) {
                            const parsedArray = JSON.parse(jsonStr);
                            if (parsedArray.length > 1) {
                                jsonStr = JSON.stringify(parsedArray[1]);
                            }
                        }
                    }

                    const dataObj = JSON.parse(jsonStr);

                    if (dataObj.data && Array.isArray(dataObj.data)) {
                        dataObj.data.forEach(tweetData => {
                            if (!tweetData) return;

                            // 🌟 核心保留：使用 Set 集合来瞬间去重
                            const idsToTrigger = new Set();

                            // 🏆 修复：绝对唯一指标。谁发出的动作，就判定为谁发推。
                            if (tweetData.u && tweetData.u.s) {
                                idsToTrigger.add(tweetData.u.s);
                            }

                            // ❌ 已经彻底删除 tweetData.su 的提取逻辑
                            // 哪怕路人引用了 100 个大 V，也只会响路人的提示音（或默认音）

                            if (idsToTrigger.size > 0) {
                                window.dispatchEvent(new CustomEvent('TWITTER_WS_MSG_RECEIVED', {
                                    detail: { twitterIds: Array.from(idsToTrigger) }
                                }));
                            }
                        });
                    }
                } catch (error) {
                    console.error("[GMGN 盯盘伴侣] 🚨 解析失败！", error.message);
                }
            }
        });

        return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
})();
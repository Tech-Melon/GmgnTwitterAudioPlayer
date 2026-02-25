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

                    if (dataObj.data && Array.isArray(dataObj.data) && dataObj.data.length > 0) {
                        const tweetData = dataObj.data[0];
                        if (tweetData && tweetData.u && tweetData.u.s) {
                            const twitterId = tweetData.u.s;
                            window.dispatchEvent(new CustomEvent('TWITTER_WS_MSG_RECEIVED', {
                                detail: { twitterId: twitterId }
                            }));
                        }
                    }
                } catch (error) {
                    console.error("[GmgnAudioPlayer] 🚨 致命错误：解析失败！", error.message);
                    console.error("导致崩溃的原始数据:", event.data);
                }
            }
        });

        return ws;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
})();
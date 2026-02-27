const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js') + '?v=' + Date.now();
script.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(script);

let configCache = {
    mappings: {}, customAudios: {}, defaultAudio: "sounds/default.MP3", isMasterEnabled: true, globalVolume: 1.0
};

// 🌟 修复：增加挂起队列。防止 WS 消息比数据库读取还要快
let isCacheReady = false;
let pendingWsMessages = [];
const audioSyncChannel = new BroadcastChannel('gmgn_audio_sync_channel');
let isLockedByOtherTab = false;

audioSyncChannel.onmessage = (event) => {
    if (event.data === 'PLAYING_AUDIO') {
        isLockedByOtherTab = true;
        setTimeout(() => { isLockedByOtherTab = false; }, 2000);
    }
};

function syncMasterToggle() {
    window.dispatchEvent(new CustomEvent('GMGN_AUDIO_TOGGLE', { detail: { enabled: configCache.isMasterEnabled } }));
}

async function convertBase64ToBlobUrl(customAudiosObj) {
    for (const key in customAudiosObj) {
        const audioItem = customAudiosObj[key];
        if (typeof audioItem.data === 'string' && audioItem.data.startsWith('blob:')) URL.revokeObjectURL(audioItem.data);
        if (typeof audioItem.data === 'string' && audioItem.data.startsWith('data:')) {
            try {
                const res = await fetch(audioItem.data);
                const blob = await res.blob();
                audioItem.data = URL.createObjectURL(blob);
            } catch (e) {
                console.error("[GMGN 盯盘伴侣] Blob 转换失败:", e);
            }
        }
    }
}

chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'globalVolume'], async (result) => {
    if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
    if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
    if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
    if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;

    if (result.customAudios) {
        configCache.customAudios = result.customAudios;
        await convertBase64ToBlobUrl(configCache.customAudios);
    }

    syncMasterToggle();
    isCacheReady = true;

    // 🌟 触发积压的消息
    if (pendingWsMessages.length > 0) {
        console.log(`[GMGN 盯盘伴侣] 数据库就绪，开始处理 ${pendingWsMessages.length} 条开局暂存消息...`);
        pendingWsMessages.forEach(processTwitterMessage);
        pendingWsMessages = [];
    }
});

chrome.storage.onChanged.addListener(async (changes, namespace) => {
    if (namespace === 'local') {
        if (changes.twitterAudioMappings) configCache.mappings = changes.twitterAudioMappings.newValue || {};
        if (changes.globalVolume) configCache.globalVolume = changes.globalVolume.newValue;
        if (changes.isMasterEnabled) {
            configCache.isMasterEnabled = changes.isMasterEnabled.newValue;
            syncMasterToggle();
        }
        if (changes.customAudios) {
            configCache.customAudios = changes.customAudios.newValue || {};
            await convertBase64ToBlobUrl(configCache.customAudios);
        }
    }
});

let lastPlayTime = {};
let globalLastPlayTime = 0;

function processTwitterMessage(e) {
    if (Object.keys(lastPlayTime).length > 1000) lastPlayTime = {};
    if (!e.detail || !Array.isArray(e.detail.twitterIds)) return;

    const now = Date.now();
    let vipAudioSrc = null;
    let vipFallbackDefault = false;
    let nobodyWantsDefault = false;
    let isVipPresent = false;
    let matchedVipName = "无";

    e.detail.twitterIds.forEach(rawId => {
        if (typeof rawId !== 'string') return;
        const twitterId = rawId.trim().toLowerCase();
        const rule = configCache.mappings[twitterId];
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;

        if (mappedAudioId) {
            isVipPresent = true;
            matchedVipName = twitterId;
            if (lastPlayTime[twitterId] && (now - lastPlayTime[twitterId] < 2500)) return;
            lastPlayTime[twitterId] = now;

            if (configCache.customAudios[mappedAudioId]) {
                const customObj = configCache.customAudios[mappedAudioId];
                vipAudioSrc = typeof customObj === 'string' ? customObj : customObj.data;
            } else if (mappedAudioId.startsWith('custom_')) {
                vipFallbackDefault = true;
            } else {
                vipAudioSrc = chrome.runtime.getURL(`sounds/${mappedAudioId}`);
            }
        } else {
            if (lastPlayTime[twitterId] && (now - lastPlayTime[twitterId] < 2500)) return;
            lastPlayTime[twitterId] = now;
            nobodyWantsDefault = true;
        }
    });

    // 🌟 增加核心 Debug 日志
    console.log(`[GMGN 盯盘伴侣] 解析推文动作 -> 推特ID: ${e.detail.twitterIds.join(',')}, 是否大V: ${isVipPresent} (${matchedVipName})`);

    // 🌟 核心播放函数：每次调用都生成独立的音频流，实现无阻塞并发混音
    const playConcurrentAudio = (src) => {
        const player = new Audio(src);
        player.volume = configCache.globalVolume;
        player.play().catch(err => {
            if (err.name === 'NotAllowedError') {
                console.warn("⚠️ [GMGN 盯盘伴侣] 浏览器拦截了自动播放！请随便点击一下页面的空白处来激活音频权限。");
            } else {
                console.warn("[GMGN 盯盘伴侣] Playback Error:", err);
            }
        });
    };

    try {
        if (vipAudioSrc) {
            console.log(`[GMGN 盯盘伴侣] 🔊 触发大V专属音频 (并发混音)...`);
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO');
            playConcurrentAudio(vipAudioSrc);

        } else if (vipFallbackDefault) {
            console.log(`[GMGN 盯盘伴侣] 🔊 大V降级默认音 (并发混音)...`);
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO');
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio));

        } else if (nobodyWantsDefault && !isVipPresent) {
            // 🛑 纯路人局：依然保留 2 秒的大盘全局防噪过滤
            // 避免短时间内几百个路人同时发推把扬声器震破
            if (now - globalLastPlayTime > 2000) {
                console.log(`[GMGN 盯盘伴侣] 🔊 触发纯路人默认音频 (并发混音)...`);
                globalLastPlayTime = now;
                audioSyncChannel.postMessage('PLAYING_AUDIO');
                playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio));
            } else {
                console.log(`[GMGN 盯盘伴侣] 🛑 拦截路人音频: 距上次发声不足2秒，触发防噪机制。`);
            }
        }
    } catch (error) {
        console.error("[GMGN 盯盘伴侣] 播放异常捕获:", error);
    }
}

window.addEventListener('TWITTER_WS_MSG_RECEIVED', function (e) {
    if (!configCache.isMasterEnabled || isLockedByOtherTab) return;

    if (!isCacheReady) {
        // 🌟 将读取数据库前就到达的推文暂存起来，而不是抛弃
        pendingWsMessages.push(e);
        return;
    }

    processTwitterMessage(e);
});
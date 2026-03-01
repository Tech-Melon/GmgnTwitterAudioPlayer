const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js') + '?v=' + Date.now();
script.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(script);

let configCache = {
    mappings: {}, customAudios: {}, defaultAudio: "sounds/default.MP3", isMasterEnabled: true, globalVolume: 1.0,
    eventFilters: { tweet: true, repost: true, reply: true, quote: true, other: true }
};

// 🌟 新增核心：极速内存预热引擎
let preloadedAudios = new Map();

function warmupAudio(src) {
    if (!src) return;
    if (!preloadedAudios.has(src)) {
        const audio = new Audio();
        audio.preload = 'auto'; // 强制浏览器在后台拉取并立刻解码音频
        audio.src = src;
        audio.load();           // 将音频载入驻留内存
        preloadedAudios.set(src, audio);
    }
}

// 🌟 将所有可能播放的音频提前灌入内存池
function initPreloadCache() {
    preloadedAudios.clear();

    // 1. 预热默认提示音
    warmupAudio(chrome.runtime.getURL(configCache.defaultAudio));

    // 2. 预热自定义音频 (高速 Blob 链接)
    for (const key in configCache.customAudios) {
        const audioItem = configCache.customAudios[key];
        if (audioItem && audioItem.data) warmupAudio(audioItem.data);
    }

    // 3. 预热扩展内置的预设音频
    for (const key in configCache.mappings) {
        const rule = configCache.mappings[key];
        const audioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;
        if (audioId && !audioId.startsWith('custom_')) {
            warmupAudio(chrome.runtime.getURL(`sounds/${audioId}`));
        }
    }
    console.log("🚀 [GMGN 盯盘伴侣] 音频底座预热完成，进入 0 毫秒响应待命状态！");
}

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

chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'globalVolume', 'eventFilters'], async (result) => {
    if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
    if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
    if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
    if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;

    if (result.eventFilters) configCache.eventFilters = result.eventFilters;
    if (configCache.eventFilters.other === undefined) configCache.eventFilters.other = true;

    if (result.customAudios) {
        configCache.customAudios = result.customAudios;
        await convertBase64ToBlobUrl(configCache.customAudios);
    }

    // 🌟 在数据加载完毕后，立刻执行预热
    initPreloadCache();

    syncMasterToggle();
    isCacheReady = true;

    if (pendingWsMessages.length > 0) {
        pendingWsMessages.forEach(processTwitterMessage);
        pendingWsMessages = [];
    }
});

chrome.storage.onChanged.addListener(async (changes, namespace) => {
    if (namespace === 'local') {
        let needsPreload = false;

        if (changes.twitterAudioMappings) {
            configCache.mappings = changes.twitterAudioMappings.newValue || {};
            needsPreload = true;
        }
        if (changes.globalVolume) configCache.globalVolume = changes.globalVolume.newValue;
        if (changes.eventFilters) configCache.eventFilters = changes.eventFilters.newValue;
        if (changes.isMasterEnabled) {
            configCache.isMasterEnabled = changes.isMasterEnabled.newValue;
            syncMasterToggle();
        }
        if (changes.customAudios) {
            const oldAudios = configCache.customAudios;
            for (const key in oldAudios) {
                const oldData = oldAudios[key].data;
                if (typeof oldData === 'string' && oldData.startsWith('blob:')) {
                    URL.revokeObjectURL(oldData);
                }
            }
            configCache.customAudios = changes.customAudios.newValue || {};
            await convertBase64ToBlobUrl(configCache.customAudios);
            needsPreload = true;
        }

        // 🌟 配置有任何变动，立刻重新刷新预热池
        if (needsPreload) {
            initPreloadCache();
        }
    }
});

let lastPlayTime = {};
let globalLastPlayTime = 0;

function processTwitterMessage(e) {
    if (Object.keys(lastPlayTime).length > 1000) lastPlayTime = {};
    if (!e.detail || !Array.isArray(e.detail.triggers)) return;

    const now = Date.now();
    let vipAudioSrc = null;
    let vipFallbackDefault = false;
    let nobodyWantsDefault = false;
    let isVipPresent = false;
    let matchedVipName = "无";

    e.detail.triggers.forEach(trigger => {
        if (!trigger || typeof trigger.id !== 'string') return;

        const twitterId = trigger.id.trim().toLowerCase();
        const rawActionType = trigger.tw;

        const knownTypes = ['tweet', 'repost', 'reply', 'quote'];
        const actionType = knownTypes.includes(rawActionType) ? rawActionType : 'other';

        if (configCache.eventFilters && configCache.eventFilters[actionType] === false) return;

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

    // 🌟 核心提速：从内存池中快速克隆，跳过繁重的解码和网络IO过程
    const playConcurrentAudio = (src) => {
        let player;
        if (preloadedAudios.has(src)) {
            // cloneNode(true) 能以微秒级速度直接拷贝已解码的音频节点结构
            player = preloadedAudios.get(src).cloneNode(true);
        } else {
            // 如果缓存未命中，安全兜底降级到传统模式
            player = new Audio(src);
        }
        player.volume = configCache.globalVolume;
        player.play().catch(err => {
            if (err.name !== 'NotAllowedError') console.warn("[GMGN 盯盘伴侣] Playback Error:", err);
        });
    };

    try {
        if (vipAudioSrc) {
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO');
            playConcurrentAudio(vipAudioSrc);
        } else if (vipFallbackDefault) {
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO');
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio));
        } else if (nobodyWantsDefault && !isVipPresent) {
            if (now - globalLastPlayTime > 2000) {
                globalLastPlayTime = now;
                audioSyncChannel.postMessage('PLAYING_AUDIO');
                playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio));
            }
        }
    } catch (error) {
        console.error("[GMGN 盯盘伴侣] 播放异常捕获:", error);
    }
}

window.addEventListener('TWITTER_WS_MSG_RECEIVED', function (e) {
    if (!configCache.isMasterEnabled || isLockedByOtherTab) return;
    if (!isCacheReady) {
        pendingWsMessages.push(e);
        return;
    }
    processTwitterMessage(e);
});
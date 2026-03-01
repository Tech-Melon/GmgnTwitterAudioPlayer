const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js') + '?v=' + Date.now();
script.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(script);

let configCache = {
    mappings: {}, customAudios: {}, defaultAudio: "sounds/default.MP3", isMasterEnabled: true, globalVolume: 1.0,
    eventFilters: { tweet: true, repost: true, reply: true, quote: true, other: true } // 🌟 加入 other
};

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

    // 🌟 读取时加入 eventFilters
    if (result.eventFilters) configCache.eventFilters = result.eventFilters;
    if (configCache.eventFilters.other === undefined) configCache.eventFilters.other = true; // 老数据兼容

    if (result.customAudios) {
        configCache.customAudios = result.customAudios;
        await convertBase64ToBlobUrl(configCache.customAudios);
    }

    syncMasterToggle();
    isCacheReady = true;

    if (pendingWsMessages.length > 0) {
        pendingWsMessages.forEach(processTwitterMessage);
        pendingWsMessages = [];
    }
});

chrome.storage.onChanged.addListener(async (changes, namespace) => {
    if (namespace === 'local') {
        if (changes.twitterAudioMappings) configCache.mappings = changes.twitterAudioMappings.newValue || {};
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
        }
    }
});

let lastPlayTime = {};
let globalLastPlayTime = 0;

function processTwitterMessage(e) {
    if (Object.keys(lastPlayTime).length > 1000) lastPlayTime = {};

    // 🌟 彻底修复接收格式，必须是 triggers 数组
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

        // 🌟 方案 B 的灵魂兜底逻辑：不是四大类的，全是 other
        const knownTypes = ['tweet', 'repost', 'reply', 'quote'];
        const actionType = knownTypes.includes(rawActionType) ? rawActionType : 'other';

        if (configCache.eventFilters && configCache.eventFilters[actionType] === false) {
            console.log(`[GMGN 盯盘伴侣] 🛑 已拦截过滤事件: ${rawActionType} -> @${twitterId}`);
            return;
        }

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

    const playConcurrentAudio = (src) => {
        const player = new Audio(src);
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
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(script);

let configCache = {
    mappings: {},
    customAudios: {},
    defaultAudio: "sounds/default.MP3",
    isMasterEnabled: true,
    globalVolume: 1.0
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
                console.error("[GmgnAudioPlayer] Blob 转换失败:", e);
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

window.addEventListener('TWITTER_WS_MSG_RECEIVED', function (e) {
    if (!configCache.isMasterEnabled) return;

    if (Object.keys(lastPlayTime).length > 1000) {
        lastPlayTime = {};
    }

    // 🌟 需求 5：收到原始推送时，强制转小写，配合存储的规则
    const twitterId = e.detail.twitterId.toLowerCase();
    const now = Date.now();

    if (lastPlayTime[twitterId] && (now - lastPlayTime[twitterId] < 2500)) {
        return;
    }
    lastPlayTime[twitterId] = now;

    let audioSrc = null;

    try {
        const rule = configCache.mappings[twitterId];
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;

        if (mappedAudioId) {
            if (configCache.customAudios[mappedAudioId]) {
                const customObj = configCache.customAudios[mappedAudioId];
                audioSrc = typeof customObj === 'string' ? customObj : customObj.data;
            } else if (mappedAudioId.startsWith('custom_')) {
                audioSrc = chrome.runtime.getURL(configCache.defaultAudio);
            } else {
                audioSrc = chrome.runtime.getURL(`sounds/${mappedAudioId}`);
            }
        } else {
            audioSrc = chrome.runtime.getURL(configCache.defaultAudio);
        }

        if (audioSrc) {
            const audio = new Audio(audioSrc);
            audio.volume = configCache.globalVolume;
            audio.play().catch(error => {
                if (error.name === 'NotAllowedError') {
                    console.warn("[GmgnAudioPlayer] 浏览器阻止自动播放，请先在页面上点击交互。");
                }
            });
        }
    } catch (error) {
        console.error("[GmgnAudioPlayer] 播放异常:", error);
    }
});
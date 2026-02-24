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

// 🌟 新增：将 Base64 转换为极低消耗的 Blob URL
async function convertBase64ToBlobUrl(customAudiosObj) {
    for (const key in customAudiosObj) {
        const audioItem = customAudiosObj[key];
        // 如果已经是 blob，或者不是 data: URI，跳过
        if (typeof audioItem.data === 'string' && audioItem.data.startsWith('data:')) {
            try {
                // 利用现代 fetch API 极其高效地转换 data URI
                const res = await fetch(audioItem.data);
                const blob = await res.blob();
                // 替换原来的冗长字符串为一条简短的内部指针 url (如 blob:chrome-extension://...)
                audioItem.data = URL.createObjectURL(blob);
            } catch (e) {
                console.error("[GmgnAudioPlayer] Blob 转换失败:", e);
            }
        }
    }
}

// 🌟 修复：在回调函数 (result) 前面加上 async
chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'globalVolume'], async (result) => {
    if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
    if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
    if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
    if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;

    // 清理了冗余代码，并等待 Blob 转换完成
    if (result.customAudios) {
        configCache.customAudios = result.customAudios;
        await convertBase64ToBlobUrl(configCache.customAudios); // 转换
    }
    syncMasterToggle();
});

// 🌟 修复：在回调函数 (changes, namespace) 前面加上 async
chrome.storage.onChanged.addListener(async (changes, namespace) => {
    if (namespace === 'local') {
        if (changes.twitterAudioMappings) configCache.mappings = changes.twitterAudioMappings.newValue || {};
        if (changes.globalVolume) configCache.globalVolume = changes.globalVolume.newValue;
        if (changes.isMasterEnabled) {
            configCache.isMasterEnabled = changes.isMasterEnabled.newValue;
            syncMasterToggle();
        }

        // 清理了冗余代码，并等待 Blob 转换完成
        if (changes.customAudios) {
            configCache.customAudios = changes.customAudios.newValue || {};
            await convertBase64ToBlobUrl(configCache.customAudios); // 转换
        }
    }
});

let lastPlayTime = {};

window.addEventListener('TWITTER_WS_MSG_RECEIVED', function (e) {
    if (!configCache.isMasterEnabled) return;

    // 🌟 定期清理内存泄漏：如果记录的 key 超过 1000 个，直接重置清空
    if (Object.keys(lastPlayTime).length > 1000) {
        lastPlayTime = {};
    }

    const twitterId = e.detail.twitterId;
    const now = Date.now();

    if (lastPlayTime[twitterId] && (now - lastPlayTime[twitterId] < 2500)) {
        return;
    }
    lastPlayTime[twitterId] = now;

    let audioSrc = null;

    try {
        const rule = configCache.mappings[twitterId];
        // 兼容新老规则结构
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;

        if (mappedAudioId) {
            // 🌟 需求 3 & 4：不读磁盘，直接在内存变量 `configCache.customAudios` 列表中查找
            if (configCache.customAudios[mappedAudioId]) {
                const customObj = configCache.customAudios[mappedAudioId];
                audioSrc = typeof customObj === 'string' ? customObj : customObj.data;
            } else if (mappedAudioId.startsWith('custom_')) {
                // 🌟 需求 2：映射了自定义文件，但在内存列表里没找到，回退到默认
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
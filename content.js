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

// 🌟 修复 1：初始化状态屏障，防止配置未加载时 WebSocket 提前触发
let isCacheReady = false;

// 🌟 修复 2：引入“双播放器”单例模式 (Singleton)
// ==========================================
// 🌟 核心利器：音频播放队列 (FIFO)
// 保证音频按顺序播放，既不重叠，也不截断丢失
// ==========================================
class AudioQueue {
    constructor() {
        this.queue = [];
        this.isPlaying = false;
        this.player = new Audio();

        // 当一个音频播放结束时，自动触发下一个
        this.player.onended = () => {
            this.isPlaying = false;
            this.playNext();
        };

        // 异常处理：类似 Python 中捕获特定异常，避免裸奔
        this.player.onerror = (e) => {
            console.warn("[GmgnAudioPlayer] 音频播放失败，跳过该条:", e);
            this.isPlaying = false;
            this.playNext(); // 容错：坏掉的音频不阻塞队列
        };
    }

    // 暴露给外部的添加方法
    enqueue(src, volume) {
        this.queue.push({ src, volume });
        // 如果当前是空闲状态，立刻启动消费循环
        if (!this.isPlaying) {
            this.playNext();
        }
    }

    playNext() {
        if (this.queue.length === 0) return; // 队列消费完毕

        this.isPlaying = true;
        const nextAudio = this.queue.shift(); // FIFO: 取出最前面的任务

        this.player.src = nextAudio.src;
        this.player.volume = nextAudio.volume;

        this.player.play().catch(err => {
            // 捕获浏览器自动播放限制等异常
            if (err.name !== 'NotAllowedError') {
                console.warn("[GmgnAudioPlayer] Playback Error:", err);
            }
            this.isPlaying = false;
            this.playNext();
        });
    }

    // 提供清空队列的能力（可选）
    clear() {
        this.queue = [];
        this.player.pause();
        this.isPlaying = false;
    }
}

// 实例化两个独立的队列
// 这样大 V 和路人的音频甚至可以做到互不干扰，或者你可以只用一个全局队列
const vipAudioQueue = new AudioQueue();
const defaultAudioQueue = new AudioQueue();

// 🌟 修复 3：跨标签页广播锁 (BroadcastChannel)
// 防止多个 GMGN 网页同时接收到 WebSocket 导致多次发声
const audioSyncChannel = new BroadcastChannel('gmgn_audio_sync_channel');
let isLockedByOtherTab = false;

audioSyncChannel.onmessage = (event) => {
    if (event.data === 'PLAYING_AUDIO') {
        isLockedByOtherTab = true;
        // 锁定 2 秒，期间本标签页保持静默，交给那个抢到锁的标签页发声
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
                console.error("[GmgnAudioPlayer] Blob 转换失败:", e);
            }
        }
    }
}

// 初始化加载缓存
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
    isCacheReady = true; // 缓存加载完毕，释放屏障
});

// 监听配置变更
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

window.addEventListener('TWITTER_WS_MSG_RECEIVED', function (e) {
    // 拦截器：主开关关闭、缓存未就绪、或已被其他标签页抢占播放权，则直接丢弃
    if (!configCache.isMasterEnabled || !isCacheReady || isLockedByOtherTab) return;

    if (Object.keys(lastPlayTime).length > 1000) {
        lastPlayTime = {};
    }

    if (!e.detail || !Array.isArray(e.detail.twitterIds)) return;

    const now = Date.now();
    let vipAudioSrc = null;          // 只保留优先级最高的一个 VIP 音频
    let vipFallbackDefault = false;
    let nobodyWantsDefault = false;
    let isVipPresent = false;

    e.detail.twitterIds.forEach(rawId => {
        if (typeof rawId !== 'string') return;
        const twitterId = rawId.trim().toLowerCase();

        const rule = configCache.mappings[twitterId];
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;

        if (mappedAudioId) {
            isVipPresent = true; // 只要名单里有大 V，不管是否防抖，先标记大V在场

            if (lastPlayTime[twitterId] && (now - lastPlayTime[twitterId] < 2500)) return;
            lastPlayTime[twitterId] = now;

            // 获取音频源
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

    try {
        if (vipAudioSrc) {
            // 🏆 优先级 1：大V专属音压入 VIP 队列
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO'); // 通知其他标签页闭嘴

            // 将音频和音量压入队列，由队列自动接管播放
            vipAudioQueue.enqueue(vipAudioSrc, configCache.globalVolume);

        } else if (vipFallbackDefault) {
            // 🏆 优先级 2：大V音频丢失，强降级播默认音，压入默认队列
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO');

            defaultAudioQueue.enqueue(chrome.runtime.getURL(configCache.defaultAudio), configCache.globalVolume);

        } else if (nobodyWantsDefault && !isVipPresent) {
            // 🛑 优先级 3：纯路人局，防抖后压入默认队列
            if (now - globalLastPlayTime > 2000) {
                globalLastPlayTime = now;
                audioSyncChannel.postMessage('PLAYING_AUDIO');

                defaultAudioQueue.enqueue(chrome.runtime.getURL(configCache.defaultAudio), configCache.globalVolume);
            }
        }
    } catch (error) {
        console.error("[GmgnAudioPlayer] 播放异常捕获:", error);
    }
});
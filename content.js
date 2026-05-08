const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js') + '?v=' + Date.now();
script.dataset.extVersion = chrome.runtime.getManifest().version;
script.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(script);

let configCache = {
    mappings: {}, customAudios: {}, defaultAudio: "sounds/default.MP3", isMasterEnabled: true, globalVolume: 1.0,
    eventFilters: { tweet: true, repost: true, reply: true, quote: true, other: true },
    playDefaultUnmapped: true, // 🌟 新增开关缓存，默认开启
    enableTTS: true, // 🌟 新增：语音播报博主名字开关，默认开启
    ttsVoice: "zh-CN-XiaoxiaoNeural",
    ttsRate: "+0%",
    ttsPitch: "+0%"
};

// 🌟 新增：配置你的 Cloudflare Worker TTS API 节点
// 部署教程参考：https://github.com/DIYgod/cloudflare-edge-tts
const CF_TTS_API = "https://cloudflare-edge-tts.tech-melon.workers.dev";

// 🌟 极速双缓存引擎：IndexedDB 本地持久化
const idb = {
    db: null,
    async init() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('GMGNTTSCache', 1);
            req.onupgradeneeded = (e) => e.target.result.createObjectStore('audio', { keyPath: 'text' });
            req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
            req.onerror = () => reject(req.error);
        });
    },
    async get(text) {
        await this.init();
        return new Promise((resolve, reject) => {
            const req = this.db.transaction('audio', 'readonly').objectStore('audio').get(text);
            req.onsuccess = () => resolve(req.result ? req.result.blob : null);
            req.onerror = () => reject(req.error);
        });
    },
    async set(text, blob) {
        await this.init();
        return new Promise((resolve, reject) => {
            const req = this.db.transaction('audio', 'readwrite').objectStore('audio').put({ text, blob, ts: Date.now() });
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
};

// 🌟 新增核心：极速内存预热引擎
let preloadedAudios = new Map();
let isRebuildingBlob = false; // 🌟 新增：全局 Blob 重建锁

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

// 🌟 优化：保持严谨的异常处理边界
function checkAudioHealth(audio) {
    if (!audio) return false;

    try {
        return audio.readyState >= 2 && audio.networkState !== 3;
    } catch (error) {
        // 仅捕获预期的 DOM 异常或类型异常
        if (error instanceof TypeError || error instanceof DOMException) {
            console.warn("⚠️ [GMGN 盯盘伴侣] 音频节点状态异常 (预期内):", error.name);
            return false;
        }
        // 未知系统级异常，绝不生吞，直接抛出
        throw error;
    }
}

// 🌟 将所有可能播放的音频提前灌入内存池
function initPreloadCache() {
    // 🌟 核心修复 1：彻底销毁旧的 Audio 实例，防止内存泄漏和解码器堆积
    preloadedAudios.forEach((audio) => {
        try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load(); // 强制浏览器切断底层音频流的占用
        } catch (e) {
            console.warn("⚠️ [GMGN 盯盘伴侣] 清理旧音频实例时出错:", e);
        }
    });
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
let audioSyncChannel = new BroadcastChannel('gmgn_audio_sync_channel');
let isLockedByOtherTab = false;

audioSyncChannel.onmessage = (event) => {
    if (event.data === 'PLAYING_AUDIO') {
        isLockedByOtherTab = true;
        setTimeout(() => { isLockedByOtherTab = false; }, 2000);
    }
};

// 🌟 优化：仅在真正的休眠恢复时重新初始化（避免标签页切换时的性能浪费）
let lastVisibilityState = document.visibilityState;
let lastVisibilityChangeTime = Date.now();

document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    const hiddenDuration = now - lastVisibilityChangeTime;

    // 只有当页面隐藏超过 5 分钟（300000ms）才认为可能是休眠，否则只是普通的标签切换
    if (lastVisibilityState === 'hidden' && document.visibilityState === 'visible' && hiddenDuration > 300000) {
        console.log("🔄 [GMGN 盯盘伴侣] 检测到长时间休眠恢复，正在重新初始化音频系统...");

        // 重新创建 BroadcastChannel（可能已断开）
        try {
            audioSyncChannel.close();
        } catch (e) { }
        audioSyncChannel = new BroadcastChannel('gmgn_audio_sync_channel');
        audioSyncChannel.onmessage = (event) => {
            if (event.data === 'PLAYING_AUDIO') {
                isLockedByOtherTab = true;
                setTimeout(() => { isLockedByOtherTab = false; }, 2000);
            }
        };

        // 重新加载配置并预热音频
        chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'globalVolume', 'eventFilters', 'playDefaultUnmapped', 'enableTTS', 'ttsVoice', 'ttsRate', 'ttsPitch'], async (result) => {
            if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
            if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
            if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
            if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;
            if (result.eventFilters) configCache.eventFilters = result.eventFilters;
            if (result.playDefaultUnmapped !== undefined) configCache.playDefaultUnmapped = result.playDefaultUnmapped;
            if (result.enableTTS !== undefined) configCache.enableTTS = result.enableTTS;
            if (result.ttsVoice) configCache.ttsVoice = result.ttsVoice;
            if (result.ttsRate) configCache.ttsRate = result.ttsRate;
            if (result.ttsPitch) configCache.ttsPitch = result.ttsPitch;

            if (result.customAudios) {
                // 🔥 关键修复：回收旧的 Blob URL，防止内存泄漏
                for (const key in configCache.customAudios) {
                    const oldData = configCache.customAudios[key].data;
                    if (typeof oldData === 'string' && oldData.startsWith('blob:')) {
                        URL.revokeObjectURL(oldData);
                    }
                }

                configCache.customAudios = result.customAudios;
                await convertBase64ToBlobUrl(configCache.customAudios);
            }

            initPreloadCache();
            syncMasterToggle();
            console.log("✅ [GMGN 盯盘伴侣] 音频系统恢复完成:", {
                mappingCount: Object.keys(configCache.mappings).length,
                customAudioCount: Object.keys(configCache.customAudios).length
            });
        });
    }

    lastVisibilityState = document.visibilityState;
    lastVisibilityChangeTime = now;
});

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

chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'globalVolume', 'eventFilters', 'playDefaultUnmapped', 'enableTTS', 'ttsVoice', 'ttsRate', 'ttsPitch'], async (result) => { // 🌟 数组加了高级定制选项
    if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
    if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
    if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
    if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;

    if (result.eventFilters) configCache.eventFilters = result.eventFilters;
    if (configCache.eventFilters.other === undefined) configCache.eventFilters.other = true;

    // 🌟 赋值缓存
    if (result.playDefaultUnmapped !== undefined) configCache.playDefaultUnmapped = result.playDefaultUnmapped;
    if (result.enableTTS !== undefined) configCache.enableTTS = result.enableTTS;
    if (result.ttsVoice) configCache.ttsVoice = result.ttsVoice;
    if (result.ttsRate) configCache.ttsRate = result.ttsRate;
    if (result.ttsPitch) configCache.ttsPitch = result.ttsPitch;

    if (result.customAudios) {
        configCache.customAudios = result.customAudios;
        await convertBase64ToBlobUrl(configCache.customAudios);
    }

    // 🌟 在数据加载完毕后，立刻执行预热
    initPreloadCache();
    // warmupTTSVoice(); 已废弃，现采用双层缓存网络 TTS

    syncMasterToggle();
    isCacheReady = true;

    console.log("⚙️ [GMGN 盯盘伴侣] 配置加载完成:", {
        mappingCount: Object.keys(configCache.mappings).length,
        customAudioCount: Object.keys(configCache.customAudios).length,
        isMasterEnabled: configCache.isMasterEnabled,
        playDefaultUnmapped: configCache.playDefaultUnmapped
    });

    if (pendingWsMessages.length > 0) {
        pendingWsMessages.forEach(processTwitterMessage);
        pendingWsMessages = [];
    }
});

chrome.storage.onChanged.addListener(async (changes, namespace) => {
    // 增加防御性校验：如果上下文已丢失，直接阻断后续的异步逻辑
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
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
        // 🌟 监听开关变动更新缓存
        if (changes.playDefaultUnmapped) {
            configCache.playDefaultUnmapped = changes.playDefaultUnmapped.newValue;
        }
        if (changes.enableTTS) {
            configCache.enableTTS = changes.enableTTS.newValue;
        }
        if (changes.ttsVoice) configCache.ttsVoice = changes.ttsVoice.newValue;
        if (changes.ttsRate) configCache.ttsRate = changes.ttsRate.newValue;
        if (changes.ttsPitch) configCache.ttsPitch = changes.ttsPitch.newValue;
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

// 🌟 优化：使用 Map 结构，利用其维持插入顺序的特性进行优雅的 LRU 淘汰
let lastPlayTime = new Map();
let globalLastPlayTime = 0;

// 🎤 云端 TTS 极速播放引擎 (双层缓存架构)
async function playNetworkTTS(text) {
    if (!text || typeof text !== 'string') return;

    try {
        // 生成包含所有配置参数的独立缓存 Key，防止切换音色后播放旧缓存
        const cacheKey = `${text}_${configCache.ttsVoice}_${configCache.ttsRate}_${configCache.ttsPitch}`;
        
        // 1. 本地极速缓存拦截 (0毫秒开销)
        let blob = await idb.get(cacheKey);

        if (blob) {
            console.log("⚡ [GMGN 盯盘伴侣 - TTS] 命中本地 IndexedDB，极速播放:", text);
            playBlobAudio(blob);
            return;
        }

        // 2. 边缘节点网络请求 (首次生成)
        console.log("☁️ [GMGN 盯盘伴侣 - TTS] 向边缘节点请求新音频:", text);
        // 注意：这里适配 DIYgod/cloudflare-edge-tts 接口协议 (POST /tts)
        const url = `${CF_TTS_API}/tts`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                voice: configCache.ttsVoice,
                rate: configCache.ttsRate,
                pitch: configCache.ttsPitch
            })
        });
        
        if (!res.ok) throw new Error(`CF Worker 返回错误: ${res.status}`);

        blob = await res.blob();

        // 3. 存入本地永久缓存 (下次 0 延迟)
        await idb.set(cacheKey, blob);
        playBlobAudio(blob);

    } catch (error) {
        console.error("❌ [GMGN 盯盘伴侣 - TTS] 网络/缓存播放异常，降级到浏览器原生TTS:", error);
        fallbackNativeTTS(text);
    }
}

function playBlobAudio(blob) {
    const url = URL.createObjectURL(blob);
    const player = new Audio(url);
    // TTS 语音稍微放大一点，防止被提示音完全盖住
    player.volume = Math.min(configCache.globalVolume * 1.5, 1.0);

    player.addEventListener('ended', () => {
        URL.revokeObjectURL(url); // 阅后即焚，释放内存
        player.removeAttribute('src');
        player.load();
    });

    player.play().catch(e => {
        console.error("❌ [GMGN 盯盘伴侣 - TTS] Blob音频播放失败，启用默认铃声兜底", e);
        // 🚀 核心逻辑修改：如果连下载好的音频都无法播放，只能使用默认铃声兜底了
        if (typeof playConcurrentAudio === 'function') {
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio));
        }
    });
}

// 兜底方案：如果没配 Worker 或者断网了，回退到以前的原生 TTS
function fallbackNativeTTS(text) {
    const playFinalFallback = () => {
        console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] 终极降级：播放默认提示音");
        if (typeof playConcurrentAudio === 'function') {
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio));
        }
    };

    if (!('speechSynthesis' in window)) {
        return playFinalFallback();
    }
    
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.0;
    utterance.pitch = 1.05;
    utterance.volume = Math.min(configCache.globalVolume * 1.5, 1.0);
    
    // 🚀 如果连浏览器原生 TTS 都报错失败，则祭出最后一张底牌：默认提示音
    utterance.onerror = (e) => {
        console.error("❌ [GMGN 盯盘伴侣 - TTS] 原生 TTS 发生错误:", e);
        playFinalFallback();
    };

    window.speechSynthesis.speak(utterance);
}

function processTwitterMessage(e) {
    // 平滑清理：当容量超过 1000 时，只清理最老的 100 条，而不是全部清空
    if (lastPlayTime.size > 1000) {
        let i = 0;
        for (const key of lastPlayTime.keys()) {
            lastPlayTime.delete(key);
            if (++i > 100) break;
        }
    }
    if (!e.detail || !Array.isArray(e.detail.triggers)) return;

    const now = Date.now();
    let vipAudioSrc = null;
    let vipFallbackDefault = false;
    let nobodyWantsDefault = false;
    let isVipPresent = false;

    // 🎤 用于存储需要 TTS 播报的信息
    let ttsInfo = null;

    e.detail.triggers.forEach(trigger => {
        if (!trigger || typeof trigger.id !== 'string') return;

        const twitterId = trigger.id.trim().toLowerCase();
        const displayName = trigger.name || twitterId; // 🎤 获取显示名称，用于 TTS 播报
        const rawActionType = trigger.tw;

        const knownTypes = ['tweet', 'repost', 'reply', 'quote'];
        const actionType = knownTypes.includes(rawActionType) ? rawActionType : 'other';

        if (configCache.eventFilters && configCache.eventFilters[actionType] === false) return;

        const rule = configCache.mappings[twitterId];
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;

        if (mappedAudioId) {
            isVipPresent = true;
            // 🌟 修正：严格使用 Map API 读取和写入，确保 size 计算准确
            if (lastPlayTime.has(twitterId) && (now - lastPlayTime.get(twitterId) < 2500)) return;
            lastPlayTime.set(twitterId, now);

            console.log("✅ [GMGN 盯盘伴侣] 规则匹配:", {
                twitterId,
                audioId: mappedAudioId,
                hasRemark: !!(typeof rule === 'object' && rule.remark)
            });

            if (configCache.customAudios[mappedAudioId]) {
                // 🎤 自定义音频：直接播放，不加 TTS
                const customObj = configCache.customAudios[mappedAudioId];
                vipAudioSrc = typeof customObj === 'string' ? customObj : customObj.data;
                ttsInfo = null; // 自定义音频不需要 TTS
            } else if (mappedAudioId.startsWith('custom_')) {
                vipFallbackDefault = true;
                console.log("⚠️ [GMGN 盯盘伴侣] 自定义音频丢失，降级为默认音频");
            } else {
                // 🎤 内置音频：区分通用提示音和人物专属音
                vipAudioSrc = chrome.runtime.getURL(`sounds/${mappedAudioId}`);

                // 只有通用提示音才需要 TTS，人物专属音频不需要
                const genericSounds = ['default.MP3', 'preset1.MP3'];
                if (configCache.enableTTS && genericSounds.includes(mappedAudioId)) {
                    // 提取播报名称：优先使用 remark，其次用显示名称，最后降级到 ID
                    let speakerName = displayName;
                    if (typeof rule === 'object' && rule !== null && rule.remark) {
                        speakerName = rule.remark;
                    }

                    ttsInfo = `${speakerName} 发推啦`;
                    // 🚀 如果开启了 TTS，则完全抛弃原有的兜底铃声，只保留 TTS
                    vipAudioSrc = null; 
                }
            }
        } else {
            // 🌟 修正：严格使用 Map API 读取和写入
            if (lastPlayTime.has(twitterId) && (now - lastPlayTime.get(twitterId) < 2500)) return;
            lastPlayTime.set(twitterId, now);
            nobodyWantsDefault = true;
        }
    });

    // 🌟 核心提速：从内存池中快速克隆，跳过繁重的解码和网络IO过程
    // 🎤 新增参数：ttsText - 如果提供，则在音频播放结束后进行语音播报
    const playConcurrentAudio = (src, ttsText = null) => {
        let player;
        const cachedAudio = preloadedAudios.get(src);

        // 检查缓存的音频是否健康
        if (cachedAudio && checkAudioHealth(cachedAudio)) {
            // cloneNode(true) 能以微秒级速度直接拷贝已解码的音频节点结构
            player = cachedAudio.cloneNode(true);
        } else {
            // 🔥 关键修复：如果是 Blob URL 失效，需要重新生成 Blob
            if (cachedAudio) {
                console.warn("⚠️ [GMGN 盯盘伴侣] 音频缓存已失效，正在重新加载:", src);
                preloadedAudios.delete(src);

                // 如果是 Blob URL 失效，尝试从 customAudios 重新生成
                if (src.startsWith('blob:')) {
                    const customKey = Object.keys(configCache.customAudios).find(
                        key => configCache.customAudios[key].data === src
                    );
                    if (customKey) {
                        console.warn("🔄 [GMGN 盯盘伴侣] Blob URL 失效，触发重建:", {
                            customKey,
                            oldSrc: src.substring(0, 50) + '...'
                        });

                        // 立即降级播放默认音兜底
                        const fallbackSrc = chrome.runtime.getURL(configCache.defaultAudio);
                        if (src !== fallbackSrc) {
                            player = new Audio(fallbackSrc);
                        }

                        // 🌟 核心修复：加入重建锁，阻断并发重入风暴
                        if (!isRebuildingBlob) {
                            isRebuildingBlob = true;
                            console.log("🔒 [GMGN 盯盘伴侣] 发起单例 Blob 重建任务...");

                            chrome.storage.local.get(['customAudios'], async (result) => {
                                if (result.customAudios) {
                                    for (const key in configCache.customAudios) {
                                        const oldData = configCache.customAudios[key].data;
                                        if (typeof oldData === 'string' && oldData.startsWith('blob:')) {
                                            URL.revokeObjectURL(oldData);
                                        }
                                    }
                                    configCache.customAudios = result.customAudios;
                                    await convertBase64ToBlobUrl(configCache.customAudios);
                                    initPreloadCache();
                                    isRebuildingBlob = false; // 解锁
                                    console.log("🔓 [GMGN 盯盘伴侣] Blob 重建任务完成！");
                                } else {
                                    isRebuildingBlob = false;
                                }
                            });
                        }
                    }
                }
            }

            // 🚨 核心修复：只有在 player 没有被兜底逻辑接管时，才创建新的 Audio
            if (!player) {
                player = new Audio(src);
                // 缓存未命中或失效时，尝试重新预热
                warmupAudio(src);
            }
        }

        // 统一设置音量，因为上面的分支都没有设置
        player.volume = configCache.globalVolume;

        // 🌟 核心修复 2：用完即焚！监听播放结束事件，彻底释放克隆节点
        const cleanup = () => {
            if (!player) return;
            player.pause();
            player.removeAttribute('src');
            player.load(); // 释放解码器
            player.removeEventListener('ended', cleanup);
            player.removeEventListener('error', cleanup);
            player = null; // 切断 JS 引用，立刻交由 GC 回收
        };

        // 🚀 彻底打破串行！并发执行 TTS，毫不等待提示音结束
        if (ttsText) {
            playNetworkTTS(ttsText);
        }
        player.addEventListener('ended', cleanup);

        player.addEventListener('error', cleanup);

        player.play().catch(err => {
            if (err.name !== 'NotAllowedError') {
                console.error("❌ [GMGN 盯盘伴侣] 播放失败:", {
                    error: err.name,
                    message: err.message,
                    src: src.substring(0, 50) + '...'
                });
            }
            cleanup(); // 如果播放被拦截或失败，也立刻执行销毁
        });
    };

    try {
        if (vipAudioSrc) {
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO');
            playConcurrentAudio(vipAudioSrc, ttsInfo); // 🎤 传入 TTS 文本
        } else if (ttsInfo) {
            // 🚀 新增分支：只有纯 TTS，没有任何前置铃声
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO');
            playNetworkTTS(ttsInfo);
        } else if (vipFallbackDefault) {
            // 降级情况：文件丢失被迫使用默认音 (不受新开关影响，照常播放)
            globalLastPlayTime = now;
            audioSyncChannel.postMessage('PLAYING_AUDIO');
            console.log("🎵 [GMGN 盯盘伴侣] 降级播放默认音频");
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio));
        } else if (nobodyWantsDefault && !isVipPresent) {
            // 🌟 新增判断：只有当允许播放未映射音频，且距离上次播放大于2秒时，才播放
            if (configCache.playDefaultUnmapped && (now - globalLastPlayTime > 2000)) {
                globalLastPlayTime = now;
                audioSyncChannel.postMessage('PLAYING_AUDIO');

                // 🎤 检查是否开启了 TTS，提取触发者名称
                let unmappedTTS = null;
                if (configCache.enableTTS) {
                    const firstTrigger = e.detail.triggers.find(t => t && typeof t.id === 'string');
                    if (firstTrigger) {
                        const speakerName = firstTrigger.name || firstTrigger.id.trim();
                        unmappedTTS = `${speakerName} 发推啦`;
                    }
                }

                // 🚀 核心逻辑修改：如果启用了 TTS 并成功生成了播报文本，则【只播放 TTS 人声】，彻底抛弃 default.MP3
                if (unmappedTTS) {
                    playNetworkTTS(unmappedTTS);
                } else {
                    // 如果关闭了 TTS 开关，则降级为只播放默认的“推特新消息” MP3
                    playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio));
                }
            }
        }
    } catch (error) {
        // 🔥 优化：精准的异常处理，不掩盖真实错误
        if (error instanceof Error) {
            // 上下文失效异常，向上抛出
            if (error.message.includes('Extension context invalidated')) {
                throw error;
            }
            // 其他错误，详细记录
            console.error("[GMGN 盯盘伴侣] 播放异常:", {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
        } else {
            console.error("[GMGN 盯盘伴侣] 未知播放异常:", error);
        }
    }
}

function handleTwitterMsg(e) {
    // 1. 前置拦截：精准判断扩展上下文是否已丢失
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        console.warn("👻 [GMGN 盯盘伴侣] 扩展已更新，旧上下文失效，正在清理遗留监听器。");
        window.removeEventListener('TWITTER_WS_MSG_RECEIVED', handleTwitterMsg);
        if (typeof audioSyncChannel !== 'undefined') audioSyncChannel.close(); // 🔪 彻底切断通信频道
        return;
    }

    if (!configCache.isMasterEnabled || isLockedByOtherTab) return;
    if (!isCacheReady) {
        pendingWsMessages.push(e);
        return;
    }

    try {
        processTwitterMessage(e);
    } catch (error) {
        // 2. 精准异常捕获：只拦截上下文失效引发的错误，不掩盖其他真实 Bug
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
            window.removeEventListener('TWITTER_WS_MSG_RECEIVED', handleTwitterMsg);
            if (typeof audioSyncChannel !== 'undefined') audioSyncChannel.close();
        } else {
            console.error("[GMGN 盯盘伴侣] 播放异常捕获:", error);
        }
    }
}

window.addEventListener('TWITTER_WS_MSG_RECEIVED', handleTwitterMsg);
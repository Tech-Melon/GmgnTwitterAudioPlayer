const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js') + '?v=' + Date.now();
script.dataset.extVersion = chrome.runtime.getManifest().version;
script.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(script);

let configCache = {
    mappings: {}, customAudios: {}, defaultAudio: "sounds/default.MP3", isMasterEnabled: true, globalVolume: 1.0,
    eventFilters: { tweet: true, repost: true, reply: true, quote: true, other: true },
    playDefaultUnmapped: true, // 🌟 新增开关缓存，默认开启
    enableTTS: true // 🌟 新增：语音播报博主名字开关，默认开启
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
        } catch (e) {}
        audioSyncChannel = new BroadcastChannel('gmgn_audio_sync_channel');
        audioSyncChannel.onmessage = (event) => {
            if (event.data === 'PLAYING_AUDIO') {
                isLockedByOtherTab = true;
                setTimeout(() => { isLockedByOtherTab = false; }, 2000);
            }
        };
        
        // 重新加载配置并预热音频
        chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'globalVolume', 'eventFilters', 'playDefaultUnmapped', 'enableTTS'], async (result) => {
            if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
            if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
            if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
            if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;
            if (result.eventFilters) configCache.eventFilters = result.eventFilters;
            if (result.playDefaultUnmapped !== undefined) configCache.playDefaultUnmapped = result.playDefaultUnmapped;
            if (result.enableTTS !== undefined) configCache.enableTTS = result.enableTTS;
            
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

chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'globalVolume', 'eventFilters', 'playDefaultUnmapped', 'enableTTS'], async (result) => { // 🌟 数组加了 'playDefaultUnmapped' 和 'enableTTS'
    if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
    if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
    if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
    if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;

    if (result.eventFilters) configCache.eventFilters = result.eventFilters;
    if (configCache.eventFilters.other === undefined) configCache.eventFilters.other = true;

    // 🌟 赋值缓存
    if (result.playDefaultUnmapped !== undefined) configCache.playDefaultUnmapped = result.playDefaultUnmapped;
    if (result.enableTTS !== undefined) configCache.enableTTS = result.enableTTS;

    if (result.customAudios) {
        configCache.customAudios = result.customAudios;
        await convertBase64ToBlobUrl(configCache.customAudios);
    }

    // 🌟 在数据加载完毕后，立刻执行预热
    initPreloadCache();
    warmupTTSVoice(); // 🎤 预热 TTS 语音引擎

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

// 🎤 TTS 语音预热与缓存机制（极致性能优化）
let cachedTTSVoice = null;
let isTTSVoiceReady = false;

// 🚀 语音引擎预热函数：在页面加载时立刻执行，消除首次延迟
function warmupTTSVoice() {
    if (!('speechSynthesis' in window)) return;
    
    // 🔥 关键优化：监听 voiceschanged 事件，确保语音列表完全加载后再缓存
    const selectBestVoice = () => {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length === 0) return; // 语音列表未就绪，等待下次触发
        
        const preferredVoices = [
            'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)',
            'Microsoft Yunyang Online (Natural) - Chinese (Mainland)',
            'Microsoft Xiaoyi Online (Natural) - Chinese (Mainland)',
            'Google 國語（臺灣）',
            'Google 普通话（中国大陆）',
            'Microsoft Huihui - Chinese (Simplified, PRC)',
            'Microsoft Yaoyao - Chinese (Simplified, PRC)',
            'Ting-Ting',
            'Sin-ji'
        ];
        
        for (const preferredName of preferredVoices) {
            const voice = voices.find(v => v.name.includes(preferredName) || v.name === preferredName);
            if (voice) {
                cachedTTSVoice = voice;
                isTTSVoiceReady = true;
                console.log("🎤 [GMGN 盯盘伴侣 - TTS] 语音预热完成:", voice.name);
                return;
            }
        }
        
        // 降级：选择任意中文语音
        const fallbackVoice = voices.find(v => v.lang.startsWith('zh'));
        if (fallbackVoice) {
            cachedTTSVoice = fallbackVoice;
            isTTSVoiceReady = true;
            console.log("🎤 [GMGN 盯盘伴侣 - TTS] 使用降级语音:", fallbackVoice.name);
        }
    };
    
    // 立即尝试获取（某些浏览器同步返回）
    selectBestVoice();
    
    // 监听异步加载完成事件（Chrome/Edge 需要）
    if (!isTTSVoiceReady) {
        window.speechSynthesis.addEventListener('voiceschanged', selectBestVoice, { once: true });
    }
}

// 🎤 TTS 语音合成函数（极速版：0 延迟启动）
function speakText(text) {
    if (!text || typeof text !== 'string') {
        console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] 播报文本无效:", text);
        return;
    }
    
    if (!('speechSynthesis' in window)) {
        console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] 当前浏览器不支持语音合成");
        return;
    }

    try {
        window.speechSynthesis.cancel(); // 🛑 清空历史积压队列
        const utterance = new SpeechSynthesisUtterance(text);
        
        utterance.lang = 'zh-CN';
        
        // 🚀 核心优化：直接使用预热缓存的语音，跳过耗时的查找过程
        if (isTTSVoiceReady && cachedTTSVoice) {
            utterance.voice = cachedTTSVoice;
        }
        
        // 🔥 优化语音参数
        utterance.rate = 1.00;
        utterance.pitch = 1.05;
        utterance.volume = Math.min(configCache.globalVolume * 1.5, 1.0);
        
        utterance.onerror = (event) => {
            console.error("❌ [GMGN 盯盘伴侣 - TTS] 播报失败:", event);
        };
        
        window.speechSynthesis.speak(utterance);
        
    } catch (error) {
        console.error("❌ [GMGN 盯盘伴侣 - TTS] 播报异常:", error);
    }
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
                    // 提取播报名称：优先使用 remark，其次用 twitterId
                    let speakerName = twitterId;
                    if (typeof rule === 'object' && rule !== null && rule.remark) {
                        speakerName = rule.remark;
                    }
                    
                    ttsInfo = `${speakerName} 发推啦`;
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

        // 🎤 如果需要 TTS 播报，在音频播放结束后触发
        if (ttsText) {
            player.addEventListener('ended', () => {
                speakText(ttsText);
                cleanup();
            });
        } else {
            player.addEventListener('ended', cleanup);
        }
        
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
                
                // 🎤 未匹配规则时，如果开启了 TTS，播报博主名字
                let unmappedTTS = null;
                if (configCache.enableTTS) {
                    // 从 triggers 中提取第一个触发者的 ID 作为播报对象
                    const firstTrigger = e.detail.triggers.find(t => t && typeof t.id === 'string');
                    if (firstTrigger) {
                        const speakerName = firstTrigger.id.trim();
                        unmappedTTS = `${speakerName} 发推啦`;
                    }
                }
                
                playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio), unmappedTTS);
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
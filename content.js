let configCache = {};
let isCacheReady = false;
let pendingWsMessages = [];
let audioSyncChannel = new BroadcastChannel('gmgn_audio_sync_channel');
let sharedAudioCtx = null; // 🌟 全局共享 AudioContext（必须在 _unlockAutoplay 之前声明）

// ════════════════════════════════════════════════════════════
// 🔒 跨 Tab 事件指纹去重引擎（替代旧版的 2 秒时间窗口粗暴锁）
// 原理：用事件内容本身（trigger IDs / txHash）作为指纹，只抑制相同事件
// BroadcastChannel 传递延迟 <1ms，天然利用多 WS 连接间的到达时差避免竞态
// ════════════════════════════════════════════════════════════
const otherTabPlayedEvents = new Map(); // fingerprint -> timestamp

/** 检查此事件是否已被其他 Tab 播放（5 秒 TTL） */
function wasPlayedByOtherTab(fingerprint) {
    const ts = otherTabPlayedEvents.get(fingerprint);
    if (!ts) return false;
    if (Date.now() - ts > 5000) {
        otherTabPlayedEvents.delete(fingerprint);
        return false;
    }
    return true;
}

/** 标记事件已播放并广播给其他 Tab */
function markEventPlayed(fingerprint) {
    audioSyncChannel.postMessage({ type: 'EVENT_PLAYED', key: fingerprint });
    // 懒清理：超过 200 条时删除最老的一半
    if (otherTabPlayedEvents.size > 200) {
        const iter = otherTabPlayedEvents.keys();
        for (let i = 0; i < 100; i++) otherTabPlayedEvents.delete(iter.next().value);
    }
}

const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js') + '?v=' + Date.now();
script.dataset.extVersion = chrome.runtime.getManifest().version;
script.onload = function () { this.remove(); };
(document.head || document.documentElement).appendChild(script);

// 🔓 Autoplay Policy 解锁器：用户首次交互时同时解锁 Audio.play() + AudioContext
const _unlockAutoplay = () => {
    // 1️⃣ 解锁 Audio.play()
    const silent = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=");
    silent.volume = 0;
    silent.play().then(() => {
        console.log("🔓 [GMGN 盯盘伴侣] Audio.play() 已解锁");
    }).catch(() => {});

    // 2️⃣ 解锁 AudioContext（GainNode 超级音量依赖此上下文）
    try {
        if (!sharedAudioCtx) {
            sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (sharedAudioCtx.state === 'suspended') {
            sharedAudioCtx.resume().then(() => {
                console.log("🔓 [GMGN 盯盘伴侣] AudioContext 已解锁, state:", sharedAudioCtx.state);
            });
        }
    } catch (e) {
        console.warn("⚠️ [GMGN 盯盘伴侣] AudioContext 解锁失败:", e);
    }

    ['click', 'keydown', 'touchstart'].forEach(evt =>
        document.removeEventListener(evt, _unlockAutoplay, true)
    );
};
['click', 'keydown', 'touchstart'].forEach(evt =>
    document.addEventListener(evt, _unlockAutoplay, { once: false, capture: true })
);
    chrome.storage.local.get(null, (result) => {
        configCache.isMasterEnabled = result.isMasterEnabled !== false;
        configCache.enableTwitter = result.enableTwitter !== false;
        configCache.enableWallet = result.enableWallet !== false;
        configCache.globalVolume = result.globalVolume !== undefined ? result.globalVolume : 1.0;
        configCache.twitterVolume = result.twitterVolume !== undefined ? result.twitterVolume : (configCache.globalVolume || 1.0);
        configCache.walletVolume = result.walletVolume !== undefined ? result.walletVolume : (configCache.globalVolume || 1.0);
        configCache.mappings = result.twitterAudioMappings || {};
        configCache.customAudios = result.customAudios || {};
        configCache.eventFilters = result.eventFilters || { tweet: true, repost: true, reply: true, quote: true, other: true };
        configCache.playDefaultUnmapped = result.playDefaultUnmapped !== false;
        configCache.enableTTS = result.enableTTS !== false;
        configCache.twitterTts = result.twitterTts || { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0%' };
        configCache.walletTts = result.walletTts || { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0%' };
        configCache.walletFilters = result.walletFilters || { buy: true, sellReduce: true, sellClear: true, minAmount: 0 };
        configCache.walletDictionary = result.walletDictionary || {};
        configCache.defaultAudio = result.defaultAudio || 'sounds/default.MP3';
    });

// 🌟 新增：配置你的 Cloudflare Worker TTS API 节点
// 部署教程参考：https://github.com/DIYgod/cloudflare-edge-tts
const CF_TTS_API = "https://cloudflare-edge-tts.tech-melon.workers.dev";

// 🌟 极速双缓存引擎：IndexedDB 本地持久化（带连接健康检查 + 超时保护）
const idb = {
    db: null,
    async init() {
        if (this.db) {
            try {
                // 健康检查：尝试发起空事务，如果底层连接已断会立刻抛异常
                this.db.transaction('audio', 'readonly');
                return this.db;
            } catch (e) {
                console.warn("⚠️ [GMGN 盯盘伴侣 - IDB] 连接已失效，重连中...");
                this.db = null;
            }
        }
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('GMGNTTSCache', 1);
            req.onupgradeneeded = (e) => e.target.result.createObjectStore('audio', { keyPath: 'text' });
            req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
            req.onerror = () => reject(req.error);
        });
    },
    async get(text) {
        try {
            await this.init();
            return await Promise.race([
                new Promise((resolve, reject) => {
                    const req = this.db.transaction('audio', 'readonly').objectStore('audio').get(text);
                    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
                    req.onerror = () => reject(req.error);
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('IDB get timeout')), 3000))
            ]);
        } catch (e) {
            console.warn("⚠️ [GMGN 盯盘伴侣 - IDB] 读取失败，跳过缓存:", e.message);
            this.db = null; // 标记连接失效，下次强制重连
            return null;    // 返回 null 让调用方走网络请求
        }
    },
    async set(text, blob) {
        try {
            await this.init();
            await Promise.race([
                new Promise((resolve, reject) => {
                    const req = this.db.transaction('audio', 'readwrite').objectStore('audio').put({ text, blob, ts: Date.now() });
                    req.onsuccess = () => resolve();
                    req.onerror = () => reject(req.error);
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('IDB set timeout')), 3000))
            ]);
        } catch (e) {
            console.warn("⚠️ [GMGN 盯盘伴侣 - IDB] 写入失败，跳过缓存:", e.message);
            this.db = null;
        }
    }
};

// 🌟 新增核心：极速内存预热引擎
let preloadedAudios = new Map();
let isRebuildingBlob = false; // 🌟 新增：全局 Blob 重建锁

const extensionBlobs = {};

async function getSafeAudioSrc(src) {
    if (!src.startsWith('chrome-extension://')) return src;
    if (extensionBlobs[src]) return extensionBlobs[src];
    try {
        const res = await fetch(src);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        extensionBlobs[src] = url;
        return url;
    } catch (e) {
        console.error("[GMGN 盯盘伴侣] 预热时转换内部音频失败:", e);
        return src;
    }
}

// sharedAudioCtx 已提升到文件顶部声明
function applyGainToAudio(audio, volume) {
    if (volume <= 1.0) {
        audio.volume = Math.max(0, volume);
        return;
    }
    audio.volume = 1.0; // 基础音量拉满

    // 🔥 防御静音 Bug：在 Content Script 中，如果不带 crossOrigin 的原生链接经过 Web Audio API 会输出静默！
    const isSafe = audio.crossOrigin === "anonymous" || 
                  (audio.src && (audio.src.startsWith('blob:') || audio.src.startsWith('data:')));
    
    if (!isSafe) {
        console.warn("[GMGN 盯盘伴侣] 跨域音频安全回退，为防静音，限制最高 100% 音量");
        return;
    }

    try {
        if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
        
        if (!audio.__sourceNode) {
            audio.__sourceNode = sharedAudioCtx.createMediaElementSource(audio);
            const gainNode = sharedAudioCtx.createGain();
            audio.__gainNode = gainNode;
            audio.__sourceNode.connect(gainNode);
            gainNode.connect(sharedAudioCtx.destination);
        }
        audio.__gainNode.gain.value = volume;
    } catch (e) {
        console.warn("[GMGN 盯盘伴侣] 超级音量(Web Audio API)增益失败，降级为 100% 音量:", e);
    }
}

async function warmupAudio(src) {
    if (!src) return;
    if (!preloadedAudios.has(src)) {
        preloadedAudios.set(src, null); // 占位，防止并发重复获取
        const safeSrc = await getSafeAudioSrc(src);
        const audio = new Audio();
        audio.crossOrigin = "anonymous"; // 允许 Web Audio API 跨域处理
        audio.preload = 'auto'; // 强制浏览器在后台拉取并立刻解码音频
        audio.src = safeSrc;
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
        if (!audio) return; // 跳过异步预热中的 null 占位符
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
    const defaultSrc = configCache.defaultAudio || 'sounds/default.MP3';
    warmupAudio(chrome.runtime.getURL(defaultSrc));

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



audioSyncChannel.onmessage = (event) => {
    const data = event.data;
    if (data && typeof data === 'object' && data.type === 'EVENT_PLAYED') {
        otherTabPlayedEvents.set(data.key, Date.now());
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
            const data = event.data;
            if (data && typeof data === 'object' && data.type === 'EVENT_PLAYED') {
                otherTabPlayedEvents.set(data.key, Date.now());
            }
        };

        // 重新加载配置并预热音频
        try {
            chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'enableTwitter', 'enableWallet', 'globalVolume', 'twitterVolume', 'walletVolume', 'eventFilters', 'playDefaultUnmapped', 'enableTTS', 'twitterTts', 'walletTts', 'walletFilters', 'walletDictionary'], async (result) => {
                if (chrome.runtime.lastError) return;
            if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
            configCache.defaultAudio = result.defaultAudio || 'sounds/default.MP3';
            if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
            if (result.enableTwitter !== undefined) configCache.enableTwitter = result.enableTwitter;
            if (result.enableWallet !== undefined) configCache.enableWallet = result.enableWallet;
            if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;
            if (result.twitterVolume !== undefined) configCache.twitterVolume = result.twitterVolume;
            if (result.walletVolume !== undefined) configCache.walletVolume = result.walletVolume;
            if (result.eventFilters) configCache.eventFilters = result.eventFilters;
            if (result.playDefaultUnmapped !== undefined) configCache.playDefaultUnmapped = result.playDefaultUnmapped;
            if (result.enableTTS !== undefined) configCache.enableTTS = result.enableTTS;
            if (result.twitterTts) configCache.twitterTts = result.twitterTts;
            if (result.walletTts) configCache.walletTts = result.walletTts;
            if (result.walletFilters) configCache.walletFilters = result.walletFilters;
            if (result.walletDictionary) configCache.walletDictionary = result.walletDictionary;

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
        } catch (e) {
            if (e.message && e.message.includes('Extension context invalidated')) {
                console.warn("🔄 [GMGN 盯盘伴侣] 插件已更新或重新加载，当前页面脚本已失效，请刷新页面以恢复监控！");
            } else {
                console.error(e);
            }
        }
    }

    lastVisibilityState = document.visibilityState;
    lastVisibilityChangeTime = now;
});

function syncMasterToggle() {
    window.dispatchEvent(new CustomEvent('GMGN_AUDIO_TOGGLE', { detail: { enabled: configCache.isMasterEnabled } }));
}

function convertBase64ToBlobUrl(customAudiosObj) {
    for (const key in customAudiosObj) {
        const audioItem = customAudiosObj[key];
        if (typeof audioItem.data === 'string' && audioItem.data.startsWith('data:')) {
            try {
                // MV3 content script 禁止 fetch data: URI，改用 atob 手动解码
                const [header, b64] = audioItem.data.split(',');
                const mime = header.match(/data:(.*?);/)?.[1] || 'audio/mpeg';
                const binary = atob(b64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const blob = new Blob([bytes], { type: mime });
                audioItem.data = URL.createObjectURL(blob);
            } catch (e) {
                console.error("[GMGN 盯盘伴侣] Blob 转换失败:", e);
            }
        }
    }
}

chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'enableTwitter', 'enableWallet', 'globalVolume', 'twitterVolume', 'walletVolume', 'eventFilters', 'playDefaultUnmapped', 'enableTTS', 'ttsVoice', 'ttsRate', 'ttsPitch', 'twitterTts', 'walletTts', 'walletFilters', 'walletDictionary'], async (result) => { // 🌟 数组加了高级定制选项+旧版字段用于迁移
    if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
    if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
    if (!configCache.defaultAudio) configCache.defaultAudio = 'sounds/default.MP3';
    if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled;
            if (result.enableTwitter !== undefined) configCache.enableTwitter = result.enableTwitter;
            if (result.enableWallet !== undefined) configCache.enableWallet = result.enableWallet;
    if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;
    if (result.twitterVolume !== undefined) configCache.twitterVolume = result.twitterVolume;
    if (result.walletVolume !== undefined) configCache.walletVolume = result.walletVolume;

    if (result.eventFilters) configCache.eventFilters = result.eventFilters;
    if (configCache.eventFilters.other === undefined) configCache.eventFilters.other = true;

    // 🌟 赋值缓存
    if (result.playDefaultUnmapped !== undefined) configCache.playDefaultUnmapped = result.playDefaultUnmapped;
    if (result.enableTTS !== undefined) configCache.enableTTS = result.enableTTS;
    if (result.twitterTts) configCache.twitterTts = result.twitterTts;
    if (result.walletTts) configCache.walletTts = result.walletTts;
    if (result.walletFilters) configCache.walletFilters = result.walletFilters;
    if (result.walletDictionary) configCache.walletDictionary = result.walletDictionary;

    // ════════════════════════════════════════════════════════════
    // 🔄 一次性存储迁移（旧版 → 新版），迁移完成后回写并清除旧字段
    // ════════════════════════════════════════════════════════════
    const migrationWrites = {};  // 需要写入的新字段
    const migrationDeletes = []; // 需要清除的旧字段

    // 1️⃣ TTS 配置迁移：旧版 ttsVoice/ttsRate/ttsPitch → 新版 twitterTts/walletTts
    if (!result.twitterTts && (result.ttsVoice || result.ttsRate || result.ttsPitch)) {
        const oldTts = {
            voice: result.ttsVoice || 'zh-CN-XiaoxiaoNeural',
            rate: result.ttsRate || '+0%',
            pitch: result.ttsPitch || '+0%'
        };
        configCache.twitterTts = oldTts;
        configCache.walletTts = { ...oldTts }; // 钱包也继承旧版设置
        migrationWrites.twitterTts = oldTts;
        migrationWrites.walletTts = { ...oldTts };
        migrationDeletes.push('ttsVoice', 'ttsRate', 'ttsPitch');
        console.log("🔄 [GMGN 盯盘伴侣 - 迁移] TTS 配置已从旧版迁移:", oldTts);
    }

    // 2️⃣ 音量迁移：旧版 globalVolume → 新版 twitterVolume/walletVolume
    if (result.globalVolume !== undefined && result.twitterVolume === undefined) {
        configCache.twitterVolume = result.globalVolume;
        configCache.walletVolume = result.globalVolume;
        migrationWrites.twitterVolume = result.globalVolume;
        migrationWrites.walletVolume = result.globalVolume;
        console.log("🔄 [GMGN 盯盘伴侣 - 迁移] 音量已从 globalVolume 迁移:", result.globalVolume);
    }

    // 3️⃣ 钱包过滤器迁移：旧版 sell:true → 新版 sellReduce/sellClear
    if (result.walletFilters && result.walletFilters.sell !== undefined && result.walletFilters.sellReduce === undefined) {
        const oldSell = result.walletFilters.sell;
        configCache.walletFilters.sellReduce = oldSell;
        configCache.walletFilters.sellClear = oldSell;
        delete configCache.walletFilters.sell;
        migrationWrites.walletFilters = configCache.walletFilters;
        console.log("🔄 [GMGN 盯盘伴侣 - 迁移] 卖出过滤器已拆分:", { sellReduce: oldSell, sellClear: oldSell });
    }

    // 4️⃣ defaultAudio 迁移：确保 storage 中有值
    if (!result.defaultAudio) {
        migrationWrites.defaultAudio = 'sounds/default.MP3';
    }

    // 执行回写（仅在有迁移项时触发一次 set + remove）
    if (Object.keys(migrationWrites).length > 0) {
        chrome.storage.local.set(migrationWrites, () => {
            console.log("✅ [GMGN 盯盘伴侣 - 迁移] 已回写新版配置:", Object.keys(migrationWrites));
        });
    }
    if (migrationDeletes.length > 0) {
        chrome.storage.local.remove(migrationDeletes, () => {
            console.log("🗑️ [GMGN 盯盘伴侣 - 迁移] 已清除旧版字段:", migrationDeletes);
        });
    }
    // ════════════════════════════════════════════════════════════

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
        pendingWsMessages.forEach(pendingE => {
            const ts = (pendingE.detail && Array.isArray(pendingE.detail.triggers)) ? pendingE.detail.triggers : [];
            const ids = ts.map(t => t && t.id ? t.id.trim().toLowerCase() : '').filter(Boolean);
            processTwitterMessage(pendingE, `tw_${ids.sort().join(',')}`);
        });
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
        if (changes.twitterVolume) configCache.twitterVolume = changes.twitterVolume.newValue;
        if (changes.walletVolume) configCache.walletVolume = changes.walletVolume.newValue;
        if (changes.eventFilters) configCache.eventFilters = changes.eventFilters.newValue;
        if (changes.isMasterEnabled) {
            configCache.isMasterEnabled = changes.isMasterEnabled.newValue;
            syncMasterToggle();
        }
        if (changes.enableTwitter) configCache.enableTwitter = changes.enableTwitter.newValue;
        if (changes.enableWallet) configCache.enableWallet = changes.enableWallet.newValue;
        // 🌟 监听开关变动更新缓存
        if (changes.playDefaultUnmapped) {
            configCache.playDefaultUnmapped = changes.playDefaultUnmapped.newValue;
        }
        if (changes.enableTTS) {
            configCache.enableTTS = changes.enableTTS.newValue;
        }
        if (changes.twitterTts) configCache.twitterTts = changes.twitterTts.newValue;
        if (changes.walletTts) configCache.walletTts = changes.walletTts.newValue;
        if (changes.walletFilters) configCache.walletFilters = changes.walletFilters.newValue;
        if (changes.walletDictionary) configCache.walletDictionary = changes.walletDictionary.newValue;
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
async function playNetworkTTS(textItems, source = 'twitter') {
    const items = Array.isArray(textItems) ? textItems : [textItems];
    if (items.length === 0 || !items[0]) return;
    const text = items[0];
    console.log(`🔊 [GMGN 盯盘伴侣 - TTS (${source})] 播报:`, items.join(' → '));

    // 获取对应的 TTS 配置
    const ttsConfig = source === 'wallet' ? (configCache.walletTts || {}) : (configCache.twitterTts || {});
    const voice = ttsConfig.voice || 'zh-CN-XiaoxiaoNeural';
    const rate = ttsConfig.rate || '+0%';
    const pitch = ttsConfig.pitch || '+0%';

    // 获取对应音量
    const defaultVol = configCache.globalVolume !== undefined ? configCache.globalVolume : 1;
    const targetVolume = source === 'wallet' 
        ? (configCache.walletVolume !== undefined ? configCache.walletVolume : defaultVol)
        : (configCache.twitterVolume !== undefined ? configCache.twitterVolume : defaultVol);

    try {
        const fetchAudioBlob = async (textChunk) => {
            const cacheKey = `${textChunk}_${voice}_${rate}_${pitch}`;
            let blob = await idb.get(cacheKey);
            if (!blob) {
                // 🛡️ 超时保护：防止 CF Worker 冷启动或网络波动时 fetch 永久 hang 住
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                try {
                    const url = `${CF_TTS_API}/tts`;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: textChunk, voice: voice, rate: rate, pitch: pitch }),
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    if (!res.ok) throw new Error(`CF Worker 返回错误: ${res.status}`);
                    blob = await res.blob();
                    await idb.set(cacheKey, blob);
                } catch (e) {
                    clearTimeout(timeoutId);
                    throw e; // 让外层 catch 降级到默认提示音
                }
            }
            return blob;
        };

        const blob1 = await fetchAudioBlob(text);
        const firstUrl = URL.createObjectURL(blob1);
        const firstAudio = new Audio(firstUrl);
        firstAudio.crossOrigin = "anonymous";
        applyGainToAudio(firstAudio, targetVolume * 1.5);
        firstAudio.play().catch(e => { 
            console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] Cloud TTS Blob首段播放失败，降级到默认提示音:", e.name);
            URL.revokeObjectURL(firstUrl);
            if (typeof playConcurrentAudio === 'function') {
                playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio || 'sounds/default.MP3'));
            }
        });

        if (items.length > 1) {
            const prefetchPromises = [];
            for (let i = 1; i < items.length; i++) prefetchPromises.push(fetchAudioBlob(items[i]).catch(e => null));
            const resolvedBlobs = Promise.all(prefetchPromises); // 只 resolve 一次，后续递归直接复用
            
            const playNext = async (index) => {
                const blobList = await resolvedBlobs;
                const nextBlob = blobList[index - 1];
                if (!nextBlob) { return; }
                const nextUrl = URL.createObjectURL(nextBlob);
                const nextAudio = new Audio(nextUrl);
                nextAudio.crossOrigin = "anonymous";
                applyGainToAudio(nextAudio, targetVolume * 1.5);
                nextAudio.onended = () => { 
                    URL.revokeObjectURL(nextUrl); 
                    if (nextAudio.__sourceNode) {
                        try { nextAudio.__sourceNode.disconnect(); } catch(e){}
                        try { nextAudio.__gainNode.disconnect(); } catch(e){}
                    }
                    if (index + 1 < items.length) playNext(index + 1); 
                };
                nextAudio.onerror = () => { URL.revokeObjectURL(nextUrl); };
                nextAudio.play().catch(e => {
                    console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] Cloud TTS Blob后续播放失败:", e.name, e.message);
                    URL.revokeObjectURL(nextUrl);
                });
            };
            firstAudio.onended = () => { 
                URL.revokeObjectURL(firstUrl); 
                if (firstAudio.__sourceNode) {
                    try { firstAudio.__sourceNode.disconnect(); } catch(e){}
                    try { firstAudio.__gainNode.disconnect(); } catch(e){}
                }
                playNext(1); 
            };
            firstAudio.onerror = () => { URL.revokeObjectURL(firstUrl); playNext(1); };
        } else {
            firstAudio.onended = () => { 
                URL.revokeObjectURL(firstUrl); 
                if (firstAudio.__sourceNode) {
                    try { firstAudio.__sourceNode.disconnect(); } catch(e){}
                    try { firstAudio.__gainNode.disconnect(); } catch(e){}
                }
            };
            firstAudio.onerror = () => { URL.revokeObjectURL(firstUrl); };
        }
    } catch (error) {
        console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] CF TTS 失败，降级到默认提示音:", error.message || error);
        if (typeof playConcurrentAudio === 'function') {
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio || 'sounds/default.MP3'), source);
        }
    }
}

// 🌟 统一的 playConcurrentAudio（合并了预热克隆逻辑与双通道配置）
function playConcurrentAudio(src, source = 'twitter', ttsFallbackText = null) {
    if (!src) return;
    const defaultVol = configCache.globalVolume !== undefined ? configCache.globalVolume : 1;
    const targetVolume = source === 'wallet' 
        ? (configCache.walletVolume !== undefined ? configCache.walletVolume : defaultVol)
        : (configCache.twitterVolume !== undefined ? configCache.twitterVolume : defaultVol);

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
                    const fallbackSrc = chrome.runtime.getURL(configCache.defaultAudio || 'sounds/default.MP3');
                    if (src !== fallbackSrc) {
                        player = new Audio(fallbackSrc);
                    }

                    // 🌟 核心修复：加入重建锁，阻断并发重入风暴
                    if (typeof isRebuildingBlob !== 'undefined' && !isRebuildingBlob) {
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
            const safeSrc = typeof extensionBlobs !== 'undefined' ? extensionBlobs[src] : null;
            if (safeSrc) {
                player = new Audio(safeSrc);
                player.crossOrigin = "anonymous";
            } else {
                player = new Audio(src); // 没有安全源时，不加 crossOrigin 防止请求直接被浏览器拦截
            }
            // 缓存未命中或失效时，尝试重新预热
            if (typeof warmupAudio === 'function') warmupAudio(src);
        }
    }

    // 默认音效和定制音效走统一的增益逻辑
    applyGainToAudio(player, targetVolume);

    // 🌟 播放结束后释放资源，防止 GainNode / MediaElementSource 内存泄漏
    const cleanup = () => {
        if (!player) return;
        player.pause();
        player.removeAttribute('src');
        player.load();
        if (player.__sourceNode) {
            try { player.__sourceNode.disconnect(); } catch(e){}
            try { player.__gainNode.disconnect(); } catch(e){}
        }
        player.removeEventListener('ended', cleanup);
        player.removeEventListener('error', handleError);
        player = null;
    };

    const handleError = (e) => {
        console.warn("⚠️ [GMGN 盯盘伴侣] 主音频源异常，尝试纯 TTS 降级:", e);
        cleanup();
        if (ttsFallbackText) {
            playNetworkTTS(ttsFallbackText, source);
        }
    };

    player.addEventListener('ended', cleanup);
    player.addEventListener('error', handleError);

    // 🔊 执行播放
    player.play().catch(e => {
        if (e.name !== 'NotAllowedError') {
            console.error("❌ [GMGN 盯盘伴侣] 音频播放失败:", { error: e.name, message: e.message });
        }
        cleanup();
        if (ttsFallbackText) {
            playNetworkTTS(ttsFallbackText, source);
        }
    });
}

function processTwitterMessage(e, fingerprint) {
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



    try {
        if (vipAudioSrc) {
            globalLastPlayTime = now;
            markEventPlayed(fingerprint);
            playConcurrentAudio(vipAudioSrc, 'twitter', ttsInfo); // 🎤 传入 TTS 文本
        } else if (ttsInfo) {
            // 🚀 新增分支：只有纯 TTS，没有任何前置铃声
            globalLastPlayTime = now;
            markEventPlayed(fingerprint);
            playNetworkTTS(ttsInfo, 'twitter');
        } else if (vipFallbackDefault) {
            // 降级情况：文件丢失被迫使用默认音 (不受新开关影响，照常播放)
            globalLastPlayTime = now;
            markEventPlayed(fingerprint);
            console.log("🎵 [GMGN 盯盘伴侣] 降级播放默认音频");
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio || 'sounds/default.MP3'), 'twitter');
        } else if (nobodyWantsDefault && !isVipPresent) {
            // 🌟 新增判断：只有当允许播放未映射音频，且距离上次播放大于2秒时，才播放
            if (configCache.playDefaultUnmapped && (now - globalLastPlayTime > 2000)) {
                globalLastPlayTime = now;
                markEventPlayed(fingerprint);

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
                    playNetworkTTS(unmappedTTS, 'twitter');
                } else {
                    // 如果关闭了 TTS 开关，则降级为只播放默认的“推特新消息” MP3
                    playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio || 'sounds/default.MP3'), 'twitter');
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
    // 📡 信号到达日志：无论是否播放，均打印原始信号，方便排障
    const triggers = (e.detail && Array.isArray(e.detail.triggers)) ? e.detail.triggers : [];
    const triggerIds = triggers.map(t => t && t.id ? t.id.trim().toLowerCase() : '').filter(Boolean);
    const triggerLabel = triggers.map(t => t && t.id ? `${t.id}(${t.tw || '?'})` : '?').join(', ');

    // 🔒 生成事件指纹：所有 trigger ID 排序后拼接（保证不同 Tab 对同一推文指纹一致）
    const eventFingerprint = `tw_${triggerIds.sort().join(',')}`;
    const alreadyPlayed = wasPlayedByOtherTab(eventFingerprint);

    console.log(`📡 [GMGN 盯盘伴侣 - 推特信号] 收到 ${triggers.length} 条 | ${triggerLabel}`, {
        fingerprint: eventFingerprint,
        masterOn: configCache.isMasterEnabled,
        twitterOn: configCache.enableTwitter,
        cacheReady: isCacheReady,
        otherTabPlayed: alreadyPlayed,
        willPlay: configCache.isMasterEnabled && configCache.enableTwitter && !alreadyPlayed && isCacheReady
    });

    // 1. 前置拦截：精准判断扩展上下文是否已丢失
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        console.warn("👻 [GMGN 盯盘伴侣] 扩展已更新，旧上下文失效，正在清理遗留监听器。");
        window.removeEventListener('TWITTER_WS_MSG_RECEIVED', handleTwitterMsg);
        if (typeof audioSyncChannel !== 'undefined') audioSyncChannel.close(); // 🔪 彻底切断通信频道
        return;
    }

    if (!configCache.isMasterEnabled || !configCache.enableTwitter || alreadyPlayed) return;
    if (!isCacheReady) {
        pendingWsMessages.push(e);
        return;
    }

    try {
        processTwitterMessage(e, eventFingerprint);
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

const walletLastPlayed = new Map();
window.addEventListener('GMGN_WALLET_MSG', async function (e) {
    if (!configCache.isMasterEnabled || !configCache.enableWallet) return;
    const item = e.detail;
    if (!item || !item.m || !item.bs) return; // 'm' is maker, 'bs' is token symbol
    
    const maker = item.m.toLowerCase();
    const tokenSymbol = item.bs || '代币';
    const amountUSD = parseFloat(item.cu) || parseFloat(item.au) || 0;
    const action = item.s;
    const cnt = item.cnt; // 'processed' 或 'confirm'

    if (action !== 'buy' && action !== 'sell') return; // 只关心买卖动作

    if (configCache.walletFilters && amountUSD < configCache.walletFilters.minAmount) return;
    if (configCache.walletFilters && configCache.walletFilters.maxAmount > 0 && amountUSD > configCache.walletFilters.maxAmount) return;
    if (action === 'buy' && configCache.walletFilters && configCache.walletFilters.buy === false) return;
    // 卖出的减仓/清仓过滤延迟到 confirm 阶段（processed 时还没有 ooc 信息）
    // 但如果减仓和清仓都关闭了，直接跳过
    if (action === 'sell' && configCache.walletFilters && configCache.walletFilters.sellReduce === false && configCache.walletFilters.sellClear === false) return;

    // 🌟 市值范围过滤：市值 = 单价(pu) × 总供应量(bts)，单位 K(千美元)
    if (configCache.walletFilters) {
        const marketCapK = (parseFloat(item.pu) || 0) * (parseFloat(item.bts) || 0) / 1000;
        if (configCache.walletFilters.minMcap > 0 && marketCapK < configCache.walletFilters.minMcap) return;
        if (configCache.walletFilters.maxMcap > 0 && marketCapK > configCache.walletFilters.maxMcap) return;
    }

    // 🌟 代币时间范围过滤：代币年龄 = (交易时间ts - 创建时间bct) / 60，单位分钟
    if (configCache.walletFilters && item.bct) {
        const tokenAgeMin = (item.ts - item.bct) / 60;
        if (configCache.walletFilters.minAge > 0 && tokenAgeMin < configCache.walletFilters.minAge) return;
        if (configCache.walletFilters.maxAge > 0 && tokenAgeMin > configCache.walletFilters.maxAge) return;
    }

    if (!configCache.walletDictionary) return;
    const walletInfo = configCache.walletDictionary[maker];
    if (!walletInfo || !walletInfo.rename || walletInfo.rename.trim() === "") return;
    
    let rename = walletInfo.rename.trim();
    const txHash = item.h;

    // 🔒 生成钱包事件指纹：txHash 优先，无 txHash 时用 maker+action+symbol
    const walletFingerprint = txHash
        ? `wl_${txHash}_${cnt || 'any'}`
        : `wl_${maker}_${action}_${tokenSymbol}`;

    // 🔒 跨 Tab 精准去重：检查此事件是否已被其他 Tab 播放
    if (wasPlayedByOtherTab(walletFingerprint)) return;

    if (action === 'buy') {
        // ✅ 买入：processed 阶段直接播报完整内容，confirm 通过 txHash 去重跳过
        if (txHash) {
            if (walletLastPlayed.has(txHash)) return;
            walletLastPlayed.set(txHash, true);
        } else {
            const dbKey = `${maker}_buy_${tokenSymbol}`;
            const now = Date.now();
            if (walletLastPlayed.has(dbKey) && now - walletLastPlayed.get(dbKey) < 2500) return;
            walletLastPlayed.set(dbKey, now);
        }
        markEventPlayed(walletFingerprint);
        playNetworkTTS([`${rename}买入`, tokenSymbol], 'wallet');
    } else {
        // 🌟 卖出：两阶段流式播报架构
        // 第一阶段 (processed)：立刻播报备注名，不等待 ooc 判定，抢占先机
        // 第二阶段 (confirm)：获取 ooc 后判断减仓/清仓，根据用户开关决定是否补播
        if (txHash) {
            const state = walletLastPlayed.get(txHash);
            if (state === true) return; // 该交易已完成全部播报

            if (cnt === 'processed') {
                if (state) return; // 已处理过 processed 阶段
                walletLastPlayed.set(txHash, 'pending_sell');
                markEventPlayed(walletFingerprint);
                playNetworkTTS([rename], 'wallet'); // 🎤 第一阶段：先播备注名
            } else if (cnt === 'confirm') {
                const isClearAll = item.ooc === 1;
                const actionText = isClearAll ? '清仓' : '减仓';

                // 🌟 根据用户开关过滤：清仓关闭则不播清仓，减仓关闭则不播减仓
                if (configCache.walletFilters) {
                    if (isClearAll && configCache.walletFilters.sellClear === false) {
                        walletLastPlayed.set(txHash, true); // 标记已完成，避免重复
                        return;
                    }
                    if (!isClearAll && configCache.walletFilters.sellReduce === false) {
                        walletLastPlayed.set(txHash, true);
                        return;
                    }
                }

                if (state === 'pending_sell') {
                    // 🎤 第二阶段：补播 "减仓/清仓+代币名" 合并为一条 TTS 请求
                    walletLastPlayed.set(txHash, true);
                    markEventPlayed(walletFingerprint);
                    playNetworkTTS([`${actionText}${tokenSymbol}`], 'wallet');
                } else {
                    // 降级兜底：没收到 processed，直接播完整内容
                    walletLastPlayed.set(txHash, true);
                    markEventPlayed(walletFingerprint);
                    playNetworkTTS([`${rename}${actionText}${tokenSymbol}`], 'wallet');
                }
            }
        } else {
            // 无 txHash 的降级去重逻辑
            const dbKey = `${maker}_sell_${tokenSymbol}`;
            const now = Date.now();
            if (walletLastPlayed.has(dbKey) && now - walletLastPlayed.get(dbKey) < 2500) return;
            walletLastPlayed.set(dbKey, now);
            const isClearAll = item.ooc === 1;
            const actionText = isClearAll ? '清仓' : '减仓';
            // 无 txHash 时直接根据开关过滤
            if (configCache.walletFilters) {
                if (isClearAll && configCache.walletFilters.sellClear === false) return;
                if (!isClearAll && configCache.walletFilters.sellReduce === false) return;
            }
            markEventPlayed(walletFingerprint);
            playNetworkTTS([`${rename}${actionText}`, tokenSymbol], 'wallet');
        }
    }

    // 定期清理防爆内存（Map 保证插入顺序，FIFO 淘汰最老的一半）
    if (walletLastPlayed.size > 2000) {
        const iter = walletLastPlayed.keys();
        for (let i = 0; i < 1000; i++) walletLastPlayed.delete(iter.next().value);
    }
});
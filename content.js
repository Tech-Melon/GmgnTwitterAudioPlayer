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
    try {
        audioSyncChannel.postMessage({ type: 'EVENT_PLAYED', key: fingerprint });
    } catch (e) {
        // 扩展热更新后 BroadcastChannel 已关闭，静默忽略
    }
    // 懒清理：超过 200 条时删除最老的一半
    if (otherTabPlayedEvents.size > 200) {
        const iter = otherTabPlayedEvents.keys();
        for (let i = 0; i < 100; i++) otherTabPlayedEvents.delete(iter.next().value);
    }
}

// 注入移交至 manifest.json 中的 world: "MAIN" 保证绝对的同步执行

// 🔓 Autoplay Policy 解锁器：用户首次交互时同时解锁 Audio.play() + AudioContext
let _autoplayUnlocked = false;
const _unlockAutoplay = () => {
    if (_autoplayUnlocked) return;
    _autoplayUnlocked = true;

    // 1️⃣ 解锁 Audio.play()（从对象池借用，避免创建新实例）
    const silent = AudioPool.acquire();
    if (silent) {
        silent.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
        silent.volume = 0;
        silent.play().then(() => {
            console.log("🔓 [GMGN 盯盘伴侣] Audio.play() 已解锁");
            AudioPool.release(silent);
        }).catch(() => { AudioPool.release(silent); });
    }

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

    // 3️⃣ 移除提示条（如果存在）
    const banner = document.getElementById('gmgn-audio-unlock-banner');
    if (banner) banner.remove();

    ['click', 'keydown', 'touchstart'].forEach(evt =>
        document.removeEventListener(evt, _unlockAutoplay, true)
    );
};
['click', 'keydown', 'touchstart'].forEach(evt =>
    document.addEventListener(evt, _unlockAutoplay, { once: false, capture: true })
);

// 🔔 延迟检测：3秒后若用户仍未交互，注入视觉提示条引导点击
setTimeout(() => {
    if (_autoplayUnlocked) return;
    const banner = document.createElement('div');
    banner.id = 'gmgn-audio-unlock-banner';
    banner.textContent = '🔊 点击页面任意位置，解锁 GMGN 盯盘伴侣音频播报';
    banner.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
        background: linear-gradient(135deg, #ff9500, #ff6b00);
        color: #fff; text-align: center; padding: 10px 16px;
        font-size: 14px; font-weight: 600; cursor: pointer;
        box-shadow: 0 2px 12px rgba(255,149,0,0.4);
        animation: gmgn-banner-pulse 2s ease-in-out infinite;
    `;
    // 注入动画样式
    const style = document.createElement('style');
    style.textContent = `
        @keyframes gmgn-banner-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.85; }
        }
    `;
    document.head.appendChild(style);
    banner.addEventListener('click', _unlockAutoplay);
    document.body.appendChild(banner);
    console.log("🔔 [GMGN 盯盘伴侣] 音频未解锁，已显示提示条");
}, 3000);
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
// ════════════════════════════════════════════════════════════
// 🏊 Audio 固定对象池 — 彻底消灭 WebMediaPlayer 泄漏
// 核心原则：启动时创建 20 个 Audio 实例，永不增减
// 播放时并发借用，全部占满才排队，播完归还
// ════════════════════════════════════════════════════════════
const AudioPool = {
    _pool: [],       // 所有 Audio 实例（固定 20 个）
    _idle: [],       // 空闲实例索引（FIFO 队列）
    _queue: [],      // 待播放任务队列（仅当池满时排队）
    SIZE: 20,

    init() {
        for (let i = 0; i < this.SIZE; i++) {
            const audio = new Audio();
            audio.__poolIdx = i;
            audio.__inUse = false;
            this._pool.push(audio);
            this._idle.push(i);
        }
        console.log(`🏊 [GMGN 盯盘伴侣] Audio 对象池已初始化, 容量: ${this.SIZE}`);
    },

    /** 尝试获取空闲 Audio，无空闲返回 null */
    acquire() {
        if (this._idle.length === 0) return null;
        const idx = this._idle.shift();
        const audio = this._pool[idx];
        audio.__inUse = true;
        return audio;
    },

    /** 归还 Audio 到空闲池 + 触发队列消费 */
    release(audio) {
        if (!audio || audio.__poolIdx === undefined || !audio.__inUse) return;
        try {
            audio.pause();
            audio.onended = null;
            audio.onerror = null;
            audio.removeAttribute('src');
            audio.load(); // 释放底层解码器，但不影响 sourceNode/gainNode 绑定
        } catch (e) { /* 忽略清理异常 */ }
        audio.__inUse = false;
        this._idle.push(audio.__poolIdx);
        this._drain();
    },

    /**
     * 请求播放：有空闲实例直接并发执行，否则排队等待
     * @param {Function} taskFn - 接收 (audio) 参数的播放回调
     */
    play(taskFn) {
        const audio = this.acquire();
        if (audio) {
            taskFn(audio);
        } else {
            if (this._queue.length >= 30) {
                this._queue.shift();
                console.warn("⚠️ [GMGN 盯盘伴侣] 播放队列已满，丢弃最旧任务");
            }
            this._queue.push(taskFn);
        }
    },

    /** 消费等待队列 */
    _drain() {
        while (this._queue.length > 0 && this._idle.length > 0) {
            const task = this._queue.shift();
            const audio = this.acquire();
            if (audio) task(audio);
        }
    },

    /** 获取状态信息（调试用） */
    status() {
        return { total: this.SIZE, idle: this._idle.length, queued: this._queue.length };
    }
};

// 🏊 立即初始化对象池（Audio 元素创建不需要用户交互）
AudioPool.init();

// ════════════════════════════════════════════════════════════
// 🛑 全局唯一独占播放与瞬间打断引擎 (Instant Interrupt Playback)
// 解决多账号并发推文或钱包高频交易时音频叠音问题，且保证最新播报 0 延迟
// ════════════════════════════════════════════════════════════
let currentActivePlayer = null;

/** 中止当前正在播放的全局音频 */
function interruptCurrentAudio() {
    if (currentActivePlayer) {
        try {
            console.log("🛑 [GMGN 盯盘伴侣] 收到新音频信号，打断当前正在播放的旧音频");
            currentActivePlayer.pause();
            currentActivePlayer.onended = null;
            currentActivePlayer.onerror = null;
            
            // 清理多段 TTS 挂载的 URL
            if (currentActivePlayer.__blobUrls) {
                currentActivePlayer.__blobUrls.forEach(u => URL.revokeObjectURL(u));
                currentActivePlayer.__blobUrls = null;
            }
            
            AudioPool.release(currentActivePlayer);
        } catch (e) {
            console.warn("⚠️ [GMGN 盯盘伴侣] 打断音频异常:", e);
        }
        currentActivePlayer = null;
    }
}

// ════════════════════════════════════════════════════════════
// 👑 首发 0 延时 + 动态批处理合并调度引擎 (Zero-Delay Dynamic Batching)
// ════════════════════════════════════════════════════════════
const TwitterBatch = {
    pendingTriggers: [],
    fingerprints: new Set(),
    add(triggers, fingerprint) {
        const now = Date.now();
        triggers.forEach(t => {
            if (t && typeof t.id === 'string') {
                t._queuedAt = now; // 👑 动态挂载排队时间戳，实现旧消息 TTL 智能过滤
                this.pendingTriggers.push(t);
            }
        });
        if (fingerprint) this.fingerprints.add(fingerprint);
    },
    clear() {
        this.pendingTriggers = [];
        this.fingerprints.clear();
    }
};

const WalletBatch = {
    pendingItems: [],
    add(itemData) {
        if (itemData) {
            itemData._queuedAt = Date.now(); // 👑 动态挂载排队时间戳，实现旧消息 TTL 智能过滤
        }
        this.pendingItems.push(itemData);
    },
    clear() {
        this.pendingItems = [];
    }
};

const DynamicPlaybackScheduler = {
    _isPlaying: false,

    /** 试图播报推特消息 (首发 0 延时，占线则入 Batch 缓存) */
    triggerTwitter(triggers, fingerprint) {
        if (!this._isPlaying) {
            this._isPlaying = true;
            playTwitterDirectly(triggers, [fingerprint]);
        } else {
            console.log("⚡ [GMGN 盯盘伴侣 - Scheduler] 播放器占线，推特事件进入动态 Batch 缓存");
            TwitterBatch.add(triggers, fingerprint);
        }
    },

    /** 试图播报钱包消息 (首发 0 延时，占线则入 Batch 缓存) */
    triggerWallet(itemData) {
        if (!this._isPlaying) {
            this._isPlaying = true;
            playWalletDirectly([itemData]);
        } else {
            console.log("⚡ [GMGN 盯盘伴侣 - Scheduler] 播放器占线，钱包事件进入动态 Batch 缓存");
            WalletBatch.add(itemData);
        }
    },

    /** 当前音频播放完毕，解锁并调度下一批 Batch 批处理合并播放 */
    releaseAndNext() {
        this._isPlaying = false;

        if (TwitterBatch.pendingTriggers.length > 0) {
            this._isPlaying = true;
            const triggers = Array.from(TwitterBatch.pendingTriggers);
            const fingerprints = Array.from(TwitterBatch.fingerprints);
            TwitterBatch.clear();
            playTwitterDirectly(triggers, fingerprints);
        } 
        else if (WalletBatch.pendingItems.length > 0) {
            this._isPlaying = true;
            const items = Array.from(WalletBatch.pendingItems);
            WalletBatch.clear();
            playWalletDirectly(items);
        }
    }
};

// ════════════════════════════════════════════════════════════
// 🗄️ Blob 数据预热缓存 — 纯数据层，不占 WebMediaPlayer 配额
// ════════════════════════════════════════════════════════════
const blobCache = new Map(); // src → blobUrl（字符串）

async function warmupAudio(src) {
    if (!src || blobCache.has(src)) return;
    blobCache.set(src, null); // 占位，防止并发重复获取
    try {
        let fetchUrl = src;
        // chrome-extension:// URL 需要先 fetch 转 Blob（页面上下文跨域限制）
        if (src.startsWith('chrome-extension://')) {
            fetchUrl = src;
        }
        // data: URI 和 blob: URL 不需要预热
        if (src.startsWith('data:') || src.startsWith('blob:')) {
            blobCache.set(src, src); // 直接缓存原始 URL
            return;
        }
        const res = await fetch(fetchUrl);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        blobCache.set(src, blobUrl);
    } catch (e) {
        blobCache.delete(src); // 失败时移除占位，允许下次重试
        console.warn("⚠️ [GMGN 盯盘伴侣] 音频预热失败:", src, e.message);
    }
}

// 🌟 将所有可能播放的音频提前灌入 Blob 缓存
function initPreloadCache() {
    // 回收旧的 Blob URL（避免内存泄漏）
    blobCache.forEach((blobUrl, src) => {
        if (blobUrl && blobUrl.startsWith('blob:') && !src.startsWith('blob:')) {
            URL.revokeObjectURL(blobUrl);
        }
    });
    blobCache.clear();

    // 1. 预热默认提示音
    const defaultSrc = configCache.defaultAudio || 'sounds/default.MP3';
    warmupAudio(chrome.runtime.getURL(defaultSrc));

    // 2. 预热自定义音频 (Blob 链接直接缓存)
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
    console.log(`🚀 [GMGN 盯盘伴侣] Blob 预热完成 | 对象池状态:`, AudioPool.status());
}

// sharedAudioCtx 已提升到文件顶部声明
function applyGainToAudio(audio, volume) {
    // 已绑定 GainNode 的池 Audio：统一通过 GainNode 控制音量（createMediaElementSource 不可逆）
    if (audio.__gainNode) {
        audio.__gainNode.gain.value = volume;
        audio.volume = 1.0;
        return;
    }

    // 未绑定 GainNode：音量 ≤100% 直接用原生 volume
    if (volume <= 1.0) {
        audio.volume = Math.max(0, volume);
        return;
    }
    audio.volume = 1.0;

    // 🛡️ Autoplay 未解锁时，禁止触碰 AudioContext
    if (!_autoplayUnlocked) return;

    // 🔥 防御静音 Bug：非 blob/data 源不走 Web Audio API
    const isSafe = audio.crossOrigin === "anonymous" ||
                  (audio.src && (audio.src.startsWith('blob:') || audio.src.startsWith('data:')));
    if (!isSafe) return;

    try {
        if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();

        // 首次绑定（永久），后续复用时直走上方 __gainNode 分支
        if (!audio.__sourceNode) {
            audio.__sourceNode = sharedAudioCtx.createMediaElementSource(audio);
            audio.__gainNode = sharedAudioCtx.createGain();
            audio.__sourceNode.connect(audio.__gainNode);
            audio.__gainNode.connect(sharedAudioCtx.destination);
        }
        audio.__gainNode.gain.value = volume;
    } catch (e) {
        console.warn("[GMGN 盯盘伴侣] 超级音量增益失败，降级为 100% 音量:", e);
    }
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

// 🎤 云端 TTS 极速播放引擎 (AudioPool 池化版 + 双层缓存)
async function playNetworkTTS(textItems, source = 'twitter', onComplete = null) {
    const items = Array.isArray(textItems) ? textItems : [textItems];
    if (items.length === 0 || !items[0]) {
        if (onComplete) onComplete();
        return;
    }
    console.log(`🔊 [GMGN 盯盘伴侣 - TTS (${source})] 准备播报:`, items.join(' → '));

    const ttsConfig = source === 'wallet' ? (configCache.walletTts || {}) : (configCache.twitterTts || {});
    const voice = ttsConfig.voice || 'zh-CN-XiaoxiaoNeural';
    const rate = ttsConfig.rate || '+0%';
    const pitch = ttsConfig.pitch || '+0%';

    const defaultVol = configCache.globalVolume !== undefined ? configCache.globalVolume : 1;
    const targetVolume = source === 'wallet' 
        ? (configCache.walletVolume !== undefined ? configCache.walletVolume : defaultVol)
        : (configCache.twitterVolume !== undefined ? configCache.twitterVolume : defaultVol);

    const fetchAudioBlob = async (textChunk) => {
        const cacheKey = `${textChunk}_${voice}_${rate}_${pitch}`;
        let blob = await idb.get(cacheKey);
        if (!blob) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            try {
                const res = await fetch(`${CF_TTS_API}/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: textChunk, voice, rate, pitch }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (!res.ok) throw new Error(`CF Worker 返回错误: ${res.status}`);
                blob = await res.blob();
                await idb.set(cacheKey, blob);
            } catch (e) {
                clearTimeout(timeoutId);
                throw e;
            }
        }
        return blob;
    };

    let validBlobs = [];
    try {
        // 预取在打断前进行，以便并发消息能“并行下载”，提升响应速度
        const blobs = await Promise.all(
            items.map(item => fetchAudioBlob(item).catch(() => null))
        );
        validBlobs = blobs.filter(b => b !== null);
        if (validBlobs.length === 0) throw new Error('所有 TTS 段获取失败');
    } catch (error) {
        console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] CF TTS 失败，降级到默认提示音:", error.message || error);
        const fallbackAudio = source === 'wallet' ? 'sounds/preset1.MP3' : (configCache.defaultAudio || 'sounds/default.MP3');
        playConcurrentAudio(chrome.runtime.getURL(fallbackAudio), source, null, onComplete);
        return;
    }

    // 播放最新音频前，立刻瞬时打断先前正在播报的旧音频
    interruptCurrentAudio();

    // 从池中借用 Audio 播放
    AudioPool.play((player) => {
        currentActivePlayer = player; // 标记独占状态
        player.crossOrigin = "anonymous";
        
        let blobUrls = []; // 记录所有创建之 Blob URL，以便在打断时能统一释放
        player.__blobUrls = blobUrls;

        const playSegment = (idx) => {
            // 如果在异步段回调中被新来的消息打断，则立刻退出，不再继续播下一段
            if (currentActivePlayer !== player) {
                blobUrls.forEach(u => URL.revokeObjectURL(u));
                if (onComplete) onComplete();
                return;
            }

            if (idx >= validBlobs.length) {
                blobUrls.forEach(u => URL.revokeObjectURL(u));
                player.__blobUrls = null;
                if (currentActivePlayer === player) currentActivePlayer = null;
                AudioPool.release(player);
                if (onComplete) onComplete();
                return;
            }

            const url = URL.createObjectURL(validBlobs[idx]);
            blobUrls.push(url);
            player.src = url;
            applyGainToAudio(player, targetVolume * 1.5);

            player.onended = () => {
                if (currentActivePlayer === player) {
                    playSegment(idx + 1);
                } else {
                    blobUrls.forEach(u => URL.revokeObjectURL(u));
                }
            };
            
            player.onerror = () => {
                blobUrls.forEach(u => URL.revokeObjectURL(u));
                player.__blobUrls = null;
                if (currentActivePlayer === player) currentActivePlayer = null;
                AudioPool.release(player);
                if (onComplete) onComplete();
            };

            player.play().catch(e => {
                if (e.name !== 'NotAllowedError') {
                    console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] 播放段失败:", e.name);
                }
                blobUrls.forEach(u => URL.revokeObjectURL(u));
                player.__blobUrls = null;
                if (currentActivePlayer === player) currentActivePlayer = null;
                AudioPool.release(player);
                if (onComplete) onComplete();
            });
        };

        playSegment(0);
    });
}

// 🌟 统一的 playConcurrentAudio（AudioPool 池化版）
function playConcurrentAudio(src, source = 'twitter', ttsFallbackText = null, onComplete = null) {
    if (!src) {
        if (onComplete) onComplete();
        return;
    }
    const defaultVol = configCache.globalVolume !== undefined ? configCache.globalVolume : 1;
    const targetVolume = source === 'wallet' 
        ? (configCache.walletVolume !== undefined ? configCache.walletVolume : defaultVol)
        : (configCache.twitterVolume !== undefined ? configCache.twitterVolume : defaultVol);

    // 优先使用 Blob 缓存的 URL（预热时已转换）
    const playUrl = blobCache.get(src) || src;

    // 如果缓存还在预热中（占位 null），降级用原始 src
    const finalUrl = playUrl || src;

    // 准备播放前，立刻打断当前正在播放的旧音频
    interruptCurrentAudio();

    // 🏊 从池中借用 Audio，播完归还
    AudioPool.play((player) => {
        currentActivePlayer = player; // 标记独占状态

        // Blob/data URL 设置 crossOrigin 以支持 Web Audio API 增益
        if (finalUrl.startsWith('blob:') || finalUrl.startsWith('data:')) {
            player.crossOrigin = "anonymous";
        } else {
            player.crossOrigin = null;
        }

        player.src = finalUrl;
        applyGainToAudio(player, targetVolume);

        player.onended = () => {
            if (currentActivePlayer === player) currentActivePlayer = null;
            AudioPool.release(player);
            if (onComplete) onComplete();
        };

        player.onerror = (e) => {
            console.warn("⚠️ [GMGN 盯盘伴侣] 音频播放错误:", e);
            if (currentActivePlayer === player) currentActivePlayer = null;
            AudioPool.release(player);
            if (ttsFallbackText) {
                playNetworkTTS(ttsFallbackText, source, onComplete);
            } else {
                if (onComplete) onComplete();
            }
        };

        player.play().catch(e => {
            if (e.name !== 'NotAllowedError') {
                console.error("❌ [GMGN 盯盘伴侣] 音频播放失败:", { error: e.name, message: e.message });
            }
            if (currentActivePlayer === player) currentActivePlayer = null;
            AudioPool.release(player);
            if (ttsFallbackText) {
                playNetworkTTS(ttsFallbackText, source, onComplete);
            } else {
                if (onComplete) onComplete();
            }
        });
    });

    // 缓存未命中时，触发后台预热（下次播放时可用）
    if (!blobCache.has(src)) {
        warmupAudio(src);
    }
}

function playTwitterDirectly(triggers, fingerprints) {
    const onComplete = () => DynamicPlaybackScheduler.releaseAndNext();

    // 🔒 二次校验：调度器排队期间，其他 Tab 可能已经播放了此事件
    if (fingerprints.length > 0 && fingerprints.every(fp => wasPlayedByOtherTab(fp))) {
        console.log("🔒 [GMGN 盯盘伴侣 - Scheduler] 推特事件已被其他 Tab 播放，跳过");
        onComplete();
        return;
    }

    if (lastPlayTime.size > 1000) {
        let i = 0;
        for (const key of lastPlayTime.keys()) {
            lastPlayTime.delete(key);
            if (++i > 100) break;
        }
    }

    const now = Date.now();

    // 👑 1. TTL 过滤：由于播放器占线太久导致的过期堆积推特事件（超过 8 秒）直接丢弃，不予播报
    const validTriggers = triggers.filter(t => (now - (t._queuedAt || now)) < 8000);
    if (validTriggers.length === 0) {
        onComplete();
        return;
    }

    // 👑 2. 超载防轰炸智能压缩：如果有效积压推特触发项 > 3，直接概括，斩断雪崩延迟
    if (validTriggers.length > 3) {
        console.warn(`🚨 [GMGN 盯盘伴侣] 推特积压超载 (${validTriggers.length} 条)，启动弹性概括播报`);
        playNetworkTTS("多位监控账号密集发推", 'twitter', onComplete);
        fingerprints.forEach(fp => markEventPlayed(fp));
        return;
    }

    let vipTtsNames = [];        // 收集开启了 TTS 的 VIP 人名
    let unmappedTtsNames = [];   // 收集开启了 TTS 的普通账号人名
    let vipAudioSources = [];    // 收集专属提示音或自定义音频
    let needsUnmappedDefaultAudio = false;
    let vipFallbackDefault = false;

    validTriggers.forEach(trigger => {
        if (!trigger || typeof trigger.id !== 'string') return;

        const twitterId = trigger.id.trim().toLowerCase();
        const displayName = trigger.name || twitterId;
        const rawActionType = trigger.tw;

        const knownTypes = ['tweet', 'repost', 'reply', 'quote'];
        const actionType = knownTypes.includes(rawActionType) ? rawActionType : 'other';

        if (configCache.eventFilters && configCache.eventFilters[actionType] === false) return;

        const rule = configCache.mappings[twitterId];
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;

        if (mappedAudioId) {
            if (lastPlayTime.has(twitterId) && (now - lastPlayTime.get(twitterId) < 2500)) return;
            lastPlayTime.set(twitterId, now);

            console.log("✅ [GMGN 盯盘伴侣 - 推特首发] VIP 规则匹配:", {
                twitterId,
                audioId: mappedAudioId
            });

            if (configCache.customAudios[mappedAudioId]) {
                const customObj = configCache.customAudios[mappedAudioId];
                const src = typeof customObj === 'string' ? customObj : customObj.data;
                if (src) vipAudioSources.push(src);
            } else if (mappedAudioId.startsWith('custom_')) {
                vipFallbackDefault = true;
            } else {
                const genericSounds = ['default.MP3', 'preset1.MP3'];
                if (configCache.enableTTS && genericSounds.includes(mappedAudioId)) {
                    let speakerName = displayName;
                    if (typeof rule === 'object' && rule !== null && rule.remark) {
                        speakerName = rule.remark;
                    }
                    if (!vipTtsNames.includes(speakerName)) {
                        vipTtsNames.push(speakerName);
                    }
                } else {
                    const src = chrome.runtime.getURL(`sounds/${mappedAudioId}`);
                    if (src) vipAudioSources.push(src);
                }
            }
        } else {
            if (lastPlayTime.has(twitterId) && (now - lastPlayTime.get(twitterId) < 2500)) return;
            lastPlayTime.set(twitterId, now);

            if (configCache.playDefaultUnmapped) {
                if (configCache.enableTTS) {
                    const speakerName = displayName;
                    if (!unmappedTtsNames.includes(speakerName)) {
                        unmappedTtsNames.push(speakerName);
                    }
                } else {
                    needsUnmappedDefaultAudio = true;
                }
            }
        }
    });

    // 广播已播放事件指纹给其他标签页去重
    fingerprints.forEach(fp => markEventPlayed(fp));

    try {
        globalLastPlayTime = now;

        // 1️⃣ 优先合并连读 VIP 账号 of TTS 人声
        if (vipTtsNames.length > 0) {
            const mergedNames = vipTtsNames.join('、');
            playNetworkTTS(`${mergedNames} 发推啦`, 'twitter', onComplete);
        }
        // 2️⃣ 其次合并连读普通未映射账号 of TTS 人声
        else if (unmappedTtsNames.length > 0) {
            const mergedNames = unmappedTtsNames.join('、');
            playNetworkTTS(`${mergedNames} 发推啦`, 'twitter', onComplete);
        }
        // 3️⃣ 播放专属定制/自定义铃声 (并发时最新打断)
        else if (vipAudioSources.length > 0) {
            const latestSrc = vipAudioSources[vipAudioSources.length - 1];
            playConcurrentAudio(latestSrc, 'twitter', null, onComplete);
        } 
        // 4️⃣ 降级默认音频
        else if (vipFallbackDefault) {
            console.log("🎵 [GMGN 盯盘伴侣] 降级播放默认音频");
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio || 'sounds/default.MP3'), 'twitter', null, onComplete);
        }
        // 5️⃣ 合并普通提示音 (600ms 窗口去重，最多只响起 1 次铃声，防轰炸与叠音)
        else if (needsUnmappedDefaultAudio) {
            playConcurrentAudio(chrome.runtime.getURL(configCache.defaultAudio || 'sounds/default.MP3'), 'twitter', null, onComplete);
        } else {
            // 如果经过过滤和去重后没有任何发声项，立刻驱动调度器释放锁并流转
            onComplete();
        }
    } catch (error) {
        console.error("[GMGN 盯盘伴侣] 首发推特播放异常:", error);
        onComplete();
    }
}

function handleTwitterMsg(e) {
    const triggers = (e.detail && Array.isArray(e.detail.triggers)) ? e.detail.triggers : [];
    const triggerIds = triggers.map(t => t && t.id ? t.id.trim().toLowerCase() : '').filter(Boolean);
    const triggerLabel = triggers.map(t => t && t.id ? `${t.id}(${t.tw || '?'})` : '?').join(', ');

    const eventFingerprint = `tw_${triggerIds.sort().join(',')}`;
    const alreadyPlayed = wasPlayedByOtherTab(eventFingerprint);

    console.log(`📡 [GMGN 盯盘伴侣 - 推特信号] 收到 ${triggers.length} 条并发消息直通调度引擎 | ${triggerLabel}`, {
        fingerprint: eventFingerprint,
        masterOn: configCache.isMasterEnabled,
        twitterOn: configCache.enableTwitter,
        cacheReady: isCacheReady,
        otherTabPlayed: alreadyPlayed,
        willQueue: configCache.isMasterEnabled && configCache.enableTwitter && !alreadyPlayed && isCacheReady
    });

    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        console.warn("👻 [GMGN 盯盘伴侣] 扩展已更新，旧上下文失效，正在清理遗留监听器。");
        window.removeEventListener('TWITTER_WS_MSG_RECEIVED', handleTwitterMsg);
        if (typeof audioSyncChannel !== 'undefined') audioSyncChannel.close();
        return;
    }

    if (!configCache.isMasterEnabled || !configCache.enableTwitter || alreadyPlayed) return;
    if (!isCacheReady) {
        pendingWsMessages.push(e);
        return;
    }

    try {
        // 🔒 先广播指纹给其他 Tab，抢占去重窗口（先广播再入队）
        markEventPlayed(eventFingerprint);
        // 🚀 首发消息 0 延时，占线动态批处理合并！
        DynamicPlaybackScheduler.triggerTwitter(triggers, eventFingerprint);
    } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
            window.removeEventListener('TWITTER_WS_MSG_RECEIVED', handleTwitterMsg);
            if (typeof audioSyncChannel !== 'undefined') audioSyncChannel.close();
        } else {
            console.error("[GMGN 盯盘伴侣] 推特调度异常捕获:", error);
        }
    }
}

window.addEventListener('TWITTER_WS_MSG_RECEIVED', handleTwitterMsg);

const walletLastPlayed = new Map();

// ════════════════════════════════════════════════════════════
// 🔇 钱包监控三层冷却引擎（BSC 出块 0.45s，拆单机器人每区块可发一笔）
// ════════════════════════════════════════════════════════════
const walletActionCooldown = new Map();
const WALLET_COOLDOWN_MS = 5000;
const tokenGlobalCooldown = new Map();
const TOKEN_COOLDOWN_MS = 3000;
const userTokenCooldown = new Map();
const userAddrCooldown = new Map();

function playShortBeep(source = 'wallet') {
    if (!_autoplayUnlocked) return;
    try {
        const ctx = sharedAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const vol = source === 'wallet' ? (configCache.walletVolume || 1.0) : (configCache.twitterVolume || 1.0);
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.value = 0.3 * Math.min(vol, 1.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.08);
    } catch (e) {
        console.warn('🔔 [GMGN 盯盘伴侣] beep 播放失败:', e);
    }
}

function playWalletDirectly(list) {
    const onComplete = () => DynamicPlaybackScheduler.releaseAndNext();
    const now = Date.now();

    // 🔒 二次校验：调度器排队期间，其他 Tab 可能已经播放了此事件
    const dedupedList = list.filter(item => !item.walletFingerprint || !wasPlayedByOtherTab(item.walletFingerprint));

    // 👑 1. TTL 过滤：由于播放器占线太久导致的过期堆积钱包交易（超过 8 秒）直接丢弃，不予播报
    const validItems = dedupedList.filter(item => (now - (item._queuedAt || now)) < 8000);
    if (validItems.length === 0) {
        onComplete();
        return;
    }

    // 👑 2. 超载防轰炸智能压缩：如果有效积压钱包交易 > 3 笔，直接概括，斩断雪崩延迟
    if (validItems.length > 3) {
        console.warn(`🚨 [GMGN 盯盘伴侣] 钱包消息积压超载 (${validItems.length} 笔)，启动弹性概括播报`);
        playNetworkTTS("多钱包高频密集异动", 'wallet', onComplete);
        playShortBeep('wallet');
        return;
    }

    // 🌟 降级处理：只有一笔待播，完美兼容原先单发逻辑
    if (validItems.length === 1) {
        const t = validItems[0];

        if (t.action === 'buy') {
            playNetworkTTS([`${t.rename}买入`, t.tokenSymbol], 'wallet', onComplete);
        } else {
            const isClearAll = t.ooc === 1;
            const actionText = isClearAll ? '清仓' : '减仓';
            if (t.cnt === 'processed') {
                playNetworkTTS([t.rename], 'wallet', onComplete);
            } else if (t.cnt === 'confirm') {
                playNetworkTTS([`${actionText}${t.tokenSymbol}`], 'wallet', onComplete);
            } else {
                playNetworkTTS([`${t.rename}${actionText}`, t.tokenSymbol], 'wallet', onComplete);
            }
        }
        return;
    }

    // 🌟 高级处理：多笔钱包交易合并汇总 AI 连读
    let mergedTexts = [];
    const groups = {};

    validItems.forEach(t => {
        const isClearAll = t.ooc === 1;
        let groupAction = t.action;
        let symbol = t.tokenSymbol;

        if (t.action === 'sell') {
            if (t.cnt === 'processed') {
                groupAction = 'sellProcessed';
                symbol = ''; // processed 阶段不报代币名，防拖沓
            } else {
                groupAction = isClearAll ? 'sellClear' : 'sellReduce';
            }
        }

        const key = `${groupAction}_${symbol}`;
        if (!groups[key]) {
            groups[key] = {
                action: t.action,
                groupAction: groupAction,
                tokenSymbol: symbol,
                names: []
            };
        }
        if (!groups[key].names.includes(t.rename)) {
            groups[key].names.push(t.rename);
        }
    });

    const groupKeys = Object.keys(groups);
    groupKeys.forEach(key => {
        const g = groups[key];
        const namesStr = g.names.join('、');

        let actionStr = '买入';
        if (g.groupAction === 'sellProcessed') actionStr = '卖出';
        if (g.groupAction === 'sellReduce') actionStr = '减仓';
        if (g.groupAction === 'sellClear') actionStr = '清仓';

        const phrase = g.groupAction === 'sellProcessed'
            ? `${namesStr}${actionStr}`
            : `${namesStr}${actionStr}${g.tokenSymbol}`;
        mergedTexts.push(phrase);
    });

    const finalTtsText = mergedTexts.join('，同时');
    console.log("🔊 [GMGN 盯盘伴侣 - 钱包动态批处理] 智能连读汇总播报:", finalTtsText);
    playNetworkTTS(finalTtsText, 'wallet', onComplete);
}

async function handleWalletMsg(e) {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        console.warn("👻 [GMGN 盯盘伴侣] 扩展已更新，旧上下文失效，正在清理遗留钱包监听器。");
        window.removeEventListener('GMGN_WALLET_MSG', handleWalletMsg);
        return;
    }

    try {
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

    // ----- 🛡️ 统一的 txHash 状态预检 -----
    // 如果这个 txHash 已经被完全处理过（TTS），或者被冷却引擎抛弃过，直接忽略
    let txState = txHash ? walletLastPlayed.get(txHash) : undefined;
    if (txState === true) return; 

    const ba = (item.ba || item.a || '').toLowerCase(); // 代币合约地址
    const now = Date.now();
    
    // 只有当这个 txHash 已经被放行了第一阶段（pending_sell / skip_processed），它的第二阶段才豁免冷却！
    const isStage2OfAllowedSell = (action === 'sell' && cnt === 'confirm' && (txState === 'pending_sell' || txState === 'skip_processed'));
    // 只有当 txState 为 pending_sell 时，才真正跳过用户冷却（Layer 3 和 4），因为 skip_processed 明确表示需要将用户冷却检查延后到 confirm 阶段
    const bypassUserCooldowns = isStage2OfAllowedSell && txState !== 'skip_processed';

    // 预准备调试日志文本，便于观察哪些播报被冷却拦截
    const isLogClearAll = item.ooc === 1;
    const logActionText = action === 'buy' ? '买入' : (isLogClearAll ? '清仓' : '减仓');
    const fullLogText = `${rename}${logActionText}${tokenSymbol}`;

    // ════════════════════════════════════════════════════════════
    // 🔇 Layer 1: 同钱包冷却 — 拦截拆单/机器人连击
    // 同一个钱包对同一个代币的同方向操作，5秒内只播第一笔
    // ════════════════════════════════════════════════════════════
    if (!isStage2OfAllowedSell) {
        const walletCoolKey = `${maker}_${action}_${ba}`;
        const lastWalletTime = walletActionCooldown.get(walletCoolKey);
        if (lastWalletTime && (now - lastWalletTime) < WALLET_COOLDOWN_MS) {
            console.log(`🔇 [GMGN 盯盘伴侣 - TTS (wallet)] 钱包冷却拦截: ${fullLogText} (剩余 ${((WALLET_COOLDOWN_MS - (now - lastWalletTime)) / 1000).toFixed(1)}s)`);
            if (txHash) walletLastPlayed.set(txHash, true); // 💀 标记该交易已死亡，防止它的 confirm 阶段绕过冷却
            return;
        }
        walletActionCooldown.set(walletCoolKey, now);
    }

    // ════════════════════════════════════════════════════════════
    // 🔔 Layer 2: 同代币全局冷却 — 多钱包并发防叠音
    // 首笔完整 TTS 播报，后续在冷却窗口内只播短促"滴"声（感知热度）
    // ════════════════════════════════════════════════════════════
    if (!isStage2OfAllowedSell) {
        const tokenCoolKey = `${ba}_${action}`;
        const lastTokenTime = tokenGlobalCooldown.get(tokenCoolKey);
        if (lastTokenTime && (now - lastTokenTime) < TOKEN_COOLDOWN_MS) {
            console.log(`🔔 [GMGN 盯盘伴侣 - TTS (wallet)] 代币热度降级(仅滴声): ${fullLogText} (剩余 ${((TOKEN_COOLDOWN_MS - (now - lastTokenTime)) / 1000).toFixed(1)}s)`);
            markEventPlayed(walletFingerprint);
            if (txHash) walletLastPlayed.set(txHash, true); // 💀 标记该交易已处理为 Beep，防止它的 confirm 阶段再次 Beep
            playShortBeep('wallet');
            return;
        }
        tokenGlobalCooldown.set(tokenCoolKey, now);
    }

    // ════════════════════════════════════════════════════════════
    // 🧊 Layer 3: 用户自定义同币冷却器（跨所有钱包，按 CA 冷却）
    // 买入冷却器：同一代币合约在 N 秒内只播报第一笔买入
    // 减仓冷却器：同一代币合约在 N 秒内只播报第一笔减仓
    //   ⚠️ 关键：清仓(ooc===1)是逃顶信号，绝不被减仓冷却器压制
    //   ⚠️ processed 阶段无法区分减仓/清仓，仅在 confirm 阶段触发冷却判定
    // ════════════════════════════════════════════════════════════
    if (!bypassUserCooldowns && ba && configCache.walletFilters) {
        const wf = configCache.walletFilters;
        if (action === 'buy' && wf.buyCooldownEnabled && wf.buyCooldownTime > 0) {
            const userCoolKey = `${ba}_buy`;
            const lastUserTime = userTokenCooldown.get(userCoolKey);
            const cooldownMs = wf.buyCooldownTime * 1000;
            if (lastUserTime && (now - lastUserTime) < cooldownMs) {
                console.log(`🧊 [GMGN 盯盘伴侣 - TTS (wallet)] 同币买入冷却拦截: ${fullLogText} (剩余 ${((cooldownMs - (now - lastUserTime)) / 1000).toFixed(1)}s)`);
                if (txHash) walletLastPlayed.set(txHash, true);
                return;
            }
            userTokenCooldown.set(userCoolKey, now);
        }
        // 减仓冷却器：仅 confirm 阶段且非清仓时触发（processed 阶段放行，因为无法区分减仓/清仓）
        const isClearAll = item.ooc === 1;
        if (action === 'sell' && cnt === 'confirm' && !isClearAll && wf.sellReduceCooldownEnabled && wf.sellReduceCooldownTime > 0) {
            const userCoolKey = `${ba}_sell`;
            const lastUserTime = userTokenCooldown.get(userCoolKey);
            const cooldownMs = wf.sellReduceCooldownTime * 1000;
            if (lastUserTime && (now - lastUserTime) < cooldownMs) {
                console.log(`🧊 [GMGN 盯盘伴侣 - TTS (wallet)] 同币减仓冷却拦截: ${fullLogText} (剩余 ${((cooldownMs - (now - lastUserTime)) / 1000).toFixed(1)}s)`);
                if (txHash) walletLastPlayed.set(txHash, true);
                return;
            }
            userTokenCooldown.set(userCoolKey, now);
        }
    }

    // ════════════════════════════════════════════════════════════
    // 🏠 Layer 4: 用户自定义同址冷却器（按钱包地址冷却）
    // 同一个钱包地址在 N 秒内的同方向操作只播第一笔（不管买/卖什么币）
    //   ⚠️ 清仓有独立的同址冷却开关
    // ════════════════════════════════════════════════════════════
    if (!bypassUserCooldowns && maker && configCache.walletFilters) {
        const wf = configCache.walletFilters;
        const isClearAll = item.ooc === 1;

        if (action === 'buy' && wf.buyAddrCooldownEnabled && wf.buyAddrCooldownTime > 0) {
            const addrKey = `${maker}_buy`;
            const lastTime = userAddrCooldown.get(addrKey);
            const coolMs = wf.buyAddrCooldownTime * 1000;
            if (lastTime && (now - lastTime) < coolMs) {
                console.log(`🏠 [GMGN 盯盘伴侣 - TTS (wallet)] 同址买入冷却拦截: ${fullLogText} (剩余 ${((coolMs - (now - lastTime)) / 1000).toFixed(1)}s)`);
                if (txHash) walletLastPlayed.set(txHash, true);
                return;
            }
            userAddrCooldown.set(addrKey, now);
        }
        // 减仓同址冷却：仅 confirm 阶段且非清仓
        if (action === 'sell' && cnt === 'confirm' && !isClearAll && wf.sellReduceAddrCooldownEnabled && wf.sellReduceAddrCooldownTime > 0) {
            const addrKey = `${maker}_sell`;
            const lastTime = userAddrCooldown.get(addrKey);
            const coolMs = wf.sellReduceAddrCooldownTime * 1000;
            if (lastTime && (now - lastTime) < coolMs) {
                console.log(`🏠 [GMGN 盯盘伴侣 - TTS (wallet)] 同址减仓冷却拦截: ${fullLogText} (剩余 ${((coolMs - (now - lastTime)) / 1000).toFixed(1)}s)`);
                if (txHash) walletLastPlayed.set(txHash, true);
                return;
            }
            userAddrCooldown.set(addrKey, now);
        }
        // 清仓同址冷却：仅 confirm 阶段且为清仓
        if (action === 'sell' && cnt === 'confirm' && isClearAll && wf.sellClearAddrCooldownEnabled && wf.sellClearAddrCooldownTime > 0) {
            const addrKey = `${maker}_clear`;
            const lastTime = userAddrCooldown.get(addrKey);
            const coolMs = wf.sellClearAddrCooldownTime * 1000;
            if (lastTime && (now - lastTime) < coolMs) {
                console.log(`🏠 [GMGN 盯盘伴侣 - TTS (wallet)] 同址清仓冷却拦截: ${fullLogText} (剩余 ${((coolMs - (now - lastTime)) / 1000).toFixed(1)}s)`);
                if (txHash) walletLastPlayed.set(txHash, true);
                return;
            }
            userAddrCooldown.set(addrKey, now);
        }
    }
    if (action === 'buy') {
        // ✅ 买入：processed 阶段直接播报完整内容，confirm 通过 txHash 去重跳过
        if (txHash) {
            walletLastPlayed.set(txHash, true);
        } else {
            const dbKey = `${maker}_buy_${tokenSymbol}`;
            if (walletLastPlayed.has(dbKey) && now - walletLastPlayed.get(dbKey) < 2500) return;
            walletLastPlayed.set(dbKey, now);
        }
        markEventPlayed(walletFingerprint);
        // 🚀 通过调度器统一播放，杜绝推特/钱包并发叠音
        DynamicPlaybackScheduler.triggerWallet({ txHash, rename, tokenSymbol, action, ooc: item.ooc, cnt, walletFingerprint });
    } else {
        // 🌟 卖出：两阶段流式播报架构
        // 第一阶段 (processed)：立刻播报备注名，不等待 ooc 判定，抢占先机
        // 第二阶段 (confirm)：获取 ooc 后判断减仓/清仓，根据用户开关决定是否补播
        if (txHash) {

            if (cnt === 'processed') {
                if (txState) return; // 已处理过 processed 阶段

                // 🧊 如果有任何卖出冷却器启用，跳过 processed 阶段的提前播报
                // 因为 confirm 阶段可能被冷却吞掉，导致用户只听到孤立的备注名没有下文
                // 此时改为让 confirm 阶段走降级兜底路径，一次性播完整内容
                const wf = configCache.walletFilters || {};
                const hasSellCooldown = wf.sellReduceCooldownEnabled || wf.sellReduceAddrCooldownEnabled
                    || wf.sellClearAddrCooldownEnabled;
                if (hasSellCooldown) {
                    walletLastPlayed.set(txHash, 'skip_processed'); // 标记跳过，让 confirm 走完整播报
                    return;
                }

                walletLastPlayed.set(txHash, 'pending_sell');
                markEventPlayed(walletFingerprint);
                // 🚀 第一阶段：先播备注名，通过调度器统一播放
                DynamicPlaybackScheduler.triggerWallet({ txHash, rename, tokenSymbol, action, ooc: item.ooc, cnt: 'processed', walletFingerprint });
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

                if (txState === 'pending_sell') {
                    // 🎤 第二阶段：补播 "减仓/清仓+代币名"，通过调度器统一播放
                    walletLastPlayed.set(txHash, true);
                    markEventPlayed(walletFingerprint);
                    DynamicPlaybackScheduler.triggerWallet({ txHash, rename, tokenSymbol, action, ooc: item.ooc, cnt: 'confirm', walletFingerprint });
                } else {
                    // 降级兜底：没收到 processed / 冷却器跳过了 processed → 完整播报
                    walletLastPlayed.set(txHash, true);
                    markEventPlayed(walletFingerprint);
                    // cnt 设为 null，让 playWalletDirectly 走完整播报分支（包含备注名）
                    DynamicPlaybackScheduler.triggerWallet({ txHash, rename, tokenSymbol, action, ooc: item.ooc, cnt: null, walletFingerprint });
                }
            }
        } else {
            // 无 txHash 的降级去重逻辑
            const dbKey = `${maker}_sell_${tokenSymbol}`;
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
            // 🚀 无 txHash 降级路径，通过调度器统一播放
            DynamicPlaybackScheduler.triggerWallet({ txHash: null, rename, tokenSymbol, action, ooc: item.ooc, cnt: null, walletFingerprint });
        }
    }

    // 定期清理防爆内存（Map 保证插入顺序，FIFO 淘汰最老的一半）
    if (walletLastPlayed.size > 2000) {
        const iter = walletLastPlayed.keys();
        for (let i = 0; i < 1000; i++) walletLastPlayed.delete(iter.next().value);
    }
    // 冷却 Map 也需要清理，避免长期运行内存膨胀
    if (walletActionCooldown.size > 500) {
        const iter = walletActionCooldown.keys();
        for (let i = 0; i < 250; i++) walletActionCooldown.delete(iter.next().value);
    }
    if (tokenGlobalCooldown.size > 500) {
        const iter = tokenGlobalCooldown.keys();
        for (let i = 0; i < 250; i++) tokenGlobalCooldown.delete(iter.next().value);
    }
    // 🧊 用户自定义冷却器 Map 清理
    if (userTokenCooldown.size > 500) {
        const iter = userTokenCooldown.keys();
        for (let i = 0; i < 250; i++) userTokenCooldown.delete(iter.next().value);
    }
    // 🏠 同址冷却器 Map 清理
    if (userAddrCooldown.size > 500) {
        const iter = userAddrCooldown.keys();
        for (let i = 0; i < 250; i++) userAddrCooldown.delete(iter.next().value);
    }
    } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
            window.removeEventListener('GMGN_WALLET_MSG', handleWalletMsg);
        } else {
            console.error("[GMGN 盯盘伴侣] 钱包播放异常捕获:", error);
        }
    }
}

window.addEventListener('GMGN_WALLET_MSG', handleWalletMsg);
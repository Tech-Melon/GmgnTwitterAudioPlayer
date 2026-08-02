let configCache = {
    isMasterEnabled: true,
    enableTwitter: true,
    enableWallet: true,
    playDefaultUnmapped: true,
    playMappedGeneric: true,
    enableTTS: true
};
let isCacheReady = false;
let pendingWsMessages = [];
let audioSyncChannel = new BroadcastChannel('gmgn_audio_sync_channel');
let sharedAudioCtx = null; // 🌟 全局共享 AudioContext（必须在 _unlockAutoplay 之前声明）

// ════════════════════════════════════════════════════════════
// 👑 Tab Leader Election — 多 Tab 单例播报引擎
// 只有 Leader Tab 执行音频播报，其他 Tab 保持静默
// 优先级：前台已解锁 > 后台已解锁 > tabId 字典序
// 后台 Leader 主动让位 / NotAllowed 弃权，避免「后台占权 → 全静音」
// ════════════════════════════════════════════════════════════
const TabLeader = {
    _tabId: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    _leaderId: null,           // 当前 Leader 的 tabId
    _heartbeatTimer: null,     // Leader 心跳定时器
    _electionTimer: null,      // Follower 竞选超时器 / 竞选等待
    _initialized: false,
    _audioReady: false,        // 本 Tab 是否已解锁 autoplay
    _seenCandidates: null,     // Map<tabId, {audioReady, visible}>
    HEARTBEAT_INTERVAL: 2000,  // 心跳间隔 2s
    ELECTION_TIMEOUT: 5000,    // 无心跳 5s 后发起竞选
    CLAIM_WAIT: 900,           // 竞选收集窗口（等齐同批 CLAIM）

    /** 页面是否前台可见（后台 Chrome 常拦 autoplay / 挂起 AudioContext） */
    _isPageActive() {
        try {
            return typeof document === 'undefined' || document.visibilityState !== 'hidden';
        } catch (e) {
            return true;
        }
    },

    /** tabId 字典序更小 = 更强（同批打开时时间戳更早者优先） */
    _isStronger(a, b) {
        if (!a) return false;
        if (!b) return true;
        return String(a) < String(b);
    },

    /**
     * 候选评分：前台已解锁(3) > 后台已解锁(2) > 前台未解锁(1) > 后台未解锁(0)
     * 同分再比 tabId
     */
    _scoreCandidate(meta) {
        const ready = !!(meta && meta.audioReady);
        const visible = !!(meta && meta.visible);
        if (ready && visible) return 3;
        if (ready) return 2;
        if (visible) return 1;
        return 0;
    },

    /** 在候选 Map 中选出最优 tabId */
    _pickWinner(candidates) {
        if (!candidates || candidates.size === 0) return this._tabId;
        let winner = null;
        let bestScore = -1;
        for (const [id, meta] of candidates) {
            const score = this._scoreCandidate(meta || {});
            if (
                winner === null ||
                score > bestScore ||
                (score === bestScore && this._isStronger(id, winner))
            ) {
                winner = id;
                bestScore = score;
            }
        }
        return winner || this._tabId;
    },

    _selfMeta() {
        return { audioReady: this._audioReady, visible: this._isPageActive() };
    },

    _heartbeatPayload() {
        return {
            type: 'LEADER_HEARTBEAT',
            tabId: this._tabId,
            audioReady: this._audioReady,
            visible: this._isPageActive()
        };
    },

    init() {
        if (this._initialized) return;
        this._initialized = true;
        this._startClaimRound();
        console.log(`🏁 [GMGN 盯盘伴侣 - TabLeader] 本 Tab 已加入选举 | tabId: ${this._tabId.slice(0, 12)}...`);
    },

    /** 当前 Tab 是否为 Leader */
    isLeader() {
        return this._leaderId === this._tabId;
    },

    /** 用户已解锁 autoplay：前台优先接管播报权 */
    markAudioReady() {
        this._audioReady = true;
        if (this.isLeader()) {
            this._broadcastMsg(this._heartbeatPayload());
            return;
        }
        // 已解锁且前台：主动接管；后台仅宣告存在，不强抢
        if (this._isPageActive()) {
            this._broadcastMsg({
                type: 'LEADER_TAKEOVER',
                tabId: this._tabId,
                audioReady: true,
                visible: true
            });
            this._becomeLeader('用户解锁后前台接管');
        } else {
            this._broadcastMsg({
                type: 'LEADER_CLAIM',
                tabId: this._tabId,
                audioReady: true,
                visible: false
            });
        }
    },

    /**
     * Leader 无法播报时弃权
     * - 后台 NotAllowed：必须弃权（Chrome 后台常禁声）
     * - 前台已解锁 NotAllowed：短暂保留，避免无其它 Tab 时空窗
     */
    abdicate(reason) {
        if (!this.isLeader()) return;
        const active = this._isPageActive();
        if (this._audioReady && reason === 'NotAllowedError' && active) {
            console.warn(`⚠️ [GMGN 盯盘伴侣 - TabLeader] 前台已解锁仍 NotAllowed，保持 Leader | ${reason}`);
            return;
        }
        console.warn(`🏳️ [GMGN 盯盘伴侣 - TabLeader] Leader 弃权: ${reason || 'unknown'} | visible=${active} audioReady=${this._audioReady}`);
        this._stopHeartbeat();
        const prev = this._tabId;
        this._leaderId = null;
        this._broadcastMsg({ type: 'LEADER_ABDICATE', tabId: prev, reason: reason || '' });
        this._resetElectionTimer();
    },

    /** 切到后台：若仍是 Leader，主动让位给其它已解锁前台 Tab */
    onVisibilityHidden() {
        if (!this.isLeader()) return;
        console.log('👁️ [GMGN 盯盘伴侣 - TabLeader] Leader 进入后台，广播让位');
        this._broadcastMsg({
            type: 'LEADER_BACKGROUND_YIELD',
            tabId: this._tabId,
            audioReady: this._audioReady,
            visible: false
        });
        // 不立刻清空 _leaderId：若无其它 Tab，自己仍可在后台尽量播；
        // 有人 TAKEOVER / 前台心跳时再让出。同步发一轮心跳标明 visible=false。
        this._broadcastMsg(this._heartbeatPayload());
    },

    /** 回到前台且已解锁：立刻接管，避免后台 Leader 继续占权 */
    onVisibilityVisible() {
        if (!this._audioReady) return;
        if (this.isLeader()) {
            this._broadcastMsg(this._heartbeatPayload());
            return;
        }
        console.log('👁️ [GMGN 盯盘伴侣 - TabLeader] 前台已解锁，请求接管播报权');
        this._broadcastMsg({
            type: 'LEADER_TAKEOVER',
            tabId: this._tabId,
            audioReady: true,
            visible: true
        });
        this._becomeLeader('回到前台接管');
    },

    /** 发起一轮 CLAIM 竞选 */
    _startClaimRound() {
        this._seenCandidates = new Map();
        this._seenCandidates.set(this._tabId, this._selfMeta());
        this._broadcastMsg({
            type: 'LEADER_CLAIM',
            tabId: this._tabId,
            audioReady: this._audioReady,
            visible: this._isPageActive()
        });
        if (this._electionTimer) clearTimeout(this._electionTimer);
        this._electionTimer = setTimeout(() => {
            this._electionTimer = null;
            this._tryBecomeLeaderAfterClaim();
        }, this.CLAIM_WAIT);
    },

    /** 竞选窗口结束：仅最优候选自封 */
    _tryBecomeLeaderAfterClaim() {
        if (this._leaderId && this._leaderId !== this._tabId) return;
        if (this.isLeader()) return;

        const candidates = this._seenCandidates || new Map([[this._tabId, this._selfMeta()]]);
        const winner = this._pickWinner(candidates);
        if (winner === this._tabId) {
            this._becomeLeader('竞选胜出');
        } else {
            console.log(`🤝 [GMGN 盯盘伴侣 - TabLeader] 认让更优候选 | winner: ${String(winner).slice(0, 12)}...`);
            this._becomeFollower(winner, '竞选认让');
        }
    },

    /** 自封为 Leader，启动心跳 */
    _becomeLeader(reason) {
        this._leaderId = this._tabId;
        if (this._electionTimer) { clearTimeout(this._electionTimer); this._electionTimer = null; }
        this._startHeartbeat();
        console.log(`👑 [GMGN 盯盘伴侣 - TabLeader] 本 Tab 已成为 Leader | tabId: ${this._tabId.slice(0, 12)}... | ${reason || ''} | visible=${this._isPageActive()}`);
    },

    /**
     * 降级为 Follower
     * @param {string} leaderId
     * @param {string} reason
     */
    _becomeFollower(leaderId, reason) {
        if (!leaderId || leaderId === this._tabId) return;
        const changed = this._leaderId !== leaderId;
        const wasLeader = this.isLeader();
        this._leaderId = leaderId;
        this._stopHeartbeat();
        this._resetElectionTimer();
        if (changed || wasLeader) {
            console.log(`🔇 [GMGN 盯盘伴侣 - TabLeader] 本 Tab 为 Follower | Leader: ${String(leaderId).slice(0, 12)}... | ${reason || ''}`);
        }
    },

    _stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    },

    /** Leader 定期心跳广播（含 visible，便于后台让位） */
    _startHeartbeat() {
        this._stopHeartbeat();
        const beat = () => {
            this._broadcastMsg(this._heartbeatPayload());
        };
        this._heartbeatTimer = setInterval(beat, this.HEARTBEAT_INTERVAL);
        beat();
    },

    /** Follower 重置竞选超时计时器 */
    _resetElectionTimer() {
        if (this._electionTimer) clearTimeout(this._electionTimer);
        this._electionTimer = setTimeout(() => {
            console.log(`⏰ [GMGN 盯盘伴侣 - TabLeader] Leader 心跳超时，发起新一轮竞选...`);
            this._leaderId = null;
            this._startClaimRound();
        }, this.ELECTION_TIMEOUT);
    },

    /**
     * 自己作为 Leader 是否应让位给对方
     * 对方前台已解锁 且（自己后台 或 对方评分更高）→ 让
     */
    _shouldYieldTo(data) {
        if (!data || !data.tabId) return false;
        const peer = {
            audioReady: !!data.audioReady,
            visible: data.visible !== false // 旧版消息无 visible 字段时按可见处理
        };
        const self = this._selfMeta();
        const peerScore = this._scoreCandidate(peer);
        const selfScore = this._scoreCandidate(self);
        if (peerScore > selfScore) return true;
        if (peerScore < selfScore) return false;
        // 同分：后台必须让给对方；前台比 tabId
        if (!self.visible && peer.visible) return true;
        if (self.visible && !peer.visible) return false;
        return this._isStronger(data.tabId, this._tabId);
    },

    /** 处理来自其他 Tab 的 Leader 消息 */
    handleMessage(data) {
        if (!data || typeof data.type !== 'string') return;
        if (data.tabId && data.tabId === this._tabId) return;

        switch (data.type) {
            case 'LEADER_HEARTBEAT': {
                if (this.isLeader()) {
                    // 自己在后台、对方前台已解锁 → 让位（核心修复）
                    if (this._shouldYieldTo(data)) {
                        this._becomeFollower(data.tabId, '心跳评分更优/后台让前台');
                    } else {
                        this._broadcastMsg({
                            type: 'LEADER_EXISTS',
                            tabId: this._tabId,
                            audioReady: this._audioReady,
                            visible: this._isPageActive()
                        });
                    }
                } else {
                    this._becomeFollower(data.tabId, '跟随心跳');
                }
                break;
            }

            case 'LEADER_CLAIM': {
                if (this._seenCandidates instanceof Map) {
                    this._seenCandidates.set(data.tabId, {
                        audioReady: !!data.audioReady,
                        visible: data.visible !== false
                    });
                }
                if (this.isLeader()) {
                    this._broadcastMsg({
                        type: 'LEADER_EXISTS',
                        tabId: this._tabId,
                        audioReady: this._audioReady,
                        visible: this._isPageActive()
                    });
                }
                break;
            }

            case 'LEADER_EXISTS': {
                if (this.isLeader()) {
                    if (this._shouldYieldTo(data)) {
                        this._becomeFollower(data.tabId, 'EXISTS 对方更优');
                    } else {
                        this._broadcastMsg({
                            type: 'LEADER_EXISTS',
                            tabId: this._tabId,
                            audioReady: this._audioReady,
                            visible: this._isPageActive()
                        });
                    }
                } else {
                    this._becomeFollower(data.tabId, '确认存在 Leader');
                }
                break;
            }

            case 'LEADER_TAKEOVER': {
                // 前台已解锁请求接管：后台 Leader 必须让；前台比评分/tabId
                if (this.isLeader()) {
                    if (this._shouldYieldTo(data) || !this._isPageActive()) {
                        this._becomeFollower(data.tabId, '让位给前台已解锁 Tab');
                    } else if (this._audioReady && this._isStronger(this._tabId, data.tabId)) {
                        this._broadcastMsg({
                            type: 'LEADER_EXISTS',
                            tabId: this._tabId,
                            audioReady: true,
                            visible: true
                        });
                    } else {
                        this._becomeFollower(data.tabId, '让位给已解锁 Tab');
                    }
                } else {
                    this._becomeFollower(data.tabId, '跟随已解锁 Leader');
                }
                break;
            }

            case 'LEADER_BACKGROUND_YIELD': {
                // 原 Leader 进后台：前台已解锁立刻接管
                if (this._audioReady && this._isPageActive()) {
                    this._broadcastMsg({
                        type: 'LEADER_TAKEOVER',
                        tabId: this._tabId,
                        audioReady: true,
                        visible: true
                    });
                    this._becomeLeader('接管后台 Leader');
                }
                break;
            }

            case 'LEADER_ABDICATE': {
                if (this._leaderId && this._leaderId !== data.tabId && this.isLeader()) break;
                if (this._leaderId === data.tabId || !this._leaderId) {
                    this._leaderId = null;
                    this._stopHeartbeat();
                    // 优先：前台已解锁接管
                    if (this._audioReady && this._isPageActive()) {
                        this._broadcastMsg({
                            type: 'LEADER_TAKEOVER',
                            tabId: this._tabId,
                            audioReady: true,
                            visible: true
                        });
                        this._becomeLeader('接管弃权 Leader');
                    } else if (this._audioReady) {
                        // 仅后台已解锁：参与竞选，不强抢
                        this._startClaimRound();
                    } else {
                        this._startClaimRound();
                    }
                }
                break;
            }
        }
    },

    /** 安全广播消息（扩展热更新后 channel 可能已关闭） */
    _broadcastMsg(msg) {
        try {
            audioSyncChannel.postMessage(msg);
        } catch (e) {
            // BroadcastChannel 已关闭，静默忽略
        }
    },

    /** 页面卸载时清理（让其他 Tab 快速接管） */
    destroy() {
        const wasLeader = this.isLeader();
        this._stopHeartbeat();
        if (this._electionTimer) clearTimeout(this._electionTimer);
        this._heartbeatTimer = null;
        this._electionTimer = null;
        if (wasLeader) {
            this._broadcastMsg({ type: 'LEADER_ABDICATE', tabId: this._tabId, reason: 'unload' });
        }
        this._leaderId = null;
    }
};

// 🛡️ 页面卸载时清理 Leader 资源，让其他 Tab 快速故障转移
window.addEventListener('beforeunload', () => TabLeader.destroy());

// ════════════════════════════════════════════════════════════
// 🔒 跨 Tab 事件指纹去重引擎（降级为兜底安全网，Leader Election 从源头解决）
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

    // 4️⃣ 已解锁 Tab 接管播报权（避免 Leader 在未点击的后台页导致全静音）
    try {
        if (typeof TabLeader !== 'undefined' && TabLeader.markAudioReady) {
            TabLeader.markAudioReady();
        }
    } catch (e) {
        console.warn('⚠️ [GMGN 盯盘伴侣] 解锁后 Leader 接管失败:', e);
    }

    // 5️⃣ 用户手势当帧预热 Offscreen：后台页切走后仍可播（单开/全后台）
    try {
        requestOffscreenWarmup().then((r) => {
            if (r && r.ok) console.log('🔈 [GMGN 盯盘伴侣] Offscreen 后台播报已预热');
            else console.warn('⚠️ [GMGN 盯盘伴侣] Offscreen 预热未完成', r && r.error);
        });
    } catch (e) {
        console.warn('⚠️ [GMGN 盯盘伴侣] Offscreen 预热调用失败:', e);
    }

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
        configCache.playMappedGeneric = result.playMappedGeneric !== false;
        configCache.enableTTS = result.enableTTS !== false;
        configCache.twitterTts = normalizeTtsConfig(result.twitterTts, result);
        configCache.walletTts = normalizeTtsConfig(result.walletTts, result);
        configCache.walletFilters = result.walletFilters || { buy: true, sellReduce: true, sellClear: true, minAmount: 0 };
        configCache.walletDictionary = result.walletDictionary || {};
        configCache.defaultAudio = result.defaultAudio || 'sounds/default.MP3';
        configCache.blockedWsChannels = Array.isArray(result.blockedWsChannels) ? result.blockedWsChannels : [];
        syncChannelToggles();
    });

// 🌟 新增：配置你的 Cloudflare Worker TTS API 节点
// 部署教程参考：https://github.com/DIYgod/cloudflare-edge-tts
const CF_TTS_API = "https://cloudflare-edge-tts.tech-melon.workers.dev";
// 语速唯一档：闪电（旧档位全部迁移）
const TTS_RATE_LIGHTNING = '+75%';

/** 规范化 TTS 配置，强制语速为闪电 */
function normalizeTtsConfig(tts, legacyResult) {
    const base = tts || {
        voice: (legacyResult && legacyResult.ttsVoice) || 'zh-CN-XiaoxiaoNeural',
        rate: TTS_RATE_LIGHTNING,
        pitch: (legacyResult && legacyResult.ttsPitch) || '+0%'
    };
    return {
        voice: base.voice || 'zh-CN-XiaoxiaoNeural',
        rate: TTS_RATE_LIGHTNING,
        pitch: base.pitch || '+0%'
    };
}

/** 向 inject 同步总开关 + 推特/钱包通道（双端拦截，避免关不掉） */
function syncChannelToggles() {
    const master = configCache.isMasterEnabled !== false;
    const twitter = configCache.enableTwitter !== false;
    const wallet = configCache.enableWallet !== false;
    window.dispatchEvent(new CustomEvent('GMGN_AUDIO_TOGGLE', { detail: { enabled: master } }));
    window.dispatchEvent(new CustomEvent('GMGN_CHANNEL_TOGGLE', {
        detail: { master, twitter, wallet }
    }));
}

// 🌟 极速双缓存引擎：IndexedDB 本地持久化（带连接健康检查 + 超时保护 + 自动清理）
const idb = {
    db: null,
    _setCount: 0,            // set 调用计数器
    MAX_ENTRIES: 3000,       // 最大缓存条目数（~90MB，电脑轻松应对）
    CLEANUP_TARGET: 2000,    // 清理后保留条目数（一次清理 1000 条）
    CHECK_INTERVAL: 100,     // 每 100 次 set 检查一次容量

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
            const req = indexedDB.open('GMGNTTSCache', 2); // v2: 添加 ts 索引用于 LRU 清理
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                let store;
                if (!db.objectStoreNames.contains('audio')) {
                    store = db.createObjectStore('audio', { keyPath: 'text' });
                } else {
                    store = e.target.transaction.objectStore('audio');
                }
                if (!store.indexNames.contains('ts')) {
                    store.createIndex('ts', 'ts', { unique: false });
                }
            };
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
            console.debug("⚠️ [GMGN 盯盘伴侣 - IDB] 读取失败，跳过缓存:", e.message);
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
            console.debug("⚠️ [GMGN 盯盘伴侣 - IDB] 写入失败，跳过缓存:", e.message);
            this.db = null;
        }
        // 🧹 定期检查容量并批量清理最旧缓存
        this._setCount++;
        if (this._setCount % this.CHECK_INTERVAL === 0) {
            this._maybeCleanup();
        }
    },
    /** 🧹 检查缓存条目数，超过上限则批量清理最旧的 */
    async _maybeCleanup() {
        try {
            await this.init();
            const count = await new Promise((resolve, reject) => {
                const req = this.db.transaction('audio', 'readonly').objectStore('audio').count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            if (count > this.MAX_ENTRIES) {
                const deleteCount = count - this.CLEANUP_TARGET;
                console.log(`🧹 [GMGN 盯盘伴侣 - IDB] 缓存超限 (${count}/${this.MAX_ENTRIES})，清理 ${deleteCount} 条最旧缓存`);
                await this._doCleanup(deleteCount);
            }
        } catch (e) {
            console.warn("⚠️ [GMGN 盯盘伴侣 - IDB] 容量检查失败:", e.message);
        }
    },
    /** 🧹 按 ts 索引升序（最旧优先）删除 deleteCount 条缓存 */
    async _doCleanup(deleteCount) {
        try {
            await this.init();
            return new Promise((resolve) => {
                const tx = this.db.transaction('audio', 'readwrite');
                const store = tx.objectStore('audio');
                const index = store.index('ts');
                let deleted = 0;
                const cursorReq = index.openCursor();
                cursorReq.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor && deleted < deleteCount) {
                        cursor.delete();
                        deleted++;
                        cursor.continue();
                    } else {
                        console.log(`🧹 [GMGN 盯盘伴侣 - IDB] 已清理 ${deleted} 条旧缓存`);
                        resolve();
                    }
                };
                cursorReq.onerror = () => resolve();
            });
        } catch (e) {
            console.warn("⚠️ [GMGN 盯盘伴侣 - IDB] 缓存清理失败:", e.message);
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
            clearAudioTailFade(audio);
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
// 🎧 双通道播放引擎 (Exclusive 专属铃 ↔ TTS 人声互不打断)
//    - ExclusiveChannel：绑定的专属/自定义铃声，同通道最新打断
//    - TtsChannel：AI 念名 / 默认 ding / 钱包播报，同通道最新打断
//    两通道可叠播，互不 interrupt
// ════════════════════════════════════════════════════════════
const GENERIC_SOUND_IDS = ['default.MP3', 'preset1.MP3'];

let exclusiveActivePlayer = null;
let ttsActivePlayer = null;
// 同账号冷却表（专属铃旁路与 TTS 通道共用，须在双通道辅助函数之前初始化）
let lastPlayTime = new Map();
let globalLastPlayTime = 0;

/** 短淡出后释放池中 Audio（通道无关） */
function _fadeOutAndReleasePlayer(player, logLabel) {
    if (!player) return;
    try {
        console.log(`🛑 [GMGN 盯盘伴侣] ${logLabel}`);
        clearAudioTailFade(player);
        fadeOutGain(player, AUDIO_INTERRUPT_FADE_SEC);
        player.onended = null;
        player.onerror = null;

        const urls = player.__blobUrls;
        player.__blobUrls = null;
        const gen = (player.__interruptGen = (player.__interruptGen || 0) + 1);

        setTimeout(() => {
            if (player.__interruptGen !== gen) return;
            try {
                player.pause();
                if (urls) urls.forEach(u => URL.revokeObjectURL(u));
                AudioPool.release(player);
            } catch (e) {
                try { AudioPool.release(player); } catch (e2) { /* ignore */ }
            }
        }, Math.ceil(AUDIO_INTERRUPT_FADE_SEC * 1000) + 8);
    } catch (e) {
        console.warn("⚠️ [GMGN 盯盘伴侣] 打断音频异常:", e);
        try { AudioPool.release(player); } catch (e2) { /* ignore */ }
    }
}

function interruptExclusiveAudio() {
    if (!exclusiveActivePlayer) return;
    const player = exclusiveActivePlayer;
    exclusiveActivePlayer = null;
    _fadeOutAndReleasePlayer(player, '专属铃通道：打断旧铃声');
}

function interruptTtsAudio() {
    if (!ttsActivePlayer) return;
    const player = ttsActivePlayer;
    ttsActivePlayer = null;
    _fadeOutAndReleasePlayer(player, 'TTS 通道：打断旧播报');
}

function getChannelActivePlayer(channel) {
    return channel === 'exclusive' ? exclusiveActivePlayer : ttsActivePlayer;
}

function setChannelActivePlayer(channel, player) {
    if (channel === 'exclusive') exclusiveActivePlayer = player;
    else ttsActivePlayer = player;
}

function isGenericSoundId(audioId) {
    return !!audioId && GENERIC_SOUND_IDS.includes(audioId);
}

/** 解析专属铃声 src；通用音 / 丢失自定义 / 无绑定 → null */
function resolveExclusiveAudioSrc(mappedAudioId) {
    if (!mappedAudioId || isGenericSoundId(mappedAudioId)) return null;
    if (configCache.customAudios && configCache.customAudios[mappedAudioId]) {
        const customObj = configCache.customAudios[mappedAudioId];
        return typeof customObj === 'string' ? customObj : customObj.data;
    }
    if (String(mappedAudioId).startsWith('custom_')) return null; // 文件丢失 → 走 TTS
    return chrome.runtime.getURL(`sounds/${mappedAudioId}`);
}

function getTwitterSpeakerName(trigger, rule) {
    const twitterId = (trigger && trigger.id ? String(trigger.id) : '').trim().toLowerCase();
    const displayName = (trigger && trigger.name) ? trigger.name : twitterId;
    if (typeof rule === 'object' && rule !== null && rule.remark) return rule.remark;
    return displayName || twitterId;
}

function getTwitterActionType(trigger) {
    const raw = trigger && trigger.tw;
    const knownTypes = ['tweet', 'repost', 'reply', 'quote'];
    return knownTypes.includes(raw) ? raw : 'other';
}

function isTwitterEventAllowed(trigger) {
    const actionType = getTwitterActionType(trigger);
    if (configCache.eventFilters && configCache.eventFilters[actionType] === false) return false;
    return true;
}

/**
 * 立即播放本批中的专属铃（最新一条），不占用 TTS 调度锁
 * @returns {boolean} 是否实际触发了专属铃
 */
function fireTwitterExclusiveIfAny(triggers) {
    if (!Array.isArray(triggers) || triggers.length === 0) return false;
    const now = Date.now();
    let latestSrc = null;

    triggers.forEach(trigger => {
        if (!trigger || typeof trigger.id !== 'string') return;
        if (!isTwitterEventAllowed(trigger)) return;

        const twitterId = trigger.id.trim().toLowerCase();
        if (lastPlayTime.has(twitterId) && (now - lastPlayTime.get(twitterId) < 2500)) return;

        const rule = configCache.mappings[twitterId];
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;
        const src = resolveExclusiveAudioSrc(mappedAudioId);
        if (!src) return;

        lastPlayTime.set(twitterId, now);
        latestSrc = src;
    });

    if (!latestSrc) return false;
    console.log(`✅ [GMGN 盯盘伴侣 - 专属铃] ${String(latestSrc).split('/').pop()}`);
    playExclusiveAudio(latestSrc);
    return true;
}

/** 筛出需要走 TTS 通道的 triggers（排除已绑定专属铃的账号） */
function filterTwitterTtsTriggers(triggers) {
    if (!Array.isArray(triggers)) return [];
    return triggers.filter(trigger => {
        if (!trigger || typeof trigger.id !== 'string') return false;
        if (!isTwitterEventAllowed(trigger)) return false;

        const twitterId = trigger.id.trim().toLowerCase();
        const rule = configCache.mappings[twitterId];
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;

        if (mappedAudioId) {
            // 专属铃账号不进 TTS 通道
            if (resolveExclusiveAudioSrc(mappedAudioId)) return false;
            // 已配置规则但无专属音（备注/通用音）→ 受 playMappedGeneric 开关控制
            return configCache.playMappedGeneric !== false;
        }
        // 未配置规则
        return configCache.playDefaultUnmapped !== false;
    });
}

// ════════════════════════════════════════════════════════════
// 🔥 TTS 异步预热引擎 — 入队即预请求，播放时 IDB 直接命中
// ════════════════════════════════════════════════════════════

/** 🔥 异步预热 TTS 文本到 IDB 缓存（fire-and-forget，不播放） */
function prefetchTTSToCache(textOrItems, source = 'twitter') {
    const items = Array.isArray(textOrItems) ? textOrItems : [textOrItems];
    if (items.length === 0 || !items[0]) return;

    const ttsConfig = source === 'wallet' ? (configCache.walletTts || {}) : (configCache.twitterTts || {});
    const voice = ttsConfig.voice || 'zh-CN-XiaoxiaoNeural';
    const rate = ttsConfig.rate || '+0%';
    const pitch = ttsConfig.pitch || '+0%';

    // 并行预热所有片段（fire-and-forget，不阻塞主流程）
    Promise.all(items.map(async (text) => {
        try {
            const cacheKey = `${text}_${voice}_${rate}_${pitch}`;
            const cached = await idb.get(cacheKey);
            if (cached) return; // 已缓存，跳过
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(`${CF_TTS_API}/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice, rate, pitch }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!res.ok) return;
            const blob = await res.blob();
            await idb.set(cacheKey, blob);
            console.log(`🔥 [GMGN 盯盘伴侣 - 预热] TTS 缓存已预热: "${text}"`);
        } catch (e) {
            // 预热失败静默忽略，playNetworkTTS 会自行请求
        }
    })).catch(() => {});
}

/** 从推特 triggers 中提取去重后的博主名（优先 remark 备注名） */
function _extractTwitterNames(triggers) {
    const seen = new Set();
    const names = [];
    triggers.forEach(t => {
        if (!t || typeof t.id !== 'string') return;
        const twitterId = t.id.trim().toLowerCase();
        if (seen.has(twitterId)) return;
        seen.add(twitterId);
        const rule = configCache.mappings ? configCache.mappings[twitterId] : null;
        let name = t.name || twitterId;
        if (typeof rule === 'object' && rule !== null && rule.remark) {
            name = rule.remark;
        }
        names.push(name);
    });
    return names.sort(); // 🔤 排序确保 cacheKey 与到达顺序无关（A→B vs B→A 同 key）
}

/** 钱包播报：代币名最大字符数（默认 15，插件内可调） */
const DEFAULT_MAX_TOKEN_NAME_LEN = 15;

function getMaxTokenNameLen() {
    const raw = configCache.walletFilters && configCache.walletFilters.maxTokenNameLen;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKEN_NAME_LEN;
    // 允许 1–80，防止误填超大值
    return Math.min(80, Math.max(1, n));
}

/** 仅用于 TTS 念名；冷却/屏蔽等逻辑仍用完整代币名 */
function formatTokenNameForSpeech(name) {
    const s = String(name == null ? '' : name).trim() || '代币';
    const max = getMaxTokenNameLen();
    return s.length > max ? s.slice(0, max) : s;
}

/** 从钱包 items 中生成 TTS 预热文本（匹配 playWalletDirectly 的最终播报格式） */
function _buildWalletPrefetchTexts(items) {
    // 先去重
    const seen = new Set();
    const deduped = items.filter(t => {
        if (!t) return false;
        const key = `${t.rename}_${t.action}_${t.tokenSymbol}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    if (deduped.length === 0) return [];

    // 单笔：用分段格式（匹配 playWalletDirectly 单笔分支）
    if (deduped.length === 1) {
        const t = deduped[0];
        const sym = formatTokenNameForSpeech(t.tokenSymbol);
        if (t.action === 'buy') {
            return [`${t.rename}买入`, sym];
        } else {
            const isClearAll = t.ooc === 1;
            const actionText = isClearAll ? '清仓' : '减仓';
            if (t.cnt === 'processed') return [t.rename];
            if (t.cnt === 'confirm') return [`${actionText}${sym}`];
            return [`${t.rename}${actionText}`, sym];
        }
    }

    // 多笔：用合并格式（匹配 playWalletDirectly 多笔分支的 mergedTexts.join('，同时')）
    const groups = {};
    deduped.forEach(t => {
        const isClearAll = t.ooc === 1;
        let groupAction = t.action;
        let symbol = formatTokenNameForSpeech(t.tokenSymbol);
        if (t.action === 'sell') {
            if (t.cnt === 'processed') { groupAction = 'sellProcessed'; symbol = ''; }
            else { groupAction = isClearAll ? 'sellClear' : 'sellReduce'; }
        }
        const key = `${groupAction}_${symbol}`;
        if (!groups[key]) groups[key] = { groupAction, tokenSymbol: symbol, names: [] };
        if (!groups[key].names.includes(t.rename)) groups[key].names.push(t.rename);
    });

    const phrases = Object.values(groups).map(g => {
        const namesStr = g.names.sort().join('、'); // 🔤 排序确保 cacheKey 一致
        let actionStr = '买入';
        if (g.groupAction === 'sellProcessed') actionStr = '卖出';
        if (g.groupAction === 'sellReduce') actionStr = '减仓';
        if (g.groupAction === 'sellClear') actionStr = '清仓';
        return g.groupAction === 'sellProcessed'
            ? `${namesStr}${actionStr}`
            : `${namesStr}${actionStr}${g.tokenSymbol}`;
    });
    return [phrases.join('，同时')];
}

// ════════════════════════════════════════════════════════════
// 👑 首发 0 延时 + 动态批处理合并调度引擎 (Zero-Delay Dynamic Batching)
//    🔥 排队期间异步预热 TTS → 前面播完后 IDB 直接命中 → 0 延迟播放
//    🔒 凑够 3 个不同信号源锁定为一批 → 后续新来的进入新批次
// ════════════════════════════════════════════════════════════
const TwitterBatch = {
    lockedBatches: [],          // 已锁定的批次队列 [{triggers, fingerprints}]
    pendingTriggers: [],        // 未锁定的 pending triggers
    pendingFingerprints: new Set(),
    _pendingDeduped: new Set(), // 去重计数：不同 twitterId 数量

    add(triggers, fingerprint) {
        const now = Date.now();
        triggers.forEach(t => {
            if (t && typeof t.id === 'string') {
                t._queuedAt = now;
                this.pendingTriggers.push(t);
                this._pendingDeduped.add(t.id.trim().toLowerCase());
            }
        });
        if (fingerprint) this.pendingFingerprints.add(fingerprint);

        // 🔒 凑够 3 个不同博主 → 锁定为一批（可能一次 add 传入多个触发多次锁定）
        while (this._pendingDeduped.size >= 3) {
            this._lockCurrentBatch();
        }
        // 🔥 不管是否锁定，都预热当前 pending 的 TTS 文本
        this._prefetchCurrentPending();
    },

    /** 🔒 取前 3 个不同博主的 triggers 锁定为一批 */
    _lockCurrentBatch() {
        const batchIds = new Set();
        const batchTriggers = [];
        const remainingTriggers = [];

        this.pendingTriggers.forEach(t => {
            const twitterId = t.id.trim().toLowerCase();
            if (batchIds.size < 3 || batchIds.has(twitterId)) {
                batchIds.add(twitterId);
                batchTriggers.push(t);
            } else {
                remainingTriggers.push(t);
            }
        });

        // 🔥 预热锁定批次的最终合并 TTS（格式必须与 playTwitterDirectly 实际播放一致）
        const names = _extractTwitterNames(batchTriggers);
        if (names.length > 0) {
            prefetchTTSToCache(`${names.join('、')} 发推啦`, 'twitter');
        }

        this.lockedBatches.push({
            triggers: batchTriggers,
            fingerprints: new Set(this.pendingFingerprints),
        });

        // 剩余的留在 pending 继续积累
        this.pendingTriggers = remainingTriggers;
        this.pendingFingerprints.clear();
        this._pendingDeduped.clear();
        remainingTriggers.forEach(t => this._pendingDeduped.add(t.id.trim().toLowerCase()));
    },

    /** 🔥 预热当前未锁定 pending 的 TTS 文本 */
    _prefetchCurrentPending() {
        if (this.pendingTriggers.length === 0) return;
        const names = _extractTwitterNames(this.pendingTriggers);
        if (names.length === 0) return;
        // 统一格式为 " 发推啦"，与 playTwitterDirectly 的 VIP/unmapped TTS 路径一致
        const text = `${names.join('、')} 发推啦`;
        prefetchTTSToCache(text, 'twitter');
    },

    hasContent() {
        return this.lockedBatches.length > 0 || this.pendingTriggers.length > 0;
    },

    /** 取出下一批：优先锁定批次，其次未锁定 pending */
    takeNext() {
        if (this.lockedBatches.length > 0) return this.lockedBatches.shift();
        if (this.pendingTriggers.length > 0) {
            const batch = {
                triggers: [...this.pendingTriggers],
                fingerprints: new Set(this.pendingFingerprints),
            };
            this.clear();
            return batch;
        }
        return null;
    },

    clear() {
        this.pendingTriggers = [];
        this.pendingFingerprints.clear();
        this._pendingDeduped.clear();
    }
};

const WalletBatch = {
    lockedBatches: [],          // 已锁定的批次队列 [{items}]
    pendingItems: [],           // 未锁定的 pending items
    _pendingDeduped: new Set(), // 去重计数：不同 rename_action_tokenSymbol

    add(itemData) {
        if (itemData) {
            itemData._queuedAt = Date.now();
            this.pendingItems.push(itemData);
            this._pendingDeduped.add(`${itemData.rename}_${itemData.action}_${itemData.tokenSymbol}`);
        }

        // 🔒 凑够 3 个不同交易事件 → 锁定为一批
        while (this._pendingDeduped.size >= 3) {
            this._lockCurrentBatch();
        }
        // 🔥 预热当前 pending 的 TTS 文本
        this._prefetchCurrentPending();
    },

    /** 🔒 取前 3 个不同交易事件锁定为一批 */
    _lockCurrentBatch() {
        const batchKeys = new Set();
        const batchItems = [];
        const remainingItems = [];

        this.pendingItems.forEach(t => {
            const key = `${t.rename}_${t.action}_${t.tokenSymbol}`;
            if (batchKeys.size < 3 || batchKeys.has(key)) {
                batchKeys.add(key);
                batchItems.push(t);
            } else {
                remainingItems.push(t);
            }
        });

        // 🔥 预热锁定批次的最终 TTS
        const texts = _buildWalletPrefetchTexts(batchItems);
        prefetchTTSToCache(texts, 'wallet');

        this.lockedBatches.push({ items: batchItems });

        this.pendingItems = remainingItems;
        this._pendingDeduped.clear();
        remainingItems.forEach(t => this._pendingDeduped.add(`${t.rename}_${t.action}_${t.tokenSymbol}`));
    },

    /** 🔥 预热当前未锁定 pending 的 TTS 文本 */
    _prefetchCurrentPending() {
        if (this.pendingItems.length === 0) return;
        const texts = _buildWalletPrefetchTexts(this.pendingItems);
        prefetchTTSToCache(texts, 'wallet');
    },

    hasContent() {
        return this.lockedBatches.length > 0 || this.pendingItems.length > 0;
    },

    takeNext() {
        if (this.lockedBatches.length > 0) return this.lockedBatches.shift();
        if (this.pendingItems.length > 0) {
            const batch = { items: [...this.pendingItems] };
            this.clear();
            return batch;
        }
        return null;
    },

    clear() {
        this.pendingItems = [];
        this._pendingDeduped.clear();
    }
};

const DynamicPlaybackScheduler = {
    _isPlaying: false,
    _safetyTimer: null,

    /** 🛡️ 启动超时兜底计时器：防止 onComplete 因异常路径未被调用导致调度器永久卡死 */
    _startSafetyTimer() {
        if (this._safetyTimer) clearTimeout(this._safetyTimer);
        this._safetyTimerStart = Date.now();
        this._safetyTimer = setTimeout(() => {
            if (this._isPlaying) {
                const elapsed = Date.now() - (this._safetyTimerStart || 0);
                console.warn("⚠️ [GMGN 盯盘伴侣 - Scheduler] 检测到播放器超时卡死，强制释放", {
                    elapsed: `${(elapsed / 1000).toFixed(1)}s`,
                    ttsPlayer: !!ttsActivePlayer,
                    exclusivePlayer: !!exclusiveActivePlayer,
                    poolStatus: AudioPool.status(),
                    twitterBatchPending: TwitterBatch.hasContent(),
                    walletBatchPending: WalletBatch.hasContent()
                });
                this._isPlaying = false;
                this.releaseAndNext();
            }
        }, 15000);
    },

    /**
     * 推特：专属铃始终旁路立即播（不占 TTS 锁）；
     * 仅「需 TTS / 默认 ding」的账号进入调度器。
     */
    triggerTwitter(triggers, fingerprint) {
        // 🎧 专属铃旁路：即使 TTS 通道占线也立刻响，且不打断 TTS
        fireTwitterExclusiveIfAny(triggers);

        const ttsTriggers = filterTwitterTtsTriggers(triggers);
        if (ttsTriggers.length === 0) {
            // 纯专属铃或全部被过滤：不占用 TTS 调度锁
            if (fingerprint) markEventPlayed(fingerprint);
            return;
        }

        if (!this._isPlaying) {
            this._isPlaying = true;
            this._startSafetyTimer();
            playTwitterDirectly(ttsTriggers, fingerprint ? [fingerprint] : []);
        } else {
            console.log("⚡ [GMGN 盯盘伴侣 - Scheduler] TTS 通道占线，推特 TTS 进入 Batch（🔥 预热中）");
            TwitterBatch.add(ttsTriggers, fingerprint);
        }
    },

    /** 钱包消息走 TTS 通道（与推特 TTS 互斥排队，不打断专属铃） */
    triggerWallet(itemData) {
        if (!this._isPlaying) {
            this._isPlaying = true;
            this._startSafetyTimer();
            playWalletDirectly([itemData]);
        } else {
            console.log("⚡ [GMGN 盯盘伴侣 - Scheduler] TTS 通道占线，钱包事件进入 Batch（🔥 预热中）");
            WalletBatch.add(itemData);
        }
    },

    /** TTS 通道播完，解锁并调度下一批（专属铃不经过此锁） */
    releaseAndNext() {
        this._isPlaying = false;
        if (this._safetyTimer) {
            clearTimeout(this._safetyTimer);
            this._safetyTimer = null;
        }

        if (TwitterBatch.hasContent()) {
            this._isPlaying = true;
            this._startSafetyTimer();
            const batch = TwitterBatch.takeNext();
            // 批次出队时再补一次专属铃（截断放回的剩余账号）
            fireTwitterExclusiveIfAny(batch.triggers);
            const ttsTriggers = filterTwitterTtsTriggers(batch.triggers);
            if (ttsTriggers.length === 0) {
                this.releaseAndNext();
                return;
            }
            playTwitterDirectly(ttsTriggers, Array.from(batch.fingerprints || []));
        } else if (WalletBatch.hasContent()) {
            this._isPlaying = true;
            this._startSafetyTimer();
            const batch = WalletBatch.takeNext();
            playWalletDirectly(batch.items);
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

    // data: URI 和 blob: URL 不需要预热
    if (src.startsWith('data:') || src.startsWith('blob:')) {
        blobCache.set(src, src); // 直接缓存原始 URL
        return;
    }

    const doFetch = async () => {
        const res = await fetch(src);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        blobCache.set(src, blobUrl);
    };

    try {
        await doFetch();
    } catch (e) {
        // 首次失败静默：扩展初始化窗口期 fetch 可能暂时不可达，2 秒后重试一次
        console.debug("🔄 [GMGN 盯盘伴侣] 音频预热首次失败，2s 后重试:", src.split('/').pop());
        setTimeout(async () => {
            try {
                await doFetch();
                console.debug("✅ [GMGN 盯盘伴侣] 音频预热重试成功:", src.split('/').pop());
            } catch (retryErr) {
                blobCache.delete(src); // 重试仍失败，移除占位允许后续重试
                console.warn("⚠️ [GMGN 盯盘伴侣] 音频预热重试仍失败:", src.split('/').pop(), retryErr.message);
            }
        }, 2000);
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
const AUDIO_HEAD_FADE_SEC = 0.07;      // 起音淡入 ~70ms，通话 AEC 更稳
const AUDIO_TAIL_FADE_SEC = 0.065;     // 收尾淡出
const AUDIO_INTERRUPT_FADE_SEC = 0.018; // 打断短淡出 ~18ms
const AUDIO_SEGMENT_GAP_MS = 28;       // 多段 TTS 段间空隙，给 AEC 喘息
const AUDIO_RELEASE_GRACE_MS = 140;

/** 播放前尽量恢复被后台挂起的 AudioContext，减少 silent NotAllowed */
function ensureAudioContextRunning() {
    try {
        if (!sharedAudioCtx) {
            sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (sharedAudioCtx.state === 'suspended') {
            return sharedAudioCtx.resume().catch(() => {});
        }
    } catch (e) {
        /* ignore */
    }
    return Promise.resolve();
}

// ════════════════════════════════════════════════════════════
// 🔈 Offscreen 后台播报桥（单开/多开全后台时 Chrome 禁页内发声的兜底）
// ════════════════════════════════════════════════════════════

/** 页面是否在后台（优先走 Offscreen） */
function isPageBackgrounded() {
    try {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    } catch (e) {
        return false;
    }
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('blob_to_dataurl_failed'));
        reader.readAsDataURL(blob);
    });
}

/** 任意可播 URL → offscreen 可消费的 item */
async function toOffscreenItem(src) {
    if (!src) return null;
    if (typeof src === 'string' && src.startsWith('data:')) {
        return { kind: 'data', dataUrl: src };
    }
    // 扩展内置音：传相对路径，offscreen 内 getURL（避免跨上下文权限问题）
    if (typeof src === 'string' && src.includes('/sounds/')) {
        const m = src.match(/sounds\/[^?#]+/i);
        if (m) return { kind: 'extension', path: m[0].replace(/\\/g, '/') };
    }
    if (typeof src === 'string' && (src.startsWith('chrome-extension://') || src.startsWith('blob:') || src.startsWith('http'))) {
        try {
            const res = await fetch(src);
            const blob = await res.blob();
            const dataUrl = await blobToDataUrl(blob);
            return { kind: 'data', dataUrl };
        } catch (e) {
            console.warn('[GMGN 盯盘伴侣] toOffscreenItem 转换失败:', e);
            return null;
        }
    }
    // 相对路径 sounds/xxx
    if (typeof src === 'string' && src.startsWith('sounds/')) {
        return { kind: 'extension', path: src };
    }
    return null;
}

/**
 * 请求 Service Worker → Offscreen 播放
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function requestOffscreenPlay(channel, items, volume) {
    return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            resolve({ ok: false, error: 'no_runtime' });
            return;
        }
        try {
            chrome.runtime.sendMessage(
                {
                    type: 'OFFSCREEN_PLAY',
                    channel: channel === 'exclusive' ? 'exclusive' : 'tts',
                    items,
                    volume
                },
                (resp) => {
                    if (chrome.runtime.lastError) {
                        resolve({ ok: false, error: chrome.runtime.lastError.message });
                        return;
                    }
                    resolve(resp || { ok: false, error: 'no_response' });
                }
            );
        } catch (e) {
            resolve({ ok: false, error: String(e && e.message ? e.message : e) });
        }
    });
}

function requestOffscreenWarmup() {
    return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            resolve({ ok: false });
            return;
        }
        try {
            chrome.runtime.sendMessage({ type: 'OFFSCREEN_WARMUP' }, (resp) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                resolve(resp || { ok: false });
            });
        } catch (e) {
            resolve({ ok: false });
        }
    });
}

/**
 * 通过 Offscreen 播放（TTS 多段 / 单文件）
 * @param {'exclusive'|'tts'} channel
 * @param {Array|string} itemsOrSrc
 * @param {number} volume
 * @param {Function|null} onComplete
 */
async function playViaOffscreen(channel, itemsOrSrc, volume, onComplete) {
    try {
        let items = Array.isArray(itemsOrSrc) ? itemsOrSrc : [itemsOrSrc];
        // 统一转 offscreen item
        const resolved = [];
        for (const it of items) {
            if (it && typeof it === 'object' && (it.kind === 'data' || it.kind === 'extension')) {
                resolved.push(it);
                continue;
            }
            if (it instanceof Blob) {
                resolved.push({ kind: 'data', dataUrl: await blobToDataUrl(it) });
                continue;
            }
            const item = await toOffscreenItem(it);
            if (item) resolved.push(item);
        }
        if (resolved.length === 0) {
            console.warn('⚠️ [GMGN 盯盘伴侣] Offscreen 无有效音源');
            if (onComplete) onComplete();
            return false;
        }
        console.log(`🔈 [GMGN 盯盘伴侣] Offscreen 播报 | channel=${channel} segments=${resolved.length}`);
        const resp = await requestOffscreenPlay(channel, resolved, volume);
        if (!resp || !resp.ok) {
            console.warn('⚠️ [GMGN 盯盘伴侣] Offscreen 播放失败:', resp && resp.error);
            if (onComplete) onComplete();
            return false;
        }
        if (onComplete) onComplete();
        return true;
    } catch (e) {
        console.warn('⚠️ [GMGN 盯盘伴侣] Offscreen 异常:', e);
        if (onComplete) onComplete();
        return false;
    }
}

/**
 * 设置播放增益；默认 70ms 淡入，避免硬起振触发音响回声消除 pop
 * @param {HTMLAudioElement} audio
 * @param {number} volume
 * @param {{ fadeIn?: boolean, fadeSec?: number }} [options]
 */
function applyGainToAudio(audio, volume, options = {}) {
    const fadeIn = options.fadeIn !== false;
    const fadeSec = options.fadeSec !== undefined ? options.fadeSec : AUDIO_HEAD_FADE_SEC;
    const safeVol = Math.max(0.0001, volume);

    // 已绑定 GainNode 的池 Audio：统一通过 GainNode 控制音量（createMediaElementSource 不可逆）
    if (audio.__gainNode) {
        if (sharedAudioCtx) {
            const now = sharedAudioCtx.currentTime;
            audio.__gainNode.gain.cancelScheduledValues(now);
            if (fadeIn && fadeSec > 0) {
                audio.__gainNode.gain.setValueAtTime(0.0001, now);
                audio.__gainNode.gain.linearRampToValueAtTime(safeVol, now + fadeSec);
            } else {
                audio.__gainNode.gain.setValueAtTime(safeVol, now);
            }
        } else {
            audio.__gainNode.gain.value = safeVol;
        }
        audio.volume = 1.0;
        return;
    }

    const isSafe = audio.crossOrigin === "anonymous" ||
                  (audio.src && (audio.src.startsWith('blob:') || audio.src.startsWith('data:')));

    // 未解锁或非安全源无法走 Web Audio，降级为原生音量。
    if (!_autoplayUnlocked || !isSafe) {
        audio.volume = Math.max(0, Math.min(volume, 1.0));
        return;
    }

    audio.volume = 1.0;

    try {
        if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();

        // 首次绑定（永久），后续复用时直走上方 __gainNode 分支
        if (!audio.__sourceNode) {
            audio.__sourceNode = sharedAudioCtx.createMediaElementSource(audio);
            audio.__gainNode = sharedAudioCtx.createGain();
            // 新建时先静音，避免绑定瞬间泄漏声
            audio.__gainNode.gain.value = 0.0001;
            audio.__sourceNode.connect(audio.__gainNode);
            audio.__gainNode.connect(sharedAudioCtx.destination);
        }
        const now = sharedAudioCtx.currentTime;
        audio.__gainNode.gain.cancelScheduledValues(now);
        if (fadeIn && fadeSec > 0) {
            audio.__gainNode.gain.setValueAtTime(0.0001, now);
            audio.__gainNode.gain.linearRampToValueAtTime(safeVol, now + fadeSec);
        } else {
            audio.__gainNode.gain.setValueAtTime(safeVol, now);
        }
    } catch (e) {
        console.warn("[GMGN 盯盘伴侣] 超级音量增益失败，降级为 100% 音量:", e);
    }
}

/** 瞬时静音（段切换/强制归零） */
function muteGainInstant(audio) {
    if (!audio || !audio.__gainNode || !sharedAudioCtx) return;
    try {
        const now = sharedAudioCtx.currentTime;
        audio.__gainNode.gain.cancelScheduledValues(now);
        audio.__gainNode.gain.setValueAtTime(0.0001, now);
    } catch (e) { /* ignore */ }
}

/** 短淡出（打断用），从当前增益 ramp 到近 0 */
function fadeOutGain(audio, fadeSec = AUDIO_INTERRUPT_FADE_SEC) {
    if (!audio || !audio.__gainNode || !sharedAudioCtx) {
        muteGainInstant(audio);
        return;
    }
    try {
        const now = sharedAudioCtx.currentTime;
        const g = audio.__gainNode.gain;
        const cur = Math.max(g.value || 0.0001, 0.0001);
        g.cancelScheduledValues(now);
        g.setValueAtTime(cur, now);
        g.linearRampToValueAtTime(0.0001, now + Math.max(fadeSec, 0.001));
    } catch (e) {
        muteGainInstant(audio);
    }
}

/**
 * play() 成功后，等一帧再淡入，减少「已出声但 gain 调度未挂上」的竞态 pop
 */
function fadeInAfterPlay(audio, volume, onReady) {
    const run = () => {
        if (!audio) return;
        applyGainToAudio(audio, volume, { fadeIn: true });
        if (typeof onReady === 'function') onReady();
    };
    // 双 rAF：对齐到浏览器绘制/音频渲染边界
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
        setTimeout(run, 16);
    }
}

function clearAudioTailFade(audio) {
    if (audio && audio.__tailFadeTimer) {
        clearTimeout(audio.__tailFadeTimer);
        audio.__tailFadeTimer = null;
    }
}

function scheduleAudioTailFade(audio, volume, fadeSec = AUDIO_TAIL_FADE_SEC) {
    clearAudioTailFade(audio);
    if (!audio || !audio.__gainNode || !sharedAudioCtx) return;

    const schedule = () => {
        if (!audio.__gainNode || !sharedAudioCtx) return;
        if (!Number.isFinite(audio.duration) || audio.duration <= fadeSec) return;

        const delayMs = Math.max(0, (audio.duration - audio.currentTime - fadeSec) * 1000);
        audio.__tailFadeTimer = setTimeout(() => {
            if (!audio.__gainNode || !sharedAudioCtx || audio.paused || audio.ended) return;
            const now = sharedAudioCtx.currentTime;
            audio.__gainNode.gain.cancelScheduledValues(now);
            audio.__gainNode.gain.setValueAtTime(volume, now);
            audio.__gainNode.gain.linearRampToValueAtTime(0.0001, now + fadeSec);
        }, delayMs);
    };

    if (Number.isFinite(audio.duration) && audio.duration > 0) {
        schedule();
    } else {
        audio.addEventListener('loadedmetadata', schedule, { once: true });
    }
}

function releaseAudioAfterQuietTail(audio, callback) {
    clearAudioTailFade(audio);
    setTimeout(callback, AUDIO_RELEASE_GRACE_MS);
}



audioSyncChannel.onmessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // 👑 Leader Election 消息分发
    TabLeader.handleMessage(data);

    // 🔒 指纹去重（兜底安全网）
    if (data.type === 'EVENT_PLAYED') {
        otherTabPlayedEvents.set(data.key, Date.now());
    }
};

// 👑 启动 Leader 选举（必须在 onmessage 注册之后）
TabLeader.init();

// 🌟 优化：仅在真正的休眠恢复时重新初始化（避免标签页切换时的性能浪费）
let lastVisibilityState = document.visibilityState;
let lastVisibilityChangeTime = Date.now();

document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    const hiddenDuration = now - lastVisibilityChangeTime;

    // 👁️ 前台/后台切换：立即调整 Leader 归属（不依赖 5 分钟休眠逻辑）
    if (document.visibilityState === 'hidden') {
        try { TabLeader.onVisibilityHidden(); } catch (e) { /* ignore */ }
    } else if (document.visibilityState === 'visible') {
        try {
            // 回到前台时尝试恢复 AudioContext（后台常被浏览器挂起）
            if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
                sharedAudioCtx.resume().catch(() => {});
            }
            TabLeader.onVisibilityVisible();
        } catch (e) { /* ignore */ }
    }

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
            if (!data || typeof data !== 'object') return;
            // 👑 Leader Election 消息分发
            TabLeader.handleMessage(data);
            // 🔒 指纹去重（兜底安全网）
            if (data.type === 'EVENT_PLAYED') {
                otherTabPlayedEvents.set(data.key, Date.now());
            }
        };

        // 👑 休眠恢复后重新发起 Leader 竞选（先清理旧定时器，再重置状态）
        TabLeader.destroy();
        TabLeader._leaderId = null;
        TabLeader._initialized = false;
        TabLeader.init();
        try {
            chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'enableTwitter', 'enableWallet', 'globalVolume', 'twitterVolume', 'walletVolume', 'eventFilters', 'playDefaultUnmapped', 'playMappedGeneric', 'enableTTS', 'twitterTts', 'walletTts', 'walletFilters', 'walletDictionary', 'blockedWsChannels'], async (result) => {
                if (chrome.runtime.lastError) return;
            if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
            configCache.defaultAudio = result.defaultAudio || 'sounds/default.MP3';
            if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled !== false;
            if (result.enableTwitter !== undefined) configCache.enableTwitter = result.enableTwitter !== false;
            if (result.enableWallet !== undefined) configCache.enableWallet = result.enableWallet !== false;
            if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;
            if (result.twitterVolume !== undefined) configCache.twitterVolume = result.twitterVolume;
            if (result.walletVolume !== undefined) configCache.walletVolume = result.walletVolume;
            if (result.eventFilters) configCache.eventFilters = result.eventFilters;
            if (result.playDefaultUnmapped !== undefined) configCache.playDefaultUnmapped = result.playDefaultUnmapped !== false;
            if (result.playMappedGeneric !== undefined) configCache.playMappedGeneric = result.playMappedGeneric !== false;
            if (result.enableTTS !== undefined) configCache.enableTTS = result.enableTTS !== false;
            if (result.twitterTts) configCache.twitterTts = normalizeTtsConfig(result.twitterTts);
            if (result.walletTts) configCache.walletTts = normalizeTtsConfig(result.walletTts);
            if (result.walletFilters) configCache.walletFilters = result.walletFilters;
            if (result.walletDictionary) configCache.walletDictionary = result.walletDictionary;
            if (Array.isArray(result.blockedWsChannels)) configCache.blockedWsChannels = result.blockedWsChannels;
            syncChannelToggles();

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
            syncWsBlocklist();
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
    syncChannelToggles();
}

/** 向 inject.js 广播 WSS 频道黑名单（页面 MAIN world 拦截 subscribe） */
function syncWsBlocklist() {
    const channels = Array.isArray(configCache.blockedWsChannels) ? configCache.blockedWsChannels : [];
    window.dispatchEvent(new CustomEvent('GMGN_WS_BLOCKLIST', { detail: { channels } }));
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

chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'defaultAudio', 'isMasterEnabled', 'enableTwitter', 'enableWallet', 'globalVolume', 'twitterVolume', 'walletVolume', 'eventFilters', 'playDefaultUnmapped', 'playMappedGeneric', 'enableTTS', 'ttsVoice', 'ttsRate', 'ttsPitch', 'twitterTts', 'walletTts', 'walletFilters', 'walletDictionary', 'blockedWsChannels'], async (result) => { // 🌟 数组加了高级定制选项+旧版字段用于迁移
    if (result.twitterAudioMappings) configCache.mappings = result.twitterAudioMappings;
    if (result.defaultAudio) configCache.defaultAudio = result.defaultAudio;
    if (!configCache.defaultAudio) configCache.defaultAudio = 'sounds/default.MP3';
    // 布尔开关：统一用 !== false，避免 false 被错误当成未设置
    if (result.isMasterEnabled !== undefined) configCache.isMasterEnabled = result.isMasterEnabled !== false;
    if (result.enableTwitter !== undefined) configCache.enableTwitter = result.enableTwitter !== false;
    if (result.enableWallet !== undefined) configCache.enableWallet = result.enableWallet !== false;
    if (result.globalVolume !== undefined) configCache.globalVolume = result.globalVolume;
    if (result.twitterVolume !== undefined) configCache.twitterVolume = result.twitterVolume;
    if (result.walletVolume !== undefined) configCache.walletVolume = result.walletVolume;
    if (Array.isArray(result.blockedWsChannels)) configCache.blockedWsChannels = result.blockedWsChannels;
    else configCache.blockedWsChannels = [];

    if (result.eventFilters) configCache.eventFilters = result.eventFilters;
    if (!configCache.eventFilters) configCache.eventFilters = { tweet: true, repost: true, reply: true, quote: true, other: true };
    if (configCache.eventFilters.other === undefined) configCache.eventFilters.other = true;

    // 🌟 赋值缓存
    if (result.playDefaultUnmapped !== undefined) configCache.playDefaultUnmapped = result.playDefaultUnmapped !== false;
    if (result.playMappedGeneric !== undefined) configCache.playMappedGeneric = result.playMappedGeneric !== false;
    else configCache.playMappedGeneric = true;
    if (result.enableTTS !== undefined) configCache.enableTTS = result.enableTTS !== false;
    configCache.twitterTts = normalizeTtsConfig(result.twitterTts, result);
    configCache.walletTts = normalizeTtsConfig(result.walletTts, result);
    if (result.walletFilters) configCache.walletFilters = result.walletFilters;
    if (result.walletDictionary) configCache.walletDictionary = result.walletDictionary;

    // ════════════════════════════════════════════════════════════
    // 🔄 一次性存储迁移（旧版 → 新版），迁移完成后回写并清除旧字段
    // ════════════════════════════════════════════════════════════
    const migrationWrites = {};  // 需要写入的新字段
    const migrationDeletes = []; // 需要清除的旧字段

    // 1️⃣ TTS 配置迁移：旧版 ttsVoice/ttsRate/ttsPitch → 新版 twitterTts/walletTts（语速强制闪电）
    if (!result.twitterTts && (result.ttsVoice || result.ttsRate || result.ttsPitch)) {
        const migrated = normalizeTtsConfig(null, result);
        configCache.twitterTts = migrated;
        configCache.walletTts = { ...migrated };
        migrationWrites.twitterTts = migrated;
        migrationWrites.walletTts = { ...migrated };
        migrationDeletes.push('ttsVoice', 'ttsRate', 'ttsPitch');
        console.log("🔄 [GMGN 盯盘伴侣 - 迁移] TTS 配置已从旧版迁移:", migrated);
    } else {
        // 强制语速闪电：旧档位一律废弃
        const tNorm = normalizeTtsConfig(result.twitterTts, result);
        const wNorm = normalizeTtsConfig(result.walletTts, result);
        if (!result.twitterTts || (result.twitterTts && result.twitterTts.rate !== TTS_RATE_LIGHTNING)) {
            migrationWrites.twitterTts = tNorm;
            configCache.twitterTts = tNorm;
        }
        if (!result.walletTts || (result.walletTts && result.walletTts.rate !== TTS_RATE_LIGHTNING)) {
            migrationWrites.walletTts = wNorm;
            configCache.walletTts = wNorm;
        }
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

    syncChannelToggles();
    syncWsBlocklist();
    isCacheReady = true;

    console.log("⚙️ [GMGN 盯盘伴侣] 配置加载完成:", {
        mappingCount: Object.keys(configCache.mappings).length,
        customAudioCount: Object.keys(configCache.customAudios).length,
        isMasterEnabled: configCache.isMasterEnabled,
        playDefaultUnmapped: configCache.playDefaultUnmapped,
        blockedWsChannels: (configCache.blockedWsChannels || []).length
    });

    if (pendingWsMessages.length > 0) {
        const queued = pendingWsMessages.slice();
        pendingWsMessages = [];
        // 配置就绪后重放排队事件（须调用现有 handleTwitterMsg，勿引用已删除的 processTwitterMessage）
        queued.forEach((pendingE) => {
            try {
                handleTwitterMsg(pendingE);
            } catch (e) {
                console.warn('⚠️ [GMGN 盯盘伴侣] 重放排队推特消息失败:', e);
            }
        });
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
        // ⚠️ 布尔开关必须用 `key in changes`，不能靠 if(changes.x)（对象恒真，但写法易踩坑）
        let channelToggleChanged = false;
        if ('isMasterEnabled' in changes) {
            configCache.isMasterEnabled = changes.isMasterEnabled.newValue !== false;
            channelToggleChanged = true;
        }
        if ('enableTwitter' in changes) {
            configCache.enableTwitter = changes.enableTwitter.newValue !== false;
            channelToggleChanged = true;
            console.log('🎚️ [GMGN 盯盘伴侣] enableTwitter →', configCache.enableTwitter);
        }
        if ('enableWallet' in changes) {
            configCache.enableWallet = changes.enableWallet.newValue !== false;
            channelToggleChanged = true;
            console.log('🎚️ [GMGN 盯盘伴侣] enableWallet →', configCache.enableWallet);
        }
        if (channelToggleChanged) syncChannelToggles();

        if (changes.blockedWsChannels) {
            configCache.blockedWsChannels = Array.isArray(changes.blockedWsChannels.newValue)
                ? changes.blockedWsChannels.newValue
                : [];
            syncWsBlocklist();
        }
        // 🌟 监听开关变动更新缓存
        if ('playDefaultUnmapped' in changes) {
            configCache.playDefaultUnmapped = changes.playDefaultUnmapped.newValue !== false;
        }
        if ('playMappedGeneric' in changes) {
            configCache.playMappedGeneric = changes.playMappedGeneric.newValue !== false;
        }
        if ('enableTTS' in changes) {
            configCache.enableTTS = changes.enableTTS.newValue !== false;
        }
        if (changes.twitterTts) configCache.twitterTts = normalizeTtsConfig(changes.twitterTts.newValue);
        if (changes.walletTts) configCache.walletTts = normalizeTtsConfig(changes.walletTts.newValue);
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

// 🎤 云端 TTS 极速播放引擎 (AudioPool 池化版 + 双层缓存) — 仅占用 TtsChannel
// 后台页 / 页内 NotAllowed → 自动降级 Offscreen 播报
async function playNetworkTTS(textItems, source = 'twitter', onComplete = null) {
    const items = Array.isArray(textItems) ? textItems : [textItems];
    if (items.length === 0 || !items[0]) {
        if (onComplete) onComplete();
        return;
    }
    await ensureAudioContextRunning();
    console.log(`🔊 [GMGN 盯盘伴侣 - TTS (${source})] 准备播报:`, items.join(' → '), {
        background: isPageBackgrounded()
    });

    const ttsConfig = source === 'wallet' ? (configCache.walletTts || {}) : (configCache.twitterTts || {});
    const voice = ttsConfig.voice || 'zh-CN-XiaoxiaoNeural';
    const rate = ttsConfig.rate || '+0%';
    const pitch = ttsConfig.pitch || '+0%';

    const defaultVol = configCache.globalVolume !== undefined ? configCache.globalVolume : 1;
    const targetVolume = source === 'wallet'
        ? (configCache.walletVolume !== undefined ? configCache.walletVolume : defaultVol)
        : (configCache.twitterVolume !== undefined ? configCache.twitterVolume : defaultVol);
    const ttsVol = Math.min(targetVolume * 1.2, 1.5);

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
        const blobs = await Promise.all(
            items.map(item => fetchAudioBlob(item).catch(() => null))
        );
        validBlobs = blobs.filter(b => b !== null);
        if (validBlobs.length === 0) throw new Error('所有 TTS 段获取失败');
    } catch (error) {
        console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] CF TTS 失败，降级到默认提示音:", error.message || error);
        const fallbackAudio = source === 'wallet' ? 'sounds/preset1.MP3' : (configCache.defaultAudio || 'sounds/default.MP3');
        playChannelAudio(chrome.runtime.getURL(fallbackAudio), 'tts', source, null, onComplete);
        return;
    }

    // 🌙 后台：直接 Offscreen（页内几乎必被 Chrome 禁声）
    if (isPageBackgrounded()) {
        await playViaOffscreen('tts', validBlobs, ttsVol, onComplete);
        return;
    }

    // 仅打断页内 TTS 通道，不影响专属铃
    interruptTtsAudio();

    const playLocalTts = () => {
        AudioPool.play((player) => {
            setChannelActivePlayer('tts', player);
            player.crossOrigin = "anonymous";

            let blobUrls = [];
            player.__blobUrls = blobUrls;
            const isTtsOwner = () => getChannelActivePlayer('tts') === player;

            const playSegment = (idx) => {
                if (!isTtsOwner()) {
                    blobUrls.forEach(u => URL.revokeObjectURL(u));
                    return;
                }

                if (idx >= validBlobs.length) {
                    blobUrls.forEach(u => URL.revokeObjectURL(u));
                    player.__blobUrls = null;
                    if (isTtsOwner()) setChannelActivePlayer('tts', null);
                    releaseAudioAfterQuietTail(player, () => {
                        AudioPool.release(player);
                        if (onComplete) onComplete();
                    });
                    return;
                }

                const url = URL.createObjectURL(validBlobs[idx]);
                blobUrls.push(url);
                player.src = url;
                applyGainToAudio(player, 0.0001, { fadeIn: false });

                player.onended = () => {
                    if (!isTtsOwner()) {
                        blobUrls.forEach(u => URL.revokeObjectURL(u));
                        return;
                    }
                    muteGainInstant(player);
                    const nextIdx = idx + 1;
                    if (nextIdx >= validBlobs.length) {
                        playSegment(nextIdx);
                        return;
                    }
                    setTimeout(() => {
                        if (isTtsOwner()) playSegment(nextIdx);
                    }, AUDIO_SEGMENT_GAP_MS);
                };

                player.onerror = () => {
                    blobUrls.forEach(u => URL.revokeObjectURL(u));
                    player.__blobUrls = null;
                    const isOwner = isTtsOwner();
                    if (isOwner) setChannelActivePlayer('tts', null);
                    AudioPool.release(player);
                    if (isOwner && onComplete) onComplete();
                };

                player.play().then(() => {
                    if (!isTtsOwner()) return;
                    fadeInAfterPlay(player, ttsVol, () => {
                        if (isTtsOwner()) scheduleAudioTailFade(player, ttsVol);
                    });
                }).catch(async (e) => {
                    blobUrls.forEach(u => URL.revokeObjectURL(u));
                    player.__blobUrls = null;
                    const isOwner = isTtsOwner();
                    if (isOwner) setChannelActivePlayer('tts', null);
                    try { AudioPool.release(player); } catch (err) { /* ignore */ }

                    if (e.name === 'NotAllowedError') {
                        console.warn('🔇 [GMGN 盯盘伴侣 - TTS] 页内 NotAllowed → Offscreen 兜底');
                        // 不再因 NotAllowed 弃权：Offscreen 可继续由本 Leader 驱动调度
                        await playViaOffscreen('tts', validBlobs, ttsVol, onComplete);
                        return;
                    }
                    console.warn("⚠️ [GMGN 盯盘伴侣 - TTS] 播放段失败:", e.name);
                    if (isOwner && onComplete) onComplete();
                });
            };

            playSegment(0);
        });
    };

    playLocalTts();
}

/**
 * 按通道播放文件音频
 * @param {'exclusive'|'tts'} channel
 */
function playChannelAudio(src, channel = 'tts', source = 'twitter', ttsFallbackText = null, onComplete = null) {
    if (!src) {
        if (onComplete) onComplete();
        return;
    }
    ensureAudioContextRunning();
    const defaultVol = configCache.globalVolume !== undefined ? configCache.globalVolume : 1;
    const targetVolume = source === 'wallet'
        ? (configCache.walletVolume !== undefined ? configCache.walletVolume : defaultVol)
        : (configCache.twitterVolume !== undefined ? configCache.twitterVolume : defaultVol);

    const playUrl = blobCache.get(src) || src;
    const finalUrl = playUrl || src;
    const offChannel = channel === 'exclusive' ? 'exclusive' : 'tts';

    // 🌙 后台：直接 Offscreen
    if (isPageBackgrounded()) {
        playViaOffscreen(offChannel, finalUrl, targetVolume, onComplete);
        return;
    }

    if (channel === 'exclusive') interruptExclusiveAudio();
    else interruptTtsAudio();

    AudioPool.play((player) => {
        setChannelActivePlayer(channel, player);

        if (finalUrl.startsWith('blob:') || finalUrl.startsWith('data:')) {
            player.crossOrigin = "anonymous";
        } else {
            player.crossOrigin = null;
        }

        player.src = finalUrl;
        applyGainToAudio(player, 0.0001, { fadeIn: false });

        const isOwner = () => getChannelActivePlayer(channel) === player;

        player.onended = () => {
            const owner = isOwner();
            if (owner) setChannelActivePlayer(channel, null);
            releaseAudioAfterQuietTail(player, () => {
                AudioPool.release(player);
                if (owner && onComplete) onComplete();
            });
        };

        player.onerror = (e) => {
            console.warn("⚠️ [GMGN 盯盘伴侣] 音频播放错误:", e);
            const owner = isOwner();
            if (owner) setChannelActivePlayer(channel, null);
            AudioPool.release(player);
            if (!owner) return;
            if (ttsFallbackText) {
                playNetworkTTS(ttsFallbackText, source, onComplete);
            } else if (onComplete) {
                onComplete();
            }
        };

        player.play().then(() => {
            if (!isOwner()) return;
            fadeInAfterPlay(player, targetVolume, () => {
                if (isOwner()) scheduleAudioTailFade(player, targetVolume);
            });
        }).catch((e) => {
            const owner = isOwner();
            if (owner) setChannelActivePlayer(channel, null);
            try { AudioPool.release(player); } catch (err) { /* ignore */ }

            if (e.name === 'NotAllowedError') {
                console.warn('🔇 [GMGN 盯盘伴侣] 页内 NotAllowed → Offscreen 兜底', { channel });
                playViaOffscreen(offChannel, finalUrl, targetVolume, (ttsFallbackText && onComplete)
                    ? () => {
                        // 文件 offscreen 结束后若仍需 TTS 兜底（极少）
                        if (onComplete) onComplete();
                    }
                    : onComplete);
                return;
            }
            console.error("❌ [GMGN 盯盘伴侣] 音频播放失败:", { error: e.name, message: e.message });
            if (!owner) return;
            if (ttsFallbackText) {
                playNetworkTTS(ttsFallbackText, source, onComplete);
            } else if (onComplete) {
                onComplete();
            }
        });
    });

    if (!blobCache.has(src)) {
        warmupAudio(src);
    }
}

/** 专属铃通道：不驱动 TTS 调度器 onComplete */
function playExclusiveAudio(src) {
    playChannelAudio(src, 'exclusive', 'twitter', null, null);
}

/** 兼容旧调用：默认走 TTS 通道（default ding / 降级音） */
function playConcurrentAudio(src, source = 'twitter', ttsFallbackText = null, onComplete = null) {
    playChannelAudio(src, 'tts', source, ttsFallbackText, onComplete);
}

/**
 * TTS 通道推特播报（入参应为 filterTwitterTtsTriggers 之后的列表）
 * 专属铃已在 triggerTwitter / releaseAndNext 旁路触发，此处只负责念名或 default ding
 */
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

    // 👑 1. TTL 过滤
    const validTriggers = triggers.filter(t => (now - (t._queuedAt || now)) < 15000);
    if (validTriggers.length === 0) {
        onComplete();
        return;
    }

    // 👑 2. 同博主去重
    const seenTwitterIds = new Set();
    const dedupedTriggers = validTriggers.filter(t => {
        if (!t || typeof t.id !== 'string') return false;
        const twitterId = t.id.trim().toLowerCase();
        if (seenTwitterIds.has(twitterId)) return false;
        seenTwitterIds.add(twitterId);
        return true;
    });
    if (dedupedTriggers.length < validTriggers.length) {
        console.log(`🔄 [GMGN 盯盘伴侣] 同博主去重：${validTriggers.length} 条 → ${dedupedTriggers.length} 条（${validTriggers.length - dedupedTriggers.length} 条重复已合并）`);
    }

    // 👑 3. 超载截断分批：>5 放回 Batch
    const TWITTER_MAX_BATCH = 5;
    let currentTriggers = dedupedTriggers;
    if (dedupedTriggers.length > TWITTER_MAX_BATCH) {
        currentTriggers = dedupedTriggers.slice(0, TWITTER_MAX_BATCH);
        const remaining = dedupedTriggers.slice(TWITTER_MAX_BATCH);
        console.log(`✂️ [GMGN 盯盘伴侣] 推特截断分批：本轮 ${currentTriggers.length} 条，剩余 ${remaining.length} 条放回队列`);
        TwitterBatch.add(remaining, null);
    }

    // 收集 TTS 人名 / 关 TTS 时的 default ding
    const ttsNames = [];
    let needsDefaultDing = false;

    currentTriggers.forEach(trigger => {
        if (!trigger || typeof trigger.id !== 'string') return;
        if (!isTwitterEventAllowed(trigger)) return;

        const twitterId = trigger.id.trim().toLowerCase();
        if (lastPlayTime.has(twitterId) && (now - lastPlayTime.get(twitterId) < 2500)) return;
        lastPlayTime.set(twitterId, now);

        const rule = configCache.mappings[twitterId];
        const mappedAudioId = (typeof rule === 'object' && rule !== null) ? rule.id : rule;
        // 双保险：专属铃账号不应进入此函数，若误入则跳过（铃已旁路播放）
        if (resolveExclusiveAudioSrc(mappedAudioId)) return;

        const speakerName = getTwitterSpeakerName(trigger, rule);

        if (configCache.enableTTS !== false) {
            if (!ttsNames.includes(speakerName)) ttsNames.push(speakerName);
        } else {
            // 关 TTS：未配置 / 通用音 / 丢失自定义 → 播 default.MP3
            needsDefaultDing = true;
        }
    });

    fingerprints.forEach(fp => markEventPlayed(fp));

    try {
        globalLastPlayTime = now;

        // 超载概括：>3 位不同博主 → 合并念「一起发推啦」（专属铃已在旁路响过最新 1 个）
        if (ttsNames.length > 3) {
            const overloadText = `${ttsNames.sort().join('、')}一起发推啦`;
            console.warn(`🚨 [GMGN 盯盘伴侣] 推特 TTS 超载 (${ttsNames.length} 人)，概括播报: "${overloadText}"`);
            playNetworkTTS(overloadText, 'twitter', onComplete);
            return;
        }

        if (ttsNames.length > 0) {
            const mergedNames = ttsNames.sort().join('、');
            console.log(`✅ [GMGN 盯盘伴侣 - 已播报] 推特 TTS: "${mergedNames} 发推啦"`);
            playNetworkTTS(`${mergedNames} 发推啦`, 'twitter', onComplete);
            return;
        }

        if (needsDefaultDing) {
            console.log(`✅ [GMGN 盯盘伴侣 - 已播报] 推特 default ding（TTS 已关）`);
            playChannelAudio(
                chrome.runtime.getURL(configCache.defaultAudio || 'sounds/default.MP3'),
                'tts',
                'twitter',
                null,
                onComplete
            );
            return;
        }

        console.log(`⏭️ [GMGN 盯盘伴侣 - 跳过] 推特 TTS 通道无发声项，释放调度器`);
        onComplete();
    } catch (error) {
        console.error("[GMGN 盯盘伴侣] 推特 TTS 播放异常:", error);
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

    // 👑 多 Tab 单例保护：只有 Leader Tab 执行播报（放在 isCacheReady 之后，确保配置已就绪）
    if (!TabLeader.isLeader()) return;

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
        if (ctx.state === 'suspended') ctx.resume(); // 🛡️ 防止 suspended 状态静默失败
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const vol = source === 'wallet' ? (configCache.walletVolume || 1.0) : (configCache.twitterVolume || 1.0);
        const now = ctx.currentTime;
        const peak = 0.3 * Math.min(vol, 1.5);
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), now + 0.01);
        gain.gain.setValueAtTime(Math.max(peak, 0.0001), now + 0.055);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.085);
    } catch (e) {
        console.warn('🔔 [GMGN 盯盘伴侣] beep 播放失败:', e);
    }
}

function playWalletDirectly(list) {
    const onComplete = () => DynamicPlaybackScheduler.releaseAndNext();
    const now = Date.now();

    // 🔒 二次校验：调度器排队期间，其他 Tab 可能已经播放了此事件
    const dedupedList = list.filter(item => !item.walletFingerprint || !wasPlayedByOtherTab(item.walletFingerprint));

    // 👑 1. TTL 过滤：由于播放器占线太久导致的过期堆积（超过 15 秒）直接丢弃，不予播报
    const validItems = dedupedList.filter(item => (now - (item._queuedAt || now)) < 15000);
    if (validItems.length === 0) {
        onComplete();
        return;
    }

    // 👑 2. 同钱包去重：同一个钱包对同一代币的同方向操作合并为一条（防止拆单/连击被误判为多人异动）
    const seenWalletKeys = new Set();
    const dedupedItems = validItems.filter(t => {
        const dedupKey = `${t.rename}_${t.action}_${t.tokenSymbol}`;
        if (seenWalletKeys.has(dedupKey)) return false;
        seenWalletKeys.add(dedupKey);
        return true;
    });
    if (dedupedItems.length < validItems.length) {
        console.log(`🔄 [GMGN 盯盘伴侣] 同钱包去重：${validItems.length} 笔 → ${dedupedItems.length} 笔（${validItems.length - dedupedItems.length} 笔重复已合并）`);
    }

    // 👑 3. 超载截断分批：超过 5 笔时截取前 5 笔本轮播报，剩余放回 Batch 下一轮自动消费
    const WALLET_MAX_BATCH = 5;
    let currentItems = dedupedItems;
    if (dedupedItems.length > WALLET_MAX_BATCH) {
        currentItems = dedupedItems.slice(0, WALLET_MAX_BATCH);
        const remaining = dedupedItems.slice(WALLET_MAX_BATCH);
        console.log(`✂️ [GMGN 盯盘伴侣] 钱包截断分批：本轮 ${currentItems.length} 笔，剩余 ${remaining.length} 笔放回队列`);
        remaining.forEach(item => WalletBatch.add(item));
    }

    // 👑 4. 超载概括播报：去重后仍超过 3 笔不同交易，精确概括人名+操作
    if (currentItems.length > 3) {
        console.warn(`🚨 [GMGN 盯盘伴侣] 钱包消息积压超载 (${currentItems.length} 笔不同交易)，启动弹性概括播报`);
        const overloadGroups = {};
        currentItems.forEach(t => {
            const isClearAll = t.ooc === 1;
            let groupAction = t.action;
            let symbol = formatTokenNameForSpeech(t.tokenSymbol);
            if (t.action === 'sell') {
                if (t.cnt === 'processed') {
                    groupAction = 'sellProcessed';
                    symbol = '';
                } else {
                    groupAction = isClearAll ? 'sellClear' : 'sellReduce';
                }
            }
            const key = `${groupAction}_${symbol}`;
            if (!overloadGroups[key]) {
                overloadGroups[key] = { groupAction, tokenSymbol: symbol, names: [] };
            }
            if (!overloadGroups[key].names.includes(t.rename)) {
                overloadGroups[key].names.push(t.rename);
            }
        });
        const overloadPhrases = Object.values(overloadGroups).map(g => {
            const namesStr = g.names.sort().join('、'); // 🔤 排序确保 cacheKey 一致
            let actionStr = '买入';
            if (g.groupAction === 'sellProcessed') actionStr = '卖出';
            if (g.groupAction === 'sellReduce') actionStr = '减仓';
            if (g.groupAction === 'sellClear') actionStr = '清仓';
            return g.groupAction === 'sellProcessed'
                ? `${namesStr}${actionStr}`
                : `${namesStr}${actionStr}${g.tokenSymbol}`;
        });
        const walletOverloadText = overloadPhrases.join('，');
        console.log(`✅ [GMGN 盯盘伴侣 - 已播报] 钱包超载概括: "${walletOverloadText}"`);
        playNetworkTTS(walletOverloadText, 'wallet', onComplete);
        playShortBeep('wallet');
        return;
    }

    // 🌟 降级处理：只有一笔待播，完美兼容原先单发逻辑
    if (currentItems.length === 1) {
        const t = currentItems[0];
        const sym = formatTokenNameForSpeech(t.tokenSymbol);

        if (t.action === 'buy') {
            console.log(`✅ [GMGN 盯盘伴侣 - 已播报] 钱包: "${t.rename}买入 ${sym}"`);
            playNetworkTTS([`${t.rename}买入`, sym], 'wallet', onComplete);
        } else {
            const isClearAll = t.ooc === 1;
            const actionText = isClearAll ? '清仓' : '减仓';
            if (t.cnt === 'processed') {
                console.log(`✅ [GMGN 盯盘伴侣 - 已播报] 钱包第一阶段: "${t.rename}"`);
                playNetworkTTS([t.rename], 'wallet', onComplete);
            } else if (t.cnt === 'confirm') {
                console.log(`✅ [GMGN 盯盘伴侣 - 已播报] 钱包第二阶段: "${actionText}${sym}"`);
                playNetworkTTS([`${actionText}${sym}`], 'wallet', onComplete);
            } else {
                console.log(`✅ [GMGN 盯盘伴侣 - 已播报] 钱包完整: "${t.rename}${actionText} ${sym}"`);
                playNetworkTTS([`${t.rename}${actionText}`, sym], 'wallet', onComplete);
            }
        }
        return;
    }

    // 🌟 高级处理：多笔钱包交易合并汇总 AI 连读
    let mergedTexts = [];
    const groups = {};

    currentItems.forEach(t => {
        const isClearAll = t.ooc === 1;
        let groupAction = t.action;
        let symbol = formatTokenNameForSpeech(t.tokenSymbol);

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
        const namesStr = g.names.sort().join('、'); // 🔤 排序确保 cacheKey 一致

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

        // 👑 多 Tab 单例保护：只有 Leader Tab 执行播报
        if (!TabLeader.isLeader()) return;
        const item = e.detail;
    if (!item || !item.m || !item.bs) return; // 'm' is maker, 'bs' is token symbol
    
    const maker = item.m.toLowerCase();
    const tokenSymbol = item.bs || '代币';
    const amountUSD = parseFloat(item.cu) || parseFloat(item.au) || 0;
    const action = item.s;
    const cnt = item.cnt; // 'processed' 或 'confirm'

    if (action !== 'buy' && action !== 'sell') return; // 只关心买卖动作

    // 🚫 屏蔽代币名：精确匹配（忽略大小写），买入/减仓/清仓统一丢弃
    // 在进调度器/冷却器之前完成，仅一次字符串比较，不影响分段 TTS 延迟
    const blockedSymbols = configCache.walletFilters && Array.isArray(configCache.walletFilters.blockedTokenSymbols)
        ? configCache.walletFilters.blockedTokenSymbols
        : null;
    if (blockedSymbols && blockedSymbols.length > 0) {
        const symKey = String(tokenSymbol).trim().toLowerCase();
        for (let i = 0; i < blockedSymbols.length; i++) {
            if (String(blockedSymbols[i]).trim().toLowerCase() === symKey) {
                console.log(`🚫 [GMGN 盯盘伴侣] 代币名屏蔽，跳过播报: ${tokenSymbol}`);
                return;
            }
        }
    }

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

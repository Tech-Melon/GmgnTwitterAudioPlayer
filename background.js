// Service Worker：安装/更新标记 + Offscreen 后台播报中继
// 注意：MV3 SW 空闲会休眠，扩展页显示「Service Worker (无效)」多数是休眠，不一定是崩溃

const TTS_RATE_LIGHTNING = '+75%';
const OFFSCREEN_URL = 'offscreen.html';
let offscreenCreating = null;

/**
 * 标记「需要展示更新说明」
 * popup 还会用 lastAcknowledgedVersion vs manifest.version 双保险
 */
function markUpdateNotice(reason, previousVersion) {
    let version = '0.0.0';
    try {
        version = chrome.runtime.getManifest().version;
    } catch (e) {
        /* ignore */
    }
    const updateNotice = {
        version,
        previousVersion: previousVersion || null,
        reason: reason || 'update',
        needShow: true,
        createdAt: Date.now()
    };
    chrome.storage.local.set({ updateNotice }, () => {
        if (chrome.runtime.lastError) {
            console.warn('[GMGN 盯盘伴侣] 写入 updateNotice 失败:', chrome.runtime.lastError.message);
            return;
        }
        console.log(`[GMGN 盯盘伴侣] 已标记更新说明 needShow | v${version} | ${reason}`);
    });
}

/**
 * 安装/升级时打开更新说明新标签页
 * - 真正版本变化 / 首次安装：打开
 * - 同版本重复加载（开发 ↻）：不重复刷标签
 */
function openUpdateNotesTab(reason, previousVersion) {
    let version = '0.0.0';
    try {
        version = chrome.runtime.getManifest().version;
    } catch (e) {
        /* ignore */
    }

    const isInstall = reason === 'install';
    const isRealUpdate = reason === 'update' && previousVersion && previousVersion !== version;
    // 开发态同版本 reload：previousVersion 常等于当前版本或缺失，避免刷屏
    const isSameVersionReload = reason === 'update' && (!previousVersion || previousVersion === version);

    if (!isInstall && !isRealUpdate) {
        if (isSameVersionReload) {
            console.log('[GMGN 盯盘伴侣] 同版本重新加载，跳过打开更新说明标签页');
        }
        return;
    }

    const qs = new URLSearchParams({
        v: version,
        reason: reason || 'update'
    });
    if (previousVersion) qs.set('from', previousVersion);

    const url = chrome.runtime.getURL(`update.html?${qs.toString()}`);

    chrome.storage.local.get(['lastChangelogTabVersion'], (res) => {
        // 同一版本只自动开一次标签（防止重复 onInstalled）
        if (res.lastChangelogTabVersion === version && isRealUpdate) {
            console.log('[GMGN 盯盘伴侣] 本版本更新说明标签已打开过，跳过');
            return;
        }
        chrome.tabs.create({ url, active: true }, (tab) => {
            if (chrome.runtime.lastError) {
                console.warn('[GMGN 盯盘伴侣] 打开更新说明页失败:', chrome.runtime.lastError.message);
                return;
            }
            chrome.storage.local.set({ lastChangelogTabVersion: version });
            console.log('[GMGN 盯盘伴侣] 已打开更新说明标签页', tab && tab.id, url);
        });
    });
}

chrome.runtime.onInstalled.addListener((details) => {
    console.log('[GMGN 盯盘伴侣] onInstalled', details);

    // 立刻打更新标记 + 新标签页展示说明
    if (details.reason === 'install' || details.reason === 'update') {
        markUpdateNotice(details.reason, details.previousVersion || null);
        openUpdateNotesTab(details.reason, details.previousVersion || null);
    }

    chrome.storage.local.get(['twitterAudioMappings', 'twitterTts', 'walletTts'], (result) => {
        if (chrome.runtime.lastError) {
            console.warn('[GMGN 盯盘伴侣] onInstalled get 失败:', chrome.runtime.lastError.message);
            return;
        }
        const writes = {};

        if (!result.twitterAudioMappings) {
            writes.twitterAudioMappings = {
                elonmusk: { id: 'elonmusk.MP3', name: '马斯克专属', remark: '内置预设' },
                cz_binance: { id: 'cz.MP3', name: 'CZ专属', remark: '内置预设' },
                heyibinance: { id: 'heyi.MP3', name: '何一专属', remark: '内置预设' }
            };
            console.log('[GMGN 盯盘伴侣] 默认映射规则将初始化');
        }

        const forceLightning = (tts) => ({
            voice: (tts && tts.voice) || 'zh-CN-XiaoxiaoNeural',
            rate: TTS_RATE_LIGHTNING,
            pitch: (tts && tts.pitch) || '+0%'
        });
        const tNorm = forceLightning(result.twitterTts);
        const wNorm = forceLightning(result.walletTts);
        if (!result.twitterTts || result.twitterTts.rate !== TTS_RATE_LIGHTNING) {
            writes.twitterTts = tNorm;
        }
        if (!result.walletTts || result.walletTts.rate !== TTS_RATE_LIGHTNING) {
            writes.walletTts = wNorm;
        }

        if (Object.keys(writes).length === 0) return;
        chrome.storage.local.set(writes, () => {
            if (writes.twitterAudioMappings) {
                console.log('[GMGN 盯盘伴侣] 默认映射规则初始化成功！');
            }
        });
    });
});

// 开发态：有的 Chrome 对「同版本重新加载」不一定可靠触发 onInstalled
// 用 runtime.onStartup 无法覆盖 reload；popup 侧版本对比才是最终兜底

/** 确保 offscreen 文档存在（AUDIO_PLAYBACK） */
async function ensureOffscreenDocument() {
    try {
        if (chrome.runtime.getContexts) {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
            });
            if (contexts && contexts.length > 0) return true;
        }
    } catch (e) {
        // 旧版 Chrome 无 getContexts：尝试 create，已存在会报错
    }

    if (offscreenCreating) {
        await offscreenCreating;
        return true;
    }

    offscreenCreating = (async () => {
        try {
            if (!chrome.offscreen || !chrome.offscreen.createDocument) {
                throw new Error('当前 Chrome 不支持 chrome.offscreen');
            }
            await chrome.offscreen.createDocument({
                url: OFFSCREEN_URL,
                reasons: ['AUDIO_PLAYBACK'],
                justification: 'GMGN 标签页在后台时仍需播报推特/钱包提示音与 TTS'
            });
            console.log('[GMGN 盯盘伴侣] Offscreen 播报文档已创建');
        } catch (e) {
            const msg = String(e && e.message ? e.message : e);
            if (/already exists|Only a single offscreen/i.test(msg)) return;
            console.warn('[GMGN 盯盘伴侣] 创建 Offscreen 失败:', msg);
            throw e;
        } finally {
            offscreenCreating = null;
        }
    })();

    await offscreenCreating;
    return true;
}

/**
 * 转发到 offscreen，并等待播放完成
 * @param {object} payload
 */
async function relayToOffscreen(payload) {
    await ensureOffscreenDocument();
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(
                { target: 'offscreen', ...payload },
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    // content → SW → offscreen 播放
    if (msg.type === 'OFFSCREEN_PLAY' || msg.type === 'OFFSCREEN_WARMUP' || msg.type === 'OFFSCREEN_STOP') {
        const payload =
            msg.type === 'OFFSCREEN_PLAY'
                ? {
                      type: 'OFFSCREEN_PLAY',
                      channel: msg.channel || 'tts',
                      items: msg.items || [],
                      volume: msg.volume
                  }
                : msg.type === 'OFFSCREEN_WARMUP'
                  ? { type: 'OFFSCREEN_WARMUP' }
                  : { type: 'OFFSCREEN_STOP', channel: msg.channel };

        relayToOffscreen(payload)
            .then(sendResponse)
            .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
        return true; // async
    }

    // popup 主动查询 / 强制标记（调试用）
    if (msg.type === 'FORCE_UPDATE_NOTICE') {
        markUpdateNotice('manual', null);
        sendResponse({ ok: true });
        return true;
    }

    return false;
});

console.log('[GMGN 盯盘伴侣] Service Worker 已加载', chrome.runtime.getManifest().version);

// Service Worker：安装/更新标记 + 多 Tab 事件协调 + Offscreen 播报中继
// 注意：MV3 SW 空闲会休眠，扩展页显示「Service Worker (无效)」多数是休眠，不一定是崩溃

importScripts('lib/event-coordinator.js');

// 语速三档：较快 / 极快 / 闪电
const TTS_RATE_OPTIONS = ['+15%', '+50%', '+75%'];
const TTS_RATE_DEFAULT = '+75%'; // 闪电

function normalizeRate(rate) {
    if (TTS_RATE_OPTIONS.includes(rate)) return rate;
    const legacyMap = {
        '+0%': '+15%',
        '+15%': '+15%',
        '+30%': '+50%',
        '+40%': '+50%',
        '+45%': '+50%',
        '+50%': '+50%',
        '+75%': '+75%'
    };
    return legacyMap[rate] || TTS_RATE_DEFAULT;
}
const OFFSCREEN_URL = 'offscreen.html';
let offscreenCreating = null;
const COORDINATOR_STORAGE_KEY = 'gmgnEventCoordinatorState';
const eventCoordinator = new GmgnEventCoordinator();
const monitorTabs = new Map();
let ingestChain = Promise.resolve();
const playbackRetryCounts = new Map();
const twitterSemanticRecent = new Map();
let persistTimer = null;
let persistDirty = false;
let persistChain = Promise.resolve();
const PERSIST_DEBOUNCE_MS = 150;
/**
 * Processor 超过该时间无心跳/注册则允许其它 Tab 接管。
 * 后台标签页定时器被强节流后 content 心跳最慢 ~60s 一次，
 * 阈值必须大于该间隔，否则后台 Processor 会被反复误判失联（角色震荡）。
 * 正常情况下 offscreen 保活节拍（10s）会持续刷新存活时间。
 */
const MONITOR_STALE_MS = 75000;
const DIAGNOSTIC_ORIGIN = 'http://127.0.0.1:37921/*';
const DIAGNOSTIC_ENDPOINT = 'http://127.0.0.1:37921/log';
const DIAGNOSTIC_SESSION_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const diagnosticBuffer = [];
let diagnosticFlushTimer = null;
let diagnosticFlushInFlight = false;
let debugLoggingEnabled = false;
const TWITTER_SEMANTIC_DEDUP_MS = 1500;

function clearDiagnosticBuffer() {
    diagnosticBuffer.length = 0;
    if (diagnosticFlushTimer) clearTimeout(diagnosticFlushTimer);
    diagnosticFlushTimer = null;
}

function applyDebugLoggingSetting(requested) {
    if (requested !== true) {
        debugLoggingEnabled = false;
        clearDiagnosticBuffer();
        return;
    }
    if (!chrome.permissions || !chrome.permissions.contains) {
        debugLoggingEnabled = false;
        return;
    }
    chrome.permissions.contains({ origins: [DIAGNOSTIC_ORIGIN] }, (granted) => {
        debugLoggingEnabled = granted === true;
        if (!granted) {
            clearDiagnosticBuffer();
            chrome.storage.local.set({ debugLoggingEnabled: false });
        }
    });
}

chrome.storage.local.get(['debugLoggingEnabled'], (result) => {
    applyDebugLoggingSetting(result && result.debugLoggingEnabled === true);
});
if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local' || !('debugLoggingEnabled' in changes)) return;
        applyDebugLoggingSetting(changes.debugLoggingEnabled.newValue === true);
    });
}

function queueDiagnosticLog(entry, sender = null) {
    if (!debugLoggingEnabled) return;
    if (!entry || typeof entry !== 'object') return;
    diagnosticBuffer.push({
        ...entry,
        extensionVersion: chrome.runtime.getManifest().version,
        backgroundSessionId: DIAGNOSTIC_SESSION_ID,
        receivedByBackgroundAt: Date.now(),
        tabId: sender && sender.tab ? sender.tab.id : undefined,
        documentId: sender && sender.documentId ? sender.documentId : undefined
    });
    if (diagnosticBuffer.length > 1000) diagnosticBuffer.splice(0, diagnosticBuffer.length - 1000);
    if (diagnosticBuffer.length >= 25) {
        flushDiagnosticLogs();
    } else if (!diagnosticFlushTimer) {
        diagnosticFlushTimer = setTimeout(flushDiagnosticLogs, 250);
    }
}

async function flushDiagnosticLogs() {
    if (diagnosticFlushTimer) {
        clearTimeout(diagnosticFlushTimer);
        diagnosticFlushTimer = null;
    }
    if (!debugLoggingEnabled || diagnosticFlushInFlight || diagnosticBuffer.length === 0) return;
    diagnosticFlushInFlight = true;
    const batch = diagnosticBuffer.splice(0, 100);
    try {
        // 强制校验：诊断数据只允许发往本机 loopback 地址，杜绝明文诊断数据被发送到真实网络中的风险
        const diagnosticHost = new URL(DIAGNOSTIC_ENDPOINT).hostname;
        if (diagnosticHost !== '127.0.0.1' && diagnosticHost !== 'localhost' && diagnosticHost !== '[::1]') {
            return;
        }
        const response = await fetch(DIAGNOSTIC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        console.debug('[GMGN 诊断] 本地日志收集器未连接:', error && error.message ? error.message : error);
    } finally {
        diagnosticFlushInFlight = false;
        if (diagnosticBuffer.length > 0 && !diagnosticFlushTimer) {
            diagnosticFlushTimer = setTimeout(flushDiagnosticLogs, 250);
        }
    }
}

function getTwitterSemanticKey(msg) {
    return msg && msg.kind === 'twitter' && msg.payload
        ? String(msg.payload.semanticKey || '')
        : '';
}

function findTwitterSemanticDuplicate(msg, now = Date.now()) {
    const semanticKey = getTwitterSemanticKey(msg);
    if (!semanticKey) return null;
    const recent = twitterSemanticRecent.get(semanticKey);
    if (!recent) return null;
    if (now - recent.timestamp > TWITTER_SEMANTIC_DEDUP_MS) {
        twitterSemanticRecent.delete(semanticKey);
        return null;
    }
    if (recent.eventId === msg.eventId) return null;
    return eventCoordinator.hasSeen(recent.eventId, 'twitter', now) ? recent : null;
}

function rememberTwitterSemantic(msg, now = Date.now()) {
    const semanticKey = getTwitterSemanticKey(msg);
    if (!semanticKey) return;
    twitterSemanticRecent.set(semanticKey, { eventId: msg.eventId, timestamp: now });
    if (twitterSemanticRecent.size <= 500) return;
    for (const [key, record] of twitterSemanticRecent) {
        if (now - record.timestamp > TWITTER_SEMANTIC_DEDUP_MS) twitterSemanticRecent.delete(key);
    }
}

function isActionableMonitorEvent(kind, payload) {
    if (kind !== 'wallet') return true;
    const action = payload && payload.item && payload.item.s;
    return action === 'buy' || action === 'sell';
}

function pruneIgnoredPendingWalletEvents() {
    let removed = 0;
    for (const [eventId, record] of eventCoordinator.pending) {
        if (isActionableMonitorEvent(record && record.kind, record && record.payload)) continue;
        eventCoordinator.removePending(eventId);
        removed += 1;
    }
    return removed;
}

function storageSessionGet(key) {
    return new Promise((resolve) => {
        if (!chrome.storage.session) {
            resolve({});
            return;
        }
        chrome.storage.session.get([key], (result) => {
            if (chrome.runtime.lastError) {
                resolve({});
                return;
            }
            resolve(result || {});
        });
    });
}

function storageSessionSet(value) {
    return new Promise((resolve) => {
        if (!chrome.storage.session) {
            resolve();
            return;
        }
        chrome.storage.session.set(value, () => resolve());
    });
}

const coordinatorReady = storageSessionGet(COORDINATOR_STORAGE_KEY).then((result) => {
    eventCoordinator.restore(result[COORDINATOR_STORAGE_KEY]);
    if (pruneIgnoredPendingWalletEvents() > 0) {
        return storageSessionSet({ [COORDINATOR_STORAGE_KEY]: eventCoordinator.snapshot() });
    }
    return undefined;
});

function flushCoordinatorState() {
    if (!persistDirty) return persistChain;
    persistDirty = false;
    const snapshot = eventCoordinator.snapshot();
    persistChain = persistChain
        .then(() => storageSessionSet({ [COORDINATOR_STORAGE_KEY]: snapshot }))
        .catch((error) => console.warn('[GMGN 盯盘伴侣] 协调状态持久化失败:', error));
    return persistChain;
}

function persistCoordinator(immediate = false) {
    persistDirty = true;
    if (immediate) {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = null;
        return flushCoordinatorState();
    }
    if (!persistTimer) {
        persistTimer = setTimeout(() => {
            persistTimer = null;
            flushCoordinatorState();
        }, PERSIST_DEBOUNCE_MS);
    }
    return Promise.resolve();
}

function buildMonitorRecord(sender, options = {}) {
    if (!sender || !sender.tab || !Number.isInteger(sender.tab.id)) return null;
    return {
        tabId: sender.tab.id,
        documentId: sender.documentId || null,
        lastSeenAt: Date.now(),
        visible: options.visible === true
    };
}

function isProcessorRecord(record) {
    const processor = eventCoordinator.processor;
    if (!processor || !record) return false;
    return processor.tabId === record.tabId
        && (!processor.documentId || processor.documentId === record.documentId);
}

function isMonitorStale(record, now = Date.now()) {
    if (!record || !Number.isFinite(record.lastSeenAt)) return true;
    return (now - record.lastSeenAt) > MONITOR_STALE_MS;
}

/**
 * 注册/刷新监控 Tab。
 * - 默认粘性保留当前 Processor，避免多 Tab 抖动
 * - preferProcessor + visible：前台切回主动接管播报权
 * - Processor 心跳过期：允许其它存活 Tab 接管
 * @returns {{ record: object, processorChanged: boolean } | null}
 */
function registerMonitor(sender, options = {}) {
    const record = buildMonitorRecord(sender, options);
    if (!record) return null;
    monitorTabs.set(record.tabId, record);

    const previous = eventCoordinator.processor;
    const preferProcessor = options.preferProcessor === true && record.visible;
    let shouldAssign = false;

    if (!previous) {
        shouldAssign = true;
    } else if (previous.tabId === record.tabId) {
        // 同 Tab 刷新 documentId / epoch 粘性
        shouldAssign = true;
    } else if (preferProcessor) {
        shouldAssign = true;
    } else if (isMonitorStale(monitorTabs.get(previous.tabId))) {
        // 旧 Processor 失联：优先让仍活着的 Tab（尤其前台）接手
        shouldAssign = record.visible || options.allowStaleTakeover !== false;
    }

    if (shouldAssign) {
        eventCoordinator.assignProcessor(record.tabId, record.documentId);
    }

    const processor = eventCoordinator.processor;
    const processorChanged = !previous
        || !processor
        || previous.tabId !== processor.tabId
        || previous.documentId !== processor.documentId
        || previous.epoch !== processor.epoch;

    return { record, processorChanged };
}

/** 通知各监控 Tab 当前是否为 Processor（非阻塞） */
function broadcastProcessorRoles() {
    const processor = eventCoordinator.processor;
    for (const record of monitorTabs.values()) {
        const isProcessor = isProcessorRecord(record);
        sendToMonitor(record, {
            type: 'GMGN_PROCESSOR_ROLE',
            isProcessor,
            processorEpoch: isProcessor && processor ? processor.epoch : null,
            processorTabId: processor ? processor.tabId : null
        }, 800).then((response) => {
            if (response && response.ok) return;
            // 失联 Tab 从候选中剔除，避免故障转移反复点名
            if (response && response.error && /timeout|Receiving end|connection/i.test(String(response.error))) {
                if (!isProcessorRecord(record)) monitorTabs.delete(record.tabId);
            }
        }).catch(() => {});
    }
}

async function finalizeProcessorAssignment(processorChanged) {
    if (!processorChanged) return eventCoordinator.processor;
    const processor = eventCoordinator.processor;
    if (processor) {
        const replayed = await replayPendingEvents(processor);
        if (!replayed) {
            monitorTabs.delete(processor.tabId);
            eventCoordinator.clearProcessor(processor.tabId, processor.documentId);
            // 尝试其它候选
            for (const candidate of monitorTabs.values()) {
                const next = eventCoordinator.assignProcessor(candidate.tabId, candidate.documentId);
                const ping = await sendToMonitor(next, { type: 'GMGN_PROCESSOR_PING' }, 1200);
                if (ping.ok && await replayPendingEvents(next)) break;
                monitorTabs.delete(candidate.tabId);
                eventCoordinator.clearProcessor(candidate.tabId, candidate.documentId);
            }
        }
    }
    broadcastProcessorRoles();
    await persistCoordinator(true);
    return eventCoordinator.processor;
}

function sendToMonitor(record, message, timeoutMs = 1500) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => finish({ ok: false, error: 'processor_timeout' }), timeoutMs);
        const callback = (response) => {
            if (chrome.runtime.lastError) {
                finish({ ok: false, error: chrome.runtime.lastError.message });
                return;
            }
            finish(response && response.ok ? response : { ok: false, error: 'processor_rejected' });
        };

        try {
            if (record.documentId) {
                chrome.tabs.sendMessage(record.tabId, message, { documentId: record.documentId }, callback);
            } else {
                chrome.tabs.sendMessage(record.tabId, message, callback);
            }
        } catch (error) {
            finish({ ok: false, error: String(error && error.message ? error.message : error) });
        }
    });
}

/** 当前 Processor 是否仍有存活心跳（未超时） */
function hasLiveProcessor(now = Date.now()) {
    const processor = eventCoordinator.processor;
    if (!processor || !Number.isInteger(processor.tabId)) return false;
    const record = monitorTabs.get(processor.tabId);
    if (!record) return false;
    if (processor.documentId && record.documentId && processor.documentId !== record.documentId) {
        return false;
    }
    return !isMonitorStale(record, now);
}

function isSameMonitor(record, processor) {
    if (!record || !processor) return false;
    return record.tabId === processor.tabId
        && (!processor.documentId || processor.documentId === record.documentId);
}

async function routeMonitorEvent(msg, sender) {
    await coordinatorReady;
    // 先登记存活，再判定是否允许上报。有存活 Processor 时，其它 Tab 直接静默丢弃，
    // 避免 N 开标签把协调链打成 N 倍洪峰（历史诊断：99% 事件被 3 Tab 同时上报）。
    const softRegistration = registerMonitor(sender, {
        visible: true,
        preferProcessor: false,
        allowStaleTakeover: false
    });
    if (!softRegistration || !softRegistration.record) return { ok: false, error: 'invalid_sender' };
    const source = softRegistration.record;
    const liveProcessor = hasLiveProcessor() ? eventCoordinator.processor : null;
    if (liveProcessor && !isSameMonitor(source, liveProcessor)) {
        return {
            ok: true,
            ignored: true,
            not_processor: true,
            isProcessor: false,
            processorTabId: liveProcessor.tabId,
            processorEpoch: liveProcessor.epoch
        };
    }

    const registration = liveProcessor
        ? softRegistration
        : registerMonitor(sender, {
            visible: true,
            preferProcessor: false,
            // 无存活 Processor：上报方顺势接管，避免全站静音
            allowStaleTakeover: true
        });
    if (!registration || !registration.record) return { ok: false, error: 'invalid_sender' };
    if (registration.processorChanged) {
        await finalizeProcessorAssignment(true);
    }
    if (!msg.eventId || (msg.kind !== 'twitter' && msg.kind !== 'wallet')) {
        return { ok: false, error: 'invalid_event' };
    }
    if (!isActionableMonitorEvent(msg.kind, msg.payload)) {
        return { ok: true, ignored: true };
    }
    if (eventCoordinator.isCompleted(msg.eventId, msg.kind)) {
        return { ok: true, duplicate: true };
    }

    const semanticDuplicate = findTwitterSemanticDuplicate(msg);
    if (semanticDuplicate) {
        eventCoordinator.markSeen(msg.eventId, 'twitter');
        persistCoordinator();
        return {
            ok: true,
            duplicate: true,
            semanticDuplicateOf: semanticDuplicate.eventId
        };
    }

    if (eventCoordinator.isPending(msg.eventId, msg.kind)) {
        const currentProcessor = eventCoordinator.processor;
        if (currentProcessor) {
            const ping = await sendToMonitor(currentProcessor, { type: 'GMGN_PROCESSOR_PING' }, 5000);
            if (ping.ok) return { ok: true, duplicate: true, pending: true };
            monitorTabs.delete(currentProcessor.tabId);
            eventCoordinator.clearProcessor(currentProcessor.tabId, currentProcessor.documentId);
        }
    }

    if (!eventCoordinator.isPending(msg.eventId, msg.kind)) {
        eventCoordinator.markPending(msg.eventId, msg.kind, msg.payload);
        rememberTwitterSemantic(msg);
        // The pending record must exist before Content can emit an early completion.
        await persistCoordinator(true);
    }

    const candidates = [];
    const current = eventCoordinator.processor;
    if (current) candidates.push(current);
    if (!current || current.tabId !== source.tabId || current.documentId !== source.documentId) {
        candidates.push(source);
    }
    for (const record of monitorTabs.values()) {
        if (!candidates.some((candidate) => candidate.tabId === record.tabId && candidate.documentId === record.documentId)) {
            candidates.push(record);
        }
    }

    for (const candidate of candidates) {
        if (eventCoordinator.isCompleted(msg.eventId, msg.kind)) {
            persistCoordinator();
            return { ok: true, duplicate: true };
        }
        const previousProcessor = eventCoordinator.processor;
        const processor = eventCoordinator.assignProcessor(candidate.tabId, candidate.documentId);
        const processorChanged = !previousProcessor
            || previousProcessor.tabId !== processor.tabId
            || previousProcessor.documentId !== processor.documentId;

        if (processorChanged) {
            const replayed = await replayPendingEvents(processor, msg.eventId);
            if (!replayed) {
                monitorTabs.delete(candidate.tabId);
                eventCoordinator.clearProcessor(candidate.tabId, candidate.documentId);
                continue;
            }
        }

        const response = await sendToMonitor(processor, {
            type: 'GMGN_PROCESS_EVENT',
            kind: msg.kind,
            eventId: msg.eventId,
            payload: msg.payload,
            processorEpoch: processor.epoch,
            runtimeState: eventCoordinator.runtimeState
        });
        if (response.ok) {
            applyProcessorResponse(response, msg.eventId, msg.kind, msg.payload);
            await persistCoordinator(true);
            return {
                ok: true,
                processorTabId: processor.tabId,
                processorEpoch: processor.epoch,
                isProcessor: isProcessorRecord(source)
            };
        }
        monitorTabs.delete(candidate.tabId);
        eventCoordinator.clearProcessor(candidate.tabId, candidate.documentId);
    }

    eventCoordinator.removePending(msg.eventId);
    persistCoordinator();
    return { ok: false, error: 'no_available_processor' };
}

function applyProcessorResponse(response, eventId, kind, payload, preservePendingTimestamp = false) {
    if (response.runtimeState) eventCoordinator.setRuntimeState(response.runtimeState);
    if (eventCoordinator.isCompleted(eventId, kind)) return;
    if (response.disposition === 'complete') {
        eventCoordinator.markSeen(eventId, kind);
        return;
    }
    if (!preservePendingTimestamp || !eventCoordinator.isPending(eventId, kind)) {
        eventCoordinator.markPending(eventId, kind, payload);
    }
}

async function replayPendingEvents(processor, excludeEventId = null) {
    const pendingEvents = eventCoordinator.getPending();
    for (const pending of pendingEvents) {
        if (pending.eventId === excludeEventId) continue;
        const response = await sendToMonitor(processor, {
            type: 'GMGN_PROCESS_EVENT',
            kind: pending.kind,
            eventId: pending.eventId,
            payload: pending.payload,
            processorEpoch: processor.epoch,
            runtimeState: eventCoordinator.runtimeState,
            replayed: true
        });
        if (!response.ok) return false;
        applyProcessorResponse(response, pending.eventId, pending.kind, pending.payload, true);
    }
    persistCoordinator();
    return true;
}

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

        const normalizeTts = (tts) => ({
            voice: (tts && tts.voice) || 'zh-CN-XiaoxiaoNeural',
            rate: normalizeRate(tts && tts.rate),
            pitch: (tts && tts.pitch) || '+0%'
        });
        const tNorm = normalizeTts(result.twitterTts);
        const wNorm = normalizeTts(result.walletTts);
        // 仅在缺失配置或旧档位需映射时写回，保留用户已选的三档语速
        if (!result.twitterTts || (result.twitterTts.rate && result.twitterTts.rate !== tNorm.rate)) {
            writes.twitterTts = tNorm;
        }
        if (!result.walletTts || (result.walletTts.rate && result.walletTts.rate !== wNorm.rate)) {
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
                // BLOBS：处理 Blob/DataURL 音频数据；同时避免 AUDIO_PLAYBACK
                // 单一理由下 30s 无声即被回收，保活节拍器需要文档常驻
                reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
                justification: 'GMGN 标签页在后台时仍需播报推特/钱包提示音与 TTS，并处理 Blob 音频数据、维持推送保活节拍'
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

// ════════════════════════════════════════════════════════════
// 🫀 WSS 保活引擎
// 后台标签页定时器被 Chrome 强节流（隐藏 >5min 后 1 次/分钟），
// GMGN 页面自身的 10s 推送心跳失效 → 服务端断线 → 推特/钱包推送
// 时断时续直至全停（刷新才恢复）。offscreen 文档不受该节流影响，
// 由它每 10s 发 GMGN_KEEPALIVE_TICK，SW 转发到各 GMGN 标签页代发心跳。
// ════════════════════════════════════════════════════════════
let lastKeepaliveEnsureAt = 0;

/** 确保 offscreen 保活节拍器存在（节流为 25s 一次检查，调用方可高频触发） */
function ensureKeepaliveEngine() {
    const now = Date.now();
    if (now - lastKeepaliveEnsureAt < 25000) return;
    lastKeepaliveEnsureAt = now;
    ensureOffscreenDocument().catch(() => {});
}

function sendWssKeepaliveToTab(tabId) {
    try {
        chrome.tabs.sendMessage(tabId, { type: 'GMGN_WSS_KEEPALIVE' }, (response) => {
            if (chrome.runtime.lastError || !response || response.ok !== true) return;
            // 保活应答顺带刷新监控存活时间，弥补后台心跳被节流到 60s 的空窗
            const record = monitorTabs.get(tabId);
            if (record) {
                record.lastSeenAt = Date.now();
                record.visible = response.visible === true;
            } else {
                monitorTabs.set(tabId, {
                    tabId,
                    documentId: null,
                    lastSeenAt: Date.now(),
                    visible: response.visible === true
                });
            }
        });
    } catch (error) {
        // Tab 已关闭等场景直接忽略，onRemoved 会做故障转移
    }
}

function handleKeepaliveTick() {
    if (monitorTabs.size > 0) {
        for (const tabId of monitorTabs.keys()) sendWssKeepaliveToTab(tabId);
        return;
    }
    // SW 冷启动后监控表为空：按 URL 找回 GMGN 标签页
    try {
        chrome.tabs.query({ url: ['*://*.gmgn.ai/*', '*://gmgn.ai/*'] }, (tabs) => {
            if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
            tabs.forEach((tab) => {
                if (tab && Number.isInteger(tab.id)) sendWssKeepaliveToTab(tab.id);
            });
        });
    } catch (error) {
        // tabs API 异常时等待下一拍
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'GMGN_KEEPALIVE_TICK') {
        handleKeepaliveTick();
        sendResponse({ ok: true });
        return false;
    }

    if (msg.type === 'GMGN_DIAGNOSTIC_LOG') {
        if (!debugLoggingEnabled) {
            sendResponse({ ok: true, disabled: true });
            return false;
        }
        queueDiagnosticLog(msg.entry, sender);
        sendResponse({ ok: true });
        return false;
    }

    if (msg.type === 'GMGN_REGISTER_MONITOR' || msg.type === 'GMGN_MONITOR_HEARTBEAT') {
        ensureKeepaliveEngine();
        coordinatorReady.then(async () => {
            const visible = msg.visible === true
                || (msg.visible !== false && msg.type === 'GMGN_REGISTER_MONITOR');
            const preferProcessor = msg.preferProcessor === true;
            const registration = registerMonitor(sender, {
                visible,
                preferProcessor,
                allowStaleTakeover: msg.type === 'GMGN_MONITOR_HEARTBEAT' || preferProcessor
            });
            if (!registration || !registration.record) {
                sendResponse({ ok: false, error: 'invalid_sender' });
                return;
            }
            const processor = await finalizeProcessorAssignment(registration.processorChanged);
            // 轻量心跳且未切换：仅刷新持久化标记，避免写放大
            if (!registration.processorChanged && msg.type === 'GMGN_REGISTER_MONITOR') {
                await persistCoordinator(true);
            } else if (!registration.processorChanged) {
                persistCoordinator(false);
            }
            sendResponse({
                ok: true,
                processor,
                isProcessor: isProcessorRecord(registration.record)
            });
        }).catch((error) => {
            sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
        });
        return true;
    }

    if (msg.type === 'GMGN_INGEST_EVENT') {
        ensureKeepaliveEngine();
        if (!isActionableMonitorEvent(msg.kind, msg.payload)) {
            sendResponse({ ok: true, ignored: true });
            return false;
        }
        const task = ingestChain.then(() => routeMonitorEvent(msg, sender));
        ingestChain = task.catch((error) => {
            console.warn('[GMGN 盯盘伴侣] 事件协调异常:', error);
        });
        task.then(sendResponse).catch((error) => {
            sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
        });
        return true;
    }

    if (msg.type === 'GMGN_EVENT_COMPLETE') {
        coordinatorReady.then(async () => {
            const authorized = sender.tab && eventCoordinator.isProcessor(
                sender.tab.id,
                sender.documentId || null,
                msg.processorEpoch
            );
            if (!authorized) {
                sendResponse({ ok: false, error: 'stale_processor' });
                return;
            }
            const completedIds = Array.isArray(msg.eventIds) ? msg.eventIds : [];
            eventCoordinator.complete(completedIds);
            completedIds.forEach((eventId) => playbackRetryCounts.delete(eventId));
            if (msg.runtimeState) eventCoordinator.setRuntimeState(msg.runtimeState);
            await persistCoordinator(true);
            sendResponse({ ok: true });
        }).catch((error) => {
            sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
        });
        return true;
    }

    if (msg.type === 'GMGN_EVENT_RETRY') {
        coordinatorReady.then(async () => {
            const authorized = sender.tab && eventCoordinator.isProcessor(
                sender.tab.id,
                sender.documentId || null,
                msg.processorEpoch
            );
            if (!authorized) {
                sendResponse({ ok: false, error: 'stale_processor' });
                return;
            }
            if (msg.runtimeState) eventCoordinator.setRuntimeState(msg.runtimeState);
            const processor = eventCoordinator.processor;
            const eventIds = Array.isArray(msg.eventIds) ? msg.eventIds : [];
            const retried = [];
            for (const eventId of eventIds) {
                const pending = eventCoordinator.pending.get(eventId);
                if (!pending) continue;
                const retryCount = (playbackRetryCounts.get(eventId) || 0) + 1;
                playbackRetryCounts.set(eventId, retryCount);
                if (retryCount > 2) {
                    console.warn('[GMGN 盯盘伴侣] 播放重试超过上限:', eventId, msg.error);
                    continue;
                }
                const response = await sendToMonitor(processor, {
                    type: 'GMGN_PROCESS_EVENT',
                    kind: pending.kind,
                    eventId,
                    payload: pending.payload,
                    processorEpoch: processor.epoch,
                    runtimeState: eventCoordinator.runtimeState,
                    replayed: true
                });
                if (response.ok) {
                    applyProcessorResponse(response, eventId, pending.kind, pending.payload, true);
                    retried.push(eventId);
                }
            }
            await persistCoordinator(true);
            sendResponse({ ok: true, retried });
        }).catch((error) => {
            sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
        });
        return true;
    }

    // content → SW → offscreen 播放
    if (msg.type === 'OFFSCREEN_PLAY' || msg.type === 'OFFSCREEN_WARMUP' || msg.type === 'OFFSCREEN_STOP') {
        if (msg.type === 'OFFSCREEN_PLAY' && sender.tab) {
            coordinatorReady.then(() => {
                const authorized = eventCoordinator.isProcessor(
                    sender.tab.id,
                    sender.documentId || null,
                    msg.processorEpoch
                );
                if (!authorized) {
                    sendResponse({ ok: false, error: 'stale_processor' });
                    return;
                }
                relayToOffscreen({
                    type: 'OFFSCREEN_PLAY',
                    channel: msg.channel || 'tts',
                    items: msg.items || [],
                    volume: msg.volume,
                    createdAt: msg.createdAt,
                    expiresAt: msg.expiresAt,
                    source: msg.source,
                    segmentGapMs: msg.segmentGapMs,
                    traceId: msg.traceId,
                    diagnostic: msg.diagnostic
                }).then(sendResponse).catch((error) => {
                    sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
                });
            }).catch((error) => {
                sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
            });
            return true;
        }

        const payload =
            msg.type === 'OFFSCREEN_PLAY'
                ? {
                      type: 'OFFSCREEN_PLAY',
                      channel: msg.channel || 'tts',
                      items: msg.items || [],
                      volume: msg.volume,
                      createdAt: msg.createdAt,
                      expiresAt: msg.expiresAt,
                      source: msg.source,
                      segmentGapMs: msg.segmentGapMs,
                      traceId: msg.traceId,
                      diagnostic: msg.diagnostic
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

async function failoverRemovedMonitor(tabId, documentId) {
    await coordinatorReady;
    if (!eventCoordinator.clearProcessor(tabId, documentId)) {
        // 非 Processor 关闭也要从候选表移除
        monitorTabs.delete(tabId);
        return;
    }
    // 优先前台 Tab，其次任意存活候选
    const candidates = Array.from(monitorTabs.values())
        .filter((record) => record.tabId !== tabId)
        .sort((left, right) => Number(right.visible === true) - Number(left.visible === true));
    for (const candidate of candidates) {
        const processor = eventCoordinator.assignProcessor(candidate.tabId, candidate.documentId);
        const ping = await sendToMonitor(processor, { type: 'GMGN_PROCESSOR_PING' }, 1500);
        if (ping.ok && await replayPendingEvents(processor)) {
            broadcastProcessorRoles();
            await persistCoordinator(true);
            return;
        }
        monitorTabs.delete(candidate.tabId);
        eventCoordinator.clearProcessor(candidate.tabId, candidate.documentId);
    }
    broadcastProcessorRoles();
    await persistCoordinator(true);
}

function removeMonitorAndFailover(tabId) {
    const removed = monitorTabs.get(tabId);
    monitorTabs.delete(tabId);
    failoverRemovedMonitor(tabId, removed && removed.documentId).catch((error) => {
        console.warn('[GMGN 盯盘伴侣] Processor 故障转移失败:', error);
    });
}

chrome.tabs.onRemoved.addListener((tabId) => {
    removeMonitorAndFailover(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo && changeInfo.discarded === true) {
        removeMonitorAndFailover(tabId);
    }
});

// SW 每次唤醒都确保保活节拍器在位（offscreen 常驻，10s 一拍反向保持 SW 活跃）
ensureKeepaliveEngine();

console.log('[GMGN 盯盘伴侣] Service Worker 已加载', chrome.runtime.getManifest().version);

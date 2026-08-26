/**
 * Offscreen 双通道播报
 * - exclusive：专属铃（互不打断 TTS）
 * - tts：TTS / 默认 ding
 * 仅由 background 转发 content 的 OFFSCREEN_* 消息
 *
 * 同通道严格 FIFO，只有显式 STOP 才会打断当前任务。
 */

const exclusivePlayer = new Audio();
const ttsPlayer = new Audio();
let exclusiveGen = 0;
let ttsGen = 0;
/** @type {null | (() => void)} */
let exclusiveCancel = null;
/** @type {null | (() => void)} */
let ttsCancel = null;
const channelQueues = {
  exclusive: [],
  tts: []
};
const channelRunning = {
  exclusive: false,
  tts: false
};
const channelGainNodes = {
  exclusive: null,
  tts: null
};
const MAX_QUEUE_LENGTH = 100;
const DEFAULT_JOB_TTL_MS = 2 * 60 * 1000;
let audioContext = null;
let debugLoggingEnabled = !(chrome.storage && chrome.storage.local);

if (chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['debugLoggingEnabled'], (result) => {
    debugLoggingEnabled = result && result.debugLoggingEnabled === true;
  });
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && 'debugLoggingEnabled' in changes) {
        debugLoggingEnabled = changes.debugLoggingEnabled.newValue === true;
      }
    });
  }
}

function diagnosticLog(stage, details = {}) {
  if (!debugLoggingEnabled) return;
  try {
    chrome.runtime.sendMessage({
      type: 'GMGN_DIAGNOSTIC_LOG',
      entry: {
        ts: Date.now(),
        context: 'offscreen',
        stage,
        ...details
      }
    }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    // 扩展重载时诊断不可用，不应影响播放。
  }
}

function normalizeVolume(volume) {
  const parsed = Number(volume);
  return Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : 1, 1.5));
}

function getAudioContext() {
  if (audioContext) return audioContext;
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) return null;
  audioContext = new AudioContextClass();
  return audioContext;
}

function ensurePlayerGain(channel, player) {
  if (channelGainNodes[channel]) return channelGainNodes[channel];
  const ctx = getAudioContext();
  if (!ctx || typeof ctx.createMediaElementSource !== 'function') return null;
  const source = ctx.createMediaElementSource(player);
  const gain = ctx.createGain();
  source.connect(gain);
  gain.connect(ctx.destination);
  channelGainNodes[channel] = gain;
  return gain;
}

async function resumeAudioContext() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') await ctx.resume().catch(() => {});
  return ctx;
}

async function playBeep(volume) {
  const ctx = await resumeAudioContext();
  if (!ctx || typeof ctx.createOscillator !== 'function') {
    return { ok: false, error: 'audio_context_unavailable' };
  }
  return new Promise((resolve) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const peak = 0.3 * normalizeVolume(volume);
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), now + 0.01);
    gain.gain.setValueAtTime(Math.max(peak, 0.0001), now + 0.055);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.onended = () => resolve({ ok: true });
    oscillator.start(now);
    oscillator.stop(now + 0.085);
  });
}

function stopPlayer(player) {
  try {
    player.onended = null;
    player.onerror = null;
    player.pause();
    player.removeAttribute('src');
    player.load();
  } catch (e) {
    /* ignore */
  }
}

function resolvePlayUrl(item) {
  if (!item) return null;
  if (typeof item === 'string') return item;
  if (item.kind === 'data' && item.dataUrl) return item.dataUrl;
  if (item.kind === 'extension' && item.path) {
    return chrome.runtime.getURL(item.path);
  }
  if (item.url) return item.url;
  return null;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('blob_to_dataurl_failed'));
    reader.readAsDataURL(blob);
  });
}

async function stitchPlaybackItems(list) {
  if (!list || list.length < 2) return list;
  if (typeof GmgnTtsSeam === 'undefined' || typeof GmgnTtsSeam.stitchBlobs !== 'function') return list;
  if (list.some((item) => item && typeof item === 'object' && item.kind === 'beep')) return list;
  const blobs = [];
  for (const item of list) {
    const url = resolvePlayUrl(item);
    if (!url) return list;
    const response = await fetch(url);
    if (!response.ok) return list;
    blobs.push(await response.blob());
  }
  const ctx = await resumeAudioContext();
  const stitched = await GmgnTtsSeam.stitchBlobs(blobs, { audioContext: ctx });
  if (!stitched) return list;
  const dataUrl = await blobToDataUrl(stitched);
  return [{ kind: 'data', dataUrl }];
}

/**
 * 顺序播放一段或多段
 * @returns {Promise<{ok:boolean, error?:string, interrupted?:boolean}>}
 */
function playItemsNow(channel, items, volume, options = {}) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (list.length === 0) return Promise.resolve({ ok: false, error: 'empty' });
  const canStitch = list.length > 1
    && typeof GmgnTtsSeam !== 'undefined'
    && typeof GmgnTtsSeam.stitchBlobs === 'function'
    && list.every((item) => !(item && typeof item === 'object' && item.kind === 'beep'));
  if (!canStitch) return playResolvedItemsNow(channel, list, volume, options);
  const stitchTimeoutMs = (typeof GmgnTtsSeam !== 'undefined' && GmgnTtsSeam.STITCH_TIMEOUT_MS) || 1500;
  let stitchTimer = null;
  const stitchWork = stitchPlaybackItems(list).catch(() => list);
  const stitchDeadline = new Promise((_, reject) => {
    stitchTimer = setTimeout(() => reject(new Error('stitch_timeout')), stitchTimeoutMs);
  });
  return Promise.race([stitchWork, stitchDeadline])
    .catch(() => list)
    .then((stitched) => playResolvedItemsNow(channel, stitched, volume, options))
    .finally(() => {
      if (stitchTimer) clearTimeout(stitchTimer);
    });
}

function playResolvedItemsNow(channel, items, volume, options = {}) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (list.length === 0) return Promise.resolve({ ok: false, error: 'empty' });

  const player = channel === 'exclusive' ? exclusivePlayer : ttsPlayer;
  const segmentGapMs = Number.isFinite(Number(options.segmentGapMs))
    ? Math.max(0, Math.min(200, Number(options.segmentGapMs)))
    : 28;
  const gen = channel === 'exclusive' ? ++exclusiveGen : ++ttsGen;
  const isCurrent = () => (channel === 'exclusive' ? exclusiveGen : ttsGen) === gen;

  stopPlayer(player);
  const vol = normalizeVolume(volume);
  const gain = ensurePlayerGain(channel, player);
  if (gain) {
    player.volume = 1;
    gain.gain.setValueAtTime(vol, gain.context.currentTime);
  } else {
    player.volume = Math.min(1, vol);
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      if (channel === 'exclusive' && exclusiveCancel) exclusiveCancel = null;
      if (channel === 'tts' && ttsCancel) ttsCancel = null;
      resolve(result);
    };

    const cancelThis = () => {
      settle({ ok: true, interrupted: true });
    };
    if (channel === 'exclusive') exclusiveCancel = cancelThis;
    else ttsCancel = cancelThis;

    // 🛡️ 看门狗：媒体元素卡死（onended/onerror 均不触发）时强制结算，
    // 防止单个异常任务永久堵死整条通道队列
    const PLAYBACK_WATCHDOG_MS = 45000;
    const watchdogTimer = setTimeout(() => {
      if (settled) return;
      console.warn(`[GMGN Offscreen] 播放看门狗超时，强制结束当前任务 | channel=${channel}`);
      if (channel === 'exclusive') exclusiveGen += 1;
      else ttsGen += 1;
      stopPlayer(player);
      settle({ ok: false, error: 'watchdog_timeout' });
    }, PLAYBACK_WATCHDOG_MS);

    let idx = 0;

    const finish = (ok, error) => {
      if (!isCurrent()) {
        // 已被更新任务取代
        settle({ ok: true, interrupted: true });
        return;
      }
      stopPlayer(player);
      settle(ok ? { ok: true } : { ok: false, error: error || 'play_failed' });
    };

    const playNext = () => {
      if (!isCurrent()) {
        settle({ ok: true, interrupted: true });
        return;
      }
      if (idx >= list.length) {
        finish(true);
        return;
      }
      const item = list[idx++];
      if (item && typeof item === 'object' && item.kind === 'beep') {
        playBeep(vol).then(playNext).catch(() => playNext());
        return;
      }
      const url = resolvePlayUrl(item);
      if (!url) {
        playNext();
        return;
      }
      player.src = url;
      player.onended = () => {
        if (!isCurrent()) {
          settle({ ok: true, interrupted: true });
          return;
        }
        if (idx >= list.length) {
          finish(true);
          return;
        }
        setTimeout(() => {
          if (isCurrent()) playNext();
          else settle({ ok: true, interrupted: true });
        }, segmentGapMs);
      };
      player.onerror = () => {
        if (!isCurrent()) {
          settle({ ok: true, interrupted: true });
          return;
        }
        if (idx >= list.length) finish(false, 'media_error');
        else playNext();
      };
      player.play().then(() => {
        /* playing */
      }).catch((e) => {
        if (!isCurrent()) {
          settle({ ok: true, interrupted: true });
          return;
        }
        finish(false, e && e.name ? e.name : 'play_rejected');
      });
    };

    playNext();
  });
}

function settleQueuedJob(job, result) {
  if (!job || job.settled) return;
  job.settled = true;
  job.resolve({
    ...result,
    queued: true,
    queueDepth: job.queueDepthAtEnqueue || 1
  });
}

function drainChannel(channel) {
  if (channelRunning[channel]) return;
  const now = Date.now();
  let job = channelQueues[channel].shift();
  while (job && job.expiresAt <= now) {
    console.warn(`[GMGN Offscreen] 丢弃过期任务 | channel=${channel}`);
    diagnosticLog('offscreen_job_expired', {
      ...(job.diagnostic || {}),
      source: job.source,
      traceId: job.traceId,
      channel,
      ageMs: now - job.createdAt
    });
    settleQueuedJob(job, { ok: false, error: 'expired' });
    job = channelQueues[channel].shift();
  }
  if (!job) return;

  channelRunning[channel] = true;
  const startedAt = Date.now();
  diagnosticLog('offscreen_job_start', {
    ...(job.diagnostic || {}),
    source: job.source,
    traceId: job.traceId,
    channel,
    queueWaitMs: startedAt - job.createdAt,
    wssToPlaybackMs: job.diagnostic && job.diagnostic.wssReceivedAt
      ? startedAt - job.diagnostic.wssReceivedAt
      : undefined,
    processingToPlaybackMs: job.diagnostic && job.diagnostic.processingStartedAt
      ? startedAt - job.diagnostic.processingStartedAt
      : undefined,
    queuedBehind: channelQueues[channel].length,
    segmentCount: Array.isArray(job.items) ? job.items.length : 1
  });
  playItemsNow(channel, job.items, job.volume, { segmentGapMs: job.segmentGapMs })
    .then((result) => {
      diagnosticLog('offscreen_job_done', {
        ...(job.diagnostic || {}),
        source: job.source,
        traceId: job.traceId,
        channel,
        durationMs: Date.now() - startedAt,
        ok: !!(result && result.ok),
        interrupted: !!(result && result.interrupted),
        error: result && result.error
      });
      settleQueuedJob(job, result || { ok: false, error: 'empty_result' });
    })
    .catch((error) => {
      console.warn('[GMGN Offscreen] 播放任务失败:', error);
      diagnosticLog('offscreen_job_done', {
        ...(job.diagnostic || {}),
        source: job.source,
        traceId: job.traceId,
        channel,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: String(error && error.message ? error.message : error)
      });
      settleQueuedJob(job, {
        ok: false,
        error: String(error && error.message ? error.message : error)
      });
    })
    .finally(() => {
      channelRunning[channel] = false;
      drainChannel(channel);
    });
}

function enqueueOnChannel(channel, items, volume, options = {}) {
  const now = Date.now();
  while (channelQueues[channel].length >= MAX_QUEUE_LENGTH) {
    const dropped = channelQueues[channel].shift();
    console.warn(`[GMGN Offscreen] 队列超限，丢弃最旧任务 | channel=${channel}`);
    diagnosticLog('offscreen_job_dropped', {
      ...((dropped && dropped.diagnostic) || {}),
      source: dropped && dropped.source,
      traceId: dropped && dropped.traceId,
      channel,
      reason: 'queue_limit'
    });
    settleQueuedJob(dropped, { ok: false, error: 'queue_limit' });
  }
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const job = {
    items,
    volume,
    createdAt: Number(options.createdAt) || now,
    expiresAt: Number(options.expiresAt) || now + DEFAULT_JOB_TTL_MS,
    source: options.source || 'unknown',
    segmentGapMs: options.segmentGapMs,
    traceId: options.traceId || '',
    diagnostic: options.diagnostic || {},
    settled: false,
    resolve: resolveCompletion,
    queueDepthAtEnqueue: 0
  };
  channelQueues[channel].push(job);
  drainChannel(channel);
  job.queueDepthAtEnqueue = channelQueues[channel].length + (channelRunning[channel] ? 1 : 0);
  diagnosticLog('offscreen_queue_depth', {
    ...(options.diagnostic || {}),
    source: options.source || 'unknown',
    traceId: options.traceId || '',
    channel,
    queueDepth: job.queueDepthAtEnqueue
  });
  return completion;
}

async function handlePlay(msg) {
  const channel = msg.channel === 'exclusive' ? 'exclusive' : 'tts';
  const items = msg.items || msg.urls || [];
  const volume = msg.volume;
  return enqueueOnChannel(channel, items, volume, msg);
}

/** 用户手势后预热：静音短音，建立 offscreen 可播状态 */
async function handleWarmup() {
  try {
    const a = new Audio(chrome.runtime.getURL('sounds/default.MP3'));
    a.volume = 0.001;
    await a.play().catch(() => {});
    a.pause();
    a.removeAttribute('src');
    a.load();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'OFFSCREEN_WARMUP') {
    handleWarmup().then(sendResponse);
    return true;
  }

  if (msg.type === 'OFFSCREEN_PLAY') {
    handlePlay(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    if (!msg.channel || msg.channel === 'tts') {
      channelQueues.tts.splice(0).forEach((job) => {
        settleQueuedJob(job, { ok: true, interrupted: true });
      });
      if (typeof ttsCancel === 'function') ttsCancel();
      ttsCancel = null;
      ttsGen += 1;
      stopPlayer(ttsPlayer);
    }
    if (!msg.channel || msg.channel === 'exclusive') {
      channelQueues.exclusive.splice(0).forEach((job) => {
        settleQueuedJob(job, { ok: true, interrupted: true });
      });
      if (typeof exclusiveCancel === 'function') exclusiveCancel();
      exclusiveCancel = null;
      exclusiveGen += 1;
      stopPlayer(exclusivePlayer);
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ⏱️ 保活节拍器：offscreen 文档不受后台标签页定时器强节流影响。
// 每 10s 通知 SW 向各 GMGN 标签页转发 WSS 心跳，防止后台页推送断线；
// 节拍消息同时反向保持 SW 活跃（每拍重置其空闲回收计时）。
const KEEPALIVE_TICK_MS = 10000;
setInterval(() => {
  try {
    chrome.runtime.sendMessage({ type: 'GMGN_KEEPALIVE_TICK' }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    // SW 重启瞬间可能失败，下一拍自动重试
  }
}, KEEPALIVE_TICK_MS);

if (debugLoggingEnabled) console.log('[GMGN Offscreen] 后台播报文档已就绪');

/**
 * Offscreen 双通道播报
 * - exclusive：专属铃（互不打断 TTS）
 * - tts：TTS / 默认 ding
 * 仅由 background 转发 content 的 OFFSCREEN_* 消息
 *
 * 注意：同通道新任务会打断旧任务；必须 settle 旧 Promise，避免 content 调度器永远等不到 onComplete
 */

const exclusivePlayer = new Audio();
const ttsPlayer = new Audio();
let exclusiveGen = 0;
let ttsGen = 0;
/** @type {null | (() => void)} */
let exclusiveCancel = null;
/** @type {null | (() => void)} */
let ttsCancel = null;

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

/**
 * 顺序播放一段或多段
 * @returns {Promise<{ok:boolean, error?:string, interrupted?:boolean}>}
 */
function playOnChannel(channel, items, volume) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (list.length === 0) return Promise.resolve({ ok: false, error: 'empty' });

  // 打断同通道上一段：先 cancel 旧 Promise，再停播放器
  if (channel === 'exclusive' && typeof exclusiveCancel === 'function') {
    exclusiveCancel();
    exclusiveCancel = null;
  }
  if (channel === 'tts' && typeof ttsCancel === 'function') {
    ttsCancel();
    ttsCancel = null;
  }

  const player = channel === 'exclusive' ? exclusivePlayer : ttsPlayer;
  const gen = channel === 'exclusive' ? ++exclusiveGen : ++ttsGen;
  const isCurrent = () => (channel === 'exclusive' ? exclusiveGen : ttsGen) === gen;

  stopPlayer(player);
  const vol = Math.max(0, Math.min(Number(volume) || 1, 1.5));
  player.volume = Math.min(1, vol);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (channel === 'exclusive' && exclusiveCancel) exclusiveCancel = null;
      if (channel === 'tts' && ttsCancel) ttsCancel = null;
      resolve(result);
    };

    const cancelThis = () => {
      settle({ ok: true, interrupted: true });
    };
    if (channel === 'exclusive') exclusiveCancel = cancelThis;
    else ttsCancel = cancelThis;

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
      const url = resolvePlayUrl(list[idx++]);
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
        setTimeout(() => {
          if (isCurrent()) playNext();
          else settle({ ok: true, interrupted: true });
        }, 28);
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

async function handlePlay(msg) {
  const channel = msg.channel === 'exclusive' ? 'exclusive' : 'tts';
  const items = msg.items || msg.urls || [];
  const volume = msg.volume;
  return playOnChannel(channel, items, volume);
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
    handlePlay(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP') {
    if (!msg.channel || msg.channel === 'tts') {
      if (typeof ttsCancel === 'function') ttsCancel();
      ttsCancel = null;
      ttsGen += 1;
      stopPlayer(ttsPlayer);
    }
    if (!msg.channel || msg.channel === 'exclusive') {
      if (typeof exclusiveCancel === 'function') exclusiveCancel();
      exclusiveCancel = null;
      exclusiveGen += 1;
      stopPlayer(exclusivePlayer);
    }
    sendResponse({ ok: true });
    return true;
  }
});

console.log('[GMGN Offscreen] 后台播报文档已就绪');

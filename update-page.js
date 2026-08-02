/**
 * update.html 页面逻辑（必须外置脚本：MV3 扩展页 CSP 禁止 inline script）
 */
(function () {
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    let version = '0.0.0';
    let reason = '';
    let prev = '';

    try {
        const params = new URLSearchParams(location.search || '');
        reason = params.get('reason') || '';
        prev = params.get('from') || '';
        const fromQuery = params.get('v');
        if (fromQuery) {
            version = fromQuery;
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
            version = chrome.runtime.getManifest().version || version;
        }
    } catch (e) {
        console.warn('[GMGN update] 解析参数失败', e);
    }

    const verBadge = document.getElementById('verBadge');
    if (verBadge) verBadge.textContent = 'v' + version;

    const reasonEl = document.getElementById('reasonText');
    if (reasonEl) {
        if (reason === 'install') {
            reasonEl.textContent = ' · 首次安装，欢迎使用';
        } else if (prev) {
            reasonEl.textContent = ' · 从 v' + prev + ' 升级';
        } else if (reason === 'update') {
            reasonEl.textContent = ' · 版本已升级';
        } else if (reason === 'manual' || reason === 'popup_fallback') {
            reasonEl.textContent = ' · 更新说明';
        }
    }

    const getNotes =
        typeof gmgnGetNotesForVersion === 'function'
            ? gmgnGetNotesForVersion
            : function () {
                  return ['更新说明数据未加载，请重新加载扩展后重试。'];
              };
    const sorted =
        typeof gmgnSortedVersions === 'function'
            ? gmgnSortedVersions
            : function () {
                  return [];
              };

    const lines = getNotes(version);
    const mainList = document.getElementById('mainList');
    if (mainList) {
        mainList.innerHTML = lines.map((t) => '<li>' + escapeHtml(t) + '</li>').join('');
    }

    const history = document.getElementById('historyList');
    if (history) {
        const versions = sorted().filter((v) => v !== version);
        history.innerHTML =
            versions
                .map((v) => {
                    const notes = getNotes(v);
                    return (
                        '<details><summary>v' +
                        escapeHtml(v) +
                        '</summary><ul>' +
                        notes.map((t) => '<li>' + escapeHtml(t) + '</li>').join('') +
                        '</ul></details>'
                    );
                })
                .join('') || '<p class="meta">暂无更早记录</p>';
    }

    function markSeen() {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.set({
            lastAcknowledgedVersion: version,
            lastChangelogTabVersion: version,
            updateNotice: {
                version,
                needShow: false,
                shownAt: Date.now(),
                reason: reason || 'tab'
            }
        });
    }

    const btnGotIt = document.getElementById('btnGotIt');
    if (btnGotIt) {
        btnGotIt.addEventListener('click', () => {
            markSeen();
            window.close();
            setTimeout(() => {
                btnGotIt.textContent = '已记录，可手动关闭标签页';
            }, 200);
        });
    }

    const btnOpenPopup = document.getElementById('btnOpenPopup');
    if (btnOpenPopup) {
        btnOpenPopup.addEventListener('click', () => {
            markSeen();
            alert('请点击浏览器工具栏的 🍉 图标打开设置面板。');
        });
    }

    // 打开本页即视为已看到
    markSeen();
    console.log('[GMGN update] 更新说明页已渲染', version, 'notes=', lines.length);
})();

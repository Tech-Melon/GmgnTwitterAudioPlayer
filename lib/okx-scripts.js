(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnOkxScripts = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';
    // OKX 是可选平台：web3.okx.com 走 optional_host_permissions，
    // 升级时不新增权限提示、不会被 Chrome 停用；用户在 popup 打开「OKX 钱包」时才授权，
    // 授权后由 Service Worker 动态注册内容脚本（与 manifest 静态注入等价）。
    const ORIGIN = '*://web3.okx.com/*';
    const MAIN_ID = 'gmgn-okx-main';
    const ISOLATED_ID = 'gmgn-okx-isolated';
    const MAIN_JS = Object.freeze([
        'lib/twitter-event.js',
        'lib/okx-twitter.js',
        'lib/okx-wallet.js',
        'inject-okx.js'
    ]);
    const FALLBACK_ISOLATED_JS = Object.freeze([
        'lib/wallet-event.js',
        'lib/multi-wallet-buy.js',
        'lib/tts-seam.js',
        'lib/twitter-play-priority.js',
        'content.js'
    ]);
    /** 与 manifest 中 content.js 那组静态脚本保持一致，避免两处清单漂移 */
    function resolveIsolatedJs(manifest) {
        const scripts = manifest && Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
        const entry = scripts.find((script) => Array.isArray(script.js) && script.js.includes('content.js'));
        return entry ? entry.js.slice() : FALLBACK_ISOLATED_JS.slice();
    }
    function buildScripts(manifest) {
        return [
            {
                id: MAIN_ID,
                matches: [ORIGIN],
                js: MAIN_JS.slice(),
                runAt: 'document_start',
                world: 'MAIN',
                persistAcrossSessions: true
            },
            {
                id: ISOLATED_ID,
                matches: [ORIGIN],
                js: resolveIsolatedJs(manifest),
                runAt: 'document_start',
                world: 'ISOLATED',
                persistAcrossSessions: true
            }
        ];
    }
    function callApi(fn, thisArg, args) {
        return new Promise((resolve, reject) => {
            try {
                const maybePromise = fn.apply(thisArg, args.concat((result) => {
                    const lastError = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
                    if (lastError) reject(new Error(lastError.message));
                    else resolve(result);
                }));
                if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(resolve, reject);
            } catch (error) {
                reject(error);
            }
        });
    }
    /**
     * 幂等同步：有权限 → 确保已注册（脚本清单变化时重注册）；无权限 → 注销。
     * @returns {Promise<'registered'|'unchanged'|'unregistered'|'absent'>}
     */
    async function syncRegistration(chromeApi) {
        const api = chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
        if (!api || !api.scripting || !api.permissions) return 'absent';
        const granted = await callApi(api.permissions.contains, api.permissions, [{ origins: [ORIGIN] }]);
        const ids = [MAIN_ID, ISOLATED_ID];
        const existing = await callApi(api.scripting.getRegisteredContentScripts, api.scripting, [{ ids }]) || [];
        if (granted !== true) {
            if (existing.length === 0) return 'absent';
            await callApi(api.scripting.unregisterContentScripts, api.scripting, [{ ids: existing.map((s) => s.id) }]);
            return 'unregistered';
        }
        const wanted = buildScripts(api.runtime && api.runtime.getManifest ? api.runtime.getManifest() : null);
        const sameJs = (a, b) => Array.isArray(a) && Array.isArray(b) && a.join('|') === b.join('|');
        const upToDate = wanted.every((script) => {
            const found = existing.find((item) => item.id === script.id);
            return found && sameJs(found.js, script.js) && (found.world || 'ISOLATED') === script.world;
        });
        if (upToDate) return 'unchanged';
        if (existing.length > 0) {
            await callApi(api.scripting.unregisterContentScripts, api.scripting, [{ ids: existing.map((s) => s.id) }]);
        }
        await callApi(api.scripting.registerContentScripts, api.scripting, [wanted]);
        return 'registered';
    }
    return {
        ORIGIN,
        MAIN_ID,
        ISOLATED_ID,
        MAIN_JS,
        buildScripts,
        syncRegistration
    };
});

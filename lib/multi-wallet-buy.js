(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnMultiWalletBuy = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    // 多钱包同买提醒：同一 CA 在统计时长内被 N 个不同关注钱包买入 → 播一条提醒。
    // 每次触发后清空本轮钱包重新统计；播满 maxAlerts 次后该 CA 冷却 cooldownMin 分钟，冷却结束全部清零。
    const DEFAULT_TEMPLATE = '{chain}{wallet}等{count}个钱包同时买入{token}，请留意';
    const LIMITS = {
        windowSec: { min: 10, max: 600, def: 60 },
        minWallets: { min: 2, max: 10, def: 3 },
        maxAlerts: { min: 1, max: 10, def: 3 },
        cooldownMin: { min: 1, max: 120, def: 10 }
    };
    const MAX_TEMPLATE_LEN = 120;
    const MAX_LISTED_WALLETS = 5;
    const SWEEP_INTERVAL_MS = 30 * 1000;

    function clampInt(value, limit) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return limit.def;
        return Math.min(limit.max, Math.max(limit.min, n));
    }

    function normalizeTemplate(value) {
        const text = String(value == null ? '' : value).trim().slice(0, MAX_TEMPLATE_LEN);
        return text || DEFAULT_TEMPLATE;
    }

    function normalizeConfig(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        return {
            enabled: src.enabled === true,
            windowSec: clampInt(src.windowSec, LIMITS.windowSec),
            minWallets: clampInt(src.minWallets, LIMITS.minWallets),
            maxAlerts: clampInt(src.maxAlerts, LIMITS.maxAlerts),
            cooldownMin: clampInt(src.cooldownMin, LIMITS.cooldownMin),
            template: normalizeTemplate(src.template)
        };
    }

    function formatWindowText(windowSec) {
        const sec = Number(windowSec) || 0;
        if (sec >= 60 && sec % 60 === 0) return `${sec / 60}分钟`;
        return `${sec}秒`;
    }

    /** 替换模板变量；未写变量的模板原样返回，交给 TTS 直接合成。 */
    function renderTemplate(template, vars) {
        const v = vars && typeof vars === 'object' ? vars : {};
        const names = Array.isArray(v.walletNames) ? v.walletNames.filter(Boolean) : [];
        const listed = names.slice(0, MAX_LISTED_WALLETS).join('、');
        const values = {
            token: String(v.token || '代币'),
            count: String(Number(v.count) || names.length || 0),
            wallet: String(v.wallet || names[names.length - 1] || ''),
            wallets: names.length > MAX_LISTED_WALLETS ? `${listed}等` : listed,
            chain: String(v.chain || ''),
            window: formatWindowText(v.windowSec)
        };
        const text = normalizeTemplate(template).replace(/\{(token|count|wallet|wallets|chain|window)\}/g,
            (_, key) => values[key]);
        return text.replace(/\s+/g, ' ').trim();
    }

    function createEntry() {
        return { wallets: new Map(), alerts: 0, cooldownUntil: 0, lastActiveAt: 0, seenTx: new Map() };
    }

    function createTracker() {
        const entries = new Map();
        let lastSweepAt = 0;

        function sweep(now, cfg) {
            if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
            lastSweepAt = now;
            const idleMs = cfg.windowSec * 1000 + cfg.cooldownMin * 60 * 1000;
            entries.forEach((entry, key) => {
                if (entry.cooldownUntil > now) return;
                if (now - entry.lastActiveAt > idleMs) entries.delete(key);
            });
        }

        /**
         * 记录一笔关注钱包的买入。
         * @returns {{triggered: boolean, reason?: string, count?: number, walletNames?: string[],
         *   alertIndex?: number, cooldownStarted?: boolean, replay?: boolean}}
         */
        function record(rawConfig, buy) {
            const cfg = normalizeConfig(rawConfig);
            if (!cfg.enabled) return { triggered: false, reason: 'disabled' };
            if (!buy || !buy.key || !buy.wallet) return { triggered: false, reason: 'invalid' };
            const now = buy.now != null && Number.isFinite(Number(buy.now)) ? Number(buy.now) : Date.now();
            const windowMs = cfg.windowSec * 1000;
            sweep(now, cfg);

            let entry = entries.get(buy.key);
            if (entry && entry.cooldownUntil > 0 && now >= entry.cooldownUntil) {
                entries.delete(buy.key);
                entry = null;
            }
            if (!entry) {
                entry = createEntry();
                entries.set(buy.key, entry);
            }
            entry.lastActiveAt = now;

            entry.seenTx.forEach((seen, txKey) => {
                if (now - seen.at > windowMs) entry.seenTx.delete(txKey);
            });
            // 同一笔交易的 processed/confirm/重试只算一次；若当初触发过提醒，重试时原样返回以便补播。
            if (buy.txKey && entry.seenTx.has(buy.txKey)) {
                const seen = entry.seenTx.get(buy.txKey);
                return seen.alert
                    ? { ...seen.alert, replay: true }
                    : { triggered: false, reason: 'duplicate_tx' };
            }
            if (entry.cooldownUntil > now) {
                return { triggered: false, reason: 'cooldown', cooldownLeftMs: entry.cooldownUntil - now };
            }
            const seenRecord = { at: now, alert: null };
            if (buy.txKey) entry.seenTx.set(buy.txKey, seenRecord);

            entry.wallets.forEach((info, wallet) => {
                if (now - info.at > windowMs) entry.wallets.delete(wallet);
            });
            const existing = entry.wallets.get(buy.wallet);
            entry.wallets.set(buy.wallet, {
                name: String(buy.name || (existing && existing.name) || ''),
                at: now
            });
            const count = entry.wallets.size;
            if (count < cfg.minWallets) return { triggered: false, reason: 'below_threshold', count };

            // 触发钱包放在最后，模板 {wallet} 取触发者。
            const walletNames = Array.from(entry.wallets.entries())
                .filter(([wallet]) => wallet !== buy.wallet)
                .map(([, info]) => info.name)
                .concat(entry.wallets.get(buy.wallet).name)
                .filter(Boolean);
            entry.wallets.clear();
            entry.alerts += 1;
            const cooldownStarted = entry.alerts >= cfg.maxAlerts;
            if (cooldownStarted) entry.cooldownUntil = now + cfg.cooldownMin * 60 * 1000;
            const alert = {
                triggered: true,
                count,
                walletNames,
                alertIndex: entry.alerts,
                cooldownStarted
            };
            seenRecord.alert = alert;
            return alert;
        }

        function serialize() {
            return Array.from(entries.entries()).map(([key, entry]) => [key, {
                wallets: Array.from(entry.wallets.entries()),
                alerts: entry.alerts,
                cooldownUntil: entry.cooldownUntil,
                lastActiveAt: entry.lastActiveAt,
                seenTx: Array.from(entry.seenTx.entries())
            }]);
        }

        function restore(data) {
            if (!Array.isArray(data)) return;
            entries.clear();
            data.forEach((pair) => {
                if (!Array.isArray(pair) || pair.length !== 2 || !pair[1]) return;
                const src = pair[1];
                const entry = createEntry();
                if (Array.isArray(src.wallets)) src.wallets.forEach(([k, v]) => entry.wallets.set(k, v));
                if (Array.isArray(src.seenTx)) src.seenTx.forEach(([k, v]) => entry.seenTx.set(k, v));
                entry.alerts = Number(src.alerts) || 0;
                entry.cooldownUntil = Number(src.cooldownUntil) || 0;
                entry.lastActiveAt = Number(src.lastActiveAt) || 0;
                entries.set(pair[0], entry);
            });
        }

        return { record, serialize, restore, size: () => entries.size };
    }

    return {
        DEFAULT_TEMPLATE,
        LIMITS,
        normalizeConfig,
        renderTemplate,
        formatWindowText,
        createTracker
    };
});

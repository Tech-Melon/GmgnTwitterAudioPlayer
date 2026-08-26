(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnWalletEvent = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';

    const SUPPORTED_WALLET_CHAINS = Object.freeze([
        { id: 'sol', label: 'SOL', mark: 'S', color: '#14f195', textColor: '#101214' },
        { id: 'bsc', label: 'BSC', mark: 'B', color: '#f0b90e', textColor: '#171717' },
        { id: 'base', label: 'Base', mark: 'B', color: '#0052ff', textColor: '#ffffff' },
        { id: 'eth', label: 'ETH', mark: 'E', color: '#627eea', textColor: '#ffffff' },
        { id: 'robinhood', label: 'Robinhood', mark: 'R', color: '#ccff00', textColor: '#111111' },
        { id: 'stable', label: 'Stable', mark: 'S', color: '#007b4f', textColor: '#ffffff' },
        { id: 'arc', label: 'Arc', mark: 'A', color: '#2775ca', textColor: '#ffffff' },
        { id: 'xlayer', label: 'X Layer', mark: 'X', color: '#18181a', textColor: '#ffffff' },
        { id: 'hyperevm', label: 'HyperEVM', mark: 'H', color: '#97fce4', textColor: '#111111' },
        { id: 'megaeth', label: 'MegaETH', mark: 'M', color: '#f044c7', textColor: '#ffffff' },
        { id: 'monad', label: 'Monad', mark: 'M', color: '#836ef9', textColor: '#ffffff' },
        { id: 'tron', label: 'Tron', mark: 'T', color: '#fc070c', textColor: '#ffffff' }
    ]);
    const SUPPORTED_WALLET_CHAIN_IDS = new Set(SUPPORTED_WALLET_CHAINS.map((chain) => chain.id));
    const DEFAULT_WALLET_CHAINS = Object.freeze(['sol', 'eth', 'bsc', 'robinhood', 'base']);
    const DEFAULT_ANNOUNCE_GAP_MS = 250;
    const MIN_ANNOUNCE_GAP_MS = 0;
    const MAX_ANNOUNCE_GAP_MS = 1000;
    const WALLET_CHAIN_ALIASES = Object.freeze({
        solana: 'sol',
        ethereum: 'eth',
        binance: 'bsc',
        binancesmartchain: 'bsc'
    });
    const CUSTOM_CHAIN_COLORS = Object.freeze([
        { color: '#7c5cff', textColor: '#ffffff' },
        { color: '#ff6b35', textColor: '#ffffff' },
        { color: '#00c2a8', textColor: '#10231f' },
        { color: '#ff4d8d', textColor: '#ffffff' },
        { color: '#3d8bfd', textColor: '#ffffff' },
        { color: '#f5a524', textColor: '#171717' },
        { color: '#8b5cf6', textColor: '#ffffff' },
        { color: '#14b8a6', textColor: '#082f2b' }
    ]);
    const CUSTOM_CHAIN_ID_PATTERN = /^[a-z][a-z0-9]{1,31}$/;

    function normalizeChain(chain) {
        const normalized = String(chain || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        return WALLET_CHAIN_ALIASES[normalized] || normalized;
    }

    function isValidCustomChainId(chainId) {
        return CUSTOM_CHAIN_ID_PATTERN.test(chainId);
    }

    function colorFromChainId(chainId) {
        let hash = 2166136261;
        const text = String(chainId || '');
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return CUSTOM_CHAIN_COLORS[(hash >>> 0) % CUSTOM_CHAIN_COLORS.length];
    }

    function isCssColor(value) {
        return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(String(value || '').trim());
    }

    function normalizeCustomChain(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const id = normalizeChain(raw.id);
        if (!isValidCustomChainId(id) || SUPPORTED_WALLET_CHAIN_IDS.has(id)) return null;
        const label = String(raw.label || id).trim().slice(0, 24) || id.toUpperCase();
        const markSource = String(raw.mark || label || id).trim();
        const mark = (markSource.slice(0, 2) || id.slice(0, 1)).toUpperCase();
        const palette = colorFromChainId(id);
        return {
            id,
            label,
            mark,
            color: isCssColor(raw.color) ? String(raw.color).trim() : palette.color,
            textColor: isCssColor(raw.textColor) ? String(raw.textColor).trim() : palette.textColor,
            custom: true
        };
    }

    function normalizeCustomChains(rawChains) {
        const seen = new Set();
        const result = [];
        (Array.isArray(rawChains) ? rawChains : []).forEach((raw) => {
            const chain = normalizeCustomChain(raw);
            if (!chain || seen.has(chain.id)) return;
            seen.add(chain.id);
            result.push(chain);
        });
        return result;
    }

    function getChainCatalog(customChains) {
        return SUPPORTED_WALLET_CHAINS.concat(normalizeCustomChains(customChains));
    }

    function getKnownChainIds(customChains) {
        const ids = new Set(SUPPORTED_WALLET_CHAIN_IDS);
        normalizeCustomChains(customChains).forEach((chain) => ids.add(chain.id));
        return ids;
    }

    function findCatalogChain(chainId, customChains) {
        const id = normalizeChain(chainId);
        if (!id) return null;
        return getChainCatalog(customChains).find((chain) => chain.id === id) || null;
    }

    function getDefaultChainSpeakAs(chainId, customChains) {
        const found = findCatalogChain(chainId, customChains);
        if (found) return String(found.label || '').trim();
        const id = normalizeChain(chainId);
        return id ? id.toUpperCase() : '';
    }

    function getChainSpeakAs(chainId, speakAsMap, customChains) {
        const id = normalizeChain(chainId);
        if (!id) return '';
        if (speakAsMap && Object.prototype.hasOwnProperty.call(speakAsMap, id)) {
            return String(speakAsMap[id] == null ? '' : speakAsMap[id]).trim();
        }
        return getDefaultChainSpeakAs(id, customChains);
    }

    function normalizeChainSpeakAsMap(rawMap) {
        const source = rawMap && typeof rawMap === 'object' ? rawMap : {};
        const normalized = {};
        Object.keys(source).forEach((key) => {
            const id = normalizeChain(key);
            if (!id) return;
            normalized[id] = String(source[key] == null ? '' : source[key]).trim();
        });
        return normalized;
    }

    function normalizeChainSpeakOnMap(rawMap) {
        const source = rawMap && typeof rawMap === 'object' ? rawMap : {};
        const normalized = {};
        Object.keys(source).forEach((key) => {
            const id = normalizeChain(key);
            if (!id) return;
            normalized[id] = source[key] === true;
        });
        return normalized;
    }

    function isChainSpeakOn(chainId, speakOnMap) {
        const id = normalizeChain(chainId);
        if (!id || !speakOnMap || typeof speakOnMap !== 'object') return false;
        return speakOnMap[id] === true;
    }

    function resolveChainSpeakAs(chainId, settings) {
        const cfg = settings && typeof settings === 'object' ? settings : {};
        if (cfg.chainSpeakEnabled !== true) return '';
        const id = normalizeChain(chainId);
        if (!id || !isChainSpeakOn(id, cfg.chainSpeakOn)) return '';
        return getChainSpeakAs(id, cfg.chainSpeakAs, cfg.customChains);
    }

    function collectEnabledSpeakAsTexts(settings) {
        const cfg = settings && typeof settings === 'object' ? settings : {};
        if (cfg.chainSpeakEnabled !== true) return [];
        return normalizeEnabledChains(cfg.walletChains, cfg.customChains)
            .map((chainId) => resolveChainSpeakAs(chainId, cfg))
            .filter(Boolean);
    }

    function normalizeAnnounceGapMs(value) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed)) return DEFAULT_ANNOUNCE_GAP_MS;
        return Math.min(MAX_ANNOUNCE_GAP_MS, Math.max(MIN_ANNOUNCE_GAP_MS, parsed));
    }

    function normalizeEnabledChains(enabledChains, customChains) {
        const knownIds = getKnownChainIds(customChains);
        const source = Array.isArray(enabledChains) ? enabledChains : DEFAULT_WALLET_CHAINS;
        return Array.from(new Set(source
            .map(normalizeChain)
            .filter((chain) => knownIds.has(chain))));
    }

    function isChainEnabled(itemOrChain, enabledChains, customChains) {
        const chain = normalizeChain(
            itemOrChain && typeof itemOrChain === 'object' ? itemOrChain.n : itemOrChain
        );
        return Boolean(chain) && normalizeEnabledChains(enabledChains, customChains).includes(chain);
    }

    function hashPayload(value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function getActivityKey(item) {
        if (!item) return 'unknown';
        return String(item.id || item.si || item.ba || item.a || item.bs || 'unknown').toLowerCase();
    }

    function buildEventId(item) {
        if (item && item.h) {
            const chain = normalizeChain(item.n) || 'unknown';
            return `wallet_${chain}_${item.h}_${hashPayload(getActivityKey(item))}_${item.cnt || 'any'}`;
        }
        return `wallet_fallback_${hashPayload(item || {})}`;
    }

    function buildTransactionKey(item) {
        if (!item || !item.h) return null;
        const chain = normalizeChain(item.n) || 'unknown';
        return `${chain}_${item.h}_${getActivityKey(item)}`;
    }

    function isTokenBlocked(item, blockedSymbols) {
        if (!item || !Array.isArray(blockedSymbols) || blockedSymbols.length === 0) return false;
        const token = String(item.bs || '').trim().toLowerCase();
        if (!token) return false;
        return blockedSymbols.some((symbol) => String(symbol).trim().toLowerCase() === token);
    }

    function resolveSpeechPrefix(source) {
        if (!source || typeof source !== 'object') return '';
        if (Object.prototype.hasOwnProperty.call(source, 'chainSpeakAs')) {
            return String(source.chainSpeakAs == null ? '' : source.chainSpeakAs).trim();
        }
        return '';
    }

    function buildSingleSpeechParts(item) {
        if (!item) return [];
        const rename = String(item.rename || '').trim();
        const tokenSymbol = String(item.tokenSymbol || '代币').trim() || '代币';
        if (!rename) return [];
        const prefix = resolveSpeechPrefix(item);
        const leading = prefix ? [prefix] : [];
        if (item.action === 'buy') return leading.concat(rename, `买入${tokenSymbol}`);
        const action = item.ooc === 1 ? '清仓' : '减仓';
        return leading.concat(rename, `${action}${tokenSymbol}`);
    }

    function buildSpeechGroupParts(group) {
        if (!group || !(group.nameCounts instanceof Map)) return [];
        const names = Array.from(group.nameCounts.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, count]) => count > 1 ? `${name}${count}笔` : name)
            .join('、');
        if (!names) return [];
        let action = '买入';
        if (group.groupAction === 'sellProcessed') action = '减仓';
        if (group.groupAction === 'sellReduce') action = '减仓';
        if (group.groupAction === 'sellClear') action = '清仓';
        const tokenSymbol = String(group.tokenSymbol || '代币').trim() || '代币';
        const prefix = resolveSpeechPrefix(group);
        const leading = prefix ? [prefix] : [];
        return leading.concat(names, `${action}${tokenSymbol}`);
    }

    function formatSpeechGroup(group) {
        return buildSpeechGroupParts(group).join('');
    }

    function formatCompactSpeechGroups(groups, totalItemCount, options = {}) {
        const maxGroups = Math.max(1, Number(options.maxGroups) || 3);
        const maxNames = Math.max(1, Number(options.maxNames) || 3);
        const sortedGroups = (Array.isArray(groups) ? groups : [])
            .filter((group) => group && group.nameCounts instanceof Map)
            .sort((left, right) => (Number(right.lastQueuedAt) || 0) - (Number(left.lastQueuedAt) || 0));
        const selectedGroups = sortedGroups.slice(0, maxGroups);
        let announcedItems = 0;

        const announcements = selectedGroups.map((group) => {
            const entries = Array.from(group.nameCounts.entries())
                .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
            const groupItemCount = Number(group.itemCount)
                || entries.reduce((sum, [, count]) => sum + Number(count || 0), 0);
            announcedItems += groupItemCount;
            const visibleEntries = entries.slice(0, maxNames);
            let names = visibleEntries
                .map(([name, count]) => count > 1 ? `${name}${count}笔` : name)
                .join('、');
            if (entries.length > visibleEntries.length) names += `等${groupItemCount}笔`;
            const prefix = resolveSpeechPrefix(group);
            const parts = buildSpeechGroupParts(group);
            const actionToken = parts[parts.length - 1] || '';
            return `${prefix}${names}${actionToken}`;
        }).filter(Boolean);

        const total = Math.max(Number(totalItemCount) || 0, announcedItems);
        const omittedItems = Math.max(0, total - announcedItems);
        if (omittedItems > 0) announcements.push(`另${omittedItems}笔异动`);
        return announcements.join('，');
    }

    function splitFreshItems(items, now, maxAgeMs) {
        const currentTime = Number(now);
        const ageLimit = Math.max(0, Number(maxAgeMs) || 0);
        const result = { fresh: [], stale: [] };
        (Array.isArray(items) ? items : []).filter(Boolean).forEach((item) => {
            const eventStartedAt = Number(item.wssReceivedAt)
                || Number(item._queuedAt)
                || currentTime;
            const target = (currentTime - eventStartedAt) < ageLimit
                ? result.fresh
                : result.stale;
            target.push(item);
        });
        return result;
    }

    async function playResolvedSegmentsInOrder(segmentPromises, playSegment) {
        const promises = Array.isArray(segmentPromises) ? segmentPromises : [];
        if (promises.length === 0) throw new Error('empty_segments');
        for (let index = 0; index < promises.length; index += 1) {
            const segment = await promises[index];
            if (!segment) throw new Error(`segment_${index}_unavailable`);
            const result = await playSegment(segment, index, promises.length);
            if (result === false || (result && result.ok === false)) {
                const reason = result && result.error ? `:${result.error}` : '';
                throw new Error(`segment_${index}_playback_failed${reason}`);
            }
        }
        return { ok: true, count: promises.length };
    }

    async function playProgressiveSegmentGroups(segmentPromises, playGroup, options = {}) {
        const promises = Array.isArray(segmentPromises) ? segmentPromises : [];
        if (promises.length === 0) throw new Error('empty_segments');
        const greedy = options && options.greedy === true;
        const tracked = promises.map((promise) => {
            const state = { settled: false, value: null, error: null };
            const wrapped = Promise.resolve(promise).then(
                (value) => {
                    state.settled = true;
                    state.value = value;
                    return value;
                },
                (error) => {
                    state.settled = true;
                    state.error = error;
                    throw error;
                }
            );
            return { promise: wrapped, state };
        });
        const scheduledPlaybacks = [];
        let index = 0;

        while (index < tracked.length) {
            const first = await tracked[index].promise;
            if (!first) throw new Error(`segment_${index}_unavailable`);
            const startIndex = index;
            const group = [first];
            index += 1;
            if (greedy) {
                while (index < tracked.length && tracked[index].state.settled) {
                    if (tracked[index].state.error || !tracked[index].state.value) break;
                    group.push(tracked[index].state.value);
                    index += 1;
                }
            }
            const groupStart = startIndex;
            scheduledPlaybacks.push(Promise.resolve(playGroup(group, {
                startIndex: groupStart,
                segmentCount: group.length,
                totalSegments: promises.length
            })).then((result) => ({ index: groupStart, result })).catch((error) => ({ index: groupStart, error })));
        }

        for (const scheduledPlayback of scheduledPlaybacks) {
            const playback = await scheduledPlayback;
            if (playback.error) throw playback.error;
            const result = playback.result;
            if (result === false || (result && result.ok === false)) {
                const reason = result && result.error ? `:${result.error}` : '';
                throw new Error(`segment_${playback.index}_playback_failed${reason}`);
            }
        }

        return { ok: true, count: promises.length, playbackGroups: scheduledPlaybacks.length };
    }

    function mergePendingSellConfirm(processedItem, confirmItem) {
        if (!processedItem || !confirmItem) return false;
        if (!processedItem.txStateKey || processedItem.txStateKey !== confirmItem.txStateKey) return false;
        if (processedItem.action !== 'sell' || processedItem.cnt !== 'processed') return false;
        const eventIds = Array.from(new Set([
            ...(Array.isArray(processedItem._coordinatorEventIds)
                ? processedItem._coordinatorEventIds
                : []),
            processedItem._coordinatorEventId,
            ...(Array.isArray(confirmItem._coordinatorEventIds)
                ? confirmItem._coordinatorEventIds
                : []),
            confirmItem._coordinatorEventId
        ].filter(Boolean)));
        processedItem._coordinatorEventIds = eventIds;
        processedItem._coordinatorEventId = eventIds[0] || null;
        processedItem.cnt = null;
        processedItem.ooc = confirmItem.ooc;
        processedItem.wssReceivedAt = Math.min(
            Number(processedItem.wssReceivedAt) || Date.now(),
            Number(confirmItem.wssReceivedAt) || Date.now()
        );
        processedItem._processingState = 'processing_confirm';
        processedItem._successState = true;
        return true;
    }

    return {
        SUPPORTED_WALLET_CHAINS,
        DEFAULT_WALLET_CHAINS,
        DEFAULT_ANNOUNCE_GAP_MS,
        MIN_ANNOUNCE_GAP_MS,
        MAX_ANNOUNCE_GAP_MS,
        normalizeAnnounceGapMs,
        CUSTOM_CHAIN_ID_PATTERN,
        normalizeChain,
        isValidCustomChainId,
        normalizeCustomChain,
        normalizeCustomChains,
        getChainCatalog,
        getKnownChainIds,
        getDefaultChainSpeakAs,
        getChainSpeakAs,
        normalizeChainSpeakAsMap,
        normalizeChainSpeakOnMap,
        isChainSpeakOn,
        resolveChainSpeakAs,
        collectEnabledSpeakAsTexts,
        normalizeEnabledChains,
        isChainEnabled,
        hashPayload,
        getActivityKey,
        buildEventId,
        buildTransactionKey,
        isTokenBlocked,
        buildSingleSpeechParts,
        buildSpeechGroupParts,
        formatSpeechGroup,
        formatCompactSpeechGroups,
        splitFreshItems,
        playResolvedSegmentsInOrder,
        playProgressiveSegmentGroups,
        mergePendingSellConfirm
    };
});

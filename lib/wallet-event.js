(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnWalletEvent = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';

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
            return `wallet_${item.h}_${hashPayload(getActivityKey(item))}_${item.cnt || 'any'}`;
        }
        return `wallet_fallback_${hashPayload(item || {})}`;
    }

    function buildTransactionKey(item) {
        if (!item || !item.h) return null;
        return `${item.h}_${getActivityKey(item)}`;
    }

    function isTokenBlocked(item, blockedSymbols) {
        if (!item || !Array.isArray(blockedSymbols) || blockedSymbols.length === 0) return false;
        const token = String(item.bs || '').trim().toLowerCase();
        if (!token) return false;
        return blockedSymbols.some((symbol) => String(symbol).trim().toLowerCase() === token);
    }

    function buildSingleSpeechParts(item) {
        if (!item) return [];
        const rename = String(item.rename || '').trim();
        const tokenSymbol = String(item.tokenSymbol || '代币').trim() || '代币';
        if (!rename) return [];
        if (item.action === 'buy') return [rename, `买入${tokenSymbol}`];
        const action = item.ooc === 1 ? '清仓' : '减仓';
        return [rename, `${action}${tokenSymbol}`];
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
        return [names, `${action}${tokenSymbol}`];
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
            const actionToken = buildSpeechGroupParts(group)[1] || '';
            return `${names}${actionToken}`;
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

    async function playProgressiveSegmentGroups(segmentPromises, playGroup) {
        const promises = Array.isArray(segmentPromises) ? segmentPromises : [];
        if (promises.length === 0) throw new Error('empty_segments');
        const scheduledPlaybacks = [];

        for (let index = 0; index < promises.length; index += 1) {
            const segment = await promises[index];
            if (!segment) throw new Error(`segment_${index}_unavailable`);
            scheduledPlaybacks.push(Promise.resolve(playGroup([segment], {
                startIndex: index,
                segmentCount: 1,
                totalSegments: promises.length
            })).then((result) => ({ index, result })).catch((error) => ({ index, error })));
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

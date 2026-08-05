(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnTwitterEvent = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';

    function hashPayload(value) {
        const text = typeof value === 'string' ? value : stableStringify(value);
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function stableStringify(value) {
        if (Array.isArray(value)) {
            return `[${value.map(stableStringify).join(',')}]`;
        }
        if (value && typeof value === 'object') {
            const entries = Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
            return `{${entries.join(',')}}`;
        }
        return JSON.stringify(value);
    }

    function readStableId(item) {
        if (!item || typeof item !== 'object') return '';
        const directKeys = [
            'tweet_id', 'tweetId', 'twitter_id', 'twitterId',
            'status_id', 'statusId', 'post_id', 'postId', 'id_str', 'id'
        ];
        for (const key of directKeys) {
            const value = item[key];
            if (typeof value === 'string' || typeof value === 'number') {
                const normalized = String(value).trim();
                if (normalized) return normalized;
            }
        }
        for (const containerKey of ['tweet', 'status', 'post']) {
            const nestedId = readStableId(item[containerKey]);
            if (nestedId) return nestedId;
        }
        return '';
    }

    function buildEventId(items) {
        const list = Array.isArray(items) ? items.filter(Boolean) : [];
        const stableIds = list.map(readStableId).filter(Boolean).sort();
        if (stableIds.length > 0) {
            return `twitter_${hashPayload(stableIds.join('|'))}`;
        }
        return `twitter_${hashPayload(list)}`;
    }

    function buildSemanticKey(triggers) {
        const parts = (Array.isArray(triggers) ? triggers : [])
            .filter((trigger) => trigger && typeof trigger.id === 'string')
            .map((trigger) => `${trigger.id.trim().toLowerCase()}:${String(trigger.tw || 'unknown').toLowerCase()}`)
            .sort();
        return parts.length > 0 ? `twitter_semantic_${hashPayload(parts.join('|'))}` : '';
    }

    return {
        stableStringify,
        readStableId,
        buildEventId,
        buildSemanticKey
    };
});

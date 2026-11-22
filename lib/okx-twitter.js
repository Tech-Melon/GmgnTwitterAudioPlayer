(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnOkxTwitter = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';
    // OKX Web3 推特流：wss://wsdexpri.okx.com/ws/v5/ipublic
    // 实测帧：{ arg:{channel}, data:[{ contentId, author:{username,nickName}, content, formatType, ... }] }
    // 同一 contentId 随后会推大量只含 { contentId, sourceLanguage, translatedContent } 的翻译帧，必须丢弃
    const CHANNEL = 'dex-market-twitter-content-recommanded';
    const FORMAT_TYPES = Object.freeze({
        2: 'tweet',
        4: 'quote',
        5: 'repost',
        6: 'reply'
    });
    const MAX_SEEN = 1000;
    const seen = new Map();
    function resetState() {
        seen.clear();
    }
    function normalizeHandle(value) {
        return String(value == null ? '' : value).trim().replace(/^@+/, '').toLowerCase();
    }
    function remember(id) {
        seen.delete(id);
        seen.set(id, true);
        while (seen.size > MAX_SEEN) {
            seen.delete(seen.keys().next().value);
        }
    }
    function parseFrame(input) {
        if (input && typeof input === 'object') return input;
        if (typeof input !== 'string') return null;
        // 预过滤：翻译帧不含 author，绝大多数帧在这里就被丢弃，避免 JSON.parse
        if (input.indexOf(CHANNEL) === -1 || input.indexOf('"author"') === -1) return null;
        try {
            return JSON.parse(input);
        } catch (error) {
            return null;
        }
    }
    function toTrigger(item) {
        if (!item || typeof item !== 'object') return null;
        const tw = FORMAT_TYPES[Number(item.formatType)];
        if (!tw) return null;
        const author = item.author && typeof item.author === 'object' ? item.author : null;
        const id = normalizeHandle(author && author.username);
        const tweetId = String(item.contentId == null ? '' : item.contentId).trim();
        if (!id || !tweetId) return null;
        const name = String((author && author.nickName) || '').trim() || id;
        return { id, tw, name, tweetId };
    }
    /** 解析一帧；返回新推文 trigger 列表（已按 contentId 去重） */
    function inspectMessage(input) {
        const frame = parseFrame(input);
        if (!frame || !frame.arg || frame.arg.channel !== CHANNEL || frame.event) return [];
        const list = Array.isArray(frame.data) ? frame.data : (frame.data ? [frame.data] : []);
        const results = [];
        list.forEach((item) => {
            // 官方 setFeedsWsData：approvalStatus === 0 表示内容被撤下，页面会从列表删除
            if (item && (item.approvalStatus === 0 || item.approvalStatus === '0')) return;
            const trigger = toTrigger(item);
            if (!trigger || seen.has(trigger.tweetId)) return;
            remember(trigger.tweetId);
            results.push({ trigger, tweetId: trigger.tweetId });
        });
        return results;
    }
    // 「我的关注」：页面用 GET /priapi/v1/dx/market/v2/alert/twitter/alertList?walletAddress=… 拉取，
    // 响应 data.alerts[].twitterHandle；带 twitterHandle 参数时是搜索结果，不能当作完整列表
    const FOLLOW_LIST_PATH = '/priapi/v1/dx/market/v2/alert/twitter/alertList';
    function isFollowListUrl(url) {
        try {
            const parsed = new URL(String(url), 'https://web3.okx.com');
            if (parsed.pathname !== FOLLOW_LIST_PATH) return false;
            return !parsed.searchParams.get('twitterHandle');
        } catch (error) {
            return false;
        }
    }
    /** @returns {string[]|null} 关注账号（小写 handle）；响应不合法返回 null */
    function parseFollowList(body) {
        if (!body || typeof body !== 'object' || Number(body.code) !== 0) return null;
        const alerts = body.data && Array.isArray(body.data.alerts) ? body.data.alerts : null;
        if (!alerts) return null;
        return alerts
            .filter((alert) => alert && alert.hasFollow !== false)
            .map((alert) => normalizeHandle(alert.twitterHandle))
            .filter(Boolean);
    }
    function buildDispatchDetail(result, eventApi) {
        if (!result || !result.trigger) return null;
        const triggers = [result.trigger];
        return {
            triggers,
            eventId: eventApi && typeof eventApi.buildEventId === 'function'
                ? eventApi.buildEventId([{ tweet_id: result.tweetId }])
                : `twitter_${result.tweetId}`,
            semanticKey: eventApi && typeof eventApi.buildSemanticKey === 'function'
                ? eventApi.buildSemanticKey(triggers)
                : ''
        };
    }
    return {
        CHANNEL,
        FORMAT_TYPES,
        normalizeHandle,
        toTrigger,
        inspectMessage,
        isFollowListUrl,
        parseFollowList,
        buildDispatchDetail,
        resetState
    };
});

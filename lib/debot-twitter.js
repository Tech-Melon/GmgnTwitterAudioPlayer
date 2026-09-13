(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnDebotTwitter = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';

    const USER_EVENT = 'social-user-twitter';
    const DELETE_EVENT = 'tweet';
    const USER_CHANNELS = new Set(['twitter_user_subscribe', 'tweet']);
    const SOCIAL_EVENT_TYPES = new Set([
        'tweet',
        'tweet_user_follow',
        'tweet_user_unfollow',
        'tweet_user_profile'
    ]);

    function normalizeHandle(value) {
        return String(value == null ? '' : value).trim().replace(/^@+/, '').toLowerCase();
    }

    function isTranslateChannel(channel) {
        const name = String(channel || '').toLowerCase();
        return name.indexOf('translate') !== -1;
    }

    function isHotChannel(channel) {
        const name = String(channel || '').toLowerCase();
        return name.indexOf('hot') !== -1;
    }

    function isTwitterPlatform(data) {
        if (!data || typeof data !== 'object') return false;
        if (data.platform === undefined || data.platform === null || data.platform === '') return true;
        return Number(data.platform) === 0;
    }

    function mapActionType(tweet) {
        if (!tweet || typeof tweet !== 'object') return 'tweet';
        if (tweet.is_reply === true || tweet.tweet_type === 'reply') return 'reply';
        if (tweet.is_quote === true || tweet.tweet_type === 'quote') return 'quote';
        if (tweet.is_retweet === true || tweet.tweet_type === 'repost') return 'repost';
        return 'tweet';
    }

    function isAcceptedSocialEvent(data) {
        if (!data || typeof data !== 'object') return false;
        if (!data.event_type) return true;
        return SOCIAL_EVENT_TYPES.has(data.event_type);
    }

    function parseJson(value) {
        if (value && typeof value === 'object') return value;
        if (typeof value !== 'string' || !value) return null;
        try {
            return JSON.parse(value);
        } catch (error) {
            return null;
        }
    }

    function toTrigger(data) {
        if (!data || typeof data !== 'object') return null;
        if (!isAcceptedSocialEvent(data)) return null;
        if (!isTwitterPlatform(data)) return null;
        const tweet = data.tweet && typeof data.tweet === 'object' ? data.tweet : null;
        const nestedUser = tweet && tweet.user && typeof tweet.user === 'object' ? tweet.user : null;
        const rootUser = data.user && typeof data.user === 'object' ? data.user : null;
        const id = normalizeHandle(
            data.screen_name
            || (nestedUser && nestedUser.username)
            || (rootUser && rootUser.username)
        );
        if (!id) return null;
        const name = (nestedUser && nestedUser.name)
            || (rootUser && rootUser.name)
            || id;
        const tweetId = String((tweet && tweet.tweet_id) || data.doc_id || '').trim();
        return {
            id,
            tw: mapActionType(tweet),
            name,
            tweetId
        };
    }

    function inspectEventArgs(args) {
        const list = Array.isArray(args) ? args : [];
        const frame = list[0];
        if (!frame || typeof frame !== 'object') return null;
        const channel = frame.Channel;
        if (isTranslateChannel(channel) || isHotChannel(channel)) return null;
        if (channel && !USER_CHANNELS.has(String(channel))) return null;
        const parsed = parseJson(frame.Payload);
        if (!parsed) return null;
        const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        const trigger = toTrigger(data);
        if (!trigger) return null;
        return {
            trigger,
            tweetId: trigger.tweetId,
            channel: channel || 'twitter_user_subscribe',
            data
        };
    }

    function inspectWorkerMessage(message) {
        if (!message || typeof message !== 'object') return null;
        if (message.type !== 'socket-event') return null;
        if (message.kind && message.kind !== 'portal') return null;
        if (message.event !== USER_EVENT && message.event !== DELETE_EVENT) return null;
        return inspectEventArgs(message.args);
    }

    function isUserSocketEventName(name) {
        return name === USER_EVENT || name === DELETE_EVENT;
    }

    function inspectEngineIoFrame(raw) {
        if (typeof raw !== 'string') return null;
        if (raw.indexOf(USER_EVENT) === -1 && raw.indexOf('"' + DELETE_EVENT + '"') === -1) return null;
        if (raw.charCodeAt(0) !== 52 || raw.charCodeAt(1) !== 50) return null;
        let index = 2;
        while (index < raw.length) {
            const code = raw.charCodeAt(index);
            if (code < 48 || code > 57) break;
            index += 1;
        }
        const parsed = parseJson(raw.slice(index));
        if (!Array.isArray(parsed) || !isUserSocketEventName(parsed[0])) return null;
        return inspectEventArgs(parsed.slice(1));
    }

    function inspectMessage(input) {
        if (input == null) return null;
        if (typeof input === 'string') return inspectEngineIoFrame(input);
        if (typeof input !== 'object') return null;
        if (input.type === 'socket-event') return inspectWorkerMessage(input);
        if (Array.isArray(input)) {
            if (isUserSocketEventName(input[0])) return inspectEventArgs(input.slice(1));
            return inspectEventArgs(input);
        }
        if (input.Channel || input.Payload) return inspectEventArgs([input]);
        return inspectWorkerMessage(input);
    }

    function buildDispatchDetail(result, eventApi) {
        if (!result || !result.trigger) return null;
        const triggers = [result.trigger];
        const idSource = result.tweetId ? [{ tweet_id: result.tweetId }] : triggers;
        return {
            triggers,
            eventId: eventApi && typeof eventApi.buildEventId === 'function'
                ? eventApi.buildEventId(idSource)
                : `twitter_${result.tweetId || result.trigger.id}`,
            semanticKey: eventApi && typeof eventApi.buildSemanticKey === 'function'
                ? eventApi.buildSemanticKey(triggers)
                : ''
        };
    }

    return {
        USER_EVENT,
        DELETE_EVENT,
        normalizeHandle,
        mapActionType,
        toTrigger,
        inspectEventArgs,
        inspectWorkerMessage,
        inspectEngineIoFrame,
        inspectMessage,
        buildDispatchDetail
    };
});

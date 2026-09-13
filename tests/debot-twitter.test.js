const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeHandle,
    mapActionType,
    toTrigger,
    inspectMessage,
    buildDispatchDetail
} = require('../lib/debot-twitter.js');
const { buildEventId, buildSemanticKey } = require('../lib/twitter-event.js');

const liveTweetPayload = {
    user_id: 214800,
    event_type: 'social-user-twitter',
    data: {
        doc_id: '2098809019767140801',
        event_type: 'tweet',
        screen_name: '0xtechmelon',
        platform: 0,
        tweet: {
            tweet_id: '2098809019767140801',
            text: '休了',
            text_translate: null,
            user: { name: 'tech-melon', username: '@0xtechmelon' },
            is_tweet: true,
            is_retweet: false,
            is_reply: false,
            is_quote: false,
            is_deleted: false,
            tweet_type: 'tweet'
        },
        user: { name: 'tech-melon', username: '@0xtechmelon' }
    }
};

function workerMessage(channel, payload, event) {
    return {
        type: 'socket-event',
        kind: 'portal',
        event: event || 'social-user-twitter',
        args: [
            {
                Channel: channel,
                Pattern: '',
                Payload: JSON.stringify(payload),
                PayloadSlice: null
            },
            'ack-1'
        ]
    };
}

test('normalize handle strips @ and lowercases', () => {
    assert.equal(normalizeHandle('@0xTechMelon'), '0xtechmelon');
});

test('official tweet types map to existing filters', () => {
    assert.equal(mapActionType({ tweet_type: 'tweet', is_tweet: true }), 'tweet');
    assert.equal(mapActionType({ tweet_type: 'reply', is_reply: true }), 'reply');
    assert.equal(mapActionType({ tweet_type: 'repost', is_retweet: true }), 'repost');
    assert.equal(mapActionType({ tweet_type: 'quote', is_quote: true }), 'quote');
    assert.equal(mapActionType({ tweet_type: 'delete_post', is_deleted: true }), 'tweet');
});

test('live original tweet becomes a trigger', () => {
    const result = inspectMessage(workerMessage('twitter_user_subscribe', liveTweetPayload));
    assert.ok(result);
    assert.equal(result.trigger.id, '0xtechmelon');
    assert.equal(result.trigger.tw, 'tweet');
    assert.equal(result.trigger.name, 'tech-melon');
    assert.equal(result.trigger.tweetId, '2098809019767140801');
});

test('translate channel of the same tweet is ignored', () => {
    const translated = JSON.parse(JSON.stringify(liveTweetPayload));
    translated.data.tweet.text_translate = { zh: '休息了', en: 'Off work.' };
    const result = inspectMessage(workerMessage('twitter_translate_user_subscribe', translated));
    assert.equal(result, null);
});

test('follow / profile / delete still announce as twitter activity', () => {
    const followPayload = {
        event_type: 'social-user-twitter',
        data: {
            doc_id: 'follow_0xtechmelon_darioamodei',
            event_type: 'tweet_user_follow',
            screen_name: '0xtechmelon',
            platform: 0,
            tweet: null,
            user: { name: 'tech-melon', username: '@0xtechmelon' },
            follow: { username: 'DarioAmodei' }
        }
    };
    const follow = inspectMessage(workerMessage('twitter_user_subscribe', followPayload));
    assert.ok(follow);
    assert.equal(follow.trigger.id, '0xtechmelon');
    assert.equal(follow.trigger.tw, 'tweet');
    assert.equal(follow.trigger.name, 'tech-melon');

    const profile = toTrigger({
        event_type: 'tweet_user_profile',
        screen_name: '0xtechmelon',
        platform: 0,
        tweet: null,
        user: { name: 'tech-melon', username: '@0xtechmelon' },
        profile: { is_name_changed: true }
    });
    assert.equal(profile.tw, 'tweet');

    const deleted = JSON.parse(JSON.stringify(liveTweetPayload));
    deleted.data.tweet.is_deleted = true;
    deleted.data.tweet.tweet_type = 'delete_post';
    const del = inspectMessage(workerMessage('tweet', deleted, 'tweet'));
    assert.ok(del);
    assert.equal(del.trigger.tw, 'tweet');
    assert.equal(del.trigger.tweetId, '2098809019767140801');
});

test('hot / binance square events are ignored', () => {
    const hot = JSON.parse(JSON.stringify(liveTweetPayload));
    hot.event_type = 'social-hot-twitter';
    hot.data.event_type = 'binance_square';
    hot.data.platform = 1;
    hot.data.screen_name = 'binance_news';
    assert.equal(inspectMessage(workerMessage('twitter_hot_subscribe', hot, 'social-hot-twitter')), null);
    assert.equal(toTrigger(hot.data), null);
});

test('engine.io fallback frame is parsed the same way', () => {
    const frame = `42["social-user-twitter",${JSON.stringify({
        Channel: 'twitter_user_subscribe',
        Pattern: '',
        Payload: JSON.stringify(liveTweetPayload),
        PayloadSlice: null
    })},"Q2MQy3H.2"]`;
    const result = inspectMessage(frame);
    assert.ok(result);
    assert.equal(result.trigger.tweetId, '2098809019767140801');
});

test('event id uses tweet_id so original and translate would collide if both passed', () => {
    const result = inspectMessage(workerMessage('twitter_user_subscribe', liveTweetPayload));
    const detail = buildDispatchDetail(result, { buildEventId, buildSemanticKey });
    assert.equal(detail.eventId, buildEventId([{ tweet_id: '2098809019767140801' }]));
    assert.equal(detail.semanticKey, buildSemanticKey([{ id: '0xtechmelon', tw: 'tweet' }]));
});

test('reply from official flags is classified as reply', () => {
    const reply = JSON.parse(JSON.stringify(liveTweetPayload));
    reply.data.tweet.is_tweet = false;
    reply.data.tweet.is_reply = true;
    reply.data.tweet.tweet_type = 'reply';
    reply.data.tweet.text = '你手速最快了';
    const result = inspectMessage(workerMessage('twitter_user_subscribe', reply));
    assert.equal(result.trigger.tw, 'reply');
});

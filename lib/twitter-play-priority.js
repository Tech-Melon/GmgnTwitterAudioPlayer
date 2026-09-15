(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnTwitterPlayPriority = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';

    const GENERIC_SOUND_IDS = ['default.MP3', 'preset1.MP3'];

    function normalizeTwitterId(value) {
        return String(value == null ? '' : value).trim().replace(/^@+/, '').toLowerCase();
    }

    function isGenericSoundId(audioId) {
        return !!audioId && GENERIC_SOUND_IDS.includes(audioId);
    }

    function getMappedAudioId(rule) {
        if (typeof rule === 'string' && rule) return rule;
        if (rule && typeof rule === 'object' && typeof rule.id === 'string') return rule.id;
        return '';
    }

    function hasExclusiveAudioBinding(mappedAudioId) {
        return !!mappedAudioId && !isGenericSoundId(mappedAudioId);
    }

    function lookupMapping(mappings, triggerOrId) {
        const table = mappings && typeof mappings === 'object' ? mappings : {};
        const raw = typeof triggerOrId === 'string' || typeof triggerOrId === 'number'
            ? triggerOrId
            : (triggerOrId && triggerOrId.id);
        const twitterId = normalizeTwitterId(raw);
        if (!twitterId) return { twitterId: '', rule: null };

        if (Object.prototype.hasOwnProperty.call(table, twitterId)) {
            return { twitterId, rule: table[twitterId] };
        }
        const rawLower = String(raw == null ? '' : raw).trim().toLowerCase();
        if (rawLower && Object.prototype.hasOwnProperty.call(table, rawLower)) {
            return { twitterId: rawLower, rule: table[rawLower] };
        }
        const atKey = `@${twitterId}`;
        if (Object.prototype.hasOwnProperty.call(table, atKey)) {
            return { twitterId: atKey, rule: table[atKey] };
        }
        return { twitterId, rule: null };
    }

    function getTwitterSpeakerName(trigger, rule, fallbackId) {
        const twitterId = fallbackId || normalizeTwitterId(trigger && trigger.id);
        const displayName = (trigger && trigger.name) ? trigger.name : twitterId;
        if (typeof rule === 'object' && rule !== null && rule.remark) return rule.remark;
        return displayName || twitterId;
    }

    function resolveExclusiveAudioSrc(mappedAudioId, customAudios, resolveBuiltinSrc) {
        if (!hasExclusiveAudioBinding(mappedAudioId)) return null;
        const table = customAudios && typeof customAudios === 'object' ? customAudios : {};
        if (Object.prototype.hasOwnProperty.call(table, mappedAudioId)) {
            const customObj = table[mappedAudioId];
            const data = typeof customObj === 'string' ? customObj : (customObj && customObj.data);
            return data || null;
        }
        if (String(mappedAudioId).startsWith('custom_')) return null;
        if (typeof resolveBuiltinSrc === 'function') return resolveBuiltinSrc(mappedAudioId) || null;
        return mappedAudioId;
    }

    /**
     * 单账号优先级（互斥，先命中先停）：
     * 1. 专属铃文件能解析到 → 只走 exclusive，绝不念备注
     * 2. 绑了专属铃但文件丢失 / 名单内默认铃 → TTS（有备注念备注）
     * 3. 名单外 → TTS 念昵称（受 playDefaultUnmapped 控制）
     */
    function classifyTwitterTrigger(trigger, ctx) {
        const mappings = ctx && ctx.mappings;
        const { twitterId, rule } = lookupMapping(mappings, trigger);
        const mappedAudioId = getMappedAudioId(rule);
        const speakerName = getTwitterSpeakerName(trigger, rule, twitterId);

        if (hasExclusiveAudioBinding(mappedAudioId)) {
            const exclusiveSrc = resolveExclusiveAudioSrc(
                mappedAudioId,
                ctx && ctx.customAudios,
                ctx && ctx.resolveBuiltinSrc
            );
            if (exclusiveSrc) {
                return {
                    playExclusive: true,
                    playTts: false,
                    mappedAudioId,
                    speakerName,
                    twitterId,
                    rule
                };
            }
            return {
                playExclusive: false,
                playTts: !ctx || ctx.playMappedGeneric !== false,
                mappedAudioId,
                speakerName,
                twitterId,
                rule
            };
        }
        if (mappedAudioId) {
            return {
                playExclusive: false,
                playTts: !ctx || ctx.playMappedGeneric !== false,
                mappedAudioId,
                speakerName,
                twitterId,
                rule
            };
        }
        return {
            playExclusive: false,
            playTts: !ctx || ctx.playDefaultUnmapped !== false,
            mappedAudioId: '',
            speakerName,
            twitterId,
            rule: null
        };
    }

    return {
        GENERIC_SOUND_IDS,
        normalizeTwitterId,
        isGenericSoundId,
        getMappedAudioId,
        hasExclusiveAudioBinding,
        lookupMapping,
        getTwitterSpeakerName,
        resolveExclusiveAudioSrc,
        classifyTwitterTrigger
    };
});

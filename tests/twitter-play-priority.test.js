const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeTwitterId,
    hasExclusiveAudioBinding,
    lookupMapping,
    classifyTwitterTrigger,
    resolveExclusiveAudioSrc
} = require('../lib/twitter-play-priority.js');

const exclusiveRule = { id: 'elonmusk.MP3', name: '马斯克专属', remark: '马斯克' };
const customRule = { id: 'custom_abc', name: '自定义铃', remark: '币安官推' };
const genericRule = { id: 'default.MP3', name: '默认提示音', remark: '币安官推' };

test('normalize strips @ and lowercases', () => {
    assert.equal(normalizeTwitterId('@ElonMusk'), 'elonmusk');
    assert.equal(normalizeTwitterId('  BinanceZH  '), 'binancezh');
});

test('exclusive binding ignores generic default/preset1', () => {
    assert.equal(hasExclusiveAudioBinding('elonmusk.MP3'), true);
    assert.equal(hasExclusiveAudioBinding('custom_abc'), true);
    assert.equal(hasExclusiveAudioBinding('default.MP3'), false);
    assert.equal(hasExclusiveAudioBinding('preset1.MP3'), false);
    assert.equal(hasExclusiveAudioBinding(''), false);
});

test('lookup hits mapping even if trigger still has @', () => {
    const mappings = { elonmusk: exclusiveRule };
    const found = lookupMapping(mappings, { id: '@ElonMusk' });
    assert.equal(found.twitterId, 'elonmusk');
    assert.equal(found.rule, exclusiveRule);
});

test('lookup also hits legacy mapping keys that still include @', () => {
    const mappings = { '@elonmusk': exclusiveRule };
    const found = lookupMapping(mappings, { id: 'ElonMusk' });
    assert.equal(found.twitterId, '@elonmusk');
    assert.equal(found.rule, exclusiveRule);
});

test('remark + exclusive audio never enters TTS', () => {
    const decision = classifyTwitterTrigger(
        { id: 'elonmusk', name: 'Elon Musk' },
        { mappings: { elonmusk: exclusiveRule }, playMappedGeneric: true, playDefaultUnmapped: true }
    );
    assert.equal(decision.playExclusive, true);
    assert.equal(decision.playTts, false);
    assert.equal(decision.speakerName, '马斯克');
});

test('remark + custom exclusive never enters TTS even if file is missing', () => {
    const decision = classifyTwitterTrigger(
        { id: 'binancezh', name: 'Binance' },
        {
            mappings: { binancezh: customRule },
            customAudios: {},
            playMappedGeneric: true
        }
    );
    assert.equal(decision.playExclusive, true);
    assert.equal(decision.playTts, false);
    assert.equal(decision.speakerName, '币安官推');
    assert.equal(resolveExclusiveAudioSrc('custom_abc', {}), null);
});

test('remark + default ding still uses TTS of the remark', () => {
    const decision = classifyTwitterTrigger(
        { id: 'binancezh', name: 'Binance' },
        { mappings: { binancezh: genericRule }, playMappedGeneric: true }
    );
    assert.equal(decision.playExclusive, false);
    assert.equal(decision.playTts, true);
    assert.equal(decision.speakerName, '币安官推');
});

test('unmapped account uses display name for TTS', () => {
    const decision = classifyTwitterTrigger(
        { id: 'randomuser', name: 'Random' },
        { mappings: {}, playDefaultUnmapped: true }
    );
    assert.equal(decision.playExclusive, false);
    assert.equal(decision.playTts, true);
    assert.equal(decision.speakerName, 'Random');
});

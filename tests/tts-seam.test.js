const test = require('node:test');
const assert = require('node:assert/strict');

const {
    findSpeechBounds,
    trimSamples,
    concatSamples,
    encodeWavMono
} = require('../lib/tts-seam.js');

function silence(count) {
    return new Float32Array(count);
}

function tone(count, amplitude = 0.4) {
    const data = new Float32Array(count);
    for (let i = 0; i < count; i += 1) data[i] = amplitude;
    return data;
}

function concatFloat32(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    parts.forEach((part) => {
        out.set(part, offset);
        offset += part.length;
    });
    return out;
}

test('speech bounds drop leading and trailing TTS padding but keep a short pad', () => {
    const samples = concatFloat32([silence(80), tone(40, 0.5), silence(90)]);
    const bounds = findSpeechBounds(samples, 1000, { threshold: 0.05, padSec: 0.01 });
    assert.equal(bounds.start, 70);
    assert.equal(bounds.end, 130);
    assert.deepEqual(Array.from(trimSamples(samples, 1000, { threshold: 0.05, padSec: 0.01 })), Array.from(samples.subarray(70, 130)));
});

test('all-silence clips keep the original samples instead of collapsing to empty', () => {
    const samples = silence(32);
    const bounds = findSpeechBounds(samples, 24000);
    assert.deepEqual(bounds, { start: 0, end: 32 });
});

test('crossfade concat overlaps adjacent clips instead of inserting a gap', () => {
    const left = concatFloat32([tone(8, 1), silence(4)]);
    const right = concatFloat32([silence(4), tone(8, 1)]);
    const merged = concatSamples([
        trimSamples(left, 1000, { threshold: 0.05, padSec: 0 }),
        trimSamples(right, 1000, { threshold: 0.05, padSec: 0 })
    ], 1000, 0.004);
    assert.ok(merged.length < left.length + right.length);
    assert.ok(merged.length >= 8);
    const peak = Math.max(...Array.from(merged).map((value) => Math.abs(value)));
    assert.ok(peak > 0.9);
});

test('wav encoder writes a valid mono pcm header', () => {
    const samples = tone(10, 0.25);
    const bytes = new Uint8Array(encodeWavMono(samples, 24000));
    const ascii = String.fromCharCode(...bytes.subarray(0, 12));
    assert.equal(ascii.slice(0, 4), 'RIFF');
    assert.equal(ascii.slice(8, 12), 'WAVE');
    assert.equal(bytes.length, 44 + (samples.length * 2));
});

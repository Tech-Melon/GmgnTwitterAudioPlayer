(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnTtsSeam = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';

    const SILENCE_THRESHOLD = 0.012;
    const KEEP_PAD_SEC = 0.016;
    const CROSSFADE_SEC = 0.02;
    const STITCH_TIMEOUT_MS = 1500;

    function withTimeout(promise, timeoutMs, label) {
        const ms = Number(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(label || 'stitch_timeout'));
            }, ms);
            Promise.resolve(promise).then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }

    let sharedDecodeContext = null;

    function getDecodeContext() {
        if (sharedDecodeContext) return sharedDecodeContext;
        const AudioContextClass = (typeof globalThis !== 'undefined' && (globalThis.AudioContext || globalThis.webkitAudioContext))
            || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
        if (!AudioContextClass) return null;
        sharedDecodeContext = new AudioContextClass();
        return sharedDecodeContext;
    }

    function findSpeechBounds(samples, sampleRate, options = {}) {
        const data = samples || new Float32Array(0);
        const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 24000;
        const threshold = options.threshold == null ? SILENCE_THRESHOLD : Number(options.threshold);
        const padSec = options.padSec == null ? KEEP_PAD_SEC : Number(options.padSec);
        const pad = Math.max(0, Math.round(rate * Math.max(0, padSec)));
        if (data.length === 0) return { start: 0, end: 0 };

        let start = 0;
        let end = data.length - 1;
        while (start < end && Math.abs(data[start]) < threshold) start += 1;
        while (end > start && Math.abs(data[end]) < threshold) end -= 1;
        if (end <= start) return { start: 0, end: data.length };

        start = Math.max(0, start - pad);
        end = Math.min(data.length - 1, end + pad);
        return { start, end: end + 1 };
    }

    function trimSamples(samples, sampleRate, options = {}) {
        const data = samples || new Float32Array(0);
        const bounds = findSpeechBounds(data, sampleRate, options);
        if (bounds.start === 0 && bounds.end === data.length) return data;
        return data.subarray(bounds.start, bounds.end);
    }

    function concatSamples(parts, sampleRate, crossfadeSec = CROSSFADE_SEC) {
        const list = (Array.isArray(parts) ? parts : []).filter((part) => part && part.length > 0);
        if (list.length === 0) return new Float32Array(0);
        if (list.length === 1) return list[0];

        const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 24000;
        const fade = Math.max(0, Math.round(rate * Math.max(0, Number(crossfadeSec) || 0)));
        let total = list[0].length;
        const overlaps = [0];
        for (let index = 1; index < list.length; index += 1) {
            const overlap = Math.min(fade, list[index - 1].length, list[index].length);
            overlaps.push(overlap);
            total += list[index].length - overlap;
        }

        const out = new Float32Array(total);
        let offset = 0;
        for (let index = 0; index < list.length; index += 1) {
            const part = list[index];
            if (index === 0) {
                out.set(part, 0);
                offset = part.length;
                continue;
            }
            const overlap = overlaps[index];
            const fadeStart = offset - overlap;
            for (let k = 0; k < overlap; k += 1) {
                const t = overlap === 1 ? 1 : k / (overlap - 1);
                const a = Math.cos(t * Math.PI / 2);
                const b = Math.sin(t * Math.PI / 2);
                out[fadeStart + k] = (out[fadeStart + k] * a) + (part[k] * b);
            }
            if (part.length > overlap) out.set(part.subarray(overlap), offset);
            offset += part.length - overlap;
        }
        return out;
    }

    function encodeWavMono(samples, sampleRate) {
        const data = samples || new Float32Array(0);
        const rate = Number(sampleRate) > 0 ? Number(sampleRate) | 0 : 24000;
        const bytesPerSample = 2;
        const blockAlign = bytesPerSample;
        const buffer = new ArrayBuffer(44 + (data.length * bytesPerSample));
        const view = new DataView(buffer);
        const writeString = (offset, text) => {
            for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + (data.length * bytesPerSample), true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, data.length * bytesPerSample, true);

        let offset = 44;
        for (let i = 0; i < data.length; i += 1) {
            const clipped = Math.max(-1, Math.min(1, data[i]));
            view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
            offset += 2;
        }
        return buffer;
    }

    function mixdownBuffer(audioBuffer) {
        const frames = audioBuffer.length;
        const channels = audioBuffer.numberOfChannels || 1;
        if (channels === 1) return audioBuffer.getChannelData(0);
        const mixed = new Float32Array(frames);
        for (let channel = 0; channel < channels; channel += 1) {
            const data = audioBuffer.getChannelData(channel);
            for (let i = 0; i < frames; i += 1) mixed[i] += data[i];
        }
        const inv = 1 / channels;
        for (let i = 0; i < frames; i += 1) mixed[i] *= inv;
        return mixed;
    }

    async function decodeBlob(blob, audioContext) {
        const ctx = audioContext || getDecodeContext();
        if (!ctx || typeof ctx.decodeAudioData !== 'function') {
            throw new Error('audio_context_unavailable');
        }
        const bytes = await blob.arrayBuffer();
        const copy = bytes.slice(0);
        return await ctx.decodeAudioData(copy);
    }

    async function stitchBlobsNow(list, options) {
        const ctx = options.audioContext || getDecodeContext();
        if (!ctx) return null;

        const decoded = [];
        let sampleRate = 0;
        for (const blob of list) {
            const audioBuffer = await decodeBlob(blob, ctx);
            if (!sampleRate) sampleRate = audioBuffer.sampleRate;
            if (audioBuffer.sampleRate !== sampleRate) return null;
            decoded.push(trimSamples(mixdownBuffer(audioBuffer), audioBuffer.sampleRate, options));
        }

        const merged = concatSamples(decoded, sampleRate, options.crossfadeSec);
        if (!merged || merged.length === 0) return list[0];
        const wav = encodeWavMono(merged, sampleRate);
        return new Blob([wav], { type: 'audio/wav' });
    }

    async function stitchBlobs(blobs, options = {}) {
        const list = (Array.isArray(blobs) ? blobs : [blobs]).filter(Boolean);
        if (list.length === 0) return null;
        if (list.length === 1) return list[0];
        const timeoutMs = options.timeoutMs == null ? STITCH_TIMEOUT_MS : options.timeoutMs;
        return withTimeout(stitchBlobsNow(list, options), timeoutMs, 'stitch_timeout');
    }

    return {
        SILENCE_THRESHOLD,
        KEEP_PAD_SEC,
        CROSSFADE_SEC,
        STITCH_TIMEOUT_MS,
        findSpeechBounds,
        trimSamples,
        concatSamples,
        encodeWavMono,
        stitchBlobs,
        getDecodeContext
    };
});

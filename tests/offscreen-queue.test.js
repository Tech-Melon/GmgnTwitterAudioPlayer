const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness() {
    const audioInstances = [];
    const gainValues = [];
    const oscillators = [];
    const diagnosticEntries = [];
    let messageListener = null;

    class FakeAudio {
        constructor(src = '') {
            this.src = src;
            this.volume = 1;
            this.onended = null;
            this.onerror = null;
            audioInstances.push(this);
        }

        play() {
            return Promise.resolve();
        }

        pause() {}
        removeAttribute() { this.src = ''; }
        load() {}
    }

    class FakeAudioContext {
        constructor() {
            this.currentTime = 10;
            this.destination = {};
            this.state = 'running';
        }

        createMediaElementSource() {
            return { connect() {} };
        }

        createGain() {
            const gain = {
                context: this,
                connect() {},
                gain: {
                    setValueAtTime(value) { gainValues.push(value); },
                    exponentialRampToValueAtTime(value) { gainValues.push(value); }
                }
            };
            return gain;
        }

        createOscillator() {
            const oscillator = {
                type: '',
                frequency: { value: 0 },
                onended: null,
                connect() {},
                start() {},
                stop() {
                    setTimeout(() => {
                        if (oscillator.onended) oscillator.onended();
                    }, 0);
                }
            };
            oscillators.push(oscillator);
            return oscillator;
        }

        resume() {
            this.state = 'running';
            return Promise.resolve();
        }
    }

    const context = vm.createContext({
        Audio: FakeAudio,
        AudioContext: FakeAudioContext,
        console: { log() {}, warn() {} },
        setTimeout,
        clearTimeout,
        chrome: {
            runtime: {
                getURL: (value) => `chrome-extension://test/${value}`,
                get lastError() { return null; },
                sendMessage(message, callback) {
                    if (message && message.type === 'GMGN_DIAGNOSTIC_LOG') {
                        diagnosticEntries.push(message.entry);
                    }
                    if (callback) callback({ ok: true });
                },
                onMessage: {
                    addListener(listener) {
                        messageListener = listener;
                    }
                }
            }
        }
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
    vm.runInContext(source, context);

    function send(message) {
        return new Promise((resolve) => {
            messageListener({ target: 'offscreen', ...message }, {}, resolve);
        });
    }

    return { audioInstances, gainValues, oscillators, diagnosticEntries, send };
}

test('offscreen resolves only after playback and keeps same-channel jobs in FIFO order', async () => {
    const harness = createHarness();
    let firstSettled = false;
    const firstPlayback = harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        items: [{ kind: 'data', dataUrl: 'data:first' }]
    }).then((result) => {
        firstSettled = true;
        return result;
    });
    const secondPlayback = harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        items: [{ kind: 'data', dataUrl: 'data:second' }]
    });

    const ttsPlayer = harness.audioInstances[1];
    await delay(0);
    assert.equal(firstSettled, false);
    assert.equal(ttsPlayer.src, 'data:first');

    ttsPlayer.onended();
    await delay(35);
    const firstResponse = await firstPlayback;
    assert.equal(firstResponse.ok, true);
    assert.equal(ttsPlayer.src, 'data:second');
    ttsPlayer.onended();
    const secondResponse = await secondPlayback;
    assert.equal(secondResponse.ok, true);
});

test('offscreen applies a custom gap only between segments, not after the final segment', async () => {
    const harness = createHarness();
    const playback = harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        segmentGapMs: 0,
        items: [
            { kind: 'data', dataUrl: 'data:first-segment' },
            { kind: 'data', dataUrl: 'data:second-segment' }
        ]
    });
    const ttsPlayer = harness.audioInstances[1];
    assert.equal(ttsPlayer.src, 'data:first-segment');

    ttsPlayer.onended();
    await delay(0);
    assert.equal(ttsPlayer.src, 'data:second-segment');

    ttsPlayer.onended();
    assert.equal((await playback).ok, true);
});

test('offscreen start diagnostics preserve WSS-to-playback timing metadata', async () => {
    const harness = createHarness();
    const wssReceivedAt = Date.now() - 250;
    const playback = harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        items: [{ kind: 'data', dataUrl: 'data:timed' }],
        source: 'wallet',
        traceId: 'wallet-trace',
        diagnostic: {
            eventIds: ['wallet-event'],
            wssReceivedAt,
            processingStartedAt: wssReceivedAt + 50
        }
    });

    await delay(0);

    const start = harness.diagnosticEntries.find((entry) => entry.stage === 'offscreen_job_start');
    assert.equal(start.traceId, 'wallet-trace');
    assert.deepEqual(Array.from(start.eventIds), ['wallet-event']);
    assert.ok(start.wssToPlaybackMs >= 250);
    assert.ok(start.processingToPlaybackMs >= 200);
    harness.audioInstances[1].onended();
    await playback;
});

test('offscreen skips expired queued jobs', async () => {
    const harness = createHarness();
    const active = harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        items: [{ kind: 'data', dataUrl: 'data:active' }]
    });
    const expired = harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        items: [{ kind: 'data', dataUrl: 'data:expired' }],
        expiresAt: Date.now() - 1
    });
    const fresh = harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        items: [{ kind: 'data', dataUrl: 'data:fresh' }]
    });

    const ttsPlayer = harness.audioInstances[1];
    ttsPlayer.onended();
    await delay(35);
    assert.equal((await active).ok, true);
    assert.equal((await expired).error, 'expired');
    assert.equal(ttsPlayer.src, 'data:fresh');
    ttsPlayer.onended();
    assert.equal((await fresh).ok, true);
});

test('offscreen limits a busy channel to one hundred queued jobs', async () => {
    const harness = createHarness();
    const active = harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        items: [{ kind: 'data', dataUrl: 'data:job-1' }]
    });

    const queued = [];
    for (let index = 2; index <= 102; index += 1) {
        queued.push(harness.send({
            type: 'OFFSCREEN_PLAY',
            channel: 'tts',
            items: [{ kind: 'data', dataUrl: `data:job-${index}` }]
        }));
    }

    assert.equal((await queued[0]).error, 'queue_limit');
    const ttsPlayer = harness.audioInstances[1];
    ttsPlayer.onended();
    await delay(35);
    assert.equal((await active).ok, true);
    assert.equal(ttsPlayer.src, 'data:job-3');
});

test('offscreen applies zero and 150 percent volume through GainNode', async () => {
    const muted = createHarness();
    const mutedPlayback = muted.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        volume: 0,
        items: [{ kind: 'data', dataUrl: 'data:muted' }]
    });
    assert.equal(muted.gainValues.at(-1), 0);
    muted.audioInstances[1].onended();
    await mutedPlayback;

    const boosted = createHarness();
    const boostedPlayback = boosted.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        volume: 1.5,
        items: [{ kind: 'data', dataUrl: 'data:boosted' }]
    });
    assert.equal(boosted.gainValues.at(-1), 1.5);
    boosted.audioInstances[1].onended();
    await boostedPlayback;
});

test('offscreen plays beep jobs without an Audio element source', async () => {
    const harness = createHarness();
    const response = await harness.send({
        type: 'OFFSCREEN_PLAY',
        channel: 'tts',
        volume: 1,
        items: [{ kind: 'beep' }]
    });

    assert.equal(response.ok, true);
    assert.equal(harness.oscillators.length, 1);
    assert.equal(harness.oscillators[0].frequency.value, 880);
});

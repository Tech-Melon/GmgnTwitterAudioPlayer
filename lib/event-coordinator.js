(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.GmgnEventCoordinator = api.EventCoordinator;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
    'use strict';

    class EventCoordinator {
        constructor(options = {}) {
            this.maxSeen = Number(options.maxSeen) || 3000;
            this.twitterTtlMs = Number(options.twitterTtlMs) || 2 * 60 * 1000;
            this.walletTtlMs = Number(options.walletTtlMs) || 10 * 60 * 1000;
            this.seen = new Map();
            this.pending = new Map();
            this.processor = null;
            this.epoch = 0;
            this.runtimeState = null;
        }

        ttlFor(kind) {
            return kind === 'wallet' ? this.walletTtlMs : this.twitterTtlMs;
        }

        hasSeen(eventId, kind, now = Date.now()) {
            const pendingRecord = this.pending.get(eventId);
            if (pendingRecord) {
                if (now - pendingRecord.timestamp <= this.ttlFor(pendingRecord.kind || kind)) return true;
                this.pending.delete(eventId);
            }
            const record = this.seen.get(eventId);
            if (!record) return false;
            if (now - record.timestamp > this.ttlFor(record.kind || kind)) {
                this.seen.delete(eventId);
                return false;
            }
            return true;
        }

        isCompleted(eventId, kind, now = Date.now()) {
            const record = this.seen.get(eventId);
            if (!record) return false;
            if (now - record.timestamp > this.ttlFor(record.kind || kind)) {
                this.seen.delete(eventId);
                return false;
            }
            return true;
        }

        isPending(eventId, kind, now = Date.now()) {
            const record = this.pending.get(eventId);
            if (!record) return false;
            if (now - record.timestamp > this.ttlFor(record.kind || kind)) {
                this.pending.delete(eventId);
                return false;
            }
            return true;
        }

        markSeen(eventId, kind, now = Date.now()) {
            this.pending.delete(eventId);
            this.seen.set(eventId, { kind, timestamp: now });
            this.prune(now);
        }

        markPending(eventId, kind, payload, now = Date.now()) {
            this.pending.set(eventId, { kind, payload, timestamp: now });
            this.prune(now);
        }

        removePending(eventId) {
            return this.pending.delete(eventId);
        }

        complete(eventIds, now = Date.now()) {
            const ids = Array.isArray(eventIds) ? eventIds : [eventIds];
            for (const eventId of ids) {
                const record = this.pending.get(eventId);
                if (!record) continue;
                this.markSeen(eventId, record.kind, now);
            }
        }

        getPending(now = Date.now()) {
            this.prune(now);
            return Array.from(this.pending.entries()).map(([eventId, record]) => ({
                eventId,
                ...record
            }));
        }

        setRuntimeState(state) {
            if (state && typeof state === 'object') this.runtimeState = state;
        }

        prune(now = Date.now()) {
            for (const [eventId, record] of this.seen) {
                if (now - record.timestamp > this.ttlFor(record.kind)) {
                    this.seen.delete(eventId);
                }
            }
            for (const [eventId, record] of this.pending) {
                if (now - record.timestamp > this.ttlFor(record.kind)) {
                    this.pending.delete(eventId);
                }
            }
            while (this.seen.size > this.maxSeen) {
                this.seen.delete(this.seen.keys().next().value);
            }
        }

        assignProcessor(tabId, documentId) {
            const sameProcessor = this.processor
                && this.processor.tabId === tabId
                && this.processor.documentId === (documentId || null);
            if (sameProcessor) return this.processor;
            this.epoch += 1;
            this.processor = {
                tabId,
                documentId: documentId || null,
                epoch: this.epoch
            };
            return this.processor;
        }

        clearProcessor(tabId, documentId) {
            if (!this.processor) return false;
            if (tabId !== undefined && this.processor.tabId !== tabId) return false;
            if (documentId && this.processor.documentId !== documentId) return false;
            this.processor = null;
            this.epoch += 1;
            return true;
        }

        isProcessor(tabId, documentId, epoch) {
            if (!this.processor) return false;
            return this.processor.tabId === tabId
                && (!this.processor.documentId || this.processor.documentId === (documentId || null))
                && this.processor.epoch === Number(epoch);
        }

        snapshot(now = Date.now()) {
            this.prune(now);
            return {
                seen: Array.from(this.seen.entries()),
                pending: Array.from(this.pending.entries()),
                processor: this.processor,
                epoch: this.epoch,
                runtimeState: this.runtimeState
            };
        }

        restore(snapshot, now = Date.now()) {
            if (!snapshot || typeof snapshot !== 'object') return;
            this.epoch = Number(snapshot.epoch) || 0;
            this.processor = snapshot.processor || null;
            this.seen = new Map(Array.isArray(snapshot.seen) ? snapshot.seen : []);
            this.pending = new Map(Array.isArray(snapshot.pending) ? snapshot.pending : []);
            this.runtimeState = snapshot.runtimeState || null;
            this.prune(now);
        }
    }

    return { EventCoordinator };
});

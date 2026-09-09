import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// This file intentionally uses a tiny fake scheduler/listener instead of the
// Firebase emulator. It is kept separate from js/test.mjs because the service
// module imports browser-only Firebase URLs.
const serviceSource = fs.readFileSync(new URL("./firestore-service.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\s*/gm, "")
  .replace(/^export\s+/gm, "");

function loadRecoveryHelper() {
  const events = [];
  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const context = {
    console: { error() {} },
    CustomEvent: FakeCustomEvent,
    window: { dispatchEvent: (event) => events.push(event) },
    TOURNAMENT_ID: "test-tournament",
    collection() {},
    doc() {},
    setDoc() {},
    addDoc() {},
    updateDoc() {},
    getDoc() {},
    getDocs() {},
    onSnapshot() {},
    query() {},
    orderBy() {},
    writeBatch() {},
    serverTimestamp() {},
    httpsCallable() {},
    db: {},
    functions: {},
    backupFromServerExport() {},
    normalizeBackupData() {},
    restorableRootData() {},
    selectRestoreRecovery() {},
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(`${serviceSource}\nglobalThis.__createRecoverableSubscription = createRecoverableSubscription;`, context, {
    filename: "firestore-service.js",
  });
  return { createRecoverableSubscription: context.__createRecoverableSubscription, events };
}

class FakeScheduler {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (handler, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.now + delay, handler });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  pending() {
    return this.timers.size;
  }

  advance(ms) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.due <= target)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (!next) break;
      this.now = next.due;
      this.timers.delete(next.id);
      next.handler();
    }
    this.now = target;
  }
}

function metadata({ fromCache = false, hasPendingWrites = false } = {}) {
  return { fromCache, hasPendingWrites };
}

function fakeSubscription(createRecoverableSubscription, scheduler, options = {}) {
  const listeners = [];
  const snapshots = [];
  const subscribe = (next, error) => {
    const listener = { next, error, stopped: false };
    listeners.push(listener);
    return () => { listener.stopped = true; };
  };
  const stop = createRecoverableSubscription({
    timeoutLabel: "피드",
    subscribe,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    timeoutMs: 10,
    retryBaseMs: 2,
    retryMaxMs: 8,
    scheduler,
    ...options,
  });
  return { listeners, snapshots, stop };
}

function activeListeners(listeners) {
  return listeners.filter((listener) => !listener.stopped);
}

function testErrorResubscribeAndServerRecovery() {
  const { createRecoverableSubscription, events } = loadRecoveryHelper();
  const scheduler = new FakeScheduler();
  const { listeners, snapshots, stop } = fakeSubscription(createRecoverableSubscription, scheduler);
  assert.equal(activeListeners(listeners).length, 1);
  assert.equal(scheduler.pending(), 1, "one initial response timer is owned");

  const stale = listeners[0];
  stale.error({ code: "permission-denied" });
  assert.equal(events.at(-1)?.type, "firestore-error");
  assert.equal(activeListeners(listeners).length, 0);
  assert.equal(scheduler.pending(), 1, "terminal error creates one bounded retry timer");
  scheduler.advance(1);
  assert.equal(listeners.length, 1, "backoff does not retry immediately");
  scheduler.advance(1);
  assert.equal(listeners.length, 2);
  assert.equal(activeListeners(listeners).length, 1);

  stale.next({ metadata: metadata() });
  assert.equal(snapshots.length, 0, "obsolete listener callback is ignored");
  listeners[1].next({ metadata: metadata() });
  assert.equal(snapshots.length, 1);
  assert.equal(scheduler.pending(), 0, "server confirmation clears response timeout");

  listeners[1].error({ code: "permission-denied" });
  scheduler.advance(1);
  assert.equal(listeners.length, 2, "server confirmation resets retry backoff");
  scheduler.advance(1);
  assert.equal(listeners.length, 3);
  stop();
}

function testRepeatedErrorsAreBoundedAndCancellationStopsWork() {
  const { createRecoverableSubscription } = loadRecoveryHelper();
  const scheduler = new FakeScheduler();
  const { listeners, stop } = fakeSubscription(createRecoverableSubscription, scheduler);
  listeners[0].error(new Error("first"));
  scheduler.advance(2);
  listeners[1].error(new Error("second"));
  assert.equal(scheduler.pending(), 1);
  scheduler.advance(3);
  assert.equal(listeners.length, 2, "second retry uses exponential backoff");
  scheduler.advance(1);
  assert.equal(listeners.length, 3);
  listeners[2].error(new Error("third"));
  scheduler.advance(8);
  assert.equal(listeners.length, 4, "retry delay is capped");
  listeners[3].error(new Error("fourth"));
  assert.equal(scheduler.pending(), 1);
  stop();
  assert.equal(scheduler.pending(), 0, "unsubscribe clears pending retry");
  scheduler.advance(1000);
  assert.equal(listeners.length, 4, "unsubscribe prevents new listeners");
  listeners[3].next({ metadata: metadata() });
}

function testCacheDoesNotRecoverAndTimeoutPropagates() {
  const { createRecoverableSubscription, events } = loadRecoveryHelper();
  const scheduler = new FakeScheduler();
  const { listeners, snapshots } = fakeSubscription(createRecoverableSubscription, scheduler);
  listeners[0].next({ metadata: metadata({ fromCache: true }) });
  assert.equal(snapshots.length, 1);
  scheduler.advance(9);
  assert.equal(events.length, 0, "cache snapshot does not immediately recover");
  scheduler.advance(1);
  assert.equal(events.at(-1)?.type, "firestore-timeout");
  assert.equal(activeListeners(listeners).length, 0);
  assert.equal(scheduler.pending(), 1, "timeout owns one retry timer");
}

// The repository's normal test command intentionally does not include this
// fixture yet; parent integration should add its invocation after updating the
// dashboard harness hooks for rootAuthorityState/live content visibility.
testErrorResubscribeAndServerRecovery();
testRepeatedErrorsAreBoundedAndCancellationStopsWork();
testCacheDoesNotRecoverAndTimeoutPropagates();
console.log("feed recovery tests passed");

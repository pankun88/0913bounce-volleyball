import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  buildRecorderFixtureIdentity,
  buildRecorderSubmitContext,
  cloneRecorderFixtureIdentity,
  normalizeRecorderFixtureIdentity,
  parseStoredRecorderDraft,
  preserveStoredRecorderDraft,
  readStoredRecorderDraft,
  recorderDraftRecoveryKey,
  recorderFixtureIdentityEqual,
  reconcileRecorderDraftIdentity,
  reconcileRecorderOwnership,
  reconcileRecorderSnapshot,
  reconcileRecorderSubmit,
  removeStoredRecorderDraft,
  writeStoredRecorderDraft,
} from "./recorder-state.js";

function storage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

const current = buildRecorderFixtureIdentity({
  matchKey: "final:men:f1",
  assignment: {
    matchType: "final",
    divisionId: "men",
    courtId: "court-a",
    officialRevision: 2,
    lastTransitionId: "server:final:2",
  },
  official: {
    teamA: { id: "team-a", name: "A팀" },
    teamB: { id: "team-b", name: "B팀" },
    officialRevision: 2,
    lastTransitionId: "server:final:2",
  },
});
const draft = { sets: [{ a: 10, b: 8 }] };

assert.deepEqual(
  normalizeRecorderFixtureIdentity(current),
  {
    matchKey: "final:men:f1",
    matchType: "final",
    divisionId: "men",
    teamAId: "team-a",
    teamBId: "team-b",
    officialRevision: 2,
    lastTransitionId: "server:final:2",
    teamAName: "A팀",
    teamBName: "B팀",
  },
  "fixture identity uses canonical IDs and explanatory names",
);

// Same official fixture restores without introducing a court identity.
{
  const moved = buildRecorderFixtureIdentity({
    matchKey: "final:men:f1",
    assignment: { matchType: "final", divisionId: "men", courtId: "court-b", officialRevision: 2 },
    official: {
      teamA: { id: "team-a", name: "A팀" }, teamB: { id: "team-b", name: "B팀" },
      officialRevision: 2, lastTransitionId: "server:final:2",
    },
  });
  const assessment = reconcileRecorderDraftIdentity({ storedIdentity: current, currentIdentity: moved });
  assert.equal(assessment.status, "same_fixture");
  assert.equal(assessment.safe, true);
  assert.equal(recorderFixtureIdentityEqual(current, moved), true);
}

// Changed participants are never considered the same fixture; names are only
// returned for the recovery explanation.
{
  const changedTeams = {
    ...current,
    teamAId: "team-c",
    teamAName: "C팀",
  };
  const assessment = reconcileRecorderDraftIdentity({
    storedIdentity: current,
    currentIdentity: changedTeams,
  });
  assert.equal(assessment.status, "mismatch");
  assert.equal(assessment.safe, false);
  assert.equal(assessment.canRestore, false);
  assert.deepEqual(assessment.teams, {
    stored: { a: "A팀", b: "B팀" },
    current: { a: "C팀", b: "B팀" },
  });
}

// Reusing the same IDs after a regenerated publication is fenced by the
// official transition even when the team names are unchanged.
{
  const regenerated = { ...current, lastTransitionId: "server:final:3" };
  const assessment = reconcileRecorderDraftIdentity({
    storedIdentity: current,
    currentIdentity: regenerated,
  });
  assert.equal(assessment.status, "stale_official");
  assert.equal(assessment.safe, false);
  assert.equal(assessment.canRestore, true);
  assert.deepEqual(assessment.mismatchFields, ["lastTransitionId"]);
}

// A legacy record remains parseable for explicit recovery but has no automatic
// restore eligibility.
{
  const legacy = parseStoredRecorderDraft(JSON.stringify({
    draft,
    touched: ["0-a"],
    revision: 1,
  }));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.reason, "missing_identity");
  assert.equal(legacy.legacy, true);
  assert.equal(reconcileRecorderDraftIdentity({
    storedIdentity: legacy.value.identity,
    currentIdentity: current,
  }).status, "missing_identity");
}

// Storage writes use the v2 identity schema and retain a mismatched record in
// a deterministic recovery slot instead of overwriting it.
{
  const store = storage();
  const old = { ...current, teamAId: "team-old", teamAName: "이전팀" };
  assert.equal(writeStoredRecorderDraft(store, "score-key", {
    draft,
    touched: ["0-a"],
    revision: 1,
    identity: old,
  }).ok, true);
  assert.equal(writeStoredRecorderDraft(store, "score-key", {
    draft: { sets: [{ a: 9, b: 9 }] },
    touched: ["0-b"],
    revision: 2,
    identity: current,
  }).preserved, true);
  const active = readStoredRecorderDraft(store, "score-key");
  const recovery = readStoredRecorderDraft(store, recorderDraftRecoveryKey("score-key", old));
  assert.equal(active.value.identity.teamAId, "team-a");
  assert.equal(recovery.value.identity.teamAId, "team-old");
  assert.equal(Object.hasOwn(active.value.identity, "courtId"), false);
}

// Explicit preservation can retain the old record, while a clear guarded by a
// new fixture identity does not delete it.
{
  const store = storage();
  const old = { ...current, teamAId: "team-old", teamAName: "이전팀" };
  store.setItem("score-key", JSON.stringify({ draft, touched: [], revision: 1 }));
  assert.equal(preserveStoredRecorderDraft(store, "score-key", {
    draft, touched: [], revision: 1, identity: null,
  }).ok, true);
  const cleared = removeStoredRecorderDraft(store, "score-key", current);
  assert.equal(cleared.ok, true);
  assert.notEqual(store.getItem("score-key"), null);
  assert.notEqual(store.getItem(recorderDraftRecoveryKey("score-key")), null);
  assert.equal(recorderFixtureIdentityEqual(old, current), false);
}

// A late submit response from the old fixture cannot reset the current
// fixture, even when the match key was reused.
{
  const pending = buildRecorderSubmitContext({
    matchKey: current.matchKey,
    courtId: "court-a",
    token: "token-1",
    queueRevision: 4,
    score: draft,
    operationId: "operation-1",
    storageKey: "score-key",
    fixtureIdentity: current,
    contextVersion: 0,
  });
  const regenerated = { ...current, lastTransitionId: "server:final:3" };
  const result = reconcileRecorderSubmit({
    pendingSubmit: pending,
    currentMatchKey: current.matchKey,
    currentFixtureIdentity: regenerated,
    currentContextVersion: 1,
    outcome: "success",
  });
  assert.equal(result.status, "completed_stale");
  assert.equal(result.resetCurrent, false);
  assert.equal(result.clearStorageKey, "");
}

const staleContextResult = reconcileRecorderSubmit({
  pendingSubmit: buildRecorderSubmitContext({
    matchKey: current.matchKey,
    courtId: "court-a",
    token: "token-2",
    queueRevision: 4,
    score: draft,
    operationId: "operation-2",
    fixtureIdentity: current,
    contextVersion: 1,
  }),
  currentMatchKey: current.matchKey,
  currentFixtureIdentity: current,
  currentContextVersion: 2,
  outcome: "success",
});
assert.equal(staleContextResult.status, "completed_stale");

// Ownership reconciliation also ignores a workflow snapshot carrying an old
// operation after the same match key has been regenerated.
{
  const pending = buildRecorderSubmitContext({
    matchKey: current.matchKey,
    courtId: "court-a",
    token: "token-1",
    queueRevision: 4,
    score: draft,
    operationId: "operation-1",
    fixtureIdentity: current,
    contextVersion: 0,
  });
  const regenerated = { ...current, lastTransitionId: "server:final:3" };
  const ownership = reconcileRecorderOwnership({
    workflow: { lock: null, draftState: "idle" },
    metadata: { fromCache: false },
    matchKey: current.matchKey,
    token: pending.token,
    currentFixtureIdentity: regenerated,
    pendingSubmit: pending,
  });
  assert.equal(ownership.status, "ignore");
  assert.equal(ownership.stale, true);
}

const staleSnapshot = reconcileRecorderSnapshot({
  pendingSave: {
    context: { fixtureIdentity: current },
    draft,
    expectedRevision: 1,
  },
  remoteDraft: { sets: [{ a: 9, b: 9 }] },
  remoteRevision: 2,
  currentFixtureIdentity: { ...current, lastTransitionId: "server:final:3" },
});
assert.equal(staleSnapshot.status, "ignore");
assert.equal(staleSnapshot.stale, true);

// A storage implementation that fails while preserving a mismatched record
// returns an explicit preservation failure instead of destructive success.
{
  const old = {
    ...current,
    teamAId: "team-old",
    teamAName: "이전팀",
  };
  let writes = 0;
  const failing = {
    getItem() { return JSON.stringify({ schemaVersion: 2, draft, touched: [], revision: 1, identity: old }); },
    setItem() { writes += 1; throw new Error("quota"); },
  };
  const result = writeStoredRecorderDraft(failing, "score-key", {
    draft, touched: [], revision: 2, identity: current,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "preserve_failed");
  assert.equal(writes, 1);
}

// Exercise the real submit handler and live queue callback in both delivery orders.
const recorderSource = readFileSync(new URL("./recorder.js", import.meta.url), "utf8");
function recorderFunction(name) {
  const start = recorderSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = recorderSource.indexOf("\n}", start);
  assert.ok(end > start, name);
  return recorderSource.slice(start, end + 2);
}
function submitRaceHarness() {
  const local = storage();
  const score = { sets: [{ a: 5, b: 10 }, { a: 5, b: 10 }] };
  const nextDraft = { sets: [{ a: 7, b: 6 }] };
  const identities = new Map(["M1", "M2"].map((key) => [key, {
    ...current, matchKey: key, teamAName: `${key} A팀`, teamBName: `${key} B팀`,
  }]));
  for (const [key, identity] of identities) {
    writeStoredRecorderDraft(local, `score:${key}`, {
      draft: key === "M1" ? score : nextDraft, touched: [], revision: 0, identity,
    });
  }
  const ui = Object.fromEntries([
    "authPanel", "courtPanel", "confirmPanel", "courtOperationsPanel", "workflowPanel", "backToEditButton",
    "submitButton", "scoreFields", "scoreLegend", "scoreError", "successPanel", "successTitle", "confirmOutcome", "connectionStatus",
  ].map((id) => [id, { hidden: false, disabled: false, textContent: "", replaceChildren() {} }]));
  ui.authPanel.hidden = true;
  ui.successPanel.hidden = true;
  const edit = {
    token: "M1-token", localDraft: score, serverDraft: score, dirty: true, touched: new Set(["0-a"]),
    savedRevision: 0,
    reviewedPayload: score, pendingSubmit: null, pendingSave: null, pendingEnd: null, pendingDiscard: null,
  };
  const requests = [], warnings = [], actions = [], attachments = [];
  let queueListener;
  const context = {
    ui, edit, busy: false, viewState: "operations", courtId: "court-a", matchKey: "M1",
    courtContextVersion: 1, contextVersion: 0, fixtureIdentity: identities.get("M1"),
    workflow: { submissionVersion: 0 }, assignment: { id: "M1" },
    dataHealth: { queue: { status: "ready" } },
    submissionWarning: null,
    queue: { currentMatchKey: "M1", queueRevision: 1 }, courtStops: [], db: {}, TOURNAMENT_ID: "test",
    buildRecorderSubmitContext, reconcileRecorderSubmit, recorderFixtureIdentityEqual, cloneRecorderFixtureIdentity,
    preserveStoredRecorderDraft, removeStoredRecorderDraft, writeStoredRecorderDraft,
    actionsReady: () => true, authActionsReady: () => true, ownershipLostFor: () => false, clearVerifiedOperationWarning() {},
    preserveOwnershipWarning: () => false, reconcileFailedOperationOwnership() {},
    ambiguousNetworkResult: (error) => error.code === "functions/unavailable",
    recorderReason: (error) => error.message,
    stopHeartbeat() {}, clearStorageStatus() {}, focus() {}, renderCourtSelectors() {},
    setStorageStatus: (reason) => warnings.push(reason),
    getLocalStorage: () => local, storageKeyForEdit: () => `score:${context.matchKey}`,
    isFinal: () => false, operationId: () => "submit-operation-1",
    draftTeamPair: (identity) => `${identity.teamAName} vs ${identity.teamBName}`,
    action: (message) => actions.push(message),
    status: (message) => { warnings.push(message); ui.connectionStatus.textContent = message; },
    doc: (_db, ...parts) => parts.join("/"),
    onSnapshot: (_ref, _options, callback) => { queueListener = callback; return () => {}; },
    subscribeCourt: () => () => {}, subscribeCourtSchedule() {}, setDataState() {}, setSnapshotState() {},
    clearConfirmation: () => { ui.confirmPanel.hidden = true; },
    clearCurrentMatch: () => { context.matchKey = ""; context.fixtureIdentity = null; },
    attachMatch: (key) => {
      attachments.push(key);
      context.contextVersion += 1;
      context.matchKey = key;
      context.fixtureIdentity = identities.get(key);
    },
    render: () => { context.syncScreenVisibility(); context.fenceAmbiguousOperation(); },
    setBusy: (value) => { context.busy = value; context.render(); },
    submitRecorderDraft: (pending) => new Promise((resolve, reject) => {
      requests.push({ pending, resolve, reject });
    }),
  };
  vm.createContext(context);
  const names = ["currentFixtureIdentity", "operationContextIsCurrent", "syncScreenVisibility",
    "resetMatchEditor", "clearStoredKey", "storeDraft", "fenceAmbiguousOperation", "followCourtQueue", "subscribeCourtStreams",
    "showSubmissionWarning", "clearSubmissionWarning"];
  const start = recorderSource.indexOf("ui.submitButton.onclick=async()=>{");
  const end = recorderSource.indexOf("\nui.endButton.onclick", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${names.map(recorderFunction).join("\n")}\n${recorderSource.slice(start, end)}`, context);
  context.subscribeCourtStreams();
  const snapshot = (key) => queueListener({
    id: "court-a", exists: () => true, data: () => ({ currentMatchKey: key, queueRevision: 2 }),
    metadata: { fromCache: false },
  });
  return { context, ui, edit, requests, warnings, actions, attachments, local, identities, snapshot, score, nextDraft };
}

for (const queueFirst of [true, false]) {
  for (const nextMatch of ["M2", null]) {
    const h = submitRaceHarness();
    const sending = h.ui.submitButton.onclick();
    if (queueFirst) {
      h.snapshot(nextMatch);
      assert.equal(h.context.matchKey, "M1", "queue advancement waits for the pending submit response");
      assert.equal(h.ui.confirmPanel.hidden, false);
      assert.equal(h.ui.submitButton.disabled, true, "live snapshots cannot enable a duplicate in-flight submit");
      await h.ui.submitButton.onclick();
      assert.equal(h.requests.length, 1);
    }
    h.requests[0].resolve({ submitted: true });
    await sending;
    if (!queueFirst) h.snapshot(nextMatch);
    assert.equal(h.context.matchKey, nextMatch || "");
    assert.equal(h.edit.pendingSubmit, null);
    assert.equal(h.edit.reviewedPayload, null);
    assert.equal(h.edit.token, null);
    assert.equal(h.edit.dirty, false);
    assert.equal(h.ui.confirmPanel.hidden, true, "the submitted confirmation does not reappear");
    assert.equal(h.ui.successPanel.hidden, false);
    assert.match(h.ui.successTitle.textContent, /M1 A팀 vs M1 B팀/);
    assert.equal(h.actions.at(-1), "제출 완료");
    assert.deepEqual(h.warnings, []);
    assert.equal(h.local.getItem("score:M1"), null);
    assert.deepEqual(readStoredRecorderDraft(h.local, "score:M2").value.draft, h.nextDraft);
  }
}

{
  const h = submitRaceHarness();
  const first = h.ui.submitButton.onclick();
  const pending = h.edit.pendingSubmit;
  h.snapshot("M2");
  h.requests[0].reject(Object.assign(new Error("response lost"), { code: "functions/unavailable" }));
  await first;
  assert.equal(h.edit.pendingSubmit, pending);
  assert.equal(h.context.matchKey, "M1");
  assert.equal(h.ui.confirmPanel.hidden, false);
  assert.equal(h.ui.submitButton.disabled, false, "an ambiguous response remains retryable without reloading");
  const retry = h.ui.submitButton.onclick();
  assert.equal(h.requests[1].pending, pending, "retry uses the original score, token, match, and operation ID");
  h.requests[1].resolve({ submitted: true, idempotent: true });
  await retry;
  assert.equal(h.context.matchKey, "M2");
  assert.equal(h.ui.confirmPanel.hidden, true);
  assert.equal(h.ui.successPanel.hidden, false);
  assert.equal(h.edit.pendingSubmit, null);
  assert.equal(h.local.getItem("score:M1"), null);
  assert.equal(h.ui.connectionStatus.textContent, "", "confirmed retry clears only its own obsolete failure notice");
  assert.equal(h.ui.scoreError.textContent, "");
}

{
  const h = submitRaceHarness();
  const sending = h.ui.submitButton.onclick();
  h.requests[0].reject(Object.assign(new Error("response lost"), { code: "functions/unavailable" }));
  await sending;
  h.context.status("다른 탭의 입력권 변경을 확인하세요.");
  const retry = h.ui.submitButton.onclick();
  h.requests[1].resolve({ submitted: true });
  await retry;
  assert.equal(h.ui.connectionStatus.textContent, "다른 탭의 입력권 변경을 확인하세요.",
    "submission success does not erase unrelated warnings");
}

for (const storageFails of [false, true]) {
  const h = submitRaceHarness();
  const editedScore = { sets: [{ a: 7, b: 10 }, { a: 8, b: 10 }] };
  h.edit.localDraft = editedScore;
  h.edit.reviewedPayload = editedScore;
  const sending = h.ui.submitButton.onclick();
  h.snapshot("M2");
  if (storageFails) h.local.setItem = () => { throw new Error("quota"); };
  h.requests[0].reject(Object.assign(new Error("queue_changed"), { code: "functions/failed-precondition" }));
  await sending;
  assert.equal(h.ui.successPanel.hidden, true, "a rejected request is never presented as submitted");
  assert.equal(h.edit.pendingSubmit, null);
  if (storageFails) {
    assert.equal(h.context.matchKey, "M1");
    assert.equal(h.edit.localDraft, editedScore);
    assert.equal(h.edit.reviewedPayload, editedScore);
    assert.match(h.warnings.at(-1), /화면을 닫지 말고/);
  } else {
    assert.equal(h.context.matchKey, "M2", "a terminal rejection consumes the already received queue cursor");
    assert.deepEqual(readStoredRecorderDraft(h.local, "score:M1").value.draft, editedScore);
    assert.deepEqual(readStoredRecorderDraft(h.local, "score:M2").value.draft, h.nextDraft);
    assert.match(h.warnings.at(-1), /입력은 임시 초안으로 보관/);
    assert.equal(h.ui.confirmPanel.hidden, true);
  }
}

{
  const h = submitRaceHarness();
  const sending = h.ui.submitButton.onclick();
  h.snapshot("M2");
  // An administrator approves before the callable response: the real fixture
  // fence clears the old editor, but no newer local input has started.
  h.context.contextVersion += 1;
  h.context.fixtureIdentity = { ...h.context.fixtureIdentity, officialRevision: 3, lastTransitionId: "approved" };
  h.edit.token = null;
  h.edit.localDraft = null;
  h.edit.reviewedPayload = null;
  h.edit.dirty = false;
  h.requests[0].resolve({ submitted: true });
  await sending;
  assert.equal(h.context.matchKey, "M2", "an early approval does not strand an idle editor on the previous match");
  assert.equal(h.ui.successPanel.hidden, false);
  assert.equal(h.ui.confirmPanel.hidden, true);
  assert.deepEqual(h.warnings, []);
}

for (const regenerateSameKey of [false, true]) {
  const h = submitRaceHarness();
  const sending = h.ui.submitButton.onclick();
  h.context.contextVersion += 1;
  h.context.matchKey = regenerateSameKey ? "M1" : "M2";
  h.context.fixtureIdentity = {
    ...h.identities.get(h.context.matchKey), lastTransitionId: "new-fixture",
  };
  const newer = { sets: [{ a: 10, b: 8 }, { a: 10, b: 6 }] };
  h.edit.localDraft = newer;
  h.edit.reviewedPayload = newer;
  h.edit.token = "newer-token";
  h.edit.dirty = true;
  const key = `score:${h.context.matchKey}`;
  writeStoredRecorderDraft(h.local, key, {
    draft: newer, touched: ["0-a"], revision: 3, identity: h.context.fixtureIdentity,
  });
  const before = h.local.getItem(key);
  h.requests[0].resolve({ submitted: true });
  await sending;
  assert.equal(h.edit.localDraft, newer, "a real context change still protects the newer input");
  assert.equal(h.edit.reviewedPayload, newer);
  assert.equal(h.edit.token, "newer-token");
  assert.equal(h.edit.dirty, true);
  assert.equal(h.local.getItem(key), before);
  assert.equal(h.ui.successPanel.hidden, false);
  assert.match(h.ui.successTitle.textContent, /M1 A팀 vs M1 B팀/, "the receipt identifies the submitted match");
  assert.deepEqual(h.warnings, [], "successful stale responses are not reported as submission errors");
}

console.log("recorder draft identity and submit ordering fixtures passed");

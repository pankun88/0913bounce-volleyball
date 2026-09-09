import assert from "node:assert/strict";
import {
  buildRecorderFixtureIdentity,
  buildRecorderSubmitContext,
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

console.log("recorder draft identity fixtures passed");

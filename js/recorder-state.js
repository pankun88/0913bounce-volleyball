import { courtMatchLabel, courtTeamNames } from "./court-display.js";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const RECORDER_DRAFT_SCHEMA_VERSION = 2;

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function identityTeamId(value) {
  if (typeof value === "string") return textValue(value) || null;
  if (!isRecord(value)) return null;
  return textValue(value.id || value.teamId) || null;
}

function identityTeamName(value) {
  if (!isRecord(value)) return "";
  return textValue(value.name || value.teamName);
}

function identityRevision(...values) {
  const value = values.find((item) => Number.isInteger(item) && item >= 0);
  return Number.isInteger(value) ? value : null;
}

function identityTransition(...values) {
  const value = values.find((item) => item === null || typeof item === "string");
  return value === null ? null : (textValue(value) || null);
}

function identityDivision(value) {
  return textValue(value?.divisionId || value?.division);
}

/**
 * Normalize the immutable identity of the official fixture represented by a
 * recorder draft. Court and recorder selectors are deliberately absent:
 * moving a fixture between courts must not create a new draft identity.
 */
export function normalizeRecorderFixtureIdentity(value) {
  if (!isRecord(value)) return null;
  const matchKey = textValue(value.matchKey);
  const rawMatchType = textValue(value.matchType || value.type);
  const matchType = rawMatchType === "finals" || rawMatchType === "tournament"
    ? "final"
    : rawMatchType;
  const divisionId = identityDivision(value);
  const teamAId = identityTeamId(value.teamAId ?? value.teamA);
  const teamBId = identityTeamId(value.teamBId ?? value.teamB);
  const officialRevision = identityRevision(value.officialRevision);
  if (value.lastTransitionId !== undefined && value.lastTransitionId !== null
      && typeof value.lastTransitionId !== "string") return null;
  const lastTransitionId = identityTransition(value.lastTransitionId);
  if (!matchKey || !matchType || !divisionId || !teamAId || !teamBId
      || officialRevision === null) return null;
  return {
    matchKey,
    matchType,
    divisionId,
    teamAId,
    teamBId,
    officialRevision,
    lastTransitionId,
    teamAName: textValue(value.teamAName || value.teamA?.name),
    teamBName: textValue(value.teamBName || value.teamB?.name),
  };
}

/**
 * Capture current assignment/official fields as a stable local-draft
 * identity. `previousIdentity` supplies fields that an unchanged official
 * snapshot omits, preventing recorder claim/lease transitions from looking
 * like a regenerated fixture.
 */
export function buildRecorderFixtureIdentity({
  matchKey = "",
  assignment = null,
  official = null,
  workflow = null,
  teamAName = "",
  teamBName = "",
  previousIdentity = null,
} = {}) {
  const key = textValue(matchKey || assignment?.matchKey || assignment?.id
    || official?.matchKey || official?.id);
  const rawType = textValue(assignment?.matchType || assignment?.type || assignment?.phase
    || official?.matchType || official?.type);
  const matchType = rawType === "finals" || rawType === "tournament" ? "final" : rawType;
  const divisionId = identityDivision(assignment) || identityDivision(official)
    || identityDivision(workflow) || textValue(previousIdentity?.divisionId);
  const teamA = official?.teamA ?? official?.teamAId ?? assignment?.teamA ?? assignment?.teamAId;
  const teamB = official?.teamB ?? official?.teamBId ?? assignment?.teamB ?? assignment?.teamBId;
  const teamAId = identityTeamId(teamA) || textValue(previousIdentity?.teamAId) || null;
  const teamBId = identityTeamId(teamB) || textValue(previousIdentity?.teamBId) || null;
  const officialRevision = identityRevision(
    official?.officialRevision,
    assignment?.officialRevision,
    workflow?.officialRevision,
    previousIdentity?.officialRevision,
  );
  const officialHasTransition = isRecord(official) && Object.hasOwn(official, "lastTransitionId");
  const lastTransitionId = officialHasTransition
    ? identityTransition(official.lastTransitionId)
    : identityTransition(previousIdentity?.lastTransitionId);
  const identity = normalizeRecorderFixtureIdentity({
    matchKey: key,
    matchType,
    divisionId,
    teamAId,
    teamBId,
    officialRevision,
    lastTransitionId,
    teamAName: teamAName || identityTeamName(teamA) || previousIdentity?.teamAName,
    teamBName: teamBName || identityTeamName(teamB) || previousIdentity?.teamBName,
  });
  return identity;
}

export function cloneRecorderFixtureIdentity(value) {
  const normalized = normalizeRecorderFixtureIdentity(value);
  return normalized ? { ...normalized } : null;
}

function identityStructuralKey(value) {
  const identity = normalizeRecorderFixtureIdentity(value);
  if (!identity) return null;
  return [
    identity.matchKey,
    identity.matchType,
    identity.divisionId,
    identity.teamAId,
    identity.teamBId,
  ].join("\u0001");
}

export function recorderFixtureIdentityEqual(left, right) {
  const a = normalizeRecorderFixtureIdentity(left);
  const b = normalizeRecorderFixtureIdentity(right);
  if (!a || !b) return false;
  return identityStructuralKey(a) === identityStructuralKey(b)
    && a.officialRevision === b.officialRevision
    && a.lastTransitionId === b.lastTransitionId;
}

export function recorderFixtureStructureEqual(left, right) {
  return Boolean(identityStructuralKey(left) && identityStructuralKey(left) === identityStructuralKey(right));
}

/**
 * Classify whether a stored record may be restored into the current official
 * fixture. Names are returned solely for explanatory recovery UI; they never
 * participate in identity equality.
 */
export function reconcileRecorderDraftIdentity({
  storedIdentity = null,
  currentIdentity = null,
} = {}) {
  const stored = normalizeRecorderFixtureIdentity(storedIdentity);
  const current = normalizeRecorderFixtureIdentity(currentIdentity);
  const teams = {
    stored: { a: stored?.teamAName || "", b: stored?.teamBName || "" },
    current: { a: current?.teamAName || "", b: current?.teamBName || "" },
  };
  if (!stored) {
    return {
      status: "missing_identity",
      safe: false,
      canRestore: false,
      storedIdentity: null,
      currentIdentity: cloneRecorderFixtureIdentity(current),
      teams,
    };
  }
  if (!current) {
    return {
      status: "current_identity_missing",
      safe: false,
      canRestore: false,
      storedIdentity: cloneRecorderFixtureIdentity(stored),
      currentIdentity: null,
      teams,
    };
  }
  const structuralMatch = recorderFixtureStructureEqual(stored, current);
  const exact = recorderFixtureIdentityEqual(stored, current);
  const mismatchFields = [];
  if (stored.matchKey !== current.matchKey) mismatchFields.push("matchKey");
  if (stored.matchType !== current.matchType) mismatchFields.push("matchType");
  if (stored.divisionId !== current.divisionId) mismatchFields.push("divisionId");
  if (stored.teamAId !== current.teamAId) mismatchFields.push("teamAId");
  if (stored.teamBId !== current.teamBId) mismatchFields.push("teamBId");
  if (stored.officialRevision !== current.officialRevision) mismatchFields.push("officialRevision");
  if (stored.lastTransitionId !== current.lastTransitionId) mismatchFields.push("lastTransitionId");
  return {
    status: exact ? "same_fixture" : structuralMatch ? "stale_official" : "mismatch",
    safe: exact,
    canRestore: structuralMatch,
    storedIdentity: cloneRecorderFixtureIdentity(stored),
    currentIdentity: cloneRecorderFixtureIdentity(current),
    mismatchFields,
    teams,
  };
}

export function recorderDraftRecoveryKey(key, identity = null) {
  if (typeof key !== "string" || !key) return "";
  const normalized = normalizeRecorderFixtureIdentity(identity);
  const fields = normalized
    ? [normalized.matchKey, normalized.matchType, normalized.divisionId, normalized.teamAId,
      normalized.teamBId, normalized.officialRevision, normalized.lastTransitionId || ""]
    : ["legacy"];
  return `${key}:recovery:${fields.map((value) => encodeURIComponent(String(value))).join("~")}`;
}

function normalizeScoreValue(value) {
  if (value === "" || value === null || value === undefined) return "";
  if (typeof value === "string" && value.trim() === "") return "";
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 15) return null;
  return number;
}

export function normalizeRecorderDraft(value) {
  if (!isRecord(value) || !Array.isArray(value.sets) || value.sets.length > 3) return null;
  const sets = value.sets.map((set) => {
    if (!isRecord(set)) return null;
    const a = normalizeScoreValue(set.a);
    const b = normalizeScoreValue(set.b);
    return a === null || b === null ? null : { a, b };
  });
  return sets.some((set) => set === null) ? null : { sets };
}

export function cloneRecorderDraft(value) {
  const normalized = normalizeRecorderDraft(value);
  return normalized ? { sets: normalized.sets.map(({ a, b }) => ({ a, b })) } : null;
}

function recorderNameForCourt(court) {
  const value = typeof court?.recorderName === "string" ? court.recorderName.trim() : "";
  return value ? [value] : [];
}

/**
 * Keep the recorder's two explicit selectors aligned with the authoritative
 * court collection. A changed/removed court or reassigned recorder invalidates
 * the stale name rather than silently selecting a different identity.
 */
export function reconcileRecorderSelections(courts, selectedCourtId = "", selectedRecorder = "") {
  const list = Array.isArray(courts) ? courts : [];
  const court = list.find((item) => item?.id === selectedCourtId) || null;
  const courtId = court?.id || "";
  const availableNames = recorderNameForCourt(court);
  const candidate = typeof selectedRecorder === "string" ? selectedRecorder.trim() : "";
  return {
    court,
    courtId,
    availableNames,
    recorder: availableNames.includes(candidate) ? candidate : "",
  };
}

/**
 * Assignment snapshots can arrive from the local Firestore cache after an
 * administrator moves a match. A cached court mismatch is not authoritative;
 * only a server snapshot may revoke the recorder's current court context.
 */
export function reconcileRecorderAssignment({ assignment, metadata = null, courtId = "" } = {}) {
  const assignedCourtId = typeof assignment?.courtId === "string" ? assignment.courtId : "";
  const mismatch = Boolean(assignedCourtId && courtId && assignedCourtId !== courtId);
  if (!mismatch) return { status: "owned" };
  if (metadata?.fromCache === true) return { status: "ignore" };
  return { status: "lost", assignedCourtId };
}

/**
 * Build the text-only data used by the confirmation view. The caller supplies
 * the already evaluated outcome; this helper only clones and shapes reviewed
 * score data so a DOM renderer cannot accidentally flatten or reinterpret it.
 */
export function buildRecorderConfirmationModel({
  court = "",
  recorder = "",
  matchLabel = "",
  teamA = "",
  teamB = "",
  score,
  outcome = "",
} = {}) {
  const draft = cloneRecorderDraft(score);
  return {
    court: String(court || ""),
    recorder: String(recorder || ""),
    matchLabel: String(matchLabel || ""),
    teamA: String(teamA || ""),
    teamB: String(teamB || ""),
    sets: (draft?.sets || []).map((set, index) => ({
      label: `${index + 1}세트`,
      a: set.a,
      b: set.b,
    })),
    outcome: String(outcome || ""),
  };
}

/**
 * Capture all values needed to retry an idempotent submit. In particular, the
 * storage key and fixture identity belong to the submitted match, not
 * whichever match a live queue snapshot may display while the RPC is in flight.
 */
export function buildRecorderSubmitContext({
  matchKey,
  courtId,
  token,
  queueRevision,
  score,
  final = false,
  operationId,
  storageKey = "",
  submissionVersion = null,
  fixtureIdentity = null,
  contextVersion = null,
} = {}) {
  const draft = cloneRecorderDraft(score);
  const identity = cloneRecorderFixtureIdentity(fixtureIdentity);
  if (typeof matchKey !== "string" || !matchKey
      || typeof courtId !== "string" || !courtId
      || typeof token !== "string" || !token
      || !draft
      || typeof operationId !== "string" || !operationId
      || !identity
      || !Number.isInteger(contextVersion) || contextVersion < 0) {
    return null;
  }
  return {
    matchKey,
    courtId,
    token,
    queueRevision,
    score: draft,
    final: Boolean(final),
    operationId,
    storageKey: typeof storageKey === "string" ? storageKey : "",
    submissionVersion: Number.isInteger(submissionVersion) ? submissionVersion : null,
    fixtureIdentity: identity,
    contextVersion: Number.isInteger(contextVersion) ? contextVersion : null,
  };
}

/**
 * Resolve a submit response without losing the context of a newer queue match
 * or regenerated fixture. Ambiguous/lost responses retain the exact pending
 * request for retry; a successful response clears only a matching fixture key.
 */
export function reconcileRecorderSubmit({
  pendingSubmit,
  currentMatchKey = "",
  currentFixtureIdentity = null,
  currentContextVersion = null,
  outcome = "pending",
} = {}) {
  if (!pendingSubmit) return { status: "none", pendingSubmit: null };
  if (outcome !== "success") return { status: "pending", pendingSubmit };
  if (pendingSubmit.fixtureIdentity && currentFixtureIdentity
      && !recorderFixtureIdentityEqual(pendingSubmit.fixtureIdentity, currentFixtureIdentity)) {
    return {
      status: "completed_stale",
      pendingSubmit: null,
      clearStorageKey: "",
      resetCurrent: false,
    };
  }
  if (Number.isInteger(pendingSubmit.contextVersion) && Number.isInteger(currentContextVersion)
      && pendingSubmit.contextVersion !== currentContextVersion) {
    return {
      status: "completed_stale",
      pendingSubmit: null,
      clearStorageKey: "",
      resetCurrent: false,
    };
  }
  return {
    status: "completed",
    pendingSubmit: null,
    clearStorageKey: pendingSubmit.storageKey || "",
    resetCurrent: currentMatchKey === pendingSubmit.matchKey,
  };
}

export function recorderDraftsEqual(left, right) {
  const a = normalizeRecorderDraft(left);
  const b = normalizeRecorderDraft(right);
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function parseStoredRecorderDraft(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isRecord(value) || !Number.isInteger(value.revision) || value.revision < 0) {
    return { ok: false, reason: "malformed" };
  }
  const draft = normalizeRecorderDraft(value.draft);
  if (!draft || !Array.isArray(value.touched) || value.touched.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "malformed" };
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== RECORDER_DRAFT_SCHEMA_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  const identity = normalizeRecorderFixtureIdentity(
    value.identity || value.fixtureIdentity || value.fixture,
  );
  if (!identity) {
    return {
      ok: true,
      reason: "missing_identity",
      legacy: true,
      value: { draft, touched: [...value.touched], revision: value.revision, identity: null },
    };
  }
  return {
    ok: true,
    value: {
      draft,
      touched: [...value.touched],
      revision: value.revision,
      identity,
    },
  };
}

export function readStoredRecorderDraft(storage, key) {
  if (!key || !storage || typeof storage.getItem !== "function") return { ok: false, reason: "blocked" };
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { ok: true, found: false, value: null };
    const parsed = parseStoredRecorderDraft(raw);
    return parsed.ok ? { ...parsed, found: true } : parsed;
  } catch {
    return { ok: false, reason: "blocked" };
  }
}

export function writeStoredRecorderDraft(storage, key, value) {
  if (!key || !storage || typeof storage.setItem !== "function") return { ok: false, reason: "blocked" };
  const draft = cloneRecorderDraft(value?.draft);
  const identity = cloneRecorderFixtureIdentity(
    value?.identity || value?.fixtureIdentity || value?.fixture,
  );
  if (!draft || !Number.isInteger(value?.revision) || value.revision < 0
      || !Array.isArray(value?.touched) || value.touched.some((item) => typeof item !== "string")
      || !identity) {
    return { ok: false, reason: identity ? "invalid" : "missing_identity" };
  }
  const serialized = JSON.stringify({
    schemaVersion: RECORDER_DRAFT_SCHEMA_VERSION,
    draft,
    touched: [...value.touched],
    revision: value.revision,
    identity,
  });
  let preserved = false;
  try {
    const existingRaw = typeof storage.getItem === "function" ? storage.getItem(key) : null;
    if (existingRaw !== null) {
      const existing = parseStoredRecorderDraft(existingRaw);
      const existingIdentity = existing.ok ? existing.value.identity : null;
      if (!existing.ok || !recorderFixtureIdentityEqual(existingIdentity, identity)) {
        const recoveryKey = recorderDraftRecoveryKey(key, existingIdentity);
        try {
          storage.setItem(recoveryKey, existingRaw);
        } catch {
          return { ok: false, reason: "preserve_failed" };
        }
        preserved = true;
      }
    }
  } catch {
    return { ok: false, reason: "blocked" };
  }
  try {
    storage.setItem(key, serialized);
    return { ok: true, preserved };
  } catch {
    return { ok: false, reason: "blocked" };
  }
}

export function preserveStoredRecorderDraft(storage, key, value) {
  if (!key || !storage || typeof storage.setItem !== "function") return { ok: false, reason: "blocked" };
  const draft = cloneRecorderDraft(value?.draft);
  const identity = (value?.identity || value?.fixtureIdentity || value?.fixture)
    ? cloneRecorderFixtureIdentity(value.identity || value.fixtureIdentity || value.fixture)
    : null;
  if (!draft || !Number.isInteger(value?.revision) || value.revision < 0
      || !Array.isArray(value?.touched) || value.touched.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "invalid" };
  }
  const recoveryKey = recorderDraftRecoveryKey(key, identity);
  if (!recoveryKey || recoveryKey === key) return { ok: false, reason: "invalid" };
  const serialized = JSON.stringify({
    schemaVersion: identity ? RECORDER_DRAFT_SCHEMA_VERSION : undefined,
    draft,
    touched: [...value.touched],
    revision: value.revision,
    ...(identity ? { identity } : {}),
  });
  return preserveStoredRecorderRaw(storage, key, serialized, identity);
}

function preserveStoredRecorderRaw(storage, key, raw, identity = null) {
  const recoveryKey = recorderDraftRecoveryKey(key, identity);
  if (!recoveryKey || recoveryKey === key || typeof raw !== "string") return { ok: false, reason: "invalid" };
  try {
    storage.setItem(recoveryKey, raw);
    return { ok: true, key: recoveryKey };
  } catch {
    return { ok: false, reason: "blocked" };
  }
}

export function removeStoredRecorderDraft(storage, key, expectedIdentity = null) {
  if (!key || !storage || typeof storage.removeItem !== "function") return { ok: false, reason: "blocked" };
  try {
    if (expectedIdentity && typeof storage.getItem === "function") {
      const raw = storage.getItem(key);
      if (raw !== null) {
        const parsed = parseStoredRecorderDraft(raw);
        if (!parsed.ok || !recorderFixtureIdentityEqual(parsed.value.identity, expectedIdentity)) {
          const preserved = preserveStoredRecorderRaw(
            storage,
            key,
            raw,
            parsed.ok ? parsed.value.identity : null,
          );
          if (preserved.ok) return { ok: true, preserved: true };
          return { ok: false, reason: preserved.reason || "preserve_failed" };
        }
      }
    }
    storage.removeItem(key);
    return { ok: true };
  } catch {
    return { ok: false, reason: "blocked" };
  }
}

export function reconcileRecorderSnapshot({
  pendingSave,
  remoteDraft,
  remoteRevision,
  currentFixtureIdentity = null,
} = {}) {
  if (pendingSave?.context?.fixtureIdentity && currentFixtureIdentity
      && !recorderFixtureIdentityEqual(pendingSave.context.fixtureIdentity, currentFixtureIdentity)) {
    return { status: "ignore", stale: true };
  }
  if (!pendingSave || !Number.isInteger(remoteRevision)
      || !Number.isInteger(pendingSave.expectedRevision)
      || remoteRevision <= pendingSave.expectedRevision) {
    return { status: "ignore" };
  }
  const remote = cloneRecorderDraft(remoteDraft);
  const local = cloneRecorderDraft(pendingSave.draft);
  if (remote && local && recorderDraftsEqual(remote, local)) {
    return { status: "confirmed", draft: remote, revision: remoteRevision };
  }
  return {
    status: "conflict",
    localDraft: local,
    remoteDraft: remote,
    remoteRevision,
    expectedRevision: pendingSave.expectedRevision,
  };
}

function matchesRecorderOperation(operation, matchKey, token, currentFixtureIdentity = null) {
  return Boolean(operation
    && operation.matchKey === matchKey
    && operation.token === token
    && (!currentFixtureIdentity || !operation.fixtureIdentity
      || recorderFixtureIdentityEqual(operation.fixtureIdentity, currentFixtureIdentity)));
}

function terminalRecorderDraftState(workflow) {
  return ["idle", "rejected"].includes(workflow?.draftState);
}

function operationEvidence(workflow, kind, operation, uid) {
  if (kind === "submit") {
    const submittedDraft = workflow?.submittedSnapshot || workflow?.draft;
    const submittedBy = workflow?.submission?.recorder?.uid;
    const priorVersion = operation.submissionVersion;
    const nextVersion = workflow?.submissionVersion;
    const evidenceAvailable = workflow?.draftState !== undefined
      || workflow?.submittedSnapshot !== undefined
      || workflow?.submission !== undefined;
    return {
      evidenceAvailable,
      matches: workflow?.draftState === "submitted"
        && recorderDraftsEqual(submittedDraft, operation.score)
        && typeof uid === "string"
        && uid.length > 0
        && submittedBy === uid
        && (!Number.isInteger(priorVersion)
          || (Number.isInteger(nextVersion) && nextVersion > priorVersion)),
    };
  }
  if (kind === "end") {
    const retainedBy = workflow?.draftRetainedBy?.uid;
    const evidenceAvailable = workflow?.draftState !== undefined
      || workflow?.draftRetention !== undefined
      || workflow?.draftRetainedBy !== undefined;
    return {
      evidenceAvailable,
      matches: terminalRecorderDraftState(workflow)
        && workflow?.draftRetention === "retained_after_cancel"
        && typeof uid === "string"
        && uid.length > 0
        && retainedBy === uid
        && (!operation.draft || recorderDraftsEqual(workflow.draft, operation.draft)),
    };
  }
  const hasDraft = operation.draft?.sets?.length > 0;
  const evidenceAvailable = workflow?.draftState !== undefined
    || workflow?.draft !== undefined
    || workflow?.draftRetention !== undefined
    || workflow?.draftRetainedBy !== undefined;
  return {
    // Deleting an already-empty draft leaves no operation-specific server
    // evidence. Wait for the callable result instead of guessing ownership.
    evidenceAvailable: hasDraft ? evidenceAvailable : false,
    matches: hasDraft
      && terminalRecorderDraftState(workflow)
      && workflow?.draft === undefined
      && workflow?.draftRetention === undefined
      && workflow?.draftRetainedBy === undefined,
  };
}

/**
 * Reconcile an authoritative workflow snapshot with the recorder's active
 * lease. A pending submit/end/discard is allowed to release its own lock only
 * when the resulting workflow contains matching server evidence. Missing
 * evidence remains pending until the callable resolves; a different active
 * lock always means takeover. Cached snapshots are never allowed to revoke a
 * fresh lease.
 */
export function reconcileRecorderOwnership({
  workflow,
  metadata = null,
  matchKey = "",
  token = "",
  uid = "",
  currentFixtureIdentity = null,
  pendingSubmit = null,
  pendingEnd = null,
  pendingDiscard = null,
} = {}) {
  if (!token) return { status: "none" };
  if (metadata?.fromCache === true) return { status: "ignore" };
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return { status: "lost" };
  }
  const lock = workflow.lock;
  const operations = [
    ["submit", pendingSubmit],
    ["end", pendingEnd],
    ["discard", pendingDiscard],
  ].filter(([kind, operation]) => operation
    && operation.matchKey === matchKey
    && operation.token === token
    && currentFixtureIdentity
    && operation.fixtureIdentity
    && !recorderFixtureIdentityEqual(operation.fixtureIdentity, currentFixtureIdentity));
  if (operations.length) return { status: "ignore", stale: true };
  if (lock?.token === token && lock?.sessionId !== undefined) {
    return { status: "owned" };
  }
  const matchingOperations = [
    ["submit", pendingSubmit],
    ["end", pendingEnd],
    ["discard", pendingDiscard],
  ].filter(([, operation]) => matchesRecorderOperation(operation, matchKey, token, currentFixtureIdentity));
  if (lock) return { status: "lost" };
  if (!matchingOperations.length) return { status: "lost" };
  const [kind, operation] = matchingOperations[0];
  const evidence = operationEvidence(workflow, kind, operation, uid);
  if (evidence.matches) {
    return {
      status: "expected_release",
      operation: kind,
      operationId: operation.operationId || null,
    };
  }
  if (evidence.evidenceAvailable) {
    return {
      status: "lost",
      operation: kind,
      operationId: operation.operationId || null,
    };
  }
  return {
    status: "awaiting_operation",
    operation: kind,
    operationId: operation.operationId || null,
  };
}

export function resolveRecorderConflict(choice, conflict) {
  if (!conflict || !Number.isInteger(conflict.remoteRevision)) return { status: "invalid" };
  if (choice === "local" && conflict.localDraft) {
    return {
      status: "retry",
      draft: cloneRecorderDraft(conflict.localDraft),
      expectedRevision: conflict.remoteRevision,
    };
  }
  if (choice === "remote" && conflict.remoteDraft) {
    return {
      status: "use_remote",
      draft: cloneRecorderDraft(conflict.remoteDraft),
      revision: conflict.remoteRevision,
    };
  }
  return { status: "invalid" };
}

export function recorderDataState(previous, event, error = null) {
  if (event === "ready") return { status: "ready", error: null };
  if (event === "error") return { status: "error", error };
  if (event === "loading") return { status: "loading", error: null };
  return previous || { status: "idle", error: null };
}

const naturalCourtCollator = typeof Intl !== "undefined" && typeof Intl.Collator === "function"
  ? new Intl.Collator("ko", { numeric: true, sensitivity: "base" })
  : null;

function naturalTextCompare(left, right) {
  const a = left === null || left === undefined ? "" : String(left).trim();
  const b = right === null || right === undefined ? "" : String(right).trim();
  if (naturalCourtCollator) return naturalCourtCollator.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function numericOrder(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function courtSortCompare(left, right) {
  const leftOrder = numericOrder(left?.order);
  const rightOrder = numericOrder(right?.order);
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  if (leftOrder === null && rightOrder !== null) return 1;
  if (leftOrder !== null && rightOrder === null) return -1;
  const names = naturalTextCompare(left?.name || left?.label, right?.name || right?.label);
  return names || naturalTextCompare(left?.id, right?.id);
}

/**
 * Sort a Firestore court snapshot for display without changing the snapshot
 * array (or any court object) supplied by the listener.
 */
export function sortRecorderCourts(courts) {
  if (!Array.isArray(courts)) return [];
  return courts
    .map((court, index) => ({ court, index }))
    .sort((left, right) => courtSortCompare(left.court, right.court) || left.index - right.index)
    .map(({ court }) => court);
}

function scheduleMatchKey(assignment) {
  return assignment?.matchKey || assignment?.id || "";
}

function scheduleOfficialMatch(officialMatches, key) {
  return officialMatches instanceof Map
    ? officialMatches.get(key) || null
    : officialMatches?.[key] || null;
}

function publishedScheduleScore(official) {
  if (!official || official.officialCurrent === false || official.isOfficialCurrent === false
      || ["retracted", "superseded", "non_current"].includes(official.officialStatus)) return null;
  const published = ["done", "completed", "approved"].includes(official.status)
    || ["done", "completed", "approved"].includes(official.publicStatus)
    || (Number.isInteger(official.officialRevision) && official.officialRevision > 0
      && (official.result || official.winner));
  if (!published || !Array.isArray(official.sets) || !official.sets.length) return null;
  return {
    sets: official.sets.map((set) => ({ a: set?.a ?? "", b: set?.b ?? "" })),
    result: String(official.result || official.winner || ""),
  };
}

function scheduleBaseStatus(assignment, official, score) {
  const staleOfficial = official?.officialCurrent === false || official?.isOfficialCurrent === false
    || ["retracted", "superseded", "non_current"].includes(official?.officialStatus);
  if (staleOfficial && !String(assignment?.publicStatus || "").toLowerCase().includes("replay")) {
    const assignmentStatus = String(assignment?.publicStatus || "").toLowerCase();
    if (!["under_review", "review", "submitted"].includes(assignmentStatus)) return "waiting";
  }
  const value = String(assignment?.publicStatus || official?.publicStatus || official?.status || "").toLowerCase();
  if (value.includes("replay") || value.includes("rework") || value.includes("correction")) return "replay";
  if (value === "under_review" || value === "review" || value === "submitted") return "under_review";
  if (value === "completed" || value === "approved" || value === "done" || score) return "completed";
  return "waiting";
}

/**
 * Produce the read-only court schedule. Queue markers are authoritative:
 * adjacency in this ordered list is never used to guess current or next.
 */
export function buildRecorderCourtSchedule({
  assignments = [],
  queue = null,
  officialMatches = new Map(),
  teamsById = new Map(),
  groupsById = new Map(),
} = {}) {
  const list = Array.isArray(assignments) ? assignments : [];
  const currentMatchKey = queue?.currentMatchKey || null;
  const nextMatchKey = queue?.nextMatchKey || null;
  return list
    .map((assignment, index) => ({ assignment, index }))
    .sort((left, right) => {
      const leftOrder = numericOrder(left.assignment?.courtOrder);
      const rightOrder = numericOrder(right.assignment?.courtOrder);
      if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (leftOrder === null && rightOrder !== null) return 1;
      if (leftOrder !== null && rightOrder === null) return -1;
      return naturalTextCompare(scheduleMatchKey(left.assignment), scheduleMatchKey(right.assignment))
        || left.index - right.index;
    })
    .map(({ assignment }) => {
      const matchKey = scheduleMatchKey(assignment);
      const official = scheduleOfficialMatch(officialMatches, matchKey);
      const score = publishedScheduleScore(official);
      const names = courtTeamNames(official, teamsById) || { a: "대진 미정", b: "대진 미정" };
      const label = courtMatchLabel(assignment, official, groupsById);
      const isCurrent = Boolean(currentMatchKey && matchKey === currentMatchKey);
      const isNext = Boolean(nextMatchKey && matchKey === nextMatchKey);
      const baseStatus = scheduleBaseStatus(assignment, official, score);
      const status = isCurrent ? "current" : isNext ? "next" : baseStatus;
      return {
        matchKey,
        courtOrder: numericOrder(assignment?.courtOrder),
        assignment,
        official,
        label,
        stage: label,
        teamA: names.a,
        teamB: names.b,
        matchup: `${names.a} vs ${names.b}`,
        score,
        status,
        baseStatus,
        statusLabel: {
          current: "현재 경기",
          next: "다음 경기",
          waiting: "대기",
          under_review: "검토 중",
          completed: "완료",
          replay: "재경기",
        }[status],
        isCurrent,
        isNext,
        eligibleCurrent: isCurrent && assignment?.dependencyReady !== false,
      };
    });
}

/**
 * Explicitly transition between the court selection and operations screens.
 * A blocked change request stays on operations instead of discarding work.
 */
export function recorderRouteState(previous = "selection", event = "", { canEnter = false, blocked = false } = {}) {
  const current = previous === "operations" ? "operations" : "selection";
  if (event === "enter" && canEnter && !blocked) return "operations";
  if (event === "change" && !blocked) return "selection";
  if (event === "logout" || event === "reset") return "selection";
  return current;
}

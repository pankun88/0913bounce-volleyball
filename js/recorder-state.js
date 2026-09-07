import { courtMatchLabel, courtTeamNames } from "./court-display.js";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

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
 * storage key belongs to the submitted match, not whichever match a live queue
 * snapshot may display while the RPC is in flight.
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
} = {}) {
  const draft = cloneRecorderDraft(score);
  if (typeof matchKey !== "string" || !matchKey
      || typeof courtId !== "string" || !courtId
      || typeof token !== "string" || !token
      || !draft
      || typeof operationId !== "string" || !operationId) {
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
  };
}

/**
 * Resolve a submit response without losing the context of a newer queue match.
 * Ambiguous/lost responses retain the exact pending request for retry; a
 * successful response clears only the captured storage key.
 */
export function reconcileRecorderSubmit({ pendingSubmit, currentMatchKey = "", outcome = "pending" } = {}) {
  if (!pendingSubmit) return { status: "none", pendingSubmit: null };
  if (outcome !== "success") return { status: "pending", pendingSubmit };
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
  return { ok: true, value: { draft, touched: [...value.touched], revision: value.revision } };
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
  if (!draft || !Number.isInteger(value?.revision) || value.revision < 0
      || !Array.isArray(value?.touched) || value.touched.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "invalid" };
  }
  try {
    storage.setItem(key, JSON.stringify({ draft, touched: [...value.touched], revision: value.revision }));
    return { ok: true };
  } catch {
    return { ok: false, reason: "blocked" };
  }
}

export function removeStoredRecorderDraft(storage, key) {
  if (!key || !storage || typeof storage.removeItem !== "function") return { ok: false, reason: "blocked" };
  try {
    storage.removeItem(key);
    return { ok: true };
  } catch {
    return { ok: false, reason: "blocked" };
  }
}

export function reconcileRecorderSnapshot({ pendingSave, remoteDraft, remoteRevision }) {
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

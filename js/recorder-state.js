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

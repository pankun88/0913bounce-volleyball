import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { auth, db, functions } from "./firebase-init.js";
import { TOURNAMENT_ID } from "./firebase-config.js";
import { normalizePlayedSets } from "./match-logic.js";

const base = (collection, id) => doc(db, "tournaments", TOURNAMENT_ID, collection, id);
const sessionStorageKey = `recorder-session:${TOURNAMENT_ID}`;
const reasonMessages = {
  unresolved_teams: "대진이 확정되기를 기다리고 있습니다.",
  stale_queue: "경기 순서가 변경되었습니다. 현재 경기를 다시 확인하세요.",
  ownership_lost: "다른 탭 또는 기록관이 이 입력을 이어받았습니다.",
  lease_expired: "입력 시간이 만료되었습니다. 초안을 이어서 하세요.",
  submitted: "이미 제출된 경기입니다.",
  maintenance: "대회 점검 중입니다. 점검 후 다시 시도하세요.",
  recorder_access_required: "현재 기록관 권한이 필요합니다.",
  recorder_name_changed: "담당 기록관 이름이 변경되었습니다. 코트를 다시 선택하세요.",
  operation_mismatch: "이 요청은 이전 작업과 일치하지 않습니다. 현재 경기 상태를 다시 확인하세요.",
  stale_revision: "다른 저장 내용이 먼저 반영되었습니다. 최신 초안을 다시 확인하세요.",
};

function tabSessionId() {
  let id = sessionStorage.getItem(sessionStorageKey);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(sessionStorageKey, id);
  }
  return id;
}

function normalizeScore(score, final) {
  const sets = Array.isArray(score?.sets) ? score.sets.map((set) => ({ a: Number(set.a), b: Number(set.b) })) : [];
  if (sets.some((set) => !Number.isInteger(set.a) || !Number.isInteger(set.b) || set.a < 0 || set.b < 0 || set.a > 15 || set.b > 15)) {
    throw new Error("유효한 세트 점수가 필요합니다.");
  }
  return { sets: normalizePlayedSets(sets, final) };
}

function callable(name, data) {
  return httpsCallable(functions, name)({ tournamentId: TOURNAMENT_ID, sessionId: tabSessionId(), ...data })
    .then((result) => result.data);
}

export function recorderSessionId() { return tabSessionId(); }
export function rotateRecorderSessionId() {
  const id = crypto.randomUUID();
  sessionStorage.setItem(sessionStorageKey, id);
  return id;
}
export function operationId() { return crypto.randomUUID(); }
export function recorderReason(error) {
  const reason = error?.details?.reason || error?.details?.code || error?.message?.match(/\b(unresolved_teams|stale_queue|ownership_lost|lease_expired|submitted|maintenance|recorder_access_required|recorder_name_changed|operation_mismatch)\b/)?.[1];
  return reasonMessages[reason] || error?.message || "처리 중 오류가 발생했습니다.";
}
export function subscribeCourt(courtId, callback, onError) { return onSnapshot(base("courts", courtId), (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null), onError); }
export function subscribeAssignment(matchKey, callback, onError) { return onSnapshot(base("courtAssignments", matchKey), (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null), onError); }
export function subscribeWorkflow(matchKey, callback, onError) { return onSnapshot(base("scoreWorkflows", matchKey), (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null), onError); }
export function canResumeCurrentMatch(workflow, recorderName) {
  return Boolean(workflow?.draftState === "editing" && workflow?.lock?.uid === auth.currentUser?.uid
    && workflow.lock.recorderName === recorderName?.trim());
}
export const claimRecorderDraft = ({ matchKey, courtId, queueRevision, recorderName, takeover = false }) =>
  callable("claimRecorderDraft", { matchKey, courtId, queueRevision, recorderName: recorderName.trim(), takeover });
export const resumeRecorderDraft = ({ matchKey, courtId, queueRevision, recorderName, takeover = false }) =>
  callable("resumeRecorderDraft", { matchKey, courtId, queueRevision, recorderName: recorderName.trim(), takeover });
export const saveRecorderDraft = ({ matchKey, token, queueRevision, draft, expectedDraftRevision, final = false }) =>
  callable("saveRecorderDraft", { matchKey, token, queueRevision, draft: normalizeScore(draft, final), expectedDraftRevision });
export const renewRecorderLease = ({ matchKey, token, queueRevision }) =>
  callable("renewRecorderLease", { matchKey, token, queueRevision });
export const reconcileRecorderCourtQueue = ({ courtId, staleMatchKey, recorderName, expectedQueueRevision }) =>
  callable("reconcileRecorderCourtQueue", { courtId, staleMatchKey, recorderName, expectedQueueRevision });
export const cancelRecorderDraft = ({ matchKey, courtId, token, queueRevision, discardDraft, operationId: id = operationId() }) =>
  callable("cancelRecorderDraft", { matchKey, courtId, token, queueRevision, discardDraft, operationId: id });
export const submitRecorderDraft = ({ matchKey, courtId, token, queueRevision, score, final = false, operationId: id = operationId() }) =>
  callable("submitRecorderDraft", { matchKey, courtId, token, queueRevision, score: normalizeScore(score, final), operationId: id });

export function startLeaseHeartbeat({ matchKey, token, queueRevision, onRenew, onError }) {
  let timer = null;
  const tick = async () => {
    if (document.hidden || !navigator.onLine) return;
    try { onRenew?.(await renewRecorderLease({ matchKey, token, queueRevision })); }
    catch (error) { onError?.(error); }
  };
  const start = () => { if (!timer) { timer = window.setInterval(tick, 60000); tick(); } };
  const stop = () => { if (timer) window.clearInterval(timer); timer = null; };
  start();
  return { start, stop, reconcile: tick };
}

// Admin callers retain the same callable helper; recorder calls above never mutate Firestore.
export function adminWorkflowCallable(name, data = {}) { return httpsCallable(functions, name)({ tournamentId: TOURNAMENT_ID, ...data }); }
export const createRecorderAccessCode = (data) => adminWorkflowCallable("createRecorderAccessCode", data);
export const revokeRecorderAccessCode = (data) => adminWorkflowCallable("revokeRecorderAccessCode", data);
export const approveScoreReview = (data) => adminWorkflowCallable("approveScoreReview", data);
export const rejectScoreReview = (data) => adminWorkflowCallable("rejectScoreReview", data);

import {
  collection,
  doc,
  getDocFromServer,
  onSnapshot,
  orderBy,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { auth, db, functions } from "./firebase-init.js";
import { TOURNAMENT_ID } from "./firebase-config.js";
import { normalizePlayedSets } from "./match-logic.js";

const base = (collection, id) => doc(db, "tournaments", TOURNAMENT_ID, collection, id);
const sessionStorageKey = `recorder-session:${TOURNAMENT_ID}`;
const reasonMessages = {
  unresolved_teams: "대진이 확정되기를 기다리고 있습니다.",
  stale_queue: "경기 순서가 바뀌었습니다. 화면이 새로 바뀐 뒤 다시 눌러 주세요.",
  ownership_lost: "다른 사람이나 다른 화면이 이 경기 입력을 이어받았습니다.",
  lease_expired: "입력 시간이 끝났습니다. ‘입력 다시 시작’을 눌러 이어서 입력하세요.",
  submitted: "이미 제출된 경기입니다.",
  maintenance: "대회 점검 중입니다. 점검이 끝난 뒤 다시 시도하세요.",
  recorder_access_required: "기록관 권한이 필요합니다. 대회 코드를 다시 입력하세요.",
  recorder_name_changed: "담당 기록관 이름이 바뀌었습니다. 코트를 다시 선택하세요.",
  operation_mismatch: "이전 요청과 달라 처리하지 못했습니다. 화면을 새로 고친 뒤 다시 시도하세요.",
  stale_revision: "다른 곳에서 먼저 저장한 점수가 있습니다. 화면의 안내에 따라 선택하세요.",
  qualification_unverified: "본선 진출팀을 다시 확인해야 합니다. 관리자에게 확인을 요청하세요.",
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
  const reason = error?.details?.reason || error?.details?.code || error?.message?.match(/\b(unresolved_teams|stale_queue|ownership_lost|lease_expired|submitted|maintenance|recorder_access_required|recorder_name_changed|operation_mismatch|stale_revision|qualification_unverified)\b/)?.[1];
  if (reasonMessages[reason]) return reasonMessages[reason];
  if (/(?:unavailable|deadline-exceeded|internal|unknown|network)$/.test(String(error?.code || ""))) {
    return "인터넷 연결이 불안정합니다. 연결을 확인한 뒤 다시 눌러 주세요.";
  }
  const message = String(error?.message || "");
  return /[가-힣]/.test(message) ? message : "처리하지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요.";
}
export function subscribeCourt(courtId, callback, onError) {
  return onSnapshot(base("courts", courtId), { includeMetadataChanges: true }, (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null, s.metadata), onError);
}
export function subscribeAssignment(matchKey, callback, onError) {
  return onSnapshot(base("courtAssignments", matchKey), { includeMetadataChanges: true }, (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null, s.metadata), onError);
}
export function subscribeCourtAssignments(courtId, callback, onError) {
  if (typeof courtId !== "string" || courtId.trim() === "") {
    throw new TypeError("courtId must be a non-empty string");
  }
  const assignments = collection(db, "tournaments", TOURNAMENT_ID, "courtAssignments");
  const scopedQuery = query(assignments, where("courtId", "==", courtId), orderBy("courtOrder"));
  return onSnapshot(
    scopedQuery,
    { includeMetadataChanges: true },
    (snapshot) => callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })), snapshot.metadata),
    onError,
  );
}
export function subscribeWorkflow(matchKey, callback, onError) {
  return onSnapshot(base("scoreWorkflows", matchKey), { includeMetadataChanges: true }, (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null, s.metadata), onError);
}
export async function fetchRecorderWorkflow(matchKey) {
  const snapshot = await getDocFromServer(base("scoreWorkflows", matchKey));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}
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

import {
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { auth, db, functions } from "./firebase-init.js";
import { TOURNAMENT_ID } from "./score-workflow.js";

const base = (collection, id) => doc(db, "tournaments", TOURNAMENT_ID, collection, id);
const workflowRef = (matchKey) => base("scoreWorkflows", matchKey);
const assignmentRef = (matchKey) => base("courtAssignments", matchKey);
const queueRef = (courtId) => base("courtQueues", courtId);
const auditRef = (id) => base("auditEvents", id);

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}
function transitionId(matchKey, event, token, revision = 0) {
  return `${matchKey}:${event}:${token}:${revision}`;
}
function scoreSnapshot(score) {
  const sets = Array.isArray(score?.sets) ? score.sets.slice(0, 3).map((set) => ({ a: Number(set.a), b: Number(set.b) })) : [];
  if (!sets.length || sets.some((set) => !Number.isInteger(set.a) || !Number.isInteger(set.b) || set.a < 0 || set.b < 0 || set.a > 15 || set.b > 15)) throw new Error("유효한 세트 점수가 필요합니다.");
  return { sets };
}
function clientAudit(eventType, matchKey, before, after, id) {
  return { transitionId: id, eventType, reason: eventType, matchKey, actor: { uid: required(auth.currentUser?.uid, "로그인이 필요합니다.") }, before, after, createdAt: serverTimestamp() };
}

export function subscribeCourt(courtId, callback, onError) { return onSnapshot(base("courts", courtId), (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null), onError); }
export function subscribeAssignment(matchKey, callback, onError) { return onSnapshot(assignmentRef(matchKey), (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null), onError); }
export function subscribeWorkflow(matchKey, callback, onError) { return onSnapshot(workflowRef(matchKey), (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null), onError); }
export function subscribeReview(matchKey, callback, onError) { return subscribeAssignment(matchKey, callback, onError); }

export async function claimCurrentMatch({ matchKey, courtId, queueRevision, recorderName, token = crypto.randomUUID() }) {
  const normalizedRecorderName = typeof recorderName === "string" ? recorderName.trim() : "";
  required(normalizedRecorderName, "기록관 이름을 선택하세요.");
  return runTransaction(db, async (tx) => {
    const [queueSnap, assignmentSnap, workflowSnap] = await Promise.all([tx.get(queueRef(courtId)), tx.get(assignmentRef(matchKey)), tx.get(workflowRef(matchKey))]);
    const queue = required(queueSnap.data(), "대기열이 없습니다."); const assignment = required(assignmentSnap.data(), "배정이 없습니다."); const workflow = required(workflowSnap.data(), "워크플로가 없습니다.");
    if (queueRevision != null && queue.queueRevision !== queueRevision) throw new Error("경기 순서가 변경되었습니다. 새로고침해 주세요.");
    if (queue.currentMatchKey !== matchKey) throw new Error("현재 경기가 아닙니다.");
    if (!['idle', 'rejected'].includes(workflow.draftState) || workflow.lock) throw new Error("이미 다른 기록관이 작업 중입니다.");
    const eventType = workflow.draftState === 'rejected' ? 'rejected_reclaim' : 'recorder_start'; const id = transitionId(matchKey, eventType, token, workflow.draftRevision || 0);
    const lock = { uid: required(auth.currentUser?.uid, "로그인이 필요합니다."), token, recorderName: normalizedRecorderName };
    const nextWorkflow = { ...workflow, draftState: 'editing', resumeDraftState: workflow.draftState, lock, lastTransitionId: id };
    const nextAssignment = { ...assignment, publicStatus: 'in_progress', lastTransitionId: id };
    tx.update(workflowRef(matchKey), nextWorkflow);
    tx.update(assignmentRef(matchKey), {
      publicStatus: nextAssignment.publicStatus,
      attemptCount: Math.max(1, assignment.attemptCount || 0),
      lastTransitionId: id,
    });
    tx.set(auditRef(id), clientAudit(eventType, matchKey, { lock: null, draftState: workflow.draftState }, { lock, draftState: 'editing' }, id));
    return { token, transitionId: id };
  });
}

export async function saveDraft({ matchKey, token, score }) {
  const snapshot = scoreSnapshot(score);
  return runTransaction(db, async (tx) => {
    const workflowSnap = await tx.get(workflowRef(matchKey));
    const workflow = required(workflowSnap.data(), "워크플로가 없습니다.");
    if (workflow.draftState !== 'editing' || workflow.lock?.token !== token) throw new Error("현재 편집 권한이 없습니다.");
    const revision = (workflow.draftRevision || 0) + 1; const id = transitionId(matchKey, 'draft_save', token, revision);
    tx.update(workflowRef(matchKey), { draft: snapshot, draftRevision: revision, lastTransitionId: id }); tx.set(auditRef(id), clientAudit('draft_save', matchKey, { draft: workflow.draft || null, lock: workflow.lock }, { draft: snapshot, lock: workflow.lock }, id)); return { draftRevision: revision, transitionId: id };
  });
}

export async function cancelDraft({ matchKey, courtId, token, queueRevision }) {
  const result = await httpsCallable(functions, "cancelRecorderDraft")({
    tournamentId: TOURNAMENT_ID,
    matchKey,
    courtId: courtId || null,
    token,
    queueRevision: Number.isInteger(queueRevision) ? queueRevision : null,
  });
  return result.data;
}

export async function submitDraft({ matchKey, courtId, token, queueRevision, score }) {
  const result = await httpsCallable(functions, "submitRecorderDraft")({
    tournamentId: TOURNAMENT_ID,
    matchKey,
    courtId: courtId || null,
    token,
    queueRevision: Number.isInteger(queueRevision) ? queueRevision : null,
    score: scoreSnapshot(score),
  });
  return result.data;
}

export function adminWorkflowCallable(name, data = {}) { return httpsCallable(functions, name)({ tournamentId: TOURNAMENT_ID, ...data }); }
export const createRecorderAccessCode = (data) => adminWorkflowCallable('createRecorderAccessCode', data);
export const revokeRecorderAccessCode = (data) => adminWorkflowCallable('revokeRecorderAccessCode', data);
export const approveScoreReview = (data) => adminWorkflowCallable('approveScoreReview', data);
export const rejectScoreReview = (data) => adminWorkflowCallable('rejectScoreReview', data);

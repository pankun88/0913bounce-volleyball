import {
  collection, doc, setDoc, addDoc, updateDoc, getDoc, getDocs,
  onSnapshot, query, orderBy, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, functions } from "./firebase-init.js";
import { TOURNAMENT_ID } from "./firebase-config.js";
import {
  backupFromServerExport, normalizeBackupData, restorableRootData, selectRestoreRecovery,
} from "./backup-format.js";

const TID = TOURNAMENT_ID;
const RESTORE_SESSION_KEY = `bounce-volleyball.restore.${TID}`;

const tDoc = () => doc(db, "tournaments", TID);
const groupsCol = () => collection(db, "tournaments", TID, "groups");
const teamsCol = () => collection(db, "tournaments", TID, "teams");
const prelimCol = () => collection(db, "tournaments", TID, "prelimMatches");
const finalCol = (division) => collection(db, "tournaments", TID, "divisions", division, "finalMatches");

/** onSnapshot 오류를 콘솔뿐 아니라 화면(firestore-error 이벤트)으로도 알린다 */
function reportSnapshotError(label, err) {
  console.error(`[Firestore] ${label} 오류:`, err);
  window.dispatchEvent(new CustomEvent("firestore-error", { detail: { label, err } }));
}

/** 실시간 구독이 일정 시간 안에 한 번도 응답하지 않으면 firestore-timeout 이벤트를 보낸다 */
function watchForTimeout(label, ms = 8000) {
  let done = false;
  const timer = setTimeout(() => {
    if (!done) {
      window.dispatchEvent(new CustomEvent("firestore-timeout", { detail: { label } }));
    }
  }, ms);
  return () => { done = true; clearTimeout(timer); };
}

// ---------- 대회 설정 ----------

export async function saveTournamentInfo(data) {
  await setDoc(tDoc(), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

function serverConfirmed(snapshot) {
  return !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
}

export function subscribeTournamentInfo(cb) {
  const clearWatch = watchForTimeout("대회정보");
  return onSnapshot(tDoc(), { includeMetadataChanges: true }, (snap) => {
    if (serverConfirmed(snap)) clearWatch();
    cb(snap.exists() ? snap.data() : null, snap.metadata);
  }, (err) => {
    clearWatch();
    reportSnapshotError("대회정보 구독", err);
  });
}

// ---------- 조 ----------

export async function addGroup(name, division) {
  await addDoc(groupsCol(), { name, division, order: Date.now() });
}

/** 조 카드의 드래그 순서를 저장한다. */
export async function reorderGroups(orderedGroupIds) {
  const batch = writeBatch(db);
  orderedGroupIds.forEach((groupId, index) => {
    batch.update(doc(groupsCol(), groupId), { order: index });
  });
  await batch.commit();
}

/** 예선 구조를 서버 트랜잭션으로 변경한다. */
export async function mutatePrelimStructure(operation, division, data = {}) {
  const result = await httpsCallable(functions, "mutatePrelimStructure")({
    tournamentId: TID, operation, division, ...data,
  });
  return result.data;
}

/** 조의 예선 진행 방식을 라운드로빈/링크제로 전환한다 */
export async function setGroupMatchMode(groupId, mode) {
  await updateDoc(doc(groupsCol(), groupId), { matchMode: mode });
}

/** 조의 링크제 꼭짓점 배치(팀 id 배열, 빈 자리는 null)를 저장한다 */
export async function setGroupRingOrder(groupId, ringOrder) {
  await updateDoc(doc(groupsCol(), groupId), { ringOrder });
}

export function subscribeGroups(cb) {
  const clearWatch = watchForTimeout("조 목록");
  return onSnapshot(query(groupsCol(), orderBy("order")), { includeMetadataChanges: true }, (snap) => {
    if (serverConfirmed(snap)) clearWatch();
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata);
  }, (err) => {
    clearWatch();
    reportSnapshotError("조 목록 구독", err);
  });
}

// ---------- 팀 ----------

export async function addTeam(name, groupId, division) {
  await addDoc(teamsCol(), { name, groupId: groupId || null, division, order: Date.now(), advanced: false });
}

export async function updateTeam(id, data) {
  await updateDoc(doc(teamsCol(), id), data);
}

/** 팀을 대상 조로 옮기면서 그 조 안의 카드 순서를 한 번에 저장한다. */
export async function moveAndReorderTeam(teamId, targetGroupId, orderedTeamIds) {
  const batch = writeBatch(db);
  orderedTeamIds.forEach((orderedTeamId, index) => {
    const data = { order: index };
    if (orderedTeamId === teamId) data.groupId = targetGroupId || null;
    batch.update(doc(teamsCol(), orderedTeamId), data);
  });
  await batch.commit();
}

export function subscribeTeams(cb) {
  const clearWatch = watchForTimeout("팀 목록");
  return onSnapshot(query(teamsCol(), orderBy("order")), { includeMetadataChanges: true }, (snap) => {
    if (serverConfirmed(snap)) clearWatch();
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata);
  }, (err) => {
    clearWatch();
    reportSnapshotError("팀 목록 구독", err);
  });
}

// ---------- 예선 ----------

/** 경기 순서(드래그로 재배열한 결과)를 저장한다 - matchIds를 새 순서대로 넘기면 round(1부터)를 다시 매긴다 */
export async function reorderPrelimMatches(groupId, orderedMatchIds) {
  const batch = writeBatch(db);
  orderedMatchIds.forEach((matchId, idx) => {
    batch.update(doc(prelimCol(), matchId), { round: idx + 1 });
  });
  await batch.commit();
}

export function subscribePrelimMatches(cb) {
  const clearWatch = watchForTimeout("예선경기");
  return onSnapshot(prelimCol(), { includeMetadataChanges: true }, (snap) => {
    if (serverConfirmed(snap)) clearWatch();
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata);
  }, (err) => {
    clearWatch();
    reportSnapshotError("예선경기 구독", err);
  });
}

// ---------- 본선 ----------

/** Publish a local final draft with its exact authoritative CAS baseline. */
export async function publishFinalBracket(division, expectedMatches, matches, scoreDrafts) {
  const callable = httpsCallable(functions, "publishFinalStructure");
  const result = await callable({
    tournamentId: TID,
    division,
    expectedMatches,
    matches,
    scoreDrafts,
  });
  return result.data;
}

export function subscribeFinalMatches(division, cb) {
  const label = `${division} 본선경기`;
  const clearWatch = watchForTimeout(label);
  return onSnapshot(finalCol(division), { includeMetadataChanges: true }, (snap) => {
    if (serverConfirmed(snap)) clearWatch();
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata);
  }, (err) => {
    clearWatch();
    reportSnapshotError(`${label} 구독`, err);
  });
}

export async function getServerClockOffset() {
  const startedAt = Date.now();
  const result = await httpsCallable(functions, "getServerClock")({ tournamentId: TID });
  const finishedAt = Date.now();
  const serverTimeMs = Number(result.data?.serverTimeMs);
  if (!Number.isFinite(serverTimeMs)) throw new Error("서버 기준 시간을 확인할 수 없습니다.");
  return serverTimeMs - ((startedAt + finishedAt) / 2);
}

// ---------- 백업 / 복원 ----------

/**
 * 현재 대회의 모든 데이터(대회정보 + 조 + 팀 + 예선경기 + 본선경기)를 하나의 평범한 객체로 모아
 * 반환한다. 문서 ID까지 함께 담아야(teams의 groupId, 경기의 teamA/teamB·nextMatchId 등이 ID로
 * 서로를 가리키므로) 복원 시 관계가 그대로 유지된다. 학기 사이처럼 긴 공백에 대비한 "되돌릴 수
 * 있는" 백업 파일을 만드는 용도다.
 */
export async function exportAllData() {
  const result = await httpsCallable(functions, "exportTournamentBackup")({ tournamentId: TID });
  return backupFromServerExport(result.data);
}

/**
 * 백업 객체로 허용된 대회 데이터를 정확히 교체한다. 서버는 청크 적용 뒤 이전 사업 문서를
 * 제거하고 검증·승격하므로, 호출 전 사용자에게 반드시 확인을 받아야 한다.
 */
export async function importAllData(data) {
  data = normalizeBackupData(data);
  if (data.version !== 3) throw new Error("v3 백업만 복원할 수 있습니다.");
  const root = `tournaments/${TID}`;
  const rootData = restorableRootData(data.info);
  const documents = [
    ...data.groups.map((item) => ({ path: `${root}/groups/${item.id}`, data: item.data })),
    ...data.teams.map((item) => ({ path: `${root}/teams/${item.id}`, data: item.data })),
    ...data.prelimMatches.map((item) => ({ path: `${root}/prelimMatches/${item.id}`, data: item.data })),
    ...data.finalMatches.men.map((item) => ({ path: `${root}/divisions/men/finalMatches/${item.id}`, data: item.data })),
    ...data.finalMatches.women.map((item) => ({ path: `${root}/divisions/women/finalMatches/${item.id}`, data: item.data })),
    ...data.officialRevisions.map((item) => ({ path: `${root}/officialRevisions/${item.id}`, data: item.data })),
    ...data.courts.map((item) => ({ path: `${root}/courts/${item.id}`, data: item.data })),
    ...data.courtAssignments.map((item) => ({ path: `${root}/courtAssignments/${item.id}`, data: item.data })),
    ...data.courtQueues.map((item) => ({ path: `${root}/courtQueues/${item.id}`, data: item.data })),
    ...data.scoreWorkflows.map((item) => ({ path: `${root}/scoreWorkflows/${item.id}`, data: item.data })),
    ...data.auditEvents.map((item) => ({ path: `${root}/auditEvents/${item.id}`, data: item.data })),
  ];
  const chunks = [];
  const encoder = new TextEncoder();
  let current = [];
  let currentBytes = 2;
  for (const document of documents) {
    const bytes = encoder.encode(JSON.stringify(document)).byteLength + (current.length ? 1 : 0);
    if (bytes > 2_000_000) throw new Error(`백업 문서가 복원 전송 한도를 초과합니다: ${document.path}`);
    if (current.length >= 100 || currentBytes + bytes > 2_000_000) {
      chunks.push({ documents: current });
      current = [];
      currentBytes = 2;
    }
    current.push(document);
    currentBytes += bytes;
  }
  if (current.length) chunks.push({ documents: current });
  if (chunks.length > 100 || encoder.encode(JSON.stringify(chunks)).byteLength > 24_000_000) {
    throw new Error("백업 전체 크기가 안전한 복원 한도를 초과합니다.");
  }
  const payload = { rootData, chunks };
  let savedState = null;
  try {
    savedState = JSON.parse(sessionStorage.getItem(RESTORE_SESSION_KEY) || "null");
  } catch {
    sessionStorage.removeItem(RESTORE_SESSION_KEY);
  }
  const rootSnapshot = await getDoc(tDoc());
  const activeManifestId = rootSnapshot.data()?.maintenance?.enabled === true
    ? rootSnapshot.data().maintenance.restoreManifestId
    : null;
  const recovery = selectRestoreRecovery({
    activeManifestId,
    savedState,
    payload,
    newManifestId: `restore-${Date.now()}-${crypto.randomUUID()}`,
  });
  const manifestId = recovery.manifestId;
  sessionStorage.setItem(RESTORE_SESSION_KEY, JSON.stringify({ manifestId, payload }));
  const call = (name, payload) => httpsCallable(functions, name)({ tournamentId: TID, ...payload });
  if (recovery.supersede) {
    await call("supersedeRestore", { priorManifestId: recovery.priorManifestId, manifestId, ...payload });
  } else {
    await call("beginRestore", { manifestId, ...payload });
  }
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    await call("resumeRestore", { manifestId, chunkIndex, chunk: chunks[chunkIndex] });
  }
  let pruneResult;
  do {
    pruneResult = (await call("pruneRestore", { manifestId })).data;
  } while (!pruneResult?.pruned);
  await call("verifyRestore", { manifestId });
  await call("promoteRestore", { manifestId });
  sessionStorage.removeItem(RESTORE_SESSION_KEY);
  return { manifestId };
}

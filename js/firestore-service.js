import {
  collection, doc, setDoc, addDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, orderBy, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, functions } from "./firebase-init.js";
import { TOURNAMENT_ID } from "./firebase-config.js";
import { generateRoundRobin } from "./schedule.js";
import { normalizeBackupData } from "./backup-format.js";

const TID = TOURNAMENT_ID;

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

export function subscribeTournamentInfo(cb) {
  const clearWatch = watchForTimeout("대회정보");
  return onSnapshot(tDoc(), (snap) => {
    clearWatch();
    cb(snap.exists() ? snap.data() : null);
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

/** 조를 삭제하면서, 그 조에 속해 있던 팀들은 '미배정' 상태(groupId: null)로 되돌린다.
 *  (이렇게 하지 않으면 팀이 삭제된 조의 id를 계속 들고 있어 화면에서 보이지도, 지워지지도 않는
 *  '고아 팀'이 되어버린다.) */
export async function deleteGroup(id) {
  const [teamsSnap, prelimSnap] = await Promise.all([
    getDocs(teamsCol()),
    getDocs(prelimCol()),
  ]);
  const batch = writeBatch(db);
  teamsSnap.docs.forEach((d) => {
    if (d.data().groupId === id) {
      batch.update(d.ref, { groupId: null });
    }
  });
  prelimSnap.docs.forEach((d) => {
    if (d.data().groupId === id) batch.delete(d.ref);
  });
  batch.delete(doc(groupsCol(), id));
  await batch.commit();
}

/** 등록된 모든 조를 삭제한다 ('조 편성' 초기화 버튼용).
 *  팀은 지우지 않고 모두 '미배정' 상태(groupId: null)로 되돌리며, 조에 딸린 예선 경기도 함께 삭제한다. */
export async function deleteAllGroups(division) {
  const [groupsSnap, teamsSnap, prelimSnap] = await Promise.all([
    getDocs(groupsCol()), getDocs(teamsCol()), getDocs(prelimCol()),
  ]);
  const batch = writeBatch(db);
  teamsSnap.docs.forEach((d) => {
    if (d.data().division === division && d.data().groupId) batch.update(d.ref, { groupId: null });
  });
  prelimSnap.docs.forEach((d) => {
    if (d.data().division === division) batch.delete(d.ref);
  });
  groupsSnap.docs.forEach((d) => {
    if (d.data().division === division) batch.delete(d.ref);
  });
  await batch.commit();
}

/** 조의 예선 진행 방식을 라운드로빈/링크제로 전환한다 */
export async function setGroupMatchMode(groupId, mode) {
  await updateDoc(doc(groupsCol(), groupId), { matchMode: mode });
}

/** 조의 링크제 꼭짓점 배치(팀 id 배열, 빈 자리는 null)를 저장한다 */
export async function setGroupRingOrder(groupId, ringOrder) {
  await updateDoc(doc(groupsCol(), groupId), { ringOrder });
}

/** 모든 조의 링크제 꼭짓점 배치(ringOrder)를 비운다 ('예선 대진 설정' 전체 초기화 버튼용).
 *  예선 경기 자체는 clearAllPrelimMatches가 지우므로, 이 함수는 도형에 남아있는 팀 배치만 정리한다. */
export async function resetAllRingOrders(division) {
  const existing = await getDocs(groupsCol());
  const batch = writeBatch(db);
  existing.docs.forEach((d) => {
    if (d.data().division === division && d.data().ringOrder && d.data().ringOrder.length) batch.update(d.ref, { ringOrder: [] });
  });
  await batch.commit();
}

export function subscribeGroups(cb) {
  const clearWatch = watchForTimeout("조 목록");
  return onSnapshot(query(groupsCol(), orderBy("order")), (snap) => {
    clearWatch();
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
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

export async function deleteTeam(id) {
  await deleteDoc(doc(teamsCol(), id));
}

/** 등록된 모든 팀을 삭제한다 ('참가팀 등록' 초기화 버튼용).
 *  팀에 의존하는 예선/본선 경기 기록도 함께 삭제해 고아 데이터가 남지 않게 한다. */
export async function deleteAllTeams(division) {
  const [teamsSnap, prelimSnap, finalSnap] = await Promise.all([
    getDocs(teamsCol()), getDocs(prelimCol()), getDocs(finalCol(division)),
  ]);
  const batch = writeBatch(db);
  teamsSnap.docs.forEach((d) => {
    if (d.data().division === division) batch.delete(d.ref);
  });
  prelimSnap.docs.forEach((d) => {
    if (d.data().division === division) batch.delete(d.ref);
  });
  finalSnap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

export function subscribeTeams(cb) {
  const clearWatch = watchForTimeout("팀 목록");
  return onSnapshot(query(teamsCol(), orderBy("order")), (snap) => {
    clearWatch();
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => {
    clearWatch();
    reportSnapshotError("팀 목록 구독", err);
  });
}

// ---------- 예선 ----------

/** 해당 조의 기존 예선 경기를 모두 지우고 라운드로빈 일정을 새로 만든다 */
export async function generatePrelimMatchesForGroup(groupId, teamIds) {
  const [existing, groupSnap] = await Promise.all([
    getDocs(prelimCol()), getDoc(doc(groupsCol(), groupId)),
  ]);
  if (!groupSnap.exists()) throw new Error("조를 찾을 수 없습니다.");
  const division = groupSnap.data().division;
  const batch = writeBatch(db);
  existing.docs.forEach((d) => {
    if (d.data().groupId === groupId) batch.delete(d.ref);
  });
  const pairs = generateRoundRobin(teamIds);
  pairs.forEach((p) => {
    const ref = doc(prelimCol());
    batch.set(ref, {
      groupId,
      division,
      teamA: p.teamA,
      teamB: p.teamB,
      round: p.round,
      sets: [],
      status: "pending",
      result: null,
      createdAt: Date.now(),
    });
  });
  await batch.commit();
}

/** 해당 조의 기존 예선 경기를 모두 지운다 (방식 전환 시 사용) */
export async function clearPrelimMatchesForGroup(groupId) {
  const existing = await getDocs(prelimCol());
  const batch = writeBatch(db);
  existing.docs.forEach((d) => {
    if (d.data().groupId === groupId) batch.delete(d.ref);
  });
  await batch.commit();
}

/** 모든 조의 예선 경기(대진+결과)를 전부 삭제한다 ('예선 대진 설정' 초기화 버튼용). */
export async function clearAllPrelimMatches(division) {
  const existing = await getDocs(prelimCol());
  const batch = writeBatch(db);
  existing.docs.forEach((d) => {
    if (d.data().division === division) batch.delete(d.ref);
  });
  await batch.commit();
}

/** 해당 조의 기존 예선 경기를 모두 지우고, 링크제(인접 꼭짓점) 대진쌍으로 새로 만든다 */
export async function generateRingMatchesForGroup(groupId, pairs) {
  const [existing, groupSnap] = await Promise.all([
    getDocs(prelimCol()), getDoc(doc(groupsCol(), groupId)),
  ]);
  if (!groupSnap.exists()) throw new Error("조를 찾을 수 없습니다.");
  const division = groupSnap.data().division;
  const batch = writeBatch(db);
  existing.docs.forEach((d) => {
    if (d.data().groupId === groupId) batch.delete(d.ref);
  });
  pairs.forEach((p, idx) => {
    const ref = doc(prelimCol());
    batch.set(ref, {
      groupId,
      division,
      teamA: p.teamA,
      teamB: p.teamB,
      round: idx + 1,
      sets: [],
      status: "pending",
      result: null,
      createdAt: Date.now(),
    });
  });
  await batch.commit();
}

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
  return onSnapshot(prelimCol(), (snap) => {
    clearWatch();
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => {
    clearWatch();
    reportSnapshotError("예선경기 구독", err);
  });
}

// ---------- 본선 ----------

/**
 * 관리자가 (대진표 생성 → 부전승 배치 → 자리 조정 → 점수 입력까지) 화면에서만 다듬어 둔
 * 본선 대진표를 한 번에 그대로 Firestore에 반영해서 관객 화면(대시보드)에 공개한다.
 * 대진표를 새로 생성하면 경기 수/아이디 구성 자체가 달라질 수 있으므로, 단순히 덮어쓰기(merge)만
 * 하면 이전에 공개됐던 경기 문서가 고스란히 남아 유령 경기로 보일 수 있다. 그래서 새 배열에 없는
 * 기존 문서는 지우고, 새 배열은 전부 덮어쓰는 "완전 교체" 방식으로 공개한다.
 */
export async function publishFinalBracket(division, matches) {
  const callable = httpsCallable(functions, "publishFinalStructure");
  const result = await callable({ tournamentId: TID, division, matches });
  return result.data;
}

export function subscribeFinalMatches(division, cb) {
  const clearWatch = watchForTimeout("본선경기");
  return onSnapshot(finalCol(division), (snap) => {
    clearWatch();
    cb(snap.docs.map((d) => d.data()));
  }, (err) => {
    clearWatch();
    reportSnapshotError("본선경기 구독", err);
  });
}

export async function clearFinalBracket(division) {
  const existing = await getDocs(finalCol(division));
  const batch = writeBatch(db);
  existing.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// ---------- 백업 / 복원 ----------

/**
 * 현재 대회의 모든 데이터(대회정보 + 조 + 팀 + 예선경기 + 본선경기)를 하나의 평범한 객체로 모아
 * 반환한다. 문서 ID까지 함께 담아야(teams의 groupId, 경기의 teamA/teamB·nextMatchId 등이 ID로
 * 서로를 가리키므로) 복원 시 관계가 그대로 유지된다. 학기 사이처럼 긴 공백에 대비한 "되돌릴 수
 * 있는" 백업 파일을 만드는 용도다.
 */
export async function exportAllData() {
  const root = `tournaments/${TID}`;
  const [infoSnap, groups, teams, prelim, menFinal, womenFinal, revisions, courts, assignments, queues, workflows, audits, restores] = await Promise.all([
    getDoc(tDoc()),
    getDocs(groupsCol()),
    getDocs(teamsCol()),
    getDocs(prelimCol()),
    getDocs(finalCol("men")),
    getDocs(finalCol("women")),
    getDocs(collection(db, root, "officialRevisions")),
    getDocs(collection(db, root, "courts")),
    getDocs(collection(db, root, "courtAssignments")),
    getDocs(collection(db, root, "courtQueues")),
    getDocs(collection(db, root, "scoreWorkflows")),
    getDocs(collection(db, root, "auditEvents")),
    getDocs(collection(db, root, "restoreManifests")),
  ]);
  const toArr = (snap) => snap.docs.map((d) => ({ id: d.id, data: d.data() }));

  const info = infoSnap.exists() ? { ...infoSnap.data() } : null;
  // updatedAt(서버 타임스탬프)은 복원 시 의미가 없고 JSON으로 깔끔히 안 떨어지므로 뺀다.
  if (info) delete info.updatedAt;

  return {
    app: "bounce-volleyball",
    type: "backup",
    version: 3,
    exportedAt: new Date().toISOString(),
    tournamentId: TID,
    info,
    groups: toArr(groups),
    teams: toArr(teams),
    prelimMatches: toArr(prelim),
    finalMatches: {
      men: toArr(menFinal),
      women: toArr(womenFinal),
    },
    officialRevisions: toArr(revisions),
    courts: toArr(courts),
    courtAssignments: toArr(assignments),
    courtQueues: toArr(queues),
    scoreWorkflows: toArr(workflows),
    auditEvents: toArr(audits),
    restoreManifests: toArr(restores),
    maintenance: { enabled: Boolean(info?.maintenance?.enabled) },
  };
}

/**
 * 백업 객체로 현재 대회 데이터를 통째로 덮어쓴다(복원). 기존 데이터는 모두 지우고 백업 내용으로
 * 교체하므로, 호출 전 사용자에게 반드시 확인을 받아야 한다. 쓰기 작업은 배치(최대 500개) 한도를
 * 넘지 않도록 청크로 나눠 커밋한다.
 */
export async function importAllData(data) {
  data = normalizeBackupData(data);
  if (data.version !== 3) throw new Error("v3 백업만 복원할 수 있습니다. 먼저 migration manifest를 생성하세요.");
  const root = `tournaments/${TID}`;
  const documents = [
    { path: root, data: { ...(data.info || {}), maintenance: data.maintenance } },
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
    ...data.restoreManifests.map((item) => ({ path: `${root}/restoreManifests/${item.id}`, data: item.data })),
  ];
  const chunks = [];
  for (let i = 0; i < documents.length; i += 200) chunks.push({ documents: documents.slice(i, i + 200) });
  const manifestId = `restore-${Date.now()}-${crypto.randomUUID()}`;
  const call = (name, payload) => httpsCallable(functions, name)({ tournamentId: TID, ...payload });
  await call("beginRestore", { manifestId, chunks });
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    await call("resumeRestore", { manifestId, chunkIndex });
  }
  await call("verifyRestore", { manifestId });
  await call("promoteRestore", { manifestId });
  return { manifestId };
}

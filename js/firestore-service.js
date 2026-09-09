import {
  collection, doc, setDoc, updateDoc, getDoc, getDocs,
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
const publicScheduleDoc = () => doc(db, "tournaments", TID, "publicSchedule", "current");

/** onSnapshot 오류를 콘솔뿐 아니라 화면(firestore-error 이벤트)으로도 알린다 */
function reportSnapshotError(label, err) {
  console.error(`[Firestore] ${label} 오류:`, err);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function"
      && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("firestore-error", { detail: { label, err } }));
  }
}

const RECOVERY_TIMEOUT_MS = 8000;
const RECOVERY_RETRY_BASE_MS = 1000;
const RECOVERY_RETRY_MAX_MS = 30000;

function reportSnapshotTimeout(label) {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function"
      && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("firestore-timeout", { detail: { label } }));
  }
}

/**
 * Owns one Firestore listener and its retry lifecycle.
 *
 * A Firestore listener is considered recovered only after a server-confirmed
 * snapshot. Cache snapshots are still delivered to the caller, but do not
 * reset the timeout or retry backoff. Every listener generation gets a token
 * so callbacks from a stopped listener cannot affect a newer generation.
 *
 * @param {{
 *   subscribe: (next: (snapshot: object) => void, error: (error: unknown) => void) => (() => void),
 *   onSnapshot: (snapshot: object) => void,
 *   timeoutLabel: string,
 *   errorLabel?: string,
 *   timeoutMs?: number,
 *   retryBaseMs?: number,
 *   retryMaxMs?: number,
 *   scheduler?: { setTimeout?: Function, clearTimeout?: Function },
 * }} options
 * @returns {(() => void) & { retry?: () => void, retryNow?: () => void }}
 */
export function createRecoverableSubscription({
  subscribe,
  onSnapshot,
  timeoutLabel,
  errorLabel = `${timeoutLabel} 구독`,
  timeoutMs = RECOVERY_TIMEOUT_MS,
  retryBaseMs = RECOVERY_RETRY_BASE_MS,
  retryMaxMs = RECOVERY_RETRY_MAX_MS,
  scheduler = globalThis,
}) {
  const schedule = scheduler?.setTimeout || setTimeout;
  const unschedule = scheduler?.clearTimeout || clearTimeout;
  const baseRetryDelay = Math.max(1, Number.isFinite(retryBaseMs) ? retryBaseMs : RECOVERY_RETRY_BASE_MS);
  const maxRetryDelay = Math.max(
    baseRetryDelay,
    Number.isFinite(retryMaxMs) ? retryMaxMs : RECOVERY_RETRY_MAX_MS,
  );
  let cancelled = false;
  let generation = 0;
  let activeStop = null;
  let responseTimer = null;
  let retryTimer = null;
  let retryAttempt = 0;

  const clearResponseTimer = () => {
    if (responseTimer === null) return;
    unschedule(responseTimer);
    responseTimer = null;
  };

  const clearRetryTimer = () => {
    if (retryTimer === null) return;
    unschedule(retryTimer);
    retryTimer = null;
  };

  const stopActiveListener = () => {
    generation += 1;
    const stop = activeStop;
    activeStop = null;
    if (typeof stop === "function") stop();
  };

  const retryDelay = () => {
    const exponent = Math.min(retryAttempt, 30);
    const delay = Math.min(maxRetryDelay, baseRetryDelay * (2 ** exponent));
    retryAttempt += 1;
    return delay;
  };

  let start;
  const scheduleRetry = () => {
    if (cancelled || retryTimer !== null) return;
    retryTimer = schedule(() => {
      retryTimer = null;
      start();
    }, retryDelay());
  };

  const restartAfterFailure = () => {
    clearResponseTimer();
    stopActiveListener();
    scheduleRetry();
  };

  const handleTimeout = (token) => {
    if (cancelled || token !== generation || responseTimer === null) return;
    responseTimer = null;
    reportSnapshotTimeout(timeoutLabel);
    restartAfterFailure();
  };

  start = () => {
    if (cancelled || activeStop || retryTimer !== null) return;
    const token = ++generation;
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      responseTimer = schedule(() => handleTimeout(token), timeoutMs);
    }

    const next = (snapshot) => {
      if (cancelled || token !== generation) return;
      if (serverConfirmed(snapshot)) {
        clearResponseTimer();
        retryAttempt = 0;
      }
      onSnapshot(snapshot);
    };
    const error = (err) => {
      if (cancelled || token !== generation) return;
      reportSnapshotError(errorLabel, err);
      restartAfterFailure();
    };

    try {
      const stop = subscribe(next, error);
      if (cancelled || token !== generation) {
        if (typeof stop === "function") stop();
        return;
      }
      activeStop = typeof stop === "function" ? stop : () => {};
    } catch (err) {
      error(err);
    }
  };

  const retryNow = () => {
    if (cancelled) return;
    clearRetryTimer();
    clearResponseTimer();
    retryAttempt = 0;
    stopActiveListener();
    start();
  };

  const unsubscribe = () => {
    if (cancelled) return;
    cancelled = true;
    clearResponseTimer();
    clearRetryTimer();
    stopActiveListener();
  };
  unsubscribe.retry = retryNow;
  unsubscribe.retryNow = retryNow;
  start();
  return unsubscribe;
}

// ---------- 대회 설정 ----------

export async function saveTournamentInfo(data) {
  await setDoc(tDoc(), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

function serverConfirmed(snapshot) {
  return Boolean(snapshot?.metadata
    && !snapshot.metadata.fromCache
    && !snapshot.metadata.hasPendingWrites);
}

export function subscribeTournamentInfo(cb) {
  return createRecoverableSubscription({
    timeoutLabel: "대회정보",
    subscribe: (next, error) => onSnapshot(
      tDoc(),
      { includeMetadataChanges: true },
      next,
      error,
    ),
    onSnapshot: (snap) => {
      cb(snap.exists() ? snap.data() : null, snap.metadata);
    },
  });
}

// ---------- 조 ----------

export async function addGroup(name, division) {
  const groupRef = doc(groupsCol());
  return editParticipantStructure([{
    collection: "groups",
    id: groupRef.id,
    create: true,
    data: { name, division, order: Date.now() },
  }]);
}

export async function renameGroup(groupId, name) {
  if (typeof groupId !== "string" || !groupId || typeof name !== "string" || !name.trim()) {
    throw new Error("조 ID와 새 이름이 필요합니다.");
  }
  await updateDoc(doc(db, "tournaments", TID, "groups", groupId), { name: name.trim() });
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

async function editParticipantStructure(changes) {
  const result = await httpsCallable(functions, "mutatePrelimStructure")({
    tournamentId: TID,
    operation: "edit_participants",
    changes,
  });
  return result.data;
}

/** 조의 예선 진행 방식을 라운드로빈/링크제로 전환한다 */
export async function setGroupMatchMode(groupId, mode) {
  return editParticipantStructure([{
    collection: "groups",
    id: groupId,
    create: false,
    data: { matchMode: mode },
  }]);
}

/** 조의 링크제 꼭짓점 배치(팀 id 배열, 빈 자리는 null)를 저장한다 */
export async function setGroupRingOrder(groupId, ringOrder) {
  return editParticipantStructure([{
    collection: "groups",
    id: groupId,
    create: false,
    data: { ringOrder: [...ringOrder] },
  }]);
}

export function subscribeGroups(cb) {
  return createRecoverableSubscription({
    timeoutLabel: "조 목록",
    subscribe: (next, error) => onSnapshot(
      query(groupsCol(), orderBy("order")),
      { includeMetadataChanges: true },
      next,
      error,
    ),
    onSnapshot: (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata);
    },
  });
}

// ---------- 팀 ----------

export async function addTeam(name, groupId, division) {
  const teamRef = doc(teamsCol());
  return editParticipantStructure([{
    collection: "teams",
    id: teamRef.id,
    create: true,
    data: {
      name, groupId: groupId || null, division, order: Date.now(),
    },
  }]);
}

export async function updateTeam(id, data) {
  return editParticipantStructure([{
    collection: "teams",
    id,
    create: false,
    data,
  }]);
}

/** 팀을 대상 조로 옮기면서 그 조 안의 카드 순서를 한 번에 저장한다. */
export async function moveAndReorderTeam(teamId, targetGroupId, orderedTeamIds) {
  return editParticipantStructure(orderedTeamIds.map((orderedTeamId, index) => {
    const data = { order: index };
    if (orderedTeamId === teamId) data.groupId = targetGroupId || null;
    return {
      collection: "teams",
      id: orderedTeamId,
      create: false,
      data,
    };
  }));
}

export function subscribeTeams(cb) {
  return createRecoverableSubscription({
    timeoutLabel: "팀 목록",
    subscribe: (next, error) => onSnapshot(
      query(teamsCol(), orderBy("order")),
      { includeMetadataChanges: true },
      next,
      error,
    ),
    onSnapshot: (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata);
    },
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
  return createRecoverableSubscription({
    timeoutLabel: "예선경기",
    subscribe: (next, error) => onSnapshot(
      prelimCol(),
      { includeMetadataChanges: true },
      next,
      error,
    ),
    onSnapshot: (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata);
    },
  });
}

// ---------- 공개 코트 일정 ----------

/**
 * 공개 대시보드는 저장된 공개 투영만 구독한다. 문서가 아직 없을 때만
 * 서버에 기존 저장 상태로 투영을 만들도록 한 번 요청하고, 그 결과를
 * 다시 스냅샷으로 받는다. 실패한 요청은 사용자의 명시적인 retry 호출
 * 전까지 반복하지 않는다.
 */
export function subscribePublicSchedule(cb) {
  let closed = false;
  let ensureAttempted = false;
  let ensurePending = false;

  const ensure = async () => {
    if (closed || ensureAttempted || ensurePending) return;
    ensureAttempted = true;
    ensurePending = true;
    try {
      await httpsCallable(functions, "ensurePublicSchedule")({ tournamentId: TID });
    } catch (err) {
      if (!closed) reportSnapshotError("공개 경기 일정 초기화", err);
    } finally {
      ensurePending = false;
    }
  };

  const subscription = createRecoverableSubscription({
    timeoutLabel: "공개 경기 일정",
    subscribe: (next, error) => onSnapshot(
      publicScheduleDoc(),
      { includeMetadataChanges: true },
      next,
      error,
    ),
    onSnapshot: (snap) => {
      if (snap.exists()) {
        ensureAttempted = false;
        cb(snap.data(), snap.metadata);
        return;
      }
      cb(null, snap.metadata);
      ensure();
    },
  });
  const recover = subscription.retry;
  const unsubscribe = () => {
    if (closed) return;
    closed = true;
    subscription();
  };
  unsubscribe.retry = () => {
    if (closed) return;
    ensureAttempted = false;
    recover();
    ensure();
  };
  return unsubscribe;
}

// ---------- 본선 ----------

/** Publish a local final draft with its exact authoritative CAS baseline and qualification proof. */
export async function publishFinalBracket(
  division,
  expectedMatches,
  matches,
  scoreDrafts,
  qualificationContext = {},
) {
  const callable = httpsCallable(functions, "publishFinalStructure");
  const result = await callable({
    tournamentId: TID,
    division,
    expectedMatches,
    matches,
    scoreDrafts,
    ...(qualificationContext || {}),
  });
  return result.data;
}

export function subscribeFinalMatches(division, cb) {
  const label = `${division} 본선경기`;
  return createRecoverableSubscription({
    timeoutLabel: label,
    subscribe: (next, error) => onSnapshot(
      finalCol(division),
      { includeMetadataChanges: true },
      next,
      error,
    ),
    onSnapshot: (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata);
    },
  });
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

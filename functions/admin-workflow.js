import crypto from 'node:crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  activateDependencyEntries, consumeCurrentAndAdvance, planCorrectionReplay,
  planRejectedRework, projectCourtQueue, projectForceRelease, projectQueue, TOURNAMENT_ID,
} from './workflow-core.js';

const db = () => getFirestore();
const root = () => db().collection('tournaments').doc(TOURNAMENT_ID);
const ref = (name, id) => root().collection(name).doc(id);
const bad = (message) => { throw new HttpsError('failed-precondition', message); };
const requireMain = (data) => { if (data?.tournamentId !== TOURNAMENT_ID) throw new HttpsError('invalid-argument', 'Unknown tournament.'); };
const bounded = (value) => JSON.parse(JSON.stringify(value ?? null, (_key, item) => typeof item === 'string' ? item.slice(0, 1024) : item));
const transitionId = (matchKey, event, revision = 0) => `${matchKey}:${event}:${revision}`;
function hash(code, salt) { return crypto.scryptSync(code, salt, 32).toString('base64url'); }
function randomCode() { return crypto.randomBytes(18).toString('base64url'); }
function resetTokenHash(token) { return crypto.createHash('sha256').update(token).digest('base64url'); }
async function admin(context, data, { allowResetMaintenance = false } = {}) {
  requireMain(data);
  if (!context.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  if (!(await ref('admins', context.auth.uid).get()).exists) throw new HttpsError('permission-denied', 'Seeded administrator required.');
  const tournament = await root().get();
  if (!allowResetMaintenance && tournament.data()?.maintenance?.enabled === true) {
    throw new HttpsError('failed-precondition', 'Tournament maintenance is active.');
  }
  return context.auth.uid;
}
async function assertTournamentWritable(tx) {
  const tournament = await tx.get(root());
  if (tournament.data()?.maintenance?.enabled === true) {
    throw new HttpsError('failed-precondition', 'Tournament maintenance is active.');
  }
  return tournament;
}
function audit(tx, id, eventType, matchKey, identity, before, after, reason = eventType) {
  const actor = typeof identity === 'object' ? bounded(identity) : { uid: identity };
  tx.create(ref('auditEvents', id), { transitionId: id, eventType, reason, matchKey, actor, before: bounded(before), after: bounded(after), createdAt: FieldValue.serverTimestamp() });
}
async function recorder(tx, uid) {
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const [tournamentSnap, configSnap, grantSnap] = await Promise.all([
    tx.get(root()),
    tx.get(ref('recorderAccess', 'config')),
    tx.get(ref('recorderGrants', uid)),
  ]);
  if (!tournamentSnap.exists
      || tournamentSnap.data().maintenance?.enabled === true
      || tournamentSnap.data().recorderFeatureEnabled !== true
      || !configSnap.exists
      || configSnap.data().enabled !== true
      || !grantSnap.exists
      || grantSnap.data().uid !== uid
      || grantSnap.data().version !== configSnap.data().version) {
    throw new HttpsError('permission-denied', 'Current recorder grant required.');
  }
}
function matchRef(assignment) {
  if (assignment.matchType === 'prelim') return root().collection('prelimMatches').doc(assignment.matchId || assignment.matchKey);
  if (assignment.matchType === 'final') return root().collection('divisions').doc(assignment.divisionId).collection('finalMatches').doc(assignment.matchId || assignment.matchKey);
  bad('Assignment has no official match selector.');
}
function finalAssignmentKey(divisionId, matchId) {
  return `final:${divisionId}:${matchId}`;
}
function setWinner(a, b, target) { if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 15 || b > 15) return null; const hi = Math.max(a,b); const margin=Math.abs(a-b); if (hi < target || a === b || (hi === 15 && margin > 2) || (hi > target && hi < 15 && margin !== 2) || (hi === target && margin < 2)) return null; return a > b ? 'A' : 'B'; }
function evaluate(assignment, sets) {
  const final = assignment.matchType === 'final'; const max = final ? 3 : 2; const targets = final ? [10, 10, 7] : [10, 10]; const source = Array.isArray(sets) ? sets.slice(0, max) : [];
  if (!source.length) bad('Score is required.');
  let a = 0; let b = 0; let pointsForA = 0; let pointsForB = 0;
  for (let i=0; i<source.length; i++) { const s=source[i]; const w=setWinner(Number(s.a), Number(s.b), targets[i]); if (!w) bad('Score contains an incomplete or invalid set.'); pointsForA += Number(s.a); pointsForB += Number(s.b); if (w === 'A') a++; else b++; if (final && (a === 2 || b === 2) && i !== source.length - 1) bad('Sets after a final winner are not allowed.'); }
  if ((!final && source.length !== 2) || (final && a !== 2 && b !== 2)) bad('Complete score required.');
  return { sets: source.map((s) => ({ a:Number(s.a), b:Number(s.b) })), setsWonA:a, setsWonB:b, pointsForA, pointsForB, status:'done', result: final ? (a === 2 ? 'A' : 'B') : (a === b ? 'draw' : (a > b ? 'A' : 'B')), winner: final ? (a === 2 ? 'A' : 'B') : null };
}
async function courtState(tx, courtId) {
  const queueSnap = await tx.get(ref('courtQueues', courtId)); if (!queueSnap.exists) bad('Court queue not found.');
  const assignmentsSnap = await tx.get(root().collection('courtAssignments').where('courtId', '==', courtId)); const workflows = await Promise.all(assignmentsSnap.docs.map((doc) => tx.get(ref('scoreWorkflows', doc.id))));
  const assignments = Object.fromEntries(assignmentsSnap.docs.map((doc) => [doc.id, doc.data()])); const workflowMap = Object.fromEntries(workflows.map((doc) => [doc.id, doc.exists ? doc.data() : {}])); return { queue: queueSnap.data(), assignments, workflows: workflowMap };
}
export async function createRecorderAccessCode(request) {
  const uid = await admin(request, request.data); const code = randomCode(); const salt = crypto.randomBytes(24).toString('base64url');
  let version;
  await db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const config = await tx.get(ref('recorderAccess', 'config'));
    version = config.exists ? (config.data().version || 0) + 1 : 1;
    const data = { enabled:true, version, salt, codeHash:hash(code,salt), hashVersion:1, updatedBy:uid, updatedAt:FieldValue.serverTimestamp() };
    if (config.exists) tx.update(config.ref, data);
    else tx.create(ref('recorderAccess', 'config'), data);
    tx.set(ref('recorderAccessChallenge', 'current'), { enabled:true, version });
    tx.set(root(), { recorderFeatureEnabled: true }, { merge: true });
  });
  return { version, code };
}
export async function revokeRecorderAccessCode(request) {
  const uid = await admin(request, request.data);
  await db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const snap = await tx.get(ref('recorderAccess', 'config'));
    if (!snap.exists) bad('Access code does not exist.');
    const version = (snap.data().version || 0) + 1;
    tx.update(snap.ref, { enabled:false, version, updatedBy:uid, updatedAt:FieldValue.serverTimestamp() });
    tx.set(ref('recorderAccessChallenge', 'current'), { enabled:false, version });
    tx.set(root(), { recorderFeatureEnabled: false }, { merge: true });
  });
  return { revoked:true };
}
export async function prepareTournamentReset(request) {
  const uid = await admin(request, request.data);
  const expectedName = request.data?.expectedName;
  if (typeof expectedName !== 'string' || !expectedName.trim()) {
    throw new HttpsError('invalid-argument', 'Current tournament name required.');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  let tournamentName;
  await db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    if (tournament.data()?.maintenance?.enabled === true) {
      throw new HttpsError('failed-precondition', 'Tournament maintenance is already active.');
    }
    tournamentName = tournament.data()?.name?.trim() || '바운스발리볼';
    if (tournamentName !== expectedName.trim()) {
      throw new HttpsError('aborted', 'Tournament name changed. Refresh and confirm again.');
    }
    tx.set(root(), {
      maintenance: {
        enabled: true,
        reset: {
          ownerUid: uid,
          tokenHash: resetTokenHash(token),
          phase: 'prepared',
          preparedAt: FieldValue.serverTimestamp(),
        },
      },
    }, { merge: true });
  });
  return { prepared: true, token, tournamentName };
}
export async function recoverTournamentReset(request) {
  const uid = await admin(request, request.data, { allowResetMaintenance: true });
  const token = crypto.randomBytes(32).toString('base64url');
  let phase;
  await db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    const reset = tournament.data()?.maintenance?.reset;
    const preparedAt = reset?.preparedAt?.toMillis?.() || 0;
    const stale = Date.now() - preparedAt >= 15 * 60 * 1000;
    if (tournament.data()?.maintenance?.enabled !== true
        || !reset
        || (reset.ownerUid !== uid && !stale)) {
      throw new HttpsError('failed-precondition', 'Active reset can only be recovered by its owner or after 15 minutes.');
    }
    phase = reset.phase;
    tx.set(root(), {
      maintenance: {
        ...tournament.data().maintenance,
        reset: {
          ...reset,
          ownerUid: uid,
          tokenHash: resetTokenHash(token),
          recoveredAt: FieldValue.serverTimestamp(),
        },
      },
    }, { merge: true });
  });
  return { recovered: true, phase, token };
}
async function resetOwner(request) {
  const uid = await admin(request, request.data, { allowResetMaintenance: true });
  const token = request.data?.token;
  if (typeof token !== 'string' || !token) throw new HttpsError('invalid-argument', 'Reset token required.');
  const maintenance = (await root().get()).data()?.maintenance;
  if (maintenance?.enabled !== true
      || maintenance?.reset?.ownerUid !== uid
      || maintenance?.reset?.tokenHash !== resetTokenHash(token)) {
    throw new HttpsError('permission-denied', 'Current reset owner and token required.');
  }
  return { uid, token };
}
export async function cancelTournamentReset(request) {
  const { uid, token } = await resetOwner(request);
  await db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    const reset = tournament.data()?.maintenance?.reset;
    if (tournament.data()?.maintenance?.enabled !== true
        || reset?.ownerUid !== uid
        || reset?.tokenHash !== resetTokenHash(token)
        || reset?.phase !== 'prepared') {
      throw new HttpsError('permission-denied', 'Current reset owner and token required.');
    }
    // merge:true 는 중첩 맵을 병합하므로 enabled만 내리면 reset 리스가 문서에 남아
    // 이후 복구(restore) 단계 callable이 영원히 maintenance로 차단된다. 명시적으로 지운다.
    tx.set(root(), { maintenance: { enabled: false, reset: FieldValue.delete() } }, { merge: true });
  });
  return { cancelled: true };
}
export async function resetTournament(request) {
  const { uid, token } = await resetOwner(request);
  await db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    const reset = tournament.data()?.maintenance?.reset;
    if (tournament.data()?.maintenance?.enabled !== true
        || reset?.ownerUid !== uid
        || reset?.tokenHash !== resetTokenHash(token)
        || !['prepared', 'deleting'].includes(reset?.phase)) {
      throw new HttpsError('permission-denied', 'Current reset owner and token required.');
    }
    tx.set(root(), {
      maintenance: {
        ...tournament.data().maintenance,
        reset: { ...reset, phase: 'deleting', deletionStartedAt: FieldValue.serverTimestamp() },
      },
    }, { merge: true });
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const collections = await root().listCollections();
    const operational = collections.filter((subcollection) => subcollection.id !== 'admins');
    await Promise.all(operational.map((subcollection) => db().recursiveDelete(subcollection)));
    const remaining = (await root().listCollections()).filter((subcollection) => subcollection.id !== 'admins');
    if (!remaining.length) break;
    if (attempt === 2) throw new HttpsError('internal', 'Tournament data deletion did not complete.');
  }
  await root().set({
    tournamentId: TOURNAMENT_ID,
    name: '',
    qualifyPerGroup: { men: 2, women: 2 },
    recorderFeatureEnabled: false,
    maintenance: { enabled: false },
    courtTopologyRevision: 0,
    venueDisplay: { mode: 'auto', intervalSeconds: 15 },
  });
  return { reset: true };
}
export async function exchangeRecorderAccessCode(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const code = request.data?.code;
  if (typeof code !== 'string' || !code.trim()) {
    throw new HttpsError('invalid-argument', 'Code required.');
  }
  return db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    if (tournament.data()?.maintenance?.enabled === true) {
      throw new HttpsError('failed-precondition', 'Tournament maintenance is active.');
    }
    const config = await tx.get(ref('recorderAccess', 'config'));
    const data = config.data();
    const suppliedHash = data ? hash(code.trim(), data.salt) : '';
    const validHash = Boolean(
      config.exists
      && data.enabled
      && suppliedHash.length === data.codeHash?.length
      && crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(data.codeHash)),
    );
    if (!validHash) throw new HttpsError('permission-denied', 'Invalid access code.');
    const version = data.version;
    tx.set(ref('recorderGrants', uid), {
      uid,
      version,
      proofHash: data.codeHash,
      issuedAt: FieldValue.serverTimestamp(),
    });
    // 과거 버전은 코드 생성 시 이 플래그를 켜지 않았다. 유효한 현재 코드를
    // 증명한 경우 함께 복구해 기존 발급 코드도 다시 만들지 않고 사용할 수 있게 한다.
    tx.set(root(), { recorderFeatureEnabled: true }, { merge: true });
    return { tournamentId: TOURNAMENT_ID, grantVersion: version };
  });
}
export async function replaceCourtWorkflows(request) {
  const uid = await admin(request, request.data);
  const {
    courts, assignmentsByCourt, unassignedAssignments, expectedTopologyRevision, expectedQueueRevisions,
  } = request.data || {};
  if (!Array.isArray(courts) || !assignmentsByCourt || typeof assignmentsByCourt !== 'object'
      || Array.isArray(assignmentsByCourt) || !Array.isArray(unassignedAssignments)
      || !Number.isInteger(expectedTopologyRevision) || !expectedQueueRevisions
      || typeof expectedQueueRevisions !== 'object' || Array.isArray(expectedQueueRevisions)) {
    throw new HttpsError('invalid-argument', 'courts, assignments, topology revision and queue revisions are required.');
  }
  const courtIds = new Set();
  const courtNames = new Set();
  // 문서 ID는 랜덤이라 읽는 순서가 관리자가 만든 순서와 무관하다. 순서를 문서에 명시적으로 박는다.
  const normalizedCourts = courts.map((court, index) => {
    const name = typeof court?.name === 'string'
      ? court.name.trim().replace(/\s*코트$/u, '').trim()
      : '';
    if (!court || typeof court.id !== 'string' || !court.id || typeof court.name !== 'string'
        || !name || typeof court.recorderName !== 'string' || courtIds.has(court.id) || courtNames.has(name)) {
      bad('Every court needs a unique id, display name and recorder name.');
    }
    courtIds.add(court.id);
    courtNames.add(name);
    return { id: court.id, name, recorderName: court.recorderName.trim(), order: index + 1 };
  });
  const desired = new Map();
  const normalizeAssignment = (item, courtId, order, nextCourtMatchKey) => {
    if (!item?.matchKey || typeof item.matchKey !== 'string' || desired.has(item.matchKey)
        || !['prelim', 'final'].includes(item.matchType)) bad('Duplicate or invalid match assignment.');
    if (item.matchType === 'prelim' && !item.division) bad('Prelim assignments require division.');
    if (item.matchType === 'final' && !item.divisionId) bad('Final assignments require divisionId.');
    desired.set(item.matchKey, {
      ...bounded(item),
      matchKey: item.matchKey,
      matchId: item.matchId || item.matchKey,
      courtId,
      courtOrder: order,
      nextCourtMatchKey,
      publicStatus: item.publicStatus || 'scheduled',
      dependencyReady: item.dependencyReady !== false,
      attemptCount: item.attemptCount || 0,
    });
  };
  for (const [courtId, list] of Object.entries(assignmentsByCourt)) {
    if (!courtIds.has(courtId) || !Array.isArray(list)) bad('Assignments must belong to a registered court.');
    list.forEach((item, index) => {
      normalizeAssignment(item, courtId, index + 1, list[index + 1]?.matchKey || null);
    });
  }
  unassignedAssignments.forEach((item) => normalizeAssignment(item, null, null, null));
  const topologyRevision = await db().runTransaction(async (tx) => {
    const [tournamentSnap, assignmentSnap, workflowSnap, queueSnap, courtSnap] = await Promise.all([
      tx.get(root()),
      tx.get(root().collection('courtAssignments')),
      tx.get(root().collection('scoreWorkflows')),
      tx.get(root().collection('courtQueues')),
      tx.get(root().collection('courts')),
    ]);
    if (tournamentSnap.data()?.maintenance?.enabled === true) {
      throw new HttpsError('failed-precondition', 'Tournament maintenance is active.');
    }
    const currentTopologyRevision = tournamentSnap.data()?.courtTopologyRevision || 0;
    if (currentTopologyRevision !== expectedTopologyRevision) {
      throw new HttpsError('aborted', 'Court topology revision changed.');
    }
    const existingQueueIds = new Set(queueSnap.docs.map((snap) => snap.id));
    const expectedQueueIds = Object.keys(expectedQueueRevisions);
    if (expectedQueueIds.length !== existingQueueIds.size
        || expectedQueueIds.some((courtId) => !existingQueueIds.has(courtId))
        || queueSnap.docs.some((snap) => (
          !Number.isInteger(expectedQueueRevisions[snap.id])
          || expectedQueueRevisions[snap.id] !== (snap.data().queueRevision || 0)
        ))) {
      throw new HttpsError('aborted', 'Court queue revision changed.');
    }
    const existingAssignments = new Map(assignmentSnap.docs.map((snap) => [snap.id, snap.data()]));
    const existingWorkflows = new Map(workflowSnap.docs.map((snap) => [snap.id, snap.data()]));
    for (const [matchKey, item] of desired) {
      if (existingAssignments.has(matchKey)) continue;
      const official = await tx.get(matchRef(item));
      if (!official.exists) bad(`Official match not found: ${matchKey}.`);
      const officialData = official.data();
      const hasOfficialHistory = (officialData.officialRevision || 0) > 0
        || Boolean(officialData.result || officialData.winner || officialData.winnerTeam)
        || ['done', 'completed'].includes(officialData.status)
        || (Array.isArray(officialData.sets)
          && officialData.sets.some((set) => Number(set?.a) > 0 || Number(set?.b) > 0));
      if (hasOfficialHistory) {
        throw new HttpsError(
          'failed-precondition',
          '이미 결과가 기록된 경기는 새 기록관 대기열에 배정할 수 없습니다. 새 대진을 생성하거나 기존 결과를 초기화하세요.',
        );
    }
    }
    const transition = `court_workflows_replaced:${crypto.randomUUID()}`;
    for (const [matchKey, assignment] of existingAssignments) {
      if (desired.has(matchKey)) continue;
      desired.set(matchKey, {
        ...assignment,
        matchKey,
        courtId: null,
        courtOrder: null,
        nextCourtMatchKey: null,
      });
    }
    const desiredByCourt = new Map(normalizedCourts.map((court) => [court.id, []]));
    const priorityByCourt = new Map(normalizedCourts.map((court) => [court.id, []]));
    for (const item of desired.values()) {
      if (item.courtId) desiredByCourt.get(item.courtId).push(item);
    }
    for (const queue of queueSnap.docs) {
      for (const entry of queue.data().priorityEntries || []) {
        const courtId = desired.get(entry.matchKey)?.courtId;
        if (courtId) priorityByCourt.get(courtId).push(entry);
      }
    }
    let reassignmentSequence = Math.max(
      0,
      ...queueSnap.docs.map((snap) => snap.data().nextPrioritySequence || 0),
      ...[...priorityByCourt.values()].flat().map((entry) => (entry.enqueueSequence || 0) + 1),
    );
    for (const item of desired.values()) {
      if (!item.courtId) continue;
      const assignment = existingAssignments.get(item.matchKey) || item;
      const workflow = existingWorkflows.get(item.matchKey) || {};
      const needsPriority = assignment.publicStatus === 'replay_required'
        || assignment.publicStatus === 'rework_required'
        || workflow.draftState === 'rejected';
      const entries = priorityByCourt.get(item.courtId);
      if (!needsPriority || entries.some((entry) => entry.matchKey === item.matchKey)) continue;
      entries.push({
        entryId: `${workflow.draftState === 'rejected' ? 'rejected_rework' : 'correction_replay'}:${item.matchKey}`,
        matchKey: item.matchKey,
        kind: workflow.draftState === 'rejected' ? 'rejected_rework' : 'correction_replay',
        enqueueSequence: reassignmentSequence,
        pathDepth: 0,
        courtOrder: item.courtOrder || 0,
        eligibility: item.dependencyReady === false ? 'blocked_dependency' : 'ready',
        sourceTransitionIds: assignment.lastTransitionId ? [assignment.lastTransitionId] : [],
      });
      reassignmentSequence += 1;
    }
    for (const [courtId, entries] of desiredByCourt) {
      entries.sort((a, b) => a.courtOrder - b.courtOrder);
      const editing = entries.filter((item) => {
        const workflow = existingWorkflows.get(item.matchKey);
        return workflow?.draftState === 'editing' || Boolean(workflow?.lock);
      });
      if (editing.length > 1) throw new HttpsError('aborted', 'Only one editing match can occupy a court.');
      if (editing.length) entries.splice(entries.indexOf(editing[0]), 1), entries.unshift(editing[0]);
      const normalizedEntries = entries.map((item, index) => {
        const normalized = {
          ...item,
          courtOrder: index + 1,
          nextCourtMatchKey: entries[index + 1]?.matchKey || null,
        };
        desired.set(item.matchKey, normalized);
        return normalized;
      });
      desiredByCourt.set(courtId, normalizedEntries);
    }
    for (const court of normalizedCourts) tx.set(ref('courts', court.id), court);
    for (const existing of courtSnap.docs) {
      if (!courtIds.has(existing.id)) tx.delete(existing.ref);
    }
    for (const queue of queueSnap.docs) {
      if (!courtIds.has(queue.id)) tx.delete(queue.ref);
    }
    for (const [matchKey, item] of desired) {
      const oldWorkflow = existingWorkflows.get(matchKey);
      const oldAssignment = existingAssignments.get(matchKey);
      const storedItem = oldAssignment ? {
        ...item,
        publicStatus: oldAssignment.publicStatus,
        attemptCount: oldAssignment.attemptCount || 0,
        officialRevision: oldAssignment.officialRevision || 0,
        lastTransitionId: oldAssignment.lastTransitionId || null,
      } : item;
      tx.set(ref('courtAssignments', matchKey), storedItem);
      if (!oldWorkflow) {
        tx.set(ref('scoreWorkflows', matchKey), {
          draftState: 'idle', draftRevision: 0, submissionVersion: 0, officialRevision: 0, lock: null,
        });
      }
    }
    for (const court of normalizedCourts) {
      const entries = desiredByCourt.get(court.id);
      const previous = queueSnap.docs.find((snap) => snap.id === court.id)?.data();
      const assignments = Object.fromEntries(entries.map((item) => [item.matchKey, {
        ...item,
        ...(['publicStatus', 'attemptCount', 'officialRevision', 'lastTransitionId'].reduce((state, key) => (
          existingAssignments.get(item.matchKey)?.[key] === undefined ? state : { ...state, [key]: existingAssignments.get(item.matchKey)[key] }
        ), {})),
      }]));
      const workflows = Object.fromEntries(entries.map((item) => [item.matchKey, existingWorkflows.get(item.matchKey) || {
        draftState: 'idle', draftRevision: 0, submissionVersion: 0, officialRevision: 0, lock: null,
      }]));
      const projected = projectCourtQueue({
        courtId: court.id,
        ...(previous || {}),
        priorityEntries: priorityByCourt.get(court.id),
        nextPrioritySequence: Math.max(
          previous?.nextPrioritySequence || 0,
          ...priorityByCourt.get(court.id).map((entry) => (entry.enqueueSequence || 0) + 1),
        ),
        queueRevision: (previous?.queueRevision || 0) + 1,
        lastTransitionId: transition,
      }, assignments, workflows);
      tx.set(ref('courtQueues', court.id), projected);
    }
    tx.set(root(), { courtTopologyRevision: currentTopologyRevision + 1 }, { merge: true });
    audit(tx, transition, 'court_workflows_replaced', 'courts', uid, {
      topologyRevision: currentTopologyRevision,
      courts: courtSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() })),
      assignments: assignmentSnap.docs.map((snap) => ({ matchKey: snap.id, courtId: snap.data().courtId, courtOrder: snap.data().courtOrder })),
    }, {
      topologyRevision: currentTopologyRevision + 1,
      courts: normalizedCourts,
      assignmentsByCourt: Object.fromEntries(normalizedCourts.map((court) => [court.id, [...desired.values()].filter((item) => item.courtId === court.id).map((item) => item.matchKey)])),
      unassignedAssignments: [...desired.values()].filter((item) => !item.courtId).map((item) => item.matchKey),
    });
    return currentTopologyRevision + 1;
  });
  return { replaced: true, topologyRevision };
}
export async function publishFinalStructure(request) {
  const uid = await admin(request, request.data);
  const { division, matches = [] } = request.data || {};
  if (!['men', 'women'].includes(division) || !Array.isArray(matches)) {
    throw new HttpsError('invalid-argument', 'Valid division and matches are required.');
  }
  const collectionRef = root().collection('divisions').doc(division).collection('finalMatches');
  const transition = `final_structure:${division}:${crypto.randomUUID()}`;
  await db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const existing = await tx.get(collectionRef);
    const keep = new Set();
    for (const match of matches) {
      if (!match?.id) bad('Every final match requires an id.');
      keep.add(match.id);
      const {
        sets, result, winner, winnerSide, winnerTeam,
        setsWonA, setsWonB, pointsForA, pointsForB,
        officialSnapshot, officialRevision, lastTransitionId,
        ...structure
      } = bounded(match);
      if (!['empty', 'waiting', 'pending', 'bye_pending'].includes(structure.status)) {
        delete structure.status;
      }
      tx.set(collectionRef.doc(match.id), structure, { merge: true });
    }
    for (const snapshot of existing.docs) {
      if (!keep.has(snapshot.id)) tx.delete(snapshot.ref);
    }
    audit(tx, transition, 'final_structure_published', division, uid, {
      matchIds: existing.docs.map((snapshot) => snapshot.id),
    }, {
      matchIds: [...keep],
    });
  });
  return { transitionId: transition, count: matches.length };
}

async function approve(request, direct = false) {
  const uid = await admin(request, request.data);
  const { matchKey, score, reason, expectedSubmissionVersion, expectedOfficialRevision } = request.data;
  if (!matchKey) throw new HttpsError('invalid-argument', 'matchKey required.');
  return db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const assignmentSnap = await tx.get(ref('courtAssignments', matchKey)); const workflowSnap = await tx.get(ref('scoreWorkflows', matchKey));
    if (!assignmentSnap.exists || !workflowSnap.exists) bad('Match workflow not found.');
    const assignment = assignmentSnap.data(); const workflow = workflowSnap.data();
    if (!direct && (assignment.publicStatus !== 'under_review' || workflow.draftState !== 'submitted')) bad('Only submitted reviews can be approved.');
    if (!direct && (!Number.isInteger(expectedSubmissionVersion) || workflow.submissionVersion !== expectedSubmissionVersion)) {
      throw new HttpsError('aborted', 'Submission version changed.');
    }
    if (direct && (!Number.isInteger(expectedOfficialRevision) || workflow.officialRevision !== expectedOfficialRevision)) {
      throw new HttpsError('aborted', 'Official revision changed.');
    }
    if (direct && (typeof reason !== 'string' || !reason.trim())) {
      throw new HttpsError('invalid-argument', 'A correction reason is required.');
    }
    const officialDocumentRef = matchRef(assignment);
    const officialSnap = await tx.get(officialDocumentRef);
    if (!officialSnap.exists) bad('Official match not found.');
    const officialMatch = officialSnap.data();
    const evaluated = evaluate(
      assignment,
      direct ? score?.sets : workflow.submittedSnapshot?.sets,
    );
    const revision = (workflow.officialRevision || 0) + 1;
    const id = transitionId(matchKey, direct ? 'admin_direct_edit' : 'review_approved', revision);
    const official = {
      ...evaluated,
      officialRevision: revision,
      lastTransitionId: id,
    };
    let downstream = null;
    let dependencyActivation = null;
    if (assignment.matchType === 'final') {
      official.winnerSide = evaluated.winner;
      official.winnerTeam = evaluated.winner === 'A' ? officialMatch.teamA : officialMatch.teamB;
      const nextMatchId = assignment.nextMatchId || officialMatch.nextMatchId;
      if (nextMatchId) {
        const nextMatchKey = finalAssignmentKey(assignment.divisionId, nextMatchId);
        const nextRef = root().collection('divisions').doc(assignment.divisionId).collection('finalMatches').doc(nextMatchId);
        const nextSnap = await tx.get(nextRef);
        if (!nextSnap.exists) bad('Downstream final match not found.');
        const slot = assignment.nextSlot || officialMatch.nextSlot;
        const teamField = slot === 'B' ? 'teamB' : 'teamA';
        const sourceField = slot === 'B' ? 'teamBSource' : 'teamASource';
        const postDownstreamMatch = {
          ...nextSnap.data(),
          [teamField]: official.winnerTeam,
          [sourceField]: { type: 'upstream', matchKey },
        };
        downstream = {
          ref: nextRef,
          matchKey: nextMatchKey,
          teamField,
          sourceField,
          team: official.winnerTeam,
          source: { type: 'upstream', matchKey },
        };
        const downstreamAssignmentSnap = await tx.get(ref('courtAssignments', nextMatchKey));
        const allDependenciesReady = Boolean(postDownstreamMatch.teamA && postDownstreamMatch.teamB);
        if (downstreamAssignmentSnap.exists
            && allDependenciesReady
            && downstreamAssignmentSnap.data().dependencyReady !== true) {
          const downstreamAssignment = downstreamAssignmentSnap.data();
          const downstreamState = downstreamAssignment.courtId
            ? await courtState(tx, downstreamAssignment.courtId)
            : null;
          const downstreamAssignments = downstreamState ? {
            ...downstreamState.assignments,
            [nextMatchKey]: { ...downstreamAssignment, dependencyReady: true },
          } : null;
          const queue = downstreamState ? projectCourtQueue(
            activateDependencyEntries(
              {
                ...downstreamState.queue,
                queueRevision: (downstreamState.queue.queueRevision || 0) + 1,
              },
              downstreamAssignments,
              downstreamState.workflows,
              [nextMatchKey],
            ),
            downstreamAssignments,
            downstreamState.workflows,
          ) : null;
          dependencyActivation = {
            assignmentRef: downstreamAssignmentSnap.ref,
            courtId: downstreamAssignment.courtId,
            queue,
          };
        }
      }
    }
    tx.update(officialDocumentRef, official);
    if (downstream) {
      tx.update(downstream.ref, {
        [downstream.teamField]: downstream.team,
        [downstream.sourceField]: downstream.source,
      });
    }
    if (dependencyActivation) {
      tx.update(dependencyActivation.assignmentRef, { dependencyReady: true, lastTransitionId: id });
      if (dependencyActivation.queue) {
        tx.update(ref('courtQueues', dependencyActivation.courtId), {
          ...dependencyActivation.queue,
          lastTransitionId: id,
        });
      }
    }
    tx.update(workflowSnap.ref, { draftState: 'approved', lock: null, officialRevision: revision, officialSnapshot: official, lastTransitionId: id });
    tx.update(assignmentSnap.ref, { publicStatus: 'completed', officialRevision: revision, lastTransitionId: id });
    audit(tx, id, direct ? 'admin_direct_edit' : 'review_approved', matchKey, uid, { assignment, workflow }, {
      assignment: { ...assignment, publicStatus: 'completed', officialRevision: revision },
      official,
      dependencyQueue: dependencyActivation?.queue || null,
    }, direct ? reason.trim() : 'review_approved');
    return { transitionId: id, official };
  });
}
export const approveScoreReview = (request) => approve(request, false);
export const directEditOfficialScore = (request) => approve(request, true);

export async function rejectScoreReview(request) {
  const uid = await admin(request, request.data); const { matchKey, reason, expectedSubmissionVersion, expectedQueueRevision } = request.data;
  if (typeof reason !== 'string' || !reason.trim() || !Number.isInteger(expectedSubmissionVersion)) {
    throw new HttpsError('invalid-argument', 'Reason and submission revision are required.');
  }
  return db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const [assignmentSnap, workflowSnap] = await Promise.all([
      tx.get(ref('courtAssignments', matchKey)),
      tx.get(ref('scoreWorkflows', matchKey)),
    ]);
    if (!assignmentSnap.exists || !workflowSnap.exists) bad('Match not found.');
    const assignment = assignmentSnap.data();
    const workflow = workflowSnap.data();
    if (assignment.publicStatus !== 'under_review' || workflow.draftState !== 'submitted') {
      bad('Only submitted reviews can be rejected.');
    }
    const state = assignment.courtId ? await courtState(tx, assignment.courtId) : null;
    if (workflow.submissionVersion !== expectedSubmissionVersion
        || (state && (!Number.isInteger(expectedQueueRevision) || state.queue.queueRevision !== expectedQueueRevision))) {
      throw new HttpsError('aborted', 'Submission or queue revision changed.');
    }
    const id = transitionId(matchKey, 'review_rejected', workflow.submissionVersion || 0);
    const planned = state ? planRejectedRework(
      { ...state.queue, queueRevision: (state.queue.queueRevision || 0) + 1 },
      state.assignments,
      state.workflows,
      matchKey,
      id,
    ) : {
      assignments: { [matchKey]: { ...assignment, publicStatus: 'replay_required' } },
      workflows: { [matchKey]: { ...workflow, draftState: 'rejected', lock: null } },
      queue: null,
    };
    tx.update(assignmentSnap.ref, { publicStatus: planned.assignments[matchKey].publicStatus, lastTransitionId: id });
    tx.update(ref('scoreWorkflows', matchKey), { draftState: 'rejected', lock: null, lastTransitionId: id });
    if (state) tx.update(ref('courtQueues', assignment.courtId), { ...planned.queue, lastTransitionId: id });
    audit(tx, id, 'review_rejected', matchKey, uid, { assignment, workflow }, { assignment: planned.assignments[matchKey], workflow: planned.workflows[matchKey] }, reason.trim());
    return { transitionId: id };
  });
}
export async function cancelRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, token, queueRevision } = request.data || {};
  if (!matchKey || !token) {
    throw new HttpsError('invalid-argument', 'matchKey and token are required.');
  }
  return db().runTransaction(async (tx) => {
    await recorder(tx, uid);
    const [assignmentSnap, workflowSnap] = await Promise.all([
      tx.get(ref('courtAssignments', matchKey)),
      tx.get(ref('scoreWorkflows', matchKey)),
    ]);
    if (!assignmentSnap.exists || !workflowSnap.exists) bad('Match workflow not found.');
    const assignment = assignmentSnap.data();
    const workflow = workflowSnap.data();
    const state = assignment.courtId ? await courtState(tx, assignment.courtId) : null;
    if ((state && (
      assignment.courtId !== courtId
      || !Number.isInteger(queueRevision)
      || state.queue.queueRevision !== queueRevision
      || state.queue.currentMatchKey !== matchKey
    ))
        || workflow.draftState !== 'editing'
        || workflow.lock?.uid !== uid
        || workflow.lock?.token !== token) {
      throw new HttpsError('aborted', 'Stale recorder ownership or queue revision.');
    }
    const draftState = workflow.resumeDraftState === 'rejected' ? 'rejected' : 'idle';
    const publicStatus = draftState === 'rejected' ? 'replay_required' : 'scheduled';
    const id = transitionId(matchKey, 'recorder_cancel', `${queueRevision ?? 'unassigned'}:${token}`);
    let queue = null;
    if (state) {
      const assignments = { ...state.assignments, [matchKey]: { ...assignment, publicStatus } };
      queue = projectForceRelease(
        { ...state.queue, queueRevision: queueRevision + 1 },
        assignments,
        state.workflows,
        matchKey,
        { draftState },
      );
    }
    tx.update(ref('scoreWorkflows', matchKey), { draftState, lock: null, lastTransitionId: id });
    tx.update(ref('courtAssignments', matchKey), { publicStatus, lastTransitionId: id });
    if (state) tx.update(ref('courtQueues', assignment.courtId), { ...queue, lastTransitionId: id });
    audit(tx, id, 'recorder_cancel', matchKey, uid, { workflow, queue: state?.queue || null }, { workflow: { ...workflow, draftState, lock: null }, queue });
    return { transitionId: id, queueRevision: queue?.queueRevision ?? null };
  });
}

export async function resumeRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, recorderName, queueRevision } = request.data || {};
  if (typeof matchKey !== 'string' || !matchKey || typeof courtId !== 'string' || !courtId
      || typeof recorderName !== 'string' || !recorderName.trim()) {
    throw new HttpsError('invalid-argument', 'Match, court and recorder name required.');
}
  const normalizedRecorderName = recorderName.trim();
  const token = randomCode();
  let result;
  await db().runTransaction(async (tx) => {
    await recorder(tx, uid);
    const [assignmentSnap, workflowSnap, courtSnap, queueSnap] = await Promise.all([
      tx.get(ref('courtAssignments', matchKey)),
      tx.get(ref('scoreWorkflows', matchKey)),
      tx.get(ref('courts', courtId)),
      tx.get(ref('courtQueues', courtId)),
    ]);
    if (!assignmentSnap.exists || !workflowSnap.exists || !courtSnap.exists || !queueSnap.exists) {
      throw new HttpsError('not-found', 'Recorder workflow not found.');
}
    const assignment = assignmentSnap.data();
    const workflow = workflowSnap.data();
    const court = courtSnap.data();
    const queue = queueSnap.data();
    if (assignment.courtId !== courtId || queue.currentMatchKey !== matchKey
        || !Number.isInteger(queueRevision) || queue.queueRevision !== queueRevision) {
      throw new HttpsError('aborted', 'Court queue changed. Refresh and try again.');
}
    if (assignment.publicStatus !== 'in_progress' || workflow.draftState !== 'editing'
        || !workflow.lock || workflow.lock.uid !== uid
        || workflow.lock.recorderName !== normalizedRecorderName
        || court.recorderName?.trim() !== normalizedRecorderName) {
      throw new HttpsError('permission-denied', 'Only the same recorder can resume this draft.');
}
    const nextLock = { uid, token, recorderName: normalizedRecorderName };
    const id = `${transitionId(matchKey, 'recorder_resume', workflow.draftRevision || 0)}:${resetTokenHash(token).slice(0, 12)}`;
    tx.update(workflowSnap.ref, { lock: nextLock, lastTransitionId: id });
    tx.update(assignmentSnap.ref, { lastTransitionId: id });
    audit(tx, id, 'recorder_resume', matchKey, {
      uid,
      name: normalizedRecorderName,
      email: request.auth?.token?.email || null,
    }, {
      lock: workflow.lock,
      draftState: workflow.draftState,
      draftRevision: workflow.draftRevision || 0,
    }, {
      lock: nextLock,
      draftState: workflow.draftState,
      draftRevision: workflow.draftRevision || 0,
    });
    result = { token, transitionId: id, resumed: true, draftRevision: workflow.draftRevision || 0 };
  });
  return result;
}

export async function submitRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, token, queueRevision, score } = request.data || {};
  if (!matchKey || !token) {
    throw new HttpsError('invalid-argument', 'matchKey and token are required.');
  }
  return db().runTransaction(async (tx) => {
    await recorder(tx, uid);
    const [assignmentSnap, workflowSnap] = await Promise.all([
      tx.get(ref('courtAssignments', matchKey)),
      tx.get(ref('scoreWorkflows', matchKey)),
    ]);
    if (!assignmentSnap.exists || !workflowSnap.exists) bad('Match workflow not found.');
    const assignment = assignmentSnap.data();
    const workflow = workflowSnap.data();
    const state = assignment.courtId ? await courtState(tx, assignment.courtId) : null;
    if ((state && (
      assignment.courtId !== courtId
      || !Number.isInteger(queueRevision)
      || state.queue.queueRevision !== queueRevision
      || state.queue.currentMatchKey !== matchKey
    ))
        || workflow.draftState !== 'editing'
        || workflow.lock?.uid !== uid
        || workflow.lock?.token !== token) {
      throw new HttpsError('aborted', 'Stale recorder ownership or queue revision.');
    }
    const evaluated = evaluate(assignment, score?.sets);
    const submittedSnapshot = { sets: evaluated.sets };
    const submissionVersion = (workflow.submissionVersion || 0) + 1;
    const id = transitionId(matchKey, 'submission_complete', submissionVersion);
    let queue = null;
    if (state) {
      const assignments = { ...state.assignments, [matchKey]: { ...assignment, publicStatus: 'under_review' } };
      const workflows = { ...state.workflows, [matchKey]: { ...workflow, draftState: 'submitted', lock: null } };
      queue = consumeCurrentAndAdvance(
        state.queue,
        assignments,
        workflows,
        matchKey,
      );
    }
    tx.update(ref('scoreWorkflows', matchKey), {
      draft: submittedSnapshot,
      submittedSnapshot,
      draftState: 'submitted',
      lock: null,
      submissionVersion,
      lastTransitionId: id,
    });
    tx.update(ref('courtAssignments', matchKey), { publicStatus: 'under_review', lastTransitionId: id });
    if (state) tx.update(ref('courtQueues', assignment.courtId), { ...queue, lastTransitionId: id });
    audit(tx, id, 'submission_complete', matchKey, {
      uid,
      name: workflow.lock?.recorderName || request.auth?.token?.name || null,
      email: request.auth?.token?.email || null,
    }, { workflow, queue: state?.queue || null }, { workflow: { ...workflow, draftState: 'submitted', lock: null, submissionVersion }, queue });
    return {
      transitionId: id,
      queueRevision: queue?.queueRevision ?? null,
      nextMatchKey: queue?.currentMatchKey ?? null,
    };
  });
}
export async function forceReleaseWorkflow(request) {
  const uid = await admin(request, request.data);
  const { matchKey, reason, expectedLockToken, expectedQueueRevision } = request.data;
  if (typeof reason !== 'string' || !reason.trim() || !expectedLockToken) {
    throw new HttpsError('invalid-argument', 'A release reason and lock token are required.');
  }
  return db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const assignmentSnap = await tx.get(ref('courtAssignments', matchKey)); const workflowSnap = await tx.get(ref('scoreWorkflows', matchKey));
    if (!assignmentSnap.exists || !workflowSnap.exists) bad('Match not found.');
    const assignment = assignmentSnap.data(); const workflow = workflowSnap.data(); if (!workflow.lock) bad('No active lock to release.');
    const state = assignment.courtId ? await courtState(tx, assignment.courtId) : null;
    const releaseId = `${transitionId(matchKey, 'force_release', workflow.draftRevision || 0)}:${crypto.createHash('sha256').update(expectedLockToken).digest('hex').slice(0, 12)}`;
    if (workflow.lock.token !== expectedLockToken
        || (state && (!Number.isInteger(expectedQueueRevision) || state.queue.queueRevision !== expectedQueueRevision))) {
      throw new HttpsError('aborted', 'Lock owner or queue revision changed.');
    }
    const returnState = { draftState: workflow.resumeDraftState === 'rejected' ? 'rejected' : 'idle' };
    const publicStatus = returnState.draftState === 'rejected' ? 'replay_required' : 'scheduled';
    const queue = state ? projectForceRelease(
      { ...state.queue, queueRevision: (state.queue.queueRevision || 0) + 1 },
      { ...state.assignments, [matchKey]: { ...assignment, publicStatus } },
      state.workflows,
      matchKey,
      returnState,
    ) : null;
    tx.update(workflowSnap.ref, { ...returnState, lock: null, lastTransitionId: releaseId });
    tx.update(assignmentSnap.ref, { publicStatus, lastTransitionId: releaseId });
    if (state) tx.update(ref('courtQueues', assignment.courtId), { ...queue, lastTransitionId: releaseId });
    audit(tx, releaseId, 'force_release', matchKey, uid, { lock: workflow.lock }, { lock: null }, reason.trim()); return { transitionId: releaseId };
  });
}
export async function previewApprovedCorrection(request) {
  await admin(request, request.data);
  const targets = [...new Set(request.data?.matchKeys || [])];
  if (!targets.length) throw new HttpsError('invalid-argument', 'matchKeys required.');
  return db().runTransaction(async (tx) => {
    const targetSnaps = await Promise.all(targets.map((key) => tx.get(ref('courtAssignments', key))));
    if (targetSnaps.some((snap) => !snap.exists)) bad('Unknown correction target.');
    const courtId = targetSnaps[0].data().courtId;
    if (!courtId || targetSnaps.some((snap) => snap.data().courtId !== courtId)) {
      bad('Correction targets must share one assigned court.');
    }
    const state = await courtState(tx, courtId);
    const planned = planCorrectionReplay(state.queue, state.assignments, state.workflows, targets, 'preview');
    const replayMatchKeys = targets.filter((key) => planned.assignments[key]?.publicStatus === 'replay_required');
    return {
      targets: targetSnaps.map((snap) => ({ matchKey: snap.id, courtId })),
      expectedQueueRevision: state.queue.queueRevision || 0,
      projection: {
        before: {
          currentMatchKey: state.queue.currentMatchKey || null,
          nextMatchKey: state.queue.nextMatchKey || null,
        },
        after: {
          currentMatchKey: planned.queue.currentMatchKey || null,
          nextMatchKey: planned.queue.nextMatchKey || null,
        },
        replayMatchKeys,
        inPlaceMatchKeys: targets.filter((key) => !replayMatchKeys.includes(key)),
      },
    };
  });
}
export async function applyApprovedCorrection(request) {
  const uid = await admin(request, request.data);
  const targets = [...new Set(request.data?.matchKeys || [])];
  const { reason, expectedQueueRevision } = request.data || {};
  if (!targets.length || typeof reason !== 'string' || !reason.trim() || !Number.isInteger(expectedQueueRevision)) {
    throw new HttpsError('invalid-argument', 'matchKeys, reason and expectedQueueRevision are required.');
  }
  return db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const first = await tx.get(ref('courtAssignments', targets[0])); if (!first.exists) bad('Unknown correction target.'); const courtId = first.data().courtId;
    const state = await courtState(tx, courtId); if (targets.some((key) => !state.assignments[key] || state.assignments[key].courtId !== courtId)) bad('Correction targets must share one court.');
    if (state.queue.queueRevision !== expectedQueueRevision) throw new HttpsError('aborted', 'Queue revision changed.');
    const id = transitionId(targets.join(','), 'approved_correction', state.queue.queueRevision || 0); const plan = planCorrectionReplay({ ...state.queue, queueRevision: (state.queue.queueRevision || 0) + 1 }, state.assignments, state.workflows, targets, id);
    for (const key of targets) { const a = plan.assignments[key]; const w = plan.workflows[key]; if (a !== state.assignments[key]) tx.update(ref('courtAssignments', key), { publicStatus: a.publicStatus, lastTransitionId: id }); if (w !== state.workflows[key]) tx.update(ref('scoreWorkflows', key), { draftState: w.draftState, lock: w.lock, lastTransitionId: id }); }
    tx.update(ref('courtQueues', courtId), { ...plan.queue, lastTransitionId: id }); audit(tx, id, 'approved_correction', targets.join(','), uid, { targets }, { targets, queue: plan.queue }, reason.trim()); return { transitionId: id };
  });
}

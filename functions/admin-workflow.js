import crypto from 'node:crypto';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  activateDependencyEntries, consumeCurrentAndAdvance, planCorrectionReplay,
  planCourtRemoval, planRejectedRework, projectCourtQueue, projectForceRelease, projectQueue, TOURNAMENT_ID,
} from './workflow-core.js';

// All privileged workflow operations are fixed to the one deployed `main`
// tournament; `requireMain` rejects any caller attempt to select another root.
const db = () => getFirestore();
const root = () => db().collection('tournaments').doc(TOURNAMENT_ID);
const ref = (name, id) => root().collection(name).doc(id);
const bad = (message) => { throw new HttpsError('failed-precondition', message); };
const requireMain = (data) => { if (data?.tournamentId !== TOURNAMENT_ID) throw new HttpsError('invalid-argument', 'Unknown tournament.'); };
const bounded = (value) => JSON.parse(JSON.stringify(value ?? null, (_key, item) => typeof item === 'string' ? item.slice(0, 1024) : item));
const boundedReason = (value) => value.trim().slice(0, 1024);
const transitionId = (matchKey, event, revision = 0) => `server:${matchKey}:${event}:${revision}`;
const LEASE_MS = 3 * 60 * 1000;
const OPERATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const callableError = (reason, code = 'failed-precondition') => { throw new HttpsError(code, reason, { reason }); };
const recorderAuditId = (event, uid, matchKey, token) => `rec:${crypto.createHash('sha256').update(`${event}:${uid}:${matchKey}:${token}`).digest('base64url')}`;
function requireOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) throw new HttpsError('invalid-argument', 'operationId required.', { reason: 'stale_revision' });
  return value;
}
function isExpired(lock, now = Date.now()) { return !lock?.expiresAt?.toMillis || lock.expiresAt.toMillis() <= now; }
function newLease(uid, token, recorderName, sessionId, now = Date.now()) {
  const stamp = Timestamp.fromMillis(now);
  return { uid, token, recorderName, sessionId, acquiredAt: stamp, renewedAt: stamp, expiresAt: Timestamp.fromMillis(now + LEASE_MS) };
}
function renewLease(lock, now = Date.now()) { return { ...lock, renewedAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + LEASE_MS) }; }
function validateLease(workflow, { uid, token, sessionId }) {
  const lock = workflow.lock;
  if (!lock || lock.uid !== uid || lock.token !== token || lock.sessionId !== sessionId) callableError('ownership_lost', 'aborted');
  if (isExpired(lock)) callableError('lease_expired', 'aborted');
  return lock;
}
function assertResolved(assignment) { if (assignment.dependencyReady === false) callableError('unresolved_teams'); }
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
function hasGoogleProvider(request) {
  return request.auth?.token?.firebase?.sign_in_provider === 'google.com';
}
async function recorder(tx, request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const [tournamentSnap, configSnap, grantSnap, adminSnap] = await Promise.all([
    tx.get(root()),
    tx.get(ref('recorderAccess', 'config')),
    tx.get(ref('recorderGrants', uid)),
    tx.get(ref('admins', uid)),
  ]);
  if ((!hasGoogleProvider(request) && !adminSnap.exists)
      || !tournamentSnap.exists
      || tournamentSnap.data().maintenance?.enabled === true
      || tournamentSnap.data().recorderFeatureEnabled !== true
      || !configSnap.exists
      || configSnap.data().enabled !== true
      || !grantSnap.exists
      || grantSnap.data().uid !== uid
      || grantSnap.data().version !== configSnap.data().version
      || grantSnap.data().status !== 'active'
      || !grantSnap.data().expiresAt?.toMillis
      || grantSnap.data().expiresAt.toMillis() <= Date.now()) {
    throw new HttpsError('permission-denied', 'Current recorder grant required.');
  }
}
function matchRef(assignment) {
  if (assignment.matchType === 'prelim') return root().collection('prelimMatches').doc(assignment.matchId || assignment.matchKey);
  if (assignment.matchType === 'final') return root().collection('divisions').doc(assignment.divisionId).collection('finalMatches').doc(assignment.matchId || assignment.matchKey);
  bad('Assignment has no official match selector.');
}
function correctionTargets(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024
      || value.some((key) => typeof key !== 'string' || !key || key.length > 256)) {
    throw new HttpsError('invalid-argument', 'matchKeys required.');
  }
  return [...new Set(value)].sort();
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value === undefined ? null : value;
}
function correctionFingerprint(descriptor) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(descriptor))).digest('hex');
}
function correctionProjection(queue, planned, targets) {
  const replayMatchKeys = targets.filter((key) => planned.assignments[key]?.publicStatus === 'replay_required');
  return {
    before: { currentMatchKey: queue.currentMatchKey || null, nextMatchKey: queue.nextMatchKey || null },
    after: { currentMatchKey: planned.queue.currentMatchKey || null, nextMatchKey: planned.queue.nextMatchKey || null },
    replayMatchKeys,
    inPlaceMatchKeys: targets.filter((key) => !replayMatchKeys.includes(key)),
  };
}
async function correctionPreviewPlan(tx, targets) {
  await assertTournamentWritable(tx);
  const targetSnaps = await Promise.all(targets.map((key) => tx.get(ref('courtAssignments', key))));
  if (targetSnaps.some((snap) => !snap.exists)) bad('Unknown correction target.');
  const courtId = targetSnaps[0].data().courtId;
  if (!courtId || targetSnaps.some((snap) => snap.data().courtId !== courtId)) {
    bad('Correction targets must share one assigned court.');
  }
  const state = await courtState(tx, courtId);
  const officialSnaps = await Promise.all(targets.map((key) => tx.get(matchRef(state.assignments[key]))));
  if (officialSnaps.some((snap) => !snap.exists)) bad('Correction target official match not found.');
  let planned;
  try {
    planned = planCorrectionReplay(state.queue, state.assignments, state.workflows, targets, 'preview');
  } catch (error) {
    bad(error instanceof Error ? error.message : 'Correction plan is no longer valid.');
  }
  const projection = correctionProjection(state.queue, planned, targets);
  const descriptor = {
    courtId,
    matchKeys: targets,
    queue: state.queue,
    courtMatches: Object.keys(state.assignments).sort().map((key) => ({
      matchKey: key,
      assignment: state.assignments[key],
      workflow: state.workflows[key],
    })),
    targets: targets.map((key, index) => ({
      matchKey: key,
      assignment: state.assignments[key],
      workflow: state.workflows[key],
      official: officialSnaps[index].data(),
    })),
    projection,
    planned: {
      queue: planned.queue,
      targets: targets.map((key) => ({
        matchKey: key,
        assignment: planned.assignments[key],
        workflow: planned.workflows[key],
      })),
    },
  };
  return {
    courtId, state, planned, projection,
    planToken: {
      courtId,
      matchKeys: targets,
      expectedQueueRevision: state.queue.queueRevision || 0,
      fingerprint: correctionFingerprint(descriptor),
    },
  };
}
function finalAssignmentKey(divisionId, matchId) {
  return `final:${divisionId}:${matchId}`;
}
function setWinner(a, b, target) { if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 15 || b > 15) return null; const hi = Math.max(a,b); const margin=Math.abs(a-b); if (hi < target || a === b || (hi === 15 && margin > 2) || (hi > target && hi < 15 && margin !== 2) || (hi === target && margin < 2)) return null; return a > b ? 'A' : 'B'; }
function evaluate(assignment, sets) {
  const final = assignment.matchType === 'final'; const max = final ? 3 : 2; const targets = final ? [10, 10, 7] : [10, 10]; let source = Array.isArray(sets) ? sets : [];
  while (source.length && source[source.length - 1]?.a === 0 && source[source.length - 1]?.b === 0) source = source.slice(0, -1);
  if (!source.length) bad('Score is required.');
  if (source.length > max) bad('Score contains too many sets.');
  let a = 0; let b = 0; let pointsForA = 0; let pointsForB = 0;
  for (let i=0; i<source.length; i++) { const s=source[i]; if (!s || !Number.isInteger(s.a) || !Number.isInteger(s.b)) bad('Score values must be integers.'); const w=setWinner(s.a, s.b, targets[i]); if (!w) bad('Score contains an incomplete or invalid set.'); pointsForA += s.a; pointsForB += s.b; if (w === 'A') a++; else b++; if (final && (a === 2 || b === 2) && i !== source.length - 1) bad('Sets after a final winner are not allowed.'); }
  if ((!final && source.length !== 2) || (final && (a !== 2 && b !== 2 || source.length !== (a === 2 || b === 2 ? (a + b === 2 ? 2 : 3) : 0)))) bad('Complete score required.');
  return { sets: source.map((s) => ({ a:s.a, b:s.b })), setsWonA:a, setsWonB:b, pointsForA, pointsForB, status:'done', result: final ? (a === 2 ? 'A' : 'B') : (a === b ? 'draw' : (a > b ? 'A' : 'B')), winner: final ? (a === 2 ? 'A' : 'B') : null };
}
async function courtState(tx, courtId) {
  const queueSnap = await tx.get(ref('courtQueues', courtId)); if (!queueSnap.exists) bad('Court queue not found.');
  const assignmentsSnap = await tx.get(root().collection('courtAssignments').where('courtId', '==', courtId)); const workflows = await Promise.all(assignmentsSnap.docs.map((doc) => tx.get(ref('scoreWorkflows', doc.id))));
  const assignments = Object.fromEntries(assignmentsSnap.docs.map((doc) => [doc.id, doc.data()])); const workflowMap = Object.fromEntries(workflows.map((doc) => [doc.id, doc.exists ? doc.data() : {}])); return { queue: queueSnap.data(), assignments, workflows: workflowMap };
}
function draftSets(value) {
  const sets = value?.sets;
  if (!Array.isArray(sets) || sets.length > 3 || sets.some((set) => !set || !Number.isInteger(set.a) || !Number.isInteger(set.b) || set.a < 0 || set.b < 0 || set.a > 15 || set.b > 15)) {
    throw new HttpsError('invalid-argument', 'Draft sets must be bounded integers.');
  }
  return { sets: sets.map(({ a, b }) => ({ a, b })) };
}
function operationRef(uid, operationId) { return ref('recorderOperations', `${uid}:${operationId}`); }
function touchRecorderGrant(tx, uid) {
  tx.update(ref('recorderGrants', uid), { lastUsedAt: FieldValue.serverTimestamp() });
}
function operationFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function unresolvedOfficial(assignment, official) {
  return assignment.dependencyReady === false || !official?.teamA || !official?.teamB;
}
export async function claimRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, recorderName, sessionId, queueRevision, takeover = false } = request.data || {};
  if (!uid || typeof matchKey !== 'string' || typeof courtId !== 'string' || typeof recorderName !== 'string' || !recorderName.trim() || typeof sessionId !== 'string' || sessionId.length < 16 || sessionId.length > 128) throw new HttpsError('invalid-argument', 'Match, court, recorder and session required.');
  const token = randomCode();
  return db().runTransaction(async (tx) => {
    await recorder(tx, request);
    const [assignmentSnap, workflowSnap, courtSnap, queueSnap] = await Promise.all([tx.get(ref('courtAssignments', matchKey)), tx.get(ref('scoreWorkflows', matchKey)), tx.get(ref('courts', courtId)), tx.get(ref('courtQueues', courtId))]);
    if (!assignmentSnap.exists || !workflowSnap.exists || !courtSnap.exists || !queueSnap.exists) throw new HttpsError('not-found', 'Recorder workflow not found.');
    const assignment = assignmentSnap.data(); const workflow = workflowSnap.data(); const queue = queueSnap.data();
    if (assignment.courtId !== courtId || queue.currentMatchKey !== matchKey || queue.queueRevision !== queueRevision) callableError('stale_queue', 'aborted');
    if (courtSnap.data().recorderName?.trim() !== recorderName.trim()) callableError('recorder_name_changed', 'aborted');
    assertResolved(assignment);
    const official = await tx.get(matchRef(assignment));
    if (!official.exists || unresolvedOfficial(assignment, official.data())) callableError('unresolved_teams');
    const lock = workflow.lock;
    if (lock && !isExpired(lock)) {
      if (lock.uid !== uid) callableError('ownership_lost', 'permission-denied');
      if (lock.sessionId !== sessionId && takeover !== true) callableError('ownership_lost', 'aborted');
    }
    if (!['idle', 'rejected', 'editing'].includes(workflow.draftState)) callableError('submitted', 'aborted');
    const nextLock = newLease(uid, token, recorderName.trim(), sessionId);
    const id = recorderAuditId('claim', uid, matchKey, token);
    const resumeDraftState = workflow.draftState === 'rejected'
      ? 'rejected'
      : workflow.draftState === 'editing' && ['idle', 'rejected'].includes(workflow.resumeDraftState)
        ? workflow.resumeDraftState
        : 'idle';
    touchRecorderGrant(tx, uid);
    tx.update(workflowSnap.ref, { draftState: 'editing', resumeDraftState, lock: nextLock, lastTransitionId: id });
    tx.update(assignmentSnap.ref, { publicStatus: 'in_progress', attemptCount: Math.max(1, assignment.attemptCount || 0), lastTransitionId: id });
    audit(tx, id, 'recorder_claim', matchKey, { uid, name: nextLock.recorderName, email: request.auth?.token?.email || null }, { lock: lock || null }, { lock: nextLock });
    return {
      token,
      sessionId,
      leaseExpiresAt: nextLock.expiresAt.toMillis(),
      transitionId: id,
      draftRevision: workflow.draftRevision || 0,
      draft: workflow.draft || { sets: [] },
    };
  });
}
export async function saveRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid; const {
    matchKey, token, sessionId, draft, queueRevision, expectedDraftRevision,
  } = request.data || {};
  if (!uid || typeof matchKey !== 'string' || typeof token !== 'string' || typeof sessionId !== 'string') throw new HttpsError('invalid-argument', 'Match ownership required.');
  if (!Number.isInteger(expectedDraftRevision) || expectedDraftRevision < 0) callableError('stale_revision', 'invalid-argument');
  const normalized = draftSets(draft);
  const eventNonce = crypto.randomUUID();
  return db().runTransaction(async (tx) => {
    await recorder(tx, request);
    const [assignmentSnap, workflowSnap] = await Promise.all([tx.get(ref('courtAssignments', matchKey)), tx.get(ref('scoreWorkflows', matchKey))]);
    if (!assignmentSnap.exists || !workflowSnap.exists) throw new HttpsError('not-found', 'Match workflow not found.');
    const assignment = assignmentSnap.data(); const workflow = workflowSnap.data(); const state = assignment.courtId ? await courtState(tx, assignment.courtId) : null;
    if (state && (state.queue.currentMatchKey !== matchKey || state.queue.queueRevision !== queueRevision)) callableError('stale_queue', 'aborted');
    if ((workflow.draftRevision || 0) !== expectedDraftRevision) callableError('stale_revision', 'aborted');
    assertResolved(assignment); validateLease(workflow, { uid, token, sessionId });
    const lock = renewLease(workflow.lock); const id = recorderAuditId('save', uid, matchKey, `${token}:${eventNonce}`);
    touchRecorderGrant(tx, uid);
    tx.update(workflowSnap.ref, {
      draft: normalized,
      draftRevision: (workflow.draftRevision || 0) + 1,
      lock,
      draftRetention: FieldValue.delete(),
      draftRetainedBy: FieldValue.delete(),
      draftRetainedAt: FieldValue.delete(),
      lastTransitionId: id,
    });
    audit(tx, id, 'draft_save', matchKey, { uid, name: lock.recorderName, email: request.auth?.token?.email || null }, { draft: workflow.draft || null, lock: workflow.lock }, { draft: normalized, lock });
    return { draftRevision: (workflow.draftRevision || 0) + 1, leaseExpiresAt: lock.expiresAt.toMillis(), transitionId: id };
  });
}
export async function renewRecorderLease(request) {
  requireMain(request.data);
  const uid = request.auth?.uid; const { matchKey, token, sessionId, queueRevision } = request.data || {};
  const eventNonce = crypto.randomUUID();
  return db().runTransaction(async (tx) => {
    await recorder(tx, request);
    const [assignmentSnap, workflowSnap] = await Promise.all([tx.get(ref('courtAssignments', matchKey)), tx.get(ref('scoreWorkflows', matchKey))]);
    if (!assignmentSnap.exists || !workflowSnap.exists) throw new HttpsError('not-found', 'Match workflow not found.');
    const assignment = assignmentSnap.data(); const workflow = workflowSnap.data(); const state = assignment.courtId ? await courtState(tx, assignment.courtId) : null;
    if (state && (state.queue.currentMatchKey !== matchKey || state.queue.queueRevision !== queueRevision)) callableError('stale_queue', 'aborted');
    const lock = renewLease(validateLease(workflow, { uid, token, sessionId })); const id = recorderAuditId('renew', uid, matchKey, `${token}:${eventNonce}`);
    touchRecorderGrant(tx, uid);
    tx.update(workflowSnap.ref, { lock, lastTransitionId: id }); audit(tx, id, 'lease_renewed', matchKey, { uid, name: lock.recorderName }, { lock: workflow.lock }, { lock });
    return { leaseExpiresAt: lock.expiresAt.toMillis(), transitionId: id };
  });
}
export async function reconcileRecorderCourtQueue(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const {
    courtId, staleMatchKey, recorderName, expectedQueueRevision,
  } = request.data || {};
  if (!uid || typeof courtId !== 'string' || !courtId
      || typeof staleMatchKey !== 'string' || !staleMatchKey
      || typeof recorderName !== 'string' || !recorderName.trim()
      || !Number.isInteger(expectedQueueRevision)) {
    throw new HttpsError('invalid-argument', 'Court, stale match, recorder and queue revision required.');
  }
  const eventNonce = crypto.randomUUID();
  return db().runTransaction(async (tx) => {
    await recorder(tx, request);
    const courtSnap = await tx.get(ref('courts', courtId));
    if (!courtSnap.exists || courtSnap.data().recorderName?.trim() !== recorderName.trim()) {
      callableError('recorder_name_changed', 'aborted');
    }
    const state = await courtState(tx, courtId);
    if (state.queue.queueRevision !== expectedQueueRevision
        || state.queue.currentMatchKey !== staleMatchKey) {
      callableError('stale_queue', 'aborted');
    }
    const assignment = state.assignments[staleMatchKey];
    const workflow = state.workflows[staleMatchKey];
    const terminal = assignment?.publicStatus === 'completed'
      || assignment?.publicStatus === 'under_review'
      || ['submitted', 'approved'].includes(workflow?.draftState);
    if (!assignment || !workflow || workflow.lock || !terminal) {
      throw new HttpsError('failed-precondition', 'Current match is still recordable.');
    }
    const nextQueue = projectCourtQueue({
      ...state.queue,
      queueRevision: expectedQueueRevision + 1,
    }, state.assignments, state.workflows);
    if (nextQueue.currentMatchKey === staleMatchKey) {
      throw new HttpsError('failed-precondition', 'Court queue could not advance.');
    }
    const id = recorderAuditId('queue_reconcile', uid, staleMatchKey, eventNonce);
    touchRecorderGrant(tx, uid);
    tx.update(ref('courtQueues', courtId), { ...nextQueue, lastTransitionId: id });
    audit(tx, id, 'recorder_queue_reconciled', staleMatchKey, {
      uid,
      name: recorderName.trim(),
      email: request.auth?.token?.email || null,
    }, { queue: state.queue }, { queue: nextQueue });
    return {
      transitionId: id,
      queueRevision: nextQueue.queueRevision,
      currentMatchKey: nextQueue.currentMatchKey || null,
      nextMatchKey: nextQueue.nextMatchKey || null,
    };
  });
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
export async function listRecorderGrants(request) {
  await admin(request, request.data);
  const [grants, config, tournament] = await Promise.all([
    root().collection('recorderGrants').get(),
    ref('recorderAccess', 'config').get(),
    root().get(),
  ]);
  const access = config.data();
  const globallyEnabled = tournament.data()?.maintenance?.enabled !== true
    && tournament.data()?.recorderFeatureEnabled === true
    && config.exists
    && access.enabled === true;
  return { grants: grants.docs.slice(0, 500).map((snap) => {
    const value = snap.data();
    const expiresAt = value.expiresAt?.toMillis?.() || null;
    const effectiveStatus = value.status === 'revoked'
      ? 'revoked'
      : expiresAt == null || expiresAt <= Date.now()
        ? 'expired'
        : !globallyEnabled
          ? 'disabled'
          : value.version !== access.version
            ? 'superseded'
            : 'active';
    return {
      uid: value.uid,
      version: value.version,
      status: value.status,
      effectiveStatus,
      issuedAt: value.issuedAt?.toMillis?.() || null,
      lastUsedAt: value.lastUsedAt?.toMillis?.() || null,
      expiresAt,
    };
  }) };
}
export async function revokeRecorderGrant(request) {
  const actor = await admin(request, request.data);
  const targetUid = request.data?.uid;
  const eventNonce = crypto.randomUUID();
  if (typeof targetUid !== 'string' || !targetUid || targetUid.length > 128) throw new HttpsError('invalid-argument', 'Grant uid required.');
  return db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const grant = await tx.get(ref('recorderGrants', targetUid));
    if (!grant.exists) throw new HttpsError('not-found', 'Recorder grant not found.');
    tx.update(grant.ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp() });
    const id = recorderAuditId('grant_revoke', actor, targetUid, `${grant.data().version}:${eventNonce}`);
    audit(tx, id, 'recorder_grant_revoked', null, { uid: actor }, { grant: { uid: targetUid, status: grant.data().status } }, { grant: { uid: targetUid, status: 'revoked' } });
    return { revoked: true, uid: targetUid };
  });
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
        reset: FieldValue.delete(),
      },
    }, { merge: true });
    tx.set(ref('resetState', 'current'), {
      ownerUid: uid, tokenHash: resetTokenHash(token), phase: 'prepared', preparedAt: FieldValue.serverTimestamp(),
    });
  });
  return { prepared: true, token, tournamentName };
}
export async function recoverTournamentReset(request) {
  const uid = await admin(request, request.data, { allowResetMaintenance: true });
  const token = crypto.randomBytes(32).toString('base64url');
  let phase;
  await db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    const resetSnap = await tx.get(ref('resetState', 'current'));
    const reset = resetSnap.data();
    const preparedAt = reset?.preparedAt?.toMillis?.() || 0;
    const recoveryReference = reset?.phase === 'deleting'
      ? reset?.deletionStartedAt?.toMillis?.() || 0
      : preparedAt;
    const stale = Date.now() - recoveryReference >= 15 * 60 * 1000;
    if (tournament.data()?.maintenance?.enabled !== true
        || !reset
        || (reset.phase === 'deleting' && !stale)
        || (reset.phase !== 'deleting' && reset.ownerUid !== uid && !stale)) {
      throw new HttpsError('failed-precondition', 'Active reset can only be recovered by its owner or after 15 minutes.');
    }
    phase = reset.phase;
    tx.update(resetSnap.ref, {
      ownerUid: uid,
      tokenHash: resetTokenHash(token),
      phase: 'prepared',
      executionFence: FieldValue.delete(),
      deletionStartedAt: FieldValue.delete(),
      recoveredAt: FieldValue.serverTimestamp(),
    });
  });
  return { recovered: true, phase, token };
}
async function resetOwner(request) {
  const uid = await admin(request, request.data, { allowResetMaintenance: true });
  const token = request.data?.token;
  if (typeof token !== 'string' || !token) throw new HttpsError('invalid-argument', 'Reset token required.');
  const [tournament, reset] = await Promise.all([root().get(), ref('resetState', 'current').get()]);
  if (tournament.data()?.maintenance?.enabled !== true
      || reset.data()?.ownerUid !== uid
      || reset.data()?.tokenHash !== resetTokenHash(token)) {
    throw new HttpsError('permission-denied', 'Current reset owner and token required.');
  }
  return { uid, token };
}
export async function cancelTournamentReset(request) {
  const { uid, token } = await resetOwner(request);
  await db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    const resetSnap = await tx.get(ref('resetState', 'current'));
    const reset = resetSnap.data();
    if (tournament.data()?.maintenance?.enabled !== true
        || reset?.ownerUid !== uid
        || reset?.tokenHash !== resetTokenHash(token)
        || reset?.phase !== 'prepared') {
      throw new HttpsError('permission-denied', 'Current reset owner and token required.');
    }
    tx.set(root(), { maintenance: { enabled: false } }, { merge: true });
    tx.delete(resetSnap.ref);
  });
  return { cancelled: true };
}
export async function resetTournament(request) {
  const { uid, token } = await resetOwner(request);
  const executionFence = crypto.randomUUID();
  await db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    const resetSnap = await tx.get(ref('resetState', 'current'));
    const reset = resetSnap.data();
    if (tournament.data()?.maintenance?.enabled !== true
        || reset?.ownerUid !== uid
        || reset?.tokenHash !== resetTokenHash(token)
        || reset?.phase !== 'prepared') {
      throw new HttpsError('permission-denied', 'Current reset owner and token required.');
    }
    tx.update(resetSnap.ref, {
      phase: 'deleting',
      executionFence,
      deletionStartedAt: FieldValue.serverTimestamp(),
    });
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const collections = await root().listCollections();
    const operational = collections.filter((subcollection) => !['admins', 'resetState'].includes(subcollection.id));
    await Promise.all(operational.map((subcollection) => db().recursiveDelete(subcollection)));
    const remaining = (await root().listCollections()).filter((subcollection) => !['admins', 'resetState'].includes(subcollection.id));
    if (!remaining.length) break;
    if (attempt === 2) throw new HttpsError('internal', 'Tournament data deletion did not complete.');
  }
  await db().runTransaction(async (tx) => {
    const [tournament, resetSnap] = await Promise.all([
      tx.get(root()),
      tx.get(ref('resetState', 'current')),
    ]);
    const reset = resetSnap.data();
    if (tournament.data()?.maintenance?.enabled !== true
        || reset?.ownerUid !== uid
        || reset?.tokenHash !== resetTokenHash(token)
        || reset?.phase !== 'deleting'
        || reset?.executionFence !== executionFence) {
      throw new HttpsError('aborted', 'Reset execution was superseded.');
    }
    tx.set(root(), {
      tournamentId: TOURNAMENT_ID,
      name: '',
      qualifyPerGroup: { men: 2, women: 2 },
      recorderFeatureEnabled: false,
      maintenance: { enabled: false },
      courtTopologyRevision: 0,
      venueDisplay: { mode: 'auto', intervalSeconds: 15 },
    });
    tx.delete(resetSnap.ref);
  });
  return { reset: true };
}
export async function exchangeRecorderAccessCode(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const code = request.data?.code;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(code)) callableError('code_invalid', 'permission-denied');
  const outcome = await db().runTransaction(async (tx) => {
    const [tournament, adminSnap, failures, existingGrant] = await Promise.all([
      tx.get(root()),
      tx.get(ref('admins', uid)),
      tx.get(ref('recorderFailures', uid)),
      tx.get(ref('recorderGrants', uid)),
    ]);
    const failure = failures.data();
    if (failure?.cooldownUntil?.toMillis?.() > Date.now()) return { error: 'code_rate_limited' };
    if (!hasGoogleProvider(request) && !adminSnap.exists) {
      throw new HttpsError('permission-denied', 'Google recorder sign-in required.');
    }
    if (tournament.data()?.maintenance?.enabled === true) {
      throw new HttpsError('failed-precondition', 'Tournament maintenance is active.');
    }
    const config = await tx.get(ref('recorderAccess', 'config'));
    const data = config.data();
    const suppliedHash = data ? hash(code, data.salt) : '';
    const validHash = Boolean(
      config.exists
      && data.enabled
      && suppliedHash.length === data.codeHash?.length
      && crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(data.codeHash)),
    );
    if (!validHash) {
      const startedAt = failure?.windowStartedAt?.toMillis?.() || 0;
      const withinWindow = Date.now() - startedAt < 15 * 60 * 1000;
      const attempts = withinWindow ? (failure?.attempts || 0) + 1 : 1;
      tx.set(ref('recorderFailures', uid), {
        uid, attempts, windowStartedAt: withinWindow ? failure.windowStartedAt : Timestamp.now(),
        cooldownUntil: attempts >= 5 ? Timestamp.fromMillis(Date.now() + 15 * 60 * 1000) : null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { error: 'code_invalid' };
    }
    const version = data.version;
    if (existingGrant.exists
        && existingGrant.data().status === 'revoked'
        && existingGrant.data().version === version) {
      return { error: 'grant_revoked' };
    }
    tx.set(ref('recorderGrants', uid), {
      uid,
      version,
      issuedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 12 * 60 * 60 * 1000),
      status: 'active',
    });
    tx.delete(ref('recorderFailures', uid));
    // 과거 버전은 코드 생성 시 이 플래그를 켜지 않았다. 유효한 현재 코드를
    // 증명한 경우 함께 복구해 기존 발급 코드도 다시 만들지 않고 사용할 수 있게 한다.
    tx.set(root(), { recorderFeatureEnabled: true }, { merge: true });
    return { tournamentId: TOURNAMENT_ID, grantVersion: version };
  });
  if (outcome.error === 'code_rate_limited') callableError('code_rate_limited', 'resource-exhausted');
  if (outcome.error === 'grant_revoked') callableError('grant_revoked', 'permission-denied');
  if (outcome.error) callableError('code_invalid', 'permission-denied');
  return outcome;
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
  if (Buffer.byteLength(JSON.stringify(request.data), 'utf8') > 512 * 1024) {
    bad('Court workflow payload is too large.');
  }
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
    for (const [matchKey, workflow] of existingWorkflows) {
      if (!workflow.lock) continue;
      const old = existingAssignments.get(matchKey);
      const next = desired.get(matchKey);
      const destination = next?.courtId && normalizedCourts.find((court) => court.id === next.courtId);
      if (!old || !destination || destination.recorderName !== workflow.lock.recorderName) {
        bad(`Live recorder lock must remain with ${workflow.lock.recorderName}.`);
      }
    }
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
    const transition = `server:court_workflows_replaced:${crypto.randomUUID()}`;
    const writePaths = new Set([
      root().path, ref('auditEvents', transition).path,
      ...normalizedCourts.map((court) => ref('courts', court.id).path),
      ...normalizedCourts.map((court) => ref('courtQueues', court.id).path),
      ...courtSnap.docs.filter((snap) => !courtIds.has(snap.id)).map((snap) => snap.ref.path),
      ...queueSnap.docs.map((snap) => snap.ref.path),
      ...queueSnap.docs.filter((snap) => !courtIds.has(snap.id)).map((snap) => snap.ref.path),
      ...[...existingAssignments.keys(), ...desired.keys()].flatMap((key) => [
        ref('courtAssignments', key).path, ref('scoreWorkflows', key).path,
      ]),
    ]);
    if (writePaths.size > 499) bad('Court workflow replacement exceeds transaction write limit.');
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
  const { tournamentId, division, expectedMatches, matches, scoreDrafts } = request.data || {};
  const required = ['tournamentId', 'division', 'expectedMatches', 'matches', 'scoreDrafts'];
  if (!request.data || typeof request.data !== 'object' || Array.isArray(request.data)
      || Object.keys(request.data).length !== required.length
      || required.some((key) => !Object.hasOwn(request.data, key))
      || tournamentId !== TOURNAMENT_ID || !['men', 'women'].includes(division)
      || !Array.isArray(expectedMatches) || !Array.isArray(matches) || !Array.isArray(scoreDrafts)) {
    throw new HttpsError('invalid-argument', 'Exact final publication payload required.');
  }
  if (matches.length > 31) bad('A final bracket may contain at most 31 matches.');
  const forbidden = new Set([
    'score', 'sets', 'result', 'winner', 'winnerSide', 'winnerTeam',
    'setsWonA', 'setsWonB', 'pointsForA', 'pointsForB', 'officialSnapshot',
    'officialRevision', 'lastTransitionId', 'attemptCount',
  ]);
  const structureFields = new Set([
    'id', 'round', 'roundLabel', 'index', 'teamA', 'teamB', 'teamASource', 'teamBSource',
    'status', 'byeCandidate', 'nextMatchId', 'nextSlot',
  ]);
  const ids = new Set();
  const staged = new Map();
  for (const draft of scoreDrafts) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)
        || Object.keys(draft).some((key) => !['matchId', 'sets', 'reason', 'expectedSubmissionVersion'].includes(key))
        || typeof draft.matchId !== 'string' || !draft.matchId || !Array.isArray(draft.sets)
        || typeof draft.reason !== 'string' || !Number.isInteger(draft.expectedSubmissionVersion)
        || draft.expectedSubmissionVersion < 0 || staged.has(draft.matchId)) {
      throw new HttpsError('invalid-argument', 'Score drafts must be unique matchId, sets and reason records.');
    }
    staged.set(draft.matchId, draft);
  }
  const byId = new Map();
  for (const input of matches) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || typeof input.id !== 'string' || !input.id || ids.has(input.id)
        || Object.keys(input).some((key) => forbidden.has(key) || !structureFields.has(key))) {
      throw new HttpsError('invalid-argument', 'Final matches must contain unique structure-only records.');
    }
    ids.add(input.id);
    byId.set(input.id, bounded(input));
  }
  for (const matchId of staged.keys()) if (!byId.has(matchId)) bad('Score draft references an unknown final match.');

  const isTeam = (team) => team === null || (team && typeof team === 'object'
    && !Array.isArray(team) && typeof team.id === 'string' && team.id);
  const isSource = (source) => source === null || (source && typeof source === 'object'
    && !Array.isArray(source) && ['fixedTeam', 'seed', 'groupRank', 'upstream'].includes(source.type));
  const ordered = [...byId.values()].sort((a, b) => a.round - b.round || a.index - b.index || a.id.localeCompare(b.id));
  const rounds = new Map();
  for (const match of ordered) {
    if (!Number.isInteger(match.round) || match.round < 1
        || !Number.isInteger(match.index) || match.index < 0
        || !isTeam(match.teamA ?? null) || !isTeam(match.teamB ?? null)
        || !isSource(match.teamASource ?? null) || !isSource(match.teamBSource ?? null)
        || !['empty', 'waiting', 'pending', 'bye_pending', 'bye'].includes(match.status)
        || (match.nextMatchId !== null && match.nextMatchId !== undefined
          && (typeof match.nextMatchId !== 'string' || !byId.has(match.nextMatchId)))
        || (match.nextMatchId && !['A', 'B'].includes(match.nextSlot))) {
      bad('Final match structure is invalid.');
    }
    if (!rounds.has(match.round)) rounds.set(match.round, []);
    rounds.get(match.round).push(match);
  }
  const maxRound = Math.max(0, ...rounds.keys());
  if (ordered.length && rounds.size !== maxRound) bad('Final rounds must be contiguous.');
  for (let round = 1; round <= maxRound; round += 1) {
    const items = rounds.get(round).sort((a, b) => a.index - b.index);
    if (items.some((item, index) => item.index !== index)
        || (round > 1 && items.length * 2 !== rounds.get(round - 1).length)
        || (round === maxRound && items.length !== 1)) bad('Final round layout is invalid.');
    for (const match of items) {
      const isRoot = round === 1;
      for (const side of ['A', 'B']) {
        const team = match[`team${side}`] ?? null;
        const source = match[`team${side}Source`] ?? null;
        if (!isRoot && (team || source)) bad('Derived final entrants cannot be supplied by the client.');
        if (isRoot && Boolean(team) !== Boolean(source)) bad('A final entrant requires its source.');
        if (source?.type === 'upstream') bad('Root final entrants cannot use an upstream source.');
      }
      if (isRoot) {
        const entrantCount = Number(Boolean(match.teamA)) + Number(Boolean(match.teamB));
        if ((match.status === 'empty' && entrantCount !== 0)
            || (['bye_pending', 'bye'].includes(match.status) && entrantCount !== 1)
            || (match.status === 'pending' && entrantCount !== 2)
            || (match.status === 'waiting' && entrantCount !== 0)) {
          bad('Final root status does not match its entrants.');
        }
      }
      if (round === maxRound) {
        if (match.nextMatchId || match.nextSlot) bad('Final championship match cannot have a downstream match.');
      } else {
        const next = byId.get(match.nextMatchId);
        if (!next || next.round !== round + 1 || next.index !== Math.floor(match.index / 2)
            || match.nextSlot !== (match.index % 2 === 0 ? 'A' : 'B')) bad('Final graph is invalid.');
      }
    }
  }
  const collectionRef = root().collection('divisions').doc(division).collection('finalMatches');
  return db().runTransaction(async (tx) => {
    const [tournamentSnap, existingSnap, assignmentSnap, workflowSnap, queueSnap, teamsSnap] = await Promise.all([
      assertTournamentWritable(tx), tx.get(collectionRef), tx.get(root().collection('courtAssignments')),
      tx.get(root().collection('scoreWorkflows')), tx.get(root().collection('courtQueues')),
      tx.get(root().collection('teams').where('division', '==', division)),
    ]);
    const expected = expectedMatches.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).length !== 3 || typeof item.id !== 'string' || !item.id
          || !Object.hasOwn(item, 'lastTransitionId') || !Number.isInteger(item.officialRevision)
          || item.officialRevision < 0 || (item.lastTransitionId !== null && typeof item.lastTransitionId !== 'string')) {
        bad('Expected final baseline is invalid.');
      }
      return item;
    });
    if (expected.some((item, index) => (index && expected[index - 1].id >= item.id))
        || expected.length !== existingSnap.size
        || expected.some((item) => {
          const snap = existingSnap.docs.find((doc) => doc.id === item.id);
          const current = snap?.data();
          return !snap || (current.lastTransitionId ?? null) !== item.lastTransitionId
            || (current.officialRevision ?? 0) !== item.officialRevision;
        })) throw new HttpsError('aborted', 'Final publication baseline changed.');
    const existing = new Map(existingSnap.docs.map((snap) => [snap.id, snap.data()]));
    const assignments = new Map(assignmentSnap.docs.map((snap) => [snap.id, snap.data()]));
    const workflows = new Map(workflowSnap.docs.map((snap) => [snap.id, snap.data()]));
    for (const match of ordered) {
      const old = existing.get(match.id);
      if (!old || (!(old.officialRevision > 0) && old.status !== 'bye')) continue;
      const fields = ['round', 'index', 'nextMatchId', 'nextSlot'];
      if (old.status === 'bye') fields.push('status');
      if (match.round === 1) fields.push('teamA', 'teamB', 'teamASource', 'teamBSource');
      if (fields.some((field) => JSON.stringify(old[field] ?? null) !== JSON.stringify(match[field] ?? null))) {
        bad(`Recorded final structure cannot change: ${match.id}.`);
      }
    }
    const divisionTeamDocs = new Map(teamsSnap.docs.map((snap) => [snap.id, snap]));
    const divisionTeams = new Set(divisionTeamDocs.keys());
    const canonicalEntrant = (entrant) => {
      if (!entrant) return null;
      const team = divisionTeamDocs.get(entrant.id);
      if (!team) bad('Final entrant is not a member of the selected division.');
      return { id: team.id, name: team.data().name || '' };
    };
    const rootTeams = new Set();
    for (const match of rounds.get(1) || []) {
      for (const side of ['A', 'B']) {
        const team = match[`team${side}`];
        if (!team) continue;
        if (!divisionTeams.has(team.id) || rootTeams.has(team.id)) bad('Final root teams must be unique members of the selected division.');
        rootTeams.add(team.id);
      }
    }
    const transition = `server:final_structure:${division}:${crypto.randomUUID()}`;
    const canonical = new Map();
    const scoreChanges = new Set();
    const winnerChangingScoreChanges = new Set();
    const finalCorrectionReasons = [];
    for (const match of ordered) {
      const old = existing.get(match.id);
      const teamA = match.round === 1 ? canonicalEntrant(match.teamA) : null;
      const teamB = match.round === 1 ? canonicalEntrant(match.teamB) : null;
      canonical.set(match.id, {
        ...match, teamA, teamB,
        teamASource: match.round === 1 ? (match.teamASource ?? null) : null,
        teamBSource: match.round === 1 ? (match.teamBSource ?? null) : null,
        status: match.round === 1
          ? (match.status === 'empty' || match.status === 'bye_pending' || match.status === 'bye'
            ? match.status : (teamA && teamB ? 'pending' : 'waiting'))
          : 'waiting',
        officialRevision: 0, lastTransitionId: transition,
      });
    }
    const descendants = new Map(ordered.map((match) => [match.id, []]));
    ordered.forEach((match) => { if (match.nextMatchId) descendants.get(match.nextMatchId).push(match.id); });
    for (const match of ordered) {
      const item = canonical.get(match.id);
      const old = existing.get(match.id);
      const draft = staged.get(match.id);
      const preserved = old?.officialRevision > 0 && !draft
        && JSON.stringify(old.teamA ?? null) === JSON.stringify(item.teamA)
        && JSON.stringify(old.teamB ?? null) === JSON.stringify(item.teamB);
      if (preserved) {
        Object.assign(item, ...['sets', 'setsWonA', 'setsWonB', 'pointsForA', 'pointsForB', 'result', 'winner', 'winnerSide', 'winnerTeam', 'status', 'officialRevision']
          .map((key) => ({ [key]: old[key] })));
      } else if (draft) {
        if (!item.teamA || !item.teamB) bad('A final score requires both derived entrants.');
        const evaluated = evaluate({ matchType: 'final' }, draft.sets);
        const changed = !old?.officialRevision || JSON.stringify(old.sets) !== JSON.stringify(evaluated.sets);
        if (old?.officialRevision && changed && !draft.reason.trim()) bad('A final score correction reason is required.');
        const revision = old?.officialRevision ? (old.officialRevision + (changed ? 1 : 0)) : 1;
        Object.assign(item, evaluated, {
          winnerSide: evaluated.winner,
          winnerTeam: evaluated.winner === 'A' ? item.teamA : item.teamB,
          officialRevision: revision,
          officialCurrent: true,
        });
        if (changed) {
          scoreChanges.add(match.id);
          if (old?.officialRevision && old.winner !== evaluated.winner) winnerChangingScoreChanges.add(match.id);
          if (old?.officialRevision) {
            finalCorrectionReasons.push({
              matchId: match.id,
              fromRevision: old.officialRevision,
              toRevision: revision,
              reason: boundedReason(draft.reason),
            });
          }
        }
      }
      if (item.status === 'bye') {
        if (item.teamA && item.teamB || !item.teamA && !item.teamB) bad('A confirmed BYE requires exactly one entrant.');
        item.winnerSide = item.teamA ? 'A' : (item.teamB ? 'B' : null);
        item.winnerTeam = item.teamA || item.teamB || null;
      }
      if ((item.officialRevision > 0 || item.status === 'bye') && item.nextMatchId) {
        const next = canonical.get(item.nextMatchId);
        const side = item.nextSlot;
        next[`team${side}`] = item.winnerTeam;
        next[`team${side}Source`] = { type: 'upstream', matchKey: finalAssignmentKey(division, item.id) };
        if (next.teamA && next.teamB && next.status === 'waiting') next.status = 'pending';
      }
    }
    for (const [id, old] of existing) {
      const item = canonical.get(id);
      if (!item || (!(old.officialRevision > 0) && old.status !== 'bye')) continue;
      if (['teamA', 'teamB', 'teamASource', 'teamBSource', 'round', 'index', 'nextMatchId', 'nextSlot']
        .some((field) => JSON.stringify(old[field] ?? null) !== JSON.stringify(item[field] ?? null))
        || (old.status === 'bye' && item.status !== 'bye')) {
        bad(`Recorded final participants cannot change: ${id}.`);
      }
    }
    for (const matchId of winnerChangingScoreChanges) {
      let cursor = byId.get(matchId)?.nextMatchId;
      while (cursor) {
        const key = finalAssignmentKey(division, cursor);
        const assignment = assignments.get(key); const workflow = workflows.get(key); const official = existing.get(cursor);
        if (assignment && (assignment.publicStatus === 'in_progress' || assignment.publicStatus === 'under_review'
            || ['replay_required', 'rework_required'].includes(assignment.publicStatus)
            || workflow?.draftState === 'editing' || workflow?.draftState === 'submitted'
            || workflow?.draftState === 'rejected' || workflow?.lock || hasFinalScoreHistory(official))) {
          bad('A score change conflicts with downstream final history.');
        }
        cursor = byId.get(cursor)?.nextMatchId;
      }
    }
    const desiredKeys = new Set([...canonical.values()].filter((match) => (
      match.teamA && match.teamB
      || assignments.has(finalAssignmentKey(division, match.id))
    )).map((match) => finalAssignmentKey(division, match.id)));
    for (const snap of existingSnap.docs) {
      if (!canonical.has(snap.id) && !finalMatchIsPristine(snap.data())) {
        bad(`Final match is not pristine: ${snap.id}.`);
      }
    }
    const obsolete = [];
    for (const [key, assignment] of assignments) {
      if (assignment.matchType !== 'final' || assignment.divisionId !== division || desiredKeys.has(key)) continue;
      const workflow = workflows.get(key);
      if (!workflow
          || assignment.publicStatus !== 'scheduled'
          || workflow.draftState !== 'idle'
          || workflow.resumeDraftState != null
          || !finalMatchIsPristine(assignment)
          || !finalMatchIsPristine(workflow)) {
        bad(`Final assignment is not pristine: ${key}.`);
      }
      obsolete.push(key);
    }
    for (const [key, workflow] of workflows) {
      if (key.startsWith(`final:${division}:`) && !assignments.has(key)) {
        bad(`Final workflow has no matching assignment: ${key}.`);
      }
    }
    for (const key of desiredKeys) {
      const assignment = assignments.get(key); const workflow = workflows.get(key);
      const matchId = key.slice(`final:${division}:`.length);
      const submittedPublish = workflow?.draftState === 'submitted'
        && staged.has(matchId)
        && workflow.submission?.version === workflow.submissionVersion
        && workflow.submissionVersion === staged.get(matchId).expectedSubmissionVersion
        && JSON.stringify(workflow.submittedSnapshot?.sets) === JSON.stringify(staged.get(matchId).sets);
      if (assignment && (!workflow || assignment.matchKey !== key || assignment.matchType !== 'final'
          || assignment.divisionId !== division || assignment.matchId !== key.slice(`final:${division}:`.length)
          || (['in_progress', 'under_review', 'replay_required', 'rework_required'].includes(assignment.publicStatus)
            && !submittedPublish)
          || ['editing', 'rejected'].includes(workflow.draftState) || (workflow.draftState === 'submitted' && !submittedPublish)
          || workflow.lock)) {
        bad(`Final assignment is not publishable: ${key}.`);
      }
    }
    const affectedCourts = new Set(obsolete.map((key) => assignments.get(key).courtId).filter(Boolean));
    for (const matchId of scoreChanges) {
      const assignment = assignments.get(finalAssignmentKey(division, matchId));
      if (assignment?.courtId) affectedCourts.add(assignment.courtId);
    }
    for (const [key, assignment] of assignments) {
      if (assignment.matchType !== 'final' || assignment.divisionId !== division || !assignment.courtId) continue;
      const match = canonical.get(assignment.matchId);
      const old = existing.get(assignment.matchId);
      if (match && ['teamA', 'teamB', 'status', 'officialRevision']
        .some((field) => JSON.stringify(match[field] ?? null) !== JSON.stringify(old?.[field] ?? null))) {
        affectedCourts.add(assignment.courtId);
      }
    }
    const writes = new Set([...canonical.keys()].map((id) => collectionRef.doc(id).path));
    for (const snap of existingSnap.docs) if (!canonical.has(snap.id)) writes.add(snap.ref.path);
    for (const key of obsolete) {
      writes.add(ref('courtAssignments', key).path);
      writes.add(ref('scoreWorkflows', key).path);
    }
    for (const key of desiredKeys) { writes.add(ref('courtAssignments', key).path); writes.add(ref('scoreWorkflows', key).path); }
    affectedCourts.forEach((courtId) => {
      writes.add(ref('courtQueues', courtId).path);
      assignmentSnap.docs
        .filter((snap) => snap.data().courtId === courtId && !obsolete.includes(snap.id))
        .forEach((snap) => writes.add(snap.ref.path));
    });
    writes.add(root().path); writes.add(ref('auditEvents', transition).path);
    if (writes.size > 499) bad('Final publication exceeds transaction write limit.');
    for (const match of canonical.values()) tx.set(collectionRef.doc(match.id), match);
    for (const snap of existingSnap.docs) if (!canonical.has(snap.id)) tx.delete(snap.ref);
    const postAssignments = new Map(assignments);
    const postWorkflows = new Map(workflows);
    for (const key of desiredKeys) {
      const match = canonical.get(key.slice(`final:${division}:`.length));
      const oldAssignment = assignments.get(key); const oldWorkflow = workflows.get(key);
      const revision = match.officialRevision || 0;
      const nextAssignment = {
        ...(oldAssignment || {}), matchKey: key, matchType: 'final', matchId: match.id, divisionId: division,
        division, courtId: oldAssignment?.courtId || null, courtOrder: oldAssignment?.courtOrder || null,
        nextCourtMatchKey: oldAssignment?.nextCourtMatchKey || null,
        nextMatchId: match.nextMatchId || null, nextSlot: match.nextSlot || null,
        dependencyReady: Boolean(match.teamA && match.teamB), publicStatus: revision ? 'completed' : 'scheduled',
        officialRevision: revision, lastTransitionId: transition,
      };
      const nextWorkflow = {
        ...(oldWorkflow || {}), matchKey: key, draftState: revision ? 'approved' : 'idle', lock: null,
        draftRevision: oldWorkflow?.draftRevision || 0, submissionVersion: oldWorkflow?.submissionVersion || 0,
        officialRevision: revision, officialSnapshot: revision ? canonical.get(match.id) : null, lastTransitionId: transition,
      };
      postAssignments.set(key, nextAssignment);
      postWorkflows.set(key, nextWorkflow);
      tx.set(ref('scoreWorkflows', key), nextWorkflow);
    }
    for (const key of obsolete) {
      postAssignments.delete(key); postWorkflows.delete(key);
      tx.delete(ref('courtAssignments', key)); tx.delete(ref('scoreWorkflows', key));
    }
    for (const courtId of affectedCourts) {
      const courtAssignments = Object.fromEntries([...postAssignments].filter(([, item]) => item.courtId === courtId)
        .map(([key, item]) => [key, { ...item, matchKey: key }]));
      const courtWorkflows = Object.fromEntries([...postWorkflows]);
      const planned = planCourtRemoval(courtAssignments, courtWorkflows, []);
      const list = Object.values(planned.assignments).sort((a, b) => (a.courtOrder || 0) - (b.courtOrder || 0));
      const normalized = Object.fromEntries(list.map((item, index) => [item.matchKey, {
        ...item, courtOrder: index + 1, nextCourtMatchKey: list[index + 1]?.matchKey || null, lastTransitionId: transition,
      }]));
      for (const item of Object.values(normalized)) {
        postAssignments.set(item.matchKey, item);
        if (!desiredKeys.has(item.matchKey)) tx.update(ref('courtAssignments', item.matchKey), {
          courtOrder: item.courtOrder, nextCourtMatchKey: item.nextCourtMatchKey, lastTransitionId: transition,
        });
      }
      const queue = queueSnap.docs.find((snap) => snap.id === courtId);
      if (!queue) bad(`Court queue not found: ${courtId}.`);
      const completed = new Set(Object.values(normalized)
        .filter((assignment) => assignment.publicStatus === 'completed').map((assignment) => assignment.matchKey));
      tx.set(queue.ref, projectCourtQueue({
        ...queue.data(),
        priorityEntries: (queue.data().priorityEntries || [])
          .filter((entry) => !completed.has(entry.matchKey))
          .map((entry) => (
            entry.eligibility === 'blocked_dependency' && normalized[entry.matchKey]?.dependencyReady === true
              ? { ...entry, eligibility: 'ready' }
              : entry
          )),
        queueRevision: (queue.data().queueRevision || 0) + 1,
        lastTransitionId: transition,
      }, normalized, planned.workflows));
    }
    for (const key of desiredKeys) tx.set(ref('courtAssignments', key), postAssignments.get(key));
    const topologyChanged = obsolete.length > 0 || [...desiredKeys].some((key) => !assignments.has(key));
    const topologyRevision = (tournamentSnap.data()?.courtTopologyRevision || 0) + (topologyChanged ? 1 : 0);
    if (topologyChanged) tx.set(root(), { courtTopologyRevision: topologyRevision }, { merge: true });
    audit(tx, transition, 'final_structure_published', division, uid, { expectedMatches: expected }, {
      matchIds: [...canonical.keys()], scoreRevisions: Object.fromEntries([...canonical].map(([id, match]) => [id, match.officialRevision || 0])),
      finalCorrectionReasons,
    });
    return { transitionId: transition, matches: [...canonical.values()], base: expected, scoreRevisions: Object.fromEntries([...canonical].map(([id, match]) => [id, match.officialRevision || 0])), counts: { matches: canonical.size, scores: [...canonical.values()].filter((match) => match.officialRevision > 0).length, createdPairs: [...desiredKeys].filter((key) => !assignments.has(key)).length, removedPairs: obsolete.length }, topologyRevision };
  });
}

function requireClearFinalStructurePayload(data) {
  const keys = ['tournamentId', 'division'];
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).length !== keys.length
      || keys.some((key) => !Object.hasOwn(data, key))
      || data.tournamentId !== TOURNAMENT_ID
      || !['men', 'women'].includes(data.division)) {
    throw new HttpsError('invalid-argument', 'Exact final structure clear payload required.');
  }
}

function hasRecordedFinalState(value) {
  if (!value || typeof value !== 'object') return false;
  for (const field of ['officialRevision', 'attemptCount', 'draftRevision', 'submissionVersion']) {
    if (value[field] !== undefined
        && (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 0)) return true;
  }
  return ['lock', 'draft', 'draftSnapshot', 'submittedSnapshot', 'officialSnapshot']
    .some((field) => value[field] != null)
    || ['score', 'result', 'winner', 'winnerSide', 'winnerTeam']
      .some((field) => value[field] != null)
    || value.teamASource?.type === 'upstream'
    || value.teamBSource?.type === 'upstream'
    || (Array.isArray(value.sets) && value.sets.length > 0)
    || ['setsWonA', 'setsWonB', 'pointsForA', 'pointsForB']
      .some((field) => value[field] != null);
}

function hasFinalScoreHistory(value) {
  if (!value || typeof value !== 'object') return false;
  return Number(value.officialRevision || 0) > 0
    || ['score', 'result', 'winner', 'winnerSide', 'winnerTeam', 'officialSnapshot']
      .some((field) => value[field] != null)
    || (Array.isArray(value.sets) && value.sets.length > 0)
    || ['setsWonA', 'setsWonB', 'pointsForA', 'pointsForB']
      .some((field) => value[field] != null);
}

function finalMatchIsPristine(match) {
  return !hasRecordedFinalState(match)
    && (match.status === undefined || ['pending', 'waiting', 'empty', 'bye_pending'].includes(match.status));
}

function queueReferences(queue, matchKeys) {
  return matchKeys.has(queue.currentMatchKey)
    || matchKeys.has(queue.nextMatchKey)
    || matchKeys.has(queue.normalCursorMatchKey)
    || (queue.priorityEntries || []).some((entry) => matchKeys.has(entry?.matchKey));
}

export async function clearFinalStructure(request) {
  const uid = await admin(request, request.data);
  requireClearFinalStructurePayload(request.data);
  const { division } = request.data;
  const finalMatchesRef = root().collection('divisions').doc(division).collection('finalMatches');
  return db().runTransaction(async (tx) => {
    const [tournamentSnap, finalMatchesSnap, assignmentsSnap, workflowsSnap, queuesSnap] = await Promise.all([
      assertTournamentWritable(tx),
      tx.get(finalMatchesRef),
      tx.get(root().collection('courtAssignments')),
      tx.get(root().collection('scoreWorkflows')),
      tx.get(root().collection('courtQueues')),
    ]);
    const finalMatches = new Map(finalMatchesSnap.docs.map((snap) => [snap.id, snap]));
    for (const snap of finalMatchesSnap.docs) {
      if (!finalMatchIsPristine(snap.data())) bad(`Final match is not pristine: ${snap.id}.`);
    }
    const targetMatchIds = new Set(finalMatches.keys());
    const expectedAssignmentKeys = new Set(
      [...targetMatchIds].map((matchId) => finalAssignmentKey(division, matchId)),
    );
    const targetAssignments = assignmentsSnap.docs.filter((snap) => {
      const assignment = snap.data();
      return assignment.matchType === 'final'
        && (assignment.divisionId === division
          || expectedAssignmentKeys.has(snap.id)
          || expectedAssignmentKeys.has(assignment.matchKey));
    });
    const targetAssignmentKeys = new Set(targetAssignments.map((snap) => snap.id));
    for (const snap of targetAssignments) {
      const assignment = snap.data();
      const matchId = assignment.matchId;
      if (assignment.divisionId !== division
          || typeof matchId !== 'string'
          || !finalMatches.has(matchId)
          || snap.id !== finalAssignmentKey(division, matchId)
          || assignment.matchKey !== snap.id) {
        bad(`Final assignment selector is inconsistent: ${snap.id}.`);
      }
      const workflowSnap = workflowsSnap.docs.find((workflow) => workflow.id === snap.id);
      if (!workflowSnap) bad(`Assignment has no workflow: ${snap.id}.`);
      const workflow = workflowSnap.data();
      if (assignment.publicStatus !== 'scheduled'
          || workflow.draftState !== 'idle'
          || workflow.resumeDraftState != null
          || hasRecordedFinalState(assignment)
          || hasRecordedFinalState(workflow)) {
        bad(`Final assignment workflow is not pristine: ${snap.id}.`);
      }
    }
    for (const workflowSnap of workflowsSnap.docs) {
      if (targetAssignmentKeys.has(workflowSnap.id)) continue;
      if (expectedAssignmentKeys.has(workflowSnap.id)
          || expectedAssignmentKeys.has(workflowSnap.data().matchKey)) {
        bad(`Final workflow has no matching assignment: ${workflowSnap.id}.`);
      }
    }
    const affectedCourtIds = new Set(targetAssignments.map((snap) => snap.data().courtId).filter(Boolean));
    const queues = new Map(queuesSnap.docs.map((snap) => [snap.id, snap.data()]));
    for (const courtId of affectedCourtIds) if (!queues.has(courtId)) bad(`Court queue not found: ${courtId}.`);
    for (const queueSnap of queuesSnap.docs) {
      if (queueReferences(queueSnap.data(), expectedAssignmentKeys) && !affectedCourtIds.has(queueSnap.id)) {
        bad(`Final queue ownership is inconsistent: ${queueSnap.id}.`);
      }
    }
    for (const courtId of affectedCourtIds) {
      for (const assignmentSnap of assignmentsSnap.docs.filter((snap) => snap.data().courtId === courtId)) {
        if (!targetAssignmentKeys.has(assignmentSnap.id)
            && !workflowsSnap.docs.some((workflow) => workflow.id === assignmentSnap.id)) {
          bad(`Court assignment has no workflow: ${assignmentSnap.id}.`);
        }
      }
    }

    const writes = new Set();
    const countWrite = (documentRef) => writes.add(documentRef.path);
    finalMatchesSnap.docs.forEach((snap) => countWrite(snap.ref));
    targetAssignments.forEach((snap) => {
      countWrite(snap.ref);
      countWrite(ref('scoreWorkflows', snap.id));
    });
    affectedCourtIds.forEach((courtId) => {
      countWrite(ref('courtQueues', courtId));
      assignmentsSnap.docs.filter((snap) => snap.data().courtId === courtId && !targetAssignmentKeys.has(snap.id))
        .forEach((snap) => countWrite(snap.ref));
    });
    countWrite(root());
    const id = `server:final_structure_cleared:${division}:${crypto.randomUUID()}`;
    countWrite(ref('auditEvents', id));
    if (writes.size > 499) bad('Final structure clear exceeds transaction write limit.');

    finalMatchesSnap.docs.forEach((snap) => tx.delete(snap.ref));
    targetAssignments.forEach((snap) => {
      tx.delete(snap.ref);
      tx.delete(ref('scoreWorkflows', snap.id));
    });
    for (const courtId of affectedCourtIds) {
      const courtAssignments = Object.fromEntries(assignmentsSnap.docs
        .filter((snap) => snap.data().courtId === courtId)
        .map((snap) => [snap.id, { ...snap.data(), matchKey: snap.id }]));
      const courtWorkflows = Object.fromEntries(workflowsSnap.docs
        .map((snap) => [snap.id, snap.data()]));
      const planned = planCourtRemoval(courtAssignments, courtWorkflows, targetAssignmentKeys);
      const ordered = Object.values(planned.assignments).sort((a, b) => (
        (a.courtOrder || 0) - (b.courtOrder || 0) || a.matchKey.localeCompare(b.matchKey)
      ));
      const normalizedAssignments = Object.fromEntries(ordered.map((assignment, index) => {
        const normalized = {
          ...assignment,
          courtOrder: index + 1,
          nextCourtMatchKey: ordered[index + 1]?.matchKey || null,
          lastTransitionId: id,
        };
        tx.update(ref('courtAssignments', assignment.matchKey), {
          courtOrder: normalized.courtOrder,
          nextCourtMatchKey: normalized.nextCourtMatchKey,
          lastTransitionId: id,
        });
        return [assignment.matchKey, normalized];
      }));
      tx.set(ref('courtQueues', courtId), projectCourtQueue({
        ...queues.get(courtId),
        queueRevision: (queues.get(courtId).queueRevision || 0) + 1,
        lastTransitionId: id,
      }, normalizedAssignments, planned.workflows));
    }
    const topologyRevision = (tournamentSnap.data()?.courtTopologyRevision || 0) + 1;
    tx.set(root(), { courtTopologyRevision: topologyRevision }, { merge: true });
    audit(tx, id, 'final_structure_cleared', division, uid, {
      finalMatchIds: [...targetMatchIds],
      assignmentKeys: [...targetAssignmentKeys],
    }, {
      removedFinalMatches: finalMatchesSnap.size,
      removedAssignments: targetAssignments.length,
      affectedCourts: [...affectedCourtIds],
      topologyRevision,
    });
    return {
      transitionId: id,
      topologyRevision,
      counts: {
        removedFinalMatches: finalMatchesSnap.size,
        removedAssignments: targetAssignments.length,
        removedWorkflows: targetAssignments.length,
        affectedCourts: affectedCourtIds.size,
      },
    };
  });
}

function requirePrelimStructurePayload(data) {
  const operation = data?.operation;
  const base = ['tournamentId', 'operation', 'division'];
  const required = {
    delete_group: [...base, 'groupId'],
    delete_team: [...base, 'teamId'],
    delete_all_groups: base,
    delete_all_teams: base,
    generate_group_round_robin: [...base, 'groupId', 'teamIds'],
    clear_group_prelim: [...base, 'groupId', 'ringOrder'],
    clear_division_prelim: base,
    generate_group_ring: [...base, 'groupId', 'ringOrder'],
  }[operation];
  if (!required || !data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).length !== required.length
      || required.some((key) => !Object.hasOwn(data, key))) {
    throw new HttpsError('invalid-argument', 'Exact preliminary structure payload required.');
  }
  if (!['men', 'women'].includes(data.division)) {
    throw new HttpsError('invalid-argument', 'Supported division required.');
  }
  if (required.includes('groupId') && (typeof data.groupId !== 'string' || !data.groupId)) {
    throw new HttpsError('invalid-argument', 'Group required.');
  }
  if (required.includes('teamId') && (typeof data.teamId !== 'string' || !data.teamId)) {
    throw new HttpsError('invalid-argument', 'Team required.');
  }
  if (operation === 'generate_group_round_robin' && !Array.isArray(data.teamIds)) {
    throw new HttpsError('invalid-argument', 'Team order required.');
  }
  if ((operation === 'generate_group_ring' || operation === 'clear_group_prelim')
      && !Array.isArray(data.ringOrder)) {
    throw new HttpsError('invalid-argument', 'Ring order required.');
  }
  return operation;
}

function prelimHasHistory(match) {
  return (match.officialRevision || 0) > 0
    || Boolean(match.result || match.winner || match.winnerTeam)
    || ['done', 'completed'].includes(match.status)
    || (Array.isArray(match.sets)
      && match.sets.some((set) => Number(set?.a) > 0 || Number(set?.b) > 0));
}

function workflowIsPristine(assignment, workflow) {
  const draft = workflow.draft;
  return assignment.publicStatus === 'scheduled'
    && !(assignment.attemptCount || assignment.officialRevision)
    && workflow.draftState === 'idle'
    && !workflow.lock
    && !(workflow.draftRevision || workflow.submissionVersion || workflow.officialRevision || workflow.attemptCount)
    && !workflow.submittedSnapshot
    && !workflow.officialSnapshot
    && (!draft || (Object.keys(draft).length === 1 && Array.isArray(draft.sets) && draft.sets.length === 0));
}

function officialPrelimIsPristine(match) {
  const sets = Array.isArray(match?.sets) ? match.sets : [];
  return Number(match?.officialRevision || 0) === 0
    && ['pending', 'scheduled'].includes(match?.status)
    && match?.result == null
    && match?.winner == null
    && match?.winnerTeam == null
    && ['setsWonA', 'setsWonB', 'pointsForA', 'pointsForB']
      .every((field) => match?.[field] == null || match[field] === 0)
    && sets.every((set) => Number(set?.a) === 0 && Number(set?.b) === 0);
}

function officialScoreMatches(snapshot, official, revision) {
  if (!snapshot || !official) return false;
  return snapshot.officialRevision === revision
    && snapshot.lastTransitionId === official.lastTransitionId
    && snapshot.status === 'done'
    && snapshot.result === official.result
    && snapshot.winner === official.winner
    && snapshot.setsWonA === official.setsWonA
    && snapshot.setsWonB === official.setsWonB
    && snapshot.pointsForA === official.pointsForA
    && snapshot.pointsForB === official.pointsForB
    && JSON.stringify(snapshot.sets) === JSON.stringify(official.sets);
}

function roundRobinPairs(teamIds) {
  let ids = [...teamIds];
  if (ids.length < 2) return [];
  if (ids.length % 2) ids.push(null);
  const rounds = ids.length - 1;
  const half = ids.length / 2;
  const pairs = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < half; index += 1) {
      const teamA = ids[index]; const teamB = ids[ids.length - 1 - index];
      // Mirror the browser schedule: every playable pairing has one dense,
      // stable display/queue order, rather than sharing a round number.
      if (teamA && teamB) pairs.push({ teamA, teamB, round: pairs.length + 1 });
    }
    ids = [ids[0], ...ids.slice(2), ids[1]];
  }
  return pairs;
}

function ringPairs(ringOrder) {
  if (ringOrder.length < 2) return [];
  if (ringOrder.length === 2) return [{ teamA: ringOrder[0], teamB: ringOrder[1], round: 1 }];
  return ringOrder.map((teamA, index) => ({
    teamA, teamB: ringOrder[(index + 1) % ringOrder.length], round: index + 1,
  }));
}

export async function mutatePrelimStructure(request) {
  const uid = await admin(request, request.data);
  const data = request.data;
  const operation = requirePrelimStructurePayload(data);
  return db().runTransaction(async (tx) => {
    const [tournamentSnap, groupsSnap, teamsSnap, prelimSnap, assignmentsSnap, workflowsSnap, queuesSnap, finalsSnap] = await Promise.all([
      assertTournamentWritable(tx),
      tx.get(root().collection('groups')),
      tx.get(root().collection('teams')),
      tx.get(root().collection('prelimMatches')),
      tx.get(root().collection('courtAssignments')),
      tx.get(root().collection('scoreWorkflows')),
      tx.get(root().collection('courtQueues')),
      tx.get(root().collection('divisions').doc(data.division).collection('finalMatches')),
    ]);
    if (finalsSnap.size) bad('Final structure exists for this division.');
    const groups = new Map(groupsSnap.docs.map((snap) => [snap.id, snap.data()]));
    const teams = new Map(teamsSnap.docs.map((snap) => [snap.id, snap.data()]));
    const group = data.groupId ? groups.get(data.groupId) : null;
    if (data.groupId && (!group || group.division !== data.division)) bad('Group does not belong to this division.');
    const team = data.teamId ? teams.get(data.teamId) : null;
    if (data.teamId && (!team || team.division !== data.division)) bad('Team does not belong to this division.');
    const divisionTeams = teamsSnap.docs.filter((snap) => snap.data().division === data.division);
    if (data.groupId && teamsSnap.docs.some((snap) => snap.data().groupId === data.groupId && snap.data().division !== data.division)) {
      bad('Group has a cross-division team membership.');
    }
    const groupTeams = data.groupId
      ? divisionTeams.filter((snap) => snap.data().groupId === data.groupId)
      : [];
    if (operation === 'generate_group_round_robin') {
      const expected = new Set(groupTeams.map((snap) => snap.id));
      if (data.teamIds.length !== expected.size
          || data.teamIds.some((id) => typeof id !== 'string' || !expected.delete(id))) {
        throw new HttpsError('invalid-argument', 'Team order must contain every group team exactly once.');
      }
    }
    if (operation === 'generate_group_ring') {
      const expected = new Set(groupTeams.map((snap) => snap.id));
      if (data.ringOrder.length !== expected.size || data.ringOrder.some((id) => typeof id !== 'string' || !expected.delete(id))) {
        throw new HttpsError('invalid-argument', 'Ring order must contain every group team exactly once.');
      }
    }
    if (operation === 'clear_group_prelim') {
      const validTeamIds = new Set(groupTeams.map((snap) => snap.id));
      const placedTeamIds = data.ringOrder.filter((id) => id != null);
      if ((data.ringOrder.length !== 0 && data.ringOrder.length !== groupTeams.length)
          || placedTeamIds.some((id) => typeof id !== 'string' || !validTeamIds.has(id))
          || new Set(placedTeamIds).size !== placedTeamIds.length) {
        throw new HttpsError('invalid-argument', 'Partial ring order contains an invalid or duplicate team.');
      }
    }
    const targetGroupIds = new Set(
      operation === 'delete_all_groups'
        ? groupsSnap.docs.filter((snap) => snap.data().division === data.division).map((snap) => snap.id)
        : data.groupId ? [data.groupId] : [],
    );
    const groupDependentMatches = targetGroupIds.size
      ? prelimSnap.docs.filter((snap) => targetGroupIds.has(snap.data().groupId))
      : [];
    if (groupDependentMatches.some((snap) => snap.data().division !== data.division)) {
      bad('Preliminary match division does not match its group.');
    }
    const matches = prelimSnap.docs.filter((snap) => snap.data().division === data.division);
    const deletedTeamIds = operation === 'delete_team' ? new Set([data.teamId])
      : operation === 'delete_all_teams'
        ? new Set(divisionTeams.map((snap) => snap.id))
        : new Set();
    if (operation === 'delete_team'
        && prelimSnap.docs.some((snap) => deletedTeamIds.has(snap.data().teamA) || deletedTeamIds.has(snap.data().teamB))) {
      bad('Team is referenced by a preliminary match.');
    }
    const removeMatches = operation === 'delete_group' || operation === 'generate_group_round_robin'
        || operation === 'generate_group_ring' || operation === 'clear_group_prelim'
      ? groupDependentMatches
      : operation === 'delete_all_groups'
        ? [...new Set([...matches, ...groupDependentMatches])]
        : ['delete_all_teams', 'clear_division_prelim'].includes(operation) ? matches : [];
    for (const snap of removeMatches) if (prelimHasHistory(snap.data())) bad(`Preliminary match has official history: ${snap.id}.`);
    const removedMatchIds = new Set(removeMatches.map((snap) => snap.id));
    const workflows = new Map(workflowsSnap.docs.map((snap) => [snap.id, snap.data()]));
    const affectedAssignments = assignmentsSnap.docs.filter((snap) => {
      const assignment = snap.data();
      return assignment.matchType === 'prelim'
        && (removedMatchIds.has(snap.id) || removedMatchIds.has(assignment.matchId));
    });
    const affectedAssignmentKeys = new Set(affectedAssignments.map((snap) => snap.id));
    for (const snap of affectedAssignments) {
      const assignment = snap.data(); const workflow = workflows.get(snap.id);
      if (!workflow) bad(`Assignment has no workflow: ${snap.id}.`);
      if (assignment.division && assignment.division !== data.division) bad(`Assignment division mismatch: ${snap.id}.`);
      if (!workflowIsPristine(assignment, workflow)) bad(`Assignment workflow is not pristine: ${snap.id}.`);
    }
    for (const matchId of removedMatchIds) {
      if (workflows.has(matchId) && !affectedAssignmentKeys.has(matchId)) {
        bad(`Workflow has no matching assignment: ${matchId}.`);
      }
    }
    const affectedCourtIds = new Set(affectedAssignments.map((snap) => snap.data().courtId).filter(Boolean));
    const queueByCourt = new Map(queuesSnap.docs.map((snap) => [snap.id, snap.data()]));
    for (const courtId of affectedCourtIds) if (!queueByCourt.has(courtId)) bad(`Court queue not found: ${courtId}.`);

    const created = operation === 'generate_group_round_robin'
      ? roundRobinPairs(data.teamIds)
      : operation === 'generate_group_ring' ? ringPairs(data.ringOrder) : [];
    const createdMatches = created.map((pair) => ({
      id: root().collection('prelimMatches').doc().id,
      ...pair,
    }));
    const writes = new Set();
    const countWrite = (documentRef) => writes.add(documentRef.path);
    removeMatches.forEach((snap) => countWrite(snap.ref));
    affectedAssignments.forEach((snap) => { countWrite(snap.ref); countWrite(ref('scoreWorkflows', snap.id)); });
    if (operation === 'delete_group') {
      countWrite(ref('groups', data.groupId));
      groupTeams.forEach((snap) => countWrite(snap.ref));
    } else if (operation === 'delete_all_groups') {
      groupsSnap.docs.filter((snap) => snap.data().division === data.division).forEach((snap) => countWrite(snap.ref));
      teamsSnap.docs.filter((snap) => snap.data().division === data.division && snap.data().groupId).forEach((snap) => countWrite(snap.ref));
    } else if (operation === 'delete_team') {
      countWrite(ref('teams', data.teamId));
      if (team.groupId && Array.isArray(groups.get(team.groupId)?.ringOrder)
          && groups.get(team.groupId).ringOrder.includes(data.teamId)) countWrite(ref('groups', team.groupId));
    } else if (operation === 'delete_all_teams') {
      teamsSnap.docs.filter((snap) => snap.data().division === data.division).forEach((snap) => countWrite(snap.ref));
      groupsSnap.docs.filter((snap) => snap.data().division === data.division && Array.isArray(snap.data().ringOrder)
        && snap.data().ringOrder.length).forEach((snap) => countWrite(snap.ref));
    }
    if (operation === 'generate_group_round_robin'
        || operation === 'generate_group_ring'
        || operation === 'clear_group_prelim') countWrite(ref('groups', data.groupId));
    if (operation === 'clear_division_prelim') groupsSnap.docs.filter((snap) => snap.data().division === data.division
      && Array.isArray(snap.data().ringOrder) && snap.data().ringOrder.length).forEach((snap) => countWrite(snap.ref));
    createdMatches.forEach((match) => countWrite(ref('prelimMatches', match.id)));
    createdMatches.forEach((match) => {
      countWrite(ref('courtAssignments', match.id));
      countWrite(ref('scoreWorkflows', match.id));
    });
    affectedCourtIds.forEach((courtId) => countWrite(ref('courtQueues', courtId)));
    affectedCourtIds.forEach((courtId) => assignmentsSnap.docs
      .filter((snap) => snap.data().courtId === courtId && !affectedAssignmentKeys.has(snap.id))
      .forEach((snap) => countWrite(snap.ref)));
    countWrite(root()); countWrite(ref('auditEvents', 'prelim_structure'));
    if (writes.size > 499) bad('Preliminary structure mutation exceeds transaction write limit.');

    const id = `server:prelim_structure:${crypto.randomUUID()}`;
    removeMatches.forEach((snap) => tx.delete(snap.ref));
    affectedAssignments.forEach((snap) => {
      tx.delete(snap.ref);
      tx.delete(ref('scoreWorkflows', snap.id));
    });
    if (operation === 'delete_group') {
      tx.delete(ref('groups', data.groupId));
      groupTeams.forEach((snap) => tx.update(snap.ref, { groupId: null }));
    } else if (operation === 'delete_all_groups') {
      groupsSnap.docs.filter((snap) => snap.data().division === data.division).forEach((snap) => tx.delete(snap.ref));
      teamsSnap.docs.filter((snap) => snap.data().division === data.division && snap.data().groupId).forEach((snap) => tx.update(snap.ref, { groupId: null }));
    } else if (operation === 'delete_team') {
      tx.delete(ref('teams', data.teamId));
      if (team.groupId && Array.isArray(groups.get(team.groupId)?.ringOrder)
          && groups.get(team.groupId).ringOrder.includes(data.teamId)) {
        tx.update(ref('groups', team.groupId), { ringOrder: groups.get(team.groupId).ringOrder.filter((id) => id !== data.teamId) });
      }
    } else if (operation === 'delete_all_teams') {
      teamsSnap.docs.filter((snap) => snap.data().division === data.division).forEach((snap) => tx.delete(snap.ref));
      groupsSnap.docs.filter((snap) => snap.data().division === data.division && Array.isArray(snap.data().ringOrder)
        && snap.data().ringOrder.length).forEach((snap) => tx.update(snap.ref, { ringOrder: [] }));
    }
    if (operation === 'generate_group_round_robin') tx.update(ref('groups', data.groupId), { matchMode: 'roundrobin', ringOrder: [] });
    if (operation === 'generate_group_ring') tx.update(ref('groups', data.groupId), { matchMode: 'ring', ringOrder: data.ringOrder });
    if (operation === 'clear_group_prelim') tx.update(ref('groups', data.groupId), { ringOrder: data.ringOrder });
    if (operation === 'clear_division_prelim') {
      groupsSnap.docs.filter((snap) => snap.data().division === data.division && Array.isArray(snap.data().ringOrder)
        && snap.data().ringOrder.length).forEach((snap) => tx.update(snap.ref, { ringOrder: [] }));
    }
    createdMatches.forEach((match) => tx.create(ref('prelimMatches', match.id), {
      groupId: data.groupId, division: data.division, teamA: match.teamA, teamB: match.teamB,
      round: match.round, sets: [], status: 'pending', result: null, officialRevision: 0, createdAt: Date.now(),
    }));
    // Generated prelims must be immediately usable by direct/admin scoring,
    // even before the planner assigns them to a court.
    createdMatches.forEach((match) => {
      tx.create(ref('courtAssignments', match.id), {
        matchKey: match.id, matchId: match.id, matchType: 'prelim', division: data.division,
        courtId: null, courtOrder: null, nextCourtMatchKey: null, dependencyReady: true,
        publicStatus: 'scheduled', attemptCount: 0, officialRevision: 0, lastTransitionId: id,
      });
      tx.create(ref('scoreWorkflows', match.id), {
        matchKey: match.id, draftState: 'idle', draftRevision: 0, submissionVersion: 0,
        officialRevision: 0, lock: null, lastTransitionId: id,
      });
    });
    for (const courtId of affectedCourtIds) {
      const courtAssignments = Object.fromEntries(assignmentsSnap.docs
        .filter((snap) => snap.data().courtId === courtId)
        .map((snap) => [snap.id, { ...snap.data(), matchKey: snap.id }]));
      const courtWorkflows = Object.fromEntries(workflowsSnap.docs.map((snap) => [snap.id, snap.data()]));
      const planned = planCourtRemoval(courtAssignments, courtWorkflows, affectedAssignmentKeys);
      const ordered = Object.values(planned.assignments).sort((a, b) => (a.courtOrder || 0) - (b.courtOrder || 0) || a.matchKey.localeCompare(b.matchKey));
      const normalizedAssignments = Object.fromEntries(ordered.map((assignment, index) => {
        const normalized = {
          ...assignment,
          courtOrder: index + 1,
          nextCourtMatchKey: ordered[index + 1]?.matchKey || null,
          lastTransitionId: id,
        };
        tx.update(ref('courtAssignments', assignment.matchKey), {
          courtOrder: normalized.courtOrder,
          nextCourtMatchKey: normalized.nextCourtMatchKey,
          lastTransitionId: normalized.lastTransitionId,
        });
        return [assignment.matchKey, normalized];
      }));
      const queue = projectCourtQueue({
        ...queueByCourt.get(courtId),
        queueRevision: (queueByCourt.get(courtId).queueRevision || 0) + 1,
        lastTransitionId: id,
      }, normalizedAssignments, planned.workflows);
      tx.set(ref('courtQueues', courtId), queue);
    }
    const topologyRevision = (tournamentSnap.data()?.courtTopologyRevision || 0) + 1;
    tx.set(root(), { courtTopologyRevision: topologyRevision }, { merge: true });
    audit(tx, id, 'prelim_structure_mutated', data.division, uid, {
      operation, removedMatchIds: [...removedMatchIds],
    }, {
      operation, removedMatchCount: removedMatchIds.size, createdMatchIds: createdMatches.map((match) => match.id),
      affectedCourts: [...affectedCourtIds], topologyRevision,
    });
    return {
      operation, transitionId: id, topologyRevision,
      counts: { removedMatches: removedMatchIds.size, removedAssignments: affectedAssignments.length, createdMatches: createdMatches.length, affectedCourts: affectedCourtIds.size },
      createdMatchIds: createdMatches.map((match) => match.id),
    };
  });
}

async function approve(request, direct = false) {
  const uid = await admin(request, request.data);
  const {
    matchKey, score, reason, expectedSubmissionVersion, expectedOfficialRevision, expectedQueueRevision,
  } = request.data;
  if (!matchKey) throw new HttpsError('invalid-argument', 'matchKey required.');
  return db().runTransaction(async (tx) => {
    await assertTournamentWritable(tx);
    const assignmentSnap = await tx.get(ref('courtAssignments', matchKey)); const workflowSnap = await tx.get(ref('scoreWorkflows', matchKey));
    if (!assignmentSnap.exists || !workflowSnap.exists) bad('Match workflow not found.');
    const assignment = assignmentSnap.data(); const workflow = workflowSnap.data();
    if (direct && assignment.matchType === 'final') {
      throw new HttpsError('failed-precondition', 'Final scores must be published through the final publication workflow.');
    }
    if (!direct && assignment.matchType === 'final') {
      throw new HttpsError('failed-precondition', 'Final scores must be published through the final publication workflow.');
    }
    if (!direct && (assignment.publicStatus !== 'under_review' || workflow.draftState !== 'submitted')) bad('Only submitted reviews can be approved.');
    if (!direct && (!Number.isInteger(expectedSubmissionVersion)
        || workflow.submissionVersion !== expectedSubmissionVersion
        || workflow.submission?.version !== workflow.submissionVersion
        || !workflow.submittedSnapshot)) {
      throw new HttpsError('aborted', 'Submission version changed.');
    }
    if (direct && (typeof reason !== 'string' || !reason.trim())) {
      throw new HttpsError('invalid-argument', 'A correction reason is required.');
    }
    const officialDocumentRef = matchRef(assignment);
    const officialSnap = await tx.get(officialDocumentRef);
    if (!officialSnap.exists) bad('Official match not found.');
    const officialMatch = officialSnap.data();
    let directQueue = null;
    if (direct) {
      const officialRevision = (value) => Number.isInteger(value) ? value : null;
      const revisionsMatch = Number.isInteger(expectedOfficialRevision)
        && officialRevision(officialMatch.officialRevision ?? 0) === expectedOfficialRevision
        && officialRevision(assignment.officialRevision ?? 0) === expectedOfficialRevision
        && officialRevision(workflow.officialRevision ?? 0) === expectedOfficialRevision;
      if (!revisionsMatch) throw new HttpsError('aborted', 'Official revision changed.');

      const pristine = expectedOfficialRevision === 0
        && workflowIsPristine(assignment, workflow)
        && officialPrelimIsPristine(officialMatch);
      const approved = assignment.publicStatus === 'completed'
        && workflow.draftState === 'approved'
        && !workflow.lock
        && expectedOfficialRevision > 0
        && assignment.lastTransitionId === workflow.lastTransitionId
        && workflow.lastTransitionId === officialMatch.lastTransitionId;
      if (approved) {
        const evaluatedOfficial = evaluate(assignment, officialMatch.sets);
        if (evaluatedOfficial.status !== officialMatch.status
            || evaluatedOfficial.result !== officialMatch.result
            || evaluatedOfficial.winner !== officialMatch.winner
            || evaluatedOfficial.setsWonA !== officialMatch.setsWonA
            || evaluatedOfficial.setsWonB !== officialMatch.setsWonB
            || evaluatedOfficial.pointsForA !== officialMatch.pointsForA
            || evaluatedOfficial.pointsForB !== officialMatch.pointsForB
            || JSON.stringify(evaluatedOfficial.sets) !== JSON.stringify(officialMatch.sets)
            || !officialScoreMatches(workflow.officialSnapshot, officialMatch, expectedOfficialRevision)) {
          bad('Approved preliminary score state is inconsistent.');
        }
      }
      if (!pristine && !approved) {
        bad('Direct preliminary scoring requires a pristine assignment or approved official score.');
      }
      if (pristine && assignment.courtId) {
        if (!Number.isInteger(expectedQueueRevision)) {
          throw new HttpsError('invalid-argument', 'Queue revision required for an assigned match.');
        }
        const state = await courtState(tx, assignment.courtId);
        if (state.queue.queueRevision !== expectedQueueRevision) {
          throw new HttpsError('aborted', 'Queue revision changed.');
        }
        directQueue = state;
      } else if (pristine && expectedQueueRevision != null) {
        throw new HttpsError('invalid-argument', 'Unassigned matches cannot include a queue revision.');
      }
    }
    const evaluated = evaluate(
      assignment,
      direct ? score?.sets : workflow.submittedSnapshot?.sets,
    );
    const revision = (workflow.officialRevision || 0) + 1;
    const id = transitionId(matchKey, direct ? 'admin_direct_edit' : 'review_approved', revision);
    const official = {
      ...evaluated,
      officialRevision: revision,
      officialCurrent: true,
      lastTransitionId: id,
    };
    const postAssignment = {
      ...assignment, publicStatus: 'completed', officialRevision: revision, lastTransitionId: id,
    };
    const postWorkflow = {
      ...workflow, draftState: 'approved', lock: null, officialRevision: revision,
      officialSnapshot: official, rejectionReason: FieldValue.delete(), lastTransitionId: id,
    };
    const queue = directQueue ? projectCourtQueue({
      ...directQueue.queue,
      priorityEntries: (directQueue.queue.priorityEntries || [])
        .filter((entry) => entry.matchKey !== matchKey),
      queueRevision: directQueue.queue.queueRevision + 1,
      lastTransitionId: id,
    }, {
      ...directQueue.assignments,
      [matchKey]: postAssignment,
    }, {
      ...directQueue.workflows,
      [matchKey]: postWorkflow,
    }) : null;
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
        lastTransitionId: id,
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
    if (queue) tx.update(ref('courtQueues', assignment.courtId), queue);
    tx.update(workflowSnap.ref, postWorkflow);
    tx.update(assignmentSnap.ref, postAssignment);
    audit(tx, id, direct ? 'admin_direct_edit' : 'review_approved', matchKey, uid, {
      assignment, workflow, queue: directQueue?.queue || null,
    }, {
      assignment: postAssignment,
      official,
      submission: { version: workflow.submissionVersion, metadata: workflow.submission || null },
      queue: directQueue ? { before: directQueue.queue, after: queue } : null,
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
    tx.update(ref('scoreWorkflows', matchKey), {
      draftState: 'rejected',
      lock: null,
      rejectionReason: boundedReason(reason),
      lastTransitionId: id,
    });
    if (state) tx.update(ref('courtQueues', assignment.courtId), { ...planned.queue, lastTransitionId: id });
    audit(tx, id, 'review_rejected', matchKey, uid, { assignment, workflow }, {
      assignment: planned.assignments[matchKey],
      workflow: {
        ...planned.workflows[matchKey],
        rejectionReason: boundedReason(reason),
        submission: workflow.submission || null,
      },
    }, boundedReason(reason));
    return { transitionId: id };
  });
}
export async function cancelRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, token, sessionId, queueRevision, operationId, discardDraft } = request.data || {};
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  if (!matchKey || !token) {
    throw new HttpsError('invalid-argument', 'matchKey and token are required.');
  }
  const opId = requireOperationId(operationId);
  if (typeof sessionId !== 'string' || typeof discardDraft !== 'boolean') throw new HttpsError('invalid-argument', 'sessionId and discardDraft required.');
  const fingerprint = operationFingerprint({ type: 'cancel', matchKey, courtId: courtId || null, discardDraft });
  return db().runTransaction(async (tx) => {
    const operation = operationRef(uid, opId);
    const prior = await tx.get(operation);
    if (prior.exists) {
      if (prior.data().fingerprint !== fingerprint) callableError('operation_mismatch', 'already-exists');
      return prior.data().result;
    }
    await recorder(tx, request);
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
        || workflow.lock?.uid !== uid) {
      throw new HttpsError('aborted', 'Stale recorder ownership or queue revision.');
    }
    validateLease(workflow, { uid, token, sessionId });
    const draftState = workflow.resumeDraftState === 'rejected' ? 'rejected' : 'idle';
    const publicStatus = draftState === 'rejected' ? 'replay_required' : 'scheduled';
    const id = recorderAuditId('cancel', uid, matchKey, token);
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
    const retainedDraft = discardDraft ? FieldValue.delete() : (workflow.draft || { sets: [] });
    touchRecorderGrant(tx, uid);
    tx.update(ref('scoreWorkflows', matchKey), {
      draftState,
      lock: null,
      draft: retainedDraft,
      draftRetention: discardDraft ? FieldValue.delete() : 'retained_after_cancel',
      draftRetainedBy: discardDraft ? FieldValue.delete() : { uid, name: workflow.lock?.recorderName || null },
      draftRetainedAt: discardDraft ? FieldValue.delete() : FieldValue.serverTimestamp(),
      lastTransitionId: id,
    });
    tx.update(ref('courtAssignments', matchKey), { publicStatus, lastTransitionId: id });
    if (state) tx.update(ref('courtQueues', assignment.courtId), { ...queue, lastTransitionId: id });
    audit(tx, id, 'recorder_cancel', matchKey, {
      uid,
      name: workflow.lock?.recorderName || null,
      email: request.auth?.token?.email || null,
    }, { workflow, queue: state?.queue || null }, { workflow: { ...workflow, draftState, lock: null }, queue });
    const result = { transitionId: id, queueRevision: queue?.queueRevision ?? null, discardedDraft: discardDraft };
    tx.create(operation, { uid, operationId: opId, type: 'cancel', fingerprint, result, createdAt: FieldValue.serverTimestamp() });
    return result;
  });
}

export async function resumeRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, recorderName, sessionId, queueRevision, takeover = false } = request.data || {};
  if (typeof matchKey !== 'string' || !matchKey || typeof courtId !== 'string' || !courtId
      || typeof recorderName !== 'string' || !recorderName.trim()
      || typeof sessionId !== 'string' || sessionId.length < 16 || sessionId.length > 128) {
    throw new HttpsError('invalid-argument', 'Match, court and recorder name required.');
}
  const normalizedRecorderName = recorderName.trim();
  const token = randomCode();
  let result;
  await db().runTransaction(async (tx) => {
    await recorder(tx, request);
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
    assertResolved(assignment);
    if (!isExpired(workflow.lock) && workflow.lock.sessionId !== sessionId && takeover !== true) callableError('ownership_lost', 'aborted');
    const nextLock = newLease(uid, token, normalizedRecorderName, sessionId);
    const id = recorderAuditId('resume', uid, matchKey, token);
    touchRecorderGrant(tx, uid);
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
    result = {
      token,
      sessionId,
      leaseExpiresAt: nextLock.expiresAt.toMillis(),
      transitionId: id,
      resumed: true,
      draftRevision: workflow.draftRevision || 0,
      draft: workflow.draft || { sets: [] },
    };
  });
  return result;
}

export async function submitRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, token, sessionId, queueRevision, score, operationId } = request.data || {};
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  if (!matchKey || !token) {
    throw new HttpsError('invalid-argument', 'matchKey and token are required.');
  }
  const opId = requireOperationId(operationId);
  if (typeof sessionId !== 'string') throw new HttpsError('invalid-argument', 'sessionId required.');
  const fingerprint = operationFingerprint({ type: 'submit', matchKey, courtId: courtId || null, score });
  return db().runTransaction(async (tx) => {
    const operation = operationRef(uid, opId);
    const prior = await tx.get(operation);
    if (prior.exists) {
      if (prior.data().fingerprint !== fingerprint) callableError('operation_mismatch', 'already-exists');
      return prior.data().result;
    }
    await recorder(tx, request);
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
        || workflow.lock?.uid !== uid) {
      throw new HttpsError('aborted', 'Stale recorder ownership or queue revision.');
    }
    validateLease(workflow, { uid, token, sessionId });
    assertResolved(assignment);
    const official = await tx.get(matchRef(assignment));
    if (!official.exists || unresolvedOfficial(assignment, official.data())) callableError('unresolved_teams');
    const evaluated = evaluate(assignment, score?.sets);
    const submittedSnapshot = { sets: evaluated.sets };
    const submissionVersion = (workflow.submissionVersion || 0) + 1;
    const submission = {
      version: submissionVersion,
      recorder: {
        uid,
        name: workflow.lock?.recorderName || request.auth?.token?.name || null,
      },
    };
    const id = recorderAuditId('submit', uid, matchKey, `${token}:${submissionVersion}`);
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
      submission,
      submittedAt: FieldValue.serverTimestamp(),
      rejectionReason: FieldValue.delete(),
      draftRetention: FieldValue.delete(),
      draftRetainedBy: FieldValue.delete(),
      draftRetainedAt: FieldValue.delete(),
      lastTransitionId: id,
    });
    tx.update(ref('courtAssignments', matchKey), { publicStatus: 'under_review', lastTransitionId: id });
    if (state) tx.update(ref('courtQueues', assignment.courtId), { ...queue, lastTransitionId: id });
    const submittedWorkflowAudit = {
      draft: submittedSnapshot,
      submittedSnapshot,
      draftState: 'submitted',
      lock: null,
      draftRevision: workflow.draftRevision || 0,
      submissionVersion,
      submission,
      officialRevision: workflow.officialRevision || 0,
      lastTransitionId: id,
    };
    touchRecorderGrant(tx, uid);
    audit(tx, id, 'submission_complete', matchKey, {
      uid,
      name: workflow.lock?.recorderName || request.auth?.token?.name || null,
      email: request.auth?.token?.email || null,
    }, { workflow, queue: state?.queue || null }, {
      workflow: submittedWorkflowAudit,
      queue,
    });
    const result = {
      transitionId: id,
      queueRevision: queue?.queueRevision ?? null,
      nextMatchKey: queue?.currentMatchKey ?? null,
    };
    tx.create(operation, { uid, operationId: opId, type: 'submit', fingerprint, result, createdAt: FieldValue.serverTimestamp() });
    return result;
  });
}
export async function forceReleaseWorkflow(request) {
  const uid = await admin(request, request.data);
  const { matchKey, reason, expectedLockToken, expectedQueueRevision } = request.data;
  if (typeof reason !== 'string' || !reason.trim() || typeof expectedLockToken !== 'string') {
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
  const targets = correctionTargets(request.data?.matchKeys);
  return db().runTransaction(async (tx) => {
    const plan = await correctionPreviewPlan(tx, targets);
    return {
      targets: targets.map((matchKey) => ({ matchKey, courtId: plan.courtId })),
      expectedQueueRevision: plan.planToken.expectedQueueRevision,
      planToken: plan.planToken,
      projection: plan.projection,
    };
  });
}
export async function applyApprovedCorrection(request) {
  const uid = await admin(request, request.data);
  const { reason, planToken } = request.data || {};
  const fields = ['tournamentId', 'planToken', 'reason'];
  const tokenFields = ['courtId', 'matchKeys', 'expectedQueueRevision', 'fingerprint'];
  if (!request.data || typeof request.data !== 'object' || Array.isArray(request.data)
      || Object.keys(request.data).length !== fields.length || fields.some((key) => !Object.hasOwn(request.data, key))
      || !planToken || typeof planToken !== 'object' || Array.isArray(planToken)
      || Object.keys(planToken).length !== tokenFields.length || tokenFields.some((key) => !Object.hasOwn(planToken, key))
      || typeof reason !== 'string' || !reason.trim()
      || !planToken || typeof planToken.courtId !== 'string'
      || !Number.isInteger(planToken.expectedQueueRevision)
      || typeof planToken.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(planToken.fingerprint)) {
    throw new HttpsError('invalid-argument', 'reason and a valid planToken are required.');
  }
  const targets = correctionTargets(planToken.matchKeys);
  if (planToken.matchKeys.length !== targets.length || planToken.matchKeys.some((key, index) => key !== targets[index])) {
    throw new HttpsError('invalid-argument', 'planToken matchKeys must be sorted and unique.');
  }
  return db().runTransaction(async (tx) => {
    let preview;
    try {
      preview = await correctionPreviewPlan(tx, targets);
    } catch (error) {
      if (error instanceof HttpsError && /maintenance/i.test(error.message)) throw error;
      throw new HttpsError('aborted', 'Correction plan changed.');
    }
    if (planToken.courtId !== preview.planToken.courtId
        || planToken.expectedQueueRevision !== preview.planToken.expectedQueueRevision
        || planToken.fingerprint !== preview.planToken.fingerprint) {
      throw new HttpsError('aborted', 'Correction plan changed.');
    }
    const id = `server:approved_correction:${crypto.randomUUID()}`;
    const plan = planCorrectionReplay(
      { ...preview.state.queue, queueRevision: (preview.state.queue.queueRevision || 0) + 1 },
      preview.state.assignments, preview.state.workflows, targets, id,
    );
    const retractedOfficials = [];
    const finalTargets = targets.map((key) => preview.state.assignments[key])
      .filter((assignment) => assignment.matchType === 'final');
    const invalidatedFinals = new Map();
    const invalidatedAssignments = new Map();
    const invalidatedWorkflows = new Map();
    const descendantStates = new Map([[
      preview.courtId,
      { queue: plan.queue, assignments: plan.assignments, workflows: plan.workflows },
    ]]);
    for (const divisionId of new Set(finalTargets.map((assignment) => assignment.divisionId))) {
      const matchesSnap = await tx.get(root().collection('divisions').doc(divisionId).collection('finalMatches'));
      const finals = new Map(matchesSnap.docs.map((snap) => [snap.id, { ref: snap.ref, ...snap.data() }]));
      const queue = finalTargets
        .filter((assignment) => assignment.divisionId === divisionId)
        .map((assignment) => assignment.matchId);
      const invalidated = new Set(queue);
      while (queue.length) {
        const matchId = queue.shift();
        const match = finals.get(matchId);
        if (!match) bad(`Final correction match not found: ${matchId}.`);
        if (match.nextMatchId && !invalidated.has(match.nextMatchId)) {
          const descendant = finals.get(match.nextMatchId);
          if (!descendant) bad(`Downstream final match not found: ${match.nextMatchId}.`);
          if (hasFinalScoreHistory(descendant)) {
            bad('A correction cannot invalidate downstream final history.');
          }
          invalidated.add(match.nextMatchId);
          queue.push(match.nextMatchId);
        }
      }
      for (const matchId of invalidated) {
        if (finalTargets.some((assignment) => assignment.divisionId === divisionId && assignment.matchId === matchId)) continue;
        const matchKey = finalAssignmentKey(divisionId, matchId);
        const [assignmentSnap, workflowSnap] = await Promise.all([
          tx.get(ref('courtAssignments', matchKey)),
          tx.get(ref('scoreWorkflows', matchKey)),
        ]);
        if (assignmentSnap.exists
            && (!workflowSnap.exists || !workflowIsPristine(assignmentSnap.data(), workflowSnap.data()))) {
          bad('A correction cannot invalidate downstream workflow history.');
        }
        if (assignmentSnap.exists) {
          invalidatedAssignments.set(matchKey, assignmentSnap.data());
          invalidatedWorkflows.set(matchKey, workflowSnap.data());
        }
      }
      invalidatedFinals.set(divisionId, { finals, invalidated });
    }
    const descendantCourtIds = new Set(
      [...invalidatedAssignments.values()].map((assignment) => assignment.courtId).filter(Boolean),
    );
    for (const courtId of descendantCourtIds) {
      if (!descendantStates.has(courtId)) descendantStates.set(courtId, await courtState(tx, courtId));
    }
    const correctionWrites = new Set([
      ref('courtQueues', preview.courtId).path,
      ref('auditEvents', id).path,
    ]);
    for (const key of targets) {
      correctionWrites.add(ref('courtAssignments', key).path);
      correctionWrites.add(ref('scoreWorkflows', key).path);
      correctionWrites.add(matchRef(preview.state.assignments[key]).path);
    }
    for (const [divisionId, { finals, invalidated }] of invalidatedFinals) {
      for (const matchId of invalidated) {
        const key = finalAssignmentKey(divisionId, matchId);
        correctionWrites.add(finals.get(matchId).ref.path);
        if (invalidatedAssignments.has(key)) {
          correctionWrites.add(ref('courtAssignments', key).path);
          correctionWrites.add(ref('scoreWorkflows', key).path);
          if (invalidatedAssignments.get(key).courtId) correctionWrites.add(ref('courtQueues', invalidatedAssignments.get(key).courtId).path);
        }
      }
    }
    if (correctionWrites.size + targets.length > 499) bad('Approved correction exceeds transaction write limit.');
    for (const key of targets) {
      const a = plan.assignments[key]; const w = plan.workflows[key];
      if (a !== preview.state.assignments[key]) tx.update(ref('courtAssignments', key), { publicStatus: a.publicStatus, lastTransitionId: id });
      if (w !== preview.state.workflows[key]) tx.update(ref('scoreWorkflows', key), { draftState: w.draftState, lock: w.lock, lastTransitionId: id });
      tx.update(matchRef(a), {
        sets: [], status: 'pending', result: null, winner: null, winnerSide: null, winnerTeam: null,
        setsWonA: null, setsWonB: null, pointsForA: null, pointsForB: null,
        officialCurrent: false, lastTransitionId: id,
      });
      retractedOfficials.push(key);
    }
    for (const [divisionId, { finals, invalidated }] of invalidatedFinals) {
      for (const matchId of invalidated) {
        const match = finals.get(matchId);
        const isTarget = finalTargets.some((assignment) => assignment.divisionId === divisionId && assignment.matchId === matchId);
        const update = { lastTransitionId: id, officialCurrent: false };
        for (const side of ['A', 'B']) {
          const source = match[`team${side}Source`];
          if (source?.type === 'upstream' && invalidated.has(source.matchKey?.replace(`final:${divisionId}:`, ''))) {
            update[`team${side}`] = null;
            update[`team${side}Source`] = null;
          }
        }
        const dependencyInvalidated = update.teamA === null || update.teamB === null;
        if (!dependencyInvalidated) {
          if (!isTarget) tx.update(match.ref, update);
          continue;
        }
        if (dependencyInvalidated) {
          update.status = 'waiting';
          update.sets = [];
          update.result = null;
          update.winner = null;
          update.winnerSide = null;
          update.winnerTeam = null;
          update.setsWonA = null;
          update.setsWonB = null;
          update.pointsForA = null;
          update.pointsForB = null;
        }
        tx.update(match.ref, update);
        const matchKey = finalAssignmentKey(divisionId, matchId);
        const assignment = invalidatedAssignments.get(matchKey) || preview.state.assignments[matchKey];
        const workflow = invalidatedWorkflows.get(matchKey) || preview.state.workflows[matchKey];
        if (!assignment) continue;
        const nextAssignment = {
          ...assignment,
          dependencyReady: false,
          publicStatus: 'replay_required',
          lastTransitionId: id,
        };
        const nextWorkflow = {
          ...workflow,
          draftState: 'rejected',
          lock: null,
          lastTransitionId: id,
        };
        tx.update(ref('courtAssignments', matchKey), {
          dependencyReady: false, publicStatus: 'replay_required', lastTransitionId: id,
        });
        tx.update(ref('scoreWorkflows', matchKey), {
          draftState: 'rejected', lock: null, lastTransitionId: id,
        });
        if (assignment.courtId) {
          const state = descendantStates.get(assignment.courtId);
          state.assignments[matchKey] = nextAssignment;
          state.workflows[matchKey] = nextWorkflow;
        }
      }
    }
    for (const [courtId, state] of descendantStates) {
      const priorityEntries = (state.queue.priorityEntries || []).map((entry) => {
        const assignment = state.assignments[entry.matchKey];
        if (assignment?.dependencyReady === false) return { ...entry, eligibility: 'blocked_dependency' };
        return entry.eligibility === 'blocked_dependency' ? { ...entry, eligibility: 'ready' } : entry;
      });
      for (const [matchKey, assignment] of Object.entries(state.assignments)) {
        if (assignment.publicStatus !== 'replay_required'
            || priorityEntries.some((entry) => entry.matchKey === matchKey)) continue;
        priorityEntries.push({
          entryId: `correction_replay:${matchKey}`,
          matchKey,
          kind: 'correction_replay',
          enqueueSequence: (state.queue.nextPrioritySequence || 0) + priorityEntries.length,
          pathDepth: 1,
          courtOrder: assignment.courtOrder || 0,
          eligibility: assignment.dependencyReady === false ? 'blocked_dependency' : 'ready',
          sourceTransitionIds: [id],
        });
      }
      tx.update(ref('courtQueues', courtId), projectCourtQueue({
        ...state.queue,
        priorityEntries,
        nextPrioritySequence: (state.queue.nextPrioritySequence || 0) + priorityEntries.length,
        queueRevision: courtId === preview.courtId
          ? state.queue.queueRevision
          : (state.queue.queueRevision || 0) + 1,
        lastTransitionId: id,
      }, state.assignments, state.workflows));
    }
    audit(tx, id, 'approved_correction', targets.join(','), uid, { targets }, {
      targets, queue: plan.queue, retractedOfficials,
    }, boundedReason(reason));
    return { transitionId: id };
  });
}

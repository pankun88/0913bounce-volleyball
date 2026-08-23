import crypto from 'node:crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  activateDependencyEntries, consumeCurrentAndAdvance, planCorrectionReplay,
  planRejectedRework, projectForceRelease, projectQueue, TOURNAMENT_ID,
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
async function admin(context, data) {
  requireMain(data);
  if (!context.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  if (!(await ref('admins', context.auth.uid).get()).exists) throw new HttpsError('permission-denied', 'Seeded administrator required.');
  return context.auth.uid;
}
function audit(tx, id, eventType, matchKey, uid, before, after, reason = eventType) {
  tx.create(ref('auditEvents', id), { transitionId: id, eventType, reason, matchKey, actor: { uid }, before: bounded(before), after: bounded(after), createdAt: FieldValue.serverTimestamp() });
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
    const config = await tx.get(ref('recorderAccess', 'config'));
    version = config.exists ? (config.data().version || 0) + 1 : 1;
    const data = { enabled:true, version, salt, codeHash:hash(code,salt), hashVersion:1, updatedBy:uid, updatedAt:FieldValue.serverTimestamp() };
    if (config.exists) tx.update(config.ref, data);
    else tx.create(ref('recorderAccess', 'config'), data);
    tx.set(ref('recorderAccessChallenge', 'current'), { enabled:true, version });
  });
  return { version, code };
}
export async function revokeRecorderAccessCode(request) { const uid=await admin(request,request.data); await db().runTransaction(async(tx)=>{const snap=await tx.get(ref('recorderAccess','config')); if(!snap.exists) bad('Access code does not exist.'); const version=(snap.data().version||0)+1; tx.update(snap.ref,{enabled:false,version,updatedBy:uid,updatedAt:FieldValue.serverTimestamp()}); tx.set(ref('recorderAccessChallenge','current'),{enabled:false,version});}); return {revoked:true}; }
export async function exchangeRecorderAccessCode(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const code = request.data?.code;
  if (typeof code !== 'string' || !code.trim()) {
    throw new HttpsError('invalid-argument', 'Code required.');
  }
  return db().runTransaction(async (tx) => {
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
    return { tournamentId: TOURNAMENT_ID, grantVersion: version };
  });
}
function startedWorkflow(workflow, assignment) {
  return Boolean(
    workflow?.lock
    || ['editing', 'submitted', 'rejected', 'approved'].includes(workflow?.draftState)
    || (workflow?.submissionVersion || 0) > 0
    || (workflow?.officialRevision || 0) > 0
    || (workflow?.attemptCount || 0) > 0
    || (assignment?.attemptCount || 0) > 0,
  );
}

export async function replaceCourtWorkflows(request) {
  const uid = await admin(request, request.data);
  const { courts, assignmentsByCourt } = request.data || {};
  if (!Array.isArray(courts) || !assignmentsByCourt || typeof assignmentsByCourt !== 'object' || Array.isArray(assignmentsByCourt)) {
    throw new HttpsError('invalid-argument', 'courts and assignmentsByCourt are required.');
  }
  const courtIds = new Set();
  const normalizedCourts = courts.map((court) => {
    if (!court?.id || typeof court.name !== 'string' || !court.name.trim() || courtIds.has(court.id)) bad('Every court needs a unique id and display name.');
    courtIds.add(court.id);
    return { id: String(court.id), name: court.name.trim() };
  });
  const desired = new Map();
  for (const [courtId, list] of Object.entries(assignmentsByCourt)) {
    if (!courtIds.has(courtId) || !Array.isArray(list)) bad('Assignments must belong to a registered court.');
    list.forEach((item, index) => {
      if (!item?.matchKey || desired.has(item.matchKey) || !['prelim', 'final'].includes(item.matchType)) bad('Duplicate or invalid match assignment.');
      if (item.matchType === 'prelim' && !item.division) bad('Prelim assignments require division.');
      if (item.matchType === 'final' && !item.divisionId) bad('Final assignments require divisionId.');
      desired.set(item.matchKey, {
        ...bounded(item),
        matchKey: item.matchKey,
        matchId: item.matchId || item.matchKey,
        courtId,
        courtOrder: index + 1,
        nextCourtMatchKey: list[index + 1]?.matchKey || null,
        publicStatus: item.publicStatus || 'scheduled',
        dependencyReady: item.dependencyReady !== false,
        attemptCount: item.attemptCount || 0,
      });
    });
  }
  await db().runTransaction(async (tx) => {
    const [assignmentSnap, workflowSnap, queueSnap, courtSnap] = await Promise.all([
      tx.get(root().collection('courtAssignments')),
      tx.get(root().collection('scoreWorkflows')),
      tx.get(root().collection('courtQueues')),
      tx.get(root().collection('courts')),
    ]);
    const existingAssignments = new Map(assignmentSnap.docs.map((snap) => [snap.id, snap.data()]));
    const existingWorkflows = new Map(workflowSnap.docs.map((snap) => [snap.id, snap.data()]));
    const hasStartedMatches = [...existingAssignments].some(([matchKey, assignment]) => (
      startedWorkflow(existingWorkflows.get(matchKey), assignment)
    ));
    if (hasStartedMatches) {
      const assignmentLayoutUnchanged = existingAssignments.size === desired.size
        && [...existingAssignments].every(([matchKey, assignment]) => {
          const next = desired.get(matchKey);
          return next
            && next.courtId === assignment.courtId
            && next.courtOrder === assignment.courtOrder
            && next.nextCourtMatchKey === (assignment.nextCourtMatchKey || null);
        });
      const existingCourtIds = new Set(courtSnap.docs.map((snap) => snap.id));
      const courtSetUnchanged = existingCourtIds.size === courtIds.size
        && [...existingCourtIds].every((courtId) => courtIds.has(courtId));
      if (!assignmentLayoutUnchanged || !courtSetUnchanged) {
        throw new HttpsError(
          'aborted',
          '대회가 시작된 뒤에는 코트 배정이나 경기 순서를 변경할 수 없습니다. 진행 전 설정에서만 변경하세요.',
        );
      }
      const transition = `court_names_updated:${crypto.randomUUID()}`;
      for (const court of normalizedCourts) tx.set(ref('courts', court.id), court, { merge: true });
      audit(tx, transition, 'court_names_updated', 'courts', uid, {
        courts: courtSnap.docs.map((snap) => ({ id: snap.id, name: snap.data().name || snap.id })),
      }, {
        courts: normalizedCourts,
      });
      return;
    }
    for (const [matchKey, item] of desired) {
      const official = await tx.get(matchRef(item));
      if (!official.exists) bad(`Official match not found: ${matchKey}.`);
      const officialData = official.data();
      const hasOfficialHistory = (officialData.officialRevision || 0) > 0
        || Boolean(officialData.result || officialData.winner || officialData.winnerTeam)
        || ['done', 'completed'].includes(officialData.status)
        || (Array.isArray(officialData.sets)
          && officialData.sets.some((set) => Number(set?.a) > 0 || Number(set?.b) > 0));
      if (!existingAssignments.has(matchKey) && hasOfficialHistory) {
        throw new HttpsError(
          'failed-precondition',
          '이미 결과가 기록된 경기는 새 기록관 대기열에 배정할 수 없습니다. 새 대진을 생성하거나 기존 결과를 초기화하세요.',
        );
    }
    }
    const transition = `court_workflows_replaced:${crypto.randomUUID()}`;
    for (const [matchKey, assignment] of existingAssignments) {
      if (desired.has(matchKey)) continue;
      tx.delete(ref('courtAssignments', matchKey));
      tx.delete(ref('scoreWorkflows', matchKey));
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
      if (!startedWorkflow(oldWorkflow, existingAssignments.get(matchKey))) {
        tx.set(ref('scoreWorkflows', matchKey), {
          draftState: 'idle', draftRevision: 0, submissionVersion: 0, officialRevision: 0, lock: null,
        });
      }
    }
    for (const court of normalizedCourts) {
      const entries = [...desired.values()].filter((item) => item.courtId === court.id).sort((a, b) => a.courtOrder - b.courtOrder);
      const previous = queueSnap.docs.find((snap) => snap.id === court.id)?.data();
      tx.set(ref('courtQueues', court.id), {
        courtId: court.id,
        currentMatchKey: entries[0]?.matchKey || null,
        nextMatchKey: entries[1]?.matchKey || null,
        normalCursorMatchKey: entries[0]?.matchKey || null,
        priorityEntries: [],
        nextPrioritySequence: 0,
        queueRevision: (previous?.queueRevision || 0) + 1,
        lastTransitionId: transition,
      });
    }
    audit(tx, transition, 'court_workflows_replaced', 'courts', uid, {
      courts: courtSnap.docs.map((snap) => snap.id),
      matchKeys: assignmentSnap.docs.map((snap) => snap.id),
    }, {
      courts: normalizedCourts.map((court) => court.id),
      assignmentsByCourt: Object.fromEntries(normalizedCourts.map((court) => [court.id, [...desired.values()].filter((item) => item.courtId === court.id).map((item) => item.matchKey)])),
    });
  });
  return { replaced: true };
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
          const downstreamState = await courtState(tx, downstreamAssignment.courtId);
          const assignments = {
            ...downstreamState.assignments,
            [nextMatchKey]: { ...downstreamAssignment, dependencyReady: true },
          };
          const queue = activateDependencyEntries(
            {
              ...downstreamState.queue,
              queueRevision: (downstreamState.queue.queueRevision || 0) + 1,
            },
            assignments,
            downstreamState.workflows,
            [nextMatchKey],
          );
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
      tx.update(ref('courtQueues', dependencyActivation.courtId), {
        ...dependencyActivation.queue,
        lastTransitionId: id,
      });
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
  if (typeof reason !== 'string' || !reason.trim() || !Number.isInteger(expectedSubmissionVersion) || !Number.isInteger(expectedQueueRevision)) {
    throw new HttpsError('invalid-argument', 'Reason and expected revisions are required.');
  }
  return db().runTransaction(async (tx) => {
    const assignmentSnap = await tx.get(ref('courtAssignments', matchKey)); if (!assignmentSnap.exists) bad('Match not found.');
    const assignment = assignmentSnap.data(); const state = await courtState(tx, assignment.courtId); const workflow = state.workflows[matchKey];
    if (workflow.submissionVersion !== expectedSubmissionVersion || state.queue.queueRevision !== expectedQueueRevision) {
      throw new HttpsError('aborted', 'Submission or queue revision changed.');
    }
    const id = transitionId(matchKey, 'review_rejected', workflow.submissionVersion || 0);
    const planned = planRejectedRework(
      { ...state.queue, queueRevision: (state.queue.queueRevision || 0) + 1 },
      state.assignments,
      state.workflows,
      matchKey,
      id,
    );
    tx.update(assignmentSnap.ref, { publicStatus: planned.assignments[matchKey].publicStatus, lastTransitionId: id });
    tx.update(ref('scoreWorkflows', matchKey), { draftState: 'rejected', lock: null, lastTransitionId: id });
    tx.update(ref('courtQueues', assignment.courtId), { ...planned.queue, lastTransitionId: id });
    audit(tx, id, 'review_rejected', matchKey, uid, { assignment, workflow }, { assignment: planned.assignments[matchKey], workflow: planned.workflows[matchKey] }, reason.trim());
    return { transitionId: id };
  });
}
export async function cancelRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, token, queueRevision } = request.data || {};
  if (!matchKey || !courtId || !token || !Number.isInteger(queueRevision)) {
    throw new HttpsError('invalid-argument', 'matchKey, courtId, token and queueRevision are required.');
  }
  return db().runTransaction(async (tx) => {
    await recorder(tx, uid);
    const state = await courtState(tx, courtId);
    const assignment = state.assignments[matchKey];
    const workflow = state.workflows[matchKey];
    if (!assignment || !workflow || assignment.courtId !== courtId
        || state.queue.queueRevision !== queueRevision
        || state.queue.currentMatchKey !== matchKey
        || workflow.draftState !== 'editing'
        || workflow.lock?.uid !== uid
        || workflow.lock?.token !== token) {
      throw new HttpsError('aborted', 'Stale recorder ownership or queue revision.');
    }
    const draftState = workflow.resumeDraftState === 'rejected' ? 'rejected' : 'idle';
    const publicStatus = draftState === 'rejected' ? 'replay_required' : 'scheduled';
    const id = transitionId(matchKey, 'recorder_cancel', `${queueRevision}:${token}`);
    const assignments = { ...state.assignments, [matchKey]: { ...assignment, publicStatus } };
    const queue = projectForceRelease(
      { ...state.queue, queueRevision: queueRevision + 1 },
      assignments,
      state.workflows,
      matchKey,
      { draftState },
    );
    tx.update(ref('scoreWorkflows', matchKey), { draftState, lock: null, lastTransitionId: id });
    tx.update(ref('courtAssignments', matchKey), { publicStatus, lastTransitionId: id });
    tx.update(ref('courtQueues', courtId), { ...queue, lastTransitionId: id });
    audit(tx, id, 'recorder_cancel', matchKey, uid, { workflow, queue: state.queue }, { workflow: { ...workflow, draftState, lock: null }, queue });
    return { transitionId: id, queueRevision: queue.queueRevision };
  });
}

export async function submitRecorderDraft(request) {
  requireMain(request.data);
  const uid = request.auth?.uid;
  const { matchKey, courtId, token, queueRevision, score } = request.data || {};
  if (!matchKey || !courtId || !token || !Number.isInteger(queueRevision)) {
    throw new HttpsError('invalid-argument', 'matchKey, courtId, token and queueRevision are required.');
  }
  return db().runTransaction(async (tx) => {
    await recorder(tx, uid);
    const state = await courtState(tx, courtId);
    const assignment = state.assignments[matchKey];
    const workflow = state.workflows[matchKey];
    if (!assignment || !workflow || assignment.courtId !== courtId
        || state.queue.queueRevision !== queueRevision
        || state.queue.currentMatchKey !== matchKey
        || workflow.draftState !== 'editing'
        || workflow.lock?.uid !== uid
        || workflow.lock?.token !== token) {
      throw new HttpsError('aborted', 'Stale recorder ownership or queue revision.');
    }
    const evaluated = evaluate(assignment, score?.sets);
    const submittedSnapshot = { sets: evaluated.sets };
    const submissionVersion = (workflow.submissionVersion || 0) + 1;
    const id = transitionId(matchKey, 'submission_complete', submissionVersion);
    const assignments = { ...state.assignments, [matchKey]: { ...assignment, publicStatus: 'under_review' } };
    const workflows = { ...state.workflows, [matchKey]: { ...workflow, draftState: 'submitted', lock: null } };
    const queue = consumeCurrentAndAdvance(
      state.queue,
      assignments,
      workflows,
      matchKey,
    );
    tx.update(ref('scoreWorkflows', matchKey), {
      draft: submittedSnapshot,
      submittedSnapshot,
      draftState: 'submitted',
      lock: null,
      submissionVersion,
      lastTransitionId: id,
    });
    tx.update(ref('courtAssignments', matchKey), { publicStatus: 'under_review', lastTransitionId: id });
    tx.update(ref('courtQueues', courtId), { ...queue, lastTransitionId: id });
    audit(tx, id, 'submission_complete', matchKey, uid, { workflow, queue: state.queue }, { workflow: { ...workflow, draftState: 'submitted', lock: null, submissionVersion }, queue });
    return { transitionId: id, queueRevision: queue.queueRevision, nextMatchKey: queue.currentMatchKey };
  });
}
export async function forceReleaseWorkflow(request) {
  const uid = await admin(request, request.data);
  const { matchKey, reason, expectedLockToken, expectedQueueRevision } = request.data;
  if (typeof reason !== 'string' || !reason.trim() || !expectedLockToken || !Number.isInteger(expectedQueueRevision)) {
    throw new HttpsError('invalid-argument', 'A release reason, lock token and queue revision are required.');
  }
  return db().runTransaction(async (tx) => {
    const assignmentSnap = await tx.get(ref('courtAssignments', matchKey)); const workflowSnap = await tx.get(ref('scoreWorkflows', matchKey));
    if (!assignmentSnap.exists || !workflowSnap.exists) bad('Match not found.');
    const assignment = assignmentSnap.data(); const workflow = workflowSnap.data(); if (!workflow.lock) bad('No active lock to release.');
    const state = await courtState(tx, assignment.courtId);
    const releaseId = `${transitionId(matchKey, 'force_release', workflow.draftRevision || 0)}:${crypto.createHash('sha256').update(expectedLockToken).digest('hex').slice(0, 12)}`;
    if (workflow.lock.token !== expectedLockToken || state.queue.queueRevision !== expectedQueueRevision) {
      throw new HttpsError('aborted', 'Lock owner or queue revision changed.');
    }
    const returnState = { draftState: workflow.resumeDraftState === 'rejected' ? 'rejected' : 'idle' };
    const publicStatus = returnState.draftState === 'rejected' ? 'replay_required' : 'scheduled';
    const postAssignments = { ...state.assignments, [matchKey]: { ...assignment, publicStatus } };
    const queue = projectForceRelease(
      { ...state.queue, queueRevision: (state.queue.queueRevision || 0) + 1 },
      postAssignments,
      state.workflows,
      matchKey,
      returnState,
    );
    tx.update(workflowSnap.ref, { ...returnState, lock: null, lastTransitionId: releaseId });
    tx.update(assignmentSnap.ref, { publicStatus, lastTransitionId: releaseId });
    tx.update(ref('courtQueues', assignment.courtId), { ...queue, lastTransitionId: releaseId });
    audit(tx, releaseId, 'force_release', matchKey, uid, { lock: workflow.lock }, { lock: null }, reason.trim()); return { transitionId: releaseId };
  });
}
export async function previewApprovedCorrection(request) {
  await admin(request, request.data); const targets = [...new Set(request.data?.matchKeys || [])]; if (!targets.length) throw new HttpsError('invalid-argument', 'matchKeys required.');
  const assignments = await Promise.all(targets.map((key) => ref('courtAssignments', key).get())); if (assignments.some((snap) => !snap.exists)) bad('Unknown correction target.');
  return { targets: assignments.map((snap) => ({ matchKey: snap.id, courtId: snap.data().courtId })) };
}
export async function applyApprovedCorrection(request) {
  const uid = await admin(request, request.data);
  const targets = [...new Set(request.data?.matchKeys || [])];
  const { reason, expectedQueueRevision } = request.data || {};
  if (!targets.length || typeof reason !== 'string' || !reason.trim() || !Number.isInteger(expectedQueueRevision)) {
    throw new HttpsError('invalid-argument', 'matchKeys, reason and expectedQueueRevision are required.');
  }
  return db().runTransaction(async (tx) => {
    const first = await tx.get(ref('courtAssignments', targets[0])); if (!first.exists) bad('Unknown correction target.'); const courtId = first.data().courtId;
    const state = await courtState(tx, courtId); if (targets.some((key) => !state.assignments[key] || state.assignments[key].courtId !== courtId)) bad('Correction targets must share one court.');
    if (state.queue.queueRevision !== expectedQueueRevision) throw new HttpsError('aborted', 'Queue revision changed.');
    const id = transitionId(targets.join(','), 'approved_correction', state.queue.queueRevision || 0); const plan = planCorrectionReplay({ ...state.queue, queueRevision: (state.queue.queueRevision || 0) + 1 }, state.assignments, state.workflows, targets, id);
    for (const key of targets) { const a = plan.assignments[key]; const w = plan.workflows[key]; if (a !== state.assignments[key]) tx.update(ref('courtAssignments', key), { publicStatus: a.publicStatus, lastTransitionId: id }); if (w !== state.workflows[key]) tx.update(ref('scoreWorkflows', key), { draftState: w.draftState, lock: w.lock, lastTransitionId: id }); }
    tx.update(ref('courtQueues', courtId), { ...plan.queue, lastTransitionId: id }); audit(tx, id, 'approved_correction', targets.join(','), uid, { targets }, { targets, queue: plan.queue }, reason.trim()); return { transitionId: id };
  });
}

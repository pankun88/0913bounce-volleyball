import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { createFixture, PROJECT_ID, path } from './fixtures.mjs';
import { activateDependencyEntries, consumeCurrentAndAdvance, insertPriorityEntry, planCorrectionReplay, planRejectedRework, projectForceRelease, selectQueueView } from '../../functions/workflow-core.js';

const host = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const [functionsHost, functionsPort] = host.split(':');
const score = [{ a: 10, b: 8 }, { a: 10, b: 7 }];
const call = (functions, name, data) => httpsCallable(functions, name)(data).then((result) => result.data);

export async function runFunctionsSuite() {
  const f = await createFixture();
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'emulator-only', appId: `emulator-${Date.now()}` }, `emulator-${Date.now()}`);
  try {
    const auth = getAuth(app); connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`, { disableWarnings: true });
    const credential = await signInAnonymously(auth);
    const functions = getFunctions(app, 'asia-northeast3'); connectFunctionsEmulator(functions, functionsHost, Number(functionsPort));
    const data = { tournamentId: 'main' };
    const resetData = { ...data, expectedName: '바운스발리볼' };
    await assert.rejects(call(functions, 'resetTournament', data), /Seeded administrator required/, 'reset-non-admin-rejected');
    await assert.rejects(call(functions, 'prepareTournamentReset', resetData), /Seeded administrator required/, 'reset-prepare-non-admin-rejected');
    const unauthenticatedApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'emulator-only', appId: `unauthenticated-${Date.now()}` }, `unauthenticated-${Date.now()}`);
    try {
      const unauthenticatedFunctions = getFunctions(unauthenticatedApp, 'asia-northeast3');
      connectFunctionsEmulator(unauthenticatedFunctions, functionsHost, Number(functionsPort));
      await assert.rejects(call(unauthenticatedFunctions, 'resetTournament', data), /Authentication required/, 'reset-unauthenticated-rejected');
      await assert.rejects(call(unauthenticatedFunctions, 'prepareTournamentReset', resetData), /Authentication required/, 'reset-prepare-unauthenticated-rejected');
    } finally {
      await deleteApp(unauthenticatedApp);
    }
    await f.seed(async (db) => {
      await setDoc(doc(db, path('admins', credential.user.uid)), { uid: credential.user.uid });
      await deleteDoc(doc(db, path('recorderAccess', 'config')));
      await deleteDoc(doc(db, path('recorderAccessChallenge', 'current')));
    });
    const preparedCancellation = await call(functions, 'prepareTournamentReset', resetData);
    assert.equal(preparedCancellation.prepared, true, 'reset-prepare-seeded-admin-succeeds');
    await assert.rejects(call(functions, 'createRecorderAccessCode', data), /maintenance/i, 'reset-maintenance-rejects-admin-callables');
    await assert.rejects(call(functions, 'createMigrationManifest', { ...data, manifestId: 'blocked-reset-migration' }), /maintenance/i, 'reset-maintenance-rejects-migration');
    await assert.rejects(call(functions, 'beginRestore', { ...data, manifestId: 'blocked-reset-restore', chunks: [] }), /maintenance/i, 'reset-maintenance-rejects-restore');
    await assert.rejects(call(functions, 'resetTournament', { ...data, token: 'wrong-token' }), /owner and token/i, 'reset-token-mismatch-rejected');
    await assert.rejects(call(functions, 'cancelTournamentReset', { ...data, token: 'wrong-token' }), /owner and token/i, 'reset-cancel-token-mismatch-rejected');
    const recoveredCancellation = await call(functions, 'recoverTournamentReset', data);
    assert.equal(recoveredCancellation.recovered, true, 'reset-owner-can-recover-lost-token');
    await assert.rejects(call(functions, 'cancelTournamentReset', { ...data, token: preparedCancellation.token }), /owner and token/i, 'reset-recovery-invalidates-old-token');
    assert.deepEqual(
      await call(functions, 'cancelTournamentReset', { ...data, token: recoveredCancellation.token }),
      { cancelled: true },
      'reset-cancel-clears-maintenance',
    );

    await f.seed((db) => setDoc(
      doc(db, 'tournaments/main'),
      { recorderFeatureEnabled: false },
      { merge: true },
    ));
    const created = await call(functions, 'createRecorderAccessCode', data);
    assert.equal(created.version, 1, 'access-code-create');
    let recorderRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(recorderRoot.data().recorderFeatureEnabled, true, 'access-code-create-enables-recorder-feature');
    const reissued = await call(functions, 'createRecorderAccessCode', data);
    assert.equal(reissued.version, 2, 'access-code-reissue');
    await assert.rejects(call(functions, 'exchangeRecorderAccessCode', { ...data, code: created.code }), /Invalid access code/);
    await f.seed((db) => setDoc(
      doc(db, 'tournaments/main'),
      { recorderFeatureEnabled: false },
      { merge: true },
    ));
    const exchanged = await call(functions, 'exchangeRecorderAccessCode', { ...data, code: reissued.code });
    assert.equal(exchanged.grantVersion, 2, 'access-code-exchange-reissued');
    recorderRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(recorderRoot.data().recorderFeatureEnabled, true, 'valid-code-self-heals-recorder-feature');
    assert.deepEqual(await call(functions, 'revokeRecorderAccessCode', data), { revoked: true }, 'access-code-revoke');
    recorderRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(recorderRoot.data().recorderFeatureEnabled, false, 'access-code-revoke-disables-recorder-feature');
    const resumedAccess = await call(functions, 'createRecorderAccessCode', data);
    recorderRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(recorderRoot.data().recorderFeatureEnabled, true, 'access-code-reissue-reenables-recorder-feature');
    await call(functions, 'exchangeRecorderAccessCode', { ...data, code: resumedAccess.code });

    const initialTopology = await call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 0,
      expectedQueueRevisions: { 'court-1': 0 },
      courts: [{ id: 'callable-court', name: 'A코트', recorderName: '기록원' }],
      assignmentsByCourt: {
        'callable-court': [
          { matchKey: 'M2', matchType: 'prelim', matchId: 'M2', division: 'men' },
          { matchKey: 'M1', matchType: 'prelim', matchId: 'M1', division: 'men' },
        ],
      },
      unassignedAssignments: [],
    });
    assert.deepEqual(initialTopology, { replaced: true, topologyRevision: 1 }, 'replace-court-workflows-cas-response');
    const normalizedCourtName = await f.seed((db) => getDoc(doc(db, path('courts', 'callable-court'))));
    assert.equal(normalizedCourtName.data().name, 'A', 'court-name-stores-identifier-without-suffix');
    const reorderedQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'callable-court'))));
    assert.equal(reorderedQueue.data().currentMatchKey, 'M2', 'replace-court-workflows-current');
    assert.equal(reorderedQueue.data().nextMatchKey, 'M1', 'replace-court-workflows-next');
    await assert.rejects(call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 0,
      expectedQueueRevisions: { 'callable-court': 1 },
      courts: [{ id: 'callable-court', name: 'stale', recorderName: '' }],
      assignmentsByCourt: { 'callable-court': [] },
      unassignedAssignments: [],
    }), /revision changed/i, 'stale-topology-zero-write');
    const rootAfterStale = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(rootAfterStale.data().courtTopologyRevision, 1, 'stale-topology-did-not-write');
    await f.seed(async (db) => {
      await setDoc(doc(db, path('courtQueues', 'callable-court')), {
        queueRevision: 2,
        lastTransitionId: 'recorder:queue-only-change',
      }, { merge: true });
    });
    await assert.rejects(call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 1,
      expectedQueueRevisions: { 'callable-court': 1 },
      courts: [{ id: 'callable-court', name: 'A코트', recorderName: '기록원' }],
      assignmentsByCourt: {
        'callable-court': [
          { matchKey: 'M2', matchType: 'prelim', matchId: 'M2', division: 'men' },
          { matchKey: 'M1', matchType: 'prelim', matchId: 'M1', division: 'men' },
        ],
      },
      unassignedAssignments: [],
    }), /queue revision changed/i, 'stale-queue-zero-write');
    const rootAfterQueueStale = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(rootAfterQueueStale.data().courtTopologyRevision, 1, 'stale-queue-did-not-write');
    await f.seed(async (db) => {
      await setDoc(doc(db, path('scoreWorkflows', 'M1')), {
        draftState: 'editing',
        lock: { uid: credential.user.uid, token: 'draft-lock', recorderName: '기록원' },
        draft: { sets: [{ a: 4, b: 2 }] },
      }, { merge: true });
      await setDoc(doc(db, path('courtAssignments', 'M1')), {
        publicStatus: 'in_progress',
        attemptCount: 1,
      }, { merge: true });
    });
    await call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 1,
      expectedQueueRevisions: { 'callable-court': 2 },
      courts: [
        { id: 'callable-court', name: 'A코트', recorderName: '기록원' },
        { id: 'destination', name: 'B코트', recorderName: '새 기록원' },
      ],
      assignmentsByCourt: {
        'callable-court': [],
        destination: [
          { matchKey: 'M1', matchType: 'prelim', matchId: 'M1', division: 'men' },
          { matchKey: 'M2', matchType: 'prelim', matchId: 'M2', division: 'men' },
        ],
      },
      unassignedAssignments: [],
    });
    const [movedAssignment, movedWorkflow, sourceQueue, destinationQueue] = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'M1'))),
      getDoc(doc(db, path('scoreWorkflows', 'M1'))),
      getDoc(doc(db, path('courtQueues', 'callable-court'))),
      getDoc(doc(db, path('courtQueues', 'destination'))),
    ]));
    assert.equal(movedAssignment.data().courtOrder, 1, 'editing-move-normalized-first');
    assert.deepEqual(
      movedWorkflow.data().lock,
      { uid: credential.user.uid, token: 'draft-lock', recorderName: '기록원' },
      'editing-move-preserves-lock',
    );
    assert.deepEqual(movedWorkflow.data().draft, { sets: [{ a: 4, b: 2 }] }, 'editing-move-preserves-draft');
    assert.equal(destinationQueue.data().currentMatchKey, 'M1', 'editing-move-is-destination-current');
    assert.equal(sourceQueue.data().queueRevision, 3, 'editing-move-increments-source-queue-revision');
    assert.equal(destinationQueue.data().queueRevision, 1, 'editing-move-increments-destination-queue-revision');
    await f.seed((db) => setDoc(doc(db, path('scoreWorkflows', 'M2')), {
      draftState: 'editing', lock: { uid: 'other', token: 'other-lock' },
    }, { merge: true }));
    await assert.rejects(call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 2,
      expectedQueueRevisions: { 'callable-court': 3, destination: 1 },
      courts: [{ id: 'destination', name: 'B코트', recorderName: '' }],
      assignmentsByCourt: {
        destination: [
          { matchKey: 'M1', matchType: 'prelim', matchId: 'M1', division: 'men' },
          { matchKey: 'M2', matchType: 'prelim', matchId: 'M2', division: 'men' },
        ],
      },
      unassignedAssignments: [],
    }), /Only one editing/i, 'destination-editing-conflict-zero-write');
    const conflictRevision = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(conflictRevision.data().courtTopologyRevision, 2, 'editing-conflict-did-not-write');
    await f.seed(async (db) => {
      await setDoc(doc(db, path('scoreWorkflows', 'M2')), {
        draftState: 'submitted', lock: null, submissionVersion: 3,
      }, { merge: true });
      await setDoc(doc(db, path('courtAssignments', 'M2')), { publicStatus: 'under_review' }, { merge: true });
    });
    await call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 2,
      expectedQueueRevisions: { 'callable-court': 3, destination: 1 },
      courts: [{ id: 'destination', name: 'B코트', recorderName: '' }],
      assignmentsByCourt: {
        destination: [
          { matchKey: 'M2', matchType: 'prelim', matchId: 'M2', division: 'men' },
          { matchKey: 'M1', matchType: 'prelim', matchId: 'M1', division: 'men' },
        ],
      },
      unassignedAssignments: [],
    });
    const submittedWorkflow = await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'M2'))));
    assert.equal(submittedWorkflow.data().draftState, 'submitted', 'existing-submitted-state-is-not-reset');
    await f.seed((db) => setDoc(doc(db, path('scoreWorkflows', 'M2')), {
      draftState: 'approved', officialRevision: 2,
    }, { merge: true }));
    await call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 3,
      expectedQueueRevisions: { destination: 2 },
      courts: [],
      assignmentsByCourt: {},
      unassignedAssignments: [],
    });
    const [unassigned, retainedDraft, retainedApproved] = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'M1'))),
      getDoc(doc(db, path('scoreWorkflows', 'M1'))),
      getDoc(doc(db, path('scoreWorkflows', 'M2'))),
    ]));
    assert.deepEqual(
      [unassigned.data().courtId, unassigned.data().courtOrder, unassigned.data().nextCourtMatchKey],
      [null, null, null],
      'deleted-court-preserves-unassigned-assignment',
    );
    assert.deepEqual(retainedDraft.data().draft, { sets: [{ a: 4, b: 2 }] }, 'deleted-court-preserves-draft');
    assert.equal(retainedApproved.data().draftState, 'approved', 'existing-approved-state-is-not-reset');
    assert.equal(retainedApproved.data().submissionVersion, 3, 'existing-submission-state-is-not-reset');
    await assert.rejects(call(functions, 'rejectScoreReview', {
      ...data,
      matchKey: 'M2',
      reason: 'stale approved reject',
      expectedSubmissionVersion: 3,
      expectedQueueRevision: null,
    }), /Only submitted reviews can be rejected/i, 'approved-unassigned-stale-reject-denied');
    const unassignedSubmit = await call(functions, 'submitRecorderDraft', {
      ...data,
      matchKey: 'M1',
      courtId: null,
      token: 'draft-lock',
      queueRevision: null,
      score: { sets: score },
    });
    assert.equal(unassignedSubmit.queueRevision, null, 'unassigned-submit-has-no-queue-revision');
    const [submittedUnassignedAssignment, submittedUnassignedWorkflow] = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'M1'))),
      getDoc(doc(db, path('scoreWorkflows', 'M1'))),
    ]));
    assert.equal(submittedUnassignedAssignment.data().publicStatus, 'under_review', 'unassigned-submit-enters-review');
    assert.equal(submittedUnassignedWorkflow.data().draftState, 'submitted', 'unassigned-submit-preserves-review-workflow');
    await call(functions, 'rejectScoreReview', {
      ...data,
      matchKey: 'M1',
      reason: 'unassigned review test',
      expectedSubmissionVersion: submittedUnassignedWorkflow.data().submissionVersion,
      expectedQueueRevision: null,
    });
    await call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 4,
      expectedQueueRevisions: {},
      courts: [{ id: 'rework-court', name: '재경기 코트', recorderName: '기록원' }],
      assignmentsByCourt: {
        'rework-court': [
          { matchKey: 'M1', matchType: 'prelim', matchId: 'M1', division: 'men' },
        ],
      },
      unassignedAssignments: [],
    });
    const reassignedReworkQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'rework-court'))));
    assert.equal(reassignedReworkQueue.data().currentMatchKey, 'M1', 'reassigned-rejected-match-restores-priority');
    assert.equal(reassignedReworkQueue.data().priorityEntries[0].matchKey, 'M1', 'reassigned-rejected-priority-entry');
    await call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 5,
      expectedQueueRevisions: { 'rework-court': 1 },
      courts: [],
      assignmentsByCourt: {},
      unassignedAssignments: [],
    });
    await f.seed(async (db) => {
      await setDoc(doc(db, path('scoreWorkflows', 'M1')), {
        draftState: 'editing',
        resumeDraftState: 'rejected',
        lock: { uid: credential.user.uid, token: 'cancel-lock', recorderName: '기록원' },
      }, { merge: true });
      await setDoc(doc(db, path('courtAssignments', 'M1')), {
        publicStatus: 'in_progress',
      }, { merge: true });
    });
    const unassignedCancel = await call(functions, 'cancelRecorderDraft', {
      ...data,
      matchKey: 'M1',
      courtId: null,
      token: 'cancel-lock',
      queueRevision: null,
    });
    assert.equal(unassignedCancel.queueRevision, null, 'unassigned-cancel-has-no-queue-revision');
    const cancelledUnassigned = await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    assert.equal(cancelledUnassigned.data().draftState, 'rejected', 'unassigned-cancel-restores-rejected-state');
    await f.seed(async (db) => {
      await setDoc(doc(db, path('courtAssignments', 'BP')), {
        matchKey: 'BP',
        matchType: 'final',
        matchId: 'BP',
        divisionId: 'men',
        courtId: null,
        courtOrder: null,
        nextCourtMatchKey: null,
        publicStatus: 'replay_required',
        dependencyReady: false,
        lastTransitionId: 'correction:blocked',
      });
      await setDoc(doc(db, path('scoreWorkflows', 'BP')), {
        draftState: 'idle',
        lock: null,
        submissionVersion: 1,
        officialRevision: 1,
      });
    });
    await call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 6,
      expectedQueueRevisions: {},
      courts: [{ id: 'blocked-court', name: '대진 대기 코트', recorderName: '' }],
      assignmentsByCourt: {
        'blocked-court': [{
          matchKey: 'BP',
          matchType: 'final',
          matchId: 'BP',
          divisionId: 'men',
          dependencyReady: false,
        }],
      },
      unassignedAssignments: [],
    });
    const [blockedQueueSnap, blockedAssignmentSnap, blockedWorkflowSnap] = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtQueues', 'blocked-court'))),
      getDoc(doc(db, path('courtAssignments', 'BP'))),
      getDoc(doc(db, path('scoreWorkflows', 'BP'))),
    ]));
    assert.equal(blockedQueueSnap.data().priorityEntries[0].eligibility, 'blocked_dependency', 'reassigned-correction-uses-canonical-blocked-state');
    const activatedBlocked = activateDependencyEntries(
      blockedQueueSnap.data(),
      { BP: { ...blockedAssignmentSnap.data(), dependencyReady: true } },
      { BP: blockedWorkflowSnap.data() },
      ['BP'],
    );
    assert.equal(activatedBlocked.currentMatchKey, 'BP', 'reassigned-blocked-correction-activates');

    // Queue planning is the same pure core used by callable review/recovery handlers.
    const assignments = { C1: { publicStatus: 'under_review', courtOrder: 1, nextCourtMatchKey: 'C2' }, C2: { publicStatus: 'scheduled', courtOrder: 2, nextCourtMatchKey: null }, R1: { publicStatus: 'replay_required', courtOrder: 3, nextCourtMatchKey: null } };
    const workflows = { C1: { draftState: 'submitted' }, C2: { draftState: 'idle' }, R1: { draftState: 'rejected', submissionVersion: 1 } };
    const initial = { queueRevision: 1, currentMatchKey: 'C1', nextMatchKey: 'C2', normalCursorMatchKey: 'C1', priorityEntries: [], nextPrioritySequence: 0 };
    const advanced = consumeCurrentAndAdvance(initial, assignments, workflows, 'C1');
    assert.equal(advanced.currentMatchKey, 'C2', 'submit-immediate-advance/review-does-not-block-next');
    const priority = insertPriorityEntry(advanced, assignments, workflows, { matchKey: 'R1', kind: 'rejected_rework', sourceTransitionIds: ['reject'], pathDepth: 0 });
    assert.equal(selectQueueView(priority, assignments, workflows).currentMatchKey, 'R1', 'reject-idle-priority');
    const busyAssignments = { ...assignments, C2: { ...assignments.C2, publicStatus: 'in_progress' } };
    const busy = { ...workflows, C2: { draftState: 'editing', lock: { uid: 'r', token: 't' } } };
    assert.equal(selectQueueView(priority, busyAssignments, busy).currentMatchKey, 'C2', 'reject-busy-priority');
    assert.deepEqual(projectForceRelease(priority, assignments, { ...workflows, R1: { draftState: 'editing', lock: { uid: 'r', token: 't' } } }, 'R1', { draftState: 'rejected' }).priorityEntries.length, 1, 'cancel-force-release');
    const correction = planCorrectionReplay(advanced, assignments, workflows, ['C2', 'R1'], 'correction');
    assert.equal(correction.queue.priorityEntries[0].matchKey, 'R1', 'never-started-normal-correction/history-priority');
    assert.throws(
      () => planCorrectionReplay(advanced, busyAssignments, busy, ['C2'], 'active'),
      /active/i,
      'active-affected-zero-write',
    );
    await f.seed(async (db) => {
      await setDoc(doc(db, path('courts', 'correction-court')), {
        id: 'correction-court', name: '정정 코트', recorderName: '',
      });
      await setDoc(doc(db, path('courtAssignments', 'P1')), {
        matchKey: 'P1', matchType: 'prelim', matchId: 'P1', division: 'men',
        courtId: 'correction-court', courtOrder: 1, nextCourtMatchKey: 'P2', publicStatus: 'completed',
      });
      await setDoc(doc(db, path('courtAssignments', 'P2')), {
        matchKey: 'P2', matchType: 'prelim', matchId: 'P2', division: 'men',
        courtId: 'correction-court', courtOrder: 2, nextCourtMatchKey: null, publicStatus: 'completed',
      });
      await setDoc(doc(db, path('scoreWorkflows', 'P1')), { draftState: 'approved', lock: null, officialRevision: 1 });
      await setDoc(doc(db, path('scoreWorkflows', 'P2')), { draftState: 'approved', lock: null, officialRevision: 1 });
      await setDoc(doc(db, path('courtQueues', 'correction-court')), {
        courtId: 'correction-court',
        queueRevision: 0,
        currentMatchKey: null,
        nextMatchKey: null,
        normalCursorMatchKey: null,
        priorityEntries: [],
        nextPrioritySequence: 0,
      });
    });
    const correctionPreview = await call(functions, 'previewApprovedCorrection', {
      ...data,
      matchKeys: ['P2'],
    });
    assert.equal(correctionPreview.expectedQueueRevision, 0, 'server-correction-preview-revision');
    await call(functions, 'applyApprovedCorrection', {
      ...data,
      matchKeys: ['P2'],
      reason: 'preview/apply parity',
      expectedQueueRevision: correctionPreview.expectedQueueRevision,
    });
    const appliedCorrectionQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'correction-court'))));
    assert.deepEqual(
      {
        currentMatchKey: appliedCorrectionQueue.data().currentMatchKey || null,
        nextMatchKey: appliedCorrectionQueue.data().nextMatchKey || null,
      },
      correctionPreview.projection.after,
      'server-preview-apply-projection-parity',
    );

    const manifest = await call(functions, 'createMigrationManifest', { ...data, manifestId: 'migration-idempotent' });
    const repeated = await call(functions, 'createMigrationManifest', { ...data, manifestId: 'migration-idempotent' });
    assert.equal(repeated.manifestId, manifest.manifestId, 'migration-idempotency');
    await call(functions, 'beginRestore', { ...data, manifestId: 'restore-maintenance', chunks: [] });
    const restoring = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(restoring.data().maintenance.enabled, true, 'restore-maintenance');
    await call(functions, 'verifyRestore', { ...data, manifestId: 'restore-maintenance' });
    await assert.rejects(call(functions, 'verifyRestore', { ...data, manifestId: 'missing' }), /not found|restore/i, 'restore-verify');
    await call(functions, 'promoteRestore', { ...data, manifestId: 'restore-maintenance' });
    await f.seed(async (db) => {
      await setDoc(doc(db, path('prelimMatches', 'approval-prelim')), {
        teamA: 'approval-a',
        teamB: 'approval-b',
        sets: [],
        status: 'pending',
        result: null,
      });
      await setDoc(doc(db, path('courtAssignments', 'approval-prelim')), {
        matchKey: 'approval-prelim',
        matchType: 'prelim',
        matchId: 'approval-prelim',
        courtId: null,
        publicStatus: 'under_review',
        officialRevision: 0,
      });
      await setDoc(doc(db, path('scoreWorkflows', 'approval-prelim')), {
        draftState: 'submitted',
        submittedSnapshot: { sets: [{ a: 10, b: 8 }, { a: 7, b: 10 }] },
        submissionVersion: 1,
        officialRevision: 0,
        lock: null,
      });
    });
    await call(functions, 'approveScoreReview', {
      ...data,
      matchKey: 'approval-prelim',
      expectedSubmissionVersion: 1,
    });
    const approvedPrelim = await f.seed((db) => getDoc(doc(db, path('prelimMatches', 'approval-prelim'))));
    assert.deepEqual(approvedPrelim.data().sets, [{ a: 10, b: 8 }, { a: 7, b: 10 }], 'approved-recorder-score-updates-prelim');
    assert.equal(approvedPrelim.data().result, 'draw', 'approved-recorder-score-updates-prelim-result');
    assert.equal(approvedPrelim.data().officialRevision, 1, 'approved-recorder-score-increments-official-revision');
    await f.seed(async (db) => {
      await setDoc(doc(db, path('courts', 'resume-court')), {
        id: 'resume-court',
        name: '재접속',
        recorderName: '재접속 기록관',
      });
      await setDoc(doc(db, path('courtAssignments', 'resume-match')), {
        matchKey: 'resume-match',
        matchType: 'prelim',
        matchId: 'resume-match',
        courtId: 'resume-court',
        publicStatus: 'in_progress',
        lastTransitionId: 'seed:resume',
      });
      await setDoc(doc(db, path('courtQueues', 'resume-court')), {
        courtId: 'resume-court',
        currentMatchKey: 'resume-match',
        nextMatchKey: null,
        normalCursorMatchKey: 'resume-match',
        priorityEntries: [],
        nextPrioritySequence: 0,
        queueRevision: 3,
        lastTransitionId: 'seed:resume',
      });
      await setDoc(doc(db, path('scoreWorkflows', 'resume-match')), {
        matchKey: 'resume-match',
        draftState: 'editing',
        resumeDraftState: 'idle',
        lock: { uid: credential.user.uid, token: 'lost-browser-token', recorderName: '재접속 기록관' },
        draft: { sets: [{ a: 6, b: 4 }] },
        draftRevision: 2,
        submissionVersion: 0,
        officialRevision: 0,
        lastTransitionId: 'seed:resume',
      });
    });
    await assert.rejects(call(functions, 'resumeRecorderDraft', {
      ...data,
      matchKey: 'resume-match',
      courtId: 'resume-court',
      recorderName: '다른 기록관',
      queueRevision: 3,
    }), /same recorder/i, 'resume-different-recorder-rejected');
    const resumedDraft = await call(functions, 'resumeRecorderDraft', {
      ...data,
      matchKey: 'resume-match',
      courtId: 'resume-court',
      recorderName: '재접속 기록관',
      queueRevision: 3,
    });
    assert.equal(resumedDraft.resumed, true, 'same-recorder-browser-reconnect-succeeds');
    assert.notEqual(resumedDraft.token, 'lost-browser-token', 'resume-rotates-lost-browser-token');
    const resumedWorkflow = await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'resume-match'))));
    assert.deepEqual(resumedWorkflow.data().draft, { sets: [{ a: 6, b: 4 }] }, 'resume-preserves-saved-draft');
    assert.equal(resumedWorkflow.data().lock.uid, credential.user.uid, 'resume-preserves-google-account-owner');
    assert.equal(resumedWorkflow.data().lock.recorderName, '재접속 기록관', 'resume-preserves-recorder-name');
    assert.equal(resumedWorkflow.data().lock.token, resumedDraft.token, 'resume-persists-new-token');
    await f.seed(async (db) => {
      await setDoc(doc(db, 'tournaments/main'), {
        tournamentId: 'main',
        name: '초기화 대상 대회',
        legacySetting: true,
        recorderFeatureEnabled: true,
        maintenance: { enabled: false },
        courtTopologyRevision: 99,
        venueDisplay: { mode: 'women', intervalSeconds: 30 },
      });
      await setDoc(doc(db, path('groups', 'reset-group')), { division: 'men' });
      await setDoc(doc(db, path('teams', 'reset-team')), { division: 'women' });
      await setDoc(doc(db, path('prelimMatches', 'reset-prelim')), { division: 'men' });
      await setDoc(doc(db, 'tournaments/main/divisions/women/finalMatches/reset-final'), { status: 'done' });
      await setDoc(doc(db, path('courts', 'reset-court')), { name: '초기화 코트' });
      await setDoc(doc(db, path('courtAssignments', 'reset-assignment')), { matchKey: 'reset-assignment' });
      await setDoc(doc(db, path('scoreWorkflows', 'reset-workflow')), { draftState: 'submitted' });
      await setDoc(doc(db, path('recorderAccess', 'reset-access')), { enabled: true });
      await setDoc(doc(db, path('recorderGrants', 'reset-grant')), { uid: 'reset-grant' });
      await setDoc(doc(db, path('auditEvents', 'reset-audit')), { eventType: 'reset-test' });
      await setDoc(doc(db, path('restoreManifests', 'reset-restore')), { status: 'staged' });
      await setDoc(doc(db, 'tournaments/main/restoreManifests/reset-restore/chunks/0'), { index: 0 });
    });
    const preparedReset = await call(functions, 'prepareTournamentReset', { ...data, expectedName: '초기화 대상 대회' });
    assert.deepEqual(
      await call(functions, 'resetTournament', { ...data, token: preparedReset.token }),
      { reset: true },
      'reset-seeded-admin-succeeds',
    );
    const resetRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.deepEqual(resetRoot.data(), {
      tournamentId: 'main',
      name: '',
      qualifyPerGroup: { men: 2, women: 2 },
      recorderFeatureEnabled: false,
      maintenance: { enabled: false },
      courtTopologyRevision: 0,
      venueDisplay: { mode: 'auto', intervalSeconds: 15 },
    }, 'reset-root-defaults');
    const resetDocs = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('groups', 'reset-group'))),
      getDoc(doc(db, path('teams', 'reset-team'))),
      getDoc(doc(db, path('prelimMatches', 'reset-prelim'))),
      getDoc(doc(db, 'tournaments/main/divisions/women/finalMatches/reset-final')),
      getDoc(doc(db, path('courts', 'reset-court'))),
      getDoc(doc(db, path('courtAssignments', 'reset-assignment'))),
      getDoc(doc(db, path('scoreWorkflows', 'reset-workflow'))),
      getDoc(doc(db, path('recorderAccess', 'reset-access'))),
      getDoc(doc(db, path('recorderGrants', 'reset-grant'))),
      getDoc(doc(db, path('auditEvents', 'reset-audit'))),
      getDoc(doc(db, path('restoreManifests', 'reset-restore'))),
      getDoc(doc(db, 'tournaments/main/restoreManifests/reset-restore/chunks/0')),
      getDoc(doc(db, path('admins', credential.user.uid))),
    ]));
    resetDocs.slice(0, -1).forEach((snap) => assert.equal(snap.exists(), false, `reset-deletes-${snap.ref.path}`));
    assert.equal(resetDocs.at(-1).exists(), true, 'reset-preserves-seeded-admin');
    // 코트 문서 ID는 랜덤이라 getDocs 기본 순서(문서 ID 오름차순)는 관리자가 만든 순서와 무관하다.
    // 만든 순서가 order 필드로 보존되는지 확인한다. 전체 초기화 직후라 topologyRevision은 0이다.
    const madeOrder = [
      { id: 'court-zzz', name: 'C', recorderName: '오수연' },
      { id: 'court-aaa', name: 'A', recorderName: '강지언' },
      { id: 'court-mmm', name: 'B', recorderName: '김수빈' },
    ];
    await call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 0,
      expectedQueueRevisions: {},
      courts: madeOrder,
      assignmentsByCourt: {},
      unassignedAssignments: [],
    });
    const storedCourts = await f.seed((db) => getDocs(collection(db, 'tournaments/main/courts')));
    const byDocId = storedCourts.docs.map((snap) => snap.data().name);
    const byOrder = storedCourts.docs
      .map((snap) => ({ name: snap.data().name, order: snap.data().order }))
      .sort((a, b) => a.order - b.order)
      .map((court) => court.name);
    assert.deepEqual(byOrder, ['C', 'A', 'B'], 'court-order-preserves-creation-sequence');
    assert.deepEqual(byDocId, ['A', 'B', 'C'], 'court-doc-id-order-differs-from-creation-order');
    assert.deepEqual(
      storedCourts.docs.map((snap) => snap.data().order).sort((a, b) => a - b),
      [1, 2, 3],
      'court-order-is-dense-one-based',
    );

    assert.ok(score.length === 2);
  } finally { await deleteApp(app); await f.cleanup(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await runFunctionsSuite();

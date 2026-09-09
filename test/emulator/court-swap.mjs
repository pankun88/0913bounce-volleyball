import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { createFixture, IDS, PROJECT_ID, path } from './fixtures.mjs';

const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const [functionsHostName, functionsPort] = functionsHost.split(':');
const call = (functions, name, data) => httpsCallable(functions, name)(data).then((result) => result.data);

export async function runCourtSwapSuite() {
  const fixture = await createFixture();
  const appName = `court-swap-${Date.now()}`;
  const app = initializeApp({
    projectId: PROJECT_ID,
    apiKey: 'emulator-only',
    appId: appName,
  }, appName);
  try {
    const auth = getAuth(app);
    connectAuthEmulator(
      auth,
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`,
      { disableWarnings: true },
    );
    const credential = await signInAnonymously(auth);
    const functions = getFunctions(app, 'asia-northeast3');
    connectFunctionsEmulator(functions, functionsHostName, Number(functionsPort));
    const uid = credential.user.uid;
    const expiresAt = Timestamp.fromMillis(Date.now() + 3_600_000);
    const oldDraft = { sets: [{ a: 8, b: 7 }] };
    const lock = {
      uid,
      token: 'old-lock-token',
      recorderName: 'Recorder One',
      sessionId: 'old-session-id-12345678',
      acquiredAt: Timestamp.fromMillis(Date.now() - 30_000),
      renewedAt: Timestamp.fromMillis(Date.now() - 5_000),
      expiresAt,
    };
    await fixture.seed(async (db) => {
      await db.doc(path('admins', uid)).set({ uid });
      await db.doc(path('recorderGrants', uid)).set({
        uid,
        version: 2,
        proofHash: 'seed-hash',
        status: 'active',
        issuedAt: Timestamp.fromMillis(Date.now() - 60_000),
        expiresAt,
      });
      await db.doc(path('courts', 'court-2')).set({
        id: 'court-2',
        name: 'Court 2',
        recorderName: 'Recorder Two',
      });
      await db.doc(path('prelimMatches', 'M3')).set({ id: 'M3', division: 'men', status: 'scheduled' });
      await db.doc(path('divisions', 'men/finalMatches/F1')).set({
        id: 'F1',
        status: 'done',
        officialRevision: 2,
        sets: [{ a: 10, b: 8 }, { a: 10, b: 7 }],
        result: 'A',
      });
      await db.doc(path('divisions', 'women/finalMatches/W1')).set({
        id: 'W1',
        status: 'done',
        officialRevision: 3,
        sets: [{ a: 8, b: 10 }, { a: 9, b: 10 }],
        result: 'B',
      });
      await db.doc(path('courtAssignments', 'M1')).set({
        matchKey: 'M1', matchType: 'prelim', matchId: 'M1', division: 'men',
        courtId: 'court-1', courtOrder: 2, nextCourtMatchKey: 'final:men:F1',
        publicStatus: 'in_progress', officialRevision: 0, lastTransitionId: 'seed:m1',
      });
      await db.doc(path('courtAssignments', 'M2')).set({
        matchKey: 'M2', matchType: 'prelim', matchId: 'M2', division: 'men',
        courtId: 'court-1', courtOrder: 1, nextCourtMatchKey: 'M1',
        publicStatus: 'completed', officialRevision: 1, lastTransitionId: 'seed:m2',
      });
      await db.doc(path('courtAssignments', 'final:men:F1')).set({
        matchKey: 'final:men:F1', matchType: 'final', matchId: 'F1', divisionId: 'men',
        courtId: 'court-1', courtOrder: 3, nextCourtMatchKey: null,
        publicStatus: 'completed', officialRevision: 2, lastTransitionId: 'seed:f1',
      });
      await db.doc(path('courtAssignments', 'M3')).set({
        matchKey: 'M3', matchType: 'prelim', matchId: 'M3', division: 'men',
        courtId: 'court-2', courtOrder: 1, nextCourtMatchKey: 'final:women:W1',
        publicStatus: 'scheduled', officialRevision: 0, lastTransitionId: 'seed:m3',
      });
      await db.doc(path('courtAssignments', 'final:women:W1')).set({
        matchKey: 'final:women:W1', matchType: 'final', matchId: 'W1', divisionId: 'women',
        courtId: 'court-2', courtOrder: 2, nextCourtMatchKey: null,
        publicStatus: 'completed', officialRevision: 3, lastTransitionId: 'seed:w1',
      });
      await db.doc(path('scoreWorkflows', 'M1')).set({
        matchKey: 'M1', draftState: 'editing', resumeDraftState: 'idle', lock,
        draft: oldDraft, draftRevision: 4, submissionVersion: 0, officialRevision: 0,
      });
      await db.doc(path('scoreWorkflows', 'M2')).set({
        matchKey: 'M2', draftState: 'approved', lock: null, draft: { sets: [] },
        submittedSnapshot: { sets: [{ a: 10, b: 8 }, { a: 10, b: 7 }] },
        submission: { version: 1, recorder: { uid: 'prior-recorder', name: '기존 기록관' } },
        draftRevision: 0, submissionVersion: 1, officialRevision: 1,
      });
      await db.doc(path('scoreWorkflows', 'final:men:F1')).set({
        matchKey: 'final:men:F1', draftState: 'approved', lock: null,
        draft: { sets: [] }, draftRevision: 0, submissionVersion: 2, officialRevision: 2,
      });
      await db.doc(path('scoreWorkflows', 'M3')).set({
        matchKey: 'M3', draftState: 'idle', lock: null, draft: { sets: [] },
        draftRevision: 0, submissionVersion: 0, officialRevision: 0,
      });
      await db.doc(path('scoreWorkflows', 'final:women:W1')).set({
        matchKey: 'final:women:W1', draftState: 'approved', lock: null,
        draft: { sets: [] }, draftRevision: 0, submissionVersion: 3, officialRevision: 3,
      });
      await db.doc(path('courtQueues', 'court-2')).set({
        courtId: 'court-2', currentMatchKey: 'M3', nextMatchKey: 'final:women:W1',
        normalCursorMatchKey: 'M3', priorityEntries: [], nextPrioritySequence: 0,
        queueRevision: 4, lastTransitionId: 'seed:queue-2',
      });
      await db.doc(path('courtQueues', 'court-1')).set({
        courtId: 'court-1', currentMatchKey: 'M1', nextMatchKey: 'M2',
        normalCursorMatchKey: 'M1', priorityEntries: [], nextPrioritySequence: 0,
        queueRevision: 0, lastTransitionId: 'seed:queue-1',
      });
    });

    const swapPayload = {
      tournamentId: 'main',
      courts: [
        { id: 'court-1', name: 'Court 1', recorderName: 'Recorder One' },
        { id: 'court-2', name: 'Court 2', recorderName: 'Recorder Two' },
      ],
      assignmentsByCourt: {
        'court-1': [
          { matchKey: 'M3', matchId: 'M3', matchType: 'prelim', division: 'men', courtOrder: 1 },
          { matchKey: 'final:women:W1', matchId: 'W1', matchType: 'final', divisionId: 'women', courtOrder: 2 },
        ],
        'court-2': [
          { matchKey: 'M2', matchId: 'M2', matchType: 'prelim', division: 'men', courtOrder: 1 },
          { matchKey: 'M1', matchId: 'M1', matchType: 'prelim', division: 'men', courtOrder: 2 },
          { matchKey: 'final:men:F1', matchId: 'F1', matchType: 'final', divisionId: 'men', courtOrder: 3 },
        ],
      },
      unassignedAssignments: [],
      courtSwaps: [{ fromCourtId: 'court-1', toCourtId: 'court-2' }],
      expectedTopologyRevision: 0,
      expectedQueueRevisions: { 'court-1': 0, 'court-2': 4 },
    };
    const swapped = await call(functions, 'replaceCourtWorkflows', swapPayload);
    assert.equal(swapped.replaced, true, 'whole-court-swap-accepted');

    const state = await fixture.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'M1'))),
      getDoc(doc(db, path('courtAssignments', 'M2'))),
      getDoc(doc(db, path('courtAssignments', 'final:men:F1'))),
      getDoc(doc(db, path('courtAssignments', 'M3'))),
      getDoc(doc(db, path('courtAssignments', 'final:women:W1'))),
      getDoc(doc(db, path('scoreWorkflows', 'M1'))),
      getDoc(doc(db, path('courtQueues', 'court-1'))),
      getDoc(doc(db, path('courtQueues', 'court-2'))),
    ]));
    assert.deepEqual(
      state.slice(0, 5).map((snapshot) => [snapshot.id, snapshot.data().courtId, snapshot.data().courtOrder]),
      [
        ['M1', 'court-2', 2],
        ['M2', 'court-2', 1],
        ['final:men:F1', 'court-2', 3],
        ['M3', 'court-1', 1],
        ['final:women:W1', 'court-1', 2],
      ],
      'all-prelim-final-completed-and-active-games-exchanged',
    );
    assert.equal(state[0].data().publicStatus, 'scheduled', 'moved-live-assignment-released');
    assert.equal(state[1].data().publicStatus, 'completed', 'completed-assignment-status-preserved');
    assert.equal(state[2].data().officialRevision, 2, 'final-official-history-preserved');
    assert.equal(state[5].data().lock, null, 'moved-live-lease-invalidated');
    assert.equal(state[5].data().draftState, 'idle', 'moved-draft-state-released');
    assert.deepEqual(state[5].data().draft, oldDraft, 'moved-draft-preserved');
    assert.equal(state[6].data().queueRevision, 1, 'source-queue-revision-bumped');
    assert.equal(state[7].data().queueRevision, 5, 'destination-queue-revision-bumped');
    assert.equal(state[6].data().currentMatchKey, 'M3', 'source-queue-rebuilt');
    assert.equal(state[7].data().currentMatchKey, 'M1', 'destination-queue-rebuilt');
    const submittedHistory = await fixture.seed((db) => getDoc(
      doc(db, path('scoreWorkflows', 'M2')),
    ));
    assert.deepEqual(
      submittedHistory.data().submittedSnapshot,
      { sets: [{ a: 10, b: 8 }, { a: 10, b: 7 }] },
      'submitted-snapshot-preserved',
    );
    assert.deepEqual(
      submittedHistory.data().submission,
      { version: 1, recorder: { uid: 'prior-recorder', name: '기존 기록관' } },
      'submission-history-preserved',
    );

    await assert.rejects(
      call(functions, 'saveRecorderDraft', {
        tournamentId: 'main',
        matchKey: 'M1',
        token: lock.token,
        sessionId: lock.sessionId,
        draft: oldDraft,
        queueRevision: 0,
        expectedDraftRevision: 4,
      }),
      /stale_queue|Queue revision changed/i,
      'old-recorder-cannot-write-after-swap',
    );
    await assert.rejects(
      call(functions, 'saveRecorderDraft', {
        tournamentId: 'main',
        matchKey: 'M1',
        token: lock.token,
        sessionId: lock.sessionId,
        draft: oldDraft,
        queueRevision: 5,
        expectedDraftRevision: 4,
      }),
      /ownership_lost|ownership|lock/i,
      'revoked-lease-fence-survives-destination-revision-match',
    );
    await assert.rejects(
      call(functions, 'renewRecorderLease', {
        tournamentId: 'main',
        matchKey: 'M1',
        token: lock.token,
        sessionId: lock.sessionId,
        queueRevision: 0,
      }),
      /stale_queue|Queue revision changed/i,
      'old-recorder-cannot-renew-from-source-queue',
    );
    await assert.rejects(
      call(functions, 'renewRecorderLease', {
        tournamentId: 'main',
        matchKey: 'M1',
        token: lock.token,
        sessionId: lock.sessionId,
        queueRevision: 5,
      }),
      /ownership_lost|ownership|lock/i,
      'revoked-lease-blocks-renew-at-destination-queue',
    );
    await assert.rejects(
      call(functions, 'submitRecorderDraft', {
        tournamentId: 'main',
        matchKey: 'M1',
        courtId: 'court-1',
        token: lock.token,
        sessionId: lock.sessionId,
        queueRevision: 0,
        score: { sets: [{ a: 10, b: 8 }, { a: 10, b: 7 }] },
        operationId: 'swap-submit-operation-0001',
      }),
      /Stale recorder ownership|queue revision|stale_queue/i,
      'old-recorder-cannot-submit-from-source-queue',
    );

    await assert.rejects(
      call(functions, 'replaceCourtWorkflows', swapPayload),
      /Court topology revision changed/i,
      'concurrent-topology-change-rejected',
    );
  } finally {
    await deleteApp(app);
    await fixture.cleanup();
  }
}

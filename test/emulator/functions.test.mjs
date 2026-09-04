import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, Timestamp } from 'firebase/firestore';
import { createFixture, IDS, PROJECT_ID, path } from './fixtures.mjs';
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
    await assert.rejects(call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'clear_division_prelim', division: 'men',
    }), /Seeded administrator required/, 'prelim-structure-non-admin-rejected');
    await assert.rejects(call(functions, 'clearFinalStructure', {
      tournamentId: 'main', division: 'men',
    }), /Seeded administrator required/, 'final-clear-non-admin-rejected');
    const unauthenticatedApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'emulator-only', appId: `unauthenticated-${Date.now()}` }, `unauthenticated-${Date.now()}`);
    try {
      const unauthenticatedFunctions = getFunctions(unauthenticatedApp, 'asia-northeast3');
      connectFunctionsEmulator(unauthenticatedFunctions, functionsHost, Number(functionsPort));
      await assert.rejects(call(unauthenticatedFunctions, 'resetTournament', data), /Authentication required/, 'reset-unauthenticated-rejected');
      await assert.rejects(call(unauthenticatedFunctions, 'prepareTournamentReset', resetData), /Authentication required/, 'reset-prepare-unauthenticated-rejected');
      await assert.rejects(call(unauthenticatedFunctions, 'mutatePrelimStructure', {
        ...data, operation: 'clear_division_prelim', division: 'men',
      }), /Authentication required/, 'prelim-structure-unauthenticated-rejected');
      await assert.rejects(call(unauthenticatedFunctions, 'clearFinalStructure', {
        tournamentId: 'main', division: 'men',
      }), /Authentication required/, 'final-clear-unauthenticated-rejected');
      const serverClock = await call(unauthenticatedFunctions, 'getServerClock', data);
      assert.ok(Number.isFinite(serverClock.serverTimeMs), 'server-clock-is-public-and-authoritative');
    } finally {
      await deleteApp(unauthenticatedApp);
    }
    await f.seed(async (db) => {
      await setDoc(doc(db, path('admins', credential.user.uid)), { uid: credential.user.uid });
      await deleteDoc(doc(db, path('recorderAccess', 'config')));
      await deleteDoc(doc(db, path('recorderAccessChallenge', 'current')));
      await setDoc(doc(db, path('courtAssignments', 'legacy-empty-lock')), {
        matchKey: 'legacy-empty-lock',
        matchType: 'prelim',
        matchId: 'legacy-empty-lock',
        courtId: null,
        courtOrder: null,
        nextCourtMatchKey: null,
        publicStatus: 'in_progress',
      });
      await setDoc(doc(db, path('scoreWorkflows', 'legacy-empty-lock')), {
        matchKey: 'legacy-empty-lock',
        draftState: 'editing',
        resumeDraftState: 'idle',
        lock: { uid: 'legacy-recorder', token: '', recorderName: '기존 기록관' },
        draftRevision: 0,
        submissionVersion: 0,
        officialRevision: 0,
      });
    });
    await call(functions, 'forceReleaseWorkflow', {
      ...data,
      matchKey: 'legacy-empty-lock',
      reason: '잘못된 기존 잠금 복구',
      expectedLockToken: '',
      expectedQueueRevision: null,
    });
    const releasedLegacyLock = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'legacy-empty-lock'))),
      getDoc(doc(db, path('scoreWorkflows', 'legacy-empty-lock'))),
    ]));
    assert.equal(releasedLegacyLock[0].data().publicStatus, 'scheduled', 'force-release-recovers-empty-token-assignment');
    assert.equal(releasedLegacyLock[1].data().draftState, 'idle', 'force-release-recovers-empty-token-workflow');
    assert.equal(releasedLegacyLock[1].data().lock, null, 'force-release-clears-empty-token-lock');
    await f.seed(async (db) => {
      await deleteDoc(doc(db, path('courtAssignments', 'legacy-empty-lock')));
      await deleteDoc(doc(db, path('scoreWorkflows', 'legacy-empty-lock')));
    });
    await f.seed(async (db) => {
      await setDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/unassigned-final'), {
        id: 'unassigned-final', status: 'empty',
      });
      await setDoc(doc(db, 'tournaments/main/divisions/women/finalMatches/women-final'), {
        id: 'women-final', status: 'pending',
      });
    });
    const unassignedClear = await call(functions, 'clearFinalStructure', {
      tournamentId: 'main', division: 'men',
    });
    assert.deepEqual(unassignedClear.counts, {
      removedFinalMatches: 1, removedAssignments: 0, removedWorkflows: 0, affectedCourts: 0,
    }, 'final-clear-removes-pristine-unassigned-structure');
    assert.equal((await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/men/finalMatches/unassigned-final'),
    ))).exists(), false, 'final-clear-deletes-unassigned-final');
    assert.equal((await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/women/finalMatches/women-final'),
    ))).exists(), true, 'final-clear-men-leaves-women-final-untouched');
    await f.seed((db) => deleteDoc(
      doc(db, 'tournaments/main/divisions/women/finalMatches/women-final'),
    ));

    const finalAssignmentKey = 'final:men:assigned-final';
    await f.seed(async (db) => {
      await setDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/assigned-final'), {
        id: 'assigned-final', status: 'pending',
      });
      await setDoc(doc(db, path('prelimMatches', 'final-clear-survivor')), {
        id: 'final-clear-survivor', division: 'men', status: 'pending',
      });
      await setDoc(doc(db, path('courtAssignments', 'final-clear-survivor')), {
        matchKey: 'final-clear-survivor', matchType: 'prelim', matchId: 'final-clear-survivor',
        division: 'men', courtId: 'final-clear-court', courtOrder: 1,
        nextCourtMatchKey: finalAssignmentKey, publicStatus: 'scheduled',
        lastTransitionId: 'seed:final-clear-survivor',
      });
      await setDoc(doc(db, path('scoreWorkflows', 'final-clear-survivor')), {
        matchKey: 'final-clear-survivor', draftState: 'idle', lock: null,
        draftRevision: 0, submissionVersion: 0, officialRevision: 0,
        lastTransitionId: 'seed:final-clear-survivor',
      });
      await setDoc(doc(db, path('courtAssignments', finalAssignmentKey)), {
        matchKey: finalAssignmentKey, matchType: 'final', matchId: 'assigned-final',
        divisionId: 'men', division: 'men', courtId: 'final-clear-court', courtOrder: 2,
        nextCourtMatchKey: null, publicStatus: 'scheduled', lastTransitionId: 'seed:assigned-final',
      });
      await setDoc(doc(db, path('scoreWorkflows', finalAssignmentKey)), {
        matchKey: finalAssignmentKey, draftState: 'idle', lock: null,
        draftRevision: 0, submissionVersion: 0, officialRevision: 0,
        lastTransitionId: 'seed:assigned-final',
      });
      await setDoc(doc(db, 'tournaments/main/divisions/women/finalMatches/assigned-final'), {
        id: 'assigned-final', status: 'pending',
      });
      await setDoc(doc(db, path('courtAssignments', 'final:women:assigned-final')), {
        matchKey: 'final:women:assigned-final', matchType: 'final', matchId: 'assigned-final',
        divisionId: 'women', division: 'women', courtId: null, courtOrder: null,
        nextCourtMatchKey: null, publicStatus: 'scheduled',
      });
      await setDoc(doc(db, path('scoreWorkflows', 'final:women:assigned-final')), {
        matchKey: 'final:women:assigned-final', draftState: 'idle', lock: null,
        draftRevision: 0, submissionVersion: 0, officialRevision: 0,
      });
      await setDoc(doc(db, path('courtQueues', 'final-clear-court')), {
        courtId: 'final-clear-court', currentMatchKey: finalAssignmentKey,
        nextMatchKey: finalAssignmentKey, normalCursorMatchKey: finalAssignmentKey,
        priorityEntries: [{
          entryId: `priority:${finalAssignmentKey}`, matchKey: finalAssignmentKey, kind: 'manual',
          enqueueSequence: 3, courtOrder: 2, eligibility: 'ready', sourceTransitionIds: [],
        }],
        nextPrioritySequence: 4, queueRevision: 8, lastTransitionId: 'seed:final-clear-queue',
      });
      await setDoc(doc(db, 'tournaments/main'), { courtTopologyRevision: 12 }, { merge: true });
    });
    const assignedClear = await call(functions, 'clearFinalStructure', {
      tournamentId: 'main', division: 'men',
    });
    assert.deepEqual(assignedClear.counts, {
      removedFinalMatches: 1, removedAssignments: 1, removedWorkflows: 1, affectedCourts: 1,
    }, 'final-clear-removes-pristine-assignment-graph');
    assert.equal(assignedClear.topologyRevision, 13, 'final-clear-returns-incremented-topology-revision');
    assert.equal((await f.seed((db) => getDoc(
      doc(db, path('courtAssignments', finalAssignmentKey)),
    ))).exists(), false, 'final-clear-deletes-final-assignment');
    assert.equal((await f.seed((db) => getDoc(
      doc(db, path('scoreWorkflows', finalAssignmentKey)),
    ))).exists(), false, 'final-clear-deletes-final-workflow');
    assert.equal((await f.seed((db) => getDoc(
      doc(db, path('courtAssignments', 'final:women:assigned-final')),
    ))).exists(), true, 'final-clear-preserves-same-id-other-division-assignment');
    await f.seed(async (db) => {
      await deleteDoc(doc(db, 'tournaments/main/divisions/women/finalMatches/assigned-final'));
      await deleteDoc(doc(db, path('courtAssignments', 'final:women:assigned-final')));
      await deleteDoc(doc(db, path('scoreWorkflows', 'final:women:assigned-final')));
    });
    const finalClearSurvivor = await f.seed((db) => getDoc(doc(db, path('courtAssignments', 'final-clear-survivor'))));
    assert.equal(finalClearSurvivor.data().courtOrder, 1, 'final-clear-relinks-surviving-prelim-order');
    assert.equal(finalClearSurvivor.data().nextCourtMatchKey, null, 'final-clear-relinks-surviving-prelim-next');
    const finalClearQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'final-clear-court'))));
    assert.equal(finalClearQueue.data().currentMatchKey, 'final-clear-survivor', 'final-clear-cleans-current-key');
    assert.equal(finalClearQueue.data().nextMatchKey, null, 'final-clear-cleans-next-key');
    assert.equal(finalClearQueue.data().normalCursorMatchKey, 'final-clear-survivor', 'final-clear-cleans-normal-cursor');
    assert.deepEqual(finalClearQueue.data().priorityEntries, [], 'final-clear-cleans-priority-key');
    assert.equal(finalClearQueue.data().queueRevision, 9, 'final-clear-increments-queue-revision');
    assert.equal((await f.seed((db) => getDoc(doc(db, 'tournaments/main')))).data().courtTopologyRevision, 13, 'final-clear-increments-topology-revision');

    const rejectedFinalCases = [
      {
        id: 'locked-final',
        workflow: {
          matchKey: 'final:men:locked-final', draftState: 'editing', lock: { uid: 'recorder' },
          draftRevision: 1, submissionVersion: 0, officialRevision: 0,
        },
      },
      {
        id: 'submitted-final',
        workflow: {
          matchKey: 'final:men:submitted-final', draftState: 'submitted', lock: null,
          submittedSnapshot: { sets: [{ a: 10, b: 8 }] }, draftRevision: 1, submissionVersion: 1, officialRevision: 0,
        },
      },
      {
        id: 'rejected-final',
        workflow: {
          matchKey: 'final:men:rejected-final', draftState: 'rejected', lock: null,
          draftRevision: 0, submissionVersion: 0, officialRevision: 0,
        },
      },
      {
        id: 'scored-final',
        final: { status: 'done', sets: [{ a: 10, b: 8 }], result: 'A', winner: 'A', officialRevision: 1 },
      },
      {
        id: 'confirmed-bye-final',
        final: {
          status: 'bye', winnerSide: 'A', winnerTeam: { id: 'bye-team' },
          nextMatchId: 'propagated-final', nextSlot: 'A',
        },
        propagated: { id: 'propagated-final', status: 'waiting', teamA: { id: 'bye-team' } },
      },
      {
        id: 'upstream-source-final',
        final: {
          status: 'waiting',
          teamA: { id: 'bye-team' },
          teamASource: { type: 'upstream', matchKey: 'final:men:bye-origin' },
        },
      },
      { id: 'missing-workflow-final', noWorkflow: true },
    ];
    for (const rejected of rejectedFinalCases) {
      const key = `final:men:${rejected.id}`;
      await f.seed(async (db) => {
        await setDoc(doc(db, 'tournaments/main/divisions/men/finalMatches', rejected.id), {
          id: rejected.id, status: 'pending', ...(rejected.final || {}),
        });
        if (rejected.propagated) {
          await setDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/propagated-final'), rejected.propagated);
        }
        await setDoc(doc(db, path('courtAssignments', key)), {
          matchKey: key, matchType: 'final', matchId: rejected.id, divisionId: 'men',
          courtId: null, courtOrder: null, nextCourtMatchKey: null, publicStatus: 'scheduled',
        });
        if (!rejected.noWorkflow) await setDoc(doc(db, path('scoreWorkflows', key)), rejected.workflow || {
          matchKey: key, draftState: 'idle', lock: null,
          draftRevision: 0, submissionVersion: 0, officialRevision: 0,
        });
      });
      const before = await f.seed(async (db) => ({
        tournament: (await getDoc(doc(db, 'tournaments/main'))).data(),
        final: (await getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches', rejected.id))).data(),
        propagated: rejected.propagated
          ? (await getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/propagated-final'))).data()
          : null,
        assignment: (await getDoc(doc(db, path('courtAssignments', key)))).data(),
        workflow: rejected.noWorkflow ? null : (await getDoc(doc(db, path('scoreWorkflows', key)))).data(),
      }));
      await assert.rejects(call(functions, 'clearFinalStructure', {
        tournamentId: 'main', division: 'men',
      }), undefined, `final-clear-${rejected.id}-rejected`);
      const after = await f.seed(async (db) => ({
        tournament: (await getDoc(doc(db, 'tournaments/main'))).data(),
        final: (await getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches', rejected.id))).data(),
        propagated: rejected.propagated
          ? (await getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/propagated-final'))).data()
          : null,
        assignment: (await getDoc(doc(db, path('courtAssignments', key)))).data(),
        workflow: rejected.noWorkflow ? null : (await getDoc(doc(db, path('scoreWorkflows', key)))).data(),
      }));
      assert.deepEqual(after, before, `final-clear-${rejected.id}-zero-writes`);
      await f.seed(async (db) => {
        await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches', rejected.id));
        if (rejected.propagated) await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/propagated-final'));
        await deleteDoc(doc(db, path('courtAssignments', key)));
        if (!rejected.noWorkflow) await deleteDoc(doc(db, path('scoreWorkflows', key)));
      });
    }
    try {
      await f.seed(async (db) => {
        for (const id of ['bye-team', 'opponent-team', 'other-team']) {
          await setDoc(doc(db, path('teams', id)), { id, division: 'men', name: id });
        }
      });
      await call(functions, 'publishFinalStructure', {
        tournamentId: 'main',
        division: 'men',
        expectedMatches: [],
        scoreDrafts: [],
        matches: [
          {
            id: 'published-confirmed-bye',
            round: 1,
            index: 0,
            status: 'bye',
            teamA: { id: 'bye-team', name: 'BYE Team' },
            teamASource: { type: 'seed', teamId: 'bye-team' },
            teamB: null,
            teamBSource: null,
            nextMatchId: 'published-bye-final',
            nextSlot: 'A',
          },
          {
            id: 'published-bye-downstream',
            round: 1,
            index: 1,
            status: 'pending',
            teamA: { id: 'opponent-team', name: 'Opponent Team' },
            teamASource: { type: 'seed', teamId: 'opponent-team' },
            teamB: { id: 'other-team', name: 'Other Team' },
            teamBSource: { type: 'seed', teamId: 'opponent-team' },
            nextMatchId: 'published-bye-final',
            nextSlot: 'B',
          },
          {
            id: 'published-bye-final',
            round: 2,
            index: 0,
            status: 'waiting',
            teamA: null,
            teamASource: null,
            teamB: null,
            teamBSource: null,
            nextMatchId: null,
            nextSlot: 'A',
          },
        ],
      });
      const publishedBye = await f.seed((db) => getDoc(
        doc(db, 'tournaments/main/divisions/men/finalMatches/published-confirmed-bye'),
      ));
      const publishedDownstream = await f.seed((db) => getDoc(
        doc(db, 'tournaments/main/divisions/men/finalMatches/published-bye-final'),
      ));
      assert.equal(publishedBye.data().status, 'bye', 'final-publication-retains-confirmed-bye-status');
      assert.deepEqual(publishedBye.data().teamA, { id: 'bye-team', name: 'bye-team' }, 'final-publication-canonicalizes-bye-entrant');
      assert.deepEqual(publishedDownstream.data().teamA, { id: 'bye-team', name: 'bye-team' }, 'final-publication-canonicalizes-bye-downstream-entrant');
      assert.deepEqual(publishedDownstream.data().teamASource, {
        type: 'upstream', matchKey: 'final:men:published-confirmed-bye',
      }, 'final-publication-persists-upstream-source');
      assert.equal(publishedDownstream.data().nextSlot, null, 'final-publication-normalizes-legacy-championship-next-slot');
      for (const field of [
        'score', 'sets', 'result', 'winner',
        'setsWonA', 'setsWonB', 'pointsForA', 'pointsForB',
        'officialSnapshot',
      ]) {
        assert.equal(Object.hasOwn(publishedBye.data(), field), false, `final-publication-strips-bye-${field}`);
      }
      const beforeByeClear = await f.seed(async (db) => ({
        bye: (await getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/published-confirmed-bye'))).data(),
        downstream: (await getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/published-bye-final'))).data(),
      }));
      await assert.rejects(call(functions, 'clearFinalStructure', {
        tournamentId: 'main', division: 'men',
      }), undefined, 'final-clear-rejects-published-confirmed-bye');
      const afterByeClear = await f.seed(async (db) => ({
        bye: (await getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/published-confirmed-bye'))).data(),
        downstream: (await getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/published-bye-final'))).data(),
      }));
      assert.deepEqual(afterByeClear, beforeByeClear, 'final-clear-preserves-published-confirmed-bye-graph');
    } finally {
      await f.seed(async (db) => {
        await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/published-confirmed-bye'));
        await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/published-bye-downstream'));
        await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/published-bye-final'));
        await deleteDoc(doc(db, path('courtAssignments', 'final:men:published-bye-downstream')));
        await deleteDoc(doc(db, path('scoreWorkflows', 'final:men:published-bye-downstream')));
        for (const id of ['bye-team', 'opponent-team', 'other-team']) {
          await deleteDoc(doc(db, path('teams', id)));
        }
      });
    }
    await f.seed((db) => setDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/publish-empty-clear'), {
      id: 'publish-empty-clear', status: 'empty', officialRevision: 0, lastTransitionId: 'seed:empty-clear',
    }));
    await call(functions, 'publishFinalStructure', {
      tournamentId: 'main', division: 'men',
      expectedMatches: [{ id: 'publish-empty-clear', lastTransitionId: 'seed:empty-clear', officialRevision: 0 }],
      matches: [], scoreDrafts: [],
    });
    assert.equal((await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/men/finalMatches/publish-empty-clear'),
    ))).exists(), false, 'final-publish-empty-cas-clears-pristine-structure');
    await f.seed((db) => setDoc(doc(db, path('teams', 'pending-bye-team')), {
      id: 'pending-bye-team', division: 'men', name: 'Pending BYE',
    }));
    const pendingByePublish = await call(functions, 'publishFinalStructure', {
      tournamentId: 'main', division: 'men', expectedMatches: [], scoreDrafts: [],
      matches: [
        {
          id: 'pending-bye-root', round: 1, index: 0, status: 'bye_pending',
          teamA: { id: 'pending-bye-team', name: 'Pending BYE' },
          teamB: null, teamASource: { type: 'seed', teamId: 'pending-bye-team' }, teamBSource: null,
          nextMatchId: 'pending-bye-final', nextSlot: 'A',
        },
        {
          id: 'pending-bye-root-other', round: 1, index: 1, status: 'empty',
          teamA: null, teamB: null, teamASource: null, teamBSource: null,
          nextMatchId: 'pending-bye-final', nextSlot: 'B',
        },
        {
          id: 'pending-bye-final', round: 2, index: 0, status: 'waiting',
          teamA: null, teamB: null, teamASource: null, teamBSource: null, nextMatchId: null, nextSlot: null,
        },
      ],
    });
    assert.equal(pendingByePublish.matches.find((match) => match.id === 'pending-bye-final').teamA, null, 'final-publish-does-not-propagate-bye-pending');
    await f.seed(async (db) => {
      for (const id of ['pending-bye-root', 'pending-bye-root-other', 'pending-bye-final']) {
        await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches', id));
      }
      await deleteDoc(doc(db, path('teams', 'pending-bye-team')));
    });
    await f.seed(async (db) => {
      for (const id of ['recorded-a', 'recorded-b', 'recorded-c']) {
        await setDoc(doc(db, path('teams', id)), { id, division: 'men', name: id });
      }
    });
    const recordedStructure = (teamB = 'recorded-b') => [{
      id: 'recorded-final', round: 1, index: 0, status: 'pending',
      teamA: { id: 'recorded-a', name: 'recorded-a' }, teamB: { id: teamB, name: teamB },
      teamASource: { type: 'seed', teamId: 'recorded-a' }, teamBSource: { type: 'seed', teamId: teamB },
      nextMatchId: null, nextSlot: null,
    }];
    const recordedPublished = await call(functions, 'publishFinalStructure', {
      tournamentId: 'main', division: 'men', expectedMatches: [], matches: recordedStructure(),
      scoreDrafts: [{ matchId: 'recorded-final', sets: score, reason: '', expectedSubmissionVersion: 0 }],
    });
    const recordedBase = recordedPublished.matches.map((match) => ({
      id: match.id, lastTransitionId: match.lastTransitionId, officialRevision: match.officialRevision,
    })).sort((a, b) => a.id.localeCompare(b.id));
    await f.seed(async (db) => {
      await setDoc(doc(db, path('courtAssignments', 'final:men:recorded-final')), {
        publicStatus: 'under_review',
      }, { merge: true });
      await setDoc(doc(db, path('scoreWorkflows', 'final:men:recorded-final')), {
        draftState: 'submitted',
        submittedSnapshot: { sets: score },
        submissionVersion: 1,
        submission: { version: 1 },
        lock: null,
      }, { merge: true });
    });
    const identicalResubmission = await call(functions, 'publishFinalStructure', {
      tournamentId: 'main',
      division: 'men',
      expectedMatches: recordedBase,
      matches: recordedStructure(),
      scoreDrafts: [{ matchId: 'recorded-final', sets: score, reason: '', expectedSubmissionVersion: 1 }],
    });
    assert.equal(identicalResubmission.scoreRevisions['recorded-final'], 1, 'identical-final-resubmission-keeps-official-revision');
    const identicalReviewState = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'final:men:recorded-final'))),
      getDoc(doc(db, path('scoreWorkflows', 'final:men:recorded-final'))),
    ]));
    assert.equal(identicalReviewState[0].data().publicStatus, 'completed', 'identical-final-resubmission-completes-assignment');
    assert.equal(identicalReviewState[1].data().draftState, 'approved', 'identical-final-resubmission-completes-review');
    const identicalBase = identicalResubmission.matches.map((match) => ({
      id: match.id, lastTransitionId: match.lastTransitionId, officialRevision: match.officialRevision,
    })).sort((a, b) => a.id.localeCompare(b.id));
    const unchangedRecorded = await call(functions, 'publishFinalStructure', {
      tournamentId: 'main', division: 'men', expectedMatches: identicalBase, matches: recordedStructure(), scoreDrafts: [],
    });
    assert.equal(unchangedRecorded.scoreRevisions['recorded-final'], 1, 'final-publish-preserves-unchanged-approved-score');
    const unchangedBase = unchangedRecorded.matches.map((match) => ({
      id: match.id, lastTransitionId: match.lastTransitionId, officialRevision: match.officialRevision,
    })).sort((a, b) => a.id.localeCompare(b.id));
    await assert.rejects(call(functions, 'publishFinalStructure', {
      tournamentId: 'main', division: 'men', expectedMatches: unchangedBase, matches: recordedStructure('recorded-c'), scoreDrafts: [],
    }), /Recorded final/, 'final-publish-rejects-recorded-entrant-retarget');
    const correctedRecorded = await call(functions, 'publishFinalStructure', {
      tournamentId: 'main',
      division: 'men',
      expectedMatches: unchangedBase,
      matches: recordedStructure(),
      scoreDrafts: [{
        matchId: 'recorded-final',
        sets: [{ a: 8, b: 10 }, { a: 7, b: 10 }],
        reason: '기록지 대조 후 승자 정정',
        expectedSubmissionVersion: 1,
      }],
    });
    assert.equal(correctedRecorded.scoreRevisions['recorded-final'], 2, 'final-score-correction-increments-revision');
    const correctionAudit = await f.seed((db) => getDoc(
      doc(db, path('auditEvents', correctedRecorded.transitionId)),
    ));
    assert.deepEqual(correctionAudit.data().after.finalCorrectionReasons, [{
      matchId: 'recorded-final',
      fromRevision: 1,
      toRevision: 2,
      reason: '기록지 대조 후 승자 정정',
    }], 'final-score-correction-reason-is-immutable-audit-data');
    await f.seed(async (db) => {
      await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/recorded-final'));
      await deleteDoc(doc(db, path('courtAssignments', 'final:men:recorded-final')));
      await deleteDoc(doc(db, path('scoreWorkflows', 'final:men:recorded-final')));
      for (const id of ['recorded-a', 'recorded-b', 'recorded-c']) await deleteDoc(doc(db, path('teams', id)));
    });
    const dependencyTeams = ['dependency-a', 'dependency-b', 'dependency-c', 'dependency-d'];
    const dependencyFinalKey = 'final:men:dependency-final';
    await f.seed(async (db) => {
      for (const id of dependencyTeams) {
        await setDoc(doc(db, path('teams', id)), { id, division: 'men', name: id });
      }
      await setDoc(doc(db, path('courtAssignments', dependencyFinalKey)), {
        matchKey: dependencyFinalKey, matchType: 'final', matchId: 'dependency-final',
        divisionId: 'men', division: 'men', courtId: 'dependency-court', courtOrder: 1,
        nextCourtMatchKey: null, publicStatus: 'scheduled', dependencyReady: false,
        officialRevision: 0, lastTransitionId: 'seed:dependency-final',
      });
      await setDoc(doc(db, path('scoreWorkflows', dependencyFinalKey)), {
        matchKey: dependencyFinalKey, draftState: 'idle', lock: null,
        draftRevision: 0, submissionVersion: 0, officialRevision: 0,
        lastTransitionId: 'seed:dependency-final',
      });
      await setDoc(doc(db, path('courtQueues', 'dependency-court')), {
        courtId: 'dependency-court', currentMatchKey: null, nextMatchKey: null, normalCursorMatchKey: null,
        priorityEntries: [{
          entryId: `blocked:${dependencyFinalKey}`, matchKey: dependencyFinalKey, kind: 'manual',
          enqueueSequence: 0, pathDepth: 0, courtOrder: 1, eligibility: 'blocked_dependency', sourceTransitionIds: [],
        }],
        nextPrioritySequence: 1, queueRevision: 0, lastTransitionId: 'seed:dependency-queue',
      });
    });
    const dependencyStructure = [
      {
        id: 'dependency-semi-a', round: 1, index: 0, status: 'pending',
        teamA: { id: 'dependency-a', name: 'dependency-a' }, teamB: { id: 'dependency-b', name: 'dependency-b' },
        teamASource: { type: 'seed', teamId: 'dependency-a' }, teamBSource: { type: 'seed', teamId: 'dependency-b' },
        nextMatchId: 'dependency-final', nextSlot: 'A',
      },
      {
        id: 'dependency-semi-b', round: 1, index: 1, status: 'pending',
        teamA: { id: 'dependency-c', name: 'dependency-c' }, teamB: { id: 'dependency-d', name: 'dependency-d' },
        teamASource: { type: 'seed', teamId: 'dependency-c' }, teamBSource: { type: 'seed', teamId: 'dependency-d' },
        nextMatchId: 'dependency-final', nextSlot: 'B',
      },
      {
        id: 'dependency-final', round: 2, index: 0, status: 'waiting',
        teamA: null, teamB: null, teamASource: null, teamBSource: null, nextMatchId: null, nextSlot: null,
      },
    ];
    const dependencyFirst = await call(functions, 'publishFinalStructure', {
      tournamentId: 'main', division: 'men', expectedMatches: [], matches: dependencyStructure,
      scoreDrafts: [{ matchId: 'dependency-semi-a', sets: score, reason: '', expectedSubmissionVersion: 0 }],
    });
    const dependencyBaseline = dependencyFirst.matches.map((match) => ({
      id: match.id, lastTransitionId: match.lastTransitionId, officialRevision: match.officialRevision,
    })).sort((a, b) => a.id.localeCompare(b.id));
    await call(functions, 'publishFinalStructure', {
      tournamentId: 'main', division: 'men', expectedMatches: dependencyBaseline, matches: dependencyStructure,
      scoreDrafts: [{ matchId: 'dependency-semi-b', sets: score, reason: '', expectedSubmissionVersion: 0 }],
    });
    const dependencyFinal = await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/men/finalMatches/dependency-final'),
    ));
    const dependencyAssignment = await f.seed((db) => getDoc(doc(db, path('courtAssignments', dependencyFinalKey))));
    const dependencyQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'dependency-court'))));
    assert.equal(dependencyFinal.data().teamA.id, 'dependency-a', 'final-publish-propagates-first-semifinal-entrant');
    assert.equal(dependencyFinal.data().teamB.id, 'dependency-c', 'final-publish-propagates-second-semifinal-entrant');
    assert.equal(dependencyAssignment.data().dependencyReady, true, 'final-publish-activates-preassigned-final-dependency');
    assert.equal(dependencyQueue.data().priorityEntries[0].eligibility, 'ready', 'final-publish-activates-blocked-final-priority');
    await f.seed(async (db) => {
      for (const id of ['dependency-semi-a', 'dependency-semi-b', 'dependency-final']) {
        await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches', id));
        await deleteDoc(doc(db, path('courtAssignments', `final:men:${id}`)));
        await deleteDoc(doc(db, path('scoreWorkflows', `final:men:${id}`)));
      }
      await deleteDoc(doc(db, path('courtQueues', 'dependency-court')));
      for (const id of dependencyTeams) await deleteDoc(doc(db, path('teams', id)));
    });

    await f.seed(async (db) => {
      await setDoc(doc(db, path('groups', 'clean-group')), { division: 'men', name: 'Clean' });
      await setDoc(doc(db, path('prelimMatches', 'clean-remove')), {
        groupId: 'clean-group', division: 'men', teamA: 'a', teamB: 'b', round: 1, sets: [], status: 'pending', result: null,
      });
      await setDoc(doc(db, path('prelimMatches', 'clean-before')), {
        groupId: 'other-group', division: 'men', teamA: 'e', teamB: 'f', round: 1, sets: [], status: 'pending', result: null,
      });
      await setDoc(doc(db, path('prelimMatches', 'clean-survivor')), {
        groupId: 'other-group', division: 'men', teamA: 'c', teamB: 'd', round: 1, sets: [], status: 'pending', result: null,
      });
      for (const id of ['clean-before', 'clean-remove', 'clean-survivor']) {
        const order = { 'clean-before': 1, 'clean-remove': 2, 'clean-survivor': 3 }[id];
        const next = { 'clean-before': 'clean-remove', 'clean-remove': 'clean-survivor', 'clean-survivor': null }[id];
        await setDoc(doc(db, path('courtAssignments', id)), {
          matchKey: id, matchType: 'prelim', matchId: id, division: 'men', courtId: 'clean-court',
          courtOrder: order, nextCourtMatchKey: next,
          publicStatus: 'scheduled', lastTransitionId: `seed:${id}`,
        });
        await setDoc(doc(db, path('scoreWorkflows', id)), {
          matchKey: id, draftState: 'idle', lock: null, draft: { sets: [] }, submittedSnapshot: null,
          draftRevision: 0, submissionVersion: 0, officialRevision: 0, lastTransitionId: `seed:${id}`,
        });
      }
      await setDoc(doc(db, path('courtQueues', 'clean-court')), {
        courtId: 'clean-court', currentMatchKey: 'clean-before', nextMatchKey: 'clean-remove',
        normalCursorMatchKey: 'clean-before',
        priorityEntries: [{
          entryId: 'priority:clean-remove', matchKey: 'clean-remove', kind: 'manual',
          enqueueSequence: 0, courtOrder: 1, eligibility: 'ready', sourceTransitionIds: [],
        }],
        nextPrioritySequence: 1, queueRevision: 0, lastTransitionId: 'seed:clean',
      });
    });
    const removal = await call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'clear_group_prelim', division: 'men', groupId: 'clean-group', ringOrder: [],
    });
    assert.deepEqual(removal.counts, { removedMatches: 1, removedAssignments: 1, createdMatches: 0, affectedCourts: 1 }, 'prelim-removal-counts');
    assert.equal((await f.seed((db) => getDoc(doc(db, path('prelimMatches', 'clean-remove'))))).exists(), false, 'prelim-removal-deletes-match');
    assert.equal((await f.seed((db) => getDoc(doc(db, path('courtAssignments', 'clean-remove'))))).exists(), false, 'prelim-removal-deletes-assignment');
    assert.equal((await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'clean-remove'))))).exists(), false, 'prelim-removal-deletes-workflow');
    const cleanedQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'clean-court'))));
    assert.equal(cleanedQueue.data().currentMatchKey, 'clean-before', 'prelim-removal-reprojects-current');
    assert.equal(cleanedQueue.data().nextMatchKey, 'clean-survivor', 'prelim-removal-reprojects-next');
    assert.equal(cleanedQueue.data().normalCursorMatchKey, 'clean-before', 'prelim-removal-reprojects-cursor');
    assert.deepEqual(cleanedQueue.data().priorityEntries, [], 'prelim-removal-cleans-priority');
    const relinkedBefore = await f.seed((db) => getDoc(doc(db, path('courtAssignments', 'clean-before'))));
    const relinkedSurvivor = await f.seed((db) => getDoc(doc(db, path('courtAssignments', 'clean-survivor'))));
    assert.equal(relinkedBefore.data().courtOrder, 1, 'prelim-removal-densifies-first-order');
    assert.equal(relinkedBefore.data().nextCourtMatchKey, 'clean-survivor', 'prelim-removal-relinks-next');
    assert.equal(relinkedSurvivor.data().courtOrder, 2, 'prelim-removal-densifies-second-order');

    await f.seed(async (db) => {
      await setDoc(doc(db, path('groups', 'pair-group')), { division: 'men', name: 'Pairs' });
      for (const id of ['pair-a', 'pair-b', 'pair-c']) {
        await setDoc(doc(db, path('teams', id)), { division: 'men', groupId: 'pair-group', name: id });
      }
    });
    const roundRobin = await call(functions, 'mutatePrelimStructure', {
      ...data,
      operation: 'generate_group_round_robin',
      division: 'men',
      groupId: 'pair-group',
      teamIds: ['pair-a', 'pair-b', 'pair-c'],
    });
    assert.equal(roundRobin.createdMatchIds.length, 3, 'round-robin-creates-every-pair');
    let generated = await f.seed((db) => getDocs(collection(db, 'tournaments/main/prelimMatches')));
    const pairs = generated.docs.filter((snap) => roundRobin.createdMatchIds.includes(snap.id))
      .map((snap) => [snap.data().teamA, snap.data().teamB, snap.data().round]).sort();
    assert.deepEqual(pairs, [['pair-a', 'pair-b', 2], ['pair-a', 'pair-c', 3], ['pair-b', 'pair-c', 1]], 'round-robin-canonical-pairs');
    await assert.rejects(call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'generate_group_ring', division: 'men', groupId: 'pair-group', ringOrder: ['pair-a', 'pair-b'],
    }), /every group team exactly once/i, 'ring-requires-exact-membership');
    const ring = await call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'generate_group_ring', division: 'men', groupId: 'pair-group', ringOrder: ['pair-c', 'pair-a', 'pair-b'],
    });
    generated = await f.seed((db) => getDocs(collection(db, 'tournaments/main/prelimMatches')));
    const ringPairs = generated.docs.filter((snap) => ring.createdMatchIds.includes(snap.id))
      .map((snap) => [snap.data().teamA, snap.data().teamB, snap.data().round]).sort();
    assert.deepEqual(ringPairs, [['pair-a', 'pair-b', 2], ['pair-b', 'pair-c', 3], ['pair-c', 'pair-a', 1]], 'ring-uses-requested-order');
    const ringGroup = await f.seed((db) => getDoc(doc(db, path('groups', 'pair-group'))));
    assert.deepEqual(ringGroup.data().ringOrder, ['pair-c', 'pair-a', 'pair-b'], 'ring-order-written-with-ring');
    const immediateScoreMatchId = ring.createdMatchIds[0];
    const generatedPair = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', immediateScoreMatchId))),
      getDoc(doc(db, path('scoreWorkflows', immediateScoreMatchId))),
    ]));
    assert.equal(generatedPair[0].data().courtId, null, 'generated-prelim-assignment-is-unassigned');
    assert.equal(generatedPair[1].data().draftState, 'idle', 'generated-prelim-workflow-is-idle');
    await call(functions, 'directEditOfficialScore', {
      ...data,
      matchKey: immediateScoreMatchId,
      score: { sets: score },
      reason: '생성 직후 관리자 기록',
      expectedOfficialRevision: 0,
      expectedQueueRevision: null,
    });
    assert.equal(
      (await f.seed((db) => getDoc(doc(db, path('prelimMatches', immediateScoreMatchId))))).data().status,
      'done',
      'generated-prelim-can-be-scored-immediately',
    );
    await f.seed(async (db) => {
      for (const matchId of ring.createdMatchIds) {
        await deleteDoc(doc(db, path('prelimMatches', matchId)));
        await deleteDoc(doc(db, path('courtAssignments', matchId)));
        await deleteDoc(doc(db, path('scoreWorkflows', matchId)));
      }
    });

    await f.seed(async (db) => {
      await setDoc(doc(db, path('groups', 'team-group')), { division: 'men' });
      await setDoc(doc(db, path('teams', 'referenced-team')), { division: 'men', groupId: 'team-group' });
      await setDoc(doc(db, path('prelimMatches', 'team-reference')), {
        groupId: 'team-group', division: 'men', teamA: 'referenced-team', teamB: 'pair-a', round: 1, sets: [], status: 'pending', result: null,
      });
    });
    await assert.rejects(call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'delete_team', division: 'men', teamId: 'referenced-team',
    }), /referenced/i, 'referenced-team-delete-rejected');
    await call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'clear_group_prelim', division: 'men', groupId: 'team-group', ringOrder: [],
    });
    await call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'delete_team', division: 'men', teamId: 'referenced-team',
    });
    assert.equal((await f.seed((db) => getDoc(doc(db, path('teams', 'referenced-team'))))).exists(), false, 'unreferenced-team-delete-succeeds');
    const bulkTeamReset = await call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'delete_all_teams', division: 'men',
    });
    assert.ok(bulkTeamReset.counts.removedMatches >= 3, 'bulk-team-reset-removes-pristine-matches');
    assert.equal((await f.seed((db) => getDoc(doc(db, path('teams', 'pair-a'))))).exists(), false, 'bulk-team-reset-deletes-teams');
    assert.equal((await f.seed((db) => getDoc(doc(db, path('courtAssignments', 'clean-before'))))).exists(), false, 'bulk-team-reset-deletes-pristine-assignments');
    assert.equal((await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'clean-survivor'))))).exists(), false, 'bulk-team-reset-deletes-pristine-workflows');
    const emptiedQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'clean-court'))));
    assert.equal(emptiedQueue.data().currentMatchKey, null, 'bulk-team-reset-empties-current-queue');
    assert.equal(emptiedQueue.data().nextMatchKey, null, 'bulk-team-reset-empties-next-queue');

    const blockedStates = ['editing', 'submitted', 'rejected', 'approved'];
    await f.seed(async (db) => {
      for (const state of blockedStates) {
        const id = `blocked-${state}`;
        await setDoc(doc(db, path('groups', id)), { division: 'men' });
        await setDoc(doc(db, path('prelimMatches', id)), {
          groupId: id, division: 'men', teamA: 'a', teamB: 'b', round: 1, sets: [], status: 'pending', result: null,
        });
        await setDoc(doc(db, path('courtAssignments', id)), {
          matchKey: id, matchType: 'prelim', matchId: id, division: 'men', courtId: null,
          courtOrder: null, nextCourtMatchKey: null, publicStatus: state === 'editing' ? 'in_progress' : 'scheduled',
        });
        await setDoc(doc(db, path('scoreWorkflows', id)), {
          matchKey: id, draftState: state, lock: state === 'editing' ? { uid: 'recorder' } : null,
          draft: { sets: [] }, submittedSnapshot: state === 'submitted' ? { sets: [] } : null,
          draftRevision: 0, submissionVersion: state === 'submitted' ? 1 : 0, officialRevision: state === 'approved' ? 1 : 0,
        });
      }
      await setDoc(doc(db, path('groups', 'blocked-history')), { division: 'men' });
      await setDoc(doc(db, path('prelimMatches', 'blocked-history')), {
        groupId: 'blocked-history', division: 'men', teamA: 'a', teamB: 'b', round: 1, sets: [{ a: 10, b: 8 }], status: 'done', result: 'A',
      });
    });
    for (const state of [...blockedStates, 'history']) {
      const id = `blocked-${state}`;
      const before = await f.seed(async (db) => ({
        match: (await getDoc(doc(db, path('prelimMatches', id)))).data(),
        assignment: state === 'history' ? null : (await getDoc(doc(db, path('courtAssignments', id)))).data(),
        workflow: state === 'history' ? null : (await getDoc(doc(db, path('scoreWorkflows', id)))).data(),
      }));
      await assert.rejects(call(functions, 'mutatePrelimStructure', {
        ...data, operation: 'clear_group_prelim', division: 'men', groupId: id, ringOrder: [],
      }), /preliminary match has official history|not pristine/i, `blocked-${state}-rejected`);
      const after = await f.seed(async (db) => ({
        match: (await getDoc(doc(db, path('prelimMatches', id)))).data(),
        assignment: state === 'history' ? null : (await getDoc(doc(db, path('courtAssignments', id)))).data(),
        workflow: state === 'history' ? null : (await getDoc(doc(db, path('scoreWorkflows', id)))).data(),
      }));
      assert.deepEqual(after, before, `blocked-${state}-zero-writes`);
    }
    await f.seed(async (db) => {
      await setDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/final-block'), { id: 'final-block' });
      await setDoc(doc(db, path('groups', 'women-group')), { division: 'women' });
      await setDoc(doc(db, path('prelimMatches', 'women-match')), {
        groupId: 'women-group', division: 'women', teamA: 'w1', teamB: 'w2', round: 1, sets: [], status: 'pending', result: null,
      });
    });
    const menBeforeFinalBlock = await f.seed((db) => getDoc(doc(db, path('prelimMatches', 'blocked-history'))));
    await assert.rejects(call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'clear_division_prelim', division: 'men',
    }), /final structure exists/i, 'final-bracket-blocks-men-prelim-mutation');
    const menAfterFinalBlock = await f.seed((db) => getDoc(doc(db, path('prelimMatches', 'blocked-history'))));
    assert.deepEqual(menAfterFinalBlock.data(), menBeforeFinalBlock.data(), 'final-block-zero-writes');
    await call(functions, 'mutatePrelimStructure', {
      ...data, operation: 'clear_group_prelim', division: 'women', groupId: 'women-group', ringOrder: [],
    });
    assert.equal((await f.seed((db) => getDoc(doc(db, path('prelimMatches', 'women-match'))))).exists(), false, 'other-division-remains-mutable');
    assert.equal((await f.seed((db) => getDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/final-block')))).exists(), true, 'other-division-final-unchanged');
    await f.seed(async (db) => {
      for (const collectionPath of [
        'tournaments/main/groups',
        'tournaments/main/teams',
        'tournaments/main/auditEvents',
        'tournaments/main/divisions/men/finalMatches',
        'tournaments/main/divisions/women/finalMatches',
      ]) {
        const snapshots = await getDocs(collection(db, collectionPath));
        await Promise.all(snapshots.docs.map((snapshot) => deleteDoc(snapshot.ref)));
      }
      for (const [collectionName, preservedIds] of [
        ['prelimMatches', new Set(['M1', 'M2'])],
        ['courtAssignments', new Set(['M1', 'M2'])],
        ['scoreWorkflows', new Set(['M1', 'M2'])],
        ['courtQueues', new Set(['court-1'])],
      ]) {
        const snapshots = await getDocs(collection(db, `tournaments/main/${collectionName}`));
        await Promise.all(snapshots.docs
          .filter((snapshot) => !preservedIds.has(snapshot.id))
          .map((snapshot) => deleteDoc(snapshot.ref)));
      }
      await setDoc(doc(db, 'tournaments/main'), { courtTopologyRevision: 0 }, { merge: true });
    });
    const preparedCancellation = await call(functions, 'prepareTournamentReset', resetData);
    assert.equal(preparedCancellation.prepared, true, 'reset-prepare-seeded-admin-succeeds');
    await assert.rejects(call(functions, 'createRecorderAccessCode', data), /maintenance/i, 'reset-maintenance-rejects-admin-callables');
    await assert.rejects(call(functions, 'beginRestore', {
      ...data, manifestId: 'blocked-reset-restore', rootData: {}, chunks: [],
    }), /maintenance/i, 'reset-maintenance-rejects-restore');
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
    await assert.rejects(call(functions, 'exchangeRecorderAccessCode', { ...data, code: created.code }), /code_invalid/);
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
    const moveLockedDraft = {
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
    };
    await assert.rejects(
      call(functions, 'replaceCourtWorkflows', moveLockedDraft),
      /Live recorder lock/,
      'editing-move-rejects-recorder-identity-change',
    );
    await call(functions, 'replaceCourtWorkflows', {
      ...moveLockedDraft,
      courts: [
        { id: 'callable-court', name: 'A코트', recorderName: '기록원' },
        { id: 'destination', name: 'B코트', recorderName: '기록원' },
      ],
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
      draftState: 'editing', lock: { uid: 'other', token: 'other-lock', recorderName: '기록원' },
    }, { merge: true }));
    await assert.rejects(call(functions, 'replaceCourtWorkflows', {
      ...data,
      expectedTopologyRevision: 2,
      expectedQueueRevisions: { 'callable-court': 3, destination: 1 },
      courts: [{ id: 'destination', name: 'B코트', recorderName: '기록원' }],
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
      courts: [{ id: 'destination', name: 'B코트', recorderName: '기록원' }],
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
    await f.seed(async (db) => {
      await setDoc(doc(db, path('scoreWorkflows', 'M1')), {
        draftState: 'idle', lock: null,
      }, { merge: true });
      await setDoc(doc(db, path('courtAssignments', 'M1')), {
        publicStatus: 'scheduled',
      }, { merge: true });
    });
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
    const testSessionId = 'test-recorder-session-0001';
    const now = Date.now();
    await f.seed(async (db) => {
      await setDoc(doc(db, path('scoreWorkflows', 'M1')), {
        draftState: 'editing',
        lock: {
          uid: credential.user.uid,
          token: 'draft-lock',
          recorderName: '기록원',
          sessionId: testSessionId,
          acquiredAt: Timestamp.fromMillis(now),
          renewedAt: Timestamp.fromMillis(now),
          expiresAt: Timestamp.fromMillis(now + 180_000),
        },
      }, { merge: true });
      await setDoc(doc(db, path('courtAssignments', 'M1')), {
        publicStatus: 'in_progress',
      }, { merge: true });
      await setDoc(doc(db, path('prelimMatches', 'M1')), {
        teamA: 'test-team-a',
        teamB: 'test-team-b',
      }, { merge: true });
    });
    const unassignedSubmit = await call(functions, 'submitRecorderDraft', {
      ...data,
      matchKey: 'M1',
      courtId: null,
      token: 'draft-lock',
      sessionId: testSessionId,
      queueRevision: null,
      score: { sets: score },
      operationId: 'test-submit-operation-0001',
    });
    assert.equal(unassignedSubmit.queueRevision, null, 'unassigned-submit-has-no-queue-revision');
    const [submittedUnassignedAssignment, submittedUnassignedWorkflow] = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'M1'))),
      getDoc(doc(db, path('scoreWorkflows', 'M1'))),
    ]));
    assert.equal(submittedUnassignedAssignment.data().publicStatus, 'under_review', 'unassigned-submit-enters-review');
    assert.equal(submittedUnassignedWorkflow.data().draftState, 'submitted', 'unassigned-submit-preserves-review-workflow');
    assert.equal(submittedUnassignedWorkflow.data().submission.version, submittedUnassignedWorkflow.data().submissionVersion, 'submission-attribution-is-version-bound');
    assert.equal(submittedUnassignedWorkflow.data().submission.recorder.uid, credential.user.uid, 'submission-attribution-preserves-recorder-uid');
    assert.ok(submittedUnassignedWorkflow.data().submittedAt?.toMillis?.(), 'submission-attribution-preserves-server-time');
    const submissionAudit = await f.seed((db) => getDoc(doc(db, path('auditEvents', unassignedSubmit.transitionId))));
    assert.deepEqual(
      submissionAudit.data().after.workflow.submittedSnapshot,
      submittedUnassignedWorkflow.data().submittedSnapshot,
      'submission-audit-matches-persisted-score',
    );
    assert.equal(
      submissionAudit.data().after.workflow.lastTransitionId,
      submittedUnassignedWorkflow.data().lastTransitionId,
      'submission-audit-matches-persisted-transition',
    );
    await call(functions, 'rejectScoreReview', {
      ...data,
      matchKey: 'M1',
      reason: 'unassigned review test',
      expectedSubmissionVersion: submittedUnassignedWorkflow.data().submissionVersion,
      expectedQueueRevision: null,
    });
    const rejectedUnassignedWorkflow = await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    assert.equal(rejectedUnassignedWorkflow.data().rejectionReason, 'unassigned review test', 'rejection-reason-is-recorder-readable');
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
      const cancelNow = Date.now();
      await setDoc(doc(db, path('scoreWorkflows', 'M1')), {
        draftState: 'editing',
        resumeDraftState: 'rejected',
        lock: {
          uid: credential.user.uid,
          token: 'cancel-lock',
          recorderName: '기록원',
          sessionId: testSessionId,
          acquiredAt: Timestamp.fromMillis(cancelNow),
          renewedAt: Timestamp.fromMillis(cancelNow),
          expiresAt: Timestamp.fromMillis(cancelNow + 180_000),
        },
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
      sessionId: testSessionId,
      queueRevision: null,
      operationId: 'test-cancel-operation-0001',
      discardDraft: false,
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
        id: 'correction-court', name: '정정 코트', recorderName: 'Recorder One',
      });
      await setDoc(doc(db, path('courtAssignments', 'P1')), {
        matchKey: 'P1', matchType: 'prelim', matchId: 'P1', division: 'men',
        courtId: 'correction-court', courtOrder: 1, nextCourtMatchKey: 'P2', publicStatus: 'completed',
        attemptCount: 1, officialRevision: 1,
      });
      await setDoc(doc(db, path('courtAssignments', 'P2')), {
        matchKey: 'P2', matchType: 'prelim', matchId: 'P2', division: 'men',
        courtId: 'correction-court', courtOrder: 2, nextCourtMatchKey: null, publicStatus: 'completed',
        attemptCount: 1, officialRevision: 1,
      });
      await setDoc(doc(db, path('scoreWorkflows', 'P1')), {
        draftState: 'approved', lock: null, draftRevision: 0, submissionVersion: 1, officialRevision: 1,
      });
      await setDoc(doc(db, path('scoreWorkflows', 'P2')), {
        draftState: 'approved', lock: null, draftRevision: 0, submissionVersion: 1, officialRevision: 1,
      });
      await setDoc(doc(db, path('prelimMatches', 'P1')), {
        officialRevision: 1, lastTransitionId: 'server:P1:approved:1', status: 'done', result: 'A',
      });
      await setDoc(doc(db, path('prelimMatches', 'P2')), {
        officialRevision: 1, lastTransitionId: 'server:P2:approved:1', status: 'done', result: 'B',
        teamA: 'correction-team-a', teamB: 'correction-team-b',
      });
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
    assert.deepEqual(correctionPreview.planToken.matchKeys, ['P2'], 'server-correction-preview-sorted-targets');

    await f.seed((db) => setDoc(doc(db, path('prelimMatches', 'P2')), { officialRevision: 2 }, { merge: true }));
    await assert.rejects(call(functions, 'applyApprovedCorrection', {
      ...data, planToken: correctionPreview.planToken, reason: 'official revision changed',
    }), /Correction plan changed/, 'correction-rejects-official-revision-change');

    const workflowPreview = await call(functions, 'previewApprovedCorrection', { ...data, matchKeys: ['P2'] });
    await f.seed((db) => setDoc(doc(db, path('scoreWorkflows', 'P2')), { lastTransitionId: 'server:P2:workflow-change' }, { merge: true }));
    await assert.rejects(call(functions, 'applyApprovedCorrection', {
      ...data, planToken: workflowPreview.planToken, reason: 'workflow changed',
    }), /Correction plan changed/, 'correction-rejects-workflow-change');

    const assignmentPreview = await call(functions, 'previewApprovedCorrection', { ...data, matchKeys: ['P2'] });
    await f.seed((db) => setDoc(doc(db, path('courtAssignments', 'P2')), { lastTransitionId: 'server:P2:assignment-change' }, { merge: true }));
    await assert.rejects(call(functions, 'applyApprovedCorrection', {
      ...data, planToken: assignmentPreview.planToken, reason: 'assignment changed',
    }), /Correction plan changed/, 'correction-rejects-assignment-change');

    const queuePreview = await call(functions, 'previewApprovedCorrection', { ...data, matchKeys: ['P2'] });
    await f.seed((db) => setDoc(doc(db, path('courtQueues', 'correction-court')), { queueRevision: 1 }, { merge: true }));
    await assert.rejects(call(functions, 'applyApprovedCorrection', {
      ...data, planToken: queuePreview.planToken, reason: 'queue changed',
    }), /Correction plan changed/, 'correction-rejects-queue-change');

    const omittedQueueFieldPreview = await call(functions, 'previewApprovedCorrection', { ...data, matchKeys: ['P2'] });
    await f.seed((db) => setDoc(
      doc(db, path('courtQueues', 'correction-court')),
      { displayNote: 'changed after preview' },
      { merge: true },
    ));
    await assert.rejects(call(functions, 'applyApprovedCorrection', {
      ...data,
      planToken: omittedQueueFieldPreview.planToken,
      reason: 'omitted queue field changed',
    }), /Correction plan changed/, 'correction-rejects-any-queue-field-change');

    const tamperPreview = await call(functions, 'previewApprovedCorrection', { ...data, matchKeys: ['P2'] });
    await assert.rejects(call(functions, 'applyApprovedCorrection', {
      ...data,
      planToken: { ...tamperPreview.planToken, matchKeys: ['P1'] },
      reason: 'target tampered',
    }), /Correction plan changed/, 'correction-rejects-token-target-tamper');
    await assert.rejects(call(functions, 'applyApprovedCorrection', {
      ...data,
      planToken: { ...tamperPreview.planToken, fingerprint: '0'.repeat(64) },
      reason: 'fingerprint tampered',
    }), /Correction plan changed/, 'correction-rejects-token-fingerprint-tamper');

    const p1BeforeCorrection = await f.seed((db) => getDoc(doc(db, path('courtAssignments', 'P1'))));
    const successfulPreview = await call(functions, 'previewApprovedCorrection', { ...data, matchKeys: ['P2'] });
    await call(functions, 'applyApprovedCorrection', {
      ...data,
      planToken: successfulPreview.planToken,
      reason: 'preview/apply parity',
    });
    const appliedCorrectionQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'correction-court'))));
    assert.deepEqual(
      {
        currentMatchKey: appliedCorrectionQueue.data().currentMatchKey || null,
        nextMatchKey: appliedCorrectionQueue.data().nextMatchKey || null,
      },
      successfulPreview.projection.after,
      'server-preview-apply-projection-parity',
    );
    const [p1AfterCorrection, p2AfterCorrection] = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'P1'))),
      getDoc(doc(db, path('courtAssignments', 'P2'))),
    ]));
    assert.equal(p1AfterCorrection.data().publicStatus, p1BeforeCorrection.data().publicStatus, 'correction-updates-only-previewed-targets');
    assert.equal(p2AfterCorrection.data().publicStatus, successfulPreview.projection.replayMatchKeys.includes('P2') ? 'replay_required' : 'completed', 'correction-applies-previewed-target');
    const retractedP2 = await f.seed((db) => getDoc(doc(db, path('prelimMatches', 'P2'))));
    assert.equal(retractedP2.data().officialCurrent, false, 'correction-retracts-public-official-result');
    assert.deepEqual(retractedP2.data().sets, [], 'correction-clears-public-score-fields');
    assert.equal(retractedP2.data().result, null, 'correction-clears-public-result');
    if (p2AfterCorrection.data().publicStatus === 'replay_required') {
      const replaySessionId = 'correction-replay-session-0001';
      const reclaimedResult = await call(functions, 'claimRecorderDraft', {
        ...data,
        matchKey: 'P2',
        courtId: 'correction-court',
        recorderName: 'Recorder One',
        sessionId: replaySessionId,
        queueRevision: appliedCorrectionQueue.data().queueRevision,
      });
      assert.equal(reclaimedResult.sessionId, replaySessionId, 'correction-replay-claim-binds-session');
      const reclaimed = await f.seed(async (db) => Promise.all([
        getDoc(doc(db, path('courtAssignments', 'P2'))),
        getDoc(doc(db, path('scoreWorkflows', 'P2'))),
      ]));
      assert.equal(reclaimed[0].data().publicStatus, 'in_progress', 'correction-replay-is-recorder-claimable');
      assert.equal(reclaimed[1].data().draftState, 'editing', 'correction-replay-enters-editing');
    }
    const beforeReuse = {
      queue: (await f.seed((db) => getDoc(doc(db, path('courtQueues', 'correction-court'))))).data(),
      p1: (await f.seed((db) => getDoc(doc(db, path('courtAssignments', 'P1'))))).data(),
      p2: (await f.seed((db) => getDoc(doc(db, path('courtAssignments', 'P2'))))).data(),
    };
    await assert.rejects(call(functions, 'applyApprovedCorrection', {
      ...data, planToken: successfulPreview.planToken, reason: 'reused token',
    }), /Correction plan changed/, 'correction-rejects-token-reuse');
    const [queueAfterReuse, p1AfterReuse, p2AfterReuse] = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtQueues', 'correction-court'))),
      getDoc(doc(db, path('courtAssignments', 'P1'))),
      getDoc(doc(db, path('courtAssignments', 'P2'))),
    ]));
    assert.deepEqual(
      { queue: queueAfterReuse.data(), p1: p1AfterReuse.data(), p2: p2AfterReuse.data() },
      beforeReuse,
      'correction-token-reuse-zero-write',
    );

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
        submission: { version: 1, recorder: { uid: 'approval-recorder', name: '기록원' } },
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
      const seedMatch = async (id, assignment = {}, workflow = {}, match = {}) => {
        await setDoc(doc(db, path('prelimMatches', id)), {
          teamA: `${id}-a`, teamB: `${id}-b`, sets: [], status: 'pending', result: null,
          officialRevision: 0, ...match,
        });
        await setDoc(doc(db, path('courtAssignments', id)), {
          matchKey: id, matchType: 'prelim', matchId: id, courtId: null,
          publicStatus: 'scheduled', officialRevision: 0, ...assignment,
        });
        await setDoc(doc(db, path('scoreWorkflows', id)), {
          matchKey: id, draftState: 'idle', lock: null, draft: { sets: [] },
          draftRevision: 0, submissionVersion: 0, officialRevision: 0, ...workflow,
        });
      };
      await seedMatch('direct-unassigned');
      await seedMatch('direct-current', { courtId: 'direct-current-court', courtOrder: 1, nextCourtMatchKey: 'direct-current-next' });
      await seedMatch('direct-current-next', { courtId: 'direct-current-court', courtOrder: 2, nextCourtMatchKey: null });
      await setDoc(doc(db, path('courtQueues', 'direct-current-court')), {
        courtId: 'direct-current-court', queueRevision: 4, currentMatchKey: 'direct-current',
        nextMatchKey: 'direct-current-next', normalCursorMatchKey: 'direct-current',
        priorityEntries: [], nextPrioritySequence: 0,
      });
      await seedMatch('direct-future-current', { courtId: 'direct-future-court', courtOrder: 1, nextCourtMatchKey: 'direct-future' });
      await seedMatch('direct-future', { courtId: 'direct-future-court', courtOrder: 2, nextCourtMatchKey: 'direct-future-next' });
      await seedMatch('direct-future-next', { courtId: 'direct-future-court', courtOrder: 3, nextCourtMatchKey: null });
      await setDoc(doc(db, path('courtQueues', 'direct-future-court')), {
        courtId: 'direct-future-court', queueRevision: 7, currentMatchKey: 'direct-future-current',
        nextMatchKey: 'direct-future', normalCursorMatchKey: 'direct-future-current',
        priorityEntries: [], nextPrioritySequence: 0,
      });
      await seedMatch('direct-priority', { courtId: 'direct-priority-court', courtOrder: 1, nextCourtMatchKey: 'direct-priority-normal' });
      await seedMatch('direct-priority-normal', { courtId: 'direct-priority-court', courtOrder: 2, nextCourtMatchKey: null });
      await setDoc(doc(db, path('courtQueues', 'direct-priority-court')), {
        courtId: 'direct-priority-court', queueRevision: 2, currentMatchKey: 'direct-priority',
        nextMatchKey: 'direct-priority-normal', normalCursorMatchKey: 'direct-priority-normal',
        priorityEntries: [{
          entryId: 'manual:direct-priority', matchKey: 'direct-priority', kind: 'manual',
          enqueueSequence: 0, pathDepth: 0, courtOrder: 1, eligibility: 'ready', sourceTransitionIds: [],
        }], nextPrioritySequence: 1,
      });
      await seedMatch('direct-editing', { publicStatus: 'in_progress', attemptCount: 1 }, {
        draftState: 'editing', lock: { uid: 'recorder', token: 'lock' }, draftRevision: 1,
      });
      await seedMatch('direct-submitted', { publicStatus: 'under_review' }, {
        draftState: 'submitted', submittedSnapshot: { sets: score }, submissionVersion: 1,
      });
      await seedMatch('direct-rejected', { publicStatus: 'replay_required', attemptCount: 1 }, {
        draftState: 'rejected', submissionVersion: 1,
      });
      const approvedTransition = 'server:direct-approved:review_approved:1';
      const approvedOfficial = {
        sets: score,
        setsWonA: 2,
        setsWonB: 0,
        pointsForA: 20,
        pointsForB: 15,
        status: 'done',
        result: 'A',
        winner: null,
        officialRevision: 1,
        lastTransitionId: approvedTransition,
      };
      await seedMatch('direct-approved', {
        courtId: 'direct-approved-court', courtOrder: 1, nextCourtMatchKey: null,
        publicStatus: 'completed', officialRevision: 1, lastTransitionId: approvedTransition,
      }, {
        draftState: 'approved',
        officialRevision: 1,
        officialSnapshot: approvedOfficial,
        lastTransitionId: approvedTransition,
      }, approvedOfficial);
      await seedMatch('direct-approved-zero', {
        publicStatus: 'completed',
        officialRevision: 0,
      }, {
        draftState: 'approved',
        officialRevision: 0,
      });
      await seedMatch('direct-approved-mismatch', {
        publicStatus: 'completed',
        officialRevision: 1,
        lastTransitionId: 'server:direct-approved-mismatch:review_approved:1',
      }, {
        draftState: 'approved',
        officialRevision: 1,
        officialSnapshot: { ...approvedOfficial, result: 'draw' },
        lastTransitionId: 'server:direct-approved-mismatch:review_approved:1',
      }, {
        ...approvedOfficial,
        lastTransitionId: 'server:direct-approved-mismatch:review_approved:1',
      });
      await seedMatch('direct-residual-history', {}, {}, {
        setsWonA: 1,
      });
      await setDoc(doc(db, path('courtQueues', 'direct-approved-court')), {
        courtId: 'direct-approved-court', queueRevision: 9, currentMatchKey: null,
        nextMatchKey: null, normalCursorMatchKey: null, priorityEntries: [], nextPrioritySequence: 0,
      });
      await seedMatch('direct-inconsistent', { officialRevision: 1 });
    });
    await call(functions, 'directEditOfficialScore', {
      ...data, matchKey: 'direct-unassigned', score: { sets: score }, reason: 'unassigned first score',
      expectedOfficialRevision: 0, expectedQueueRevision: null,
    });
    const directUnassigned = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('prelimMatches', 'direct-unassigned'))),
      getDoc(doc(db, path('courtAssignments', 'direct-unassigned'))),
      getDoc(doc(db, path('scoreWorkflows', 'direct-unassigned'))),
    ]));
    assert.equal(directUnassigned[0].data().officialRevision, 1, 'direct-unassigned-writes-official-score');
    assert.equal(directUnassigned[1].data().publicStatus, 'completed', 'direct-unassigned-completes-assignment');
    assert.equal(directUnassigned[2].data().draftState, 'approved', 'direct-unassigned-approves-workflow');
    await call(functions, 'directEditOfficialScore', {
      ...data, matchKey: 'direct-current', score: { sets: score }, reason: 'current first score',
      expectedOfficialRevision: 0, expectedQueueRevision: 4,
    });
    const directCurrentQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'direct-current-court'))));
    assert.equal(directCurrentQueue.data().queueRevision, 5, 'direct-current-increments-queue-once');
    assert.equal(directCurrentQueue.data().currentMatchKey, 'direct-current-next', 'direct-current-advances-queue');
    await f.seed(async (db) => {
      const access = await getDoc(doc(db, path('recorderAccess', 'config')));
      await setDoc(doc(db, path('recorderGrants', IDS.recorder)), {
        uid: IDS.recorder,
        version: access.data().version,
        status: 'active',
        issuedAt: Timestamp.fromMillis(Date.now() - 1_000),
        expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      });
      await setDoc(doc(db, path('recorderGrants', credential.user.uid)), {
        uid: credential.user.uid,
        version: access.data().version,
        status: 'active',
        issuedAt: Timestamp.fromMillis(Date.now() - 1_000),
        expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      });
      await setDoc(doc(db, path('courts', 'direct-current-court')), {
        id: 'direct-current-court',
        name: 'A',
        recorderName: 'Recorder One',
      });
    });
    await assert.doesNotReject(
      getDoc(doc(f.recorder(), path('scoreWorkflows', 'direct-current-next'))),
      'recorder-can-read-next-workflow-after-admin-scores-current-match',
    );
    await f.seed((db) => setDoc(doc(db, path('courtQueues', 'direct-current-court')), {
      currentMatchKey: 'direct-current',
      nextMatchKey: 'direct-current-next',
      normalCursorMatchKey: 'direct-current',
      queueRevision: 5,
    }, { merge: true }));
    const reconciledQueue = await call(functions, 'reconcileRecorderCourtQueue', {
      ...data,
      courtId: 'direct-current-court',
      staleMatchKey: 'direct-current',
      recorderName: 'Recorder One',
      expectedQueueRevision: 5,
    });
    assert.equal(reconciledQueue.currentMatchKey, 'direct-current-next', 'recorder-reconciles-stale-completed-current-match');
    assert.equal(reconciledQueue.queueRevision, 6, 'recorder-reconcile-increments-queue-once');
    await call(functions, 'directEditOfficialScore', {
      ...data, matchKey: 'direct-future', score: { sets: score }, reason: 'future first score',
      expectedOfficialRevision: 0, expectedQueueRevision: 7,
    });
    const directFutureQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'direct-future-court'))));
    assert.equal(directFutureQueue.data().currentMatchKey, 'direct-future-current', 'direct-future-preserves-current-work');
    assert.equal(directFutureQueue.data().nextMatchKey, 'direct-future-next', 'direct-future-is-skipped');
    await call(functions, 'directEditOfficialScore', {
      ...data, matchKey: 'direct-priority', score: { sets: score }, reason: 'priority first score',
      expectedOfficialRevision: 0, expectedQueueRevision: 2,
    });
    const directPriorityQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'direct-priority-court'))));
    assert.deepEqual(directPriorityQueue.data().priorityEntries, [], 'direct-priority-removes-completed-target');
    assert.equal(directPriorityQueue.data().currentMatchKey, 'direct-priority-normal', 'direct-priority-reprojects-normal-work');
    const staleBefore = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('prelimMatches', 'direct-current-next'))),
      getDoc(doc(db, path('courtAssignments', 'direct-current-next'))),
      getDoc(doc(db, path('scoreWorkflows', 'direct-current-next'))),
      getDoc(doc(db, path('courtQueues', 'direct-current-court'))),
    ]).then((snaps) => snaps.map((snap) => snap.data())));
    await assert.rejects(call(functions, 'directEditOfficialScore', {
      ...data, matchKey: 'direct-current-next', score: { sets: score }, reason: 'stale queue',
      expectedOfficialRevision: 0, expectedQueueRevision: 4,
    }), /Queue revision changed/, 'direct-stale-queue-rejected');
    const staleAfter = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('prelimMatches', 'direct-current-next'))),
      getDoc(doc(db, path('courtAssignments', 'direct-current-next'))),
      getDoc(doc(db, path('scoreWorkflows', 'direct-current-next'))),
      getDoc(doc(db, path('courtQueues', 'direct-current-court'))),
    ]).then((snaps) => snaps.map((snap) => snap.data())));
    assert.deepEqual(staleAfter, staleBefore, 'direct-stale-queue-zero-writes');
    for (const id of ['direct-editing', 'direct-submitted', 'direct-rejected']) {
      const before = await f.seed(async (db) => Promise.all([
        getDoc(doc(db, path('prelimMatches', id))),
        getDoc(doc(db, path('courtAssignments', id))),
        getDoc(doc(db, path('scoreWorkflows', id))),
      ]).then((snaps) => snaps.map((snap) => snap.data())));
      await assert.rejects(call(functions, 'directEditOfficialScore', {
        ...data, matchKey: id, score: { sets: score }, reason: `${id} rejected`,
        expectedOfficialRevision: 0, expectedQueueRevision: null,
      }), /pristine|approved/i, `${id}-direct-edit-rejected`);
      const after = await f.seed(async (db) => Promise.all([
        getDoc(doc(db, path('prelimMatches', id))),
        getDoc(doc(db, path('courtAssignments', id))),
        getDoc(doc(db, path('scoreWorkflows', id))),
      ]).then((snaps) => snaps.map((snap) => snap.data())));
      assert.deepEqual(after, before, `${id}-direct-edit-zero-writes`);
    }
    for (const [id, expectedOfficialRevision] of [
      ['direct-approved-zero', 0],
      ['direct-approved-mismatch', 1],
      ['direct-residual-history', 0],
    ]) {
      const before = await f.seed(async (db) => Promise.all([
        getDoc(doc(db, path('prelimMatches', id))),
        getDoc(doc(db, path('courtAssignments', id))),
        getDoc(doc(db, path('scoreWorkflows', id))),
      ]).then((snaps) => snaps.map((snap) => snap.data())));
      await assert.rejects(call(functions, 'directEditOfficialScore', {
        ...data,
        matchKey: id,
        score: { sets: score },
        reason: `${id} corrupt state rejected`,
        expectedOfficialRevision,
        expectedQueueRevision: null,
      }), /pristine|approved|inconsistent/i, `${id}-corrupt-state-rejected`);
      const after = await f.seed(async (db) => Promise.all([
        getDoc(doc(db, path('prelimMatches', id))),
        getDoc(doc(db, path('courtAssignments', id))),
        getDoc(doc(db, path('scoreWorkflows', id))),
      ]).then((snaps) => snaps.map((snap) => snap.data())));
      assert.deepEqual(after, before, `${id}-corrupt-state-zero-writes`);
    }
    const approvedQueueBefore = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'direct-approved-court'))).then((snap) => snap.data()));
    await call(functions, 'directEditOfficialScore', {
      ...data, matchKey: 'direct-approved', score: { sets: [{ a: 10, b: 6 }, { a: 10, b: 8 }] },
      reason: 'approved correction', expectedOfficialRevision: 1,
    });
    const [approvedCorrection, approvedQueueAfter] = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('prelimMatches', 'direct-approved'))),
      getDoc(doc(db, path('courtQueues', 'direct-approved-court'))),
    ]));
    assert.equal(approvedCorrection.data().officialRevision, 2, 'direct-approved-correction-increments-official-only');
    assert.equal(approvedCorrection.data().sets[0].b, 6, 'direct-approved-correction-updates-score');
    assert.deepEqual(approvedQueueAfter.data(), approvedQueueBefore, 'direct-approved-correction-does-not-rewind-queue');
    const inconsistentBefore = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('prelimMatches', 'direct-inconsistent'))),
      getDoc(doc(db, path('courtAssignments', 'direct-inconsistent'))),
      getDoc(doc(db, path('scoreWorkflows', 'direct-inconsistent'))),
    ]).then((snaps) => snaps.map((snap) => snap.data())));
    await assert.rejects(call(functions, 'directEditOfficialScore', {
      ...data, matchKey: 'direct-inconsistent', score: { sets: score }, reason: 'inconsistent revision',
      expectedOfficialRevision: 0, expectedQueueRevision: null,
    }), /Official revision changed/, 'direct-inconsistent-revisions-rejected');
    const inconsistentAfter = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('prelimMatches', 'direct-inconsistent'))),
      getDoc(doc(db, path('courtAssignments', 'direct-inconsistent'))),
      getDoc(doc(db, path('scoreWorkflows', 'direct-inconsistent'))),
    ]).then((snaps) => snaps.map((snap) => snap.data())));
    assert.deepEqual(inconsistentAfter, inconsistentBefore, 'direct-inconsistent-revisions-zero-writes');
    await f.seed(async (db) => {
      for (const id of [
        'direct-unassigned', 'direct-current', 'direct-current-next', 'direct-future-current',
        'direct-future', 'direct-future-next', 'direct-priority', 'direct-priority-normal',
        'direct-editing', 'direct-submitted', 'direct-rejected', 'direct-approved', 'direct-inconsistent',
      ]) {
        await deleteDoc(doc(db, path('prelimMatches', id)));
        await deleteDoc(doc(db, path('courtAssignments', id)));
        await deleteDoc(doc(db, path('scoreWorkflows', id)));
      }
      for (const id of ['direct-current-court', 'direct-future-court', 'direct-priority-court', 'direct-approved-court']) {
        await deleteDoc(doc(db, path('courtQueues', id)));
      }
    });
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
      sessionId: 'resume-new-session-0001',
      queueRevision: 3,
    }), /same recorder/i, 'resume-different-recorder-rejected');
    const resumedDraft = await call(functions, 'resumeRecorderDraft', {
      ...data,
      matchKey: 'resume-match',
      courtId: 'resume-court',
      recorderName: '재접속 기록관',
      sessionId: 'resume-new-session-0001',
      queueRevision: 3,
    });
    assert.equal(resumedDraft.resumed, true, 'same-recorder-browser-reconnect-succeeds');
    assert.notEqual(resumedDraft.token, 'lost-browser-token', 'resume-rotates-lost-browser-token');
    const resumedWorkflow = await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'resume-match'))));
    assert.deepEqual(resumedWorkflow.data().draft, { sets: [{ a: 6, b: 4 }] }, 'resume-preserves-saved-draft');
    assert.equal(resumedWorkflow.data().lock.uid, credential.user.uid, 'resume-preserves-google-account-owner');
    assert.equal(resumedWorkflow.data().lock.recorderName, '재접속 기록관', 'resume-preserves-recorder-name');
    assert.equal(resumedWorkflow.data().lock.token, resumedDraft.token, 'resume-persists-new-token');

    // Keep the recorder contract isolated from the topology scenarios above.
    const contractCourt = 'recorder-contract-court';
    const seedRecorderMatch = async (id, {
      matchType = 'prelim', divisionId = null, dependencyReady = true, draftState = 'idle',
      resumeDraftState = 'idle', lock = null, draft = { sets: [] },
    } = {}) => f.seed(async (db) => {
      await setDoc(doc(db, path('courts', contractCourt)), {
        id: contractCourt, name: 'Recorder contract court', recorderName: 'Recorder One',
      });
      await setDoc(doc(db, path('courtQueues', contractCourt)), {
        courtId: contractCourt, currentMatchKey: id, nextMatchKey: null, normalCursorMatchKey: id,
        priorityEntries: [], nextPrioritySequence: 0, queueRevision: 0, lastTransitionId: `seed:${id}`,
      });
      await setDoc(doc(db, path('courtAssignments', id)), {
        matchKey: id, matchType, matchId: id, divisionId, courtId: contractCourt, courtOrder: 1,
        nextCourtMatchKey: null, publicStatus: draftState === 'editing' ? 'in_progress' : 'scheduled',
        dependencyReady, attemptCount: 0, lastTransitionId: `seed:${id}`,
      });
      const official = { id, status: 'scheduled', teamA: 'A', teamB: 'B' };
      if (matchType === 'final') {
        await setDoc(doc(db, `tournaments/main/divisions/${divisionId}/finalMatches/${id}`), official);
      } else {
        await setDoc(doc(db, path('prelimMatches', id)), official);
      }
      await setDoc(doc(db, path('scoreWorkflows', id)), {
        matchKey: id, draftState, resumeDraftState, lock, draft, submittedSnapshot: null,
        draftRevision: 0, submissionVersion: 0, officialRevision: 0, lastTransitionId: `seed:${id}`,
      });
    });

    const accessCode = await call(functions, 'createRecorderAccessCode', data);
    const invalidCode = 'x'.repeat(24);
    await assert.rejects(call(functions, 'exchangeRecorderAccessCode', { ...data, code: 'too-short' }), /code_invalid/, 'code-shape-rejected-before-kdf');
    assert.equal((await f.seed((db) => getDoc(doc(db, path('recorderFailures', credential.user.uid))))).exists(), false, 'malformed-code-does-not-record-kdf-failure');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(call(functions, 'exchangeRecorderAccessCode', { ...data, code: invalidCode }), /code_invalid/, `valid-shape-failure-${attempt}`);
    }
    await assert.rejects(call(functions, 'exchangeRecorderAccessCode', { ...data, code: invalidCode }), /code_rate_limited/, 'valid-shape-failures-rate-limited');
    await f.seed((db) => deleteDoc(doc(db, path('recorderFailures', credential.user.uid))));
    await call(functions, 'exchangeRecorderAccessCode', { ...data, code: accessCode.code });
    const activeGrant = await f.seed((db) => getDoc(doc(db, path('recorderGrants', credential.user.uid))));
    assert.equal(activeGrant.data().status, 'active', 'exchange-creates-active-grant');
    assert.ok(activeGrant.data().issuedAt?.toMillis?.(), 'exchange-grant-has-issued-at');
    assert.ok(activeGrant.data().expiresAt?.toMillis?.() > activeGrant.data().issuedAt?.toMillis?.(), 'exchange-grant-has-expiry');
    assert.ok(Math.abs(activeGrant.data().expiresAt.toMillis() - activeGrant.data().issuedAt.toMillis() - 12 * 60 * 60 * 1000) < 5_000, 'exchange-grant-lasts-twelve-hours');
    const grantList = await call(functions, 'listRecorderGrants', data);
    const listedGrant = grantList.grants.find(({ uid }) => uid === credential.user.uid);
    assert.deepEqual(Object.keys(listedGrant).sort(), ['effectiveStatus', 'expiresAt', 'issuedAt', 'lastUsedAt', 'status', 'uid', 'version'], 'grant-list-redacts-verifier-proof-and-email');
    await f.seed((db) => setDoc(doc(db, path('recorderGrants', 'revoke-target')), {
      uid: 'revoke-target', version: activeGrant.data().version, status: 'active',
      proofHash: 'private-proof', issuedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
    }));
    await call(functions, 'revokeRecorderGrant', { ...data, uid: 'revoke-target' });
    const [revokedTarget, untouchedGrant] = await f.seed((db) => Promise.all([
      getDoc(doc(db, path('recorderGrants', 'revoke-target'))),
      getDoc(doc(db, path('recorderGrants', credential.user.uid))),
    ]));
    assert.equal(revokedTarget.data().status, 'revoked', 'targeted-grant-revoke-marks-only-target');
    assert.equal(untouchedGrant.data().status, 'active', 'targeted-grant-revoke-leaves-other-grants-active');
    await call(functions, 'revokeRecorderGrant', { ...data, uid: credential.user.uid });
    await assert.rejects(call(functions, 'exchangeRecorderAccessCode', {
      ...data, code: accessCode.code,
    }), /grant_revoked/, 'targeted-revoke-cannot-be-undone-with-same-code-version');
    const rotatedAccessCode = await call(functions, 'createRecorderAccessCode', data);
    await call(functions, 'exchangeRecorderAccessCode', { ...data, code: rotatedAccessCode.code });

    await seedRecorderMatch('contract-unresolved', { dependencyReady: false });
    const unresolvedBefore = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'contract-unresolved'))),
      getDoc(doc(db, path('scoreWorkflows', 'contract-unresolved'))),
      getDoc(doc(db, path('courtQueues', contractCourt))),
    ]));
    await assert.rejects(call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-unresolved', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-unresolved-session',
      queueRevision: 0,
    }), /unresolved_teams/, 'unresolved-current-claim-rejected');
    const unresolvedAfter = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('courtAssignments', 'contract-unresolved'))),
      getDoc(doc(db, path('scoreWorkflows', 'contract-unresolved'))),
      getDoc(doc(db, path('courtQueues', contractCourt))),
    ]));
    assert.deepEqual(unresolvedAfter.map((snap) => snap.data()), unresolvedBefore.map((snap) => snap.data()), 'unresolved-current-claim-zero-write');

    await seedRecorderMatch('contract-lease');
    const leaseClaim = await call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-lease', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-lease-session-aaa', queueRevision: 0,
    });
    assert.ok(leaseClaim.leaseExpiresAt - Date.now() <= 180_000 && leaseClaim.leaseExpiresAt - Date.now() > 170_000, 'claim-creates-three-minute-lease');
    const claimedLease = await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'contract-lease'))));
    assert.equal(claimedLease.data().lock.sessionId, leaseClaim.sessionId, 'claim-persists-server-lease-session');
    const saved = await call(functions, 'saveRecorderDraft', {
      ...data, matchKey: 'contract-lease', token: leaseClaim.token, sessionId: leaseClaim.sessionId,
      queueRevision: 0, expectedDraftRevision: 0, draft: { sets: [{ a: 4, b: 2 }] },
    });
    assert.equal(saved.draftRevision, 1, 'save-increments-draft-revision');
    assert.ok(saved.leaseExpiresAt > leaseClaim.leaseExpiresAt, 'save-renews-lease');
    const renewed = await call(functions, 'renewRecorderLease', {
      ...data, matchKey: 'contract-lease', token: leaseClaim.token, sessionId: leaseClaim.sessionId, queueRevision: 0,
    });
    assert.ok(renewed.leaseExpiresAt >= saved.leaseExpiresAt, 'lease-heartbeat-extends-lease');
    const savedAgain = await call(functions, 'saveRecorderDraft', {
      ...data, matchKey: 'contract-lease', token: leaseClaim.token, sessionId: leaseClaim.sessionId,
      queueRevision: 0, expectedDraftRevision: 1, draft: { sets: [{ a: 6, b: 4 }] },
    });
    assert.equal(savedAgain.draftRevision, 2, 'same-lease-second-save-has-distinct-audit-event');
    const renewedAgain = await call(functions, 'renewRecorderLease', {
      ...data, matchKey: 'contract-lease', token: leaseClaim.token, sessionId: leaseClaim.sessionId, queueRevision: 0,
    });
    assert.ok(renewedAgain.transitionId !== renewed.transitionId, 'same-lease-heartbeats-have-distinct-audit-events');
    await assert.rejects(call(functions, 'saveRecorderDraft', {
      ...data, matchKey: 'contract-lease', token: leaseClaim.token, sessionId: leaseClaim.sessionId,
      queueRevision: 0, expectedDraftRevision: 1, draft: { sets: [{ a: 7, b: 5 }] },
    }), /stale_revision/, 'stale-draft-revision-save-is-zero-write');
    await assert.rejects(call(functions, 'saveRecorderDraft', {
      ...data, matchKey: 'contract-lease', token: 'wrong-token', sessionId: leaseClaim.sessionId, queueRevision: 0, expectedDraftRevision: 2, draft: { sets: [] },
    }), /ownership_lost/, 'stale-token-save-rejected');
    await assert.rejects(call(functions, 'saveRecorderDraft', {
      ...data, matchKey: 'contract-lease', token: leaseClaim.token, sessionId: 'contract-lease-other-session', queueRevision: 0, expectedDraftRevision: 2, draft: { sets: [] },
    }), /ownership_lost/, 'other-session-save-rejected');
    await assert.rejects(call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-lease', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-lease-session-bbb', queueRevision: 0,
    }), /ownership_lost/, 'same-uid-other-session-claim-needs-takeover');
    const takenClaim = await call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-lease', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-lease-session-bbb', queueRevision: 0, takeover: true,
    });
    await assert.rejects(call(functions, 'resumeRecorderDraft', {
      ...data, matchKey: 'contract-lease', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-lease-session-ccc', queueRevision: 0,
    }), /ownership_lost/, 'same-uid-other-session-resume-needs-takeover');
    const takenResume = await call(functions, 'resumeRecorderDraft', {
      ...data, matchKey: 'contract-lease', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-lease-session-ccc', queueRevision: 0, takeover: true,
    });
    await assert.notEqual(takenResume.token, takenClaim.token, 'explicit-resume-takeover-rotates-token');
    await f.seed((db) => setDoc(doc(db, path('scoreWorkflows', 'contract-lease')), {
      resumeDraftState: 'rejected',
      lock: { uid: credential.user.uid, token: takenResume.token, recorderName: 'Recorder One', sessionId: takenResume.sessionId,
        acquiredAt: Timestamp.now(), renewedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() - 1) },
    }, { merge: true }));
    await assert.rejects(call(functions, 'saveRecorderDraft', {
      ...data, matchKey: 'contract-lease', token: takenResume.token, sessionId: takenResume.sessionId, queueRevision: 0, expectedDraftRevision: 2, draft: { sets: [] },
    }), /lease_expired/, 'expired-lease-save-rejected');
    const reclaimed = await call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-lease', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-lease-session-ddd', queueRevision: 0,
    });
    const reclaimedWorkflow = await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'contract-lease'))));
    assert.equal(reclaimedWorkflow.data().resumeDraftState, 'rejected', 'expired-lock-reclaim-preserves-resume-state');
    assert.ok(reclaimed.token, 'expired-lock-is-reclaimable');

    await seedRecorderMatch('contract-final-straight', { matchType: 'final', divisionId: 'men' });
    const straightClaim = await call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-final-straight', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-final-straight-session', queueRevision: 0,
    });
    for (const [index, invalidSets] of [
      [{ a: '10', b: 8 }, { a: 10, b: 8 }],
      [{ a: 10.5, b: 8 }, { a: 10, b: 8 }],
      [{ a: 10, b: 8 }, { a: 10, b: 8 }, { a: 7, b: 5 }, { a: 7, b: 5 }],
    ].entries()) {
      await assert.rejects(call(functions, 'submitRecorderDraft', {
        ...data, matchKey: 'contract-final-straight', courtId: contractCourt, token: straightClaim.token,
        sessionId: straightClaim.sessionId, queueRevision: 0, score: { sets: invalidSets },
        operationId: `contract-invalid-score-${index}`,
      }), /Score/, 'invalid-final-score-rejected');
    }
    const straightResult = await call(functions, 'submitRecorderDraft', {
      ...data, matchKey: 'contract-final-straight', courtId: contractCourt, token: straightClaim.token,
      sessionId: straightClaim.sessionId, queueRevision: 0,
      score: { sets: [...score, { a: 0, b: 0 }] },
      operationId: 'contract-straight-submit',
    });
    const straightWorkflow = await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'contract-final-straight'))));
    assert.deepEqual(straightWorkflow.data().submittedSnapshot.sets, score, 'straight-final-drops-client-trailing-zero-set');
    const straightReplay = await call(functions, 'submitRecorderDraft', {
      ...data, matchKey: 'contract-final-straight', courtId: contractCourt, token: straightClaim.token,
      sessionId: straightClaim.sessionId, queueRevision: 0, score: { sets: [...score, { a: 0, b: 0 }] }, operationId: 'contract-straight-submit',
    });
    assert.deepEqual(straightReplay, straightResult, 'submit-response-loss-replay-is-identical');
    await assert.rejects(call(functions, 'submitRecorderDraft', {
      ...data, matchKey: 'contract-final-straight', courtId: contractCourt, token: straightClaim.token,
      sessionId: straightClaim.sessionId, queueRevision: 0, score: { sets: score }, operationId: 'contract-straight-submit',
    }), /operation_mismatch/, 'submit-operation-id-is-bound-to-exact-payload');
    assert.equal((await f.seed((db) => getDoc(doc(db, path('scoreWorkflows', 'contract-final-straight'))))).data().submissionVersion, 1, 'submit-replay-does-not-double-submit');
    assert.equal((await f.seed((db) => getDoc(
      doc(db, path('courtQueues', contractCourt)),
    ))).data().queueRevision, straightResult.queueRevision, 'submit-replay-does-not-double-advance-queue');

    await seedRecorderMatch('contract-final-three', { matchType: 'final', divisionId: 'men' });
    const threeClaim = await call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-final-three', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-final-three-session', queueRevision: 0,
    });
    await call(functions, 'submitRecorderDraft', {
      ...data, matchKey: 'contract-final-three', courtId: contractCourt, token: threeClaim.token,
      sessionId: threeClaim.sessionId, queueRevision: 0,
      score: { sets: [{ a: 10, b: 8 }, { a: 8, b: 10 }, { a: 7, b: 5 }] },
      operationId: 'contract-three-set-submit',
    });
    assert.equal((await f.seed((db) => getDoc(
      doc(db, path('scoreWorkflows', 'contract-final-three')),
    ))).data().submittedSnapshot.sets.length, 3, 'three-set-final-persists-three-sets');

    const cancelCase = async (id, discardDraft) => {
      await seedRecorderMatch(id);
      const claimed = await call(functions, 'claimRecorderDraft', {
        ...data, matchKey: id, courtId: contractCourt, recorderName: 'Recorder One',
        sessionId: `${id}-session-0001`, queueRevision: 0,
      });
      await call(functions, 'saveRecorderDraft', {
        ...data, matchKey: id, token: claimed.token, sessionId: claimed.sessionId, queueRevision: 0,
        expectedDraftRevision: 0, draft: { sets: [{ a: 6, b: 4 }] },
      });
      const request = {
        ...data, matchKey: id, courtId: contractCourt, token: claimed.token, sessionId: claimed.sessionId,
        queueRevision: 0, discardDraft, operationId: `${id}-cancel-operation`,
      };
      const first = await call(functions, 'cancelRecorderDraft', request);
      assert.deepEqual(await call(functions, 'cancelRecorderDraft', request), first, `${id}-cancel-replay-is-identical`);
      return f.seed((db) => getDoc(doc(db, path('scoreWorkflows', id))));
    };
    const retained = await cancelCase('contract-cancel-retain', false);
    assert.deepEqual(retained.data().draft, { sets: [{ a: 6, b: 4 }] }, 'cancel-retain-keeps-draft');
    assert.equal(retained.data().draftRetention, 'retained_after_cancel', 'cancel-retain-marks-semantics');
    const discarded = await cancelCase('contract-cancel-discard', true);
    assert.equal(discarded.data().draft, undefined, 'cancel-discard-clears-draft');
    assert.equal(discarded.data().draftRetention, undefined, 'cancel-discard-clears-retention-marker');

    await call(functions, 'revokeRecorderGrant', { ...data, uid: credential.user.uid });
    await seedRecorderMatch('contract-revoked');
    await assert.rejects(call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-revoked', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-revoked-session', queueRevision: 0,
    }), /Current recorder grant required/, 'revoked-grant-rejects-recorder-callables');
    const restoredAccess = await call(functions, 'createRecorderAccessCode', data);
    await call(functions, 'exchangeRecorderAccessCode', { ...data, code: restoredAccess.code });
    await f.seed((db) => setDoc(doc(db, path('recorderGrants', credential.user.uid)), {
      expiresAt: Timestamp.fromMillis(Date.now() - 1),
    }, { merge: true }));
    await assert.rejects(call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-revoked', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-expired-grant-session', queueRevision: 0,
    }), /Current recorder grant required/, 'expired-grant-rejects-recorder-callables');
    const renewedAccess = await call(functions, 'createRecorderAccessCode', data);
    await call(functions, 'exchangeRecorderAccessCode', { ...data, code: renewedAccess.code });
    const otherApp = initializeApp({ projectId: PROJECT_ID, apiKey: 'emulator-only', appId: `other-recorder-${Date.now()}` }, `other-recorder-${Date.now()}`);
    try {
      const otherAuth = getAuth(otherApp);
      connectAuthEmulator(otherAuth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`, { disableWarnings: true });
      await signInAnonymously(otherAuth);
      const otherFunctions = getFunctions(otherApp, 'asia-northeast3');
      connectFunctionsEmulator(otherFunctions, functionsHost, Number(functionsPort));
      await assert.rejects(call(otherFunctions, 'claimRecorderDraft', {
        ...data, matchKey: 'contract-revoked', courtId: contractCourt, recorderName: 'Recorder One',
        sessionId: 'contract-other-uid-session', queueRevision: 0,
      }), /Current recorder grant required/, 'other-uid-is-denied-recorder-claim');
    } finally {
      await deleteApp(otherApp);
    }
    await f.seed((db) => setDoc(doc(db, 'tournaments/main'), { maintenance: { enabled: true } }, { merge: true }));
    await assert.rejects(call(functions, 'exchangeRecorderAccessCode', { ...data, code: renewedAccess.code }), /maintenance/i, 'maintenance-blocks-recorder-readiness-exchange');
    await assert.rejects(call(functions, 'claimRecorderDraft', {
      ...data, matchKey: 'contract-revoked', courtId: contractCourt, recorderName: 'Recorder One',
      sessionId: 'contract-maintenance-session', queueRevision: 0,
    }), /Current recorder grant required/, 'maintenance-blocks-recorder-server-operation');
    await f.seed((db) => setDoc(doc(db, 'tournaments/main'), { maintenance: { enabled: false } }, { merge: true }));

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
    const preResetBackup = await call(functions, 'exportTournamentBackup', data);
    assert.equal(preResetBackup.version, 3, 'reset-safety-backup-completes-before-maintenance');
    const preparedReset = await call(functions, 'prepareTournamentReset', { ...data, expectedName: '초기화 대상 대회' });
    const concurrentResetResults = await Promise.allSettled([
      call(functions, 'resetTournament', { ...data, token: preparedReset.token }),
      call(functions, 'resetTournament', { ...data, token: preparedReset.token }),
    ]);
    assert.equal(concurrentResetResults.filter(({ status }) => status === 'fulfilled').length, 1, 'reset-allows-one-execution-fence-owner');
    assert.deepEqual(concurrentResetResults.find(({ status }) => status === 'fulfilled').value, { reset: true }, 'reset-seeded-admin-succeeds');
    assert.equal(concurrentResetResults.filter(({ status }) => status === 'rejected').length, 1, 'reset-rejects-concurrent-worker');
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

    await f.seed(async (db) => {
      await setDoc(doc(db, path('teams', 'restore-stale-team')), { stale: true });
      await setDoc(doc(db, path('prelimMatches', 'restore-stale-match')), { stale: true });
      await setDoc(doc(db, path('scoreWorkflows', 'restore-stale-workflow')), { stale: true });
      await setDoc(doc(db, path('courtQueues', 'restore-stale-queue')), { stale: true });
      await setDoc(doc(db, path('recorderGrants', 'restore-protected-grant')), { protected: true });
      await setDoc(doc(db, path('recorderAccess', 'restore-protected-access')), { protected: true });
    });
    const restorePayload = {
      ...data,
      manifestId: 'exact-restore',
      rootData: {
        name: '복원된 대회',
        qualifyPerGroup: { men: 3, women: 1 },
        venueDisplay: { mode: 'auto', intervalSeconds: 15, cycleStartedAt: 1_700_000_000_000 },
      },
      chunks: [{
        documents: [{
          path: path('teams', 'restore-kept-team'),
          data: {
            name: '백업 팀',
            division: 'men',
            createdAt: {
              __bounceFirestoreValue: 'timestamp',
              seconds: '1700000000',
              nanoseconds: 123000000,
            },
          },
        }],
      }],
    };
    const exportedBackup = await call(functions, 'exportTournamentBackup', data);
    assert.equal(exportedBackup.version, 3, 'backup-export-version');
    assert.deepEqual(exportedBackup.tournamentId, 'main', 'backup-export-tournament');
    assert.equal(Object.keys(exportedBackup.rootData).every((key) => ['name', 'qualifyPerGroup', 'venueDisplay', 'courtTopologyRevision'].includes(key)), true, 'backup-export-root-whitelist');
    assert.equal(exportedBackup.chunks.length, 1, 'backup-export-single-consistent-snapshot');
    assert.equal(exportedBackup.chunks[0].documents.every((item) => !/(admins|recorder|restoreManifests)/i.test(item.path)), true, 'backup-export-excludes-protected');
    assert.equal(
      JSON.stringify(exportedBackup).includes('__bounceFirestoreValue'),
      true,
      'backup-export-tags-firestore-values-before-json-download',
    );
    await assert.rejects(call(functions, 'beginRestore', {
      ...restorePayload,
      manifestId: 'orphan-restore',
      chunks: [{ documents: [
        { path: path('prelimMatches', 'orphan'), data: {} },
        { path: path('courtAssignments', 'orphan'), data: { matchKey: 'orphan', matchType: 'prelim', matchId: 'orphan', courtId: null } },
      ] }],
    }), /graph|workflow/i, 'restore-rejects-orphan-workflow');
    await assert.rejects(call(functions, 'beginRestore', {
      ...restorePayload,
      manifestId: 'missing-queue-restore',
      chunks: [{ documents: [
        { path: path('prelimMatches', 'queued'), data: {} },
        { path: path('courts', 'missing-queue-court'), data: {} },
        { path: path('courtAssignments', 'queued'), data: { matchKey: 'queued', matchType: 'prelim', matchId: 'queued', courtId: 'missing-queue-court' } },
        { path: path('scoreWorkflows', 'queued'), data: {} },
      ] }],
    }), /graph|queue/i, 'restore-rejects-missing-queue');
    await assert.rejects(call(functions, 'beginRestore', {
      ...restorePayload,
      manifestId: 'invalid-root-restore',
      rootData: { ...restorePayload.rootData, venueDisplay: { mode: 'manual', intervalSeconds: 45 } },
    }), /venueDisplay/i, 'restore-rejects-invalid-root-settings');
    await assert.rejects(
      call(functions, 'beginRestore', {
        ...restorePayload,
        manifestId: 'unsafe-restore',
        chunks: [{ documents: [{ path: path('admins', 'forbidden'), data: {} }] }],
      }),
      /unsafe|malformed/i,
      'restore-rejects-protected-path-without-write',
    );
    await assert.rejects(
      call(functions, 'beginRestore', {
        ...restorePayload,
        manifestId: 'unknown-value-tag-restore',
        chunks: [{
          documents: [{
            path: path('teams', 'unknown-tag'),
            data: { value: { __bounceFirestoreValue: 'geo-point', latitude: 0, longitude: 0 } },
          }],
        }],
      }),
      /unknown|malformed|unsupported/i,
      'restore-rejects-unknown-firestore-value-tag',
    );
    await assert.rejects(
      call(functions, 'beginRestore', {
        ...restorePayload,
        manifestId: 'duplicate-restore',
        chunks: [{ documents: [
          { path: path('teams', 'duplicate'), data: {} },
          { path: path('teams', 'duplicate'), data: {} },
        ] }],
      }),
      /duplicate/i,
      'restore-rejects-duplicate-path-without-write',
    );
    const rejectedManifests = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, path('restoreManifests', 'unsafe-restore'))),
      getDoc(doc(db, path('restoreManifests', 'duplicate-restore'))),
    ]));
    rejectedManifests.forEach((snap) => assert.equal(snap.exists(), false, `restore-invalid-zero-write-${snap.ref.id}`));
    await call(functions, 'beginRestore', restorePayload);
    await assert.rejects(
      call(functions, 'exportTournamentBackup', data),
      /maintenance/i,
      'backup-export-rejects-active-restore',
    );
    const replacementPayload = { ...restorePayload, manifestId: 'exact-restore-replacement' };
    await call(functions, 'supersedeRestore', { ...replacementPayload, priorManifestId: 'exact-restore' });
    await call(functions, 'supersedeRestore', { ...replacementPayload, priorManifestId: 'exact-restore' });
    await assert.rejects(call(functions, 'pruneRestore', { ...data, manifestId: 'exact-restore' }), /lease/i, 'old-prune-rejected-after-supersede');
    await call(functions, 'resumeRestore', {
      ...data, manifestId: 'exact-restore-replacement', chunkIndex: 0, chunk: replacementPayload.chunks[0],
    });
    await assert.rejects(call(functions, 'verifyRestore', { ...data, manifestId: 'exact-restore-replacement' }), /pruned/i, 'restore-verify-before-prune-rejected');
    let pruneResult;
    do {
      pruneResult = await call(functions, 'pruneRestore', { ...data, manifestId: 'exact-restore-replacement' });
    } while (!pruneResult.pruned);
    assert.equal(pruneResult.pruned, true, 'restore-prunes-stale-documents');
    assert.equal((await call(functions, 'pruneRestore', { ...data, manifestId: 'exact-restore-replacement' })).pruned, true, 'restore-prune-retry-idempotent');
    await call(functions, 'resumeRestore', {
      ...data, manifestId: 'exact-restore-replacement', chunkIndex: 0, chunk: replacementPayload.chunks[0],
    });
    const pruned = await f.seed(async (db) => Promise.all([
      getDoc(doc(db, 'tournaments/main')),
      getDoc(doc(db, path('teams', 'restore-kept-team'))),
      getDoc(doc(db, path('teams', 'restore-stale-team'))),
      getDoc(doc(db, path('prelimMatches', 'restore-stale-match'))),
      getDoc(doc(db, path('scoreWorkflows', 'restore-stale-workflow'))),
      getDoc(doc(db, path('courtQueues', 'restore-stale-queue'))),
      getDoc(doc(db, path('recorderGrants', 'restore-protected-grant'))),
      getDoc(doc(db, path('recorderAccess', 'restore-protected-access'))),
    ]));
    assert.equal(pruned[0].data().name, '복원된 대회', 'restore-restores-root-name');
    assert.deepEqual(pruned[0].data().qualifyPerGroup, { men: 3, women: 1 }, 'restore-restores-root-settings');
    assert.equal(Object.hasOwn(pruned[0].data(), 'courtTopologyRevision'), false, 'restore-deletes-absent-root-setting');
    assert.equal(pruned[0].data().maintenance?.enabled, true, 'restore-prune-keeps-maintenance-lease');
    assert.equal(pruned[0].data().maintenance?.restoreManifestId, 'exact-restore-replacement', 'restore-prune-keeps-manifest-lease');
    assert.equal(pruned[1].exists(), true, 'restore-keeps-backed-up-team');
    assert.equal(pruned[1].data().createdAt.toMillis(), 1_700_000_000_123, 'restore-round-trips-firestore-timestamp');
    pruned.slice(2, 6).forEach((snap) => assert.equal(snap.exists(), false, `restore-deletes-stale-${snap.ref.id}`));
    pruned.slice(6).forEach((snap) => assert.equal(snap.exists(), true, `restore-preserves-protected-${snap.ref.id}`));
    await f.seed((db) => setDoc(doc(db, path('teams', 'restore-kept-team')), { name: '변조' }));
    await assert.rejects(call(functions, 'verifyRestore', { ...data, manifestId: 'exact-restore-replacement' }), /checksum|path/i, 'restore-checksum-mismatch-rejected');
    await assert.rejects(call(functions, 'promoteRestore', { ...data, manifestId: 'exact-restore-replacement' }), /verified/i, 'restore-mismatch-blocks-promotion');
    const retainedLease = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(retainedLease.data().maintenance?.enabled, true, 'restore-failed-promotion-keeps-maintenance');
    assert.equal(retainedLease.data().maintenance?.restoreManifestId, 'exact-restore-replacement', 'restore-failed-promotion-keeps-lease-owner');
    const retryPayload = { ...restorePayload, manifestId: 'exact-restore-retry' };
    await call(functions, 'supersedeRestore', {
      ...retryPayload,
      priorManifestId: 'exact-restore-replacement',
    });
    await call(functions, 'resumeRestore', {
      ...data, manifestId: 'exact-restore-retry', chunkIndex: 0, chunk: restorePayload.chunks[0],
    });
    do {
      pruneResult = await call(functions, 'pruneRestore', { ...data, manifestId: 'exact-restore-retry' });
    } while (!pruneResult.pruned);
    await call(functions, 'verifyRestore', { ...data, manifestId: 'exact-restore-retry' });
    await call(functions, 'resumeRestore', {
      ...data, manifestId: 'exact-restore-retry', chunkIndex: 0, chunk: restorePayload.chunks[0],
    });
    await call(functions, 'pruneRestore', { ...data, manifestId: 'exact-restore-retry' });
    await call(functions, 'verifyRestore', { ...data, manifestId: 'exact-restore-retry' });
    await call(functions, 'promoteRestore', { ...data, manifestId: 'exact-restore-retry' });
    const activeAfterPromote = { ...restorePayload, manifestId: 'active-after-promote' };
    await call(functions, 'beginRestore', activeAfterPromote);
    await assert.rejects(
      call(functions, 'supersedeRestore', {
        ...retryPayload,
        priorManifestId: 'active-after-promote',
      }),
      /already in use|already-exists/i,
      'restore-supersede-rejects-terminal-manifest-reuse',
    );
    const activeLeaseAfterReuseRejection = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(
      activeLeaseAfterReuseRejection.data().maintenance?.restoreManifestId,
      'active-after-promote',
      'restore-terminal-reuse-keeps-current-lease',
    );

    assert.ok(score.length === 2);
  } finally { await deleteApp(app); await f.cleanup(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await runFunctionsSuite();

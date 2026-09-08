import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { createFixture, IDS, PROJECT_ID, path } from './fixtures.mjs';

const PUBLIC_DOCUMENT = 'tournaments/main/publicSchedule/current';
const PUBLIC_COLLECTION = 'tournaments/main/publicSchedule';
const FUNCTION_REGION = 'asia-northeast3';
const POLL_DEADLINE_MS = 20_000;
const POLL_INTERVAL_MS = 100;

function requireDemoEmulatorEnvironment() {
  if (process.env.GCLOUD_PROJECT !== PROJECT_ID || !process.env.GCLOUD_PROJECT.startsWith('demo-')) {
    throw new Error(`Public schedule emulator suite requires GCLOUD_PROJECT=${PROJECT_ID}.`);
  }
  for (const [name, port] of [
    ['FIRESTORE_EMULATOR_HOST', '8080'],
    ['FIREBASE_AUTH_EMULATOR_HOST', '9099'],
    ['FUNCTIONS_EMULATOR_HOST', '5001'],
  ]) {
    const value = process.env[name] || '';
    const [host, actualPort] = value.split(':');
    if (actualPort !== port || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(`${name} must point to a loopback emulator port ${port}.`);
    }
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const readPublic = (db) => getDoc(doc(db, PUBLIC_DOCUMENT));

async function deleteCollectionDocuments(db, collectionPath) {
  const snapshot = await getDocs(collection(db, collectionPath));
  await Promise.all(snapshot.docs.map((item) => deleteDoc(item.ref)));
}

async function waitForPublic(db, expected) {
  let latest = null;
  const startedAt = Date.now();
  const deadline = startedAt + POLL_DEADLINE_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    latest = await readPublic(db);
    if (latest.exists()) {
      try {
        assert.deepEqual(latest.data(), expected, 'public schedule projection');
        return latest.data();
      } catch {
        // Trigger delivery is eventually consistent; keep the bounded poll.
      }
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }

  const actual = latest?.exists() ? latest.data() : null;
  assert.fail(
    `Public schedule trigger did not converge after ${Date.now() - startedAt}ms `
      + `(${attempts} reads). Expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}.`,
  );
}

function assertExactPublicPayload(payload) {
  assert.deepEqual(Object.keys(payload).sort(), ['assignments', 'courts', 'status']);
  assert.ok(['ready', 'maintenance', 'unavailable'].includes(payload.status));
  payload.courts.forEach((court) => assert.deepEqual(Object.keys(court).sort(), ['id', 'name']));
  payload.assignments.forEach((assignment) => {
    assert.deepEqual(Object.keys(assignment).sort(), ['courtId', 'courtOrder', 'matchKey', 'matchType']);
    assert.ok(['prelim', 'final'].includes(assignment.matchType));
  });
}

export async function runPublicScheduleSuite() {
  requireDemoEmulatorEnvironment();
  const f = await createFixture();
  const appName = `public-schedule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const app = initializeApp({
    projectId: PROJECT_ID,
    apiKey: 'emulator-only',
    appId: appName,
  }, appName);
  try {
    const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
    const [functionsHostName, functionsPort] = functionsHost.split(':');
    const functions = getFunctions(app, FUNCTION_REGION);
    connectFunctionsEmulator(functions, functionsHostName, Number(functionsPort));
    const ensurePublicSchedule = httpsCallable(functions, 'ensurePublicSchedule');
    const anonymous = f.anonymous();
    const admin = f.admin();
    const recorder = f.recorder();

    await assert.rejects(
      ensurePublicSchedule({ tournamentId: 'test-fixture' }),
      /Unknown tournament|invalid-argument/i,
      'ensure-public-schedule-rejects-other-tournament',
    );
    await assert.rejects(
      ensurePublicSchedule({}),
      /Unknown tournament|invalid-argument/i,
      'ensure-public-schedule-rejects-missing-tournament',
    );

    // Source documents are already persisted by the fixture. Remove only the
    // derived document to prove bootstrap does not require a source resave.
    await f.seed((db) => deleteDoc(doc(db, PUBLIC_DOCUMENT)));
    const initialPayload = {
      status: 'ready',
      courts: [{ id: 'court-1', name: 'Court 1' }],
      assignments: [
        { matchKey: 'M1', matchType: 'prelim', courtId: 'court-1', courtOrder: 1 },
        { matchKey: 'M2', matchType: 'prelim', courtId: 'court-1', courtOrder: 2 },
      ],
    };
    const initialResponse = await ensurePublicSchedule({ tournamentId: 'main' });
    assert.deepEqual(initialResponse.data, { status: 'ready' }, 'ensure-public-schedule-callable-response');
    const initialSnapshot = await assertSucceeds(readPublic(anonymous));
    assert.deepEqual(initialSnapshot.data(), initialPayload, 'saved-source-bootstraps-without-resave');
    assertExactPublicPayload(initialSnapshot.data());

    await assertSucceeds(readPublic(admin));
    await assertFails(getDocs(collection(anonymous, PUBLIC_COLLECTION)), 'public-schedule-collection-list-denied');
    await assertFails(getDoc(doc(anonymous, 'tournaments/main/publicSchedule/other')));
    await assertFails(getDoc(doc(anonymous, 'tournaments/test-fixture/publicSchedule/current')));
    for (const db of [anonymous, admin]) {
      await assertFails(setDoc(doc(db, PUBLIC_DOCUMENT), initialPayload));
      await assertFails(updateDoc(doc(db, PUBLIC_DOCUMENT), { status: 'maintenance' }));
      await assertFails(deleteDoc(doc(db, PUBLIC_DOCUMENT)));
    }

    // The public projection must not widen any existing private source boundary.
    await assertFails(getDoc(doc(anonymous, path('courts', 'court-1'))));
    await assertFails(getDoc(doc(anonymous, path('courtAssignments', 'M1'))));
    await assertFails(getDoc(doc(anonymous, path('courtQueues', 'court-1'))));
    await assertFails(getDoc(doc(anonymous, path('scoreWorkflows', 'M1'))));
    await assertSucceeds(getDoc(doc(recorder, path('courts', 'court-1'))));
    await assertSucceeds(getDoc(doc(recorder, path('courtAssignments', 'M1'))));
    await assertSucceeds(getDoc(doc(recorder, path('courtQueues', 'court-1'))));
    await assertSucceeds(getDoc(doc(recorder, path('scoreWorkflows', 'M1'))));

    await f.seed(async (db) => {
      await setDoc(doc(db, path('recorderAccess', 'config')), {
        enabled: true,
        version: 7,
        salt: 'private-salt',
        codeHash: 'private-code-hash',
      });
      await setDoc(doc(db, path('recorderGrants', IDS.recorder)), {
        uid: IDS.recorder,
        version: 7,
        status: 'active',
        proofHash: 'private-proof-hash',
      }, { merge: true });
      await setDoc(doc(db, path('courts', 'court-1')), {
        id: 'court-1',
        name: 'Court 1',
        order: 1,
        recorderName: 'Private Recorder',
        recorderUid: IDS.recorder,
        accessCode: 'private-access-code',
      });
      await setDoc(doc(db, path('courtAssignments', 'M1')), {
        matchKey: 'forged-client-key',
        matchType: 'prelim',
        courtId: 'court-1',
        courtOrder: 1,
        lock: { uid: IDS.recorder, token: 'private-lock-token' },
        rawScore: { sets: [{ a: 10, b: 8 }] },
      }, { merge: true });
      await setDoc(doc(db, path('scoreWorkflows', 'M1')), {
        lock: { uid: IDS.recorder, token: 'private-workflow-token' },
        draft: { sets: [{ a: 10, b: 8 }] },
        submittedSnapshot: { sets: [{ a: 10, b: 8 }] },
        rawScore: { sets: [{ a: 10, b: 8 }] },
      }, { merge: true });
      await setDoc(doc(db, path('prelimMatches', 'M1')), {
        sets: [{ a: 10, b: 8 }],
        result: 'A',
        officialSnapshot: { secret: true },
      }, { merge: true });
      await setDoc(doc(db, path('courtQueues', 'court-1')), {
        queueRevision: 91,
        privateRecorderUid: IDS.recorder,
        privateLock: 'queue-secret',
      }, { merge: true });
      await setDoc(doc(db, 'tournaments/main/divisions/men/finalMatches/private-final'), {
        sets: [{ a: 10, b: 0 }],
        result: 'A',
        lock: { uid: IDS.recorder },
      });
    });

    // Replace the source graph with interleaved prelim/final assignments. All
    // writes occur through the fixture's rules-disabled seed path.
    await f.seed(async (db) => {
      for (const collectionPath of [
        'tournaments/main/courts',
        'tournaments/main/courtAssignments',
        'tournaments/main/courtQueues',
        'tournaments/main/scoreWorkflows',
        'tournaments/main/prelimMatches',
        'tournaments/main/divisions/men/finalMatches',
        'tournaments/main/divisions/women/finalMatches',
      ]) await deleteCollectionDocuments(db, collectionPath);

      await setDoc(doc(db, path('courts', 'court-a')), {
        id: 'court-a', name: 'A코트', order: 1, recorderName: 'A Recorder', privateUid: 'uid-a',
      });
      await setDoc(doc(db, path('courts', 'court-b')), {
        id: 'court-b', name: 'B코트', order: 2, recorderName: 'B Recorder', accessCode: 'code-b',
      });
      await setDoc(doc(db, path('courts', 'court-z')), {
        id: 'court-z', name: 'Z코트', order: 3, recorderName: 'Z Recorder', lock: { uid: 'uid-z' },
      });

      const assignments = [
        ['prelim:men:p1', 'prelim', 'court-a', 1],
        ['final:men:f2', 'final', 'court-a', 2],
        ['prelim:men:p3', 'prelim', 'court-a', 3],
        ['final:men:f1', 'final', 'court-a', 4],
        ['prelim:women:p2', 'prelim', 'court-b', 1],
        ['final:women:w1', 'final', 'court-z', 2],
        ['prelim:men:bad-order', 'prelim', 'court-a', '9'],
        ['final:women:unassigned', 'final', null, 99],
        ['prelim:men:unknown-court', 'prelim', 'missing-court', 5],
        ['practice:men:ignored', 'practice', 'court-a', 6],
      ];
      for (const [matchKey, matchType, courtId, courtOrder] of assignments) {
        await setDoc(doc(db, path('courtAssignments', matchKey)), {
          matchKey: 'forged-key',
          matchType,
          courtId,
          courtOrder,
          publicStatus: 'in_progress',
          lock: { uid: IDS.recorder, token: `lock-${matchKey}` },
          rawScore: { sets: [{ a: 10, b: 1 }] },
        });
        await setDoc(doc(db, path('scoreWorkflows', matchKey)), {
          lock: { uid: IDS.recorder, token: `workflow-${matchKey}` },
          draft: { sets: [{ a: 10, b: 1 }] },
          submittedSnapshot: { sets: [{ a: 10, b: 1 }] },
        });
        if (matchType === 'final') {
          const [division, id] = matchKey.split(':').slice(1);
          await setDoc(doc(db, `tournaments/main/divisions/${division}/finalMatches/${id}`), {
            status: 'done', sets: [{ a: 10, b: 1 }], result: 'A', winner: 'private',
          });
        } else {
          await setDoc(doc(db, path('prelimMatches', matchKey)), {
            status: 'done', sets: [{ a: 10, b: 1 }], result: 'A', winner: 'private',
          });
        }
      }
      for (const courtId of ['court-a', 'court-b', 'court-z']) {
        await setDoc(doc(db, path('courtQueues', courtId)), {
          courtId,
          queueRevision: 17,
          currentMatchKey: 'private-current',
          privateLock: { uid: IDS.recorder, token: 'private-queue-token' },
        });
      }
    });

    const customPayload = {
      status: 'ready',
      courts: [
        { id: 'court-a', name: 'A' },
        { id: 'court-b', name: 'B' },
        { id: 'court-z', name: 'Z' },
      ],
      assignments: [
        { matchKey: 'prelim:men:p1', matchType: 'prelim', courtId: 'court-a', courtOrder: 1 },
        { matchKey: 'final:men:f2', matchType: 'final', courtId: 'court-a', courtOrder: 2 },
        { matchKey: 'prelim:men:p3', matchType: 'prelim', courtId: 'court-a', courtOrder: 3 },
        { matchKey: 'final:men:f1', matchType: 'final', courtId: 'court-a', courtOrder: 4 },
        { matchKey: 'prelim:women:p2', matchType: 'prelim', courtId: 'court-b', courtOrder: 1 },
        { matchKey: 'final:women:w1', matchType: 'final', courtId: 'court-z', courtOrder: 2 },
        { matchKey: 'final:women:unassigned', matchType: 'final', courtId: null, courtOrder: null },
        // A known court with an invalid absolute slot is unassigned publicly.
        { matchKey: 'prelim:men:bad-order', matchType: 'prelim', courtId: null, courtOrder: null },
        { matchKey: 'prelim:men:unknown-court', matchType: 'prelim', courtId: null, courtOrder: null },
      ],
    };
    await waitForPublic(anonymous, customPayload);
    const customSnapshot = await assertSucceeds(readPublic(anonymous));
    assertExactPublicPayload(customSnapshot.data());
    assert.equal(JSON.stringify(customSnapshot.data()).includes('private'), false, 'public-projection-redacts-private-source-fields');
    assert.equal(JSON.stringify(customSnapshot.data()).includes('Recorder'), false, 'public-projection-redacts-recorder-identities');
    assert.equal(JSON.stringify(customSnapshot.data()).includes('score'), false, 'public-projection-redacts-raw-scores');

    // Saving a private recorder draft or renaming its operator must not alter
    // the public schedule or disclose the unapproved score.
    await f.seed(async (db) => {
      await updateDoc(doc(db, path('scoreWorkflows', 'prelim:men:p1')), {
        draft: { sets: [{ a: 10, b: 9 }] },
        recorderName: 'Changed private recorder',
      });
      await updateDoc(doc(db, path('courts', 'court-a')), {
        recorderName: 'Changed private recorder',
      });
    });
    assert.deepEqual((await assertSucceeds(readPublic(anonymous))).data(), customPayload);

    // A persisted order transition moves the court and its absolute slots;
    // polling covers eventual trigger delivery without unbounded sleeps.
    await f.seed((db) => updateDoc(doc(db, path('courts', 'court-a')), {
      order: 4,
      name: 'A 최신코트',
    }));
    const reorderedPayload = {
      ...customPayload,
      courts: [
        { id: 'court-b', name: 'B' },
        { id: 'court-z', name: 'Z' },
        { id: 'court-a', name: 'A 최신' },
      ],
      assignments: [
        { matchKey: 'prelim:women:p2', matchType: 'prelim', courtId: 'court-b', courtOrder: 1 },
        { matchKey: 'final:women:w1', matchType: 'final', courtId: 'court-z', courtOrder: 2 },
        { matchKey: 'prelim:men:p1', matchType: 'prelim', courtId: 'court-a', courtOrder: 1 },
        { matchKey: 'final:men:f2', matchType: 'final', courtId: 'court-a', courtOrder: 2 },
        { matchKey: 'prelim:men:p3', matchType: 'prelim', courtId: 'court-a', courtOrder: 3 },
        { matchKey: 'final:men:f1', matchType: 'final', courtId: 'court-a', courtOrder: 4 },
        { matchKey: 'final:women:unassigned', matchType: 'final', courtId: null, courtOrder: null },
        { matchKey: 'prelim:men:bad-order', matchType: 'prelim', courtId: null, courtOrder: null },
        { matchKey: 'prelim:men:unknown-court', matchType: 'prelim', courtId: null, courtOrder: null },
      ],
    };
    await waitForPublic(anonymous, reorderedPayload);

    // Removing a court makes its saved assignment safely unassigned; removing
    // the assignment itself removes the match from the projection.
    await f.seed((db) => deleteDoc(doc(db, path('courts', 'court-z'))));
    const withoutCourt = {
      ...reorderedPayload,
      courts: [
        { id: 'court-b', name: 'B' },
        { id: 'court-a', name: 'A 최신' },
      ],
      assignments: [
        ...reorderedPayload.assignments.filter(({ matchKey }) => matchKey === 'prelim:women:p2'),
        ...reorderedPayload.assignments.filter(({ matchKey }) => [
          'prelim:men:p1',
          'final:men:f2',
          'prelim:men:p3',
          'final:men:f1',
        ].includes(matchKey)),
        ...reorderedPayload.assignments.filter(({ matchKey }) => matchKey === 'final:women:unassigned'),
        { matchKey: 'final:women:w1', matchType: 'final', courtId: null, courtOrder: null },
        { matchKey: 'prelim:men:bad-order', matchType: 'prelim', courtId: null, courtOrder: null },
        ...reorderedPayload.assignments.filter(({ matchKey }) => matchKey === 'prelim:men:unknown-court'),
      ],
    };
    await waitForPublic(anonymous, withoutCourt);
    await f.seed((db) => deleteDoc(doc(db, path('courtAssignments', 'final:women:w1'))));
    const withoutMatch = {
      ...withoutCourt,
      assignments: withoutCourt.assignments.filter(({ matchKey }) => matchKey !== 'final:women:w1'),
    };
    await waitForPublic(anonymous, withoutMatch);

    // Root deletion is unavailable, while maintenance intentionally masks all
    // source documents during a restore-like replacement.
    await f.seed((db) => deleteDoc(doc(db, 'tournaments/main')));
    const unavailablePayload = { status: 'unavailable', courts: [], assignments: [] };
    await waitForPublic(anonymous, unavailablePayload);
    assert.deepEqual((await assertSucceeds(readPublic(anonymous))).data(), unavailablePayload);

    await f.seed((db) => setDoc(doc(db, 'tournaments/main'), {
      tournamentId: 'main',
      name: 'Restored replacement',
      maintenance: { enabled: true, restoreManifestId: 'restore-like' },
    }));
    const maintainedPayload = { status: 'maintenance', courts: [], assignments: [] };
    await waitForPublic(anonymous, maintainedPayload);

    await f.seed(async (db) => {
      for (const collectionPath of [
        'tournaments/main/courts',
        'tournaments/main/courtAssignments',
        'tournaments/main/courtQueues',
        'tournaments/main/scoreWorkflows',
        'tournaments/main/prelimMatches',
        'tournaments/main/divisions/men/finalMatches',
        'tournaments/main/divisions/women/finalMatches',
      ]) await deleteCollectionDocuments(db, collectionPath);
      await setDoc(doc(db, path('courts', 'restore-a')), {
        id: 'restore-a', name: 'Restore A코트', order: 2, recorderName: 'restore-private',
      });
      await setDoc(doc(db, path('courts', 'restore-b')), {
        id: 'restore-b', name: 'Restore B코트', order: 1, recorderName: 'restore-private',
      });
      await setDoc(doc(db, path('courtAssignments', 'final:men:restored')), {
        matchKey: 'forged', matchType: 'final', courtId: 'restore-a', courtOrder: 4,
        lock: { uid: IDS.recorder, token: 'restore-private-lock' },
      });
      await setDoc(doc(db, path('courtAssignments', 'prelim:women:restored')), {
        matchKey: 'forged', matchType: 'prelim', courtId: 'restore-b', courtOrder: 2,
        rawScore: { sets: [{ a: 10, b: 0 }] },
      });
    });
    await waitForPublic(anonymous, maintainedPayload);

    await f.seed((db) => updateDoc(doc(db, 'tournaments/main'), {
      maintenance: { enabled: false },
    }));
    const restoredPayload = {
      status: 'ready',
      courts: [
        { id: 'restore-b', name: 'Restore B' },
        { id: 'restore-a', name: 'Restore A' },
      ],
      assignments: [
        { matchKey: 'prelim:women:restored', matchType: 'prelim', courtId: 'restore-b', courtOrder: 2 },
        { matchKey: 'final:men:restored', matchType: 'final', courtId: 'restore-a', courtOrder: 4 },
      ],
    };
    await waitForPublic(anonymous, restoredPayload);

    // Two saved transitions are issued before the trigger can settle. The
    // handler must reread current source, so replaying the older event cannot
    // resurrect its stale court name/order.
    await f.seed(async (db) => {
      const court = doc(db, path('courts', 'restore-a'));
      await updateDoc(court, { name: 'Restore stale코트', order: 3 });
      await updateDoc(court, { name: 'Restore latest코트', order: 1 });
      await updateDoc(doc(db, path('courts', 'restore-b')), { order: 2 });
    });
    const latestRestoredPayload = {
      ...restoredPayload,
      courts: [
        { id: 'restore-a', name: 'Restore latest' },
        { id: 'restore-b', name: 'Restore B' },
      ],
      assignments: [
        { matchKey: 'final:men:restored', matchType: 'final', courtId: 'restore-a', courtOrder: 4 },
        { matchKey: 'prelim:women:restored', matchType: 'prelim', courtId: 'restore-b', courtOrder: 2 },
      ],
    };
    await waitForPublic(anonymous, latestRestoredPayload);
    assert.deepEqual((await assertSucceeds(readPublic(anonymous))).data(), latestRestoredPayload);
  } finally {
    await deleteApp(app);
    await f.cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runPublicScheduleSuite();

import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';
import { createFixture, PROJECT_ID, path } from './fixtures.mjs';
import { consumeCurrentAndAdvance, insertPriorityEntry, planCorrectionReplay, planRejectedRework, projectForceRelease, selectQueueView } from '../../functions/workflow-core.js';

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
    await f.seed(async (db) => {
      await setDoc(doc(db, path('admins', credential.user.uid)), { uid: credential.user.uid });
      await deleteDoc(doc(db, path('recorderAccess', 'config')));
      await deleteDoc(doc(db, path('recorderAccessChallenge', 'current')));
    });
    const functions = getFunctions(app, 'asia-northeast3'); connectFunctionsEmulator(functions, functionsHost, Number(functionsPort));
    const data = { tournamentId: 'main' };

    const created = await call(functions, 'createRecorderAccessCode', data);
    assert.equal(created.version, 1, 'access-code-create');
    const exchanged = await call(functions, 'exchangeRecorderAccessCode', { ...data, code: created.code });
    assert.equal(exchanged.grantVersion, 1, 'access-code-exchange');
    const rotated = await call(functions, 'rotateRecorderAccessCode', data);
    assert.equal(rotated.version, 2, 'access-code-rotate');
    await assert.rejects(call(functions, 'exchangeRecorderAccessCode', { ...data, code: created.code }), /Invalid access code/);
    assert.deepEqual(await call(functions, 'revokeRecorderAccessCode', data), { revoked: true }, 'access-code-revoke');

    await call(functions, 'setupCourtWorkflow', { ...data, court: { id: 'callable-court' }, assignments: [
      { matchKey: 'C1', matchType: 'prelim', matchId: 'C1', courtOrder: 1, nextCourtMatchKey: 'C2' },
      { matchKey: 'C2', matchType: 'prelim', matchId: 'C2', courtOrder: 2, nextCourtMatchKey: null },
    ] });
    const queue = await f.seed((db) => getDoc(doc(db, path('courtQueues', 'callable-court'))));
    assert.equal(queue.data().currentMatchKey, 'C1', 'setup-queue');

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

    const manifest = await call(functions, 'createMigrationManifest', { ...data, manifestId: 'migration-idempotent' });
    const repeated = await call(functions, 'createMigrationManifest', { ...data, manifestId: 'migration-idempotent' });
    assert.equal(repeated.manifestId, manifest.manifestId, 'migration-idempotency');
    await call(functions, 'beginRestore', { ...data, manifestId: 'restore-maintenance', chunks: [] });
    const restoring = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(restoring.data().maintenance.enabled, true, 'restore-maintenance');
    await call(functions, 'verifyRestore', { ...data, manifestId: 'restore-maintenance' });
    await assert.rejects(call(functions, 'verifyRestore', { ...data, manifestId: 'missing' }), /not found|restore/i, 'restore-verify');
    assert.ok(score.length === 2);
  } finally { await deleteApp(app); await f.cleanup(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await runFunctionsSuite();

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFile } from 'node:fs/promises';
import { Timestamp } from 'firebase/firestore';

export const PROJECT_ID = 'demo-bounce-volleyball';
export const TOURNAMENT_ID = 'main';
export const IDS = Object.freeze({ admin: 'admin-fixture', recorder: 'recorder-current', stale: 'recorder-stale', ungranted: 'recorder-ungranted' });

const baseWorkflow = (matchKey) => ({ matchKey, draftState: 'idle', lock: null, draft: { sets: [] }, submittedSnapshot: null, draftRevision: 0, submissionVersion: 0, officialRevision: 0, lastTransitionId: `seed:${matchKey}` });
const assignment = (matchKey, courtOrder) => ({ matchKey, matchType: 'prelim', matchId: matchKey, courtId: 'court-1', courtOrder, nextCourtMatchKey: courtOrder === 1 ? 'M2' : null, publicStatus: 'scheduled', lastTransitionId: `seed:${matchKey}` });

export async function createFixture() {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  const env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules } });
  const seed = env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('tournaments/main').set({ tournamentId: 'main', recorderFeatureEnabled: true, maintenance: { enabled: false } });
    await db.doc('tournaments/test-fixture').set({ tournamentId: 'test-fixture', recorderFeatureEnabled: true, maintenance: { enabled: false } });
    await db.doc(`tournaments/main/admins/${IDS.admin}`).set({ uid: IDS.admin });
    await db.doc('tournaments/main/recorderAccess/config').set({ enabled: true, version: 2, salt: 'seed', codeHash: 'seed-hash' });
    await db.doc('tournaments/main/recorderAccessChallenge/current').set({ enabled: true, version: 2 });
    const issuedAt = Timestamp.fromMillis(Date.now() - 60_000);
    const expiresAt = Timestamp.fromMillis(Date.now() + 3_600_000);
    await db.doc(`tournaments/main/recorderGrants/${IDS.recorder}`).set({ uid: IDS.recorder, version: 2, proofHash: 'seed-hash', status: 'active', issuedAt, expiresAt });
    await db.doc(`tournaments/main/recorderGrants/${IDS.stale}`).set({ uid: IDS.stale, version: 1, proofHash: 'old-hash', status: 'active', issuedAt, expiresAt });
    await db.doc('tournaments/main/courts/court-1').set({
      id: 'court-1',
      name: 'Court 1',
      recorderName: 'Recorder One',
    });
    await db.doc('tournaments/main/prelimMatches/M1').set({ id: 'M1', status: 'scheduled' });
    await db.doc('tournaments/main/prelimMatches/M2').set({ id: 'M2', status: 'scheduled' });
    await db.doc('tournaments/main/courtAssignments/M1').set(assignment('M1', 1));
    await db.doc('tournaments/main/courtAssignments/M2').set(assignment('M2', 2));
    await db.doc('tournaments/main/courtQueues/court-1').set({ courtId: 'court-1', currentMatchKey: 'M1', nextMatchKey: 'M2', normalCursorMatchKey: 'M1', priorityEntries: [], nextPrioritySequence: 0, queueRevision: 0, lastTransitionId: 'seed:queue' });
    await db.doc('tournaments/main/scoreWorkflows/M1').set(baseWorkflow('M1'));
    await db.doc('tournaments/main/scoreWorkflows/M2').set(baseWorkflow('M2'));
  });
  await seed;
  return {
    env,
    anonymous: () => env.unauthenticatedContext().firestore(),
    recorder: () => env.authenticatedContext(IDS.recorder, { firebase: { sign_in_provider: 'google.com' } }).firestore(),
    staleRecorder: () => env.authenticatedContext(IDS.stale, { firebase: { sign_in_provider: 'google.com' } }).firestore(),
    ungrantedRecorder: () => env.authenticatedContext(IDS.ungranted, { firebase: { sign_in_provider: 'google.com' } }).firestore(),
    admin: () => env.authenticatedContext(IDS.admin).firestore(),
    seed: async (fn) => {
      let result;
      await env.withSecurityRulesDisabled(async (context) => {
        result = await fn(context.firestore());
      });
      return result;
    },
    cleanup: async () => {
      await env.clearFirestore();
      await env.cleanup();
    },
  };
}

export const path = (collection, id) => `tournaments/${TOURNAMENT_ID}/${collection}/${id}`;

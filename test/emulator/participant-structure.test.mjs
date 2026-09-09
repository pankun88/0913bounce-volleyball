import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { createFixture, PROJECT_ID, path } from './fixtures.mjs';

const host = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const [functionsHost, functionsPort] = host.split(':');
const call = (functions, data) => httpsCallable(functions, 'mutatePrelimStructure')(data).then((result) => result.data);

export async function runParticipantStructureSuite() {
  const fixture = await createFixture();
  const appName = `participant-structure-${Date.now()}`;
  const app = initializeApp({
    projectId: PROJECT_ID,
    apiKey: 'emulator-only',
    appId: appName,
  }, appName);
  try {
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`, { disableWarnings: true });
    const credential = await signInAnonymously(auth);
    await fixture.seed((db) => setDoc(doc(db, path('admins', credential.user.uid)), { uid: credential.user.uid }));
    const functions = getFunctions(app, 'asia-northeast3');
    connectFunctionsEmulator(functions, functionsHost, Number(functionsPort));
    const edit = (changes) => call(functions, {
      tournamentId: 'main',
      operation: 'edit_participants',
      changes,
    });
    const group = (id, division = 'men', extra = {}) => ({
      collection: 'groups', id, create: true,
      data: { name: id, division, order: 1, ...extra },
    });
    const team = (id, groupId, division = 'men') => ({
      collection: 'teams', id, create: true,
      data: { name: id, groupId, division, order: 1 },
    });

    const creation = await edit([
      group('participant-normal', 'men', { matchMode: 'ring' }),
      team('participant-a', 'participant-normal'),
      team('participant-b', 'participant-normal'),
    ]);
    await edit([{
      collection: 'groups', id: 'participant-normal', create: false,
      data: { ringOrder: ['participant-a', null] },
    }]);
    const placedGroup = await fixture.seed((db) => getDoc(doc(db, path('groups', 'participant-normal'))));
    assert.deepEqual(placedGroup.data().ringOrder, ['participant-a', null], 'participant-create-assign-ring');
    const participantAudit = (await fixture.seed((db) => getDoc(
      doc(db, path('auditEvents', creation.transitionId)),
    ))).data();
    assert.ok(participantAudit, 'participant-structure-audit-created');
    assert.ok(participantAudit.before.some((entry) => entry.id === 'participant-normal'), 'participant-audit-before');
    assert.ok(participantAudit.after.some((entry) => entry.id === 'participant-a'), 'participant-audit-after');

    await edit([
      group('participant-history', 'men', { matchMode: 'roundrobin' }),
      group('participant-history-target', 'men'),
      group('participant-live', 'men'),
      group('participant-live-target', 'men'),
      group('participant-women', 'women'),
      team('participant-history-team', 'participant-history'),
      team('participant-live-team', 'participant-live'),
    ]);

    await fixture.seed(async (db) => {
      await setDoc(doc(db, path('prelimMatches', 'participant-history-match')), {
        groupId: 'participant-history', division: 'men', teamA: 'participant-history-team',
        teamB: 'participant-a', sets: [{ a: 10, b: 8 }], status: 'done', result: 'A', officialRevision: 1,
      });
    });
    await assert.rejects(edit([{
      collection: 'teams', id: 'participant-history-team', create: false,
      data: { groupId: 'participant-history-target' },
    }]), /history|live|final|division/i, 'participant-history-membership-block');
    await assert.rejects(edit([{
      collection: 'groups', id: 'participant-history', create: false,
      data: { matchMode: 'ring' },
    }]), /history|live|final/i, 'participant-history-mode-block');
    const historyMatch = await fixture.seed((db) => getDoc(doc(db, path('prelimMatches', 'participant-history-match'))));
    assert.equal(historyMatch.data().result, 'A', 'participant-history-score-preserved');

    await fixture.seed(async (db) => {
      await setDoc(doc(db, path('prelimMatches', 'participant-live-match')), {
        groupId: 'participant-live', division: 'men', teamA: 'participant-live-team',
        teamB: 'participant-a', sets: [], status: 'pending', result: null, officialRevision: 0,
      });
      await setDoc(doc(db, path('courtAssignments', 'participant-live-match')), {
        matchKey: 'participant-live-match', matchId: 'participant-live-match', matchType: 'prelim',
        publicStatus: 'in_progress', courtId: 'court-1', division: 'men',
      });
      await setDoc(doc(db, path('scoreWorkflows', 'participant-live-match')), {
        matchKey: 'participant-live-match', draftState: 'editing', lock: { uid: credential.user.uid, token: 'live-token' },
      });
    });
    await assert.rejects(edit([{
      collection: 'teams', id: 'participant-live-team', create: false,
      data: { groupId: 'participant-live-target' },
    }]), /history|live|final/i, 'participant-live-membership-block');
    const liveMatch = await fixture.seed((db) => getDoc(doc(db, path('prelimMatches', 'participant-live-match'))));
    assert.equal(liveMatch.data().status, 'pending', 'participant-live-score-preserved');

    await assert.rejects(edit([{
      collection: 'teams', id: 'participant-a', create: false,
      data: { groupId: 'participant-women' },
    }]), /division/i, 'participant-cross-division-destination-block');

    await fixture.seed((db) => setDoc(doc(db, path('divisions/men/finalMatches', 'participant-published-final')), {
      division: 'men', status: 'pending', teamA: 'participant-a', teamB: 'participant-b',
    }));
    await assert.rejects(edit([group('participant-late-group', 'men')]), /final|published/i, 'participant-published-create-group-block');
    await assert.rejects(edit([team('participant-late-team', 'participant-normal')]), /final|published/i, 'participant-published-create-team-block');
    await assert.rejects(edit([{
      collection: 'groups', id: 'participant-normal', create: false,
      data: { matchMode: 'roundrobin' },
    }]), /final|published/i, 'participant-published-mode-block');
    await edit([
      { collection: 'groups', id: 'participant-normal', create: false, data: { name: 'Renamed after publication', order: 2 } },
      { collection: 'teams', id: 'participant-a', create: false, data: { name: 'Team renamed after publication', order: 2 } },
    ]);

    await edit([group('participant-women-late', 'women'), team('participant-women-late-team', 'participant-women-late', 'women')]);
    const womenTeam = await fixture.seed((db) => getDoc(doc(db, path('teams', 'participant-women-late-team'))));
    assert.equal(womenTeam.data().division, 'women', 'participant-other-division-remains-editable');

    await assert.rejects(edit([
      group('participant-no-partial', 'men'),
      { collection: 'teams', id: 'participant-a', create: false, data: { groupId: 'participant-women' } },
    ]), /division|final/i, 'participant-batch-rejected');
    const noPartial = await fixture.seed((db) => getDoc(doc(db, path('groups', 'participant-no-partial'))));
    assert.equal(noPartial.exists(), false, 'participant-batch-no-partial-write');
  } finally {
    await deleteApp(app);
    await fixture.cleanup();
  }
}

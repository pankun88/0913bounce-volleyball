import assert from 'node:assert/strict';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { deleteDoc, deleteField, doc, getDoc, serverTimestamp, setDoc, Timestamp, updateDoc } from 'firebase/firestore';
import { createFixture, IDS, path } from './fixtures.mjs';

const VALID_LOCK_TOKEN = 'recorder-lock-token-0001';

export async function runRulesSuite() {
  const f = await createFixture();
  try {
    await assertSucceeds(getDoc(doc(f.anonymous(), 'tournaments/main/prelimMatches/M1')));
    await assertFails(getDoc(doc(f.anonymous(), 'tournaments/test-fixture/prelimMatches/M1')));
    await assertFails(getDoc(doc(f.anonymous(), path('recorderAccess', 'config'))));
    await assertFails(getDoc(doc(f.anonymous(), path('courts', 'court-1'))));
    await assertFails(getDoc(doc(f.anonymous(), path('courtAssignments', 'M1'))));
    await assertFails(getDoc(doc(f.anonymous(), path('courtQueues', 'court-1'))));
    await assertSucceeds(getDoc(doc(f.admin(), path('admins', IDS.admin))));
    await assertFails(getDoc(doc(f.ungrantedRecorder(), path('scoreWorkflows', 'M1'))));
    await assertFails(getDoc(doc(f.staleRecorder(), path('scoreWorkflows', 'M1'))));

    const db = f.recorder();
    await assertSucceeds(getDoc(doc(db, path('courts', 'court-1'))));
    await assertSucceeds(getDoc(doc(db, path('courtAssignments', 'M1'))));
    await assertSucceeds(getDoc(doc(db, path('courtQueues', 'court-1'))));
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, 'tournaments/main'), { maintenance: deleteField() });
      await setDoc(doc(admin, path('recorderGrants', 'password-recorder')), {
        uid: 'password-recorder', version: 2, status: 'active',
        issuedAt: Timestamp.fromMillis(Date.now() - 60_000),
        expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      });
      await setDoc(doc(admin, path('recorderGrants', 'revoked-recorder')), {
        uid: 'revoked-recorder', version: 2, status: 'revoked',
        issuedAt: Timestamp.fromMillis(Date.now() - 60_000),
        expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      });
      await setDoc(doc(admin, path('recorderGrants', 'expired-recorder')), {
        uid: 'expired-recorder', version: 2, status: 'active',
        issuedAt: Timestamp.fromMillis(Date.now() - 3_600_000),
        expiresAt: Timestamp.fromMillis(Date.now() - 60_000),
      });
    });
    const passwordRecorder = f.env.authenticatedContext('password-recorder', {
      firebase: { sign_in_provider: 'password' },
    }).firestore();
    await assertFails(getDoc(doc(passwordRecorder, path('scoreWorkflows', 'M1'))));
    for (const uid of ['revoked-recorder', 'expired-recorder']) {
      const denied = f.env.authenticatedContext(uid, {
        firebase: { sign_in_provider: 'google.com' },
      }).firestore();
      await assertFails(getDoc(doc(denied, path('courts', 'court-1'))));
      await assertFails(getDoc(doc(denied, path('courtAssignments', 'M1'))));
      await assertFails(getDoc(doc(denied, path('courtQueues', 'court-1'))));
      await assertFails(getDoc(doc(denied, path('scoreWorkflows', 'M1'))));
    }
    await assertSucceeds(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, 'tournaments/main'), { maintenance: { enabled: true } });
    });
    await assertFails(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await assertFails(getDoc(doc(db, path('courts', 'court-1'))));
    await assertFails(getDoc(doc(db, path('courtAssignments', 'M1'))));
    await assertFails(getDoc(doc(db, path('courtQueues', 'court-1'))));
    const seededAdmin = f.admin();
    await assertSucceeds(getDoc(doc(seededAdmin, path('groups', 'reset-read-remains-allowed'))));
    await assertSucceeds(getDoc(doc(seededAdmin, path('officialRevisions', 'backup-readable-during-reset'))));
    await assertSucceeds(getDoc(doc(seededAdmin, path('restoreManifests', 'backup-readable-during-reset'))));
    await assertSucceeds(getDoc(doc(seededAdmin, 'tournaments/main/restoreManifests/backup-readable-during-reset/chunks/0')));
    await assertFails(updateDoc(doc(seededAdmin, 'tournaments/main'), { name: 'blocked during reset' }));
    await assertFails(setDoc(doc(seededAdmin, path('groups', 'reset-write-blocked')), { name: 'blocked' }));
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, 'tournaments/main'), { maintenance: { enabled: false } });
    });
    await assertSucceeds(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      name: 'UI-owned tournament name',
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      qualifyPerGroup: { men: 2, women: 3 },
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      venueDisplay: { mode: 'auto', intervalSeconds: 15, cycleStartedAt: 1 },
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      name: 'missing server timestamp',
    }));
    await assertFails(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      qualifyPerGroup: { men: 0 },
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      maintenance: { enabled: true },
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      recorderFeatureEnabled: false,
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      courtTopologyRevision: 1,
      updatedAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(seededAdmin, 'tournaments/main'), {
      unknownRootField: true,
      updatedAt: serverTimestamp(),
    }));
    await assertSucceeds(setDoc(doc(seededAdmin, path('groups', 'rule-group')), { name: 'Allowed group' }));
    await assertSucceeds(updateDoc(doc(seededAdmin, path('groups', 'rule-group')), { name: 'Updated group' }));
    await assertFails(deleteDoc(doc(seededAdmin, path('groups', 'rule-group'))));
    await assertSucceeds(setDoc(doc(seededAdmin, path('teams', 'rule-team')), { name: 'Allowed team' }));
    await assertSucceeds(updateDoc(doc(seededAdmin, path('teams', 'rule-team')), { name: 'Updated team' }));
    await assertFails(deleteDoc(doc(seededAdmin, path('teams', 'rule-team'))));
    await assertFails(setDoc(doc(seededAdmin, path('prelimMatches', 'rule-match')), {
      id: 'rule-match', status: 'pending', sets: [], result: null,
    }));
    await assertFails(deleteDoc(doc(seededAdmin, path('prelimMatches', 'M2'))));
    await assertSucceeds(updateDoc(doc(seededAdmin, path('prelimMatches', 'M2')), { round: 2 }));
    await assertSucceeds(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await assertFails(updateDoc(doc(db, path('scoreWorkflows', 'M1')), {
      draftState: 'editing',
      lock: { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' },
    }));
    await assertFails(updateDoc(doc(db, path('courtAssignments', 'M1')), {
      publicStatus: 'in_progress',
    }));
    await assertFails(setDoc(doc(db, path('auditEvents', 'recorder:forged')), {
      transitionId: 'recorder:forged',
      eventType: 'draft_save',
      reason: 'draft_save',
      matchKey: 'M1',
      actor: { uid: IDS.recorder },
      createdAt: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(db, path('scoreWorkflows', 'M1')), { draftRevision: 1 }));
    await assertFails(updateDoc(doc(db, path('prelimMatches', 'M1')), { status: 'done' }));
    await assertFails(updateDoc(doc(db, path('courtAssignments', 'M2')), { publicStatus: 'in_progress' }));
    await assertFails(setDoc(doc(seededAdmin, path('scoreWorkflows', 'browser-forged-workflow')), {
      matchKey: 'browser-forged-workflow', draftState: 'editing', lock: null,
    }));
    await assertFails(setDoc(doc(seededAdmin, path('courtAssignments', 'browser-forged-assignment')), {
      matchKey: 'browser-forged-assignment', publicStatus: 'in_progress',
    }));
    await assertFails(setDoc(doc(seededAdmin, path('auditEvents', 'admin-browser-forged')), {
      transitionId: 'admin-browser-forged', eventType: 'recorder_claim', reason: 'recorder_claim',
      matchKey: 'M1', actor: { uid: IDS.admin }, createdAt: serverTimestamp(),
    }));
    await f.seed(async (admin) => { await updateDoc(doc(admin, path('recorderAccess', 'config')), { enabled: false, version: 3 }); });
    await assertFails(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    for (const privatePath of [
      path('recorderOperations', 'private-operation'),
      path('recorderFailures', IDS.recorder),
      path('accessAttempts', IDS.recorder),
      path('resetState', 'private-reset'),
    ]) {
      await assertFails(getDoc(doc(seededAdmin, privatePath)));
    }
    await assertFails(setDoc(doc(db, path('auditEvents', 'orphan')), { transitionId: 'orphan', eventType: 'draft_save', reason: 'draft_save', matchKey: 'M1', actor: { uid: IDS.recorder }, createdAt: serverTimestamp() }));
    assert.ok(true, 'rules boundary assertions completed');
  } finally { await f.cleanup(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await runRulesSuite();

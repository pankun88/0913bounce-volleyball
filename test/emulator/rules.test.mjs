import assert from 'node:assert/strict';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { deleteDoc, deleteField, doc, getDoc, writeBatch, serverTimestamp, updateDoc, setDoc } from 'firebase/firestore';
import { createFixture, IDS, path } from './fixtures.mjs';

const audit = (batch, db, id, eventType, matchKey, uid, before, after) => batch.set(doc(db, path('auditEvents', id)), { transitionId: id, eventType, reason: eventType, matchKey, actor: { uid }, before, after, createdAt: serverTimestamp() });
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
        uid: 'password-recorder', version: 2,
      });
    });
    const passwordRecorder = f.env.authenticatedContext('password-recorder', {
      firebase: { sign_in_provider: 'password' },
    }).firestore();
    await assertFails(getDoc(doc(passwordRecorder, path('scoreWorkflows', 'M1'))));
    await assertSucceeds(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, 'tournaments/main'), { maintenance: { enabled: true } });
    });
    await assertFails(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
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
    const forged = writeBatch(db); const forgedId = 'recorder:M1:recorder_start:forged';
    audit(forged, db, forgedId, 'recorder_start', 'M1', IDS.recorder, { lock: null, draftState: 'idle' }, {
      lock: { uid: IDS.recorder, token: 'forged-lock', recorderName: 'Wrong Recorder' }, draftState: 'editing',
    });
    forged.update(doc(db, path('scoreWorkflows', 'M1')), {
      draftState: 'editing',
      lock: { uid: IDS.recorder, token: 'forged-lock', recorderName: 'Wrong Recorder' },
      lastTransitionId: forgedId,
    });
    forged.update(doc(db, path('courtAssignments', 'M1')), {
      publicStatus: 'in_progress',
      lastTransitionId: forgedId,
    });
    await assertFails(forged.commit());
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, path('courts', 'court-1')), { recorderName: '' });
    });
    const emptyName = writeBatch(db); const emptyNameId = 'recorder:M1:recorder_start:empty-name';
    audit(emptyName, db, emptyNameId, 'recorder_start', 'M1', IDS.recorder, { lock: null, draftState: 'idle' }, {
      lock: { uid: IDS.recorder, token: 'empty-lock', recorderName: '' }, draftState: 'editing',
    });
    emptyName.update(doc(db, path('scoreWorkflows', 'M1')), {
      draftState: 'editing',
      lock: { uid: IDS.recorder, token: 'empty-lock', recorderName: '' },
      lastTransitionId: emptyNameId,
    });
    emptyName.update(doc(db, path('courtAssignments', 'M1')), {
      publicStatus: 'in_progress',
      lastTransitionId: emptyNameId,
    });
    await assertFails(emptyName.commit());
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, path('courts', 'court-1')), { recorderName: 'Recorder One' });
      await setDoc(doc(admin, path('scoreWorkflows', 'namespace-only')), {
        matchKey: 'namespace-only',
        draftState: 'idle',
        lock: null,
        lastTransitionId: 'server:namespace-only:review_approved:1',
      });
    });
    await assertFails(setDoc(
      doc(db, path('auditEvents', 'server:namespace-only:review_approved:1')),
      {
        transitionId: 'server:namespace-only:review_approved:1',
        eventType: 'recorder_start',
        reason: 'recorder_start',
        matchKey: 'namespace-only',
        actor: { uid: IDS.recorder },
        createdAt: serverTimestamp(),
      },
    ));
    const invalidClaim = async (suffix, token, resumeDraftState, attemptCount) => {
      const batch = writeBatch(db);
      const id = `recorder:M1:recorder_start:${suffix}`;
      const lock = { uid: IDS.recorder, token, recorderName: 'Recorder One' };
      audit(batch, db, id, 'recorder_start', 'M1', IDS.recorder, { lock: null, draftState: 'idle' }, { lock, draftState: 'editing' });
      batch.update(doc(db, path('scoreWorkflows', 'M1')), {
        draftState: 'editing',
        resumeDraftState,
        lock,
        lastTransitionId: id,
      });
      batch.update(doc(db, path('courtAssignments', 'M1')), {
        publicStatus: 'in_progress',
        attemptCount,
        lastTransitionId: id,
      });
      await assertFails(batch.commit());
    };
    await invalidClaim('empty-token', '', 'idle', 1);
    await invalidClaim('short-token', 'short', 'idle', 1);
    await invalidClaim('wrong-resume', VALID_LOCK_TOKEN, 'rejected', 1);
    await invalidClaim('wrong-attempt', VALID_LOCK_TOKEN, 'idle', 99);
    await assertFails(updateDoc(doc(db, path('courtAssignments', 'M1')), {
      attemptCount: 99,
    }));
    const serverNamespaceClaim = writeBatch(db);
    const reservedServerId = 'server:M1:review_approved:1';
    const validLock = { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' };
    audit(serverNamespaceClaim, db, reservedServerId, 'recorder_start', 'M1', IDS.recorder, { lock: null, draftState: 'idle' }, { lock: validLock, draftState: 'editing' });
    serverNamespaceClaim.update(doc(db, path('scoreWorkflows', 'M1')), {
      draftState: 'editing',
      resumeDraftState: 'idle',
      lock: validLock,
      lastTransitionId: reservedServerId,
    });
    serverNamespaceClaim.update(doc(db, path('courtAssignments', 'M1')), {
      publicStatus: 'in_progress',
      attemptCount: 1,
      lastTransitionId: reservedServerId,
    });
    await assertFails(serverNamespaceClaim.commit());

    const claim = writeBatch(db); const transitionId = 'recorder:M1:recorder_start:0';
    audit(claim, db, transitionId, 'recorder_start', 'M1', IDS.recorder, { lock: null, draftState: 'idle' }, { lock: { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' }, draftState: 'editing' });
    claim.update(doc(db, path('scoreWorkflows', 'M1')), { draftState: 'editing', resumeDraftState: 'idle', lock: { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' }, lastTransitionId: transitionId });
    claim.update(doc(db, path('courtAssignments', 'M1')), { publicStatus: 'in_progress', attemptCount: 1, lastTransitionId: transitionId });
    await assertSucceeds(claim.commit());
    const forgedAuditSave = writeBatch(db);
    const forgedAuditSaveId = 'recorder:M1:draft_save:forged-audit:1';
    const claimedLock = { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' };
    audit(
      forgedAuditSave, db, forgedAuditSaveId, 'draft_save', 'M1', IDS.recorder,
      { draft: { sets: [{ a: 99, b: 0 }] }, lock: claimedLock },
      { draft: { sets: [{ a: 4, b: 2 }] }, lock: claimedLock },
    );
    forgedAuditSave.update(doc(db, path('scoreWorkflows', 'M1')), {
      draft: { sets: [{ a: 4, b: 2 }] },
      draftRevision: 1,
      lastTransitionId: forgedAuditSaveId,
    });
    await assertFails(forgedAuditSave.commit());

    await f.seed(async (admin) => {
      await setDoc(doc(admin, path('courts', 'court-2')), {
        id: 'court-2',
        name: 'Court 2',
        recorderName: 'Recorder Two',
      });
      await updateDoc(doc(admin, path('courtAssignments', 'M1')), {
        courtId: 'court-2',
        courtOrder: 1,
        nextCourtMatchKey: null,
      });
      await setDoc(doc(admin, path('courtQueues', 'court-2')), {
        courtId: 'court-2',
        currentMatchKey: 'M1',
        nextMatchKey: null,
        normalCursorMatchKey: 'M1',
        priorityEntries: [],
        nextPrioritySequence: 0,
        queueRevision: 1,
        lastTransitionId: 'admin:move',
      });
      await updateDoc(doc(admin, path('courtQueues', 'court-1')), {
        currentMatchKey: 'M2',
        nextMatchKey: null,
        normalCursorMatchKey: 'M2',
        queueRevision: 1,
        lastTransitionId: 'admin:move',
      });
    });
    const movedSave = writeBatch(db); const movedSaveId = 'recorder:M1:draft_save:moved';
    const recorderLock = { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' };
    audit(movedSave, db, movedSaveId, 'draft_save', 'M1', IDS.recorder, { draft: { sets: [] }, lock: recorderLock }, { draft: { sets: [{ a: 4, b: 2 }] }, lock: recorderLock });
    movedSave.update(doc(db, path('scoreWorkflows', 'M1')), {
      draft: { sets: [{ a: 4, b: 2 }] },
      draftRevision: 1,
      lastTransitionId: movedSaveId,
    });
    await assertSucceeds(movedSave.commit());
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, path('courtAssignments', 'M1')), {
        courtId: null,
        courtOrder: null,
        nextCourtMatchKey: null,
      });
    });
    await assertSucceeds(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    const unassignedSave = writeBatch(db); const unassignedSaveId = 'recorder:M1:draft_save:unassigned';
    audit(unassignedSave, db, unassignedSaveId, 'draft_save', 'M1', IDS.recorder, { draft: { sets: [{ a: 4, b: 2 }] }, lock: recorderLock }, { draft: { sets: [{ a: 6, b: 4 }] }, lock: recorderLock });
    unassignedSave.update(doc(db, path('scoreWorkflows', 'M1')), {
      draft: { sets: [{ a: 6, b: 4 }] },
      draftRevision: 2,
      lastTransitionId: unassignedSaveId,
    });
    await assertSucceeds(unassignedSave.commit());
    const legacyLock = { uid: IDS.recorder, token: VALID_LOCK_TOKEN };
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, path('scoreWorkflows', 'M1')), { lock: legacyLock });
    });
    const legacySave = writeBatch(db); const legacySaveId = 'recorder:M1:draft_save:legacy-lock';
    audit(legacySave, db, legacySaveId, 'draft_save', 'M1', IDS.recorder, { draft: { sets: [{ a: 6, b: 4 }] }, lock: legacyLock }, { draft: { sets: [{ a: 7, b: 5 }] }, lock: legacyLock });
    legacySave.update(doc(db, path('scoreWorkflows', 'M1')), {
      draft: { sets: [{ a: 7, b: 5 }] },
      draftRevision: 3,
      lastTransitionId: legacySaveId,
    });
    await assertSucceeds(legacySave.commit());

    await assertFails(updateDoc(doc(db, path('scoreWorkflows', 'M1')), { draftRevision: 1 }));
    await assertFails(updateDoc(doc(db, path('prelimMatches', 'M1')), { status: 'done' }));
    await assertFails(updateDoc(doc(db, path('courtAssignments', 'M2')), { publicStatus: 'in_progress' }));

    const rollback = writeBatch(db); const rollbackId = 'M1:bad-rollback';
    audit(rollback, db, rollbackId, 'draft_save', 'M1', IDS.recorder, { lock: { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' } }, { lock: { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' } });
    rollback.update(doc(db, path('scoreWorkflows', 'M1')), { draftState: 'editing', lock: { uid: IDS.recorder, token: VALID_LOCK_TOKEN, recorderName: 'Recorder One' }, draftRevision: 0, lastTransitionId: rollbackId });
    await assertFails(rollback.commit());

    await f.seed(async (admin) => { await updateDoc(doc(admin, path('recorderAccess', 'config')), { enabled: false, version: 3 }); });
    await assertFails(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await assertFails(setDoc(doc(db, path('auditEvents', 'orphan')), { transitionId: 'orphan', eventType: 'draft_save', reason: 'draft_save', matchKey: 'M1', actor: { uid: IDS.recorder }, createdAt: serverTimestamp() }));
    assert.ok(true, 'rules boundary assertions completed');
  } finally { await f.cleanup(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await runRulesSuite();

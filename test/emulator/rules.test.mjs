import assert from 'node:assert/strict';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { deleteField, doc, getDoc, writeBatch, serverTimestamp, updateDoc, setDoc } from 'firebase/firestore';
import { createFixture, IDS, path } from './fixtures.mjs';

const audit = (batch, db, id, eventType, matchKey, uid, before, after) => batch.set(doc(db, path('auditEvents', id)), { transitionId: id, eventType, reason: eventType, matchKey, actor: { uid }, before, after, createdAt: serverTimestamp() });

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
    });
    await assertSucceeds(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, 'tournaments/main'), { maintenance: { enabled: true } });
    });
    await assertFails(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, 'tournaments/main'), { maintenance: { enabled: false } });
    });
    const forged = writeBatch(db); const forgedId = 'M1:recorder_start:forged';
    audit(forged, db, forgedId, 'recorder_start', 'M1', IDS.recorder, { lock: null }, {
      lock: { uid: IDS.recorder, token: 'forged-lock', recorderName: 'Wrong Recorder' },
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
    const emptyName = writeBatch(db); const emptyNameId = 'M1:recorder_start:empty-name';
    audit(emptyName, db, emptyNameId, 'recorder_start', 'M1', IDS.recorder, { lock: null }, {
      lock: { uid: IDS.recorder, token: 'empty-lock', recorderName: '' },
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
    });
    const claim = writeBatch(db); const transitionId = 'M1:recorder_start:0';
    audit(claim, db, transitionId, 'recorder_start', 'M1', IDS.recorder, { lock: null }, { lock: { uid: IDS.recorder, token: 'lock-1', recorderName: 'Recorder One' } });
    claim.update(doc(db, path('scoreWorkflows', 'M1')), { draftState: 'editing', lock: { uid: IDS.recorder, token: 'lock-1', recorderName: 'Recorder One' }, lastTransitionId: transitionId });
    claim.update(doc(db, path('courtAssignments', 'M1')), { publicStatus: 'in_progress', lastTransitionId: transitionId });
    await assertSucceeds(claim.commit());

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
    const movedSave = writeBatch(db); const movedSaveId = 'M1:draft_save:moved';
    const recorderLock = { uid: IDS.recorder, token: 'lock-1', recorderName: 'Recorder One' };
    audit(movedSave, db, movedSaveId, 'draft_save', 'M1', IDS.recorder, { lock: recorderLock }, { lock: recorderLock });
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
    const unassignedSave = writeBatch(db); const unassignedSaveId = 'M1:draft_save:unassigned';
    audit(unassignedSave, db, unassignedSaveId, 'draft_save', 'M1', IDS.recorder, { lock: recorderLock }, { lock: recorderLock });
    unassignedSave.update(doc(db, path('scoreWorkflows', 'M1')), {
      draft: { sets: [{ a: 6, b: 4 }] },
      draftRevision: 2,
      lastTransitionId: unassignedSaveId,
    });
    await assertSucceeds(unassignedSave.commit());
    const legacyLock = { uid: IDS.recorder, token: 'lock-1' };
    await f.seed(async (admin) => {
      await updateDoc(doc(admin, path('scoreWorkflows', 'M1')), { lock: legacyLock });
    });
    const legacySave = writeBatch(db); const legacySaveId = 'M1:draft_save:legacy-lock';
    audit(legacySave, db, legacySaveId, 'draft_save', 'M1', IDS.recorder, { lock: legacyLock }, { lock: legacyLock });
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
    audit(rollback, db, rollbackId, 'draft_save', 'M1', IDS.recorder, { lock: { uid: IDS.recorder, token: 'lock-1', recorderName: 'Recorder One' } }, { lock: { uid: IDS.recorder, token: 'lock-1', recorderName: 'Recorder One' } });
    rollback.update(doc(db, path('scoreWorkflows', 'M1')), { draftState: 'editing', lock: { uid: IDS.recorder, token: 'lock-1', recorderName: 'Recorder One' }, draftRevision: 0, lastTransitionId: rollbackId });
    await assertFails(rollback.commit());

    await f.seed(async (admin) => { await updateDoc(doc(admin, path('recorderAccess', 'config')), { enabled: false, version: 3 }); });
    await assertFails(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await assertFails(setDoc(doc(db, path('auditEvents', 'orphan')), { transitionId: 'orphan', eventType: 'draft_save', reason: 'draft_save', matchKey: 'M1', actor: { uid: IDS.recorder }, createdAt: serverTimestamp() }));
    assert.ok(true, 'rules boundary assertions completed');
  } finally { await f.cleanup(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await runRulesSuite();

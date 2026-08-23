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
    await assertSucceeds(getDoc(doc(f.admin(), path('admins', IDS.admin))));
    await assertFails(getDoc(doc(f.ungrantedRecorder(), path('scoreWorkflows', 'M1'))));
    await assertFails(getDoc(doc(f.staleRecorder(), path('scoreWorkflows', 'M1'))));

    const db = f.recorder();
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
    const claim = writeBatch(db); const transitionId = 'M1:recorder_start:0';
    audit(claim, db, transitionId, 'recorder_start', 'M1', IDS.recorder, { lock: null }, { lock: { uid: IDS.recorder, token: 'lock-1' } });
    claim.update(doc(db, path('scoreWorkflows', 'M1')), { draftState: 'editing', lock: { uid: IDS.recorder, token: 'lock-1' }, lastTransitionId: transitionId });
    claim.update(doc(db, path('courtAssignments', 'M1')), { publicStatus: 'in_progress', lastTransitionId: transitionId });
    await assertSucceeds(claim.commit());

    await assertFails(updateDoc(doc(db, path('scoreWorkflows', 'M1')), { draftRevision: 1 }));
    await assertFails(updateDoc(doc(db, path('prelimMatches', 'M1')), { status: 'done' }));
    await assertFails(updateDoc(doc(db, path('courtAssignments', 'M2')), { publicStatus: 'in_progress' }));

    const rollback = writeBatch(db); const rollbackId = 'M1:bad-rollback';
    audit(rollback, db, rollbackId, 'draft_save', 'M1', IDS.recorder, { lock: { uid: IDS.recorder, token: 'lock-1' } }, { lock: { uid: IDS.recorder, token: 'lock-1' } });
    rollback.update(doc(db, path('scoreWorkflows', 'M1')), { draftState: 'editing', lock: { uid: IDS.recorder, token: 'lock-1' }, draftRevision: 0, lastTransitionId: rollbackId });
    await assertFails(rollback.commit());

    await f.seed(async (admin) => { await updateDoc(doc(admin, path('recorderAccess', 'config')), { enabled: false, version: 3 }); });
    await assertFails(getDoc(doc(db, path('scoreWorkflows', 'M1'))));
    await assertFails(setDoc(doc(db, path('auditEvents', 'orphan')), { transitionId: 'orphan', eventType: 'draft_save', reason: 'draft_save', matchKey: 'M1', actor: { uid: IDS.recorder }, createdAt: serverTimestamp() }));
    assert.ok(true, 'rules boundary assertions completed');
  } finally { await f.cleanup(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await runRulesSuite();

import assert from 'node:assert/strict';
import {
  activateDependencyEntries,
  classifyCorrectionTarget,
  consumeCurrentAndAdvance,
  insertPriorityEntry,
  planCorrectionReplay,
  planRejectedRework,
  projectCancel,
  projectForceRelease,
  reconcilePlannerAssignments,
  selectQueueView,
} from './score-workflow.js';

const assignments = () => ({
  M1: { publicStatus: 'under_review', courtOrder: 1, nextCourtMatchKey: 'M2' },
  M2: { publicStatus: 'scheduled', courtOrder: 2, nextCourtMatchKey: 'M3' },
  M3: { publicStatus: 'scheduled', courtOrder: 3, nextCourtMatchKey: 'M4' },
  M4: { publicStatus: 'completed', courtOrder: 4, nextCourtMatchKey: null },
  R1: { publicStatus: 'replay_required', courtOrder: 5, nextCourtMatchKey: null },
  R2: { publicStatus: 'replay_required', courtOrder: 6, nextCourtMatchKey: null, dependencyReady: false },
});
const workflows = () => ({
  M1: { draftState: 'submitted', submissionVersion: 1 },
  M2: { draftState: 'idle' }, M3: { draftState: 'idle' }, M4: { draftState: 'approved' },
  R1: { draftState: 'rejected', submissionVersion: 1 }, R2: { draftState: 'idle', submissionVersion: 1 },
});
const queue = (changes = {}) => ({
  queueRevision: 7, currentMatchKey: 'M2', nextMatchKey: 'M3', normalCursorMatchKey: 'M2',
  priorityEntries: [], nextPrioritySequence: 0, ...changes,
});

// 코트 초안을 먼저 편집한 뒤 다른 조·여자부 대진을 생성해도 새 경기가 합쳐져야 한다.
{
  const current = [{
    matchKey: 'men-halla-1',
    matchType: 'prelim',
    division: 'men',
    courtId: 'court-a',
    label: '이전 한라 표기',
  }];
  const options = [
    { matchKey: 'men-halla-1', matchType: 'prelim', division: 'men', label: '남자부 · 한라 · 1경기', hasOfficialHistory: false },
    { matchKey: 'men-baekdu-1', matchType: 'prelim', division: 'men', label: '남자부 · 백두 · 1경기', hasOfficialHistory: false },
    { matchKey: 'women-cheonha-1', matchType: 'prelim', division: 'women', label: '여자부 · 천하 · 1경기', hasOfficialHistory: false },
    { matchKey: 'official-saved', matchType: 'prelim', division: 'women', label: '여자부 · 저장된 공식 경기', hasOfficialHistory: true },
    { matchKey: 'official-unsaved', matchType: 'prelim', division: 'women', label: '여자부 · 미배정 공식 경기', hasOfficialHistory: true },
  ];
  const persisted = [{
    id: 'official-saved',
    matchKey: 'official-saved',
    courtId: 'court-b',
    courtOrder: 2,
  }];
  const merged = reconcilePlannerAssignments(current, options, persisted);
  assert.deepEqual(
    merged.map((assignment) => assignment.matchKey),
    ['men-halla-1', 'men-baekdu-1', 'women-cheonha-1', 'official-saved'],
  );
  assert.equal(merged[0].courtId, 'court-a', '기존 한라 코트 선택 보존');
  assert.equal(merged[0].label, '남자부 · 한라 · 1경기', '기존 경기 메타데이터 갱신');
  assert.equal(merged[1].courtId, null, '새 백두 경기 활성 초안 생성');
  assert.equal(merged[2].division, 'women', '새 여자부 경기 활성 초안 생성');
  assert.equal(merged[3].courtId, 'court-b', '공식 경기의 서버 배정 복원');
}

// pass-4: review history is excluded and submit advances without approval.
{
  const a = assignments(); const w = workflows();
  assert.deepEqual(selectQueueView(queue(), a, w), { currentMatchKey: 'M2', nextMatchKey: 'M3' });
  const submitted = { ...a, M2: { ...a.M2, publicStatus: 'under_review' } };
  const submittedWorkflows = { ...w, M2: { ...w.M2, draftState: 'submitted', lock: null } };
  const advanced = consumeCurrentAndAdvance(queue(), submitted, submittedWorkflows, 'M2');
  assert.equal(advanced.currentMatchKey, 'M3');
  assert.equal(advanced.normalCursorMatchKey, 'M3');
}

// pass-4: deterministic priority overlay, idle displacement, and active-lock preservation.
{
  const a = assignments(); const w = workflows();
  let q = insertPriorityEntry(queue(), a, w, { matchKey: 'R2', kind: 'correction_replay', sourceTransitionIds: ['t2'] });
  q = insertPriorityEntry(q, a, w, { matchKey: 'R1', kind: 'rejected_rework', sourceTransitionIds: ['t1'], pathDepth: 1 });
  assert.equal(selectQueueView(q, a, w).currentMatchKey, 'R2');
  const busyAssignments = { ...a, M2: { ...a.M2, publicStatus: 'in_progress' } };
  const busyWorkflows = { ...w, M2: { ...w.M2, lock: { token: 'owner' } } };
  assert.equal(selectQueueView(q, busyAssignments, busyWorkflows).currentMatchKey, 'M2');
  assert.equal(selectQueueView(q, busyAssignments, busyWorkflows).nextMatchKey, 'R2');
}

// revision-4: cancel and force release project the same canonical reclaimable queue.
{
  const a = assignments(); const w = workflows();
  const active = queue({ currentMatchKey: 'R1', normalCursorMatchKey: 'M2', priorityEntries: [{ entryId: 'r', matchKey: 'R1', kind: 'rejected_rework', enqueueSequence: 0, pathDepth: 0, courtOrder: 5, eligibility: 'ready' }] });
  const editing = { ...w, R1: { ...w.R1, draftState: 'editing', lock: { token: 'x' } } };
  const returnState = { draftState: 'rejected' };
  assert.deepEqual(projectCancel(active, a, editing, 'R1', returnState), projectForceRelease(active, a, editing, 'R1', returnState));
}

// revision-4: never-started normal corrections remain in place; history creates a blocked replay then activates.
{
  const a = assignments(); const w = workflows();
  assert.equal(classifyCorrectionTarget(a.M2, w.M2), 'in_place');
  assert.equal(classifyCorrectionTarget(a.R2, w.R2), 'priority');
  const planned = planCorrectionReplay(queue(), a, w, ['M2', 'R2'], 'correction-1');
  assert.equal(planned.queue.priorityEntries.length, 1);
  assert.equal(planned.queue.priorityEntries[0].matchKey, 'R2');
  assert.equal(selectQueueView(planned.queue, planned.assignments, planned.workflows).currentMatchKey, 'M2');
  assert.equal(activateDependencyEntries(planned.queue, planned.assignments, planned.workflows, ['R2']).currentMatchKey, 'R2');
}

// Rejection enters priority once, and all ownership/cursor invariant failures reject before a mutation result exists.
{
  const a = assignments(); const w = workflows();
  const rejected = planRejectedRework(queue(), a, w, 'M1', 'reject-1');
  const duplicate = insertPriorityEntry(rejected.queue, rejected.assignments, rejected.workflows, { matchKey: 'M1', kind: 'rejected_rework', sourceTransitionIds: ['reject-2'] });
  assert.equal(duplicate.priorityEntries.length, 1);
  assert.throws(() => selectQueueView(queue({ normalCursorMatchKey: 'R1', priorityEntries: [{ matchKey: 'R1', enqueueSequence: 0, eligibility: 'ready' }] }), a, w), /Dual normal\/priority/);
  assert.throws(() => selectQueueView(queue({ normalCursorMatchKey: 'M1' }), a, w), /Stale or ineligible/);
  assert.throws(() => selectQueueView(queue({ normalCursorMatchKey: 'M4' }), a, w), /Stale or ineligible/);
  assert.deepEqual(
    selectQueueView(queue({ currentMatchKey: null, priorityEntries: [{ matchKey: 'R1', enqueueSequence: 0, eligibility: 'blocked_dependency' }] }), a, w),
    { currentMatchKey: 'M2', nextMatchKey: 'M3' },
  );
  assert.throws(() => selectQueueView(queue({ priorityEntries: [{ matchKey: 'R1', enqueueSequence: 0, eligibility: 'ready' }, { matchKey: 'R1', enqueueSequence: 1, eligibility: 'ready' }] }), a, w), /Duplicate priority/);
}

console.log('score-workflow fixtures passed');

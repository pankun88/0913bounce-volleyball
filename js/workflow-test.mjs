import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { formatCourtName } from './court-display.js';
import {
  activateDependencyEntries,
  classifyCorrectionTarget,
  consumeCurrentAndAdvance,
  getPlannerVisibleAdjacent,
  groupPlannerAssignments,
  insertPriorityEntry,
  isPlannerMatchCompleted,
  movePlannerAssignment,
  movePlannerMatchByOffset,
  planCorrectionReplay,
  planRejectedRework,
  plannerPhaseMatches,
  projectCancel,
  projectForceRelease,
  reconcilePlannerAssignments,
  selectQueueView,
  swapPlannerCourts,
} from './score-workflow.js';
import {
  buildRecorderCourtSchedule,
  buildRecorderConfirmationModel,
  buildRecorderSubmitContext,
  parseStoredRecorderDraft,
  reconcileRecorderSelections,
  reconcileRecorderSubmit,
  readStoredRecorderDraft,
  recorderDataState,
  recorderRouteState,
  reconcileRecorderOwnership,
  reconcileRecorderSnapshot,
  recorderDraftsEqual,
  resolveRecorderConflict,
  sortRecorderCourts,
} from './recorder-state.js';

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

// Recorder selectors stay explicit: a court change or reassignment never
// carries an old recorder name into a new authoritative court assignment.
{
  const courts = [
    { id: 'court-a', name: 'A', recorderName: '민서' },
    { id: 'court-b', name: 'B', recorderName: '' },
  ];
  const selected = reconcileRecorderSelections(courts, 'court-a', '민서');
  assert.equal(selected.courtId, 'court-a');
  assert.deepEqual(selected.availableNames, ['민서']);
  assert.equal(selected.recorder, '민서');
  assert.equal(reconcileRecorderSelections(courts, 'court-a', '').recorder, '');
  assert.deepEqual(
    reconcileRecorderSelections(courts.map((court) => (
      court.id === 'court-a' ? { ...court, recorderName: '지우' } : court
    )), 'court-a', '민서'),
    {
      court: { id: 'court-a', name: 'A', recorderName: '지우' },
      courtId: 'court-a',
      availableNames: ['지우'],
      recorder: '',
    },
  );
  assert.equal(reconcileRecorderSelections(courts, 'court-b', '민서').recorder, '');
  assert.equal(reconcileRecorderSelections(courts, 'missing', '민서').courtId, '');
}

// Court choices use configured numeric order, then Korean/natural name and ID
// order. Missing order values are not coerced to zero, and the subscription
// array remains untouched.
{
  const courts = [
    { id: 'court10', name: '10', order: null },
    { id: 'court2', name: '2', order: null },
    { id: 'court-ordered-2', name: '가', order: 2 },
    { id: 'court-ordered-1', name: '나', order: 1 },
  ];
  const before = courts.map((court) => ({ ...court }));
  assert.deepEqual(sortRecorderCourts(courts).map((court) => court.id), [
    'court-ordered-1', 'court-ordered-2', 'court2', 'court10',
  ]);
  assert.deepEqual(courts, before);
  assert.deepEqual(sortRecorderCourts([
    { id: 'z10', name: '코트 10' },
    { id: 'z2', name: '코트 2' },
  ]).map((court) => court.id), ['z2', 'z10']);
}

// The ordered schedule follows courtOrder while queue current/next markers
// remain authoritative when a priority replay is placed later in that list.
{
  const scheduleAssignments = [
    { id: 'normal-1', matchKey: 'normal-1', courtOrder: 1, matchType: 'prelim', publicStatus: 'scheduled' },
    { id: 'normal-2', matchKey: 'normal-2', courtOrder: 2, matchType: 'prelim', publicStatus: 'scheduled' },
    { id: 'replay-1', matchKey: 'replay-1', courtOrder: 3, matchType: 'prelim', publicStatus: 'replay_required' },
    { id: 'missing-order', matchKey: 'missing-order', courtOrder: null, matchType: 'prelim', publicStatus: 'scheduled' },
  ];
  const schedule = buildRecorderCourtSchedule({
    assignments: scheduleAssignments,
    queue: { currentMatchKey: 'replay-1', nextMatchKey: 'normal-1' },
    officialMatches: new Map([
      ['normal-1', { groupId: 'g1', teamA: 't1', teamB: 'missing-team', round: 1, status: 'done', officialCurrent: true, sets: [{ a: 10, b: 8 }], result: 'A' }],
      ['normal-2', { groupId: 'g1', teamA: 't2', teamB: 't3', round: 2, status: 'done', officialCurrent: false, sets: [{ a: 10, b: 8 }], result: 'A' }],
    ]),
    teamsById: new Map([['t1', { id: 't1', name: '팀 하나' }]]),
    groupsById: new Map([['g1', { id: 'g1', name: '한라' }]]),
  });
  assert.deepEqual(schedule.map((item) => item.matchKey), ['normal-1', 'normal-2', 'replay-1', 'missing-order']);
  assert.equal(schedule.find((item) => item.matchKey === 'replay-1').status, 'current');
  assert.equal(schedule.find((item) => item.matchKey === 'normal-1').status, 'next');
  assert.equal(schedule.find((item) => item.matchKey === 'normal-2').score, null);
  assert.equal(schedule.find((item) => item.matchKey === 'normal-2').baseStatus, 'waiting');
  assert.match(schedule.find((item) => item.matchKey === 'normal-1').matchup, /대진 미정/);
  assert.doesNotMatch(schedule.find((item) => item.matchKey === 'normal-1').matchup, /missing-team/);
  assert.equal(recorderRouteState('selection', 'enter', { canEnter: false }), 'selection');
  assert.equal(recorderRouteState('selection', 'enter', { canEnter: true }), 'operations');
  assert.equal(recorderRouteState('operations', 'change', { blocked: true }), 'operations');
  assert.equal(recorderRouteState('operations', 'change', { blocked: false }), 'selection');
}

// The recorder displays actual court order, not the array index or match ID.
{
  const source = readFileSync(new URL('./recorder.js', import.meta.url), 'utf8');
  const start = source.indexOf('function selectedCourt()');
  const end = source.indexOf('function clearConfirmation()', start);
  assert.ok(start >= 0 && end > start);
  const element = (tagName) => ({
    tagName, dataset: {}, children: [], textContent: '', hidden: false,
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  const ui = Object.fromEntries([
    'selectedCourtLabel', 'selectedRecorderLabel', 'courtScheduleHeading',
    'courtScheduleList', 'courtScheduleStatus',
  ].map((id) => [id, element('div')]));
  const courtAssignments = [
    { matchKey: 'later', courtOrder: 12, matchType: 'prelim', publicStatus: 'scheduled' },
    { matchKey: 'earlier', courtOrder: 5, matchType: 'prelim', publicStatus: 'scheduled' },
    { matchKey: 'unordered', courtOrder: null, matchType: 'prelim', publicStatus: 'scheduled' },
  ];
  const before = structuredClone(courtAssignments);
  const context = {
    ui, document: { createElement: element },
    courts: [{ id: 'court-1', name: '1' }], courtId: 'court-1', pendingCourtId: '',
    recorder: '기록관', displayCourt: formatCourtName, scheduleState: 'ready',
    courtAssignments, queue: null, buildRecorderCourtSchedule,
    scheduleOfficial: new Map([
      ['earlier', { groupId: 'group', teamA: 'a', teamB: 'b', round: 9 }],
      ['later', { groupId: 'group', teamA: 'b', teamB: 'c', round: 3 }],
    ]),
    teams: new Map(), groups: new Map([['group', { name: '1조' }]]),
  };
  runInNewContext(`${source.slice(start, end)}\nrenderCourtSchedule();`, context);
  assert.equal(ui.courtScheduleHeading.textContent, '1코트 경기 일정');
  assert.deepEqual(
    Array.from(ui.courtScheduleList.children, (card) => card.children[0].textContent),
    ['코트 순서 5 · 1조 예선 · 9경기', '코트 순서 12 · 1조 예선 · 3경기', '순서 미정 · 예선'],
  );
  assert.deepEqual(courtAssignments, before, 'rendering preserves court assignments and order');
}

// A submit request keeps its original operation and storage context while a
// queue snapshot advances (or briefly reports no current match).
{
  const pending = buildRecorderSubmitContext({
    matchKey: 'M1',
    courtId: 'court-a',
    token: 'token-1',
    queueRevision: 7,
    score: { sets: [{ a: 10, b: 8 }, { a: 10, b: 9 }] },
    operationId: 'operation-1',
    storageKey: 'recorder-score:tournament:M1:uid',
    fixtureIdentity: {
      matchKey: 'M1', matchType: 'prelim', divisionId: 'men',
      teamAId: 'team-a', teamBId: 'team-b', officialRevision: 0,
      lastTransitionId: 'fixture-created',
    },
    contextVersion: 0,
  });
  const retained = reconcileRecorderSubmit({
    pendingSubmit: pending,
    currentMatchKey: 'M2',
    outcome: 'pending',
  });
  assert.equal(retained.status, 'pending');
  assert.equal(retained.pendingSubmit, pending);
  assert.equal(pending.operationId, 'operation-1');
  const completed = reconcileRecorderSubmit({
    pendingSubmit: pending,
    currentMatchKey: 'M2',
    outcome: 'success',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resetCurrent, false);
  assert.equal(completed.clearStorageKey, 'recorder-score:tournament:M1:uid');
  assert.equal(completed.pendingSubmit, null);
}

// A submit transaction clears the lock before its callable resolves. Matching
// submitted evidence is an expected release; another active lock is takeover.
{
  const submit = {
    matchKey: 'M1',
    token: 'token-1',
    operationId: 'operation-1',
    submissionVersion: 2,
    score: { sets: [{ a: 10, b: 8 }, { a: 10, b: 9 }] },
  };
  const released = reconcileRecorderOwnership({
    workflow: {
      draftState: 'submitted',
      lock: null,
      draft: submit.score,
      submittedSnapshot: submit.score,
      submission: { recorder: { uid: 'uid-1' } },
      submissionVersion: 3,
    },
    metadata: { fromCache: false },
    matchKey: 'M1',
    token: 'token-1',
    uid: 'uid-1',
    pendingSubmit: submit,
  });
  assert.deepEqual(released, {
    status: 'expected_release',
    operation: 'submit',
    operationId: 'operation-1',
  });
  assert.equal(reconcileRecorderOwnership({
    workflow: {
      draftState: 'editing',
      lock: { token: 'takeover-token', sessionId: 'session-2' },
    },
    metadata: { fromCache: false },
    matchKey: 'M1',
    token: 'token-1',
    uid: 'uid-1',
    pendingSubmit: submit,
  }).status, 'lost');
  assert.equal(reconcileRecorderOwnership({
    workflow: {
      draftState: 'submitted',
      lock: null,
      submittedSnapshot: { sets: [{ a: 9, b: 8 }, { a: 10, b: 9 }] },
      submission: { recorder: { uid: 'uid-1' } },
      submissionVersion: 3,
    },
    metadata: { fromCache: false },
    matchKey: 'M1',
    token: 'token-1',
    uid: 'uid-1',
    pendingSubmit: submit,
  }).status, 'lost');
  assert.equal(reconcileRecorderOwnership({
    workflow: {
      draftState: 'submitted',
      lock: null,
      submittedSnapshot: submit.score,
      submission: { recorder: { uid: 'uid-1' } },
      submissionVersion: 2,
    },
    metadata: { fromCache: false },
    matchKey: 'M1',
    token: 'token-1',
    uid: 'uid-1',
    pendingSubmit: submit,
  }).status, 'lost');
  assert.equal(reconcileRecorderOwnership({
    workflow: { draftState: 'submitted', lock: null },
    metadata: { fromCache: true },
    matchKey: 'M1',
    token: 'token-1',
    uid: 'uid-1',
    pendingSubmit: submit,
  }).status, 'ignore');
}

// End/discard releases are recognized only from their terminal server fields;
// an empty discard stays pending until its callable result supplies proof.
{
  const end = {
    matchKey: 'M1',
    token: 'token-end',
    operationId: 'operation-end',
    draft: { sets: [{ a: 10, b: 8 }] },
  };
  assert.equal(reconcileRecorderOwnership({
    workflow: {
      draftState: 'idle',
      lock: null,
      draft: end.draft,
      draftRetention: 'retained_after_cancel',
      draftRetainedBy: { uid: 'uid-1' },
    },
    metadata: { fromCache: false },
    matchKey: 'M1',
    token: 'token-end',
    uid: 'uid-1',
    pendingEnd: end,
  }).status, 'expected_release');
  const discard = {
    matchKey: 'M1',
    token: 'token-discard',
    operationId: 'operation-discard',
    draft: { sets: [{ a: 10, b: 8 }] },
  };
  assert.equal(reconcileRecorderOwnership({
    workflow: { draftState: 'idle', lock: null },
    metadata: { fromCache: false },
    matchKey: 'M1',
    token: 'token-discard',
    uid: 'uid-1',
    pendingDiscard: discard,
  }).status, 'expected_release');
  assert.equal(reconcileRecorderOwnership({
    workflow: { draftState: 'idle', lock: null },
    metadata: { fromCache: false },
    matchKey: 'M1',
    token: 'token-discard',
    uid: 'uid-1',
    pendingDiscard: { ...discard, draft: { sets: [] } },
  }).status, 'awaiting_operation');
}

// Lease renewals can resolve after stop() or after the match/token changes.
// Those obsolete callbacks must not revoke a newly claimed lease.
{
  const source = readFileSync(new URL('./recorder.js', import.meta.url), 'utf8');
  const heartbeatStart = source.indexOf('function beginHeartbeat()');
  const heartbeatEnd = source.indexOf('\nfunction channelMessage', heartbeatStart);
  assert.ok(heartbeatStart >= 0 && heartbeatEnd > heartbeatStart, 'heartbeat callback remains directly testable');
  const heartbeatSource = source.slice(heartbeatStart, heartbeatEnd);
  const context = { version: 1, matchKey: 'M1', courtId: 'court-a', uid: 'uid-1' };
  const callbacks = [];
  const statusCalls = [];
  const renderCalls = [];
  const edit = { token: 'token-1', dirty: true, pendingSubmit: null, pendingEnd: null, pendingDiscard: null };
  const runtime = {
    heartbeatEpoch: 0,
    heartbeat: null,
    renderedFormKey: '',
    queue: { queueRevision: 3 },
    edit,
    captureContext: () => context,
    contextIsCurrent: (value) => value === context,
    startLeaseHeartbeat: ({ onError }) => {
      callbacks.push(onError);
      return { stop() {}, start() {}, reconcile() {} };
    },
    stopHeartbeat() {
      runtime.heartbeatEpoch += 1;
      runtime.heartbeat?.stop?.();
      runtime.heartbeat = null;
    },
    reasonCode: () => 'ownership_lost',
    recorderReason: () => 'ownership lost',
    status: (value) => statusCalls.push(value),
    setOwnershipLostWarning: (matchKey, token) => statusCalls.push(`lost:${matchKey}:${token}`),
    render: () => renderCalls.push(true),
  };
  const { beginHeartbeat } = runInNewContext(`(() => {
    ${heartbeatSource}
    return { beginHeartbeat };
  })()`, runtime);
  beginHeartbeat();
  const firstCallback = callbacks[0];
  runtime.stopHeartbeat();
  firstCallback({ code: 'aborted' });
  assert.deepEqual(statusCalls, []);
  assert.deepEqual(renderCalls, []);

  beginHeartbeat();
  const secondCallback = callbacks[1];
  edit.token = 'token-2';
  secondCallback({ code: 'aborted' });
  assert.deepEqual(statusCalls, []);
  assert.deepEqual(renderCalls, []);

  edit.token = 'token-3';
  beginHeartbeat();
  callbacks[2]({ code: 'aborted' });
  assert.deepEqual(statusCalls, ['lost:M1:token-3']);
  assert.deepEqual(renderCalls, [true]);
}

// Confirmation data preserves a draw, a deciding third set, and long names as
// separate text fields/rows instead of flattening scores into one string.
{
  const draw = buildRecorderConfirmationModel({
    court: 'A코트',
    recorder: '민서',
    matchLabel: '청춘조 예선 · 1경기',
    teamA: '아주 긴 팀 이름 A',
    teamB: '아주 긴 팀 이름 B',
    score: { sets: [{ a: 10, b: 8 }, { a: 8, b: 10 }] },
    outcome: '무승부',
  });
  assert.equal(draw.outcome, '무승부');
  assert.deepEqual(draw.sets, [
    { label: '1세트', a: 10, b: 8 },
    { label: '2세트', a: 8, b: 10 },
  ]);
  assert.equal(draw.teamA, '아주 긴 팀 이름 A');
  assert.equal(draw.teamB, '아주 긴 팀 이름 B');
  const final = buildRecorderConfirmationModel({
    court: '본선코트',
    recorder: '지우',
    matchLabel: '준결승 1경기',
    teamA: '팀 A',
    teamB: '팀 B',
    score: { sets: [{ a: 10, b: 8 }, { a: 8, b: 10 }, { a: 7, b: 5 }] },
    outcome: '팀 A 승리',
  });
  assert.equal(final.sets.length, 3);
  assert.deepEqual(final.sets[2], { label: '3세트', a: 7, b: 5 });
}

// Recorder save recovery: a lost response is confirmed only by a newer matching
// authoritative snapshot, while a different server draft never replaces local work.
{
  const attempted = { sets: [{ a: 10, b: 8 }] };
  const confirmed = reconcileRecorderSnapshot({
    pendingSave: { draft: attempted, expectedRevision: 2 },
    remoteDraft: { sets: [{ a: '10', b: '8' }] },
    remoteRevision: 3,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.revision, 3);
  assert.equal(recorderDraftsEqual(confirmed.draft, attempted), true);

  const conflict = reconcileRecorderSnapshot({
    pendingSave: { draft: attempted, expectedRevision: 2 },
    remoteDraft: { sets: [{ a: 9, b: 8 }] },
    remoteRevision: 3,
  });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.localDraft, attempted);
  assert.deepEqual(conflict.remoteDraft, { sets: [{ a: 9, b: 8 }] });
  assert.deepEqual(resolveRecorderConflict('local', conflict), {
    status: 'retry', draft: attempted, expectedRevision: 3,
  });
  assert.deepEqual(resolveRecorderConflict('remote', conflict), {
    status: 'use_remote', draft: { sets: [{ a: 9, b: 8 }] }, revision: 3,
  });
}

// The server snapshot may arrive while the local form is already dirty,
// before the save request is created. A stale-revision response must still
// reconcile against that same newer snapshot rather than retrying revision 2.
{
  const local = { sets: [{ a: 10, b: 8 }] };
  const serverSeenBeforeSave = { sets: [{ a: 9, b: 8 }] };
  const recovery = reconcileRecorderSnapshot({
    pendingSave: { draft: local, expectedRevision: 2 },
    remoteDraft: serverSeenBeforeSave,
    remoteRevision: 4,
  });
  assert.equal(recovery.status, 'conflict');
  assert.equal(resolveRecorderConflict('local', recovery).expectedRevision, 4);
}

// Blocked and malformed local storage must fail closed without throwing.
{
  const malformed = parseStoredRecorderDraft('{not-json');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'malformed');
  const blocked = readStoredRecorderDraft({
    getItem() { throw new Error('storage disabled'); },
  }, 'recorder-score:test');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'blocked');
}

// A failed listener remains unsafe until a non-cache authoritative snapshot
// recovers it; the recovery clears the stale error.
{
  const failed = recorderDataState({ status: 'ready', error: null }, 'error', { code: 'permission-denied' });
  assert.equal(failed.status, 'error');
  const recovered = recorderDataState(failed, 'ready');
  assert.deepEqual(recovered, { status: 'ready', error: null });
}

// 코트 초안을 먼저 편집한 뒤 다른 조·여자부 대진을 생성해도 새 경기가 합쳐져야 한다.
{
  const current = [{
    matchKey: 'men-halla-1',
    matchType: 'prelim',
    division: 'men',
    courtId: 'court-a',
    label: '이전 한라 표기',
  }, {
    matchKey: 'deleted-live-match',
    matchType: 'prelim',
    division: 'men',
    courtId: 'court-a',
    label: '이미 삭제된 경기',
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
  assert.equal(merged.some((assignment) => assignment.matchKey === 'deleted-live-match'), false, '서버에서 사라진 경기 초안 제거');
}

// 통합 보드의 필터·완료 분류는 입력 배열과 전체 코트 순서를 변경하지 않는다.
{
  const options = [
    { matchKey: 'p1', matchType: 'prelim' },
    { matchKey: 'f1', matchType: 'final' },
    { matchKey: 'p2', matchType: 'prelim' },
  ];
  const plannerAssignments = [
    { matchKey: 'p1', courtId: 'court-a', courtOrder: 1, publicStatus: 'scheduled' },
    { matchKey: 'f1', courtId: 'court-a', courtOrder: 2, publicStatus: 'completed', officialRevision: 4 },
    { matchKey: 'p2', courtId: 'court-a', courtOrder: 3, publicStatus: 'scheduled' },
  ];
  const beforeOptions = structuredClone(options);
  const beforeAssignments = structuredClone(plannerAssignments);
  assert.equal(plannerPhaseMatches(options[0], 'prelim'), true);
  assert.equal(plannerPhaseMatches(options[1], 'prelim'), false);
  assert.deepEqual([...groupPlannerAssignments(options, plannerAssignments, 'prelim').get('court-a')]
    .map((option) => option.matchKey), ['p1', 'p2']);
  assert.deepEqual(options, beforeOptions);
  assert.deepEqual(plannerAssignments, beforeAssignments);
  assert.equal(isPlannerMatchCompleted(options[1], plannerAssignments[1], { draftState: 'approved' }), true);
  assert.equal(isPlannerMatchCompleted(options[1], { ...plannerAssignments[1], publicStatus: 'replay_required' }, { draftState: 'approved' }), false);
  assert.equal(isPlannerMatchCompleted(options[1], plannerAssignments[1], { draftState: 'approved', lock: { token: 'live' } }), false);
  assert.equal(isPlannerMatchCompleted(options[1], { ...plannerAssignments[1], officialRevision: 9, publicStatus: 'scheduled' }, { draftState: 'idle' }), false);
  assert.equal(isPlannerMatchCompleted(options[1], plannerAssignments[1], { draftState: 'rejected', status: 'approved' }), false);
  const local = [{ ...plannerAssignments[1], courtId: 'local-court', courtOrder: 9, publicStatus: 'scheduled' }];
  const refreshed = reconcilePlannerAssignments(local, [options[1]], [plannerAssignments[1]]);
  assert.equal(refreshed[0].courtId, 'local-court');
  assert.equal(refreshed[0].courtOrder, 9);
  assert.equal(refreshed[0].publicStatus, 'completed');
  assert.equal(local[0].publicStatus, 'scheduled');
  assert.equal(isPlannerMatchCompleted(options[1], refreshed[0], { draftState: 'approved' }), true);
}

// 화살표는 필터 배열이 아니라 전체 순서의 바로 옆 활성 경기만 대상으로 한다.
{
  const options = [
    { matchKey: 'prelim-1', matchType: 'prelim' },
    { matchKey: 'final-1', matchType: 'final' },
    { matchKey: 'final-2', matchType: 'final' },
  ];
  const plannerAssignments = [
    { matchKey: 'prelim-1', courtId: 'court-a', courtOrder: 1, publicStatus: 'scheduled' },
    { matchKey: 'final-1', courtId: 'court-a', courtOrder: 2, publicStatus: 'scheduled' },
    { matchKey: 'final-2', courtId: 'court-a', courtOrder: 3, publicStatus: 'scheduled' },
  ];
  const finalsOnly = getPlannerVisibleAdjacent(options, plannerAssignments, new Map(), 'final-1', 'final');
  assert.deepEqual(finalsOnly, { previousMatchKey: null, nextMatchKey: 'final-2' });
  const blockedByHistoric = getPlannerVisibleAdjacent(
    options,
    plannerAssignments.map((assignment) => assignment.matchKey === 'final-2'
      ? { ...assignment, publicStatus: 'completed' }
      : assignment),
    new Map([['final-2', { draftState: 'approved' }]]),
    'final-1',
    'all',
  );
  assert.deepEqual(blockedByHistoric, { previousMatchKey: 'prelim-1', nextMatchKey: null });
  const moved = movePlannerMatchByOffset(options, plannerAssignments, new Map(), 'final-2', -1, 'final');
  assert.deepEqual([...moved].sort((a, b) => a.courtOrder - b.courtOrder).map((assignment) => [assignment.matchKey, assignment.courtOrder]), [
    ['prelim-1', 1], ['final-2', 2], ['final-1', 3],
  ]);
  assert.deepEqual(plannerAssignments.map((assignment) => assignment.matchKey), ['prelim-1', 'final-1', 'final-2']);
  assert.deepEqual(movePlannerMatchByOffset(options, plannerAssignments, new Map(), 'prelim-1', 1, 'final'), plannerAssignments);
  const interleaved = plannerAssignments.map((assignment, index) => ({ ...assignment, courtOrder: [2, 1, 3][index] }));
  assert.deepEqual(getPlannerVisibleAdjacent(options, interleaved, new Map(), 'final-1', 'final'), {
    previousMatchKey: null, nextMatchKey: null,
  });
  const gaps = plannerAssignments.map((assignment, index) => ({ ...assignment, courtOrder: [7, 20, 40][index] }));
  const swapped = movePlannerMatchByOffset(options, gaps, new Map(), 'final-2', -1, 'final');
  assert.deepEqual(swapped.map((assignment) => assignment.courtOrder), [7, 40, 20]);
}

// 코트 선택은 숨겨진 경기를 제외한 배열로 바꾸지 않고 목적지 전체 끝에 붙인다.
{
  const plannerAssignments = [
    { matchKey: 'hidden-prelim', courtId: 'court-b', courtOrder: 1, matchType: 'prelim' },
    { matchKey: 'visible-final', courtId: 'court-a', courtOrder: 1, matchType: 'final' },
    { matchKey: 'other-final', courtId: 'court-b', courtOrder: 2, matchType: 'final' },
  ];
  const moved = movePlannerAssignment(plannerAssignments, 'visible-final', 'court-b');
  assert.deepEqual(moved.map((assignment) => [assignment.matchKey, assignment.courtId, assignment.courtOrder]), [
    ['hidden-prelim', 'court-b', 1],
    ['visible-final', 'court-b', 3],
    ['other-final', 'court-b', 2],
  ]);
  assert.deepEqual(plannerAssignments.map((assignment) => [assignment.matchKey, assignment.courtId, assignment.courtOrder]), [
    ['hidden-prelim', 'court-b', 1],
    ['visible-final', 'court-a', 1],
    ['other-final', 'court-b', 2],
  ]);
  const originalMoved = structuredClone(moved);
  const appended = movePlannerAssignment(moved, 'other-final', 'court-b');
  assert.deepEqual([...appended].sort((a, b) => a.courtOrder - b.courtOrder).map((assignment) => assignment.matchKey), [
    'hidden-prelim', 'visible-final', 'other-final',
  ]);
  assert.deepEqual(moved, originalMoved);
}

// A whole-court swap includes hidden/completed and cross-phase entries while
// preserving the internal order of both source lists.
{
  const plannerAssignments = [
    { matchKey: 'a-hidden', courtId: 'court-a', courtOrder: 3, matchType: 'prelim', publicStatus: 'scheduled' },
    { matchKey: 'b-final', courtId: 'court-b', courtOrder: 2, matchType: 'final', publicStatus: 'completed' },
    { matchKey: 'a-final', courtId: 'court-a', courtOrder: 1, matchType: 'final', publicStatus: 'completed' },
    { matchKey: 'b-prelim', courtId: 'court-b', courtOrder: 1, matchType: 'prelim', publicStatus: 'in_progress' },
  ];
  const before = structuredClone(plannerAssignments);
  const swapped = swapPlannerCourts(plannerAssignments, 'court-a', 'court-b');
  assert.deepEqual(swapped.map((assignment) => [
    assignment.matchKey, assignment.courtId, assignment.courtOrder,
  ]), [
    ['a-hidden', 'court-b', 2],
    ['b-final', 'court-a', 2],
    ['a-final', 'court-b', 1],
    ['b-prelim', 'court-a', 1],
  ]);
  assert.deepEqual(plannerAssignments, before);
  assert.deepEqual(
    swapped.filter((assignment) => assignment.courtId === 'court-a')
      .sort((left, right) => left.courtOrder - right.courtOrder)
      .map((assignment) => assignment.matchKey),
    ['b-prelim', 'b-final'],
  );
  assert.deepEqual(
    swapped.filter((assignment) => assignment.courtId === 'court-b')
      .sort((left, right) => left.courtOrder - right.courtOrder)
      .map((assignment) => assignment.matchKey),
    ['a-final', 'a-hidden'],
  );
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

// Explicit score-entry navigation waits for the rendered workflow panel,
// preserves focus visibility, and never acts on an obsolete claim context.
{
  const source = readFileSync(new URL('./recorder.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('const navigateToWorkflowEntry =');
  const helperEnd = source.indexOf('\nconst displayCourt', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'recorder navigation helper remains directly testable');
  const helperSource = source.slice(helperStart, helperEnd);
  const createMock = ({ reducedMotion = false } = {}) => {
    let frame = null;
    let currentContext = 'match-1';
    let staleTerminal = false;
    const title = { focusCalls: [], focus(options) { this.focusCalls.push({ ...options }); } };
    const panel = {
      hidden: false,
      scrollCalls: [],
      scrollIntoView(options) { this.scrollCalls.push({ ...options }); },
    };
    const scoreForm = { hidden: false };
    const edit = { token: 'token-1' };
    const ui = { workflowPanel: panel, workflowTitle: title, scoreForm };
    const mediaQueries = [];
    const { navigateToWorkflowEntry, setViewState } = runInNewContext(`(() => {
      let viewState = "operations";
      ${helperSource}
      return {
        navigateToWorkflowEntry,
        setViewState: (value) => { viewState = value; },
      };
    })()`, {
      contextIsCurrent: (context) => context === currentContext,
      edit,
      ui,
      requestAnimationFrame: (callback) => { frame = callback; },
      window: {
        matchMedia: (query) => {
          mediaQueries.push(query);
          return { matches: reducedMotion };
        },
      },
      isStaleTerminalCurrent: () => staleTerminal,
    });
    return {
      panel,
      scoreForm,
      title,
      mediaQueries,
      schedule: (context = 'match-1', token = edit.token) => navigateToWorkflowEntry(context, token),
      runFrame: () => frame?.(),
      setContext: (value) => { currentContext = value; },
      setToken: (value) => { edit.token = value; },
      setStale: (value) => { staleTerminal = value; },
      setViewState,
    };
  };

  const entry = createMock();
  entry.schedule();
  assert.equal(entry.title.focusCalls.length, 0);
  assert.equal(entry.panel.scrollCalls.length, 0);
  entry.runFrame();
  assert.deepEqual(entry.title.focusCalls, [{ preventScroll: true }]);
  assert.deepEqual(entry.panel.scrollCalls, [{ behavior: 'smooth', block: 'start' }]);
  assert.deepEqual(entry.mediaQueries, ['(prefers-reduced-motion: reduce)']);

  const alreadyEditing = createMock({ reducedMotion: true });
  alreadyEditing.setToken('editing-token');
  alreadyEditing.schedule();
  alreadyEditing.runFrame();
  assert.equal(alreadyEditing.title.focusCalls.length, 1);
  assert.deepEqual(alreadyEditing.panel.scrollCalls, [{ behavior: 'auto', block: 'start' }]);

  const failedClaim = createMock();
  failedClaim.schedule('match-1', null);
  failedClaim.runFrame();
  assert.equal(failedClaim.title.focusCalls.length, 0);
  assert.equal(failedClaim.panel.scrollCalls.length, 0);

  const staleContext = createMock();
  staleContext.schedule();
  staleContext.setContext('match-2');
  staleContext.runFrame();
  assert.equal(staleContext.title.focusCalls.length, 0);
  assert.equal(staleContext.panel.scrollCalls.length, 0);

  const staleToken = createMock();
  staleToken.schedule();
  staleToken.setToken('token-2');
  staleToken.runFrame();
  assert.equal(staleToken.title.focusCalls.length, 0);
  assert.equal(staleToken.panel.scrollCalls.length, 0);

  const hiddenPanel = createMock();
  hiddenPanel.schedule();
  hiddenPanel.panel.hidden = true;
  hiddenPanel.runFrame();
  assert.equal(hiddenPanel.title.focusCalls.length, 0);
  assert.equal(hiddenPanel.panel.scrollCalls.length, 0);

  const hiddenScoreForm = createMock();
  hiddenScoreForm.schedule();
  hiddenScoreForm.scoreForm.hidden = true;
  hiddenScoreForm.runFrame();
  assert.equal(hiddenScoreForm.title.focusCalls.length, 0);
  assert.equal(hiddenScoreForm.panel.scrollCalls.length, 0);

  const staleQueue = createMock();
  staleQueue.schedule();
  staleQueue.setStale(true);
  staleQueue.runFrame();
  assert.equal(staleQueue.title.focusCalls.length, 0);
  assert.equal(staleQueue.panel.scrollCalls.length, 0);

  const nonOperationsView = createMock();
  nonOperationsView.schedule();
  nonOperationsView.setViewState('selection');
  nonOperationsView.runFrame();
  assert.equal(nonOperationsView.title.focusCalls.length, 0);
  assert.equal(nonOperationsView.panel.scrollCalls.length, 0);
}

console.log('score-workflow fixtures passed');

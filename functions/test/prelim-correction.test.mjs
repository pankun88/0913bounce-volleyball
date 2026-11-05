import assert from 'node:assert/strict';
import {
  buildQualificationSnapshot,
  computeQualificationState,
} from '../match-logic.generated.js';
import {
  assertFinalQualificationCurrent,
  planPrelimQualificationChange,
} from '../admin-workflow.js';

const win = [{ a: 10, b: 8 }, { a: 10, b: 8 }];
const lose = [{ a: 8, b: 10 }, { a: 8, b: 10 }];
const draw = [{ a: 10, b: 8 }, { a: 8, b: 10 }];

const pairs = [['a', 'b'], ['a', 'c'], ['b', 'c']];
const prelimRecord = ([teamA, teamB], index) => ({
  id: `m${index}`, division: 'men', groupId: 'g1', teamA, teamB,
  sets: win, status: 'done', result: 'A', officialCurrent: true, officialRevision: 1,
});
const snapshot = buildQualificationSnapshot({
  division: 'men',
  qualifyPerGroup: 2,
  groups: [{ id: 'g1', division: 'men', matchMode: 'roundrobin' }],
  teams: ['a', 'b', 'c'].map((id) => ({ id, division: 'men', groupId: 'g1', name: id })),
  matches: pairs.map(prelimRecord),
});

const finalRoot = {
  id: 'f1', round: 1, index: 0, status: 'pending', division: 'men',
  teamA: { id: 'a' }, teamB: { id: 'b' }, officialRevision: 0,
};
const playedFinal = { ...finalRoot, status: 'done', officialRevision: 1, sets: win };

function context({ played, finalQualification }) {
  const final = played ? playedFinal : finalRoot;
  const proof = finalQualification === undefined ? {
    status: 'current', participantIds: ['a', 'b'], tieSelections: { g1: [] },
    fingerprint: 'old', reason: 'published',
  } : finalQualification;
  return {
    division: 'men',
    snapshot,
    state: computeQualificationState(snapshot),
    fingerprint: 'fp',
    finalQualification: proof,
    finalsSnap: { empty: false, docs: [{ id: 'f1', data: () => final }] },
    finals: new Map([['f1', final]]),
    assignments: new Map(),
    workflows: new Map(),
    prelims: new Map(pairs.map((pair, index) => [`m${index}`, prelimRecord(pair, index)])),
  };
}

const evaluated = (sets, result) => ({
  sets, status: 'done', result,
  setsWonA: result === 'A' ? 2 : result === 'B' ? 0 : 1,
  setsWonB: result === 'A' ? 0 : result === 'B' ? 2 : 1,
  pointsForA: 0, pointsForB: 0,
});
const plan = (ctx, matchId, sets, result, correction) => planPrelimQualificationChange(
  ctx, { matchType: 'prelim', matchId, matchKey: matchId }, ctx.prelims.get(matchId),
  evaluated(sets, result), 2, 'tx', correction,
);
const reasonOf = (fn) => { try { fn(); } catch (error) { return error.details?.reason ?? error.message; } return null; };

// (a) 진출팀이 그대로면 본선 시작 후에도 기존처럼 current 로 재검증된다.
const unchanged = plan(context({ played: true }), 'm0', draw, 'draw');
assert.equal(unchanged.metadata.status, 'current');
assert.equal(unchanged.metadata.reason, 'prelim_corrected_revalidated');
assert.equal(unchanged.metadata.postFinalCorrection, undefined);

// (b) 본선 시작 전에는 순위가 바뀌어도 저장되고 stale 로 표시된다.
const preplay = plan(context({ played: false }), 'm2', lose, 'B');
assert.equal(preplay.metadata.status, 'stale');
assert.equal(preplay.metadata.reason, 'prelim_changed');
assert.deepEqual(preplay.metadata.participantIds, ['a', 'b']);

// (c) 본선 시작 후 진출팀이 바뀌면 플래그 없이는 한글 매핑용 reason 으로 차단된다.
const blockedCtx = context({ played: true });
assert.equal(reasonOf(() => plan(blockedCtx, 'm2', lose, 'B')), 'prelim_correction_after_finals');
assert.equal(reasonOf(() => plan(blockedCtx, 'm2', lose, 'B', { allowPostFinalCorrection: false })), 'prelim_correction_after_finals');

// (c) 비상용 플래그가 있으면 진출팀·추첨 기록은 그대로, 상태는 current 이고 감사 표식이 남는다.
const override = plan(blockedCtx, 'm2', lose, 'B', { allowPostFinalCorrection: true });
assert.equal(override.metadata.status, 'current');
assert.equal(override.metadata.reason, 'prelim_corrected_after_finals');
assert.deepEqual(override.metadata.participantIds, ['a', 'b']);
assert.deepEqual(override.metadata.tieSelections, { g1: [] });
assert.equal(override.metadata.postFinalCorrection.count, 1);
assert.deepEqual(override.metadata.postFinalCorrection.groupIds, ['g1']);
assert.ok(Number.isFinite(override.metadata.postFinalCorrection.at));
assert.notEqual(override.metadata.fingerprint, blockedCtx.finalQualification.fingerprint);

// 정정 뒤에도 본선 점수 기록은 막히지 않는다 (assertFinalQualificationCurrent 통과).
const afterCtx = {
  ...context({ played: true, finalQualification: override.metadata }),
  snapshot: context({ played: true }).snapshot,
};
const correctedSnapshot = buildQualificationSnapshot({
  division: 'men', qualifyPerGroup: 2,
  groups: [{ id: 'g1', division: 'men', matchMode: 'roundrobin' }],
  teams: ['a', 'b', 'c'].map((id) => ({ id, division: 'men', groupId: 'g1', name: id })),
  matches: pairs.map((pair, index) => (index === 2
    ? { ...prelimRecord(pair, index), sets: lose, result: 'B', officialRevision: 2 } : prelimRecord(pair, index))),
});
afterCtx.snapshot = correctedSnapshot;
afterCtx.state = computeQualificationState(correctedSnapshot);
afterCtx.fingerprint = override.metadata.fingerprint;
assert.doesNotThrow(() => assertFinalQualificationCurrent(afterCtx), 'final scoring stays unblocked after override');
// 같은 증명이라도 플래그 표식이 없으면 새 순위와 달라 막힌다 (표식이 실제로 필요한 이유).
const { postFinalCorrection: _marker, ...unmarked } = override.metadata;
assert.equal(reasonOf(() => assertFinalQualificationCurrent({ ...afterCtx, finalQualification: unmarked })), 'qualification_unverified');
// 표식이 있어도 대진표의 진출팀 집합이 다르면 계속 막힌다.
assert.throws(() => assertFinalQualificationCurrent({
  ...afterCtx, finalQualification: { ...override.metadata, participantIds: ['a', 'c'] },
}));

// 두 번째 정정은 횟수와 조 목록을 누적한다.
const second = plan(
  context({ played: true, finalQualification: override.metadata }), 'm1', lose, 'B',
  { allowPostFinalCorrection: true },
);
assert.equal(second.metadata.postFinalCorrection.count, 2);

console.log('prelim correction unit tests passed');

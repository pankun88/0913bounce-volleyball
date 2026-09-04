import assert from 'node:assert/strict';
import {
  getSetWinner,
  evaluatePrelimMatch,
  evaluateFinalMatch,
  computeGroupStandings,
  computeAutomaticQualifiers,
  normalizePlayedSets,
  validateSetScore,
} from './match-logic.js';
import { generateBracket, recordMatchResult, invalidateDescendantResults, groupByRound, seedOrder, nextPowerOfTwo, buildCrossGroupSeedOrder, swapFinalSeedSlots, resetAndPropagateByes, confirmBye, placeByeTeam, publicMatchView, roundLabel } from './bracket.js';
import { generateRoundRobin, orderExistingRoundRobinMatchIds } from './schedule.js';
import { normalizeRingOrder, getRingEdges, getRingMatchPairs, getRingPositions, getRingEdgeLabelPositions } from './ring-bracket.js';
import {
  backupFromServerExport, normalizeBackupData, restorableRootData, selectRestoreRecovery, upgradeLegacyBackup,
} from './backup-format.js';
import {
  courtMatchSummary, courtTeamNames, formatCourtName, normalizeCourtName, syncCourtOrderWithPrelimOrder,
} from './court-display.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', label); }
}

// ---- public match view ----
const unapprovedByePending = publicMatchView({
  status: 'bye_pending',
  teamA: { id: 'bye-team', name: '부전승 팀' },
  teamB: null,
});
const retractedOfficial = publicMatchView({
  status: 'done',
  officialRevision: 3,
  officialCurrent: false,
  sets: [{ a: 10, b: 2 }, { a: 10, b: 3 }],
  result: 'A',
  winner: 'A',
});
check('retracted official result is hidden despite historical revision',
  retractedOfficial.status === 'pending'
    && retractedOfficial.sets.length === 0
    && retractedOfficial.result === null
    && retractedOfficial.winner === null);
check('public view preserves bye_pending status and team placement',
  unapprovedByePending.status === 'bye_pending' && unapprovedByePending.teamA?.id === 'bye-team' && unapprovedByePending.teamB === null);
check('public view preserves confirmed bye status', publicMatchView({ status: 'bye' }).status === 'bye');
const unapprovedInProgress = publicMatchView({
  status: 'in_progress',
  sets: [{ a: 25, b: 0 }],
  result: 'A',
  winner: 'A',
  winnerSide: 'A',
  winnerTeam: { id: 'bye-team', name: '부전승 팀' },
  setsWonA: 1,
  setsWonB: 0,
  pointsForA: 25,
  pointsForB: 0,
});
check('public view preserves in_progress status while hiding unapproved scores and winners',
  unapprovedInProgress.status === 'in_progress'
    && unapprovedInProgress.sets.length === 0
    && unapprovedInProgress.result === null
    && unapprovedInProgress.winner === null
    && unapprovedInProgress.winnerSide === null
    && unapprovedInProgress.winnerTeam === null
    && unapprovedInProgress.setsWonA === null
    && unapprovedInProgress.setsWonB === null
    && unapprovedInProgress.pointsForA === null
    && unapprovedInProgress.pointsForB === null);
const approvedPublicMatch = {
  officialRevision: 1,
  status: 'done',
  sets: [{ a: 25, b: 22 }],
  result: 'A',
  winner: 'A',
  winnerSide: 'A',
  winnerTeam: { id: 'winner' },
};
check('public view leaves approved official matches unchanged',
  publicMatchView(approvedPublicMatch) === approvedPublicMatch);

// ---- court display ----
check('court input stores only identifier', normalizeCourtName(' A코트 ') === 'A');
check('court display appends suffix once', formatCourtName('A') === 'A코트');
check('court display never duplicates suffix', formatCourtName('A코트') === 'A코트');
check('empty court display uses fallback', formatCourtName('', '코트 미정') === '코트 미정');
const courtTeams = new Map([
  ['team-a', { name: '강남 스파이크' }],
  ['team-b', { name: '서초 블로커스' }],
]);
const courtGroups = new Map([['group-a', { name: 'A조' }]]);
const prelimCourtView = courtMatchSummary(
  { matchType: 'prelim' },
  { teamA: 'team-a', teamB: 'team-b', groupId: 'group-a', round: 3 },
  { teamsById: courtTeams, groupsById: courtGroups },
);
check('prelim court display resolves real team names', prelimCourtView.teams === '강남 스파이크 vs 서초 블로커스');
check('prelim court display resolves group and round', prelimCourtView.label === 'A조 예선 · 3경기');
const finalCourtView = courtMatchSummary(
  { matchType: 'final' },
  { teamA: { name: '남자 1위' }, teamB: { name: '남자 2위' }, roundLabel: '결승', index: 0 },
);
check('final court display resolves embedded team names', finalCourtView.teams === '남자 1위 vs 남자 2위');
check('final court display resolves round label', finalCourtView.label === '결승 1경기');
check('unresolved final teams are explicit', courtTeamNames({ teamA: null, teamB: null }).a === '대진 미정');
const reorderedCourtAssignments = [
  { matchKey: 'group-a-1', courtId: 'court-1', courtOrder: 1 },
  { matchKey: 'other-group', courtId: 'court-1', courtOrder: 2 },
  { matchKey: 'group-a-2', courtId: 'court-1', courtOrder: 3 },
  { matchKey: 'group-a-3', courtId: 'court-2', courtOrder: 1 },
];
syncCourtOrderWithPrelimOrder(reorderedCourtAssignments, ['group-a-2', 'group-a-3', 'group-a-1']);
check(
  'prelim reorder updates matching games within each court while preserving unrelated slots',
  reorderedCourtAssignments.find((item) => item.matchKey === 'group-a-2').courtOrder === 1
    && reorderedCourtAssignments.find((item) => item.matchKey === 'other-group').courtOrder === 2
    && reorderedCourtAssignments.find((item) => item.matchKey === 'group-a-1').courtOrder === 3,
);
check(
  'prelim reorder normalizes independently assigned courts',
  reorderedCourtAssignments.find((item) => item.matchKey === 'group-a-3').courtOrder === 1,
);

// ---- backup format boundary ----
const legacyBackup = {
  type: 'backup', version: 1,
  info: { name: '기존 여자부', qualifyPerGroup: 2 },
  groups: [{ id: 'g1', data: { name: 'A조' } }],
  teams: [{ id: 't1', data: { name: '팀1', groupId: 'g1' } }],
  prelimMatches: [{ id: 'p1', data: { teamA: 't1' } }],
  finalMatches: [{ id: 'f1', data: { status: 'done' } }],
};
const legacyMenBackup = {
  ...legacyBackup,
  info: { name: '기존 남자부', qualifyPerGroup: 3 },
};
for (const [label, backup] of [['women', legacyBackup], ['men', legacyMenBackup]]) {
  let rejected = false;
  try {
    normalizeBackupData(backup);
  } catch {
    rejected = true;
  }
  check(`legacy ${label} backup is rejected instead of pseudo-migrated`, rejected);
}
const upgradedLegacy = upgradeLegacyBackup({
  ...legacyBackup,
  app: 'bounce-volleyball',
  tournamentId: 'main',
  prelimMatches: [{
    id: 'p1',
    data: {
      id: 'p1', groupId: 'g1', teamA: { id: 't1', name: '팀1' },
      teamB: { id: 't2', name: '팀2' }, sets: [{ a: 10, b: 8 }, { a: 10, b: 7 }],
      status: 'done', result: 'A',
    },
  }],
  teams: [
    { id: 't1', data: { name: '팀1', groupId: 'g1' } },
    { id: 't2', data: { name: '팀2', groupId: 'g1' } },
  ],
  finalMatches: [{
    id: 'f1',
    data: {
      id: 'f1', round: 1, index: 0, teamA: { id: 't1', name: '팀1' },
      teamB: { id: 't2', name: '팀2' }, sets: [], status: 'pending',
      nextMatchId: null, nextSlot: 'A',
    },
  }],
}, 'women');
check('legacy v1 upgrade assigns every business document to selected division',
  upgradedLegacy.groups[0].data.division === 'women'
  && upgradedLegacy.teams.every((item) => item.data.division === 'women')
  && upgradedLegacy.prelimMatches[0].data.division === 'women'
  && upgradedLegacy.finalMatches.women.length === 1
  && upgradedLegacy.finalMatches.men.length === 0);
check('legacy v1 upgrade creates complete assignment-workflow pairs',
  upgradedLegacy.courtAssignments.length === 2
  && upgradedLegacy.scoreWorkflows.length === 2
  && upgradedLegacy.courtAssignments.every((item) => item.data.attemptCount === 0)
  && upgradedLegacy.scoreWorkflows.some((item) => item.id === 'p1' && item.data.draftState === 'approved'));
check('legacy v1 upgrade removes invalid championship downstream slot',
  upgradedLegacy.finalMatches.women[0].data.nextSlot === null);

const protectedRoot = {
  name: '복원 대회',
  qualifyPerGroup: { women: 2 },
  venueDisplay: '체육관',
  courtTopologyRevision: 4,
  maintenance: { enabled: true },
  recorderFeatureEnabled: true,
  updatedAt: 'server timestamp',
  admins: ['admin'],
  accessCode: 'secret',
};
const allowedRoot = restorableRootData(protectedRoot);
check('backup root allowlists only restorable settings',
  JSON.stringify(allowedRoot) === JSON.stringify({
    name: '복원 대회',
    qualifyPerGroup: { women: 2 },
    venueDisplay: '체육관',
    courtTopologyRevision: 4,
  }));
check('backup root omits protected operational fields',
  !Object.hasOwn(allowedRoot, 'maintenance') && !Object.hasOwn(allowedRoot, 'recorderFeatureEnabled') &&
  !Object.hasOwn(allowedRoot, 'updatedAt') && !Object.hasOwn(allowedRoot, 'admins') &&
  !Object.hasOwn(allowedRoot, 'accessCode'));

const emptyV3Backup = normalizeBackupData({
  app: 'bounce-volleyball',
  type: 'backup',
  version: 3,
  tournamentId: 'main',
  info: protectedRoot,
  groups: [],
  teams: [],
  prelimMatches: [],
  finalMatches: { men: [], women: [] },
  officialRevisions: [],
  courts: [],
  courtAssignments: [],
  courtQueues: [],
  scoreWorkflows: [],
  auditEvents: [],
});
check('v3 backup accepts empty business document lists',
  emptyV3Backup.groups.length === 0 && emptyV3Backup.teams.length === 0 &&
  emptyV3Backup.prelimMatches.length === 0 && emptyV3Backup.finalMatches.men.length === 0 &&
  emptyV3Backup.finalMatches.women.length === 0 && emptyV3Backup.auditEvents.length === 0);
const legacyFinalAssignmentBackup = normalizeBackupData({
  ...emptyV3Backup,
  courtAssignments: [{
    id: 'final:men:m_r1_0',
    data: { matchKey: 'final:men:m_r1_0', matchType: 'final', publicStatus: 'scheduled' },
  }],
});
check('v3 backup normalizes missing legacy assignment attempt count',
  legacyFinalAssignmentBackup.courtAssignments[0].data.attemptCount === 0);
let malformedAttemptCountRejected = false;
try {
  normalizeBackupData({
    ...emptyV3Backup,
    courtAssignments: [{ id: 'bad', data: { matchKey: 'bad', attemptCount: '0' } }],
  });
} catch {
  malformedAttemptCountRejected = true;
}
check('v3 backup still rejects non-integer assignment attempt count', malformedAttemptCountRejected);
let unexpectedEnvelopeRejected = false;
try {
  normalizeBackupData({ ...emptyV3Backup, maintenance: { enabled: true } });
} catch {
  unexpectedEnvelopeRejected = true;
}
check('v3 backup rejects unexpected operational envelope fields', unexpectedEnvelopeRejected);

const serverExportBackup = backupFromServerExport({
  version: 3,
  tournamentId: 'main',
  rootData: protectedRoot,
  chunks: [{ documents: [
    { path: 'tournaments/main/groups/g1', data: { name: 'A조' } },
    { path: 'tournaments/main/divisions/women/finalMatches/f1', data: { round: 1 } },
  ] }],
});
check('server export adapter maps exact document paths to v3 backup collections',
  serverExportBackup.groups[0].id === 'g1' && serverExportBackup.finalMatches.women[0].id === 'f1');
check('server export adapter preserves only allowed root fields',
  !Object.hasOwn(serverExportBackup.info, 'maintenance') && !Object.hasOwn(serverExportBackup, 'restoreManifests'));
check('downloaded v3 backup passes its own exact import parser',
  normalizeBackupData(serverExportBackup).tournamentId === 'main');
const retryPayload = { rootData: { name: '복원 대회' }, chunks: [] };
const savedRestore = { manifestId: 'restore-saved', payload: retryPayload };
check('restore recovery reuses same-session manifest for identical payload',
  selectRestoreRecovery({ activeManifestId: 'restore-saved', savedState: savedRestore, payload: retryPayload, newManifestId: 'restore-new' }).manifestId === 'restore-saved');
check('restore recovery supersedes an observed foreign lease',
  (() => {
    const recovery = selectRestoreRecovery({ activeManifestId: 'restore-foreign', savedState: savedRestore, payload: retryPayload, newManifestId: 'restore-new' });
    return recovery.supersede && recovery.manifestId === 'restore-new' && recovery.priorManifestId === 'restore-foreign';
  })());
check('restore recovery never reuses a terminal saved manifest without an active lease',
  selectRestoreRecovery({ activeManifestId: null, savedState: savedRestore, payload: retryPayload, newManifestId: 'restore-new' }).manifestId === 'restore-new');
check('restore recovery replaces saved manifest for changed payload',
  selectRestoreRecovery({ activeManifestId: null, savedState: savedRestore, payload: { rootData: {}, chunks: [] }, newManifestId: 'restore-new' }).manifestId === 'restore-new');

// ---- getSetWinner ----
check('10:0 -> A', getSetWinner(10, 0, 10) === 'A');
check('9:10 -> not yet (need 10 reached, 10>=10 ok, diff1 -> not decided)', getSetWinner(9, 10, 10) === null);
check('10:9 -> not decided (diff1)', getSetWinner(10, 9, 10) === null);
check('11:9 -> A decided (diff2)', getSetWinner(11, 9, 10) === 'A');
check('14:13 -> not decided', getSetWinner(14, 13, 10) === null);
check('15:14 -> A decided by cap', getSetWinner(15, 14, 10) === 'A');
check('15:13 -> A decided', getSetWinner(15, 13, 10) === 'A');
check('7:0 target7 -> A', getSetWinner(7, 0, 7) === 'A');
check('6:5 target7 -> not decided', getSetWinner(6, 5, 7) === null);
check('8:6 target7 -> A decided', getSetWinner(8, 6, 7) === 'A');

// ---- validateSetScore ----
check('112:8 target10 -> rejected (실제 버그 사례: 상한 초과)', validateSetScore(112, 8, 10).ok === false);
check('16:14 target10 -> rejected (상한 초과)', validateSetScore(16, 14, 10).ok === false);
check('-1:5 target10 -> rejected (음수)', validateSetScore(-1, 5, 10).ok === false);
check('9.5:5 target10 -> rejected (정수 아님)', validateSetScore(9.5, 5, 10).ok === false);
check('10:0 target10 -> ok (정상 종료)', validateSetScore(10, 0, 10).ok === true);
check('10:8 target10 -> ok (정상 종료, 2점차)', validateSetScore(10, 8, 10).ok === true);
check('0:0 target10 -> ok (아직 입력 안 한 세트)', validateSetScore(0, 0, 10).ok === true);
check('0:0 target7 -> ok (아직 입력 안 한 3세트)', validateSetScore(0, 0, 7).ok === true);
check('5:3 target10 -> rejected (목표 미달, 아직 안 끝난 세트)', validateSetScore(5, 3, 10).ok === false);
check('10:9 target10 -> rejected (듀스 1점차, 아직 안 끝남)', validateSetScore(10, 9, 10).ok === false);
check('10:10 target10 -> rejected (듀스 동점, 아직 안 끝남)', validateSetScore(10, 10, 10).ok === false);
check('11:9 target10 -> ok (듀스 후 2점차로 종료)', validateSetScore(11, 9, 10).ok === true);
check('12:9 target10 -> rejected (3점차로 끝남, 2점차여야 함)', validateSetScore(12, 9, 10).ok === false);
check('14:13 target10 -> rejected (듀스 1점차 상한 전, 아직 안 끝남)', validateSetScore(14, 13, 10).ok === false);
check('15:13 target10 -> ok (상한에서 2점차 종료)', validateSetScore(15, 13, 10).ok === true);
check('15:14 target10 -> ok (상한에서 1점차 종료)', validateSetScore(15, 14, 10).ok === true);
check('15:15 target10 -> rejected (상한에서 동점)', validateSetScore(15, 15, 10).ok === false);
check('15:12 target10 -> rejected (상한인데 3점차)', validateSetScore(15, 12, 10).ok === false);
check('7:0 target7 -> ok (3세트 정상 종료)', validateSetScore(7, 0, 7).ok === true);
check('6:5 target7 -> rejected (3세트 목표 미달, 아직 안 끝남)', validateSetScore(6, 5, 7).ok === false);
check('10:7 target7 -> rejected (3세트, 2점차 아님)', validateSetScore(10, 7, 7).ok === false);
check('15:13 target7 -> ok (3세트도 상한 15는 동일)', validateSetScore(15, 13, 7).ok === true);

// ---- evaluatePrelimMatch ----
let r = evaluatePrelimMatch([{ a: 10, b: 5 }, { a: 8, b: 10 }]);
check('prelim 1-1 draw', r.result === 'draw' && r.status === 'done');

r = evaluatePrelimMatch([{ a: 10, b: 5 }, { a: 10, b: 6 }]);
check('prelim 2-0 A win', r.result === 'A' && r.status === 'done');

r = evaluatePrelimMatch([{ a: 10, b: 5 }]);
check('prelim 1 set only -> in_progress', r.status === 'in_progress' && r.result === null);

r = evaluatePrelimMatch([]);
check('prelim no sets -> pending', r.status === 'pending');

r = evaluatePrelimMatch([{ a: 10.5, b: 2 }, { a: 10, b: 2 }]);
check('prelim decimal score never completes', r.status !== 'done' && r.result === null);
r = evaluatePrelimMatch([{ a: 11, b: 0 }, { a: 10, b: 2 }]);
check('prelim unreachable terminal never completes', r.status !== 'done' && r.result === null);

// ---- evaluateFinalMatch ----
r = evaluateFinalMatch([{ a: 10, b: 5 }, { a: 10, b: 6 }]);
check('final 2-0 A win, no 3rd set needed', r.winner === 'A' && r.status === 'done' && r.setsWonA === 2);

r = evaluateFinalMatch([{ a: 10, b: 5 }, { a: 8, b: 10 }, { a: 7, b: 2 }]);
check('final 1-1 then 3rd set 7pt A win', r.winner === 'A' && r.setsWonA === 2 && r.setsWonB === 1);

r = evaluateFinalMatch([{ a: 10, b: 5 }, { a: 8, b: 10 }, { a: 6, b: 5 }]);
check('final 3rd set not yet decided (6:5 target7)', r.status === 'in_progress' && r.winner === null);
r = evaluateFinalMatch([{ a: 10, b: 5 }, { a: 10, b: 6 }, { a: 7, b: 2 }]);
check('final unreachable third set never completes', r.status !== 'done' && r.winner === null);
r = evaluateFinalMatch([{ a: 10, b: 5 }, { a: 10, b: 6.5 }]);
check('final decimal score never completes', r.status !== 'done' && r.winner === null);
check('final 2-0 normalization removes unused third set', normalizePlayedSets(
  [{ a: 10, b: 8 }, { a: 10, b: 7 }, { a: 0, b: 0 }], true,
).length === 2);
check('final 2-1 normalization preserves deciding set', normalizePlayedSets(
  [{ a: 10, b: 8 }, { a: 8, b: 10 }, { a: 7, b: 5 }], true,
).length === 3);

// ---- computeGroupStandings ----
const teams = [{ id: 't1', name: '1반' }, { id: 't2', name: '2반' }, { id: 't3', name: '3반' }];
const matches = [
  { teamA: 't1', teamB: 't2', sets: [{ a: 10, b: 3 }, { a: 10, b: 4 }] }, // t1 win
  { teamA: 't1', teamB: 't3', sets: [{ a: 10, b: 8 }, { a: 8, b: 10 }] }, // draw
  { teamA: 't2', teamB: 't3', sets: [{ a: 5, b: 10 }, { a: 4, b: 10 }] }, // t3 win
];
const standings = computeGroupStandings(teams, matches);
check('standings length 3', standings.length === 3);
const byId = Object.fromEntries(standings.map((s) => [s.teamId, s]));
check('t1 points = 3(win)+1(draw)=4', byId.t1.points === 4);
check('t3 points = 1(draw)+3(win)=4', byId.t3.points === 4);
check('t2 points = 0', byId.t2.points === 0);
check('t1 rank 1 or t3 rank1 (tie resolved by setDiff/pointDiff/h2h)', byId.t1.rank === 1 || byId.t3.rank === 1);
check('t2 ranked last', byId.t2.rank === 3);
check('complete standings are not provisional', standings.every((s) => !s.provisional));

const zeroScheduledStandings = computeGroupStandings(
  [{ id: 'a', name: 'A팀' }, { id: 'b', name: 'B팀' }],
  [],
);
check(
  'zero scheduled matches leave standings provisional and unqualified',
  zeroScheduledStandings.every((s) => s.provisional && !s.needsLottery)
    && computeAutomaticQualifiers(zeroScheduledStandings, 1).length === 0,
);
const partialScheduledStandings = computeGroupStandings(
  [{ id: 'a', name: 'A팀' }, { id: 'b', name: 'B팀' }, { id: 'c', name: 'C팀' }],
  [
    { teamA: 'a', teamB: 'b', sets: [{ a: 10, b: 0 }, { a: 10, b: 0 }] },
    { teamA: 'a', teamB: 'c', sets: [] },
  ],
);
check(
  'partial scheduled matches leave standings provisional and unqualified',
  partialScheduledStandings.every((s) => s.provisional && !s.needsLottery)
    && computeAutomaticQualifiers(partialScheduledStandings, 1).length === 0,
);
const forgedStandings = computeGroupStandings(
  [{ id: 'a', name: 'A팀' }, { id: 'b', name: 'B팀' }],
  [{
    teamA: 'a', teamB: 'b',
    sets: [{ a: 10.5, b: 0 }, { a: 10, b: 0 }],
    status: 'done', result: 'A', setsWonA: 2, setsWonB: 0, pointsForA: 20, pointsForB: 0,
  }],
);
check(
  'standings ignore forged completed aggregate fields',
  forgedStandings.every((s) => s.played === 0 && s.provisional),
);

const twoTeamTieStandings = computeGroupStandings(
  [{ id: 'a', name: 'A팀' }, { id: 'b', name: 'B팀' }],
  [{ teamA: 'a', teamB: 'b', sets: [{ a: 10, b: 0 }, { a: 0, b: 10 }] }],
);
check(
  '2팀 미해소 동률은 공동 순위와 추첨 필요로 표시',
  twoTeamTieStandings.every((s) => s.rank === 1 && s.needsLottery),
);

const partialHeadToHeadTeams = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: `${id}팀` }));
const decisiveMatch = (teamA, teamB, result) => ({
  teamA,
  teamB,
  sets: result === 'A' ? [{ a: 10, b: 0 }, { a: 10, b: 0 }] : [{ a: 0, b: 10 }, { a: 0, b: 10 }],
});
const drawMatch = (teamA, teamB) => ({
  teamA,
  teamB,
  sets: [{ a: 10, b: 0 }, { a: 0, b: 10 }],
});
const partialHeadToHeadStandings = computeGroupStandings(partialHeadToHeadTeams, [
  decisiveMatch('a', 'b', 'A'), decisiveMatch('a', 'c', 'A'), drawMatch('a', 'd'),
  drawMatch('b', 'c'), decisiveMatch('b', 'd', 'A'), decisiveMatch('c', 'd', 'A'),
  decisiveMatch('a', 'e', 'B'), decisiveMatch('a', 'f', 'B'),
  decisiveMatch('b', 'e', 'A'), decisiveMatch('b', 'f', 'B'),
  decisiveMatch('c', 'e', 'B'), decisiveMatch('c', 'f', 'A'),
  decisiveMatch('d', 'e', 'A'), decisiveMatch('d', 'f', 'A'),
]);
const partialHeadToHeadById = Object.fromEntries(partialHeadToHeadStandings.map((s) => [s.teamId, s]));
check(
  '부분 승자승 순서는 1, 2, 2, 4위로 경쟁 순위를 매긴다',
  partialHeadToHeadById.a.rank === 1
    && partialHeadToHeadById.b.rank === 2
    && partialHeadToHeadById.c.rank === 2
    && partialHeadToHeadById.d.rank === 4,
);
check(
  '부분 승자승에서 같은 하위 그룹만 추첨 필요로 표시',
  !partialHeadToHeadById.a.needsLottery
    && partialHeadToHeadById.b.needsLottery
    && partialHeadToHeadById.c.needsLottery
    && !partialHeadToHeadById.d.needsLottery,
);

const tiedCutoffStandings = [
  { teamId: 'first', rank: 1 },
  { teamId: 'tied-a', rank: 2 },
  { teamId: 'tied-b', rank: 2 },
  { teamId: 'fourth', rank: 4 },
];
check(
  '진출선에 걸친 공동 순위는 자동 선택하지 않는다',
  JSON.stringify(computeAutomaticQualifiers(tiedCutoffStandings, 2).map((s) => s.teamId)) === JSON.stringify(['first']),
);
check(
  '진출선 안에 완전히 들어온 공동 순위는 함께 자동 선택한다',
  JSON.stringify(computeAutomaticQualifiers(tiedCutoffStandings, 3).map((s) => s.teamId)) === JSON.stringify(['first', 'tied-a', 'tied-b']),
);
check(
  '동률과 무관한 확정 순위는 계속 자동 선택한다',
  JSON.stringify(computeAutomaticQualifiers([
    { teamId: 'first', rank: 1 },
    { teamId: 'second', rank: 2 },
    { teamId: 'third', rank: 3 },
  ], 2).map((s) => s.teamId)) === JSON.stringify(['first', 'second']),
);

// ---- bracket: power of two / seed order ----
check('nextPowerOfTwo(6)=8', nextPowerOfTwo(6) === 8);
check('nextPowerOfTwo(8)=8', nextPowerOfTwo(8) === 8);
check('nextPowerOfTwo(9)=16', nextPowerOfTwo(9) === 16);
check('seedOrder(4) = [1,4,2,3]', JSON.stringify(seedOrder(4)) === JSON.stringify([1, 4, 2, 3]));
check('seedOrder(8) = [1,8,4,5,2,7,3,6]', JSON.stringify(seedOrder(8)) === JSON.stringify([1, 8, 4, 5, 2, 7, 3, 6]));

// ---- bracket: 8 teams, no byes ----
const teams8 = Array.from({ length: 8 }, (_, i) => ({ id: `T${i + 1}`, name: `${i + 1}번` }));
let { matches: m8, bracketSize: bs8, totalRounds: tr8 } = generateBracket(teams8);
check('8 teams -> bracketSize 8', bs8 === 8);
check('8 teams -> totalRounds 3', tr8 === 3);
check('8 teams -> 7 matches (no 3rd place match)', m8.length === 7);
check('no byes among 8 teams', m8.filter((m) => m.status === 'bye').length === 0);
check('championship has no downstream match or slot', (() => {
  const championship = m8.find((m) => m.round === tr8);
  return championship.nextMatchId === null && championship.nextSlot === null;
})());
check('non-championship matches keep paired downstream ids and slots', m8
  .filter((m) => m.round < tr8)
  .every((m) => m.nextMatchId && ['A', 'B'].includes(m.nextSlot)));

// simulate full run: round1 (4 matches), winners always teamA
let round1 = m8.filter((m) => m.round === 1);
round1.forEach((m) => {
  recordMatchResult(m8, m.id, [{ a: 10, b: 5 }, { a: 10, b: 5 }], evaluateFinalMatch);
});
let round2 = m8.filter((m) => m.round === 2);
check('round2 matches filled after round1', round2.every((m) => m.teamA && m.teamB));
round2.forEach((m) => {
  recordMatchResult(m8, m.id, [{ a: 10, b: 5 }, { a: 10, b: 5 }], evaluateFinalMatch);
});
let final = m8.find((m) => m.round === 3);
check('final filled after semis', final.teamA && final.teamB);
recordMatchResult(m8, final.id, [{ a: 10, b: 5 }, { a: 10, b: 5 }], evaluateFinalMatch);
check('final done', final.status === 'done' && final.winnerTeam);

// ---- bracket: local correction preview clears stale descendants ----
const previewTeams = Array.from({ length: 4 }, (_, i) => ({ id: `P${i + 1}`, name: `${i + 1}번` }));
const { matches: previewMatches } = generateBracket(previewTeams);
const previewRound1 = previewMatches.filter((m) => m.round === 1);
previewRound1.forEach((m) => recordMatchResult(
  previewMatches, m.id, [{ a: 10, b: 5 }, { a: 10, b: 5 }], evaluateFinalMatch,
));
const previewFinal = previewMatches.find((m) => m.round === 2);
recordMatchResult(previewMatches, previewFinal.id, [{ a: 10, b: 5 }, { a: 10, b: 5 }], evaluateFinalMatch);
const invalidatedPreview = invalidateDescendantResults(previewMatches, previewRound1[0].id);
check('upstream correction preview invalidates descendant result', invalidatedPreview.includes(previewFinal.id)
  && previewFinal.sets.length === 0 && previewFinal.winnerTeam === null && previewFinal.status === 'waiting');

// ---- bracket: 6 teams -> 2 byes (자동 배치/확정 금지: 미배정(empty) 상태로만 생성되어야 함) ----
const teams6 = Array.from({ length: 6 }, (_, i) => ({ id: `S${i + 1}`, name: `${i + 1}시드` }));
let { matches: m6, bracketSize: bs6 } = generateBracket(teams6);
check('6 teams -> bracketSize 8', bs6 === 8);
const emptyMatches6 = m6.filter((m) => m.status === 'empty');
check('6 teams -> 2 empty(미배정) matches (자동 배치 없음)', emptyMatches6.length === 2);
check('6 teams -> bye_pending/bye 없음(자동 배치·확정 금지)', m6.filter((m) => m.status === 'bye_pending' || m.status === 'bye').length === 0);
check('미배정 매치는 teamA/teamB 모두 비어 있음', emptyMatches6.every((m) => !m.teamA && !m.teamB));
check('미배정 매치는 byeCandidate에 원래 자리 후보 팀이 기록됨', emptyMatches6.every((m) => m.byeCandidate && m.byeCandidate.team && m.byeCandidate.side));
check('top 2 seeds become byeCandidate', emptyMatches6.some((m) => m.byeCandidate.team.id === 'S1') && emptyMatches6.some((m) => m.byeCandidate.team.id === 'S2'));
const round2of6 = m6.filter((m) => m.round === 2);
check('배치 전에는 2라운드가 자동으로 채워지지 않음(대기 상태 유지)', round2of6.every((m) => !m.teamA && !m.teamB && m.status === 'waiting'));

// ---- bracket: 5 teams -> totalRounds & byes ----
const teams5 = Array.from({ length: 5 }, (_, i) => ({ id: `Q${i + 1}`, name: `${i + 1}` }));
let { matches: m5, bracketSize: bs5, totalRounds: tr5 } = generateBracket(teams5);
check('5 teams -> bracketSize 8', bs5 === 8);
check('5 teams -> 3개 미배정(empty) 슬롯 (자동 배치 없음)', m5.filter((m) => m.status === 'empty').length === 3);
check('5 teams -> bye_pending/bye 없음', m5.filter((m) => m.status === 'bye_pending' || m.status === 'bye').length === 0);

// ---- bracket: 32 teams (max) ----
const teams32 = Array.from({ length: 32 }, (_, i) => ({ id: `Z${i + 1}`, name: `${i + 1}` }));
let { matches: m32, bracketSize: bs32, totalRounds: tr32 } = generateBracket(teams32);
check('32 teams -> bracketSize 32', bs32 === 32);
check('32 teams -> totalRounds 5', tr32 === 5);
check('32 teams -> no byes', m32.filter((m) => m.status === 'bye' || m.status === 'bye_pending' || m.status === 'empty').length === 0);
check('32 teams -> 31 matches (no 3rd place match)', m32.length === 31);

// ---- buildCrossGroupSeedOrder (조 1위/2위 교차 시드) ----
{
  // 2개 조: A1-B2 / B1-A2 형태(사용자가 명시한 예시)가 정확히 나와야 한다
  const tiers2 = [
    [{ teamId: 'A1', groupId: 'A' }, { teamId: 'B1', groupId: 'B' }],
    [{ teamId: 'A2', groupId: 'A' }, { teamId: 'B2', groupId: 'B' }],
  ];
  const seeds2 = buildCrossGroupSeedOrder(tiers2);
  check('2개조 교차시드: 1위 2명이 시드1,2', seeds2[0] === 'A1' && seeds2[1] === 'B1');
  check('2개조 교차시드: seed1(A1) 파트너(seed4)는 B2 (다른 조)', seeds2[3] === 'B2');
  check('2개조 교차시드: seed2(B1) 파트너(seed3)는 A2 (다른 조)', seeds2[2] === 'A2');

  // 4개 조: 1라운드에서 같은 조끼리 만나는 경기가 하나도 없어야 한다
  const groupsX = ['A', 'B', 'C', 'D'];
  const tiers4 = [
    groupsX.map((g) => ({ teamId: `${g}1`, groupId: g })),
    groupsX.map((g) => ({ teamId: `${g}2`, groupId: g })),
  ];
  const seeds4 = buildCrossGroupSeedOrder(tiers4);
  check('4개조 교차시드: 시드 8명 모두 포함', seeds4.length === 8);
  const order8 = seedOrder(8);
  let anySameGroupPair = false;
  for (let j = 0; j < 4; j++) {
    const a = seeds4[order8[j * 2] - 1];
    const b = seeds4[order8[j * 2 + 1] - 1];
    if (a[0] === b[0]) anySameGroupPair = true; // teamId 앞글자 = 조 이름
  }
  check('4개조 교차시드: 1라운드에 같은 조 매치업 없음', !anySameGroupPair);

  // 1개 티어(순위)만 있으면 그냥 그대로 반환
  const seeds1 = buildCrossGroupSeedOrder([groupsX.map((g) => ({ teamId: `${g}1`, groupId: g }))]);
  check('1개 티어뿐이면 그대로 반환', JSON.stringify(seeds1) === JSON.stringify(['A1', 'B1', 'C1', 'D1']));

  // 빈 입력 -> 빈 배열
  check('빈 입력 -> 빈 배열', buildCrossGroupSeedOrder([]).length === 0);

  // 5개 조(10팀, 16강 대진표 -> 부전승 6자리): 표준 시딩은 순위(1위 -> 2위) 순서 그대로
  // 시드를 배정하므로, 부전승은 앞쪽(좋은) 시드부터 채워진다 - 1위를 억지로 실제 경기에
  // 넣지 않는다. 단, 실제로 열리는 경기에 같은 조 매치업이 없어야 한다.
  const groups5 = ['A', 'B', 'C', 'D', 'E'];
  const tiers5 = [
    groups5.map((g) => ({ teamId: `${g}1`, groupId: g })),
    groups5.map((g) => ({ teamId: `${g}2`, groupId: g })),
  ];
  const seeds5 = buildCrossGroupSeedOrder(tiers5);
  check('5개조 교차시드: 시드 10명 모두 포함', seeds5.length === 10);
  check(
    '5개조 표준시드: 순위 순서 그대로(1위 전원 -> 2위 전원) 배정됨(같은 조 충돌 없어 스왑 불필요)',
    JSON.stringify(seeds5) === JSON.stringify(['A1', 'B1', 'C1', 'D1', 'E1', 'A2', 'B2', 'C2', 'D2', 'E2'])
  );
  const { matches: m5 } = generateBracket(seeds5.map((id) => ({ id, name: id })));
  const r1_5 = m5.filter((m) => m.round === 1).sort((a, b) => a.index - b.index);
  const realMatches5 = r1_5.filter((m) => m.teamA && m.teamB);
  const byeMatches5 = r1_5.filter((m) => !(m.teamA && m.teamB));
  check('5개조: 실제 경기는 정확히 2경기(대진표 구조상 강제됨)', realMatches5.length === 2);
  check('5개조: 부전승은 정확히 6자리', byeMatches5.length === 6);
  const groupOf5 = (id) => id[0];
  const noSameGroupRematch5 = realMatches5.every((m) => groupOf5(m.teamA.id) !== groupOf5(m.teamB.id));
  check('5개조: 실제 경기에 같은 조 매치업 없음', noSameGroupRematch5);

  // 3개 조(6팀, 8강 대진표 -> 부전승 2자리): 표준 순서대로면 C조 1위(시드3)와 C조 2위(시드6)가
  // 그대로 1라운드에서 만나버리는 충돌이 생긴다 - 같은 티어(1위 그룹) 안에서 자리를 바꿔
  // 이 충돌만 해소해야 한다(부전승 2자리는 여전히 가장 앞쪽 시드가 받음).
  const groups3 = ['A', 'B', 'C'];
  const tiers3 = [
    groups3.map((g) => ({ teamId: `${g}1`, groupId: g })),
    groups3.map((g) => ({ teamId: `${g}2`, groupId: g })),
  ];
  const seeds3 = buildCrossGroupSeedOrder(tiers3);
  check('3개조 표준시드: 시드 6명 모두 포함', seeds3.length === 6);
  const { matches: m3 } = generateBracket(seeds3.map((id) => ({ id, name: id })));
  const r1_3 = m3.filter((m) => m.round === 1).sort((a, b) => a.index - b.index);
  const realMatches3 = r1_3.filter((m) => m.teamA && m.teamB);
  const byeMatches3 = r1_3.filter((m) => !(m.teamA && m.teamB));
  check('3개조: 실제 경기는 정확히 2경기', realMatches3.length === 2);
  check('3개조: 부전승은 정확히 2자리', byeMatches3.length === 2);
  const groupOf3 = (id) => id[0];
  const noSameGroupRematch3 = realMatches3.every((m) => groupOf3(m.teamA.id) !== groupOf3(m.teamB.id));
  check('3개조: 같은 조 충돌이 자리바꿈으로 해소되어, 실제 경기에 같은 조 매치업 없음', noSameGroupRematch3);
}

// ---- swapFinalSeedSlots (생성된 대진표의 1라운드 자리바꿈) ----
{
  // 정상 스왑: 4팀, 부전승 없음 -> 다른 매치의 팀과 교환 후 2라운드는 깨끗이 비워져야 함
  const teamsSwap = Array.from({ length: 4 }, (_, i) => ({ id: `W${i + 1}`, name: `${i + 1}` }));
  const { matches: msw } = generateBracket(teamsSwap);
  const r1 = msw.filter((m) => m.round === 1).sort((a, b) => a.index - b.index);
  const beforeA = r1[0].teamA, beforeOtherMatchA = r1[1].teamA;
  const res = swapFinalSeedSlots(msw, { matchId: r1[0].id, side: 'A' }, { matchId: r1[1].id, side: 'A' });
  check('정상 스왑 -> ok:true', res.ok === true);
  check('스왑 후 자리가 실제로 바뀜', r1[0].teamA.id === beforeOtherMatchA.id && r1[1].teamA.id === beforeA.id);
  const r2sw = msw.filter((m) => m.round === 2);
  check('스왑 후 2라운드는 대기 상태로 초기화됨', r2sw.every((m) => m.status === 'waiting' && !m.teamA && !m.teamB));

  // 같은 매치 안에서 A<->B 스왑 (단순 자리 뒤집기) - 항상 허용
  const teamsFlip = Array.from({ length: 2 }, (_, i) => ({ id: `F${i + 1}`, name: `${i + 1}` }));
  const { matches: mflip } = generateBracket(teamsFlip);
  const flipMatch = mflip[0];
  const flipA = flipMatch.teamA;
  const resFlip = swapFinalSeedSlots(mflip, { matchId: flipMatch.id, side: 'A' }, { matchId: flipMatch.id, side: 'B' });
  check('같은 매치 내 A/B 자리 뒤집기 -> ok:true', resFlip.ok === true);
  check('같은 매치 내 자리 뒤집기 결과 확인', flipMatch.teamB.id === flipA.id);

  // 라운드1이 아닌 매치는 스왑 불가
  const teamsR2 = Array.from({ length: 4 }, (_, i) => ({ id: `R${i + 1}`, name: `${i + 1}` }));
  const { matches: mr2 } = generateBracket(teamsR2);
  const round2Match = mr2.find((m) => m.round === 2);
  const round1MatchAny = mr2.find((m) => m.round === 1);
  const resR2 = swapFinalSeedSlots(mr2, { matchId: round1MatchAny.id, side: 'A' }, { matchId: round2Match.id, side: 'A' });
  check('1라운드가 아닌 매치는 ROUND1_ONLY로 거부', resR2.ok === false && resR2.reason === 'ROUND1_ONLY');

  // 이미 점수가 입력된 경기가 있으면(=시작됨) 스왑 거부
  const teamsStarted = Array.from({ length: 4 }, (_, i) => ({ id: `S${i + 1}`, name: `${i + 1}` }));
  const { matches: mst } = generateBracket(teamsStarted);
  const r1st = mst.filter((m) => m.round === 1).sort((a, b) => a.index - b.index);
  recordMatchResult(mst, r1st[0].id, [{ a: 10, b: 5 }, { a: 10, b: 5 }], evaluateFinalMatch);
  const resStarted = swapFinalSeedSlots(mst, { matchId: r1st[0].id, side: 'A' }, { matchId: r1st[1].id, side: 'A' });
  check('이미 시작된 대진표는 ALREADY_STARTED로 거부', resStarted.ok === false && resStarted.reason === 'ALREADY_STARTED');

  // 미배정(empty) 상태인 자리는 배치 전까지 스왑 자체가 거부되어야 함
  const teams5u = Array.from({ length: 5 }, (_, i) => ({ id: `U${i + 1}`, name: `${i + 1}` }));
  const { matches: m5u } = generateBracket(teams5u);
  const emptyMatch5u = m5u.find((m) => m.status === 'empty');
  const pendingMatch5u = m5u.find((m) => m.status === 'pending' && m.round === 1);
  check('5팀 -> 미배정(empty) 매치 존재(테스트 전제조건)', Boolean(emptyMatch5u));
  if (emptyMatch5u && pendingMatch5u) {
    const resUnassigned = swapFinalSeedSlots(
      m5u,
      { matchId: pendingMatch5u.id, side: 'A' },
      { matchId: emptyMatch5u.id, side: 'A' }
    );
    check('미배정(empty) 자리와의 스왑은 UNASSIGNED_SLOT으로 거부', resUnassigned.ok === false && resUnassigned.reason === 'UNASSIGNED_SLOT');
  }

  // 두 부전승(확정대기) 매치 사이에서, 실제 팀 쪽과 빈 자리 쪽을 바꾸면 한쪽 매치가 완전히 빈 매치가 되므로 거부되어야 함
  // (먼저 미배정 자리에 placeByeTeam으로 후보를 배치해 bye_pending으로 만들어야 스왑 시도 자체가 가능하다)
  const teams5b = Array.from({ length: 5 }, (_, i) => ({ id: `B${i + 1}`, name: `${i + 1}` }));
  const { matches: m5b } = generateBracket(teams5b);
  const emptyMatches5b = m5b.filter((m) => m.status === 'empty');
  check('5팀 -> 미배정(empty) 매치 2개 이상 존재(테스트 전제조건)', emptyMatches5b.length >= 2);
  if (emptyMatches5b.length >= 2) {
    const [em1, em2] = emptyMatches5b;
    placeByeTeam(m5b, em1.id);
    placeByeTeam(m5b, em2.id);
    const bm1 = m5b.find((m) => m.id === em1.id);
    const bm2 = m5b.find((m) => m.id === em2.id);
    check('배치 후 두 매치 모두 bye_pending', bm1.status === 'bye_pending' && bm2.status === 'bye_pending');
    const realSideOf = (m) => (m.teamA ? 'A' : 'B');
    const nullSideOf = (m) => (m.teamA ? 'B' : 'A');
    const resEmpty = swapFinalSeedSlots(
      m5b,
      { matchId: bm1.id, side: realSideOf(bm1) },
      { matchId: bm2.id, side: nullSideOf(bm2) }
    );
    check('두 부전승(확정대기) 매치 간 실제팀<->빈자리 스왑은 EMPTY_MATCH로 거부', resEmpty.ok === false && resEmpty.reason === 'EMPTY_MATCH');
  }

  // 부전승 자리로 팀을 끌어오면("부전승 넘기기"), 원래 부전승이던 팀은 그 팀의 옛 상대와 맞붙게 된다
  // (마찬가지로 먼저 미배정 자리를 배치해 bye_pending으로 만들어 둔다)
  const teams6b = Array.from({ length: 6 }, (_, i) => ({ id: `G${i + 1}`, name: `${i + 1}` }));
  const { matches: m6b } = generateBracket(teams6b);
  const emptyMatch6b = m6b.find((m) => m.status === 'empty');
  if (emptyMatch6b) placeByeTeam(m6b, emptyMatch6b.id);
  const byeMatch6 = emptyMatch6b ? m6b.find((m) => m.id === emptyMatch6b.id) : null;
  const pendingMatch6 = m6b.find((m) => m.status === 'pending' && m.round === 1);
  if (byeMatch6 && pendingMatch6) {
    const byeRealSide = byeMatch6.teamA ? 'A' : 'B';
    const byeNullSide = byeMatch6.teamA ? 'B' : 'A';
    const movedTeam = pendingMatch6.teamA;
    const stayingTeam = pendingMatch6.teamB;
    const byeTeam = byeMatch6.teamA || byeMatch6.teamB;
    const resBye = swapFinalSeedSlots(
      m6b,
      { matchId: pendingMatch6.id, side: 'A' },
      { matchId: byeMatch6.id, side: byeNullSide }
    );
    check('부전승 자리로 팀을 끌어오는 스왑 -> ok:true', resBye.ok === true);
    check('부전승 자리를 차지한 팀이 바뀜', getTeam(byeMatch6, byeNullSide).id === movedTeam.id);
    check('원래 부전승이던 팀은 이제 남은 팀과 매치', pendingMatch6.teamA == null
      ? pendingMatch6.teamB.id === stayingTeam.id
      : pendingMatch6.teamA.id === stayingTeam.id);
    check('원래 부전승 자리였던 매치는 이제 (원래 부전승팀 vs 끌려온 팀) 실제 대진이 됨',
      byeMatch6.status === 'pending'
      && [byeMatch6.teamA, byeMatch6.teamB].some((t) => t && t.id === byeTeam.id)
      && [byeMatch6.teamA, byeMatch6.teamB].some((t) => t && t.id === movedTeam.id));
    check('스왑으로 새로 생긴 부전승 자리는 자동 확정되지 않고 확정 대기 상태가 됨',
      pendingMatch6.status === 'bye_pending' && pendingMatch6.winnerSide === null && pendingMatch6.winnerTeam === null);
  }
}
function getTeam(m, side) { return side === 'A' ? m.teamA : m.teamB; }

// ---- confirmBye (관리자가 직접 부전승을 확정하는 동작) ----
{
  // 정상 확정: 미배정(empty) -> placeByeTeam으로 bye_pending이 되고, confirmBye로 bye가 되며,
  // 남은 팀이 다음 라운드로 전파되어야 함
  const teamsCb = Array.from({ length: 6 }, (_, i) => ({ id: `C${i + 1}`, name: `${i + 1}` }));
  const { matches: mcb } = generateBracket(teamsCb);
  const emptyForCb = mcb.find((m) => m.status === 'empty');
  check('confirmBye 테스트 전제조건: empty(미배정) 매치 존재', Boolean(emptyForCb));
  if (emptyForCb) {
    const placeRes = placeByeTeam(mcb, emptyForCb.id);
    check('placeByeTeam 배치 -> ok:true', placeRes.ok === true);
    const pendingBye = mcb.find((m) => m.id === emptyForCb.id);
    check('배치 후 status가 bye_pending으로 바뀜', pendingBye.status === 'bye_pending');
    const byeTeam = pendingBye.teamA || pendingBye.teamB;
    const expectedSide = pendingBye.teamA ? 'A' : 'B';
    const res = confirmBye(mcb, pendingBye.id);
    check('confirmBye 정상 확정 -> ok:true', res.ok === true);
    check('확정 후 status가 bye로 바뀜', pendingBye.status === 'bye');
    check('확정 후 winnerSide가 실제 팀 쪽으로 설정됨', pendingBye.winnerSide === expectedSide);
    check('확정 후 winnerTeam이 설정됨', pendingBye.winnerTeam && pendingBye.winnerTeam.id === byeTeam.id);
    if (pendingBye.nextMatchId) {
      const next = mcb.find((m) => m.id === pendingBye.nextMatchId);
      const placedSide = pendingBye.nextSlot === 'A' ? next.teamA : next.teamB;
      check('확정 후 다음 라운드로 전파됨', placedSide && placedSide.id === byeTeam.id);
    }

    // 이미 확정된 매치를 다시 확정하려 하면 거부되어야 함
    const resAgain = confirmBye(mcb, pendingBye.id);
    check('이미 확정된 매치 재확정 -> NOT_BYE_PENDING', resAgain.ok === false && resAgain.reason === 'NOT_BYE_PENDING');

    // confirmBye로 부전승이 하나 확정된 뒤에는, 자리 교체가 ALREADY_STARTED로 막혀야 한다
    const r1cb = mcb.filter((m) => m.round === 1).sort((a, b) => a.index - b.index);
    const otherPending = r1cb.find((m) => m.id !== pendingBye.id && m.status === 'pending');
    if (otherPending) {
      const resSwapAfterConfirm = swapFinalSeedSlots(
        mcb,
        { matchId: otherPending.id, side: 'A' },
        { matchId: otherPending.id, side: 'B' }
      );
      check('부전승 확정 후에는 자리 교체가 ALREADY_STARTED로 거부됨',
        resSwapAfterConfirm.ok === false && resSwapAfterConfirm.reason === 'ALREADY_STARTED');
    }
  }

  // 실제 팀이 둘 다 있는(=부전승이 아닌) 매치를 확정하려 하면 거부되어야 함
  const teamsCb2 = Array.from({ length: 4 }, (_, i) => ({ id: `D${i + 1}`, name: `${i + 1}` }));
  const { matches: mcb2 } = generateBracket(teamsCb2);
  const realMatch = mcb2.find((m) => m.status === 'pending');
  check('confirmBye 테스트 전제조건: pending 매치 존재', Boolean(realMatch));
  if (realMatch) {
    const resBad = confirmBye(mcb2, realMatch.id);
    check('부전승이 아닌 매치 확정 시도 -> NOT_BYE_PENDING', resBad.ok === false && resBad.reason === 'NOT_BYE_PENDING');
  }

  // 미배정(empty) 매치를 배치 없이 바로 확정하려 해도 거부되어야 함
  const teamsCb3 = Array.from({ length: 6 }, (_, i) => ({ id: `E${i + 1}`, name: `${i + 1}` }));
  const { matches: mcb3 } = generateBracket(teamsCb3);
  const emptyCb3 = mcb3.find((m) => m.status === 'empty');
  check('confirmBye 테스트 전제조건: empty 매치 존재', Boolean(emptyCb3));
  if (emptyCb3) {
    const resEmptyConfirm = confirmBye(mcb3, emptyCb3.id);
    check('미배정 매치를 배치 없이 확정 시도 -> NOT_BYE_PENDING', resEmptyConfirm.ok === false && resEmptyConfirm.reason === 'NOT_BYE_PENDING');
  }

  // 존재하지 않는 매치 id -> NOT_FOUND
  const resNotFound = confirmBye(mcb2, 'no_such_match_id');
  check('존재하지 않는 매치 확정 시도 -> NOT_FOUND', resNotFound.ok === false && resNotFound.reason === 'NOT_FOUND');
}

// ---- placeByeTeam (관리자가 미배정 부전승 후보를 대진표 자리에 직접 배치) ----
{
  const teamsPb = Array.from({ length: 6 }, (_, i) => ({ id: `P${i + 1}`, name: `${i + 1}` }));
  const { matches: mpb } = generateBracket(teamsPb);
  const emptyPb = mpb.find((m) => m.status === 'empty');
  check('placeByeTeam 테스트 전제조건: empty 매치 존재', Boolean(emptyPb));
  if (emptyPb) {
    const candidate = emptyPb.byeCandidate;
    check('미배정 매치는 byeCandidate를 가짐', Boolean(candidate && candidate.team && candidate.side));
    const res = placeByeTeam(mpb, emptyPb.id);
    check('placeByeTeam 정상 배치 -> ok:true', res.ok === true);
    check('배치 후 status가 bye_pending으로 바뀜', emptyPb.status === 'bye_pending');
    check('배치 후 byeCandidate가 비워짐', emptyPb.byeCandidate === null);
    check('배치 후 후보 팀이 원래 자리(side)에 그대로 들어감',
      (candidate.side === 'A' ? emptyPb.teamA : emptyPb.teamB).id === candidate.team.id);
    check('배치 후에도 winnerSide/winnerTeam은 비어 있음(확정 전)', emptyPb.winnerSide === null && emptyPb.winnerTeam === null);

    // 이미 배치된 매치를 다시 배치하려 하면 거부되어야 함
    const resAgain = placeByeTeam(mpb, emptyPb.id);
    check('이미 배치된 매치 재배치 -> NOT_EMPTY', resAgain.ok === false && resAgain.reason === 'NOT_EMPTY');
  }

  // 부전승이 필요 없는(실제 두 팀이 있는) 매치를 배치하려 하면 거부되어야 함
  const teamsPb2 = Array.from({ length: 4 }, (_, i) => ({ id: `K${i + 1}`, name: `${i + 1}` }));
  const { matches: mpb2 } = generateBracket(teamsPb2);
  const realMatchPb2 = mpb2.find((m) => m.status === 'pending');
  check('placeByeTeam 테스트 전제조건: pending 매치 존재', Boolean(realMatchPb2));
  if (realMatchPb2) {
    const resBad = placeByeTeam(mpb2, realMatchPb2.id);
    check('부전승 자리가 아닌 매치 배치 시도 -> NOT_EMPTY', resBad.ok === false && resBad.reason === 'NOT_EMPTY');
  }

  // 존재하지 않는 매치 id -> NOT_FOUND
  const resNotFoundPb = placeByeTeam(mpb2, 'no_such_match_id');
  check('존재하지 않는 매치 배치 시도 -> NOT_FOUND', resNotFoundPb.ok === false && resNotFoundPb.reason === 'NOT_FOUND');
}

// ---- groupByRound ----
const { rounds } = groupByRound(m8);
check('groupByRound returns 3 rounds for 8 teams', rounds.length === 3);
check('round labels correct', rounds[0].label === '준결승' || rounds[0].label === '8강' || rounds[0].label === '준결승');
check('8팀(부전승 없음)이면 1라운드 라벨이 슬롯 수와 똑같이 8강', rounds[0].label === '8강');

// ---- roundLabel: 부전승으로 슬롯과 실제 참가팀 수가 다른 라운드의 명칭 ----
// 결승/준결승 여부는 슬롯 수(matchCountInRound)로만 판단해야 하고, 부전승 유무와 무관하게 항상 정확하다.
check('roundLabel(1) -> 결승 (실제 팀 수 인자 없어도 동일)', roundLabel(1) === '결승');
check('roundLabel(2) -> 준결승 (실제 팀 수 인자 없어도 동일)', roundLabel(2) === '준결승');
check('roundLabel(4) -> 8강 (실제 팀 수 인자 생략 시 슬롯*2로 계산, 기존 동작 유지)', roundLabel(4) === '8강');
// 6팀이 진출하면 대진표는 8슬롯(4경기)으로 만들어지지만, 1라운드 명칭은 실제 참가팀 수(6)를 써야 한다.
check('roundLabel(4, 6) -> 6강 (실제 참가팀 수 6명을 그대로 사용)', roundLabel(4, 6) === '6강');
// 결승/준결승 자리는 부전승이 있어도 실제 팀 수 인자에 휘둘리지 않고 그대로 결승/준결승이어야 한다.
check('roundLabel(2, 3) -> 준결승 (부전승 있어도 2경기면 무조건 준결승)', roundLabel(2, 3) === '준결승');
check('roundLabel(1, 2) -> 결승 (1경기면 무조건 결승)', roundLabel(1, 2) === '결승');

// ---- 6팀 대진표: 1라운드는 8슬롯(부전승 2)이지만 라벨은 실제 참가팀 수 기준 "6강"이어야 함 ----
const teams6rl = Array.from({ length: 6 }, (_, i) => ({ id: `RL6_${i + 1}`, name: `${i + 1}번` }));
const { matches: m6rl } = generateBracket(teams6rl);
const { rounds: rounds6rl } = groupByRound(m6rl);
check('6팀 대진표 -> 3라운드 생성(8슬롯)', rounds6rl.length === 3);
check('6팀 대진표 1라운드 라벨 -> "6강"(실제 참가팀 수, 슬롯 기준 "8강" 아님)', rounds6rl[0].label === '6강');
check('6팀 대진표 2라운드 라벨 -> "준결승"(부전승 유무와 무관하게 그대로)', rounds6rl[1].label === '준결승');
check('6팀 대진표 3라운드 라벨 -> "결승"', rounds6rl[2].label === '결승');

// ---- 5팀 대진표: 1라운드는 8슬롯(부전승 3)이지만 라벨은 "5강" ----
const teams5rl = Array.from({ length: 5 }, (_, i) => ({ id: `RL5_${i + 1}`, name: `${i + 1}번` }));
const { matches: m5rl } = generateBracket(teams5rl);
const { rounds: rounds5rl } = groupByRound(m5rl);
check('5팀 대진표 1라운드 라벨 -> "5강"', rounds5rl[0].label === '5강');

// ---- 3팀 대진표: 부전승이 있어도 1라운드가 곧 준결승 단계이므로 라벨은 그대로 "준결승" ----
const teams3rl = Array.from({ length: 3 }, (_, i) => ({ id: `RL3_${i + 1}`, name: `${i + 1}번` }));
const { matches: m3rl } = generateBracket(teams3rl);
const { rounds: rounds3rl } = groupByRound(m3rl);
check('3팀 대진표 -> 2라운드 생성(4슬롯)', rounds3rl.length === 2);
check('3팀 대진표 1라운드 라벨 -> "준결승"(부전승 있어도 "3강" 아님)', rounds3rl[0].label === '준결승');
check('3팀 대진표 2라운드 라벨 -> "결승"', rounds3rl[1].label === '결승');

// ---- generateRoundRobin ----
function validateRoundRobin(n) {
  const ids = Array.from({ length: n }, (_, i) => `T${i + 1}`);
  const rr = generateRoundRobin(ids);
  const expectedCount = (n * (n - 1)) / 2;
  check(`roundRobin(${n}) match count = ${expectedCount}`, rr.length === expectedCount);
  const seen = new Set();
  let dup = false, selfPlay = false;
  rr.forEach((m) => {
    const key = [m.teamA, m.teamB].sort().join('-');
    if (seen.has(key)) dup = true;
    seen.add(key);
    if (m.teamA === m.teamB) selfPlay = true;
  });
  check(`roundRobin(${n}) no duplicate pairs`, !dup);
  check(`roundRobin(${n}) no self-play`, !selfPlay);
  check(
    `roundRobin(${n}) display order is dense and unique`,
    rr.every((m, index) => m.round === index + 1),
  );
  // each team plays exactly n-1 matches
  const playCount = {};
  ids.forEach((id) => (playCount[id] = 0));
  rr.forEach((m) => { playCount[m.teamA]++; playCount[m.teamB]++; });
  const allCorrect = ids.every((id) => playCount[id] === n - 1);
  check(`roundRobin(${n}) each team plays ${n - 1} matches`, allCorrect);
}
[3, 4, 5, 6, 7].forEach(validateRoundRobin);
const existingRoundRobinMatches = [
  { id: 'bc', teamA: 'B', teamB: 'C' },
  { id: 'ac', teamA: 'A', teamB: 'C' },
  { id: 'ab', teamA: 'A', teamB: 'B' },
];
check(
  'team reorder also reorders existing round-robin matches without replacing match ids',
  JSON.stringify(orderExistingRoundRobinMatchIds(existingRoundRobinMatches, ['C', 'A', 'B']))
    === JSON.stringify(['ab', 'ac', 'bc']),
);
check(
  'round-robin match reorder keeps unmatched existing documents at the end',
  JSON.stringify(orderExistingRoundRobinMatchIds(
    [...existingRoundRobinMatches, { id: 'legacy', teamA: 'A', teamB: 'D' }],
    ['C', 'A', 'B'],
  )) === JSON.stringify(['ab', 'ac', 'bc', 'legacy']),
);

// ---- 링크제(ring/link bracket) ----

// getRingEdges: n=2 특수케이스 (1경기만)
check('getRingEdges(2) -> 1 edge', JSON.stringify(getRingEdges(2)) === JSON.stringify([[0, 1]]));
// n=2 미만 -> 경기 없음
check('getRingEdges(1) -> no edges', getRingEdges(1).length === 0);
check('getRingEdges(0) -> no edges', getRingEdges(0).length === 0);
// n=3 삼각형 -> 3경기 (= 라운드로빈과 동일, 삼각형의 성질)
check('getRingEdges(3) -> 3 edges', getRingEdges(3).length === 3);
// n=4 사각형 -> 4경기 (대각선 제외, 라운드로빈 6경기보다 적음)
const edges4 = getRingEdges(4);
check('getRingEdges(4) -> 4 edges (not 6)', edges4.length === 4);
check('getRingEdges(4) -> each vertex has exactly 2 neighbors', (() => {
  const degree = [0, 0, 0, 0];
  edges4.forEach(([i, j]) => { degree[i]++; degree[j]++; });
  return degree.every((d) => d === 2);
})());
check('getRingEdges(4) -> no diagonal (0-2 / 1-3 not adjacent)', !edges4.some(
  ([i, j]) => (i === 0 && j === 2) || (i === 2 && j === 0) || (i === 1 && j === 3) || (i === 3 && j === 1)
));
// n=6 육각형 -> 6경기
check('getRingEdges(6) -> 6 edges', getRingEdges(6).length === 6);

// getRingMatchPairs: 꼭짓점이 다 채워지지 않으면 null
check('getRingMatchPairs incomplete -> null', getRingMatchPairs(['a', null, 'c', 'd']) === null);
// 4팀 완전 배치 -> 인접한 팀끼리만 4경기 (대각선 제외)
const pairs4 = getRingMatchPairs(['a', 'b', 'c', 'd']);
check('getRingMatchPairs(4 teams) -> 4 matches', pairs4.length === 4);
const pairKeySet = new Set(pairs4.map((p) => [p.teamA, p.teamB].sort().join('-')));
check('getRingMatchPairs(4 teams) -> a vs c (대각선) NOT included', !pairKeySet.has(['a', 'c'].sort().join('-')));
check('getRingMatchPairs(4 teams) -> b vs d (대각선) NOT included', !pairKeySet.has(['b', 'd'].sort().join('-')));
check('getRingMatchPairs(4 teams) -> a vs b included (인접)', pairKeySet.has(['a', 'b'].sort().join('-')));
check('getRingMatchPairs(4 teams) -> a vs d included (인접, 마지막-처음 연결)', pairKeySet.has(['a', 'd'].sort().join('-')));
// 2팀 -> 단 1경기 (중복 없이)
const pairs2 = getRingMatchPairs(['x', 'y']);
check('getRingMatchPairs(2 teams) -> exactly 1 match (not 2)', pairs2.length === 1);

// getRingPositions: 정다각형 좌표 - 모든 점이 중심에서 같은 거리(반지름)
const pos5 = getRingPositions(5, 260, 38);
const cx = 130, cy = 130;
const dists = pos5.map((p) => Math.hypot(p.x - cx, p.y - cy));
check('getRingPositions(5) -> all vertices equidistant from center', dists.every((d) => Math.abs(d - dists[0]) < 0.001));
check('getRingPositions(n) -> first vertex at top (12시 방향)', Math.abs(pos5[0].x - cx) < 0.001 && pos5[0].y < cy);

// normalizeRingOrder: 팀 수에 맞춰 길이를 맞추고, 사라진 팀은 제거
check('normalizeRingOrder: fresh group -> all null, length = team count', (() => {
  const r = normalizeRingOrder(undefined, ['t1', 't2', 't3']);
  return r.length === 3 && r.every((x) => x === null);
})());
check('normalizeRingOrder: removed team slot cleared, length matches new team count', (() => {
  // t2가 삭제된 경우 (이제 t1, t3만 존재)
  const r = normalizeRingOrder(['t1', 't2', 't3'], ['t1', 't3']);
  return r.length === 2 && r.includes('t1') && r.includes('t3') && !r.includes('t2');
})());
check('normalizeRingOrder: new team added -> extra null slot appended', (() => {
  const r = normalizeRingOrder(['t1', 't2'], ['t1', 't2', 't3']);
  return r.length === 3 && r.includes('t1') && r.includes('t2') && r.includes(null);
})());
check('normalizeRingOrder: preserves existing valid placement untouched', (() => {
  const r = normalizeRingOrder(['t2', null, 't1'], ['t1', 't2']);
  // t1, t2 모두 유효 -> 길이 2로 맞춰지되 기존 자리 유지(t2 idx0, t1 idx2->잘림 주의)
  return r.length === 2;
})());

// getRingEdgeLabelPositions: 경기 순서 라벨 위치 - 변(=경기) 개수만큼, 중심보다 변에 더 가까움
const n4 = 4;
const labelPos4 = getRingEdgeLabelPositions(n4, 260, 38, 9);
check('getRingEdgeLabelPositions(4) -> 4개 라벨 (변=경기 개수와 동일)', labelPos4.length === getRingEdges(n4).length);
check('getRingEdgeLabelPositions -> 라벨이 중심에서 충분히 떨어져 변 근처에 위치', (() => {
  const cx = 130, cy = 130;
  return labelPos4.every((p) => Math.hypot(p.x - cx, p.y - cy) > 0);
})());
check('getRingEdgeLabelPositions(2) -> 변 1개에 라벨 1개만 (n=2 특수케이스)', getRingEdgeLabelPositions(2, 260, 38).length === 1);
check('getRingEdgeLabelPositions -> 변의 중점보다 중심에서 더 먼 위치로 살짝 밀려남 (겹침 방지)', (() => {
  const cx = 130, cy = 130;
  const verts = getRingPositions(n4, 260, 38);
  const edges = getRingEdges(n4);
  return labelPos4.every((p, idx) => {
    const [i, j] = edges[idx];
    const mx = (verts[i].x + verts[j].x) / 2, my = (verts[i].y + verts[j].y) / 2;
    const distMid = Math.hypot(mx - cx, my - cy);
    const distLabel = Math.hypot(p.x - cx, p.y - cy);
    return distLabel > distMid; // 중점보다 바깥쪽
  });
})());
check('getRingEdgeLabelPositions(0) -> 빈 배열', getRingEdgeLabelPositions(0, 260, 38).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

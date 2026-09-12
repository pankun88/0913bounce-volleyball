import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  getSetWinner,
  evaluatePrelimMatch,
  evaluateFinalMatch,
  computeGroupStandings,
  computeAutomaticQualifiers,
  buildQualificationSnapshot,
  computeQualificationState,
  validateQualificationSelection,
  normalizePlayedSets,
  validateSetScore,
} from './match-logic.js';
import { generateBracket, recordMatchResult, invalidateDescendantResults, groupByRound, seedOrder, nextPowerOfTwo, buildCrossGroupSeedOrder, swapFinalSeedSlots, resetAndPropagateByes, confirmBye, placeByeTeam, publicMatchView, roundLabel } from './bracket.js';
import { generateRoundRobin, orderExistingRoundRobinMatchIds } from './schedule.js';
import { normalizeRingOrder, getRingEdges, getRingMatchPairs, getRingPositions, getRingEdgeLabelPositions } from './ring-bracket.js';
import {
  getPlannerVisibleAdjacent,
  groupPlannerAssignments,
  isPlannerMatchCompleted,
  movePlannerAssignment,
  movePlannerMatchByOffset,
  plannerPhaseMatches,
  swapPlannerCourts,
} from './score-workflow.js';
import {
  backupFromServerExport, normalizeBackupData, restorableRootData, selectRestoreRecovery, upgradeLegacyBackup,
} from './backup-format.js';
import {
  courtMatchSummary, courtTeamNames, formatCourtName, normalizeCourtName,
  projectPrelimCourtSchedule, getPrelimRingEdgeLabels, renderMatchMeta,
} from './court-display.js';
import {
  correctionConfirmationState,
  correctionSelectionInfo,
  correctionSelectionKeys,
  isCorrectionCandidateEligible,
} from './correction-view.js';
import {
  buildRecorderSubmitContext,
  readStoredRecorderDraft,
  reconcileRecorderAssignment,
  reconcileRecorderSubmit,
  writeStoredRecorderDraft,
} from './recorder-state.js';

let pass = 0, fail = 0;
const recorderFixtureIdentity = {
  matchKey: 'M1', matchType: 'prelim', divisionId: 'men',
  teamAId: 'team-a', teamBId: 'team-b', officialRevision: 0,
  lastTransitionId: 'fixture-created',
};
function check(label, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', label); }
}

{
  const source = fs.readFileSync(new URL('./workflow-service.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\s*/gm, '')
    .replace(/^export /gm, '');
  const context = { TOURNAMENT_ID: 'test' };
  vm.runInNewContext(`${source}
    globalThis.structuredReason = recorderReason({details:{reason:"qualification_unverified"}});
    globalThis.messageReason = recorderReason({message:"qualification_unverified"});
  `, context);
  check('unverified final qualification gives recorder actionable Korean guidance',
    context.structuredReason.includes('본선 진출팀') && context.structuredReason.includes('관리자'));
  check('unverified qualification guidance also handles plain reason responses',
    context.messageReason === context.structuredReason);
}

// Recorder sign-in persists across browser sessions without extending grants.
{
  const source = fs.readFileSync(new URL('./recorder-auth-service.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\s*/gm, '')
    .replace(/^export /gm, '');
  const events = [];
  const user = { uid: 'recorder-persistence-test' };
  const auth = { currentUser: user };
  const local = { type: 'LOCAL' };
  const session = { type: 'SESSION' };
  let now = 1000;
  let persistenceError = null;
  let popupError = null;
  let releasePersistence;
  let persistenceWait = new Promise((resolve) => { releasePersistence = resolve; });
  const context = {
    auth,
    browserLocalPersistence: local,
    browserSessionPersistence: session,
    GoogleAuthProvider: class {
      setCustomParameters(parameters) { this.parameters = parameters; return this; }
    },
    Date: { now: () => now },
    setPersistence: async (target, persistence) => {
      assert.equal(target, auth);
      events.push(['persistence', persistence]);
      if (persistenceError) throw persistenceError;
      await persistenceWait;
    },
    signInWithPopup: async (target, provider) => {
      assert.equal(target, auth);
      events.push(['popup', provider.parameters.prompt]);
      if (popupError) throw popupError;
      return { user };
    },
    signInWithRedirect: async (target, provider) => {
      assert.equal(target, auth);
      events.push(['redirect', provider.parameters.prompt]);
    },
    signOut: async (target) => {
      assert.equal(target, auth);
      events.push(['logout']);
      target.currentUser = null;
    },
  };
  vm.runInNewContext(`${source}
    globalThis.recorderAuth = { loginWithGoogle, logoutRecorder, state };
  `, context);
  const recorderAuth = context.recorderAuth;
  const pendingLogin = recorderAuth.loginWithGoogle();
  check('recorder waits for local persistence before opening Google sign-in',
    events.length === 1 && events[0][1] === local);
  releasePersistence();
  check('recorder popup sign-in keeps explicit Google account selection',
    (await pendingLogin).user === user && events[1][0] === 'popup' && events[1][1] === 'select_account');
  persistenceWait = Promise.resolve();
  for (const code of ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment']) {
    events.length = 0;
    popupError = Object.assign(new Error(code), { code });
    check(`recorder redirect retains local persistence for ${code}`,
      await recorderAuth.loginWithGoogle() === null
        && events[0][1] === local
        && events.map(([event]) => event).join(',') === 'persistence,popup,redirect');
  }
  events.length = 0;
  popupError = Object.assign(new Error('popup closed'), { code: 'auth/popup-closed-by-user' });
  await assert.rejects(recorderAuth.loginWithGoogle(), /popup closed/);
  check('cancelled Google sign-in does not force a redirect',
    events.map(([event]) => event).join(',') === 'persistence,popup');
  events.length = 0;
  persistenceError = new Error('local storage unavailable');
  await assert.rejects(recorderAuth.loginWithGoogle(), /local storage unavailable/);
  check('failed local persistence does not silently sign in with session-only storage',
    events.length === 1 && events[0][1] === local);

  const root = { recorderFeatureEnabled: true };
  const challenge = { enabled: true, version: 2 };
  const expiresAt = now + 12 * 60 * 60 * 1000;
  const grant = { uid: user.uid, status: 'active', version: 2, expiresAt: { toMillis: () => expiresAt } };
  const grantState = () => recorderAuth.state(user, root, challenge, grant, false, 'google.com');
  check('restored recorder login uses an existing valid grant without another code exchange',
    grantState().kind === 'ready');
  now = expiresAt;
  check('persistent Google login does not bypass the twelve-hour grant expiry',
    grantState().kind === 'staleGrant' && grantState().user === user);
  now -= 1;
  grant.status = 'revoked';
  check('persistent Google login does not bypass revoked recorder access',
    grantState().kind === 'staleGrant');
  grant.status = 'active';
  challenge.version += 1;
  check('persistent Google login does not bypass access-code rotation',
    grantState().kind === 'staleGrant');
  events.length = 0;
  await recorderAuth.logoutRecorder();
  check('explicit recorder logout still signs out the stored account',
    events.length === 1 && events[0][0] === 'logout' && auth.currentUser === null);
}

// A cached assignment may briefly contain the post-swap court. Only the
// authoritative snapshot fences the current recorder context.
{
  const moved = { matchKey: 'M1', courtId: 'court-b' };
  check(
    'cached assignment court move does not revoke the current recorder',
    reconcileRecorderAssignment({
      assignment: moved,
      metadata: { fromCache: true },
      courtId: 'court-a',
    }).status === 'ignore',
  );
  check(
    'authoritative assignment court move revokes the current recorder',
    reconcileRecorderAssignment({
      assignment: moved,
      metadata: { fromCache: false },
      courtId: 'court-a',
    }).status === 'lost',
  );
}

// Context invalidation keeps the original match/uid storage identity even
// when the source court has no successor match.
{
  const storageData = new Map();
  const storage = {
    getItem: (key) => storageData.has(key) ? storageData.get(key) : null,
    setItem: (key, value) => storageData.set(key, value),
    removeItem: (key) => storageData.delete(key),
  };
  const originalKey = 'recorder-score:tournament:M1:uid-1';
  const movedKey = 'recorder-score:tournament:M2:uid-1';
  const draft = { sets: [{ a: 10, b: 8 }] };
  const pendingSave = {
    context: { matchKey: 'M1', courtId: 'court-a', storageKey: originalKey, fixtureIdentity: recorderFixtureIdentity },
    draft,
    touched: new Set(['0-a']),
    expectedRevision: 3,
  };
  const stored = writeStoredRecorderDraft(storage, pendingSave.context.storageKey, {
    draft: pendingSave.draft,
    touched: [...pendingSave.touched],
    revision: pendingSave.expectedRevision,
    identity: pendingSave.context.fixtureIdentity,
  });
  const recovered = readStoredRecorderDraft(storage, originalKey);
  check(
    'dirty pending-save draft survives a source court with an empty queue',
    stored.ok && recovered.ok && recovered.found && recovered.value.revision === 3
      && recovered.value.draft.sets[0].a === 10 && !storageData.has(movedKey),
  );
}

// A stale operation keeps its immutable request and old storage key until
// the callable settles; a rejection never retargets or deletes the new draft.
{
  const pending = buildRecorderSubmitContext({
    matchKey: 'M1',
    courtId: 'court-a',
    token: 'token-1',
    queueRevision: 7,
    score: { sets: [{ a: 10, b: 8 }] },
    operationId: 'operation-1',
    storageKey: 'recorder-score:tournament:M1:uid-1',
    fixtureIdentity: recorderFixtureIdentity,
    contextVersion: 0,
  });
  const rejected = reconcileRecorderSubmit({
    pendingSubmit: pending,
    currentMatchKey: 'M2',
    outcome: 'rejected',
  });
  check(
    'stale submit rejection retains immutable old request',
    rejected.status === 'pending' && rejected.pendingSubmit === pending
      && pending.matchKey === 'M1' && pending.courtId === 'court-a'
      && pending.storageKey.endsWith(':M1:uid-1'),
  );
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
check('match metadata retains the assigned final division before the official fixture loads',
  courtMatchSummary({ matchType: 'final', divisionId: 'women' }, null).division === 'women');
check('match metadata resolves a preliminary division from the official match or its group',
  courtMatchSummary({ matchType: 'prelim' }, { division: 'men' }).division === 'men'
    && courtMatchSummary({ matchType: 'prelim' }, { groupId: 'g' }, {
      groupsById: new Map([['g', { division: 'women' }]]),
    }).division === 'women');
check('missing division information never defaults to the mens division',
  courtMatchSummary({ matchType: 'final' }, null).division === null);
const prelimProjectionMatches = [
  { id: 'p1', groupId: 'g', round: 1, teamA: 't1', teamB: 't2' },
  { id: 'p2', groupId: 'g', round: 2, teamA: 't2', teamB: 't3' },
  { id: 'p3', groupId: 'g', round: 3, teamA: 't3', teamB: 't1' },
];
const prelimProjectionAssignments = [
  { matchKey: 'p1', courtId: 'court-a', courtOrder: 5 },
  { matchKey: 'p2', courtId: 'court-a', courtOrder: 3 },
  { matchKey: 'p3', courtId: 'court-a', courtOrder: 1 },
];
const prelimProjectionBefore = JSON.stringify(prelimProjectionAssignments);
const prelimMatchesBefore = JSON.stringify(prelimProjectionMatches);
const prelimProjection = projectPrelimCourtSchedule(
  prelimProjectionMatches,
  prelimProjectionAssignments,
  [{ id: 'court-a', name: 'A코트' }],
);
check(
  'projection preserves absolute reverse planner slots 1/3/5',
  JSON.stringify(prelimProjection.map((item) => [item.match.id, item.courtOrder])) === JSON.stringify([
    ['p3', 1], ['p2', 3], ['p1', 5],
  ]),
);
check(
  'projection labels use normalized court name and per-court round',
  prelimProjection[0].label === 'A코트 · 1라운드'
    && prelimProjection[2].label === 'A코트 · 5라운드',
);
check(
  'projection does not mutate matches or assignments',
  JSON.stringify(prelimProjectionAssignments) === prelimProjectionBefore
    && JSON.stringify(prelimProjectionMatches) === prelimMatchesBefore,
);

const interleavedProjectionMatches = [
  { id: 'prelim-men', division: 'men', round: 1, teamA: 'm1', teamB: 'm2' },
  { id: 'prelim-women', division: 'women', round: 1, teamA: 'w1', teamB: 'w2' },
  { id: 'prelim-men-later', division: 'men', round: 2, teamA: 'm2', teamB: 'm3' },
];
const interleavedProjection = projectPrelimCourtSchedule(
  interleavedProjectionMatches,
  [
    { matchKey: 'prelim-men', courtId: 'court-a', courtOrder: 1 },
    { matchKey: 'final:women:final-women', courtId: 'court-a', courtOrder: 2 },
    { matchKey: 'prelim-women', courtId: 'court-a', courtOrder: 3 },
    { matchKey: 'prelim-men-later', courtId: 'court-a', courtOrder: 4 },
  ],
  [{ id: 'court-a', name: 'A' }],
);
check(
  'projection keeps interleaved final/opposite-division slots in the same court lane',
  JSON.stringify(interleavedProjection.map((item) => [item.match.id, item.courtOrder])) === JSON.stringify([
    ['prelim-men', 1], ['prelim-women', 3], ['prelim-men-later', 4],
  ]),
);

const customCourtProjection = projectPrelimCourtSchedule(
  [
    { id: 'a', round: 1 },
    { id: 'b', round: 1 },
    { id: 'c', round: 1 },
  ],
  [
    { matchKey: 'a', courtId: 'court-z', courtOrder: 2 },
    { matchKey: 'b', courtId: 'court-a', courtOrder: 1 },
    { matchKey: 'c', courtId: 'court-z', courtOrder: 1 },
  ],
  [{ id: 'court-z', name: 'Z' }, { id: 'court-a', name: 'A' }],
);
check(
  'projection follows passed custom court input order before court order',
  JSON.stringify(customCourtProjection.map((item) => [item.match.id, item.courtName, item.courtOrder])) === JSON.stringify([
    ['c', 'Z', 1], ['a', 'Z', 2], ['b', 'A', 1],
  ]),
);

const invalidProjectionMatches = [
  { id: 'missing', round: 1 },
  { id: 'unknown-court', round: 2 },
  { id: 'unassigned', round: 3 },
  { id: 'zero-order', round: 4 },
  { id: 'fractional-order', round: 5 },
  { id: 'infinite-order', round: 6 },
];
const invalidProjection = projectPrelimCourtSchedule(
  invalidProjectionMatches,
  [
    { matchKey: 'unknown-court', courtId: 'court-missing', courtOrder: 1 },
    { matchKey: 'unassigned', courtId: null, courtOrder: 2 },
    { matchKey: 'zero-order', courtId: 'court-a', courtOrder: 0 },
    { matchKey: 'fractional-order', courtId: 'court-a', courtOrder: 1.5 },
    { matchKey: 'infinite-order', courtId: 'court-a', courtOrder: Infinity },
  ],
  [{ id: 'court-a', name: 'A' }],
);
check(
  'missing, unknown, unassigned, and invalid placements are explicit unassigned',
  invalidProjection.every((item) => item.courtId === null
    && item.courtName === ""
    && item.courtOrder === null
    && item.label === "미배정"),
);
check(
  'unassigned projection rows retain structural round/id order',
  JSON.stringify(invalidProjection.map((item) => item.match.id)) === JSON.stringify(invalidProjectionMatches.map((item) => item.id)),
);

const equalOrderProjectionMatches = [
  { id: 'z-id', round: 2 },
  { id: 'a-id', round: 1 },
  { id: 'b-id', round: 1 },
];
const equalOrderProjection = projectPrelimCourtSchedule(
  equalOrderProjectionMatches,
  equalOrderProjectionMatches.map((match) => ({
    matchKey: match.id, courtId: 'court-a', courtOrder: 1,
  })),
  [{ id: 'court-a', name: 'A' }],
);
check(
  'equal court-order ties are deterministic by structural round then id',
  JSON.stringify(equalOrderProjection.map((item) => item.match.id)) === JSON.stringify(['a-id', 'b-id', 'z-id']),
);

const ringSchedule = projectPrelimCourtSchedule(
  [
    { id: 'm-ab', round: 3, teamA: 'a', teamB: 'b' },
    { id: 'm-bc', round: 1, teamA: 'c', teamB: 'b' },
    { id: 'm-ca', round: 2, teamA: 'a', teamB: 'c' },
  ],
  [
    { matchKey: 'm-ab', courtId: 'court-a', courtOrder: 5 },
    { matchKey: 'm-bc', courtId: 'court-a', courtOrder: 3 },
    { matchKey: 'm-ca', courtId: 'court-a', courtOrder: 1 },
  ],
  [{ id: 'court-a', name: 'A' }],
);
const ringOrderBefore = ['a', 'b', 'c'];
const ringScheduleBefore = JSON.stringify(ringSchedule);
const ringLabels = getPrelimRingEdgeLabels(ringOrderBefore, ringSchedule);
check(
  'ring labels resolve reverse team orientation without changing topology',
  JSON.stringify(ringLabels.map((item) => item.text)) === JSON.stringify([
    'A코트 - 5라운드',
    'A코트 - 3라운드',
    'A코트 - 1라운드',
  ])
    && JSON.stringify(ringOrderBefore) === JSON.stringify(['a', 'b', 'c'])
    && JSON.stringify(ringSchedule) === ringScheduleBefore,
);
check(
  'ring labels support the two-vertex special case',
  JSON.stringify(getPrelimRingEdgeLabels(['a', 'b'], ringSchedule).map((item) => item.text))
    === JSON.stringify(['A코트 - 5라운드']),
);
check(
  'ring labels preserve structural edge count and use explicit unassigned fallback',
  getPrelimRingEdgeLabels(['a', 'b', 'missing', 'c'], ringSchedule).length === 4
    && getPrelimRingEdgeLabels(['a', 'b', 'missing', 'c'], ringSchedule)
      .every((item, index) => index === 0
        ? item.text === 'A코트 - 5라운드'
        : index === 3
          ? item.text === 'A코트 - 1라운드'
          : item.text === '미배정' && item.title === `미배정 · 대진 ${index + 1}`),
);
check(
  'ring label text and titles are safe strings',
  ringLabels.every((item) => typeof item.text === 'string' && typeof item.title === 'string')
    && ringLabels[0].title === 'A코트 · 5라운드',
);
const numericRingMatches = [
  { id: 'numeric-12', round: 12, teamA: 'numeric-1', teamB: 'numeric-2' },
  { id: 'numeric-23', round: 2, teamA: 'numeric-2', teamB: 'numeric-3' },
  { id: 'numeric-34', round: 3, teamA: 'numeric-3', teamB: 'numeric-4' },
  { id: 'numeric-41', round: 4, teamA: 'numeric-4', teamB: 'numeric-1' },
];
const numericRingMatchesBefore = JSON.stringify(numericRingMatches);
const numericRingSchedule = projectPrelimCourtSchedule(
  numericRingMatches,
  [
    { matchKey: 'numeric-12', courtId: 'court-1', courtOrder: 12 },
    { matchKey: 'numeric-23', courtId: 'court-2', courtOrder: 2 },
    { matchKey: 'numeric-34', courtId: 'court-3', courtOrder: 3 },
    { matchKey: 'numeric-41', courtId: 'court-12', courtOrder: 12 },
  ],
  [
    { id: 'court-1', name: '1코트' },
    { id: 'court-2', name: '2' },
    { id: 'court-3', name: '3' },
    { id: 'court-12', name: '12' },
  ],
);
const numericRingLabels = getPrelimRingEdgeLabels(
  ['numeric-1', 'numeric-2', 'numeric-3', 'numeric-4'],
  numericRingSchedule,
);
check(
  'numeric and multi-digit court labels keep units and assignment rounds explicit',
  JSON.stringify(numericRingLabels.map((item) => item.text)) === JSON.stringify([
    '1코트 - 12라운드',
    '2코트 - 2라운드',
    '3코트 - 3라운드',
    '12코트 - 12라운드',
  ])
    && numericRingLabels[0].title === '1코트 · 12라운드'
    && numericRingLabels.every((item) => !item.text.includes('코트코트')),
);
check(
  'numeric court projection preserves source match rounds and normalized names',
  JSON.stringify(numericRingMatches) === numericRingMatchesBefore
    && numericRingSchedule.every((row) => !row.courtName.endsWith('코트코트')),
);
const shuffledUnassignedMatches = [
  { id: 'z-unassigned', round: 2 },
  { id: 'b-unassigned', round: 1 },
  { id: 'a-unassigned', round: 1 },
];
const shuffledUnassigned = projectPrelimCourtSchedule(shuffledUnassignedMatches, [], []);
check(
  'shuffled unassigned rows sort deterministically by structural round then id',
  JSON.stringify(shuffledUnassigned.map((item) => item.match.id)) === JSON.stringify([
    'a-unassigned', 'b-unassigned', 'z-unassigned',
  ]),
);
const partialRingLabels = getPrelimRingEdgeLabels([null, 'b'], [
  {
    match: { teamA: null, teamB: 'b' },
    courtId: 'court-a',
    courtName: 'A',
    courtOrder: 1,
    label: 'A코트 · 1라운드',
  },
]);
check(
  'partial ring vertices never match rows with missing team IDs',
  partialRingLabels.length === 1
    && partialRingLabels[0].text === '미배정'
    && partialRingLabels[0].title === '미배정 · 대진 1',
);
check(
  'blank ring vertices never match rows with blank team IDs',
  getPrelimRingEdgeLabels(["", "b"], [{
    match: { teamA: "", teamB: "b" },
    courtId: "court-a",
    courtName: "A",
    courtOrder: 1,
    label: "A코트 · 1라운드",
  }])[0].text === "미배정",
);
check(
  'ring labels reject missing court names and invalid orders',
  getPrelimRingEdgeLabels(["a", "b"], [{
    match: { teamA: "a", teamB: "b" },
    courtId: "court-a",
    courtName: "",
    courtOrder: 1,
    label: "미배정",
  }])[0].text === "미배정"
    && getPrelimRingEdgeLabels(["a", "b"], [{
      match: { teamA: "a", teamB: "b" },
      courtId: "court-a",
      courtName: "A",
      courtOrder: 0,
      label: "A코트 · 0라운드",
    }])[0].text === "미배정",
);

// ---- approved correction selection state ----
const correctionFixtures = [
  {
    id: 'approved-1',
    assignment: { id: 'approved-1', courtId: 'court-a', publicStatus: 'completed', officialRevision: 2 },
    workflow: { draftState: 'approved', officialRevision: 2 },
    officialMatch: { officialRevision: 2, officialCurrent: true },
    entitiesReady: true,
  },
  {
    id: 'approved-2',
    assignment: { id: 'approved-2', courtId: 'court-a', publicStatus: 'completed', officialRevision: 1 },
    workflow: { draftState: 'approved', officialRevision: 1 },
    officialMatch: { officialRevision: 1, officialCurrent: true },
    entitiesReady: true,
  },
  {
    id: 'approved-other-court',
    assignment: { id: 'approved-other-court', courtId: 'court-b', publicStatus: 'completed', officialRevision: 1 },
    workflow: { draftState: 'approved', officialRevision: 1 },
    officialMatch: { officialRevision: 1, officialCurrent: true },
    entitiesReady: true,
  },
  {
    id: 'retracted',
    assignment: { id: 'retracted', courtId: 'court-a', publicStatus: 'replay_required', officialRevision: 3 },
    workflow: { draftState: 'rejected', officialRevision: 3 },
    officialMatch: { officialRevision: 3, officialCurrent: false },
    entitiesReady: true,
  },
];
check(
  'correction eligibility excludes retracted official results awaiting re-entry',
  !isCorrectionCandidateEligible(correctionFixtures[3])
  && isCorrectionCandidateEligible(correctionFixtures[0]),
);
check(
  'correction eligibility excludes candidates with missing public entities',
  !isCorrectionCandidateEligible({ ...correctionFixtures[0], id: 'missing', entitiesReady: false }),
);
const retainedCorrectionSelection = correctionSelectionKeys(
  new Set(['approved-1', 'approved-2', 'removed']),
  correctionFixtures,
);
check(
  'correction selection retains eligible keys and removes stale entries',
  retainedCorrectionSelection.size === 2
  && retainedCorrectionSelection.has('approved-1')
  && !retainedCorrectionSelection.has('removed'),
);
const sameCourtCorrection = correctionSelectionInfo(
  new Set(['approved-1', 'approved-2']),
  correctionFixtures,
);
const mixedCourtCorrection = correctionSelectionInfo(
  new Set(['approved-1', 'approved-other-court']),
  correctionFixtures,
);
check('correction selection allows multiple matches on one court', sameCourtCorrection.sameCourt && sameCourtCorrection.courtId === 'court-a');
check('correction selection identifies cross-court targets for prevention', !mixedCourtCorrection.sameCourt && mixedCourtCorrection.courtId === null);
const previewFixture = {
  generation: 4,
  matchKeys: ['approved-1', 'approved-2'],
  planToken: { courtId: 'court-a', expectedQueueRevision: 3, fingerprint: 'fixture' },
};
check(
  'correction stale preview is invalidated when generation changes',
  !correctionConfirmationState({
    selectedKeys: new Set(['approved-1', 'approved-2']),
    preview: previewFixture,
    generation: 5,
    reason: '입력 오류',
    acknowledged: true,
  }).canApply,
);
check(
  'correction apply guard requires reason and acknowledgement',
  !correctionConfirmationState({
    selectedKeys: new Set(['approved-1', 'approved-2']),
    preview: previewFixture,
    generation: 4,
    reason: '',
    acknowledged: false,
  }).canApply
  && !correctionConfirmationState({
    selectedKeys: new Set(['approved-1', 'approved-2']),
    preview: previewFixture,
    generation: 4,
    reason: '입력 오류',
    acknowledged: true,
    activeLocks: ['approved-1'],
  }).canApply
  && correctionConfirmationState({
    selectedKeys: new Set(['approved-1', 'approved-2']),
    preview: previewFixture,
    generation: 4,
    reason: '입력 오류',
    acknowledged: true,
  }).canApply,
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
const domainBackup = {
  ...emptyV3Backup,
  groups: [
    { id: 'g-men', data: { name: '남자 A조', division: 'men', ringOrder: ['t-men'] } },
    { id: 'g-women', data: { name: '여자 A조', division: 'women', ringOrder: [] } },
  ],
  teams: [
    { id: 't-men', data: { name: '남자 팀', division: 'men', groupId: 'g-men' } },
    { id: 't-women', data: { name: '여자 팀', division: 'women', groupId: 'g-women' } },
  ],
  prelimMatches: [{
    id: 'p-men',
    data: { groupId: 'g-men', division: 'men', teamA: 't-men', teamB: 't-men-2' },
  }],
};
const domainValidBackup = {
  ...domainBackup,
  teams: [
    ...domainBackup.teams,
    { id: 't-men-2', data: { name: '남자 팀 2', division: 'men', groupId: 'g-men' } },
  ],
  groups: [{
    ...domainBackup.groups[0],
    data: { ...domainBackup.groups[0].data, ringOrder: ['t-men', 't-men-2'] },
  }, domainBackup.groups[1]],
};
check('v3 backup accepts consistent group/team/preliminary references',
  normalizeBackupData(domainValidBackup).prelimMatches[0].data.teamB === 't-men-2');
let missingDomainReferenceRejected = false;
try {
  normalizeBackupData({
    ...domainValidBackup,
    teams: domainValidBackup.teams.map((item) => item.id === 't-men' ? {
      ...item, data: { ...item.data, groupId: 'missing-group' },
    } : item),
  });
} catch {
  missingDomainReferenceRejected = true;
}
check('v3 backup rejects a team that references a missing group', missingDomainReferenceRejected);
let missingPrelimTeamRejected = false;
try {
  normalizeBackupData({
    ...domainValidBackup,
    prelimMatches: [{
      id: 'p-men',
      data: { groupId: 'g-men', division: 'men', teamA: 'missing-team', teamB: 't-men-2' },
    }],
  });
} catch {
  missingPrelimTeamRejected = true;
}
check('v3 backup rejects a preliminary match that references a missing team', missingPrelimTeamRejected);
let crossGroupTeamRejected = false;
try {
  normalizeBackupData({
    ...domainValidBackup,
    prelimMatches: [{
      id: 'p-men',
      data: { groupId: 'g-men', division: 'men', teamA: 't-men', teamB: 't-women' },
    }],
  });
} catch {
  crossGroupTeamRejected = true;
}
check('v3 backup rejects a preliminary team from another group', crossGroupTeamRejected);
let crossDivisionTeamRejected = false;
try {
  normalizeBackupData({
    ...domainValidBackup,
    teams: domainValidBackup.teams.map((item) => item.id === 't-men-2' ? {
      ...item, data: { ...item.data, division: 'women' },
    } : item),
  });
} catch {
  crossDivisionTeamRejected = true;
}
check('v3 backup rejects a team whose division disagrees with its group', crossDivisionTeamRejected);
let samePrelimTeamRejected = false;
try {
  normalizeBackupData({
    ...domainValidBackup,
    prelimMatches: [{
      id: 'p-men',
      data: { groupId: 'g-men', division: 'men', teamA: 't-men', teamB: 't-men' },
    }],
  });
} catch {
  samePrelimTeamRejected = true;
}
check('v3 backup rejects a preliminary match that references one team twice', samePrelimTeamRejected);
const unresolvedFinalBackup = normalizeBackupData({
  ...domainValidBackup,
  finalMatches: {
    men: [{
      id: 'm_r1_0',
      data: {
        round: 1, index: 0, status: 'empty',
        teamA: null, teamB: null, teamASource: null, teamBSource: null,
        nextMatchId: 'm_r2_0', nextSlot: 'A',
      },
    }, {
      id: 'm_r2_0',
      data: {
        round: 2, index: 0, status: 'waiting',
        teamA: null, teamB: null, teamASource: null, teamBSource: null,
        nextMatchId: null, nextSlot: null,
      },
    }],
    women: [{
      id: 'w_r1_0',
      data: {
        round: 1, index: 0, status: 'bye',
        teamA: { id: 't-women', name: '여자 팀' }, teamB: null,
        teamASource: { type: 'fixedTeam' }, teamBSource: null,
        nextMatchId: null, nextSlot: null,
      },
    }],
  },
});
check('v3 backup preserves unresolved final slots and confirmed byes',
  unresolvedFinalBackup.finalMatches.men[0].data.teamA === null
    && unresolvedFinalBackup.finalMatches.men[1].data.status === 'waiting'
    && unresolvedFinalBackup.finalMatches.women[0].data.status === 'bye');
let missingFinalTeamRejected = false;
try {
  normalizeBackupData({
    ...domainValidBackup,
    finalMatches: {
      men: [{
        id: 'missing-final-team',
        data: { teamA: { id: 'missing-team' }, teamB: null, status: 'waiting' },
      }],
      women: [],
    },
  });
} catch {
  missingFinalTeamRejected = true;
}
check('v3 backup rejects a final entrant that references a missing team', missingFinalTeamRejected);
let crossDivisionFinalTeamRejected = false;
try {
  normalizeBackupData({
    ...domainValidBackup,
    finalMatches: {
      men: [{
        id: 'cross-division-final-team',
        data: { teamA: { id: 't-women' }, teamB: null, status: 'waiting' },
      }],
      women: [],
    },
  });
} catch {
  crossDivisionFinalTeamRejected = true;
}
check('v3 backup rejects a final entrant from another division', crossDivisionFinalTeamRejected);
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
    { path: 'tournaments/main/groups/g1', data: { name: 'A조', division: 'women' } },
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

// Card borders, not centers, keep the same gap from horizontal and sloping edges.
for (const n of [2, 3, 4, 5, 6, 8, 12, 30]) {
  const gap = 6;
  const vertices = getRingPositions(n, 600, 100);
  const edges = getRingEdges(n);
  const anchors = getRingEdgeLabelPositions(n, 600, 100, gap);
  check(`ring ${n}-team card borders keep equal gaps for short, wide and wrapped text`,
    anchors.every((anchor, index) => {
      const [a, b] = edges[index].map((vertex) => vertices[vertex]);
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      return [[82, 24], [110, 24], [150, 40]].every(([width, height]) => {
        const left = anchor.x + anchor.translateX / 100 * width;
        const top = anchor.y + anchor.translateY / 100 * height;
        const corners = [[left, top], [left + width, top], [left, top + height], [left + width, top + height]];
        const nearest = Math.min(...corners.map(([x, y]) => ((x - a.x) * dy - (y - a.y) * dx) / length));
        return Math.abs(nearest - gap) < 1e-6;
      });
    }),
  );
}
{
  const vertices = getRingPositions(3, 454, 88);
  const labels = getRingEdgeLabelPositions(3, 454, 88);
  const lower = labels[1];
  check('triangle bottom label anchors its top border near the horizontal edge',
    lower.translateX === -50 && lower.translateY === 0
      && Math.abs(lower.y - (vertices[1].y + vertices[2].y) / 2 - 6) < 1e-6);
  const collapsed = getRingEdgeLabelPositions(2, 260, 130)[0];
  check('degenerate ring coordinates remain finite',
    Number.isFinite(collapsed.x) && Number.isFinite(collapsed.y)
      && collapsed.translateX === -50 && collapsed.translateY === -50);
}

// ---- dashboard venue rotation / public schedule ----
function createDashboardHarness(search = '?display=venue', options = {}) {
  const source = fs.readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\s*/gm, '');
  let now = 0;
  let nextTimerId = 1;
  let nextAnimationFrameId = 1;
  const intervals = new Map();
  const animationFrames = new Map();
  const resizeObservers = [];
  const fontReadyHandlers = [];
  const fontEventHandlers = new Map();
  const listeners = new Map();
  const subscriptions = {};
  const ringRenders = [];
  const bracketRenders = [];
  let animationFrameRequestCount = 0;
  const fitGeometry = {
    viewportWidth: 1280,
    viewportHeight: 720,
    stageWidth: 1280,
    stageHeight: 720,
    compactStageHeight: null,
    stageLeft: 0,
    stageTop: 0,
    descendants: [],
  };

  function element(id, extra = {}) {
    const classes = new Set();
    const classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains: (name) => classes.has(name),
    };
    const node = {
      id,
      children: [],
      parentNode: null,
      className: '',
      classList,
      dataset: {},
      style: {},
      hidden: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      offsetWidth: 0,
      offsetHeight: 0,
      scrollWidth: 0,
      scrollHeight: 0,
      eventHandlers: {},
      setAttribute(name, value) { this[name] = String(value); },
      addEventListener(name, handler) {
        (this.eventHandlers[name] ||= []).push(handler);
      },
      click() {
        (this.eventHandlers.click || []).forEach((handler) => handler({ currentTarget: this }));
      },
      querySelectorAll() { return []; },
      matches(selector) {
        if (selector === '*') return true;
        if (selector.startsWith('.')) {
          const name = selector.slice(1);
          return classes.has(name) || String(this.className || '').split(/\s+/).includes(name);
        }
        return false;
      },
      getBoundingClientRect() {
        const rect = typeof this._rect === 'function' ? this._rect() : this._rect;
        if (rect) return { ...rect };
        const width = Number(this.offsetWidth) || 0;
        const height = Number(this.offsetHeight) || 0;
        return { left: 0, top: 0, right: width, bottom: height, width, height };
      },
      appendChild(child) {
        if (child) {
          child.parentNode = this;
          this.children.push(child);
        }
        this.lastChild = child;
        return child;
      },
      append(...children) { children.forEach((child) => this.appendChild(child)); },
      prepend(...children) {
        children.forEach((child) => { child.parentNode = this; });
        this.children.unshift(...children);
      },
      replaceChildren(...children) {
        this.children = [];
        this.lastChildren = children;
        this.innerHTML = '';
        children.forEach((child) => this.appendChild(child));
      },
      after(child) { this.afterChild = child; },
      ...extra,
    };
    return node;
  }

  function setFitGeometry(next = {}) {
    Object.assign(fitGeometry, next);
    const viewport = elements.dashboardViewport;
    const stage = elements.dashboardStage;
    const compactPrelim = () => Boolean(
      elements.dashPrelim?.classList?.contains("dashboard-prelim-compact"),
    );
    viewport.clientWidth = Number(fitGeometry.viewportWidth) || 0;
    viewport.clientHeight = Number(fitGeometry.viewportHeight) || 0;
    viewport.offsetWidth = viewport.clientWidth;
    viewport.offsetHeight = viewport.clientHeight;
    viewport._rect = () => ({
      left: 0,
      top: 0,
      right: viewport.clientWidth,
      bottom: viewport.clientHeight,
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    });
    stage.offsetWidth = Number(fitGeometry.stageWidth) || 0;
    if (!stage._fitHeightAccessors) {
      Object.defineProperty(stage, "offsetHeight", {
        configurable: true,
        get() {
          const compactHeight = Number(fitGeometry.compactStageHeight);
          return compactPrelim() && Number.isFinite(compactHeight)
            ? compactHeight
            : Number(fitGeometry.stageHeight) || 0;
        },
      });
      Object.defineProperty(stage, "scrollHeight", {
        configurable: true,
        get() {
          return stage.offsetHeight;
        },
      });
      stage._fitHeightAccessors = true;
    }
    stage.scrollWidth = stage.offsetWidth;
    stage._rect = () => ({
      left: Number(fitGeometry.stageLeft) || 0,
      top: Number(fitGeometry.stageTop) || 0,
      right: (Number(fitGeometry.stageLeft) || 0) + stage.offsetWidth,
      bottom: (Number(fitGeometry.stageTop) || 0) + stage.offsetHeight,
      width: stage.offsetWidth,
      height: stage.offsetHeight,
    });
    stage._fitDescendants = (fitGeometry.descendants || []).map((item) => {
      if (item && typeof item.getBoundingClientRect === 'function') return item;
      const rect = { ...(item || {}) };
      return {
        hidden: Boolean(item?.hidden),
        _computedStyle: item?._computedStyle || {},
        getBoundingClientRect() {
          if (compactPrelim() && Number.isFinite(Number(item?.compactHeight))) {
            const compactHeight = Number(item.compactHeight);
            return {
              ...rect,
              height: compactHeight,
              bottom: (Number(rect.top) || 0) + compactHeight,
            };
          }
          return { ...rect };
        },
      };
    });
  }

  const elements = Object.fromEntries([
    'dashboardShell', 'dashTitle', 'dashDivisionBadge', 'dashPrelim', 'dashBracketCard',
    'dashBracketTitle', 'dashBracketContainer', 'dashBracketFullscreenBtn',
    'dashFullscreenBtn', 'dashboardFullscreenStatus',
    'dashboardViewport', 'dashboardStage',
    'dashDivisionSwitch', 'maintenanceNotice', 'dashboardLiveContent', 'venueStatusHome',
    'venueSwitcher', 'venueCurrentDivision', 'venueNextDivision', 'venueCountdown',
    'venueProgressTrack', 'venueProgressBar', 'errorBanner',
  ].map((id) => [id, element(id)]));
  elements.dashboardViewport.children = [elements.dashboardStage];
  elements.dashboardStage.parentNode = elements.dashboardViewport;
  elements.dashboardStage.children = [elements.dashboardLiveContent];
  elements.dashboardLiveContent.parentNode = elements.dashboardStage;
  elements.venueSwitcher.parentNode = elements.dashboardShell;
  elements.dashboardStage.querySelectorAll = (selector) => selector === '*'
    ? elements.dashboardStage._fitDescendants || []
    : [];
  setFitGeometry();
  const divisionButtons = ['men', 'women'].map((division) => element(`division-${division}`, { dataset: { division } }));
  const tabButtons = ['prelim', 'final'].map((tab) => element(`tab-button-${tab}`, { dataset: { tab } }));
  const tabPanels = ['prelim', 'final'].map((tab) => element(`tab-${tab}`, { id: `tab-${tab}` }));
  tabPanels.forEach((panel) => { elements[panel.id] = panel; });
  elements.dashDivisionSwitch.querySelectorAll = () => divisionButtons;
  elements.dashBracketFullscreenBtn.requestFullscreen = null;
  elements.dashBracketCard.requestFullscreen = null;
  const liveDot = element('live-dot');
  const body = element('body');
  const documentElement = element('documentElement');
  const document = {
    body,
    documentElement,
    visibilityState: 'visible',
    fonts: {
      ready: {
        then(handler) {
          fontReadyHandlers.push(handler);
          return { catch() {} };
        },
      },
      addEventListener(name, handler) {
        (fontEventHandlers.get(name) || (fontEventHandlers.set(name, []), fontEventHandlers.get(name))).push(handler);
      },
    },
    createElement(tagName) {
      return element(`created-${tagName}-${nextTimerId++}`, { tagName: String(tagName).toUpperCase() });
    },
    createTextNode(text) {
      return element(`text-${nextTimerId++}`, { textContent: String(text) });
    },
    getElementById(id) {
      return elements[id] ||= element(id);
    },
    querySelectorAll(selector) {
      if (selector === '.tab-btn') return tabButtons;
      if (selector === '.tab-panel') return tabPanels;
      if (selector === '#dashDivisionSwitch [data-division]') return divisionButtons;
      return [];
    },
    querySelector(selector) {
      return selector === '.live-dot' ? liveDot : null;
    },
    addEventListener(name, handler) {
      (listeners.get(name) || (listeners.set(name, []), listeners.get(name))).push(handler);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach((handler) => handler(event));
    },
  };
  const window = {
    location: { search, pathname: '/dashboard.html' },
    performance: { now: () => now },
    setInterval(handler, delay) {
      const id = nextTimerId++;
      intervals.set(id, { handler, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    requestAnimationFrame(handler) {
      const id = nextAnimationFrameId++;
      animationFrameRequestCount += 1;
      animationFrames.set(id, handler);
      return id;
    },
    cancelAnimationFrame(id) { animationFrames.delete(id); },
    setTimeout,
    clearTimeout,
    addEventListener(name, handler) {
      (listeners.get(`window:${name}`) || (listeners.set(`window:${name}`, []), listeners.get(`window:${name}`))).push(handler);
    },
    dispatchEvent(event) {
      (listeners.get(`window:${event.type}`) || []).forEach((handler) => handler(event));
    },
  };
  const context = {
    window,
    document,
    subscriptions,
    divisionButtons,
    tabButtons,
    tabPanels,
    history: { replaceState() {} },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    getComputedStyle: (node) => ({
      display: node?._computedStyle?.display || 'block',
      visibility: node?._computedStyle?.visibility || 'visible',
      columnGap: node?._computedStyle?.columnGap || node?.style?.columnGap || '16px',
      gap: node?._computedStyle?.gap || node?.style?.gap || '16px',
    }),
    ResizeObserver: class ResizeObserverMock {
      constructor(callback) {
        this.callback = callback;
        resizeObservers.push(this);
      }
      observe(target) { this.target = target; }
      disconnect() {}
    },
    subscribeTournamentInfo: (cb) => { subscriptions.tournament = cb; },
    subscribeGroups: (cb) => { subscriptions.groups = cb; },
    subscribeTeams: (cb) => { subscriptions.teams = cb; },
    subscribePrelimMatches: (cb) => { subscriptions.prelim = cb; },
    subscribeFinalMatches: (division, cb) => {
      (subscriptions.final ||= {})[division] = cb;
    },
    subscribePublicSchedule: (cb) => {
      subscriptions.publicSchedule = cb;
      const stop = () => {};
      stop.retry = () => { subscriptions.publicScheduleRetry = true; };
      return stop;
    },
    evaluatePrelimMatch: options.realData ? evaluatePrelimMatch : () => ({ result: null, status: 'pending' }),
    computeGroupStandings: options.realData ? computeGroupStandings : () => [],
    publicMatchView: options.realData ? publicMatchView : (match) => match,
    renderBracket: (...args) => {
      if (options.clearBracketRender) args[0].replaceChildren();
      bracketRenders.push(args);
    },
    displayTeamName: (name) => name,
    getRingEdges,
    normalizeRingOrder: options.realData ? normalizeRingOrder : () => [],
    renderRingDiagram: (...args) => { ringRenders.push(args); },
    formatCourtName,
    projectPrelimCourtSchedule,
    getPrelimRingEdgeLabels,
  };
  Object.assign(window, context);
  const bridge = `
    globalThis.__dashboardTest = {
      snapshot(info, metadata = { fromCache: false, hasPendingWrites: false }) {
        subscriptions.tournament(info, metadata);
      },
      groups(data, metadata = { fromCache: false, hasPendingWrites: false }) {
        subscriptions.groups(data, metadata);
      },
      teams(data, metadata = { fromCache: false, hasPendingWrites: false }) {
        subscriptions.teams(data, metadata);
      },
      prelim(data, metadata = { fromCache: false, hasPendingWrites: false }) {
        subscriptions.prelim(data, metadata);
      },
      finals(division, data, metadata = { fromCache: false, hasPendingWrites: false }) {
        subscriptions.final[division](data, metadata);
      },
      publicSchedule(data, metadata = { fromCache: false, hasPendingWrites: false }) {
        subscriptions.publicSchedule(data, metadata);
      },
      clickDivision(division) {
        divisionButtons.find((button) => button.dataset.division === division).click();
      },
      clickTab(tab) {
        tabButtons.find((button) => button.dataset.tab === tab).click();
      },
      visibility(state) {
        document.visibilityState = state;
        document.dispatchEvent({ type: 'visibilitychange' });
      },
      state() {
        return {
          activeDivision,
          venueConfigKey,
          venueAutoStartedAt,
          venueAutoIntervalMs,
          timerCount: venueTimer === null ? 0 : 1,
          maintenanceActive,
          publicScheduleState,
          publicScheduleIsCached,
          venueHidden: document.getElementById('venueSwitcher').hidden,
          progressHidden: document.getElementById('venueProgressTrack').hidden,
          current: document.getElementById('venueCurrentDivision').textContent,
          next: document.getElementById('venueNextDivision').textContent,
          countdown: document.getElementById('venueCountdown').textContent,
          progress: document.getElementById('venueProgressBar').style.transform,
        };
      },
    };
  `;
  vm.runInNewContext(`${source}\n${bridge}`, context, { filename: 'dashboard.js' });
  if (options.initialConfirmed !== false) {
    context.__dashboardTest.snapshot({ maintenance: { enabled: false } });
  }
  return {
    state: () => context.__dashboardTest.state(),
    snapshot: (info, metadata) => context.__dashboardTest.snapshot(info, metadata),
    groups: (data, metadata) => context.__dashboardTest.groups(data, metadata),
    teams: (data, metadata) => context.__dashboardTest.teams(data, metadata),
    prelim: (data, metadata) => context.__dashboardTest.prelim(data, metadata),
    finals: (division, data, metadata) => context.__dashboardTest.finals(division, data, metadata),
    publicSchedule: (data, metadata) => context.__dashboardTest.publicSchedule(data, metadata),
    clickDivision: (division) => context.__dashboardTest.clickDivision(division),
    clickTab: (tab) => context.__dashboardTest.clickTab(tab),
    visibility: (state) => context.__dashboardTest.visibility(state),
    element: (id) => elements[id] || null,
    error(label, err = {}) {
      window.dispatchEvent({ type: 'firestore-error', detail: { label, err } });
    },
    ringRenders,
    bracketRenders,
    setFitGeometry,
    flushAnimationFrames() {
      const queued = [...animationFrames.values()];
      animationFrames.clear();
      queued.forEach((handler) => handler(now));
      return queued.length;
    },
    pendingAnimationFrames: () => animationFrames.size,
    animationFrameRequestCount: () => animationFrameRequestCount,
    triggerResize() {
      window.dispatchEvent({ type: 'resize' });
    },
    triggerResizeObserver() {
      resizeObservers.forEach((observer) => observer.callback([{ target: observer.target }]));
    },
    triggerFontReady() {
      fontReadyHandlers.splice(0).forEach((handler) => handler());
    },
    triggerFontLoadingDone() {
      (fontEventHandlers.get('loadingdone') || []).forEach((handler) => handler());
    },
    triggerFullscreenChange() {
      document.dispatchEvent({ type: 'fullscreenchange' });
    },
    advance(ms) {
      now += ms;
      intervals.forEach(({ handler }) => handler());
    },
    timerCount: () => intervals.size,
  };
}

const adminHtml = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const landingHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function readAudienceLink(source, id) {
  const anchor = source.match(new RegExp(`<a\\b[^>]*\\bid="${id}"[^>]*>[^<]*</a>`, 'm'))?.[0];
  assert.ok(anchor, `audience link exists: ${id}`);
  const href = anchor.match(/\bhref="([^"]+)"/)?.[1];
  assert.ok(href, `audience link has href: ${id}`);
  return {
    href: href.replace(/&amp;/g, '&'),
    label: anchor.match(/>([^<]*)<\/a>/)?.[1]?.trim() || '',
    title: anchor.match(/\btitle="([^"]+)"/)?.[1] || '',
  };
}

const primaryAudienceLinks = [
  { id: 'adminAudienceDashboardLink', ...readAudienceLink(adminHtml, 'adminAudienceDashboardLink') },
  { id: 'settingsAudienceDashboardLink', ...readAudienceLink(adminHtml, 'settingsAudienceDashboardLink') },
  { id: 'landingAudienceDashboardLink', ...readAudienceLink(landingHtml, 'landingAudienceDashboardLink') },
];
const dashboardBaseUrl = 'https://example.test/';
const primaryAudienceUrls = primaryAudienceLinks.map(({ href }) => new URL(href, dashboardBaseUrl));
check(
  'primary audience links share the saved venue URL',
  primaryAudienceLinks.every(({ href }) => href === 'dashboard.html?display=venue&tab=prelim')
    && new Set(primaryAudienceLinks.map(({ href }) => href)).size === 1,
);
check(
  'primary audience links use the consistent label and saved-settings title',
  primaryAudienceLinks.every(({ label, title }) => (
    label === '관객 대시보드 열기' && title.includes('저장된 경기장 송출 설정')
  )),
);

for (const [{ id }, url] of primaryAudienceLinks.map((link, index) => [link, primaryAudienceUrls[index]])) {
  const entry = createDashboardHarness(url.search);
  let entryState = entry.state();
  check(
    `${id} venue entry starts a 15-second rotation`,
    entryState.activeDivision === 'men'
      && entryState.timerCount === 1
      && entryState.countdown === '15초 후 전환',
  );
  entry.advance(14999);
  entryState = entry.state();
  check(
    `${id} venue entry holds the starting division at the 15-second boundary`,
    entryState.activeDivision === 'men' && entryState.countdown === '1초 후 전환',
  );
  entry.advance(1);
  entryState = entry.state();
  check(
    `${id} venue entry rotates at the 15-second boundary`,
    entryState.activeDivision === 'women' && entryState.countdown === '15초 후 전환',
  );
  entry.snapshot({ venueDisplay: { mode: 'women', intervalSeconds: 15 } });
  entryState = entry.state();
  check(
    `${id} venue entry honors a fixed saved division without a timer`,
    entryState.activeDivision === 'women' && entryState.timerCount === 0 && entryState.progressHidden,
  );
  entry.snapshot({ venueDisplay: { mode: 'auto', intervalSeconds: 20 } });
  entryState = entry.state();
  check(
    `${id} venue entry honors the configured auto interval`,
    entryState.activeDivision === 'women'
      && entryState.timerCount === 1
      && entryState.countdown === '20초 후 전환',
  );
  entry.advance(19999);
  check(
    `${id} configured interval keeps the current division until its boundary`,
    entry.state().activeDivision === 'women' && entry.state().countdown === '1초 후 전환',
  );
  entry.advance(1);
  check(
    `${id} configured interval rotates at its boundary`,
    entry.state().activeDivision === 'men' && entry.state().countdown === '20초 후 전환',
  );
}

const manualAudienceLink = readAudienceLink(adminHtml, 'manualAudienceDashboardLink');
const manualAudienceUrl = new URL(manualAudienceLink.href, dashboardBaseUrl);
check(
  'admin settings keeps a separate manual audience link',
  manualAudienceLink.href === 'dashboard.html' && manualAudienceUrl.pathname === '/dashboard.html',
);
const manualAudience = createDashboardHarness(manualAudienceUrl.search);
manualAudience.clickDivision('women');
const manualAudienceState = manualAudience.state();
check(
  'manual audience link keeps division selection without a venue timer',
  manualAudienceState.activeDivision === 'women'
    && manualAudienceState.timerCount === 0
    && manualAudienceState.venueHidden,
);

const venue = createDashboardHarness();
let venueState = venue.state();
check('venue auto starts without cycleStartedAt or server clock', venueState.activeDivision === 'men' && venueState.timerCount === 1 && venueState.countdown === '15초 후 전환');
venue.advance(14999);
venueState = venue.state();
check('15-second boundary keeps the starting division until the interval ends', venueState.activeDivision === 'men' && venueState.countdown === '1초 후 전환');
venue.advance(1);
venueState = venue.state();
check('15-second boundary switches to the next division', venueState.activeDivision === 'women' && venueState.countdown === '15초 후 전환');
const venueStart = venueState.venueAutoStartedAt;
venue.snapshot({ venueDisplay: { mode: 'auto', intervalSeconds: 15, cycleStartedAt: 1 } });
check('repeated snapshots do not restart monotonic rotation', venue.state().venueAutoStartedAt === venueStart);
check('auto mode exposes progress and current/next labels', !venue.state().progressHidden && venue.state().next === '다음: 남자부' && venue.state().progress.includes('scaleX'));
const intervalVenue = createDashboardHarness();
intervalVenue.advance(5000);
const intervalStart = intervalVenue.state().venueAutoStartedAt;
intervalVenue.snapshot({ venueDisplay: { mode: 'auto', intervalSeconds: 20 } });
check('changing the auto interval deliberately restarts the current division', intervalVenue.state().venueAutoStartedAt > intervalStart && intervalVenue.state().countdown === '20초 후 전환');
venue.snapshot({ venueDisplay: { mode: 'women', intervalSeconds: 15 } });
venueState = venue.state();
check('pinned mode stops rotation and hides progress', venueState.activeDivision === 'women' && venueState.timerCount === 0 && venueState.progressHidden);
venue.visibility('hidden');
venue.visibility('visible');
check('pinned mode keeps progress hidden across visibility changes', venue.state().progressHidden && venue.timerCount() === 0);
venue.snapshot({ venueDisplay: { mode: 'auto', intervalSeconds: 15 } });
venueState = venue.state();
check('pinned to auto starts the pinned division for a full interval', venueState.activeDivision === 'women' && venueState.countdown === '15초 후 전환' && venueState.timerCount === 1);
venue.advance(14999);
check('pinned to auto retains its starting division through the interval', venue.state().activeDivision === 'women');
venue.visibility('hidden');
const hiddenStart = venue.state().venueAutoStartedAt;
check('hidden venue screen has no dangling timer', venue.timerCount() === 0 && hiddenStart !== null);
venue.advance(15000);
check('hidden venue screen does not render stale timer callbacks', venue.state().activeDivision === 'women');
venue.visibility('visible');
check('visible resume catches up from monotonic elapsed', venue.state().activeDivision === 'men' && venue.timerCount() === 1);
venue.snapshot({ maintenance: { enabled: true }, venueDisplay: { mode: 'auto', intervalSeconds: 15 } });
venueState = venue.state();
check('maintenance pauses and hides venue rotation', venueState.maintenanceActive && venueState.timerCount === 0 && venueState.venueHidden);
venue.advance(15000);
venue.snapshot({ maintenance: { enabled: false }, venueDisplay: { mode: 'auto', intervalSeconds: 15 } });
venueState = venue.state();
check('maintenance resume restores auto progress', !venueState.maintenanceActive && venueState.timerCount === 1 && !venueState.venueHidden);
venue.error("대회정보 구독", { code: "permission-denied" });
check("terminated root listener pauses venue rotation", venue.timerCount() === 0);
venue.snapshot({ maintenance: { enabled: false } }, { fromCache: true, hasPendingWrites: false });
check("cached root cannot restart venue rotation after terminal failure", venue.timerCount() === 0);
venue.snapshot({ maintenance: { enabled: false }, venueDisplay: { mode: "auto", intervalSeconds: 15 } });
check("authoritative root recovery restores exactly one venue timer", venue.timerCount() === 1);

const viewer = createDashboardHarness('');
viewer.clickDivision('women');
const viewerState = viewer.state();
check('normal dashboard keeps manual division controls and no venue timer', viewerState.activeDivision === 'women' && viewerState.timerCount === 0 && viewerState.venueHidden);

function dashboardNodeText(node) {
  return [
    node.textContent || "",
    ...(node.children || []).map((child) => dashboardNodeText(child)),
  ].join(" ");
}

function dashboardNodes(node, predicate, result = []) {
  if (predicate(node)) result.push(node);
  (node.children || []).forEach((child) => dashboardNodes(child, predicate, result));
  return result;
}

const dashboardSchedule = createDashboardHarness("", { realData: true });
dashboardSchedule.snapshot({ maintenance: { enabled: false } });
dashboardSchedule.groups([
  { id: "gm", division: "men", name: "A조", matchMode: "ring", ringOrder: ["m1", "m2", "m3"] },
  { id: "gw", division: "women", name: "W조", matchMode: "ring", ringOrder: ["w1", "w2", "w3"] },
]);
dashboardSchedule.teams([
  { id: "m1", division: "men", groupId: "gm", name: "남자1" },
  { id: "m2", division: "men", groupId: "gm", name: "남자2" },
  { id: "m3", division: "men", groupId: "gm", name: "남자3" },
  { id: "w1", division: "women", groupId: "gw", name: "여자1" },
  { id: "w2", division: "women", groupId: "gw", name: "여자2" },
  { id: "w3", division: "women", groupId: "gw", name: "여자3" },
]);
dashboardSchedule.prelim([
  {
    id: "m1-m2", division: "men", groupId: "gm", round: 1, teamA: "m1", teamB: "m2",
    status: "done", officialRevision: 1, officialCurrent: true,
    sets: [{ a: 10, b: 5 }, { a: 10, b: 6 }], result: "A", winner: "A",
  },
  {
    id: "m2-m3", division: "men", groupId: "gm", round: 2, teamA: "m2", teamB: "m3",
    status: "done", officialRevision: 1, officialCurrent: true,
    sets: [{ a: 10, b: 8 }, { a: 8, b: 10 }], result: "draw",
  },
  {
    id: "m3-m1", division: "men", groupId: "gm", round: 3, teamA: "m3", teamB: "m1",
    status: "in_progress", sets: [{ a: 25, b: 0 }], result: "A", winner: "A",
    winnerTeam: { id: "m3", name: "남자3" }, setsWonA: 1, setsWonB: 0,
  },
  { id: "w1-w2", division: "women", groupId: "gw", round: 1, teamA: "w1", teamB: "w2", status: "pending" },
  { id: "w2-w3", division: "women", groupId: "gw", round: 2, teamA: "w2", teamB: "w3", status: "pending" },
  { id: "w3-w1", division: "women", groupId: "gw", round: 3, teamA: "w3", teamB: "w1", status: "pending" },
]);
dashboardSchedule.publicSchedule(null);
check(
  "dashboard public schedule bootstrap remains pending instead of unassigned",
  dashboardSchedule.state().publicScheduleState === "loading"
    && dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("순서 확인 중")
    && !dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("미배정"),
);
const savedPublicSchedule = {
  status: "ready",
  courts: [{ id: "court-a", name: "A" }],
  assignments: [
    { matchKey: "m1-m2", matchType: "prelim", courtId: "court-a", courtOrder: 5 },
    { matchKey: "m2-m3", matchType: "prelim", courtId: "court-a", courtOrder: 3 },
    { matchKey: "m3-m1", matchType: "prelim", courtId: "court-a", courtOrder: 1 },
    { matchKey: "w1-w2", matchType: "prelim", courtId: "court-a", courtOrder: 2 },
    { matchKey: "w2-w3", matchType: "prelim", courtId: "court-a", courtOrder: 4 },
    { matchKey: "w3-w1", matchType: "prelim", courtId: "court-a", courtOrder: 6 },
    { matchKey: "final:women:f1", matchType: "final", courtId: "court-a", courtOrder: 7 },
  ],
};
dashboardSchedule.publicSchedule(savedPublicSchedule);
let dashboardRows = dashboardNodes(
  dashboardSchedule.element("dashPrelim"),
  (node) => String(node.className || "").includes("dashboard-prelim-match-row"),
);
check(
  "saved public schedule reorders men rows by absolute court slots",
  dashboardRows.slice(0, 3).map((row) => row.dataset.prelimMatchId).join(",") === "m3-m1,m2-m3,m1-m2"
    && dashboardRows.slice(0, 3).map((row) => row.dataset.prelimCourtOrder).join(",") === "1,3,5",
);
check(
  "spectator prelim does not render ring diagrams",
  dashboardSchedule.ringRenders.length === 0
    && !dashboardNodes(
      dashboardSchedule.element("dashPrelim"),
      (node) => /\bring-/.test(String(node.className || "")),
    ).length,
);
check(
  "approved preliminary win and draw show both set scores and results",
  dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("10:5 / 10:6")
    && dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("남자1 승")
    && dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("10:8 / 8:10")
    && dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("무승부"),
);
check(
  "approved-only score boundary remains intact in dashboard rows",
  !dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("25:0")
    && !dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("남자3 승"),
);
dashboardSchedule.clickDivision("women");
dashboardRows = dashboardNodes(
  dashboardSchedule.element("dashPrelim"),
  (node) => String(node.className || "").includes("dashboard-prelim-match-row"),
);
check(
  "saved public schedule keeps women absolute slots without ring diagrams",
  dashboardRows.slice(0, 3).map((row) => row.dataset.prelimCourtOrder).join(",") === "2,4,6"
    && dashboardSchedule.ringRenders.length === 0,
);
dashboardSchedule.publicSchedule({
  status: "unavailable",
  courts: [],
  assignments: [],
});
check(
  "unavailable public schedule never fabricates execution ordering",
  dashboardSchedule.state().publicScheduleState === "unavailable"
    && dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("순서 사용 불가")
    && !dashboardNodes(
      dashboardSchedule.element("dashPrelim"),
      (node) => String(node.className || "").includes("prelim-execution-label"),
    ).length,
);
dashboardSchedule.error("공개 경기 일정 구독", { code: "permission-denied" });
check(
  "public schedule errors are explicit and retryable without fake unassigned rows",
  dashboardSchedule.state().publicScheduleState === "error"
    && dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("순서 연결 오류")
    && !dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("미배정"),
);
dashboardSchedule.publicSchedule(savedPublicSchedule, { fromCache: true, hasPendingWrites: false });
check(
  "cached ready schedule is marked as cache rather than freshly confirmed",
  dashboardSchedule.state().publicScheduleIsCached
    && dashboardNodeText(dashboardSchedule.element("dashPrelim")).includes("오프라인 캐시"),
);
dashboardSchedule.snapshot({ maintenance: { enabled: true } });
check(
  "root maintenance hides public schedule and live content",
  dashboardSchedule.state().maintenanceActive
    && dashboardSchedule.element("dashboardLiveContent").hidden
    && dashboardSchedule.element("dashPrelim").children.length === 0,
);

const dashboardRecovery = createDashboardHarness("", { clearBracketRender: true, initialConfirmed: false });
check(
  "spectator results stay hidden before authoritative tournament confirmation",
  dashboardRecovery.element("dashboardLiveContent").hidden,
);
dashboardRecovery.snapshot({ maintenance: { enabled: false } });
check(
  "authoritative tournament confirmation enables spectator results",
  !dashboardRecovery.element("dashboardLiveContent").hidden,
);
dashboardRecovery.snapshot({ maintenance: { enabled: false } }, { fromCache: true, hasPendingWrites: false });
check(
  "ordinary offline cache keeps last confirmed spectator results visible",
  !dashboardRecovery.element("dashboardLiveContent").hidden,
);
dashboardRecovery.error("대회정보 구독", { code: "permission-denied" });
check(
  "terminal tournament subscription failure hides potentially stale official results",
  dashboardRecovery.element("dashboardLiveContent").hidden
    && !dashboardRecovery.element("maintenanceNotice").hidden,
);
dashboardRecovery.snapshot({ maintenance: { enabled: false } }, { fromCache: true, hasPendingWrites: false });
check(
  "cached root snapshot cannot reopen a terminally disconnected spectator view",
  dashboardRecovery.element("dashboardLiveContent").hidden,
);
dashboardRecovery.snapshot({ maintenance: { enabled: true } });
check(
  "recovered maintenance snapshot keeps spectator results hidden",
  dashboardRecovery.state().maintenanceActive
    && dashboardRecovery.element("dashboardLiveContent").hidden,
);
dashboardRecovery.snapshot({ maintenance: { enabled: false } });
check(
  "recovered authoritative open state restores spectator results",
  !dashboardRecovery.element("dashboardLiveContent").hidden,
);
check(
  "no qualification warning is shown before a final bracket exists",
  !dashboardNodeText(dashboardRecovery.element("dashBracketContainer")).includes("재확인"),
);
dashboardRecovery.finals("men", [{ id: "final-fixture", round: 1, status: "pending" }]);
check(
  "unverified existing final bracket is prominently marked as the previous publication",
  dashboardRecovery.element("dashBracketContainer").children[0]?.className === "qualification-stale-notice"
    && dashboardNodeText(dashboardRecovery.element("dashBracketContainer")).includes("이전 공개 대진"),
);
dashboardRecovery.snapshot({
  maintenance: { enabled: false },
  finalQualification: { men: { status: "current" } },
});
check(
  "verified current qualification removes the spectator warning",
  !dashboardNodeText(dashboardRecovery.element("dashBracketContainer")).includes("재확인"),
);
dashboardRecovery.snapshot({
  maintenance: { enabled: false },
  finalQualification: { men: { status: "stale" } },
});
check(
  "preliminary correction reintroduces the previous-publication warning",
  dashboardNodeText(dashboardRecovery.element("dashBracketContainer")).includes("이전 공개 대진"),
);

// ---- dashboard viewport fitting ----
function fitRect(left, top, width, height, extra = {}) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    ...extra,
  };
}

function dashboardFitSnapshot(harness) {
  const transform = String(harness.element("dashboardStage").style.transform || "");
  const match = transform.match(/^translate\(([-+.0-9eE]+)px,\s*([-+.0-9eE]+)px\)\s+scale\(([-+.0-9eE]+)\)$/);
  if (!match) return null;
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    scale: Number(match[3]),
    width: Number.parseFloat(harness.element("dashboardStage").style.width),
    height: Number.parseFloat(harness.element("dashboardStage").style.height),
  };
}

const dashboardFitCases = [
  [1920, 1080],
  [1366, 768],
  [1280, 720],
  [390, 844],
];
for (const division of ["men", "women"]) {
  for (const tab of ["prelim", "final"]) {
    for (const [viewportWidth, viewportHeight] of dashboardFitCases) {
      const naturalWidth = tab === "prelim" ? 1600 : 1800;
      const naturalHeight = tab === "prelim" ? 900 : 1000;
      const descendants = tab === "prelim"
        ? [
          fitRect(0, 0, naturalWidth, naturalHeight),
          fitRect(naturalWidth - 480, 80, 460, naturalHeight - 120),
          fitRect(0, 0, 1, 1, { hidden: true, right: 99999, bottom: 99999 }),
        ]
        : [
          fitRect(-24, -18, naturalWidth + 24, naturalHeight + 18),
          fitRect(naturalWidth - 240, naturalHeight - 180, 230, 170),
        ];
      const fitHarness = createDashboardHarness(
        `?display=venue&division=${division}&tab=${tab}`,
      );
      fitHarness.setFitGeometry({
        viewportWidth,
        viewportHeight,
        stageWidth: naturalWidth,
        stageHeight: naturalHeight,
        descendants,
      });
      fitHarness.flushAnimationFrames();
      const snapshot = dashboardFitSnapshot(fitHarness);
      const visible = descendants.filter((item) => !item.hidden);
      const contentLeft = Math.min(...visible.map((item) => item.left));
      const contentTop = Math.min(...visible.map((item) => item.top));
      const contentRight = Math.max(...visible.map((item) => item.right));
      const contentBottom = Math.max(...visible.map((item) => item.bottom));
      const screenLeft = snapshot ? snapshot.left + contentLeft * snapshot.scale : NaN;
      const screenTop = snapshot ? snapshot.top + contentTop * snapshot.scale : NaN;
      const screenRight = snapshot ? snapshot.left + contentRight * snapshot.scale : NaN;
      const screenBottom = snapshot ? snapshot.top + contentBottom * snapshot.scale : NaN;
      const label = `${division} ${tab} ${viewportWidth}x${viewportHeight}`;
      check(`${label} computes a finite uniform fit transform`, Boolean(snapshot)
        && [snapshot.left, snapshot.top, snapshot.scale, snapshot.width, snapshot.height].every(Number.isFinite)
        && snapshot.scale > 0
        && snapshot.scale <= 1 + 1e-9);
      check(`${label} keeps standings/results/bracket content inside the viewport`, Boolean(snapshot)
        && screenLeft >= -0.5
        && screenTop >= -0.5
        && screenRight <= viewportWidth + 0.5
        && screenBottom <= viewportHeight + 0.5);
      check(`${label} activates the requested tab without moving the venue counter into stage`,
        fitHarness.element(`tab-${tab}`).classList.contains("active")
          && fitHarness.element("venueSwitcher").parentNode === fitHarness.element("dashboardShell")
          && !fitHarness.element("dashboardStage").children.includes(fitHarness.element("venueSwitcher")));
    }
  }
}

const compactPrelimFit = createDashboardHarness("?display=venue&division=men&tab=prelim");
compactPrelimFit.setFitGeometry({
  viewportWidth: 1530,
  viewportHeight: 596,
  stageWidth: 1530,
  stageHeight: 636,
  compactStageHeight: 584,
  descendants: [
    fitRect(0, 0, 1530, 636, { compactHeight: 584 }),
    fitRect(0, 0, 1, 1, { hidden: true, right: 99999, bottom: 99999 }),
  ],
});
compactPrelimFit.flushAnimationFrames();
let compactSnapshot = dashboardFitSnapshot(compactPrelimFit);
check(
  "prelim uses compact density before uniform scaling when full-height content is too tall",
  compactPrelimFit.element("dashPrelim").classList.contains("dashboard-prelim-compact")
    && compactSnapshot?.scale === 1
    && compactSnapshot?.width >= 1530
    && compactSnapshot?.height <= 596,
);
check(
  "compact prelim keeps visible content inside the viewport without hiding it",
  compactSnapshot?.scale === 1
    && compactSnapshot?.height <= compactPrelimFit.element("dashboardViewport").clientHeight
    && !compactPrelimFit.element("dashPrelim").hidden,
);
compactPrelimFit.clickTab("final");
compactPrelimFit.flushAnimationFrames();
check(
  "switching to finals resets preliminary compact density",
  !compactPrelimFit.element("dashPrelim").classList.contains("dashboard-prelim-compact"),
);
compactPrelimFit.clickTab("prelim");
compactPrelimFit.flushAnimationFrames();
compactPrelimFit.setFitGeometry({ viewportHeight: 680, compactStageHeight: 636 });
compactPrelimFit.triggerResize();
compactPrelimFit.flushAnimationFrames();
compactSnapshot = dashboardFitSnapshot(compactPrelimFit);
check(
  "resizing a fitting prelim viewport back to normal height clears compact density",
  !compactPrelimFit.element("dashPrelim").classList.contains("dashboard-prelim-compact")
    && compactSnapshot?.scale === 1,
);

const coalescedFit = createDashboardHarness("?display=venue&division=men&tab=prelim");
coalescedFit.setFitGeometry({
  viewportWidth: 1366,
  viewportHeight: 768,
  stageWidth: 1800,
  stageHeight: 1000,
  descendants: [fitRect(0, 0, 1800, 1000)],
});
coalescedFit.flushAnimationFrames();
const coalescedBefore = coalescedFit.animationFrameRequestCount();
coalescedFit.setFitGeometry({ viewportWidth: 1280, viewportHeight: 720 });
coalescedFit.triggerResize();
coalescedFit.triggerResize();
coalescedFit.triggerResizeObserver();
coalescedFit.triggerFontLoadingDone();
coalescedFit.triggerFontReady();
coalescedFit.clickDivision("women");
coalescedFit.clickTab("final");
check(
  "division/tab/resize/font updates coalesce into one pending fit frame",
  coalescedFit.pendingAnimationFrames() === 1,
);
check(
  "coalesced viewport fitting does not create a second venue rotation timer",
  coalescedFit.timerCount() === 1,
);
coalescedFit.flushAnimationFrames();
check(
  "coalesced viewport fitting requests exactly one frame",
  coalescedFit.animationFrameRequestCount() === coalescedBefore + 1
    && coalescedFit.pendingAnimationFrames() === 0,
);

const emptyFit = createDashboardHarness("?display=venue&division=men&tab=prelim");
emptyFit.setFitGeometry({
  viewportWidth: 0,
  viewportHeight: 0,
  stageWidth: 0,
  stageHeight: 0,
  descendants: [fitRect(0, 0, 2000, 2000)],
});
emptyFit.flushAnimationFrames();
check(
  "empty/hidden viewport dimensions skip fitting without NaN or a frame loop",
  !String(emptyFit.element("dashboardStage").style.transform || "").includes("NaN")
    && emptyFit.pendingAnimationFrames() === 0,
);
emptyFit.setFitGeometry({
  viewportWidth: 390,
  viewportHeight: 844,
  stageWidth: 0,
  stageHeight: 0,
  descendants: [],
});
emptyFit.triggerResize();
emptyFit.flushAnimationFrames();
check(
  "empty content receives a finite non-upscaled fallback fit",
  !String(emptyFit.element("dashboardStage").style.transform || "").includes("NaN")
    && (dashboardFitSnapshot(emptyFit)?.scale ?? 0) <= 1,
);
const emptyFitRequests = emptyFit.animationFrameRequestCount();
emptyFit.snapshot({ maintenance: { enabled: true } });
check(
  "maintenance/content hiding schedules one bounded refit",
  emptyFit.pendingAnimationFrames() === 1,
);
emptyFit.flushAnimationFrames();
check(
  "maintenance/content hiding settles without repeated fit requests",
  emptyFit.pendingAnimationFrames() === 0
    && emptyFit.animationFrameRequestCount() === emptyFitRequests + 1,
);

const rotationFit = createDashboardHarness("?display=venue&division=men&tab=prelim");
rotationFit.setFitGeometry({
  viewportWidth: 1366,
  viewportHeight: 768,
  stageWidth: 1800,
  stageHeight: 1000,
  descendants: [fitRect(0, 0, 1800, 1000)],
});
rotationFit.flushAnimationFrames();
rotationFit.advance(14999);
check(
  "viewport fitting leaves the 15-second venue rotation on its starting division",
  rotationFit.state().activeDivision === "men" && rotationFit.timerCount() === 1,
);
rotationFit.triggerResize();
rotationFit.triggerResize();
check(
  "rotation resize coalesces without multiplying timers",
  rotationFit.pendingAnimationFrames() === 1 && rotationFit.timerCount() === 1,
);
rotationFit.flushAnimationFrames();
rotationFit.advance(1);
check(
  "viewport fitting does not disrupt the 15-second division boundary",
  rotationFit.state().activeDivision === "women" && rotationFit.timerCount() === 1,
);

// ---- admin preliminary projection UI ----
const adminStyleSource = fs.readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
check(
  "preliminary rows use two logical desktop columns after badge removal",
  adminStyleSource.includes(
    ".prelim-match-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto;",
  ),
);
check(
  "preliminary rows collapse to one usable column on mobile",
  adminStyleSource.includes(
    "@media (max-width: 640px) {\n  .prelim-match-row {\n    grid-template-columns: minmax(0, 1fr);",
  )
    && adminStyleSource.includes(
      ".prelim-court-control {\n    grid-column: 1 / -1;\n    grid-template-columns: auto minmax(0, 1fr);",
    ),
);
function createAdminProjectionHarness() {
  const elements = new Map();
  const listeners = new Map();
  const toDatasetKey = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const classNames = (element) => String(element.className || "").split(/\s+/).filter(Boolean);

  class FakeElement {
    constructor(tagName = "div") {
      this.tagName = String(tagName).toUpperCase();
      this.nodeName = this.tagName;
      this.children = [];
      this.parentNode = null;
      this.parentElement = null;
      this.dataset = {};
      this.style = {};
      this.className = "";
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.checked = false;
      this.open = false;
      this.type = "";
      this.textContent = "";
      this._innerHTML = "";
      this.eventHandlers = {};
      this.attributes = {};
      this.ownerDocument = null;
      this.classList = {
        add: (...names) => {
          const merged = new Set(classNames(this));
          names.forEach((name) => merged.add(name));
          this.className = [...merged].join(" ");
        },
        remove: (...names) => {
          const removed = new Set(names);
          this.className = classNames(this).filter((name) => !removed.has(name)).join(" ");
        },
        contains: (name) => classNames(this).includes(name),
        toggle: (name, force) => {
          const next = force === undefined ? !this.classList.contains(name) : Boolean(force);
          if (next) this.classList.add(name);
          else this.classList.remove(name);
          return next;
        },
      };
    }

    get textContent() {
      return this._textContent + this.children.map((child) => child.textContent).join("");
    }

    set textContent(value) {
      this._textContent = String(value ?? "");
      this.replaceChildren();
    }

    get innerHTML() {
      return this._innerHTML;
    }

    set innerHTML(value) {
      this._innerHTML = String(value ?? "");
      if (this._innerHTML === "") this.replaceChildren();
    }

    get options() {
      return this.children;
    }

    get selectedIndex() {
      const index = this.children.findIndex((child) => child.selected);
      return index < 0 ? 0 : index;
    }

    set selectedIndex(index) {
      this.children.forEach((child, childIndex) => { child.selected = childIndex === index; });
    }

    appendChild(child) {
      if (!child || typeof child !== "object") return child;
      if (child.parentNode) child.parentNode.removeChild(child);
      this.children.push(child);
      child.parentNode = this;
      child.parentElement = this;
      return child;
    }

    insertBefore(child, reference) {
      if (reference == null) return this.appendChild(child);
      assert.ok(this.children.includes(reference), "insertBefore reference belongs to parent");
      if (child === reference) return child;
      child.parentNode?.removeChild(child);
      this.children.splice(this.children.indexOf(reference), 0, child);
      child.parentNode = this;
      child.parentElement = this;
      return child;
    }

    append(...children) {
      children.flat().forEach((child) => {
        if (child && typeof child === "object") this.appendChild(child);
      });
    }

    prepend(...children) {
      const nodes = children.flat().filter((child) => child && typeof child === "object");
      nodes.reverse().forEach((child) => {
        if (child.parentNode) child.parentNode.removeChild(child);
        this.children.unshift(child);
        child.parentNode = this;
        child.parentElement = this;
      });
    }

    replaceChildren(...children) {
      this.children.forEach((child) => {
        child.parentNode = null;
        child.parentElement = null;
      });
      this.children = [];
      this.append(...children);
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index < 0) return child;
      this.children.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    }

    remove() {
      this.parentNode?.removeChild(this);
    }

    after(child) {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index < 0) return;
      if (child.parentNode) child.parentNode.removeChild(child);
      this.parentNode.children.splice(index + 1, 0, child);
      child.parentNode = this.parentNode;
      child.parentElement = this.parentNode;
    }

    addEventListener(name, handler) {
      (this.eventHandlers[name] ||= []).push(handler);
    }

    click() {
      (this.eventHandlers.click || []).forEach((handler) => handler({ currentTarget: this, target: this }));
    }

    focus() {
      document.activeElement = this;
    }

    select() {}

    scrollIntoView() {}

    setAttribute(name, value) {
      const text = String(value);
      this.attributes[name] = text;
      if (name === "class") this.className = text;
      else if (name.startsWith("data-")) this.dataset[toDatasetKey(name.slice(5))] = text;
      else this[name] = text;
    }

    getAttribute(name) {
      if (name.startsWith("data-")) return this.dataset[toDatasetKey(name.slice(5))] ?? null;
      return this.attributes[name] ?? (this[name] === undefined ? null : String(this[name]));
    }

    removeAttribute(name) {
      delete this.attributes[name];
      if (name.startsWith("data-")) delete this.dataset[toDatasetKey(name.slice(5))];
      else delete this[name];
    }

    matches(selector) {
      return matchesSimple(this, selector);
    }

    closest(selector) {
      let current = this;
      while (current) {
        if (matchesSimple(current, selector)) return current;
        current = current.parentNode;
      }
      return null;
    }

    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    }

    querySelectorAll(selector) {
      return selectWithin(this, selector);
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  function readAttribute(element, name) {
    if (name.startsWith("data-")) return element.dataset[toDatasetKey(name.slice(5))];
    if (name === "class") return element.className;
    return element[name] ?? element.attributes[name];
  }

  function matchesSimple(element, selector) {
    const source = String(selector || "").trim();
    if (!source || source.includes(" ") || source.includes(":")) return false;
    if (source === "*") return true;
    const idMatch = source.match(/^#([A-Za-z0-9_-]+)/);
    if (idMatch && element.id !== idMatch[1]) return false;
    const tagMatch = source.match(/^[A-Za-z][A-Za-z0-9-]*/);
    if (tagMatch && element.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    const classes = [...source.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
    if (classes.some((name) => !classNames(element).includes(name))) return false;
    const attributes = [...source.matchAll(/\[([^=\]]+)(?:=(["']?)([^"'\]]*)\2)?\]/g)];
    return attributes.every(([, name, , expected]) => {
      const actual = readAttribute(element, name);
      return expected === undefined ? actual !== undefined : String(actual ?? "") === expected;
    });
  }

  function descendants(root) {
    const result = [];
    root.children.forEach((child) => {
      result.push(child, ...descendants(child));
    });
    return result;
  }

  function hasMatchingAncestor(node, selector, root) {
    let current = node.parentNode;
    while (current && current !== root) {
      if (matchesSimple(current, selector)) return true;
      current = current.parentNode;
    }
    return current === root && matchesSimple(current, selector);
  }

  function selectWithin(root, selector) {
    const source = String(selector || "").trim();
    const directPrefix = ":scope > ";
    if (source.startsWith(directPrefix)) {
      const directSelector = source.slice(directPrefix.length).trim();
      return root.children.filter((child) => matchesSimple(child, directSelector));
    }
    const parts = source.split(/\s+/);
    if (parts.length > 1) {
      const finalSelector = parts.pop();
      const ancestorSelector = parts.join(" ");
      return descendants(root).filter((node) => (
        matchesSimple(node, finalSelector) && hasMatchingAncestor(node, ancestorSelector, root)
      ));
    }
    return descendants(root).filter((node) => matchesSimple(node, source));
  }

  let document;
  function element(tagName = "div") {
    const created = new FakeElement(tagName);
    created.ownerDocument = document;
    return created;
  }

  const body = element("body");
  body.id = "body";
  document = {
    body,
    activeElement: body,
    visibilityState: "visible",
    createElement: element,
    createElementNS: (_, tagName) => element(tagName),
    createTextNode: (text) => {
      const node = element("span");
      node.textContent = String(text);
      return node;
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const created = element("div");
        created.id = id;
        elements.set(id, created);
      }
      return elements.get(id);
    },
    querySelectorAll(selector) {
      return selectWithin(body, selector);
    },
    querySelector(selector) {
      return document.querySelectorAll(selector)[0] || null;
    },
    addEventListener(name, handler) {
      (listeners.get(name) || (listeners.set(name, []), listeners.get(name))).push(handler);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach((handler) => handler(event));
    },
  };
  body.ownerDocument = document;
  ["prelimSetupGroups", "prelimGroups", "courtSettingsList", "allCourtBoard"].forEach((id) => {
    body.appendChild(document.getElementById(id));
  });
  for (const [id, tag] of [
    ["recorderGrantStatus", "div"],
    ["recorderGrantList", "div"],
    ["recorderGrantHistory", "details"],
    ["recorderGrantHistorySummary", "summary"],
    ["recorderGrantHistoryList", "div"],
    ["recorderGrantHistoryMoreBtn", "button"],
  ]) {
    assert.match(adminHtml, new RegExp(`<${tag}\\b[^>]*\\bid="${id}"`));
    const node = element(tag);
    node.id = id;
    elements.set(id, node);
  }
  body.append(
    document.getElementById("recorderGrantStatus"),
    document.getElementById("recorderGrantList"),
    document.getElementById("recorderGrantHistory"),
  );
  document.getElementById("recorderGrantHistory").append(
    document.getElementById("recorderGrantHistorySummary"),
    document.getElementById("recorderGrantHistoryList"),
    document.getElementById("recorderGrantHistoryMoreBtn"),
  );

  function Option(text, value) {
    const option = element("option");
    option.textContent = String(text);
    option.value = value;
    return option;
  }

  const windowListeners = new Map();
  const window = {
    location: { search: "", pathname: "/admin.html" },
    addEventListener(name, handler) {
      (windowListeners.get(name) || (windowListeners.set(name, []), windowListeners.get(name))).push(handler);
    },
    dispatchEvent(event) {
      (windowListeners.get(event.type) || []).forEach((handler) => handler(event));
    },
  };
  const storage = {
    values: new Map(),
    getItem(key) { return this.values.get(key) || null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); },
  };
  let adminWorkflowCallableImpl = async () => ({});
  let lastConfirmMessage = "";
  const renderRingDiagramForTest = (container, opts = {}) => {
    container.replaceChildren();
    const labels = Array.isArray(opts.edgeLabels) ? opts.edgeLabels : [];
    getRingEdges(Array.isArray(opts.ringOrder) ? opts.ringOrder.length : 0).forEach((_, index) => {
      const label = element("div");
      label.className = "ring-edge-label";
      label.dataset.ringEdgeIndex = String(index);
      label.textContent = labels[index]?.text ?? String(index + 1);
      label.title = labels[index]?.title ?? `${index + 1}경기`;
      container.appendChild(label);
    });
  };
  const context = {
    window,
    document,
    Map,
    Option,
    URLSearchParams,
    sessionStorage: storage,
    localStorage: storage,
    crypto: { randomUUID: () => "test-uuid-00000000" },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    isFirebaseConfigured: true,
    db: {},
    collection: () => ({}),
    doc: () => ({}),
    getDoc: async () => ({ exists: () => false }),
    getDocs: async () => ({ docs: [] }),
    onSnapshot: () => () => {},
    serverTimestamp: () => "server-timestamp",
    updateDoc: async () => {},
    watchAuthState: () => () => {},
    login: async () => {},
    logout: async () => {},
    requestPasswordReset: async () => {},
    changePassword: async () => {},
    describeAuthError: () => "",
    saveTournamentInfo: async () => {},
    subscribeTournamentInfo: () => () => {},
    addGroup: async () => {},
    renameGroup: async () => {},
    reorderGroups: async () => {},
    subscribeGroups: () => () => {},
    addTeam: async () => {},
    moveAndReorderTeam: async () => {},
    subscribeTeams: () => () => {},
    mutatePrelimStructure: async () => {},
    subscribePrelimMatches: () => () => {},
    reorderPrelimMatches: async () => {},
    setGroupMatchMode: async () => {},
    setGroupRingOrder: async () => {},
    publishFinalBracket: async () => {},
    subscribeFinalMatches: () => () => {},
    exportAllData: async () => {},
    importAllData: async () => {},
    evaluatePrelimMatch: () => ({ result: null, status: "pending" }),
    evaluateFinalMatch: () => ({ result: null, status: "pending" }),
    computeGroupStandings: () => [],
    computeAutomaticQualifiers: () => [],
    buildQualificationSnapshot,
    computeQualificationState,
    validateQualificationSelection,
    validateSetScore: () => ({ ok: true }),
    buildCrossGroupSeedOrder: () => [],
    swapFinalSeedSlots: () => ({ ok: true }),
    confirmBye: () => ({ ok: true }),
    placeByeTeam: () => ({ ok: true }),
    generateBracket: () => ({ matches: [] }),
    recordMatchResult: () => {},
    invalidateDescendantResults: () => [],
    renderBracket: () => {},
    buildFullResultsCsv: () => "",
    downloadCsv: () => {},
    normalizeRingOrder,
    renderRingDiagram: renderRingDiagramForTest,
    orderExistingRoundRobinMatchIds: () => [],
    adminWorkflowCallable: (...args) => adminWorkflowCallableImpl(...args),
    __setAdminWorkflowCallable: (fn) => {
      adminWorkflowCallableImpl = fn;
    },
    __getConfirmMessage: () => lastConfirmMessage,
    getPlannerVisibleAdjacent,
    isPlannerMatchCompleted,
    movePlannerAssignment,
    movePlannerMatchByOffset,
    plannerPhaseMatches,
    reconcilePlannerAssignments: (assignments) => assignments,
    groupPlannerAssignments,
    swapPlannerCourts,
    correctionConfirmationState: () => ({}),
    correctionSelectionInfo: () => ({}),
    correctionSelectionKeys: (selection) => selection,
    correctionSelectionMatches: () => false,
    eligibleCorrectionCandidates: () => [],
    isCorrectionCandidateEligible: () => false,
    upgradeLegacyBackup: () => ({}),
    courtMatchSummary,
    renderMatchMeta,
    courtTeamNames,
    formatCourtName,
    normalizeCourtName,
    getPrelimRingEdgeLabels,
    projectPrelimCourtSchedule,
    TOURNAMENT_ID: "test",
    confirm: (message) => {
      lastConfirmMessage = String(message || "");
      return true;
    },
    alert: () => {},
    prompt: () => "",
  };
  Object.assign(window, context);
  const sourcePath = new URL("./admin.js", import.meta.url);
  const rawSource = fs.readFileSync(sourcePath, "utf8");
  const bootstrapMarker = "// ---------------- 부트스트랩 ----------------";
  const bootstrapStart = rawSource.indexOf(bootstrapMarker);
  const bootstrapEnd = rawSource.indexOf("// ---------------- 연결 상태 감시 ----------------", bootstrapStart);
  assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart, "admin bootstrap boundaries exist");
  const source = (rawSource.slice(0, bootstrapStart) + rawSource.slice(bootstrapEnd))
    .replace(/^import[\s\S]*?;\s*/gm, "");
  const bridge = `
    const originalRenderCourtBoard = renderCourtBoard;
    const originalRenderCourtSettings = renderCourtSettings;
    renderGroupList = () => {};
    renderTeamGroupSelect = () => {};
    renderGroupTeamLists = () => {};
    renderFinalTeamPicker = () => {};
    renderScoreReviews = () => {};
    updatePrelimMutationGuardUi = () => {};
    renderCourtSettings = () => {};
    renderCourtBoard = () => {};
    syncPrelimCourtSelects = () => {};
    syncPrelimCourtBadges = () => {};
    syncWorkflowSaveControls = () => {};
    syncWorkflowPhaseFilter = () => {};
    buildRoundRobinControls = () => document.createElement("div");
    buildRingControls = (group, groupTeams) => {
      const host = document.createElement("div");
      const ringOrder = normalizeRingOrder(group.ringOrder, groupTeams.map((team) => team.id));
      renderRingDiagram(host, {
        ringOrder,
        edgeLabels: getPrelimRingEdgeLabels(ringOrder, prelimCourtSchedule()),
      });
      return host;
    };
    let preservedScoreInput = null;
    let preservedScoreRow = null;
    const projectionFixture = {
      groups: [{
        id: "group-a", division: "men", name: "A조", matchMode: "ring",
        ringOrder: ["team-a", "team-b", "team-c"],
      }],
      teams: [
        { id: "team-a", division: "men", groupId: "group-a", name: "A팀" },
        { id: "team-b", division: "men", groupId: "group-a", name: "B팀" },
        { id: "team-c", division: "men", groupId: "group-a", name: "C팀" },
      ],
      matches: [
        { id: "match-ab", division: "men", groupId: "group-a", round: 1, teamA: "team-a", teamB: "team-b", sets: [] },
        { id: "match-bc", division: "men", groupId: "group-a", round: 2, teamA: "team-b", teamB: "team-c", sets: [] },
        { id: "match-ca", division: "men", groupId: "group-a", round: 3, teamA: "team-c", teamB: "team-a", sets: [] },
      ],
      assignments: [
        { matchKey: "match-ab", matchType: "prelim", courtId: "court-a", courtOrder: 5 },
        { matchKey: "match-bc", matchType: "prelim", courtId: "court-a", courtOrder: 3 },
        { matchKey: "match-ca", matchType: "prelim", courtId: "court-a", courtOrder: 1 },
      ],
      courts: [{ id: "court-a", name: "A" }],
    };
    function projectionRows(rootId) {
      const root = document.getElementById(rootId);
      const lanes = root.querySelector("[data-prelim-court-lanes='group-a']");
      const list = lanes?.querySelector("[data-prelim-court-lane-list='court-a']");
      return list ? [...list.children] : [];
    }
    function projectionRingLabels(rootId) {
      return [...document.getElementById(rootId).querySelectorAll(".ring-edge-label")]
        .map((label) => ({ text: label.textContent, title: label.title }));
    }
    function projectionState() {
      const setupRows = projectionRows("prelimSetupGroups");
      const scoreRows = projectionRows("prelimGroups");
      const setupHint = document.getElementById("prelimSetupGroups")
        .querySelector(":scope > [data-prelim-workflow-hint]");
      const scoreHint = document.getElementById("prelimGroups")
        .querySelector(":scope > [data-prelim-workflow-hint]");
      return {
        setupIds: setupRows.map((row) => row.dataset.prelimMatchRow),
        scoreIds: scoreRows.map((row) => row.dataset.prelimMatchRow),
        setupRowChildren: setupRows[0]?.children.map((child) => child.className) || [],
        setupCourtControlChildren: setupRows[0]?.children[1]?.children.map((child) => child.tagName) || [],
        setupExecution: setupRows.map((row) => [...row.querySelector("[data-prelim-execution-label]").children]
          .map((badge) => badge.textContent).join("|")),
        scoreExecution: scoreRows.map((row) => [...row.querySelector("[data-prelim-execution-label]").children]
          .map((badge) => badge.textContent).join("|")),
        setupRing: projectionRingLabels("prelimSetupGroups"),
        scoreRing: projectionRingLabels("prelimGroups"),
        dirty: workflowDirty,
        setupHintVisible: setupHint ? !setupHint.hidden : false,
        scoreHintVisible: scoreHint ? !scoreHint.hidden : false,
        hintText: setupHint?.textContent || "",
        scoreInputPreserved: Boolean(
          preservedScoreRow
            && preservedScoreRow.querySelector("input") === preservedScoreInput,
        ),
        scoreRowPreserved: projectionRows("prelimGroups").includes(preservedScoreRow),
        scoreInputValue: preservedScoreInput?.value || "",
        scoreInputFocused: document.activeElement === preservedScoreInput,
      };
    }
    globalThis.__adminProjectionTest = {
      setup() {
        allGroups = projectionFixture.groups.map((group) => ({ ...group }));
        allTeams = projectionFixture.teams.map((team) => ({ ...team }));
        allPrelimMatches = projectionFixture.matches.map((match) => ({ ...match }));
        workflowDraftAssignments = projectionFixture.assignments.map((assignment) => ({ ...assignment }));
        workflowDraftCourts = projectionFixture.courts.map((court) => ({ ...court }));
        reviewAssignments = [];
        reviewWorkflows = new Map();
        workflowDraftCourtSwaps = [];
        prelimHistoryReadiness = { status: "ready", error: null };
        workflowPhaseFilter = "all";
        workflowDirty = false;
        refreshActiveDivisionData();
        preservedScoreRow = document.getElementById("prelimGroups")
          .querySelector("[data-prelim-match-row='match-ab']");
        preservedScoreInput = document.createElement("input");
        preservedScoreInput.value = "25";
        preservedScoreRow?.appendChild(preservedScoreInput);
        preservedScoreInput?.focus();
        return projectionState();
      },
      settings() {
        workflowDraftCourts = [{ id: "court-settings-test", name: "1", recorderName: "" }];
        originalRenderCourtSettings();
        const row = document.getElementById("courtSettingsList").children[0];
        const name = row?.querySelector(".court-name-input input");
        return {
          hasOrdinalMarker: Boolean(row?.querySelector(".court-settings-order")),
          namePlaceholder: name?.placeholder || "",
          suffix: row?.querySelector(".court-name-input b")?.textContent || "",
        };
      },
      moveDraft() {
        moveWorkflowMatch("match-ab", -1);
        return projectionState();
      },
      renameDraft() {
        workflowDraftCourts[0].name = "1";
        markWorkflowDirty();
        syncPrelimExecutionProjection();
        return projectionState();
      },
      swapDraft() {
        allPrelimMatches.push(
          { id: "match-hidden", division: "men", groupId: "group-a", round: 4, teamA: "team-a", teamB: "team-b", sets: [] },
          { id: "match-complete", division: "men", groupId: "group-a", round: 5, teamA: "team-b", teamB: "team-c", sets: [] },
        );
        workflowDraftCourts = [
          ...workflowDraftCourts,
          { id: "court-b", name: "B", recorderName: "" },
        ];
        workflowDraftAssignments = [
          ...workflowDraftAssignments,
          { matchKey: "match-hidden", courtId: "court-b", courtOrder: 1, matchType: "prelim", publicStatus: "scheduled" },
          { matchKey: "match-complete", courtId: "court-b", courtOrder: 2, matchType: "prelim", publicStatus: "completed" },
        ];
        reviewWorkflows = new Map([
          ["match-complete", { draftState: "approved" }],
        ]);
        workflowPhaseFilter = "final";
        workflowDraftCourtSwaps = [];
        reviewAssignments = workflowDraftAssignments.map((assignment) => ({ ...assignment }));
        reviewCourts = new Map(workflowDraftCourts.map((court) => [court.id, { ...court }]));
        swapWorkflowCourts("court-a", "court-b");
        const validSwap = workflowCourtSwapsMatchSavedPlan();
        const moved = workflowDraftAssignments[0];
        const originalCourt = moved.courtId;
        moved.courtId = null;
        const rejectsMixedAssignment = !workflowCourtSwapsMatchSavedPlan();
        moved.courtId = originalCourt;
        const originalName = workflowDraftCourts[0].name;
        workflowDraftCourts[0].name = "변경";
        const rejectsMixedCourtSettings = !workflowCourtSwapsMatchSavedPlan();
        workflowDraftCourts[0].name = originalName;
        return {
          validSwap,
          rejectsMixedAssignment,
          rejectsMixedCourtSettings,
          assignments: workflowDraftAssignments.map((assignment) => [
            assignment.matchKey, assignment.courtId, assignment.courtOrder,
          ]),
          dirty: workflowDirty,
          phase: workflowPhaseFilter,
        };
      },
      boardSetup(mixed = false) {
        renderCourtBoard = originalRenderCourtBoard;
        allGroups = [];
        allTeams = [];
        allPrelimMatches = [];
        workflowDraftAssignments = [
          { matchKey: "board-a", label: "경기 A", teams: "A팀 · B팀", matchType: "final", courtId: "court-a", courtOrder: 1, publicStatus: "scheduled" },
          { matchKey: "board-b", label: "경기 B", teams: "C팀 · D팀", matchType: "final", courtId: "court-a", courtOrder: 2, publicStatus: "scheduled" },
          { matchKey: "board-c", label: "경기 C", teams: "E팀 · F팀", matchType: "final", courtId: "court-a", courtOrder: 3, publicStatus: "scheduled" },
          { matchKey: "board-d", label: "경기 D", teams: "G팀 · H팀", matchType: "final", courtId: "court-a", courtOrder: 4, publicStatus: "completed" },
          { matchKey: "board-e", label: "경기 E", teams: "I팀 · J팀", matchType: "final", courtId: "court-b", courtOrder: 1, publicStatus: "scheduled" },
        ];
        workflowDraftCourts = [
          { id: "court-a", name: "A", recorderName: "" },
          { id: "court-b", name: "B", recorderName: "" },
        ];
        reviewAssignments = [];
        reviewWorkflows = new Map([["board-d", { draftState: "approved" }]]);
        workflowCompletedDetailsOpen.clear();
        workflowCompletedDetailsOpen.set("court-a", true);
        workflowPhaseFilter = "all";
        workflowDirty = false;
        if (mixed) {
          activeDivision = "men";
          allGroups = [
            { id: "group-men", division: "men", name: "1조" },
            { id: "group-women", division: "women", name: "2조" },
          ];
          allPrelimMatches = [
            {
              id: "board-prelim-men",
              division: "men",
              groupId: "group-men",
              round: 1,
              teamA: "men-a",
              teamB: "men-b",
            },
            {
              id: "board-prelim-women",
              division: "women",
              groupId: "group-women",
              round: 2,
              teamA: "women-a",
              teamB: "women-b",
            },
          ];
          prelimMatches = allPrelimMatches.filter((match) => match.division === activeDivision);
          workflowDraftAssignments = [
            {
              matchKey: "board-prelim-men",
              matchType: "prelim",
              division: "men",
              courtId: "court-a",
              courtOrder: 1,
              publicStatus: "scheduled",
              teams: "남자 A팀 · 남자 B팀",
            },
            {
              matchKey: "board-prelim-women",
              matchType: "prelim",
              division: "women",
              courtId: "court-a",
              courtOrder: 2,
              publicStatus: "scheduled",
              teams: "여자 A팀 · 여자 B팀",
            },
          ];
          reviewWorkflows = new Map();
        }
        renderCourtBoard();
        const root = document.getElementById("allCourtBoard");
        const cardFor = (matchKey) => [...root.querySelectorAll(".court-board-card")]
          .find((card) => card.dataset.workflowMatchKey === matchKey);
        const setGeometry = () => {
          root.querySelectorAll(".court-board-list").forEach((list) => {
            list.getBoundingClientRect = () => ({ top: 0, height: 500, bottom: 500 });
            [...list.querySelectorAll(".court-board-card")].forEach((card, index) => {
              card.getBoundingClientRect = () => ({
                top: index * 100,
                height: 80,
                bottom: index * 100 + 80,
              });
            });
          });
        };
        const transferFor = (matchKey) => {
          let value = matchKey;
          return {
            types: ["text/plain"],
            effectAllowed: "",
            setData(type, data) {
              if (type === "text/plain") value = data;
            },
            getData(type) {
              return type === "text/plain" ? value : "";
            },
          };
        };
        const invoke = (node, type, event) => {
          (node?.eventHandlers[type] || []).forEach((handler) => handler({
            currentTarget: node,
            target: node,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            ...event,
          }));
        };
        const orderFor = (courtId) => workflowDraftAssignments
          .filter((assignment) => (assignment.courtId || null) === courtId)
          .sort((left, right) => left.courtOrder - right.courtOrder)
          .map((assignment) => assignment.matchKey);
        const columnFor = (courtId) => root.querySelectorAll(".court-board-column")[
          courtId === null ? 0 : courtId === "court-a" ? 1 : 2
        ];
        const drag = (sourceKey) => {
          const source = cardFor(sourceKey);
          const dataTransfer = transferFor(sourceKey);
          invoke(source, "dragstart", { dataTransfer });
          setGeometry();
          return {
            source,
            over(targetKey, clientY) {
              const target = cardFor(targetKey);
              const event = { dataTransfer, clientY };
              invoke(target, "dragover", event);
              return {
                indicator: root.querySelector(".court-board-drop-indicator"),
                event,
              };
            },
            drop(targetKey, clientY) {
              const target = cardFor(targetKey);
              const event = { dataTransfer, clientY };
              invoke(target, "drop", event);
              return event;
            },
            overColumn(courtId, clientY) {
              const column = columnFor(courtId);
              const list = column.querySelector(".court-board-list");
              const event = { dataTransfer, clientY, target: list };
              invoke(column, "dragover", event);
              return {
                indicator: root.querySelector(".court-board-drop-indicator"),
                event,
              };
            },
            dropColumn(courtId, clientY) {
              const column = columnFor(courtId);
              const list = column.querySelector(".court-board-list");
              const event = { dataTransfer, clientY, target: list };
              invoke(column, "drop", event);
              return event;
            },
            end() {
              invoke(source, "dragend", { dataTransfer });
            },
            order: orderFor,
            cardFor,
            root,
          };
        };
        const restrict = () => {
          root.querySelectorAll("[data-workflow-completed-court]").forEach((details) => {
            if (details.dataset.workflowCompletedCourt === "court-a") details.open = false;
          });
          workflowCompletedDetailsOpen.delete("court-a");
          renderCourtBoard();
          return cardFor("board-a").draggable;
        };
        return {
          root,
          cardFor,
          setGeometry,
          drag,
          orderFor,
          restrict,
          move: (matchKey, courtId) => {
            setMatchCourt(matchKey, courtId);
            return [...(cardFor(matchKey)?.children[0]?.children || [])]
              .map((badge) => badge.textContent).join("|");
          },
          matches: () => allPrelimMatches.map((match) => ({ ...match })),
        };
      },
    };
    globalThis.__adminGrantTest = {
      setCallable(fn) {
        globalThis.__setAdminWorkflowCallable(fn);
      },
      setAuth(uid) {
        resetRecorderGrantAuth(uid);
      },
      setGrants(grants) {
        recorderGrantsLoading = false;
        recorderGrantsError = "";
        recorderGrantsHistoryVisibleCount = 20;
        recorderGrants = grants.map((grant) => ({ ...grant }));
        renderRecorderGrants();
      },
      refresh() {
        return refreshRecorderGrants();
      },
      render() {
        renderRecorderGrants();
      },
      status() {
        return document.getElementById("recorderGrantStatus").textContent;
      },
      activeCards() {
        return [...document.getElementById("recorderGrantList").children];
      },
      historyCards() {
        return [...document.getElementById("recorderGrantHistoryList").children];
      },
      historyMore() {
        return document.getElementById("recorderGrantHistoryMoreBtn");
      },
      historyDetails() {
        return document.getElementById("recorderGrantHistory");
      },
      revokeButton(kind, index = 0) {
        const root = kind === "history"
          ? document.getElementById("recorderGrantHistoryList")
          : document.getElementById("recorderGrantList");
        return root.children[index]?.querySelector(".btn.danger") || null;
      },
      confirmation() {
        return globalThis.__getConfirmMessage();
      },
    };
  `;
  vm.runInNewContext(`${source}\n${bridge}`, context, { filename: "admin.js" });
  return {
    setup: () => context.__adminProjectionTest.setup(),
    settings: () => context.__adminProjectionTest.settings(),
    moveDraft: () => context.__adminProjectionTest.moveDraft(),
    renameDraft: () => context.__adminProjectionTest.renameDraft(),
    swapDraft: () => context.__adminProjectionTest.swapDraft(),
    board: (mixed) => context.__adminProjectionTest.boardSetup(mixed),
    grant: context.__adminGrantTest,
  };
}

const adminProjectionUi = createAdminProjectionHarness();
const courtSettingsUi = adminProjectionUi.settings();
check(
  'court settings use the displayed suffix without a redundant ordinal marker',
  !courtSettingsUi.hasOrdinalMarker
    && courtSettingsUi.namePlaceholder === "예: 1"
    && courtSettingsUi.suffix === "코트",
);
const savedProjectionUi = adminProjectionUi.setup();
check(
  'admin setup and score views initially share projected court execution order',
  JSON.stringify(savedProjectionUi.setupIds) === JSON.stringify(['match-ca', 'match-bc', 'match-ab'])
    && JSON.stringify(savedProjectionUi.scoreIds) === JSON.stringify(savedProjectionUi.setupIds)
    && JSON.stringify(savedProjectionUi.setupRowChildren) === JSON.stringify([
      "prelim-matchup", "prelim-court-control",
    ])
    && JSON.stringify(savedProjectionUi.setupCourtControlChildren) === JSON.stringify(["SPAN", "SELECT"])
    && JSON.stringify(savedProjectionUi.setupExecution) === JSON.stringify(savedProjectionUi.scoreExecution)
    && savedProjectionUi.setupExecution[0] === 'A코트|코트 순서 1|남자부|A조 예선 3경기'
    && savedProjectionUi.setupExecution[2] === 'A코트|코트 순서 5|남자부|A조 예선 1경기',
);
check(
  'saved planner projection keeps preliminary hints hidden',
  !savedProjectionUi.dirty && !savedProjectionUi.setupHintVisible && !savedProjectionUi.scoreHintVisible,
);
const draftedProjectionUi = adminProjectionUi.moveDraft();
check(
  'planner draft reorders existing setup and score rows and updates ring labels',
  JSON.stringify(draftedProjectionUi.setupIds) === JSON.stringify(['match-ca', 'match-ab', 'match-bc'])
    && JSON.stringify(draftedProjectionUi.scoreIds) === JSON.stringify(draftedProjectionUi.setupIds)
    && draftedProjectionUi.setupRing.map((item) => item.text).join("|")
      === "A코트 - 3라운드|A코트 - 5라운드|A코트 - 1라운드"
    && draftedProjectionUi.scoreRing.map((item) => item.text).join("|")
      === "A코트 - 3라운드|A코트 - 5라운드|A코트 - 1라운드",
);
check(
  'planner draft preserves score input node and value while marking both views unsaved',
  draftedProjectionUi.scoreRowPreserved
    && draftedProjectionUi.scoreInputPreserved
    && draftedProjectionUi.scoreInputValue === "25"
    && draftedProjectionUi.dirty
    && draftedProjectionUi.setupHintVisible
    && draftedProjectionUi.scoreHintVisible
    && draftedProjectionUi.hintText.includes("저장되지 않은 코트"),
);
const renamedProjectionUi = adminProjectionUi.renameDraft();
check(
  'planner draft rename refreshes full ring labels in setup and score views',
  renamedProjectionUi.setupRing.map((item) => item.text).join("|")
    === "1코트 - 3라운드|1코트 - 5라운드|1코트 - 1라운드"
    && renamedProjectionUi.scoreRing.map((item) => item.text).join("|")
      === "1코트 - 3라운드|1코트 - 5라운드|1코트 - 1라운드",
);
check(
  'planner draft rename does not rebuild or defocus the score row',
  renamedProjectionUi.scoreRowPreserved
    && renamedProjectionUi.scoreInputPreserved
    && renamedProjectionUi.scoreInputValue === "25"
    && renamedProjectionUi.scoreInputFocused,
);
const swappedProjectionUi = adminProjectionUi.swapDraft();
check(
  'whole-court swap save validation rejects mixed assignment and court setting edits',
  swappedProjectionUi.validSwap
    && swappedProjectionUi.rejectsMixedAssignment
    && swappedProjectionUi.rejectsMixedCourtSettings,
);
check(
  'whole-court swap includes filter-hidden and completed assignments in original court order',
  swappedProjectionUi.phase === "final"
    && swappedProjectionUi.dirty
    && JSON.stringify(swappedProjectionUi.assignments) === JSON.stringify([
      ["match-ab", "court-b", 2],
      ["match-bc", "court-b", 3],
      ["match-ca", "court-b", 1],
      ["match-hidden", "court-a", 1],
      ["match-complete", "court-a", 2],
    ]),
);

const mixedDivisionBoard = adminProjectionUi.board(true);
const boardMetadata = (card) => [...(card?.children[0]?.children || [])]
  .map((badge) => badge.textContent).join("|");
check(
  "unified board separates court order, division and preliminary match into badges",
  boardMetadata(mixedDivisionBoard.cardFor("board-prelim-women")) === "A코트|코트 순서 2|여자부|2조 예선 2경기"
    && boardMetadata(mixedDivisionBoard.cardFor("board-prelim-men")) === "A코트|코트 순서 1|남자부|1조 예선 1경기",
);
const mixedWomenMatchesBefore = JSON.stringify(mixedDivisionBoard.matches());
mixedDivisionBoard.move("board-prelim-men", "court-a");
check(
  "unified board refreshes execution order without relabeling the preliminary fixture",
  boardMetadata(mixedDivisionBoard.cardFor("board-prelim-women")) === "A코트|코트 순서 1|여자부|2조 예선 2경기",
);
const movedMixedWomen = mixedDivisionBoard.move("board-prelim-women", "court-b");
check(
  "unified board reflects a draft court move in the preliminary execution label",
  movedMixedWomen === "B코트|코트 순서 1|여자부|2조 예선 2경기"
    && JSON.stringify(mixedDivisionBoard.matches()) === mixedWomenMatchesBefore,
);
check(
  "unified board keeps an explicit unassigned fallback after a draft removal",
  mixedDivisionBoard.move("board-prelim-women", null) === "미배정|순서 미정|여자부|2조 예선 2경기",
);

const boardTop = adminProjectionUi.board();
const topDrag = boardTop.drag("board-b");
const topPreview = topDrag.over("board-a", 10);
check(
  "court planner previews the top-half insertion as the first full-court slot",
  topPreview.indicator?.dataset.workflowDropPosition === "1"
    && topPreview.indicator?.textContent.includes("A코트 · 1번째 슬롯")
    && topPreview.indicator?.dataset.workflowDropPlacement === "before"
    && topPreview.indicator?.textContent.includes("대상 경기 앞에 놓기")
    && boardTop.cardFor("board-b").classList.contains("workflow-drag-source"),
);
topDrag.drop("board-a", 10);
check(
  "court planner drop matches the top-half preview and confirms the moved card",
  JSON.stringify(boardTop.orderFor("court-a")) === JSON.stringify(["board-b", "board-a", "board-c", "board-d"])
    && !boardTop.root.querySelector(".court-board-drop-indicator")
    && boardTop.cardFor("board-b").classList.contains("workflow-drop-confirmed"),
);

const boardBottom = adminProjectionUi.board();
const bottomDrag = boardBottom.drag("board-c");
const bottomPreview = bottomDrag.over("board-b", 170);
check(
  "court planner previews the bottom-half insertion after the target while counting completed slots",
  bottomPreview.indicator?.dataset.workflowDropPosition === "4"
    && bottomPreview.indicator?.textContent.includes("A코트 · 4번째 슬롯")
    && bottomPreview.indicator?.dataset.workflowDropPlacement === "after"
    && bottomPreview.indicator?.textContent.includes("대상 경기 뒤에 놓기"),
);
bottomDrag.drop("board-b", 170);
check(
  "court planner bottom-half drop preserves the exact full-court insertion target",
  JSON.stringify(boardBottom.orderFor("court-a")) === JSON.stringify(["board-a", "board-b", "board-d", "board-c"]),
);

const boardEnd = adminProjectionUi.board();
const endDrag = boardEnd.drag("board-a");
const endPreview = endDrag.overColumn("court-a", 999);
check(
  "court planner exposes the destination list end as a full-court slot",
  endPreview.indicator?.dataset.workflowDropPosition === "4"
    && endPreview.indicator?.textContent.includes("목록 마지막에 놓기"),
);
endDrag.dropColumn("court-a", 999);
check(
  "court planner appends a background drop to the same end slot it previewed",
  JSON.stringify(boardEnd.orderFor("court-a")) === JSON.stringify(["board-b", "board-c", "board-d", "board-a"]),
);

const boardNoop = adminProjectionUi.board();
const noopDrag = boardNoop.drag("board-b");
const noopPreview = noopDrag.over("board-b", 10);
noopDrag.drop("board-b", 10);
check(
  "court planner rejects self drops without an indicator or draft mutation",
  !noopPreview.indicator
    && JSON.stringify(boardNoop.orderFor("court-a")) === JSON.stringify(["board-a", "board-b", "board-c", "board-d"])
    && !boardNoop.cardFor("board-b").classList.contains("workflow-drop-confirmed"),
);

const boardCancel = adminProjectionUi.board();
const cancelDrag = boardCancel.drag("board-a");
cancelDrag.over("board-b", 170);
cancelDrag.end();
check(
  "court planner clears insertion feedback and source styling on cancellation",
  !boardCancel.root.querySelector(".court-board-drop-indicator")
    && !boardCancel.cardFor("board-a").classList.contains("workflow-drag-source"),
);

const boardRestricted = adminProjectionUi.board();
check(
  "court planner disables drag handlers when completed disclosure is collapsed",
  boardRestricted.restrict() === false
    && !boardRestricted.cardFor("board-a").eventHandlers.dragover,
);

// ---- recorder grant access UI ----
function grantFixture(overrides = {}) {
  return {
    uid: "uid-default",
    version: 1,
    status: "active",
    effectiveStatus: "active",
    issuedAt: 1000,
    lastUsedAt: null,
    expiresAt: 2000,
    revokedAt: null,
    email: "recorder@example.com",
    displayName: "기록관",
    accountDeleted: false,
    ...overrides,
  };
}

const adminGrantUi = createAdminProjectionHarness();
adminGrantUi.grant.setAuth("admin-uid");
adminGrantUi.grant.setGrants([
  grantFixture({ uid: "uid-safe", email: "safe@example.com", displayName: "안전 기록관" }),
]);
const identityCard = adminGrantUi.grant.activeCards()[0];
check(
  "grant card uses email as primary identity and display name as secondary identity",
  identityCard?.querySelector(".recorder-grant-email")?.textContent === "safe@example.com"
    && identityCard?.querySelector(".recorder-grant-display-name")?.textContent === "안전 기록관",
);
check(
  "grant UID is present only within the expandable account details",
  identityCard?.querySelector(".recorder-grant-account")?.querySelector(".recorder-uid")?.textContent === "uid-safe"
    && identityCard?.querySelector(".recorder-grant-identity")?.querySelector(".recorder-uid") === null,
);
const unsafeEmail = '<img src=x onerror="alert(1)">';
adminGrantUi.grant.setGrants([
  grantFixture({ uid: "uid-unsafe", email: unsafeEmail, displayName: "<b>이름</b>" }),
]);
const unsafeCard = adminGrantUi.grant.activeCards()[0];
check(
  "grant identity text is rendered safely without HTML interpolation",
  unsafeCard?.querySelector(".recorder-grant-email")?.textContent === unsafeEmail
    && unsafeCard?.querySelector("img") === null
    && unsafeCard?.querySelector("b") === null,
);
adminGrantUi.grant.setGrants([
  grantFixture({ uid: "uid-deleted", email: null, displayName: null, accountDeleted: true }),
]);
const deletedCard = adminGrantUi.grant.activeCards()[0];
check(
  "grant card labels missing email and deleted Auth account explicitly",
  deletedCard?.querySelector(".recorder-grant-email")?.textContent === "이메일 정보 없음"
    && deletedCard?.querySelector(".recorder-grant-account-deleted")?.textContent === "삭제된 로그인 계정",
);

adminGrantUi.grant.setGrants([
  grantFixture({ uid: "uid-active" }),
  grantFixture({ uid: "uid-expired", effectiveStatus: "expired" }),
  grantFixture({ uid: "uid-revoked", status: "revoked", effectiveStatus: "revoked", revokedAt: 3000 }),
]);
check(
  "active and history grants are separated with a collapsed history section and total",
  adminGrantUi.grant.activeCards().length === 1
    && adminGrantUi.grant.historyCards().length === 2
    && !adminGrantUi.grant.historyDetails().open
    && adminGrantUi.grant.historyDetails().querySelector("summary").textContent === "이력 (2건)",
);
adminGrantUi.grant.setGrants(Array.from({ length: 21 }, (_, index) => grantFixture({
  uid: `uid-history-${index}`,
  effectiveStatus: "expired",
  issuedAt: index + 1,
})));
check(
  "history initially renders in client pages of twenty",
  adminGrantUi.grant.historyCards().length === 20
    && adminGrantUi.grant.historyMore().hidden === false,
);
adminGrantUi.grant.historyMore().click();
check(
  "history more renders the next twenty-page increment",
  adminGrantUi.grant.historyCards().length === 21
    && adminGrantUi.grant.historyMore().hidden === true,
);

let grantCalls = [];
adminGrantUi.grant.setCallable(async (name, data) => {
  grantCalls.push([name, data]);
  if (!data.cursor) {
    return {
      data: {
        grants: [grantFixture({ uid: "uid-page-one", email: "one@example.com" })],
        nextCursor: "uid-page-one",
      },
    };
  }
  return {
    data: {
      grants: [grantFixture({ uid: "uid-page-two", email: "two@example.com" })],
      nextCursor: null,
    },
  };
});
await adminGrantUi.grant.refresh();
check(
  "grant refresh consumes every page and includes an active grant on the last page",
  grantCalls.length === 2
    && grantCalls[1][1].cursor === "uid-page-one"
    && adminGrantUi.grant.activeCards().length === 2
    && adminGrantUi.grant.status() === "2개 활성 접근 권한",
);

grantCalls = [];
adminGrantUi.grant.setCallable(async (name, data) => {
  grantCalls.push([name, data]);
  if (!data.cursor) {
    return {
      data: {
        grants: [grantFixture({ uid: "uid-before-failure" })],
        nextCursor: "uid-before-failure",
      },
    };
  }
  throw new Error("second page failed");
});
await adminGrantUi.grant.refresh();
check(
  "second-page failure clears partial grants and reports an incomplete refresh",
  grantCalls.length === 2
    && adminGrantUi.grant.activeCards().length === 0
    && adminGrantUi.grant.status().includes("불러오지 못했습니다"),
);

adminGrantUi.grant.setCallable(async (name, data) => ({
  data: {
    grants: [grantFixture({ uid: data.cursor ? "uid-repeat-two" : "uid-repeat-one" })],
    nextCursor: "uid-repeat-one",
  },
}));
await adminGrantUi.grant.refresh();
check(
  "repeating page cursor is rejected without claiming a complete list",
  adminGrantUi.grant.activeCards().length === 0
    && adminGrantUi.grant.status().includes("불러오지 못했습니다"),
);

adminGrantUi.grant.setCallable(async () => ({
  data: {
    grants: [],
    nextCursor: "uid-empty-page",
  },
}));
await adminGrantUi.grant.refresh();
check(
  "a nonterminal empty page is rejected as malformed",
  adminGrantUi.grant.activeCards().length === 0
    && adminGrantUi.grant.status().includes("불러오지 못했습니다"),
);

adminGrantUi.grant.setCallable(async () => ({
  data: {
    grants: [grantFixture({ uid: "uid-cursor-source" })],
    nextCursor: "uid-different",
  },
}));
await adminGrantUi.grant.refresh();
check(
  "a cursor that does not identify the last returned grant is rejected",
  adminGrantUi.grant.activeCards().length === 0
    && adminGrantUi.grant.status().includes("불러오지 못했습니다"),
);

let revokePayload = null;
adminGrantUi.grant.setGrants([
  grantFixture({ uid: "uid-to-revoke", email: "revoke@example.com", displayName: "취소 대상" }),
  grantFixture({ uid: "uid-already-revoked", status: "revoked", effectiveStatus: "revoked" }),
]);
adminGrantUi.grant.setCallable(async (name, data) => {
  if (name === "revokeRecorderGrant") revokePayload = data;
  return { data: { revoked: false } };
});
adminGrantUi.grant.revokeButton("active")?.click();
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  "revoke action preserves UID payload and names the account without deleting login",
  revokePayload?.uid === "uid-to-revoke"
    && adminGrantUi.grant.confirmation().includes("revoke@example.com")
    && adminGrantUi.grant.confirmation().includes("취소 대상")
    && adminGrantUi.grant.confirmation().includes("로그인 계정 자체는 삭제하지 않습니다"),
);
check(
  "revoked grants do not expose a repeat revoke action",
  adminGrantUi.grant.revokeButton("history") === null,
);

let resolveStalePage;
adminGrantUi.grant.setCallable(() => new Promise((resolve) => {
  resolveStalePage = resolve;
}));
const staleRefresh = adminGrantUi.grant.refresh();
adminGrantUi.grant.setAuth(null);
resolveStalePage({
  data: {
    grants: [grantFixture({ uid: "uid-stale", email: "stale@example.com" })],
    nextCursor: null,
  },
});
await staleRefresh;
check(
  "logout invalidates a delayed grant response and leaves no stale account identity",
  adminGrantUi.grant.activeCards().length === 0
    && !adminGrantUi.grant.status().includes("stale@example.com"),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

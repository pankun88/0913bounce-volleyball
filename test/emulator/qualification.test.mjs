import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { deleteDoc, deleteField, doc, getDoc, setDoc } from 'firebase/firestore';
import { createFixture, PROJECT_ID, path } from './fixtures.mjs';
import {
  buildQualificationSnapshot,
  computeQualificationState,
  validateQualificationSelection,
} from '../../js/match-logic.js';
import { buildCrossGroupSeedOrder, generateBracket } from '../../js/bracket.js';

// 관리자 화면이 서버에 보내는 것과 같은 구조 전용 레코드로 바꾼다(admin.js finalStructureMatch와 동일한 필드).
function structureOnly(prefix, matches) {
  const rename = (id) => (id ? `${prefix}-${id}` : null);
  return matches.map((match) => {
    const structure = {};
    for (const field of ['id', 'round', 'roundLabel', 'index', 'teamA', 'teamB', 'teamASource', 'teamBSource',
      'status', 'byeCandidate', 'nextMatchId', 'nextSlot']) {
      if (match[field] !== undefined) structure[field] = match[field];
    }
    structure.id = rename(match.id);
    structure.nextMatchId = rename(match.nextMatchId);
    if (!structure.nextMatchId) structure.nextSlot = null;
    return structure;
  });
}

// 3개 조 · 조별 2팀 진출(6팀) · 8강 대진. winners에 든 조 1위가 부전승 자리를 받는다.
function byeLotteryBracket(prefix, standingsByGroup, winners) {
  const tiers = [0, 1].map((rankIndex) => standingsByGroup.map(({ groupId, ids }) => ({
    teamId: ids[rankIndex],
    groupId,
    groupSize: ids.length,
    ...(rankIndex === 0 && winners ? { byePriority: winners.includes(ids[0]) } : {}),
  })));
  const order = buildCrossGroupSeedOrder(tiers);
  return structureOnly(prefix, generateBracket(order.map((id) => ({ id, name: id }))).matches);
}

const host = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const [functionsHost, functionsPort] = host.split(':');
const sets = [{ a: 10, b: 8 }, { a: 10, b: 8 }];

function pureFixture() {
  const groups = [{ id: 'qualification-emulator-group', division: 'men', matchMode: 'roundrobin' }];
  const teams = ['qualification-a', 'qualification-b', 'qualification-c']
    .map((id) => ({ id, division: 'men', groupId: groups[0].id, name: id }));
  const pairs = [['qualification-a', 'qualification-b'], ['qualification-a', 'qualification-c'], ['qualification-b', 'qualification-c']];
  const matches = pairs.map(([teamA, teamB], index) => ({
    id: `qualification-match-${index}`,
    division: 'men',
    groupId: groups[0].id,
    teamA,
    teamB,
    sets,
    status: 'done',
    officialCurrent: true,
    officialRevision: 1,
  }));
  return buildQualificationSnapshot({
    division: 'men', qualifyPerGroup: 2, groups, teams, matches,
  });
}

function finalStructureBaseline(matches) {
  return matches.map((match) => ({
    id: match.id,
    lastTransitionId: match.lastTransitionId,
    officialRevision: match.officialRevision,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function finalBracket4(prefix, ids) {
  const source = (id) => ({ type: 'seed', teamId: id });
  return [
    {
      id: `${prefix}-semi-a`, round: 1, index: 0, status: 'pending',
      teamA: { id: ids[0], name: ids[0] }, teamB: { id: ids[1], name: ids[1] },
      teamASource: source(ids[0]), teamBSource: source(ids[1]),
      nextMatchId: `${prefix}-final`, nextSlot: 'A',
    },
    {
      id: `${prefix}-semi-b`, round: 1, index: 1, status: 'pending',
      teamA: { id: ids[2], name: ids[2] }, teamB: { id: ids[3], name: ids[3] },
      teamASource: source(ids[2]), teamBSource: source(ids[3]),
      nextMatchId: `${prefix}-final`, nextSlot: 'B',
    },
    {
      id: `${prefix}-final`, round: 2, index: 0, status: 'waiting',
      teamA: null, teamB: null, teamASource: null, teamBSource: null,
      nextMatchId: null, nextSlot: null,
    },
  ];
}

function finalBracket5(prefix, ids, byeRoot = 2) {
  const source = (id) => ({ type: 'seed', teamId: id });
  const roots = [
    {
      id: `${prefix}-root-a`, round: 1, index: 0, status: 'pending',
      teamA: { id: ids[0], name: ids[0] }, teamB: { id: ids[1], name: ids[1] },
      teamASource: source(ids[0]), teamBSource: source(ids[1]),
      nextMatchId: `${prefix}-round2-a`, nextSlot: 'A',
    },
    {
      id: `${prefix}-root-b`, round: 1, index: 1, status: 'pending',
      teamA: { id: ids[2], name: ids[2] }, teamB: { id: ids[3], name: ids[3] },
      teamASource: source(ids[2]), teamBSource: source(ids[3]),
      nextMatchId: `${prefix}-round2-a`, nextSlot: 'B',
    },
    {
      id: `${prefix}-root-c`, round: 1, index: 2, status: 'empty',
      teamA: null, teamB: null, teamASource: null, teamBSource: null,
      nextMatchId: `${prefix}-round2-b`, nextSlot: 'A',
    },
    {
      id: `${prefix}-root-d`, round: 1, index: 3, status: 'empty',
      teamA: null, teamB: null, teamASource: null, teamBSource: null,
      nextMatchId: `${prefix}-round2-b`, nextSlot: 'B',
    },
  ];
  roots[byeRoot].byeCandidate = {
    team: { id: ids[4], name: ids[4] },
    source: source(ids[4]),
    side: 'A',
  };
  return [
    ...roots,
    {
      id: `${prefix}-round2-a`, round: 2, index: 0, status: 'waiting',
      teamA: null, teamB: null, teamASource: null, teamBSource: null,
      nextMatchId: `${prefix}-final`, nextSlot: 'A',
    },
    {
      id: `${prefix}-round2-b`, round: 2, index: 1, status: 'waiting',
      teamA: null, teamB: null, teamASource: null, teamBSource: null,
      nextMatchId: `${prefix}-final`, nextSlot: 'B',
    },
    {
      id: `${prefix}-final`, round: 3, index: 0, status: 'waiting',
      teamA: null, teamB: null, teamASource: null, teamBSource: null,
      nextMatchId: null, nextSlot: null,
    },
  ];
}

export async function runQualificationSuite() {
  const pureState = computeQualificationState(pureFixture());
  assert.equal(pureState.ready, true, 'complete qualification preconditions are ready');
  assert.equal(validateQualificationSelection(pureState, [
    'qualification-a', 'qualification-b',
  ], {}).ok, true, 'automatic qualifiers are accepted');
  assert.equal(validateQualificationSelection(pureState, [
    'qualification-a', 'qualification-c',
  ], {}).ok, false, 'manual non-qualifier override is rejected');

  const incompleteSnapshot = pureFixture();
  incompleteSnapshot.matches.pop();
  const incompleteState = computeQualificationState(incompleteSnapshot);
  assert.equal(incompleteState.ready, false, 'missing scheduled game blocks publication');
  assert.ok(incompleteState.blockers.some((blocker) => blocker.startsWith('missing_game:')));

  const retractedSnapshot = pureFixture();
  retractedSnapshot.matches[0].officialCurrent = false;
  const retractedState = computeQualificationState(retractedSnapshot);
  assert.equal(retractedState.ready, false, 'retracted preliminary result blocks publication');

  const f = await createFixture();
  const appName = `qualification-emulator-${Date.now()}`;
  const app = initializeApp({
    projectId: PROJECT_ID,
    apiKey: 'emulator-only',
    appId: appName,
  }, appName);
  try {
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`, { disableWarnings: true });
    const credential = await signInAnonymously(auth);
    const functions = getFunctions(app, 'asia-northeast3');
    connectFunctionsEmulator(functions, functionsHost, Number(functionsPort));
    await f.seed(async (db) => {
      await setDoc(doc(db, path('admins', credential.user.uid)), { uid: credential.user.uid });
      await setDoc(doc(db, 'tournaments/main'), {
        qualifyPerGroup: { men: 2, women: 2 },
      }, { merge: true });
      await setDoc(doc(db, path('groups', 'qualification-server-group')), {
        id: 'qualification-server-group', division: 'men', matchMode: 'roundrobin', ringOrder: [],
      });
      for (const id of ['qualification-server-a', 'qualification-server-b']) {
        await setDoc(doc(db, path('teams', id)), {
          id, division: 'men', groupId: 'qualification-server-group', name: id,
        });
      }
      await setDoc(doc(db, path('prelimMatches', 'qualification-server-match')), {
        id: 'qualification-server-match', division: 'men', groupId: 'qualification-server-group',
        teamA: 'qualification-server-a', teamB: 'qualification-server-b', sets, status: 'done',
        result: 'A', officialCurrent: true, officialRevision: 1,
      });
    });
    const call = (name, data) => httpsCallable(functions, name)(data).then((result) => result.data);
    const scenarioArtifacts = new Map();
    const scoreForResult = (result) => result === 'B'
      ? [{ a: 8, b: 10 }, { a: 8, b: 10 }]
      : sets;
    const officialFor = (match, result) => ({
      id: match.id,
      division: match.division,
      groupId: match.groupId,
      teamA: match.teamA,
      teamB: match.teamB,
      sets: scoreForResult(result),
      status: 'done',
      result,
      winner: null,
      winnerSide: null,
      winnerTeam: null,
      setsWonA: result === 'A' ? 2 : 0,
      setsWonB: result === 'A' ? 0 : 2,
      pointsForA: result === 'A' ? 20 : 16,
      pointsForB: result === 'A' ? 16 : 20,
      officialCurrent: true,
      officialRevision: 1,
      lastTransitionId: `seed:${match.id}`,
    });
    const seedQualificationScenario = async ({
      prefix,
      groupSpecs,
      count = 2,
      resultOverrides = {},
      seedAssignments = true,
    }) => {
      const groups = [];
      const teams = [];
      const matches = [];
      const artifact = {
        prefix,
        groupIds: [],
        teamIds: [],
        matchIds: [],
        finalIds: [],
        assignmentIds: [],
        workflowIds: [],
        courtIds: [],
      };
      for (const spec of groupSpecs) {
        const groupId = `${prefix}-${spec.name}`;
        const groupDivision = spec.division || 'men';
        const groupTeams = spec.teams.map((suffix) => `${prefix}-${suffix}`);
        groups.push({
          id: groupId,
          division: groupDivision,
          matchMode: 'roundrobin',
          ringOrder: [],
        });
        artifact.groupIds.push(groupId);
        groupTeams.forEach((id) => {
          teams.push({
            id,
            division: spec.teamDivision || groupDivision,
            groupId,
            name: id,
          });
          artifact.teamIds.push(id);
        });
        const omitted = new Set((spec.omitPairs || []).map(([a, b]) => [a, b].sort().join('\u0000')));
        for (let i = 0; i < groupTeams.length; i += 1) {
          for (let j = i + 1; j < groupTeams.length; j += 1) {
            const suffixPair = [spec.teams[i], spec.teams[j]].sort().join('\u0000');
            if (omitted.has(suffixPair)) continue;
            const teamA = groupTeams[i];
            const teamB = groupTeams[j];
            const key = `${spec.name}:${spec.teams[i]}-${spec.teams[j]}`;
            const result = resultOverrides[key] || 'A';
            const id = `${prefix}-prelim-${i}-${j}-${spec.name}`;
            const match = {
              id,
              division: spec.matchDivision || groupDivision,
              groupId,
              teamA,
              teamB,
              sets: scoreForResult(result),
              status: 'done',
              result,
              officialCurrent: true,
              officialRevision: 1,
              lastTransitionId: `seed:${id}`,
            };
            matches.push(match);
            artifact.matchIds.push(id);
            if (seedAssignments) {
              artifact.assignmentIds.push(id);
              artifact.workflowIds.push(id);
            }
          }
        }
      }
      await f.seed(async (db) => {
        await setDoc(doc(db, 'tournaments/main'), {
          qualifyPerGroup: {
            men: count,
            women: 2,
          },
        }, { merge: true });
        for (const group of groups) {
          await setDoc(doc(db, path('groups', group.id)), group);
        }
        for (const team of teams) {
          await setDoc(doc(db, path('teams', team.id)), team);
        }
        for (const match of matches) {
          const result = match.result;
          const official = officialFor(match, result);
          await setDoc(doc(db, path('prelimMatches', match.id)), official);
          if (!seedAssignments) continue;
          await setDoc(doc(db, path('courtAssignments', match.id)), {
            matchKey: match.id,
            matchType: 'prelim',
            matchId: match.id,
            division: match.division,
            courtId: null,
            courtOrder: null,
            nextCourtMatchKey: null,
            dependencyReady: true,
            publicStatus: 'completed',
            attemptCount: 0,
            officialRevision: 1,
            lastTransitionId: official.lastTransitionId,
          });
          await setDoc(doc(db, path('scoreWorkflows', match.id)), {
            matchKey: match.id,
            draftState: 'approved',
            lock: null,
            draftRevision: 0,
            submissionVersion: 0,
            officialRevision: 1,
            officialSnapshot: official,
            lastTransitionId: official.lastTransitionId,
          });
        }
      });
      scenarioArtifacts.set(prefix, artifact);
      return { ...artifact, groups, teams, matches };
    };
    const seedFinalContinuation = async (prefix, matchId) => {
      const finalKey = `final:men:${matchId}`;
      const courtId = `${prefix}-continuation-court`;
      const workflow = {
        matchKey: finalKey,
        draftState: 'idle',
        lock: null,
        draftRevision: 0,
        submissionVersion: 0,
        officialRevision: 0,
        lastTransitionId: `seed:${finalKey}`,
      };
      await f.seed(async (db) => {
        await setDoc(doc(db, path('courts', courtId)), {
          id: courtId,
          name: courtId,
          recorderName: 'Qualification Recorder',
        });
        await setDoc(doc(db, path('courtAssignments', finalKey)), {
          matchKey: finalKey,
          matchType: 'final',
          matchId,
          divisionId: 'men',
          division: 'men',
          courtId,
          courtOrder: 1,
          nextCourtMatchKey: null,
          dependencyReady: false,
          publicStatus: 'scheduled',
          attemptCount: 0,
          officialRevision: 0,
          lastTransitionId: workflow.lastTransitionId,
        });
        await setDoc(doc(db, path('scoreWorkflows', finalKey)), workflow);
        await setDoc(doc(db, path('courtQueues', courtId)), {
          courtId,
          currentMatchKey: null,
          nextMatchKey: null,
          normalCursorMatchKey: null,
          priorityEntries: [{
            entryId: `blocked:${finalKey}`,
            matchKey: finalKey,
            kind: 'manual',
            enqueueSequence: 0,
            pathDepth: 0,
            courtOrder: 1,
            eligibility: 'blocked_dependency',
            sourceTransitionIds: [],
          }],
          nextPrioritySequence: 1,
          queueRevision: 0,
          lastTransitionId: `seed:${courtId}`,
        });
        const access = await getDoc(doc(db, path('recorderAccess', 'config')));
        await setDoc(doc(db, path('recorderGrants', credential.user.uid)), {
          uid: credential.user.uid,
          version: access.data().version,
          status: 'active',
          issuedAt: new Date(Date.now() - 1_000),
          expiresAt: new Date(Date.now() + 3_600_000),
        });
      });
      const artifact = scenarioArtifacts.get(prefix);
      artifact.assignmentIds.push(finalKey);
      artifact.workflowIds.push(finalKey);
      artifact.courtIds.push(courtId);
      return { finalKey, courtId };
    };
    const cleanupScenario = async (artifact, { clearMenProof = true } = {}) => {
      await f.seed(async (db) => {
        for (const id of [...artifact.matchIds, ...artifact.finalIds]) {
          await deleteDoc(doc(db, path('prelimMatches', id)));
          await deleteDoc(doc(db, 'tournaments/main/divisions/men/finalMatches', id));
        }
        for (const id of artifact.finalIds) {
          await deleteDoc(doc(db, path('courtAssignments', `final:men:${id}`)));
          await deleteDoc(doc(db, path('scoreWorkflows', `final:men:${id}`)));
        }
        for (const id of [...artifact.assignmentIds, ...artifact.workflowIds]) {
          await deleteDoc(doc(db, path('courtAssignments', id)));
          await deleteDoc(doc(db, path('scoreWorkflows', id)));
        }
        for (const id of artifact.courtIds) {
          await deleteDoc(doc(db, path('courts', id)));
          await deleteDoc(doc(db, path('courtQueues', id)));
        }
        for (const id of artifact.teamIds) {
          await deleteDoc(doc(db, path('teams', id)));
        }
        for (const id of artifact.groupIds) {
          await deleteDoc(doc(db, path('groups', id)));
        }
        await setDoc(doc(db, 'tournaments/main'), {
          qualifyPerGroup: { men: 2, women: 2 },
          ...(clearMenProof ? { finalQualification: { men: deleteField() } } : {}),
        }, { merge: true });
      });
      scenarioArtifacts.delete(artifact.prefix);
    };
    const publishQualification = async ({
      division = 'men',
      expectedMatches = [],
      matches,
      scoreDrafts = [],
      tieSelections = {},
      replacementMode,
      replacementReason,
    }) => {
      const prepared = await call('prepareFinalQualification', {
        tournamentId: 'main',
        division,
      });
      const payload = {
        tournamentId: 'main',
        division,
        expectedMatches,
        matches,
        scoreDrafts,
        expectedPrelimFingerprint: prepared.fingerprint,
        tieSelections,
      };
      if (replacementMode !== undefined) {
        payload.replacementMode = replacementMode;
        payload.replacementReason = replacementReason;
      }
      const result = await call('publishFinalStructure', payload);
      return { ...result, prepared };
    };
    const prepared = await call('prepareFinalQualification', { tournamentId: 'main', division: 'men' });
    assert.equal(prepared.state.ready, true, 'server preparation is ready');
    const published = await call('publishFinalStructure', {
      tournamentId: 'main',
      division: 'men',
      expectedMatches: [],
      expectedPrelimFingerprint: prepared.fingerprint,
      tieSelections: {},
      scoreDrafts: [],
      matches: [{
        id: 'qualification-server-final', round: 1, index: 0, status: 'pending',
        teamA: { id: 'qualification-server-a', name: 'A' },
        teamB: { id: 'qualification-server-b', name: 'B' },
        teamASource: { type: 'seed', teamId: 'qualification-server-a' },
        teamBSource: { type: 'seed', teamId: 'qualification-server-b' },
        nextMatchId: null, nextSlot: null,
      }],
    });
    assert.equal(published.matches.length, 1, 'server publication accepts validated entrants');
    const root = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(root.data().finalQualification.men.status, 'current', 'server stores current qualification proof');
    await assert.rejects(call('publishFinalStructure', {
      tournamentId: 'main', division: 'men', expectedMatches: published.matches.map((match) => ({
        id: match.id, lastTransitionId: match.lastTransitionId, officialRevision: match.officialRevision,
      })), expectedPrelimFingerprint: '0'.repeat(64), tieSelections: {}, scoreDrafts: [],
      matches: published.matches.map(({ sets: _sets, result: _result, winner: _winner, winnerSide: _winnerSide,
        winnerTeam: _winnerTeam, setsWonA: _setsWonA, setsWonB: _setsWonB, pointsForA: _pointsForA,
        pointsForB: _pointsForB, officialRevision: _officialRevision, lastTransitionId: _lastTransitionId, ...structure }) => structure),
    }), /Preliminary qualification input changed|qualification/i, 'stale-preliminary-fingerprint-rejected');
    await call('clearFinalStructure', { tournamentId: 'main', division: 'men' });
    const clearedRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(clearedRoot.data().finalQualification?.men, undefined, 'clear removes derived qualification proof');
    await f.seed(async (db) => {
      await deleteDoc(doc(db, path('groups', 'qualification-server-group')));
      await deleteDoc(doc(db, path('teams', 'qualification-server-a')));
      await deleteDoc(doc(db, path('teams', 'qualification-server-b')));
      await deleteDoc(doc(db, path('prelimMatches', 'qualification-server-match')));
    });

    const compatible = await seedQualificationScenario({
      prefix: 'compatible-played',
      groupSpecs: [
        { name: 'g1', teams: ['a', 'b'] },
        { name: 'g2', teams: ['c', 'd'] },
      ],
    });
    const continuation = await seedFinalContinuation('compatible-played', 'compatible-played-final');
    const compatibleStructure = finalBracket4('compatible-played', compatible.teamIds);
    compatible.finalIds.push(...compatibleStructure.map((match) => match.id));
    const compatibleInitial = await publishQualification({ matches: compatibleStructure });
    assert.equal(
      compatibleInitial.prepared.state.requiredCount,
      compatible.teamIds.length,
      'server-preparation-counts-all-populated-groups',
    );
    const compatiblePlayed = await publishQualification({
      expectedMatches: finalStructureBaseline(compatibleInitial.matches),
      matches: compatibleStructure,
      scoreDrafts: [
        {
          matchId: 'compatible-played-semi-a',
          sets,
          reason: '',
          expectedSubmissionVersion: 0,
        },
        {
          matchId: 'compatible-played-semi-b',
          sets,
          reason: '',
          expectedSubmissionVersion: 0,
        },
      ],
    });
    assert.equal(compatiblePlayed.matches.length, compatibleStructure.length, 'played-final-publication-retains-graph');
    const correctionBefore = await f.seed((db) => getDoc(
      doc(db, path('prelimMatches', compatible.matchIds[0])),
    ));
    await call('directEditOfficialScore', {
      tournamentId: 'main',
      matchKey: compatible.matchIds[0],
      score: { sets: [{ a: 8, b: 10 }, { a: 8, b: 10 }] },
      reason: 'Compatible preliminary result correction',
      expectedOfficialRevision: 1,
      expectedQueueRevision: null,
    });
    const freshAfterCorrection = await call('prepareFinalQualification', {
      tournamentId: 'main',
      division: 'men',
    });
    const correctedRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(
      correctedRoot.data().finalQualification.men.status,
      'current',
      'compatible-prelim-correction-keeps-final-qualification-current',
    );
    assert.equal(
      correctedRoot.data().finalQualification.men.fingerprint,
      freshAfterCorrection.fingerprint,
      'compatible-prelim-correction-stores-fresh-fingerprint',
    );
    const correctedPrelim = await f.seed((db) => getDoc(
      doc(db, path('prelimMatches', compatible.matchIds[0])),
    ));
    assert.equal(correctedPrelim.data().officialRevision, correctionBefore.data().officialRevision + 1, 'compatible-correction-increments-prelim-revision');
    const continuationAssignment = await f.seed((db) => getDoc(
      doc(db, path('courtAssignments', continuation.finalKey)),
    ));
    const continuationQueue = await f.seed((db) => getDoc(
      doc(db, path('courtQueues', continuation.courtId)),
    ));
    assert.equal(continuationAssignment.data().dependencyReady, true, 'final-continuation-dependency-is-ready');
    assert.equal(continuationQueue.data().currentMatchKey, continuation.finalKey, 'final-continuation-owns-current-queue');
    const claimedContinuation = await call('claimRecorderDraft', {
      tournamentId: 'main',
      matchKey: continuation.finalKey,
      courtId: continuation.courtId,
      recorderName: 'Qualification Recorder',
      sessionId: 'compatible-final-session',
      queueRevision: continuationQueue.data().queueRevision,
    });
    assert.equal(claimedContinuation.sessionId, 'compatible-final-session', 'current-proof-final-continuation-remains-claimable');
    const sameCount = await call('setQualificationCount', {
      tournamentId: 'main',
      division: 'men',
      count: 2,
    });
    assert.equal(sameCount.status, 'current', 'same-count-on-played-finals-is-current-no-op');
    const sameCountRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(sameCountRoot.data().finalQualification.men.status, 'current', 'same-count-does-not-mark-proof-stale');
    await cleanupScenario(compatible);

    // 본선 시작 후 예선 정정: 기본 차단 -> 사유 없는 플래그 거부 -> 비상용 정정 허용(진출팀·본선 유지)
    const postFinal = await seedQualificationScenario({
      prefix: 'post-final',
      groupSpecs: [
        { name: 'g1', teams: ['a', 'b', 'c'] },
        { name: 'g2', teams: ['d', 'e', 'f'] },
      ],
    });
    const postFinalContinuation = await seedFinalContinuation('post-final', 'post-final-final');
    const postFinalIds = ['a', 'b', 'd', 'e'].map((suffix) => `post-final-${suffix}`);
    const postFinalStructure = finalBracket4('post-final', postFinalIds);
    postFinal.finalIds.push(...postFinalStructure.map((match) => match.id));
    const postFinalInitial = await publishQualification({ matches: postFinalStructure });
    const postFinalPlayed = await publishQualification({
      expectedMatches: finalStructureBaseline(postFinalInitial.matches),
      matches: postFinalStructure,
      scoreDrafts: ['post-final-semi-a', 'post-final-semi-b'].map((matchId) => ({
        matchId, sets, reason: '', expectedSubmissionVersion: 0,
      })),
    });
    const postFinalMatch = postFinal.matches.find((match) => (
      match.teamA === 'post-final-b' && match.teamB === 'post-final-c'
    ));
    const postFinalBefore = await f.seed((db) => getDoc(doc(db, path('prelimMatches', postFinalMatch.id))));
    const postFinalRootBefore = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    const postFinalRequest = {
      tournamentId: 'main',
      matchKey: postFinalMatch.id,
      score: { sets: [{ a: 8, b: 10 }, { a: 8, b: 10 }] },
      expectedOfficialRevision: 1,
      expectedQueueRevision: null,
    };
    // (c) 기본: 순위가 바뀌어 본선 진출팀이 무효가 되면 한글 매핑용 reason 으로 차단되고 아무것도 쓰지 않는다.
    await assert.rejects(call('directEditOfficialScore', {
      ...postFinalRequest, reason: '기록 오기 정정',
    }), (error) => error?.details?.reason === 'prelim_correction_after_finals',
    'post-final-correction-blocked-by-default-with-reason-code');
    // 비상용 플래그는 사유가 있어야 하고, 불리언이어야 한다.
    await assert.rejects(call('directEditOfficialScore', {
      ...postFinalRequest, reason: '  ', allowPostFinalCorrection: true,
    }), /reason|correction/i, 'post-final-override-without-reason-rejected');
    await assert.rejects(call('directEditOfficialScore', {
      ...postFinalRequest, allowPostFinalCorrection: true,
    }), /reason|correction/i, 'post-final-override-missing-reason-rejected');
    await assert.rejects(call('directEditOfficialScore', {
      ...postFinalRequest, reason: '기록 오기 정정', allowPostFinalCorrection: 'yes',
    }), /correction/i, 'post-final-override-flag-must-be-boolean');
    const postFinalUnchanged = await f.seed((db) => getDoc(doc(db, path('prelimMatches', postFinalMatch.id))));
    assert.deepEqual(postFinalUnchanged.data(), postFinalBefore.data(), 'rejected-post-final-corrections-write-nothing');
    const postFinalRootUnchanged = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.deepEqual(
      postFinalRootUnchanged.data().finalQualification.men,
      postFinalRootBefore.data().finalQualification.men,
      'rejected-post-final-corrections-keep-proof',
    );
    // 허용: 점수만 바로잡고 진출팀·본선 대진은 그대로, 감사 표식이 남는다.
    const postFinalOverride = await call('directEditOfficialScore', {
      ...postFinalRequest, reason: '대회 본부 결정: 기록 오기 정정', allowPostFinalCorrection: true,
    });
    const postFinalCorrected = await f.seed((db) => getDoc(doc(db, path('prelimMatches', postFinalMatch.id))));
    assert.equal(postFinalCorrected.data().officialRevision, 2, 'post-final-override-corrects-the-score');
    const postFinalRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    const postFinalProof = postFinalRoot.data().finalQualification.men;
    assert.equal(postFinalProof.status, 'current', 'post-final-override-keeps-proof-current');
    assert.equal(postFinalProof.reason, 'prelim_corrected_after_finals', 'post-final-override-records-reason-marker');
    assert.deepEqual(postFinalProof.participantIds, [...postFinalIds].sort(), 'post-final-override-keeps-finalists');
    assert.deepEqual(postFinalProof.tieSelections, postFinalRootBefore.data().finalQualification.men.tieSelections,
      'post-final-override-keeps-tie-selections');
    assert.deepEqual(postFinalProof.postFinalCorrection.groupIds, ['post-final-g1'], 'post-final-override-marks-division-group');
    const postFinalAudit = await f.seed((db) => getDoc(doc(db, path('auditEvents', postFinalOverride.transitionId))));
    assert.equal(postFinalAudit.data().reason, '대회 본부 결정: 기록 오기 정정', 'post-final-override-reason-is-audited');
    assert.equal(postFinalAudit.data().after.qualification.postFinalCorrection, true, 'post-final-override-audit-marker');
    for (const id of postFinalStructure.map((match) => match.id)) {
      assert.equal((await f.seed((db) => getDoc(
        doc(db, 'tournaments/main/divisions/men/finalMatches', id),
      ))).exists(), true, 'post-final-override-keeps-final-bracket');
    }
    // 정정 뒤에도 본선 기록관은 막히지 않는다 (qualification_unverified 아님).
    const postFinalQueue = await f.seed((db) => getDoc(doc(db, path('courtQueues', postFinalContinuation.courtId))));
    const postFinalClaim = await call('claimRecorderDraft', {
      tournamentId: 'main',
      matchKey: postFinalContinuation.finalKey,
      courtId: postFinalContinuation.courtId,
      recorderName: 'Qualification Recorder',
      sessionId: 'post-final-recorder-session',
      queueRevision: postFinalQueue.data().queueRevision,
    });
    assert.equal(postFinalClaim.sessionId, 'post-final-recorder-session', 'final-scoring-stays-available-after-post-final-override');
    // 같은 대진 재공개도 새 순위가 아닌 기록된 진출팀 기준으로 허용된다.
    const postFinalRepublished = await publishQualification({
      expectedMatches: finalStructureBaseline(postFinalPlayed.matches),
      matches: postFinalStructure,
    });
    assert.equal(postFinalRepublished.matches.length, postFinalStructure.length, 'post-final-republication-keeps-bracket');
    const postFinalRepublishedRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.deepEqual(postFinalRepublishedRoot.data().finalQualification.men.participantIds, [...postFinalIds].sort(),
      'post-final-republication-keeps-finalists');
    assert.equal(postFinalRepublishedRoot.data().finalQualification.men.status, 'current', 'post-final-republication-stays-current');
    await cleanupScenario(postFinal);

    const playedNoProof = await seedQualificationScenario({
      prefix: 'played-without-proof',
      groupSpecs: [{ name: 'g1', teams: ['a', 'b', 'c'] }],
      resultOverrides: { 'g1:b-c': 'A' },
    });
    const playedNoProofStructure = [{
      id: 'played-without-proof-final',
      round: 1,
      index: 0,
      status: 'pending',
      teamA: { id: playedNoProof.teamIds[0], name: playedNoProof.teamIds[0] },
      teamB: { id: playedNoProof.teamIds[1], name: playedNoProof.teamIds[1] },
      teamASource: { type: 'seed', teamId: playedNoProof.teamIds[0] },
      teamBSource: { type: 'seed', teamId: playedNoProof.teamIds[1] },
      nextMatchId: null,
      nextSlot: null,
    }];
    playedNoProof.finalIds.push(...playedNoProofStructure.map((match) => match.id));
    const playedNoProofPublished = await publishQualification({
      matches: playedNoProofStructure,
      scoreDrafts: [{
        matchId: playedNoProofStructure[0].id,
        sets,
        reason: '',
        expectedSubmissionVersion: 0,
      }],
    });
    await f.seed((db) => setDoc(doc(db, 'tournaments/main'), {
      finalQualification: { men: deleteField() },
    }, { merge: true }));
    const qualifierChangingMatch = playedNoProof.matches.find((match) => (
      match.teamA === playedNoProof.teamIds[1] && match.teamB === playedNoProof.teamIds[2]
    ));
    const noProofPrelimBefore = await f.seed((db) => getDoc(
      doc(db, path('prelimMatches', qualifierChangingMatch.id)),
    ));
    await assert.rejects(call('directEditOfficialScore', {
      tournamentId: 'main',
      matchKey: qualifierChangingMatch.id,
      score: { sets: [{ a: 8, b: 10 }, { a: 8, b: 10 }] },
      reason: 'Attempted qualifier-changing correction without proof',
      expectedOfficialRevision: 1,
      expectedQueueRevision: null,
    }), /qualification|final|entrant|proof/i, 'played-final-without-proof-rejects-qualifier-changing-correction');
    const noProofPrelimAfter = await f.seed((db) => getDoc(
      doc(db, path('prelimMatches', qualifierChangingMatch.id)),
    ));
    assert.deepEqual(noProofPrelimAfter.data(), noProofPrelimBefore.data(), 'rejected-no-proof-correction-writes-nothing');
    await assert.rejects(call('setQualificationCount', {
      tournamentId: 'main',
      division: 'men',
      count: 3,
    }), /qualification|final|played|proof|entrant/i, 'played-final-without-proof-rejects-count-change');
    const noProofRootAfter = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(noProofRootAfter.data().qualifyPerGroup.men, 2, 'rejected-no-proof-count-keeps-count');
    assert.equal(playedNoProofPublished.matches.length, 1, 'played-no-proof-fixture-published');
    const mixedCourtId = 'played-without-proof-mixed-court';
    const mixedFinalKey = `final:men:${playedNoProofStructure[0].id}`;
    playedNoProof.courtIds.push(mixedCourtId);
    await f.seed(async (db) => {
      await setDoc(doc(db, path('courts', mixedCourtId)), {
        id: mixedCourtId, name: 'Mixed correction', recorderName: '',
      });
      await setDoc(doc(db, path('courtQueues', mixedCourtId)), {
        courtId: mixedCourtId, currentMatchKey: null, nextMatchKey: null,
        normalCursorMatchKey: null, priorityEntries: [], nextPrioritySequence: 0,
        queueRevision: 0, lastTransitionId: 'seed:mixed-correction',
      });
      await setDoc(doc(db, path('courtAssignments', mixedFinalKey)), {
        courtId: mixedCourtId, courtOrder: 1, nextCourtMatchKey: qualifierChangingMatch.id,
      }, { merge: true });
      await setDoc(doc(db, path('courtAssignments', qualifierChangingMatch.id)), {
        courtId: mixedCourtId, courtOrder: 2, nextCourtMatchKey: null,
      }, { merge: true });
    });
    await assert.rejects(call('previewApprovedCorrection', {
      tournamentId: 'main', courtId: mixedCourtId,
      matchKeys: [mixedFinalKey, qualifierChangingMatch.id],
    }), /preliminary correction.*real final play/i,
    'final-first-mixed-targets-cannot-skip-prelim-played-final-guard');
    await cleanupScenario(playedNoProof);

    const unplayedNoProof = await seedQualificationScenario({
      prefix: 'unplayed-without-proof',
      groupSpecs: [{ name: 'g1', teams: ['a', 'b'] }],
    });
    const unplayedFinalId = 'unplayed-without-proof-final';
    unplayedNoProof.finalIds.push(unplayedFinalId);
    await f.seed(async (db) => {
      await setDoc(doc(db, 'tournaments/main/divisions/men/finalMatches', unplayedFinalId), {
        id: unplayedFinalId,
        round: 1,
        index: 0,
        status: 'pending',
        teamA: { id: unplayedNoProof.teamIds[0], name: unplayedNoProof.teamIds[0] },
        teamB: { id: unplayedNoProof.teamIds[1], name: unplayedNoProof.teamIds[1] },
        teamASource: { type: 'seed', teamId: unplayedNoProof.teamIds[0] },
        teamBSource: { type: 'seed', teamId: unplayedNoProof.teamIds[1] },
        nextMatchId: null,
        nextSlot: null,
      });
    });
    await assert.rejects(call('setQualificationCount', {
      tournamentId: 'main',
      division: 'men',
      count: 1,
    }), /qualification|final|unverified|proof/i, 'unplayed-no-proof-count-change-rejected');
    const unplayedNoProofRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(unplayedNoProofRoot.data().qualifyPerGroup.men, 2, 'unplayed-no-proof-count-remains-unchanged');
    await cleanupScenario(unplayedNoProof);

    const wrongFinalist = await seedQualificationScenario({
      prefix: 'wrong-finalist',
      groupSpecs: [{ name: 'g1', teams: ['a', 'b', 'c'] }],
    });
    const wrongStructure = [{
      id: 'wrong-finalist-final',
      round: 1,
      index: 0,
      status: 'pending',
      teamA: { id: wrongFinalist.teamIds[0], name: wrongFinalist.teamIds[0] },
      teamB: { id: wrongFinalist.teamIds[2], name: wrongFinalist.teamIds[2] },
      teamASource: { type: 'seed', teamId: wrongFinalist.teamIds[0] },
      teamBSource: { type: 'seed', teamId: wrongFinalist.teamIds[2] },
      nextMatchId: null,
      nextSlot: null,
    }];
    wrongFinalist.finalIds.push(...wrongStructure.map((match) => match.id));
    await assert.rejects(publishQualification({
      matches: wrongStructure,
    }), /qualification|qualifier|entrant|participant/i, 'server-publication-rejects-wrong-finalist');
    assert.equal((await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/men/finalMatches', wrongStructure[0].id),
    ))).exists(), false, 'wrong-finalist-publication-writes-nothing');
    await cleanupScenario(wrongFinalist);

    const incompleteSecondGroup = await seedQualificationScenario({
      prefix: 'incomplete-second-group',
      groupSpecs: [
        { name: 'g1', teams: ['a', 'b'] },
        { name: 'g2', teams: ['c', 'd', 'e'], omitPairs: [['d', 'e']] },
      ],
    });
    const incompleteSecondStructure = finalBracket5(
      'incomplete-second-group',
      incompleteSecondGroup.teamIds,
    );
    incompleteSecondGroup.finalIds.push(...incompleteSecondStructure.map((match) => match.id));
    const incompletePrepared = await call('prepareFinalQualification', {
      tournamentId: 'main',
      division: 'men',
    });
    assert.equal(incompletePrepared.state.ready, false, 'server-preparation-reports-incomplete-second-group');
    await assert.rejects(call('publishFinalStructure', {
      tournamentId: 'main',
      division: 'men',
      expectedMatches: [],
      matches: incompleteSecondStructure,
      scoreDrafts: [],
      expectedPrelimFingerprint: incompletePrepared.fingerprint,
      tieSelections: {},
    }), /qualification|preliminary|complete|missing/i, 'server-publication-rejects-incomplete-second-group');
    await cleanupScenario(incompleteSecondGroup);

    const crossLabeled = await seedQualificationScenario({
      prefix: 'cross-labeled',
      groupSpecs: [{
        name: 'g1',
        teams: ['a', 'b'],
        teamDivision: 'women',
        matchDivision: 'women',
      }],
    });
    let crossPreparationBlocked = false;
    try {
      const crossPrepared = await call('prepareFinalQualification', {
        tournamentId: 'main',
        division: 'men',
      });
      assert.equal(crossPrepared.state.ready, false, 'cross-labeled-group-member-blocks-preparation');
      assert.ok(
        crossPrepared.state.blockers.some((blocker) => /foreign|division|group/i.test(blocker)),
        'cross-labeled-group-member-is-reported',
      );
      crossPreparationBlocked = true;
    } catch (error) {
      assert.match(String(error), /foreign|division|group|qualification/i, 'cross-labeled-preparation-error');
      crossPreparationBlocked = true;
    }
    assert.equal(crossPreparationBlocked, true, 'cross-labeled-group-member-cannot-prepare');
    await cleanupScenario(crossLabeled);

    const byeStale = await seedQualificationScenario({
      prefix: 'bye-stale',
      count: 3,
      groupSpecs: [
        { name: 'g1', teams: ['a', 'b', 'c'] },
        { name: 'g2', teams: ['d', 'e'] },
      ],
    });
    const oldByeStructure = finalBracket5('bye-stale-old', byeStale.teamIds, 2);
    byeStale.finalIds.push(...oldByeStructure.map((match) => match.id));
    const oldByePublished = await publishQualification({ matches: oldByeStructure });
    const stalePrelim = byeStale.matches.find((match) => (
      match.teamA === byeStale.teamIds[0] && match.teamB === byeStale.teamIds[1]
    ));
    await call('directEditOfficialScore', {
      tournamentId: 'main',
      matchKey: stalePrelim.id,
      score: { sets: [{ a: 8, b: 10 }, { a: 8, b: 10 }] },
      reason: 'Preliminary correction before BYE-only replacement',
      expectedOfficialRevision: 1,
      expectedQueueRevision: null,
    });
    const stalePrepared = await call('prepareFinalQualification', {
      tournamentId: 'main',
      division: 'men',
    });
    const staleRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(staleRoot.data().finalQualification.men.status, 'stale', 'pre-play-prelim-correction-marks-publication-stale');
    assert.equal(
      staleRoot.data().finalQualification.men.fingerprint,
      stalePrepared.fingerprint,
      'stale-publication-stores-corrected-input-fingerprint',
    );
    const replacementStructure = finalBracket5('bye-stale-replacement', byeStale.teamIds, 3);
    byeStale.finalIds.push(...replacementStructure.map((match) => match.id));
    const replacedBye = await call('publishFinalStructure', {
      tournamentId: 'main',
      division: 'men',
      expectedMatches: finalStructureBaseline(oldByePublished.matches),
      matches: replacementStructure,
      scoreDrafts: [],
      expectedPrelimFingerprint: stalePrepared.fingerprint,
      tieSelections: {},
      replacementMode: 'replace_unplayed',
      replacementReason: 'Regenerate stale pre-play bracket after audited correction',
    });
    assert.equal(replacedBye.matches.length, replacementStructure.length, 'replace-unplayed-rebuilds-BYE-only-bracket');
    const replacementAudit = await f.seed((db) => getDoc(
      doc(db, path('auditEvents', replacedBye.transitionId)),
    ));
    assert.equal(replacementAudit.data().reason, 'Regenerate stale pre-play bracket after audited correction', 'replace-unplayed-reason-is-audited');
    assert.equal(
      replacementAudit.data().before.priorFinalMatches.length,
      oldByeStructure.length,
      'replace-unplayed-audits-complete-prior-bracket',
    );
    assert.equal(
      replacementAudit.data().before.priorFinalMatches.some((match) => match.id === oldByeStructure[2].id),
      true,
      'replace-unplayed-audits-old-BYE-candidate-root',
    );
    assert.equal((await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/men/finalMatches', oldByeStructure[0].id),
    ))).exists(), false, 'replace-unplayed-removes-old-graph-after-archive');
    const replacementRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(replacementRoot.data().finalQualification.men.status, 'current', 'replace-unplayed-publishes-current-proof');
    const replacementPlayed = await publishQualification({
      expectedMatches: finalStructureBaseline(replacedBye.matches),
      matches: replacementStructure,
      scoreDrafts: [{
        matchId: replacementStructure[0].id,
        sets,
        reason: 'Actual final play for replacement protection',
        expectedSubmissionVersion: 0,
      }],
    });
    const playedReplacementFinal = await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/men/finalMatches', replacementStructure[0].id),
    ));
    assert.equal(playedReplacementFinal.data().officialRevision, 1, 'replacement-test-records-real-final-play');
    await assert.rejects(call('publishFinalStructure', {
      tournamentId: 'main',
      division: 'men',
      expectedMatches: finalStructureBaseline(replacementPlayed.matches),
      matches: replacementStructure,
      scoreDrafts: [],
      expectedPrelimFingerprint: replacementPlayed.prepared.fingerprint,
      tieSelections: {},
      replacementMode: 'replace_unplayed',
      replacementReason: 'Must reject replacement after real final play',
    }), /replace_unplayed|real final|play|played/i, 'replace-unplayed-rejects-after-real-final-play');
    const preservedPlayedFinal = await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/men/finalMatches', replacementStructure[0].id),
    ));
    assert.equal(preservedPlayedFinal.data().officialRevision, 1, 'rejected-played-replacement-preserves-score-history');
    await cleanupScenario(byeStale);

    // 부전승 추첨: 3개 조 1위 3팀이 부전승 2자리를 두고 추첨한 결과를 서버가 검증·저장한다.
    const byeLottery = await seedQualificationScenario({
      prefix: 'bye-lottery',
      groupSpecs: [
        { name: 'g1', teams: ['a', 'b', 'c'] },
        { name: 'g2', teams: ['d', 'e', 'f'] },
        { name: 'g3', teams: ['g', 'h', 'i'] },
      ],
    });
    const standingsByGroup = [
      { groupId: 'bye-lottery-g1', ids: ['bye-lottery-a', 'bye-lottery-b'] },
      { groupId: 'bye-lottery-g2', ids: ['bye-lottery-d', 'bye-lottery-e'] },
      { groupId: 'bye-lottery-g3', ids: ['bye-lottery-g', 'bye-lottery-h'] },
    ];
    const lotteryWinners = ['bye-lottery-d', 'bye-lottery-g'];
    const lotteryRecord = {
      candidateIds: ['bye-lottery-a', 'bye-lottery-d', 'bye-lottery-g'],
      selectedIds: lotteryWinners,
      reason: '감독자 회의 제비뽑기',
    };
    const lotteryStructure = byeLotteryBracket('bye-lottery-final', standingsByGroup, lotteryWinners);
    const defaultStructure = byeLotteryBracket('bye-lottery-final', standingsByGroup, null);
    byeLottery.finalIds.push(...lotteryStructure.map((match) => match.id));
    const lotteryPrepared = await call('prepareFinalQualification', { tournamentId: 'main', division: 'men' });
    assert.equal(lotteryPrepared.state.requiredCount, 6, 'bye-lottery-six-finalists');
    const lotteryPayload = (matches, byeSelection) => ({
      tournamentId: 'main',
      division: 'men',
      expectedMatches: [],
      matches,
      scoreDrafts: [],
      expectedPrelimFingerprint: lotteryPrepared.fingerprint,
      tieSelections: {},
      ...(byeSelection === undefined ? {} : { byeSelection }),
    });
    await assert.rejects(
      call('publishFinalStructure', lotteryPayload(defaultStructure, lotteryRecord)),
      /bye_placement_mismatch/,
      'bye-lottery-rejects-placement-that-contradicts-the-record',
    );
    await assert.rejects(
      call('publishFinalStructure', lotteryPayload(lotteryStructure, {
        ...lotteryRecord, candidateIds: ['bye-lottery-d', 'bye-lottery-g'],
      })),
      /bye_candidates_mismatch/,
      'bye-lottery-rejects-forged-candidates',
    );
    await assert.rejects(
      call('publishFinalStructure', lotteryPayload(lotteryStructure, {
        ...lotteryRecord, selectedIds: ['bye-lottery-d', 'bye-lottery-b'],
      })),
      /bye_/,
      'bye-lottery-rejects-non-candidate-winner',
    );
    await assert.rejects(
      call('publishFinalStructure', lotteryPayload(lotteryStructure, { ...lotteryRecord, reason: ' ' })),
      /bye_reason_required/,
      'bye-lottery-requires-a-note',
    );
    await assert.rejects(
      call('publishFinalStructure', { ...lotteryPayload(lotteryStructure, lotteryRecord), extra: true }),
      /Exact final publication payload/,
      'bye-lottery-payload-stays-exact',
    );
    const noFinalsYet = await f.seed((db) => getDoc(
      doc(db, 'tournaments/main/divisions/men/finalMatches', lotteryStructure[0].id),
    ));
    assert.equal(noFinalsYet.exists(), false, 'bye-lottery-rejections-write-nothing');
    const lotteryPublished = await call('publishFinalStructure', lotteryPayload(lotteryStructure, lotteryRecord));
    assert.equal(lotteryPublished.matches.length, 7, 'bye-lottery-publishes-eight-slot-bracket');
    const lotteryRoots = lotteryPublished.matches.filter((match) => match.round === 1);
    assert.deepEqual(
      lotteryRoots.filter((match) => match.byeCandidate).map((match) => match.byeCandidate.team.id).sort(),
      lotteryWinners,
      'bye-lottery-winners-hold-the-bye-slots',
    );
    assert.ok(
      lotteryRoots.some((match) => match.status === 'pending'
        && [match.teamA?.id, match.teamB?.id].includes('bye-lottery-a')),
      'bye-lottery-remaining-winner-plays-round-one',
    );
    const lotteryRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.equal(lotteryRoot.data().finalQualification.men.status, 'current', 'bye-lottery-proof-is-current');
    assert.deepEqual(lotteryRoot.data().finalQualification.men.byeSelection, {
      candidateIds: ['bye-lottery-a', 'bye-lottery-d', 'bye-lottery-g'],
      selectedIds: lotteryWinners,
      reason: '감독자 회의 제비뽑기',
    }, 'bye-lottery-record-is-persisted-with-the-proof');
    const lotteryAudit = await f.seed((db) => getDoc(doc(db, path('auditEvents', lotteryPublished.transitionId))));
    assert.deepEqual(lotteryAudit.data().before.byeSelection.selectedIds, lotteryWinners, 'bye-lottery-record-is-audited');
    const republished = await call('publishFinalStructure', {
      ...lotteryPayload(
        lotteryPublished.matches.map(({ id, round, roundLabel, index, teamA, teamB, teamASource, teamBSource,
          status, byeCandidate, nextMatchId, nextSlot }) => ({
          id, round, roundLabel, index, teamA, teamB, teamASource, teamBSource, status,
          ...(byeCandidate ? { byeCandidate } : {}), nextMatchId, nextSlot,
        })),
        undefined,
      ),
      expectedMatches: finalStructureBaseline(lotteryPublished.matches),
    });
    assert.equal(republished.matches.length, 7, 'bye-lottery-republication-without-record-stays-allowed');
    const republishedRoot = await f.seed((db) => getDoc(doc(db, 'tournaments/main')));
    assert.deepEqual(republishedRoot.data().finalQualification.men.byeSelection?.selectedIds, lotteryWinners,
      'bye-lottery-record-is-kept-when-a-matching-bracket-is-republished');
    await cleanupScenario(byeLottery);
  } finally {
    await deleteApp(app);
    await f.cleanup();
  }
}

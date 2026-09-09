import assert from 'node:assert/strict';
import {
  buildQualificationSnapshot,
  computeQualificationState,
  serializeQualificationSnapshot,
  validateQualificationSelection,
} from '../../js/match-logic.js';

const finishedSets = [{ a: 10, b: 8 }, { a: 10, b: 8 }];

function fixture({
  teams = ['a', 'b', 'c'],
  pairs = [['a', 'b'], ['a', 'c'], ['b', 'c']],
  secondGroup = false,
  score = finishedSets,
  qualifyPerGroup = 2,
} = {}) {
  const groups = [{ id: 'g1', division: 'men', matchMode: 'roundrobin' }];
  const allTeams = teams.map((id) => ({ id, division: 'men', groupId: 'g1', name: id }));
  if (secondGroup) {
    groups.push({ id: 'g2', division: 'men', matchMode: 'roundrobin' });
    allTeams.push(
      { id: 'd', division: 'men', groupId: 'g2', name: 'd' },
      { id: 'e', division: 'men', groupId: 'g2', name: 'e' },
      { id: 'f', division: 'men', groupId: 'g2', name: 'f' },
    );
  }
  const matches = pairs.map(([teamA, teamB], index) => ({
    id: `m${index}`, division: 'men', groupId: 'g1', teamA, teamB,
    sets: score, status: 'done', officialCurrent: true, officialRevision: 1,
  }));
  if (secondGroup) {
    matches.push({
      id: 'm-second', division: 'men', groupId: 'g2', teamA: 'd', teamB: 'e',
      sets: score, status: 'done', officialCurrent: true, officialRevision: 1,
    });
  }
  return buildQualificationSnapshot({
    division: 'men',
    qualifyPerGroup,
    groups,
    teams: allTeams,
    matches,
  });
}

function runQualificationUnitSuite() {
  const complete = computeQualificationState(fixture());
  assert.equal(complete.ready, true);
  assert.equal(complete.requiredCount, 2);
  assert.deepEqual(complete.groups[0].automaticIds, ['a', 'b']);
  assert.deepEqual(complete.groups[0].cutoffCandidateIds, []);
  assert.deepEqual(complete.groups[0].cutoffSlots, 0);
  const emptyGroup = fixture();
  emptyGroup.groups.push({ id: 'empty', division: 'men', matchMode: 'roundrobin' });
  assert.equal(computeQualificationState(emptyGroup).ready, true, 'truly empty groups are ignored');
  emptyGroup.matches.push({ ...emptyGroup.matches[0], id: 'orphan-game', groupId: 'empty' });
  const orphanState = computeQualificationState(emptyGroup);
  assert.equal(orphanState.ready, false, 'games in a group without members cannot disappear from qualification');
  assert.ok(orphanState.blockers.some((blocker) => blocker.startsWith('empty_group_games:')));
  assert.deepEqual(validateQualificationSelection(complete, ['a', 'b'], {}), {
    ok: true,
    errors: [],
  });
  const highCount = computeQualificationState(fixture({ teams: ['a', 'b'], pairs: [['a', 'b']], qualifyPerGroup: 64 }));
  assert.equal(highCount.ready, true);
  assert.equal(highCount.groups[0].requiredCount, 2);
  assert.equal(validateQualificationSelection(highCount, ['a', 'b'], {}).ok, true);

  const cosmetic = fixture();
  cosmetic.teams[0].name = 'renamed';
  cosmetic.groups[0].name = 'display-only';
  assert.equal(
    serializeQualificationSnapshot(cosmetic),
    serializeQualificationSnapshot(fixture()),
    'cosmetic fields are not part of the qualification fingerprint',
  );
  const transitionChanged = fixture();
  transitionChanged.matches[0].lastTransitionId = 'server:changed';
  assert.notEqual(
    serializeQualificationSnapshot(transitionChanged),
    serializeQualificationSnapshot(fixture()),
    'official transition changes are part of the qualification fingerprint',
  );

  const incomplete = computeQualificationState(fixture({ secondGroup: true }));
  assert.equal(incomplete.ready, false);
  assert.ok(incomplete.blockers.some((blocker) => blocker.startsWith('missing_game:')));
  assert.ok(incomplete.blockers.some((blocker) => blocker.startsWith('schedule_size:')));

  const tie = computeQualificationState(fixture({
    score: [{ a: 10, b: 8 }, { a: 8, b: 10 }],
  }));
  assert.equal(tie.ready, true);
  assert.equal(tie.groups[0].cutoffSlots, 2);
  assert.deepEqual(tie.groups[0].cutoffCandidateIds.sort(), ['a', 'b', 'c']);
  assert.deepEqual(validateQualificationSelection(tie, ['a', 'b'], { g1: ['a', 'b'] }), {
    ok: true,
    errors: [],
  });
  assert.equal(validateQualificationSelection(tie, ['a'], { g1: ['a'] }).ok, false);
  assert.equal(validateQualificationSelection(complete, ['a', 'c'], {}).ok, false);
  assert.equal(validateQualificationSelection(complete, ['b'], {}).ok, false);

  const duplicate = fixture();
  duplicate.matches.push({ ...duplicate.matches[0], id: 'duplicate', teamA: 'a', teamB: 'b' });
  const duplicateState = computeQualificationState(duplicate);
  assert.ok(duplicateState.blockers.some((blocker) => blocker.startsWith('duplicate_game:')));

  const retracted = fixture();
  retracted.matches[0].officialCurrent = false;
  assert.equal(computeQualificationState(retracted).ready, false);

  const foreign = fixture();
  foreign.teams[0].division = 'women';
  assert.equal(computeQualificationState(foreign).ready, false);
  assert.ok(foreign.teams[0].id);

  console.log('qualification unit fixtures passed');
}

runQualificationUnitSuite();

export { runQualificationUnitSuite };

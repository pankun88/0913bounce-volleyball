import assert from 'node:assert/strict';
import {
  getSetWinner,
  evaluatePrelimMatch,
  evaluateFinalMatch,
  computeGroupStandings,
} from './match-logic.js';
import { generateBracket, recordMatchResult, groupByRound, seedOrder, nextPowerOfTwo } from './bracket.js';
import { generateRoundRobin } from './schedule.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', label); }
}

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

// ---- evaluatePrelimMatch ----
let r = evaluatePrelimMatch([{ a: 10, b: 5 }, { a: 8, b: 10 }]);
check('prelim 1-1 draw', r.result === 'draw' && r.status === 'done');

r = evaluatePrelimMatch([{ a: 10, b: 5 }, { a: 10, b: 6 }]);
check('prelim 2-0 A win', r.result === 'A' && r.status === 'done');

r = evaluatePrelimMatch([{ a: 10, b: 5 }]);
check('prelim 1 set only -> in_progress', r.status === 'in_progress' && r.result === null);

r = evaluatePrelimMatch([]);
check('prelim no sets -> pending', r.status === 'pending');

// ---- evaluateFinalMatch ----
r = evaluateFinalMatch([{ a: 10, b: 5 }, { a: 10, b: 6 }]);
check('final 2-0 A win, no 3rd set needed', r.winner === 'A' && r.status === 'done' && r.setsWonA === 2);

r = evaluateFinalMatch([{ a: 10, b: 5 }, { a: 8, b: 10 }, { a: 7, b: 2 }]);
check('final 1-1 then 3rd set 7pt A win', r.winner === 'A' && r.setsWonA === 2 && r.setsWonB === 1);

r = evaluateFinalMatch([{ a: 10, b: 5 }, { a: 8, b: 10 }, { a: 6, b: 5 }]);
check('final 3rd set not yet decided (6:5 target7)', r.status === 'in_progress' && r.winner === null);

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
check('8 teams -> 7 real matches + 1 third place = 8', m8.length === 8);
check('no byes among 8 teams', m8.filter((m) => m.status === 'bye').length === 0);

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
let third = m8.find((m) => m.id === 'm_third');
check('3rd place match filled after semis', third.teamA && third.teamB);
let final = m8.find((m) => m.round === 3 && !m.isThirdPlace);
check('final filled after semis', final.teamA && final.teamB);
recordMatchResult(m8, final.id, [{ a: 10, b: 5 }, { a: 10, b: 5 }], evaluateFinalMatch);
check('final done', final.status === 'done' && final.winnerTeam);

// ---- bracket: 6 teams -> 2 byes ----
const teams6 = Array.from({ length: 6 }, (_, i) => ({ id: `S${i + 1}`, name: `${i + 1}시드` }));
let { matches: m6, bracketSize: bs6 } = generateBracket(teams6);
check('6 teams -> bracketSize 8', bs6 === 8);
const byeMatches = m6.filter((m) => m.status === 'bye');
check('6 teams -> 2 bye matches', byeMatches.length === 2);
check('top 2 seeds get byes', byeMatches.some((m) => m.winnerTeam.id === 'S1') && byeMatches.some((m) => m.winnerTeam.id === 'S2'));
const round2of6 = m6.filter((m) => m.round === 2);
check('round2 has seed1/seed2 already placed via bye propagation', round2of6.some((m) => m.teamA?.id === 'S1' || m.teamB?.id === 'S1'));

// ---- bracket: 5 teams -> totalRounds & byes ----
const teams5 = Array.from({ length: 5 }, (_, i) => ({ id: `Q${i + 1}`, name: `${i + 1}` }));
let { matches: m5, bracketSize: bs5, totalRounds: tr5 } = generateBracket(teams5);
check('5 teams -> bracketSize 8', bs5 === 8);
check('5 teams -> 3 byes', m5.filter((m) => m.status === 'bye').length === 3);

// ---- bracket: 32 teams (max) ----
const teams32 = Array.from({ length: 32 }, (_, i) => ({ id: `Z${i + 1}`, name: `${i + 1}` }));
let { matches: m32, bracketSize: bs32, totalRounds: tr32 } = generateBracket(teams32);
check('32 teams -> bracketSize 32', bs32 === 32);
check('32 teams -> totalRounds 5', tr32 === 5);
check('32 teams -> no byes', m32.filter((m) => m.status === 'bye').length === 0);
check('32 teams -> 31 matches + 3rd place = 32', m32.length === 32);

// ---- groupByRound ----
const { rounds, thirdPlace } = groupByRound(m8);
check('groupByRound returns 3 rounds for 8 teams', rounds.length === 3);
check('groupByRound finds third place match', thirdPlace && thirdPlace.id === 'm_third');
check('round labels correct', rounds[0].label === '준결승' || rounds[0].label === '8강' || rounds[0].label === '준결승');

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
  // each team plays exactly n-1 matches
  const playCount = {};
  ids.forEach((id) => (playCount[id] = 0));
  rr.forEach((m) => { playCount[m.teamA]++; playCount[m.teamB]++; });
  const allCorrect = ids.every((id) => playCount[id] === n - 1);
  check(`roundRobin(${n}) each team plays ${n - 1} matches`, allCorrect);
}
[3, 4, 5, 6, 7].forEach(validateRoundRobin);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

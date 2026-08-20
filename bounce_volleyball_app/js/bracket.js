/**
 * 본선 토너먼트 대진표 생성 / 진행 로직
 * - 가변 팀 수(2~32팀) 지원, 표준 시드 배정 + 부전승(BYE) 자동 처리
 * - 3·4위전(준결승 패자전) 자동 생성
 */

export function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** 표준 토너먼트 시드 배정 순서 (1번 시드가 배열 첫 칸) */
export function seedOrder(n) {
  if (n === 1) return [1];
  const prev = seedOrder(n / 2);
  const result = [];
  prev.forEach((s) => {
    result.push(s);
    result.push(n + 1 - s);
  });
  return result;
}

export function roundLabel(matchCountInRound) {
  if (matchCountInRound === 1) return '결승';
  if (matchCountInRound === 2) return '준결승';
  return `${matchCountInRound * 2}강`;
}

/**
 * @param {{id:string,name:string}[]} teamsInSeedOrder 시드 1번부터 순서대로
 * @returns {{matches: object[], bracketSize:number, totalRounds:number}}
 */
export function generateBracket(teamsInSeedOrder) {
  const n = teamsInSeedOrder.length;
  if (n < 2) throw new Error('본선 진출팀은 최소 2팀 이상이어야 합니다.');
  if (n > 32) throw new Error('본선 진출팀은 최대 32팀까지 지원합니다.');

  const size = nextPowerOfTwo(n);
  const order = seedOrder(size);
  const slots = order.map((seed) => (seed <= n ? teamsInSeedOrder[seed - 1] : null));
  const totalRounds = Math.log2(size);

  const matches = [];

  // Round 1
  for (let i = 0; i < size / 2; i++) {
    const teamA = slots[i * 2] || null;
    const teamB = slots[i * 2 + 1] || null;
    const isBye = !teamA || !teamB;
    matches.push({
      id: `m_r1_${i}`,
      round: 1,
      roundLabel: roundLabel(size / 2),
      index: i,
      teamA,
      teamB,
      sets: [],
      status: isBye ? 'bye' : 'pending',
      winnerSide: isBye ? (teamA ? 'A' : 'B') : null,
      winnerTeam: isBye ? (teamA || teamB) : null,
      nextMatchId: totalRounds > 1 ? `m_r2_${Math.floor(i / 2)}` : null,
      nextSlot: i % 2 === 0 ? 'A' : 'B',
      thirdPlaceSlot: totalRounds === 1 ? null : (totalRounds - 1 === 1 ? (i % 2 === 0 ? 'A' : 'B') : null),
    });
  }

  // Round 2..totalRounds
  for (let r = 2; r <= totalRounds; r++) {
    const count = size / Math.pow(2, r);
    for (let i = 0; i < count; i++) {
      matches.push({
        id: `m_r${r}_${i}`,
        round: r,
        roundLabel: roundLabel(count),
        index: i,
        teamA: null,
        teamB: null,
        sets: [],
        status: 'waiting',
        winnerSide: null,
        winnerTeam: null,
        nextMatchId: r < totalRounds ? `m_r${r + 1}_${Math.floor(i / 2)}` : null,
        nextSlot: i % 2 === 0 ? 'A' : 'B',
        // 준결승 라운드(totalRounds-1)인 경기는 패자를 3,4위전으로 보냄
        thirdPlaceSlot: r === totalRounds - 1 ? (i % 2 === 0 ? 'A' : 'B') : null,
      });
    }
  }

  // 3,4위전 (준결승이 존재할 때만, 즉 totalRounds >= 2)
  if (totalRounds >= 2) {
    matches.push({
      id: 'm_third',
      round: totalRounds,
      roundLabel: '3·4위전',
      index: 0,
      teamA: null,
      teamB: null,
      sets: [],
      status: 'waiting',
      winnerSide: null,
      winnerTeam: null,
      nextMatchId: null,
      nextSlot: null,
      isThirdPlace: true,
      thirdPlaceSlot: null,
    });
  }

  propagateByes(matches);

  return { matches, bracketSize: size, totalRounds };
}

function indexById(matches) {
  return Object.fromEntries(matches.map((m) => [m.id, m]));
}

function propagateByes(matches) {
  const byId = indexById(matches);
  matches
    .filter((m) => m.status === 'bye')
    .forEach((m) => pushWinnerForward(m, byId));
}

function pushWinnerForward(match, byId) {
  if (match.nextMatchId) {
    const next = byId[match.nextMatchId];
    if (next) {
      if (match.nextSlot === 'A') next.teamA = match.winnerTeam;
      else next.teamB = match.winnerTeam;
      if (next.teamA && next.teamB && next.status === 'waiting') next.status = 'pending';
    }
  }
}

/**
 * 경기 결과(세트 점수)를 반영하고, 승자를 다음 라운드/3,4위전으로 전파한다.
 * @param {object[]} matches generateBracket()이 만든 매치 배열 (변형됨, 동일 참조 반환)
 * @param {string} matchId 결과를 입력할 매치 id
 * @param {{a:number,b:number}[]} sets 세트 점수
 * @param {function} evaluateFn evaluateFinalMatch (match-logic.js)
 */
export function recordMatchResult(matches, matchId, sets, evaluateFn) {
  const byId = indexById(matches);
  const match = byId[matchId];
  if (!match) return matches;

  const evald = evaluateFn(sets);
  match.sets = sets;

  if (evald.status === 'done') {
    match.status = 'done';
    match.winnerSide = evald.winner;
    match.winnerTeam = evald.winner === 'A' ? match.teamA : match.teamB;
    const loserTeam = evald.winner === 'A' ? match.teamB : match.teamA;

    pushWinnerForward(match, byId);

    if (match.thirdPlaceSlot) {
      const third = byId['m_third'];
      if (third) {
        if (match.thirdPlaceSlot === 'A') third.teamA = loserTeam;
        else third.teamB = loserTeam;
        if (third.teamA && third.teamB && third.status === 'waiting') third.status = 'pending';
      }
    }
  } else {
    match.status = evald.status; // 'pending' | 'in_progress'
  }

  return matches;
}

/** 라운드별로 매치를 그룹화 (대진표 렌더링용, 3,4위전은 별도 반환) */
export function groupByRound(matches) {
  const rounds = {};
  let thirdPlace = null;
  matches.forEach((m) => {
    if (m.isThirdPlace) { thirdPlace = m; return; }
    rounds[m.round] = rounds[m.round] || [];
    rounds[m.round].push(m);
  });
  const roundNumbers = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  const orderedRounds = roundNumbers.map((r) => ({
    round: r,
    label: rounds[r][0].roundLabel,
    matches: rounds[r].sort((a, b) => a.index - b.index),
  }));
  return { rounds: orderedRounds, thirdPlace };
}

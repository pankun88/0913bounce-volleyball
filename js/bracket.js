/**
 * 본선 토너먼트 대진표 생성 / 진행 로직
 * - 가변 팀 수(2~32팀) 지원, 표준 시드 배정 + 부전승(BYE) 자동 처리
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

/**
 * @param {number} matchCountInRound 이 라운드의 경기 수(대진표 슬롯 기준) - 결승/준결승 여부를
 *   판단하는 데 쓴다. 이건 부전승이 있어도 항상 정확하다(부전승도 슬롯은 그대로 차지하므로).
 * @param {number} [realTeamCount] 이 라운드에 실제로 들어오는 팀 수. 1라운드처럼 부전승으로
 *   슬롯이 비어 있을 수 있는 라운드에서만 matchCountInRound*2(=슬롯 수)와 달라진다 - 예를 들어
 *   6팀이 진출하면 대진표는 8슬롯으로 만들어지지만 실제로는 6팀뿐이므로, "8강"이 아니라
 *   실제 참가팀 수를 그대로 쓴 "6강"으로 표시해야 헷갈리지 않는다. 2라운드부터는 부전승이
 *   없어 항상 슬롯 수와 실제 팀 수가 같으므로 이 값을 생략해도 결과가 같다.
 */
export function roundLabel(matchCountInRound, realTeamCount) {
  if (matchCountInRound === 1) return '결승';
  if (matchCountInRound === 2) return '준결승';
  const teamCount = realTeamCount != null ? realTeamCount : matchCountInRound * 2;
  return `${teamCount}강`;
}

/**
 * 조별 순위(1위, 2위, ...) 팀들을 가장 표준적인 방식으로 시드 순서를 만든다.
 * 원칙: 순위가 좋은 팀부터 차례로 좋은 시드 번호를 받는다(1위 전원 -> 2위 전원 -> ...).
 * 표준 토너먼트 시딩 규칙상 앞쪽(좋은) 시드가 부전승을 먼저 받는다.
 *
 * 같은 순위(티어) 안에서는 조 인원수가 많은 조부터 우선해서 좋은(앞쪽) 시드를 받는다 -
 * 즉 조 인원수가 적은 조의 진출팀은 부전승보다 실제 경기를 먼저 배정받고, 그만큼 인원수가
 * 많은 조의 1위가 부전승을 우선적으로 받는다. (조 인원수가 모두 같으면 조 순서 그대로
 * 유지되어 기존과 동일하게 동작한다.) 어떤 조 구성이든(조 수, 조별 인원수 무관) 그대로
 * 적용되는 일반 규칙이며, 특정 인원수에 맞춰 하드코딩되어 있지 않다.
 * 예: 4팀·4팀·3팀 3개 조에서 2위까지 진출하면, 3팀 조의 진출팀들이 다른 조의 2위들과
 * 실제 경기를 치르고, 4팀 조 두 곳의 1위가 부전승을 받는다.
 *
 * 다만, 같은 조에서 올라온 두 팀(예: A조 1위와 A조 2위)이 조별리그에서 이미 만났는데
 * 1라운드에서 곧바로 다시 만나는 것은 피하는 게 일반적인 토너먼트 구성 관례이므로,
 * 그런 경우에만 같은 순위(티어) 안에서 자리를 바꿔 충돌을 없앤다. 이때도 위의 부전승
 * 우선순위(조 인원수)가 불필요하게 흔들리지 않도록, 부전승이 아닌 실제 경기 자리끼리
 * 먼저 자리를 바꿔보고, 그래도 해소가 안 될 때만 부전승 자리까지 포함해 바꾼다.
 * @param {{teamId:string, groupId:string, groupSize?:number}[][]} tiers tiers[0]=1위 목록, tiers[1]=2위 목록, ... (조 순서대로)
 * @returns {string[]} 시드 1번부터의 팀 id 순서
 */
export function buildCrossGroupSeedOrder(tiers) {
  const nonEmptyTiers = (tiers || []).filter((t) => t && t.length);
  if (nonEmptyTiers.length <= 1) {
    return nonEmptyTiers.flat().map((e) => e.teamId);
  }

  const totalSeeds = nonEmptyTiers.reduce((sum, t) => sum + t.length, 0);
  const size = nextPowerOfTwo(totalSeeds);
  const partnerOf = (s) => size + 1 - s; // 시드 s가 1라운드에서 만날 수 있는 상대 시드 번호
  const sizeOf = (entry) => (Number.isFinite(entry.groupSize) ? entry.groupSize : 0);
  const isRealMatchSeed = (s) => { const p = partnerOf(s); return p >= 1 && p <= totalSeeds; };

  // 1) 표준 배정: 순위가 좋은 팀부터(1위 전원 -> 2위 전원 -> ...) 차례로 시드 번호를 받는다.
  //    각 티어 안에서는 조 인원수가 많은 조부터 앞쪽 자리를 받도록 정렬한다(인원수가 같으면
  //    조 순서 그대로 - groupSize 정보가 없을 때도 전부 0으로 취급되어 기존과 동일하게 동작).
  const seeds = new Array(totalSeeds + 1).fill(null); // 1-indexed
  const tierRanges = []; // 각 티어가 차지하는 시드 번호 [시작, 끝] (같은 티어 내 스왑용)
  let cursor = 1;
  nonEmptyTiers.forEach((tier) => {
    const sortedTier = tier.slice().sort((a, b) => sizeOf(b) - sizeOf(a));
    const start = cursor;
    sortedTier.forEach((entry) => { seeds[cursor] = entry; cursor++; });
    tierRanges.push([start, cursor - 1]);
  });
  const tierRangeOf = (s) => tierRanges.find(([a, b]) => s >= a && s <= b);

  // 2) 같은 조 팀끼리 1라운드에서 곧바로 다시 만나는 실제 경기(부전승이 아닌 경우)만,
  //    같은 티어 안에서 다른 팀과 자리를 바꿔 피한다. 후보는 s가 속한 티어와 상대(p)가 속한
  //    티어 양쪽에서 찾되, 부전승이 아닌(실제 경기) 자리에 있는 후보를 먼저 시도해 위 1)에서
  //    정한 부전승 우선순위가 가능한 한 그대로 유지되게 한다.
  for (let s = 1; s <= totalSeeds; s++) {
    const p = partnerOf(s);
    if (p <= s || p > totalSeeds) continue; // 이미 처리했거나, 상대가 없는(부전승) 자리
    if (seeds[s].groupId !== seeds[p].groupId) continue; // 충돌 없음

    const [sStart, sEnd] = tierRangeOf(s);
    const [pStart, pEnd] = tierRangeOf(p);
    const candidates = [];
    for (let cand = pStart; cand <= pEnd; cand++) if (cand !== p) candidates.push({ side: 'p', cand });
    for (let cand = sStart; cand <= sEnd; cand++) if (cand !== s) candidates.push({ side: 's', cand });
    // 부전승이 아닌(실제 경기) 자리에 있는 후보를 먼저 시도한다 (안정 정렬이라 같은 우선도
    // 안에서는 원래 순서, 즉 p쪽 후보 -> s쪽 후보 순서가 유지된다).
    candidates.sort((a, b) => (isRealMatchSeed(b.cand) ? 1 : 0) - (isRealMatchSeed(a.cand) ? 1 : 0));

    for (const { side, cand } of candidates) {
      const candPartner = partnerOf(cand);
      const candPartnerEntry = isRealMatchSeed(cand) ? seeds[candPartner] : null;
      if (side === 'p') {
        // p 자리와 cand 자리를 맞바꾼다 (s는 그대로) - p의 새 상대는 여전히 s.
        const okForP = seeds[cand].groupId !== seeds[s].groupId;
        const okForCand = !candPartnerEntry || seeds[p].groupId !== candPartnerEntry.groupId;
        if (okForP && okForCand) {
          const tmp = seeds[p];
          seeds[p] = seeds[cand];
          seeds[cand] = tmp;
          break;
        }
      } else {
        // s 자리와 cand 자리를 맞바꾼다 (p는 그대로) - s의 새 상대는 여전히 p.
        const okForS = seeds[cand].groupId !== seeds[p].groupId;
        const okForCand = !candPartnerEntry || seeds[s].groupId !== candPartnerEntry.groupId;
        if (okForS && okForCand) {
          const tmp = seeds[s];
          seeds[s] = seeds[cand];
          seeds[cand] = tmp;
          break;
        }
      }
    }
    // 양쪽 티어에서 모두 못 찾으면(매우 드문 경우) 그대로 둔다 - 표준 시딩 순서를 더 우선한다.
  }

  const result = [];
  for (let s = 1; s <= totalSeeds; s++) result.push(seeds[s].teamId);
  return result;
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
  // 부전승(한쪽 팀이 없는 1라운드 경기)은 대진표 생성 시 자동으로 채우거나 확정하지 않는다.
  // 어느 팀에게 부전승을 줄지는 관리자가 "미배정 팀" 목록에서 직접 골라 배치해야 하므로
  // (placeByeTeam), 일단 teamA/teamB를 모두 비워 둔 'empty'(미배정) 상태로만 만들어 두고,
  // 원래 이 자리를 차지했을 후보 팀 정보만 byeCandidate에 기록해 둔다(목록 표시용).
  // 배치(placeByeTeam) 후에는 'bye_pending'(확정 대기)이 되고, 다음 라운드로의 실제 전파는
  // 그 뒤 confirmBye가 호출되기 전까지 일어나지 않는다.
  for (let i = 0; i < size / 2; i++) {
    const slotA = slots[i * 2] || null;
    const slotB = slots[i * 2 + 1] || null;
    const isBye = !slotA || !slotB;
    const byeCandidate = isBye
      ? (slotA ? { team: slotA, side: 'A' } : (slotB ? { team: slotB, side: 'B' } : null))
      : null;
    matches.push({
      id: `m_r1_${i}`,
      round: 1,
      roundLabel: roundLabel(size / 2, n),
      index: i,
      teamA: isBye ? null : slotA,
      teamB: isBye ? null : slotB,
      sets: [],
      status: byeCandidate ? 'empty' : (isBye ? 'waiting' : 'pending'),
      winnerSide: null,
      winnerTeam: null,
      byeCandidate,
      nextMatchId: totalRounds > 1 ? `m_r2_${Math.floor(i / 2)}` : null,
      nextSlot: i % 2 === 0 ? 'A' : 'B',
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
        byeCandidate: null,
        nextMatchId: r < totalRounds ? `m_r${r + 1}_${Math.floor(i / 2)}` : null,
        nextSlot: i % 2 === 0 ? 'A' : 'B',
      });
    }
  }

  // 생성 직후에는 모든 부전승 자리가 'empty'(미배정)이므로, confirmBye로 확정된 부전승이 하나도 없어 전파할 것이 없다.

  return { matches, bracketSize: size, totalRounds };
}

function indexById(matches) {
  return Object.fromEntries(matches.map((m) => [m.id, m]));
}

/**
 * 1라운드 이후의 모든 경기를 초기 상태로 되돌린 뒤, 1라운드(부전승 포함) 결과를 다시 한 번
 * 다음 라운드로 전파한다. 1라운드 자리바꿈(swapFinalSeedSlots) 직후, 이미 자동 전파되어 있던
 * 부전승 진출 결과를 깨끗하게 다시 계산하기 위해 쓴다.
 * (이 함수를 부르기 전에 호출자가 1라운드 매치들의 teamA/teamB/status/winnerSide/winnerTeam을
 *  이미 새 자리배치에 맞게 갱신해 둔 상태여야 한다)
 */
export function resetAndPropagateByes(matches) {
  matches.forEach((m) => {
    if (m.round > 1) {
      m.teamA = null;
      m.teamB = null;
      m.status = 'waiting';
      m.sets = [];
      m.winnerSide = null;
      m.winnerTeam = null;
    }
  });
  propagateByes(matches);
  return matches;
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
 * '미배정'(status: 'empty') 상태인 1라운드 자리에, 그 자리의 원래 후보 팀(byeCandidate)을
 * 실제로 배치해 '확정 대기'(bye_pending) 상태로 만든다. 부전승은 더 이상 대진표 생성 시
 * 자동으로 채워지지 않으므로, 관리자가 "미배정 팀" 목록에서 이 함수를 호출해야만 그 팀이
 * 대진표에 나타난다. 다음 라운드로의 실제 진출 확정은 이후 별도로 confirmBye를 호출해야 한다.
 * @param {object[]} matches generateBracket() 결과(또는 Firestore에서 읽은 동일 구조) - 직접 변형됨
 * @param {string} matchId 배치할 매치 id
 * @returns {{ok:boolean, reason?:string}} 실패 시 reason: 'NOT_FOUND'|'NOT_EMPTY'
 */
export function placeByeTeam(matches, matchId) {
  const byId = indexById(matches);
  const match = byId[matchId];
  if (!match) return { ok: false, reason: 'NOT_FOUND' };
  if (match.status !== 'empty' || !match.byeCandidate) return { ok: false, reason: 'NOT_EMPTY' };

  const { team, side } = match.byeCandidate;
  if (side === 'A') match.teamA = team; else match.teamB = team;
  match.status = 'bye_pending';
  match.byeCandidate = null;

  return { ok: true };
}

/**
 * 확정 대기('bye_pending') 상태인 1라운드 경기를, 관리자가 직접 "부전승 확정"을 눌렀을 때
 * 실제로 부전승 처리한다(status: 'bye'로 바꾸고, 남아 있는 팀을 다음 라운드로 전파).
 * 부전승은 더 이상 generateBracket()이나 자리 교체에서 자동으로 확정되지 않으므로,
 * 이 함수를 통한 명시적인 호출만이 유일한 확정 경로다.
 * @param {object[]} matches generateBracket() 결과(또는 Firestore에서 읽은 동일 구조) - 직접 변형됨
 * @param {string} matchId 확정할 매치 id
 * @returns {{ok:boolean, reason?:string}} 실패 시 reason: 'NOT_FOUND'|'NOT_BYE_PENDING'
 */
export function confirmBye(matches, matchId) {
  const byId = indexById(matches);
  const match = byId[matchId];
  if (!match) return { ok: false, reason: 'NOT_FOUND' };
  if (match.status !== 'bye_pending') return { ok: false, reason: 'NOT_BYE_PENDING' };

  const winnerSide = match.teamA ? 'A' : 'B';
  match.status = 'bye';
  match.winnerSide = winnerSide;
  match.winnerTeam = match.teamA || match.teamB;

  pushWinnerForward(match, byId);
  return { ok: true };
}

/**
 * 경기 결과(세트 점수)를 반영하고, 승자를 다음 라운드로 전파한다.
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

    pushWinnerForward(match, byId);
  } else {
    match.status = evald.status; // 'pending' | 'in_progress'
  }

  return matches;
}

/**
 * 이미 생성된 본선 대진표에서, 아직 경기가 시작되지 않은 1라운드 두 자리(팀)를 서로 바꾼다.
 * 표준 시딩으로 자동 배정된 자리를 관리자가 직접 조정하거나, 부전승을 다른 팀에게
 * 주고 싶을 때(부전승 자리로 팀을 끌어다 놓으면, 원래 부전승이던 팀이 그 팀의 옛 상대와
 * 맞붙게 된다) 쓴다.
 * @param {object[]} matches generateBracket() 결과(또는 Firestore에서 읽은 동일 구조) - 직접 변형됨
 * @param {{matchId:string, side:'A'|'B'}} slotA
 * @param {{matchId:string, side:'A'|'B'}} slotB
 * @returns {{ok:boolean, reason?:string}} 실패 시 reason:
 *   'NOT_FOUND'|'ROUND1_ONLY'|'UNASSIGNED_SLOT'|'ALREADY_STARTED'|'SAME_SLOT'|'EMPTY_MATCH'
 */
export function swapFinalSeedSlots(matches, slotA, slotB) {
  const byId = indexById(matches);
  const mA = byId[slotA && slotA.matchId];
  const mB = byId[slotB && slotB.matchId];
  if (!mA || !mB) return { ok: false, reason: 'NOT_FOUND' };
  if (mA.round !== 1 || mB.round !== 1) return { ok: false, reason: 'ROUND1_ONLY' };
  // 미배정(empty) 자리는 아직 후보 팀이 배치되지 않은 상태이므로 자리 교체 대상이 될 수 없다.
  // (관리자가 "미배정 팀" 목록에서 placeByeTeam으로 먼저 배치해야 한다)
  if (mA.status === 'empty' || mB.status === 'empty') return { ok: false, reason: 'UNASSIGNED_SLOT' };

  // 부전승을 확정(confirmBye)하면 다음 라운드까지 전파되므로, 점수가 입력된 경기와 마찬가지로
  // 이미 진행된 결과로 취급해 자리 교체를 막는다. 아직 확정 전인 'bye_pending'은 막지 않는다.
  const hasAnyResult = matches.some(
    (m) => (m.sets && m.sets.length) || m.status === 'done' || m.status === 'in_progress' || m.status === 'bye'
  );
  if (hasAnyResult) return { ok: false, reason: 'ALREADY_STARTED' };

  const getTeam = (m, side) => (side === 'A' ? m.teamA : m.teamB);
  const setTeam = (m, side, team) => { if (side === 'A') m.teamA = team; else m.teamB = team; };
  const otherSide = (side) => (side === 'A' ? 'B' : 'A');

  if (mA === mB) {
    if (slotA.side === slotB.side) return { ok: false, reason: 'SAME_SLOT' };
    const tmp = mA.teamA;
    mA.teamA = mA.teamB;
    mA.teamB = tmp;
  } else {
    const teamX = getTeam(mA, slotA.side);
    const teamY = getTeam(mB, slotB.side);
    const otherA = getTeam(mA, otherSide(slotA.side));
    const otherB = getTeam(mB, otherSide(slotB.side));
    // 자리를 바꾼 뒤 한쪽 경기가 양쪽 모두 빈 자리가 되면(=경기 자체가 성립하지 않음) 막는다.
    if (!otherA && !teamY) return { ok: false, reason: 'EMPTY_MATCH' };
    if (!otherB && !teamX) return { ok: false, reason: 'EMPTY_MATCH' };

    setTeam(mA, slotA.side, teamY);
    setTeam(mB, slotB.side, teamX);
  }

  [mA, mB].forEach((m) => {
    const isBye = !m.teamA || !m.teamB;
    // 자리를 바꾼 결과 한쪽이 비더라도 자동으로 부전승을 확정하지 않는다.
    // 'bye_pending'(확정 대기)으로만 두고, 실제 확정은 confirmBye를 통해 관리자가 직접 한다.
    m.status = isBye ? 'bye_pending' : 'pending';
    m.winnerSide = null;
    m.winnerTeam = null;
    m.sets = [];
  });

  resetAndPropagateByes(matches);
  return { ok: true };
}

/** 라운드별로 매치를 그룹화한다 (대진표 렌더링용). 옛 데이터에 3·4위전이 남아있다면 무시한다. */
export function groupByRound(matches) {
  const rounds = {};
  matches.forEach((m) => {
    if (m.isThirdPlace) return; // 더 이상 생성하지 않지만, 과거에 저장된 데이터는 무시하고 건너뜀
    rounds[m.round] = rounds[m.round] || [];
    rounds[m.round].push(m);
  });
  const roundNumbers = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  const orderedRounds = roundNumbers.map((r) => ({
    round: r,
    label: rounds[r][0].roundLabel,
    matches: rounds[r].sort((a, b) => a.index - b.index),
  }));
  return { rounds: orderedRounds };
}

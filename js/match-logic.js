/**
 * 바운스발리볼 경기 판정 / 순위 / 통계 로직
 * 경기규칙.md 기준:
 *  - 예선: 2세트제. 1~2세트 10점. 1팀씩 세트를 가져가면(1:1) 무승부.
 *  - 본선(토너먼트): 3세트제. 1~2세트 10점, 3세트 7점. 2세트 먼저 가져가면 종료.
 *  - 듀스: 2점차 승리, 15점 상한(도달 시 즉시 종료, 그 시점 점수가 높은 팀 승).
 *  - 예선 순위: 승점(승3/무1/패0) - 세트득실 - 득실차 - 승자승 - (동률 시 추첨, 관리자 수동결정)
 *
 * 이 파일은 브라우저(ESM)와 Node(테스트) 양쪽에서 동작하도록 작성됨.
 */

// ---------- 세트 단위 판정 ----------

/**
 * 한 세트의 승자를 판정한다.
 * @param {number} a A팀 점수
 * @param {number} b B팀 점수
 * @param {number} target 해당 세트의 기본 목표 점수 (10 또는 7)
 * @returns {'A'|'B'|null} null이면 아직 진행중(미종료)
 */
export function getSetWinner(a, b, target) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a < 0 || b < 0 || a > 15 || b > 15) return null;
  const hi = Math.max(a, b);
  if (hi < target) return null; // 목표 점수 미달 -> 진행중

  if (hi >= 15) {
    // 15점 상한 도달 -> 즉시 종료, 동점이면 판정 불가(잘못된 입력)
    if (a === b) return null;
    return a > b ? 'A' : 'B';
  }

  if (Math.abs(a - b) >= 2) {
    return a > b ? 'A' : 'B';
  }

  return null; // 듀스 진행중
}

/** 세트가 아직 진행 중(미완료)인지 여부 - 둘 다 0이면 미입력으로 간주 */
export function isSetEmpty(set) {
  return !set || (set.a === 0 && set.b === 0);
}

/**
 * 한 세트에 입력된 점수가 경기규칙(상한 15점, 듀스 2점차)에 맞고, 승부가 실제로 끝난
 * 점수인지 검사한다. 이 프로그램은 경기가 모두 끝난 뒤 최종 점수만 한 번에 입력받는
 * 방식으로 쓰이므로("실시간 중계 입력"이 아님), 아직 승부가 나지 않은 점수(목표 점수
 * 미달, 또는 듀스 중이라 2점차가 안 난 상태)는 "진행중"이 아니라 잘못 입력된 값으로
 * 간주해 저장을 막는다. 단, 아직 한 번도 입력하지 않은 0:0은 예외로 통과시킨다.
 * @param {number} a A팀 점수
 * @param {number} b B팀 점수
 * @param {number} target 해당 세트의 기본 목표 점수 (10 또는 7)
 * @returns {{ok:true}|{ok:false,message:string}}
 */
export function validateSetScore(a, b, target) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    return { ok: false, message: '점수는 정수로 입력해주세요.' };
  }
  const na = a;
  const nb = b;
  if (na < 0 || nb < 0) {
    return { ok: false, message: '점수는 0 이상이어야 합니다.' };
  }
  if (na > 15 || nb > 15) {
    return { ok: false, message: '점수는 15점을 넘을 수 없습니다 (듀스 상한 15점).' };
  }
  if (na === 0 && nb === 0) {
    return { ok: true }; // 아직 입력 안 한 세트
  }

  const hi = Math.max(na, nb);
  const lo = Math.min(na, nb);
  const margin = hi - lo;

  if (hi === 15 && margin === 0) {
    return { ok: false, message: '15점에서는 동점일 수 없습니다.' };
  }
  if (hi === 15 && margin > 2) {
    return { ok: false, message: '듀스 상황에서는 2점차로 끝나야 합니다 (예: 15:13, 15:14).' };
  }
  if (hi > target && hi < 15 && margin !== 2) {
    // 목표 점수를 넘었지만 상한(15) 전인 경우 = 듀스 상황. 2점차가 나는 순간 바로 끝나야 한다.
    return { ok: false, message: `듀스 상황에서는 2점차로 끝나야 합니다 (예: ${hi}:${hi - 2}).` };
  }

  // 위 듀스/상한 조건에 안 걸렸다면, getSetWinner로 실제 승부가 났는지 최종 확인한다.
  // (목표 점수 미달, 또는 목표 점수에 딱 도달했지만 듀스가 아직 안 끝난 경우 등 — 즉
  // "이 세트는 아직 끝나지 않았다"는 모든 경우를 여기서 한 번에 걸러낸다.)
  if (getSetWinner(na, nb, target) === null) {
    return { ok: false, message: '아직 끝나지 않은 세트입니다. 세트가 끝난 최종 점수만 입력해주세요.' };
  }
  return { ok: true };
}

// ---------- 예선 경기 판정 (2세트제) ----------

const PRELIM_TARGET = 10;

function hasSetInput(set) {
  return !isSetEmpty(set);
}

function validSetWinner(set, target) {
  if (isSetEmpty(set) || !validateSetScore(set.a, set.b, target).ok) return null;
  return getSetWinner(set.a, set.b, target);
}

/**
 * 예선 경기 결과를 평가한다.
 * @param {{a:number,b:number}[]} sets 최대 2세트
 * @returns {{
 *   setResults: (('A'|'B'|null)[]),
 *   setsWonA:number, setsWonB:number,
 *   pointsForA:number, pointsForB:number,
 *   status: 'pending'|'in_progress'|'done',
 *   result: 'A'|'B'|'draw'|null
 * }}
 */
export function evaluatePrelimMatch(sets) {
  const supplied = Array.isArray(sets) ? sets : [];
  const trimmed = supplied.slice(0, 2);
  const setResults = trimmed.map((s) => validSetWinner(s, PRELIM_TARGET));
  let setsWonA = 0, setsWonB = 0;
  let pointsForA = 0, pointsForB = 0;
  trimmed.forEach((s, i) => {
    if (setResults[i]) {
      pointsForA += s.a;
      pointsForB += s.b;
    }
    if (setResults[i] === 'A') setsWonA++;
    else if (setResults[i] === 'B') setsWonB++;
  });

  let status = 'pending';
  let result = null;
  const anyInput = supplied.some(hasSetInput);
  if (anyInput) status = 'in_progress';

  if (!supplied.slice(2).some(hasSetInput) && setsWonA + setsWonB === 2) {
    status = 'done';
    if (setsWonA === 2) result = 'A';
    else if (setsWonB === 2) result = 'B';
    else result = 'draw'; // 1:1
  }

  return { setResults, setsWonA, setsWonB, pointsForA, pointsForB, status, result };
}

// ---------- 본선(토너먼트) 경기 판정 (3세트제) ----------

const FINAL_TARGETS = [10, 10, 7];

/**
 * 본선 경기 결과를 평가한다. 2세트를 먼저 이기면 즉시 종료(3세트 불필요).
 * @param {{a:number,b:number}[]} sets 최대 3세트
 */
export function evaluateFinalMatch(sets) {
  const supplied = Array.isArray(sets) ? sets : [];
  const trimmed = supplied.slice(0, 3);
  const setResults = [];
  let setsWonA = 0, setsWonB = 0;
  let pointsForA = 0, pointsForB = 0;
  let hasUnreachableSet = supplied.slice(3).some(hasSetInput);
  let seenEmptySet = false;

  for (let i = 0; i < trimmed.length; i++) {
    const s = trimmed[i];
    if (isSetEmpty(s)) seenEmptySet = true;
    else if (seenEmptySet || setsWonA === 2 || setsWonB === 2) hasUnreachableSet = true;
    const w = validSetWinner(s, FINAL_TARGETS[i]);
    setResults.push(w);
    if (w) {
      pointsForA += s.a;
      pointsForB += s.b;
    }
    if (w === 'A') setsWonA++;
    else if (w === 'B') setsWonB++;
  }

  let status = 'pending';
  const anyInput = supplied.some(hasSetInput);
  if (anyInput) status = 'in_progress';

  let winner = null;
  if (!hasUnreachableSet && (setsWonA === 2 || setsWonB === 2)) {
    status = 'done';
    winner = setsWonA === 2 ? 'A' : 'B';
  }

  return { setResults, setsWonA, setsWonB, pointsForA, pointsForB, status, winner };
}

/** 본선 경기에서 다음 세트가 필요한지(3세트까지 가야 하는지) 판단 */
export function finalNeedsThirdSet(sets) {
  const r = evaluateFinalMatch((sets || []).slice(0, 2));
  return r.setsWonA === 1 && r.setsWonB === 1;
}

/** 제출·저장 전에 본선의 미사용 3세트를 제거하되 2:1 경기는 보존한다. */
export function normalizePlayedSets(sets, final = false) {
  const source = Array.isArray(sets) ? sets.map(({ a, b }) => ({ a, b })) : [];
  if (!final) return source;
  const firstTwo = evaluateFinalMatch(source.slice(0, 2));
  return source.slice(0, firstTwo.setsWonA === 2 || firstTwo.setsWonB === 2 ? 2 : 3);
}

// ---------- 예선 조 순위 산정 ----------

/**
 * 조 순위를 계산한다.
 * @param {{id:string,name:string}[]} teams 해당 조 소속 팀들
 * @param {Array} matches 해당 조의 경기 목록. 각 항목: {teamA, teamB, sets}
 * @returns {Array} 순위 정렬된 통계 배열. 동률 미해소 시 needsLottery 표시.
 */
export function computeGroupStandings(teams, matches) {
  const stats = {};
  teams.forEach((t) => {
    stats[t.id] = {
      teamId: t.id,
      name: t.name,
      played: 0,
      win: 0,
      draw: 0,
      loss: 0,
      points: 0,
      setsWon: 0,
      setsLost: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    };
  });

  const headToHead = {}; // headToHead[a][b] = 'win'|'loss'|'draw' (a팀 기준 결과)

  const scheduledMatches = (matches || []).filter((m) => stats[m.teamA] && stats[m.teamB]);
  const provisional = scheduledMatches.length === 0
    || scheduledMatches.some((m) => evaluatePrelimMatch(m.sets).status !== 'done');

  scheduledMatches.forEach((m) => {
    const evald = evaluatePrelimMatch(m.sets);
    if (evald.status !== 'done') return;

    const sa = stats[m.teamA];
    const sb = stats[m.teamB];
    sa.played++; sb.played++;
    sa.setsWon += evald.setsWonA; sa.setsLost += evald.setsWonB;
    sb.setsWon += evald.setsWonB; sb.setsLost += evald.setsWonA;
    sa.pointsFor += evald.pointsForA; sa.pointsAgainst += evald.pointsForB;
    sb.pointsFor += evald.pointsForB; sb.pointsAgainst += evald.pointsForA;

    if (evald.result === 'A') {
      sa.win++; sa.points += 3; sb.loss++;
      headToHead[m.teamA] = headToHead[m.teamA] || {};
      headToHead[m.teamA][m.teamB] = 'win';
      headToHead[m.teamB] = headToHead[m.teamB] || {};
      headToHead[m.teamB][m.teamA] = 'loss';
    } else if (evald.result === 'B') {
      sb.win++; sb.points += 3; sa.loss++;
      headToHead[m.teamB] = headToHead[m.teamB] || {};
      headToHead[m.teamB][m.teamA] = 'win';
      headToHead[m.teamA] = headToHead[m.teamA] || {};
      headToHead[m.teamA][m.teamB] = 'loss';
    } else if (evald.result === 'draw') {
      sa.draw++; sa.points += 1;
      sb.draw++; sb.points += 1;
      headToHead[m.teamA] = headToHead[m.teamA] || {};
      headToHead[m.teamA][m.teamB] = 'draw';
      headToHead[m.teamB] = headToHead[m.teamB] || {};
      headToHead[m.teamB][m.teamA] = 'draw';
    }
  });

  const list = Object.values(stats).map((s) => ({
    ...s,
    setDiff: s.setsWon - s.setsLost,
    pointDiff: s.pointsFor - s.pointsAgainst,
  }));

  // 1차 정렬: 승점 -> 세트득실 -> 득실차
  list.sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (y.setDiff !== x.setDiff) return y.setDiff - x.setDiff;
    if (y.pointDiff !== x.pointDiff) return y.pointDiff - x.pointDiff;
    return 0;
  });

  // 동률 그룹 탐색 후 승자승 적용, 그래도 안되면 추첨필요 표시
  let i = 0;
  let rank = 1;
  while (i < list.length) {
    let j = i + 1;
    while (
      j < list.length &&
      list[j].points === list[i].points &&
      list[j].setDiff === list[i].setDiff &&
      list[j].pointDiff === list[i].pointDiff
    ) {
      j++;
    }
    const tiedGroup = list.slice(i, j);
    if (tiedGroup.length > 1) {
      resolveHeadToHead(tiedGroup, headToHead);
    }
    let k = 0;
    while (k < tiedGroup.length) {
      let l = k + 1;
      while (l < tiedGroup.length && tiedGroup[l]._h2hOrder === tiedGroup[k]._h2hOrder) l++;
      const sameHeadToHeadGroup = tiedGroup.slice(k, l);
      if (sameHeadToHeadGroup.length > 1) {
        if (!provisional) sameHeadToHeadGroup.forEach((t) => { t.needsLottery = true; });
      }
      sameHeadToHeadGroup.forEach((t) => { t.rank = rank + k; });
      k = l;
    }
    rank += tiedGroup.length;
    i = j;
  }

  return list
    .sort((x, y) => x.rank - y.rank)
    .map((standing) => ({ ...standing, provisional }));
}

/** 동률 팀들 내에서 승자승(상호 전적) 기준으로 재정렬을 시도한다 */
function resolveHeadToHead(tiedGroup, headToHead) {
  // 각 팀의 "동률 그룹 내" 승수를 계산하는 미니리그 방식
  tiedGroup.forEach((t) => {
    let wins = 0;
    tiedGroup.forEach((opp) => {
      if (opp.teamId === t.teamId) return;
      const r = headToHead[t.teamId] && headToHead[t.teamId][opp.teamId];
      if (r === 'win') wins++;
    });
    t._h2hOrder = wins;
  });
  tiedGroup.sort((x, y) => y._h2hOrder - x._h2hOrder);
}

/**
 * 진출 인원 안에 완전히 들어오는 순위 그룹만 자동 진출팀으로 반환한다.
 * 컷오프를 걸치는 공동 순위는 오프라인 추첨 뒤 관리자가 직접 선택해야 한다.
 */
export function computeAutomaticQualifiers(standings, qualificationCount) {
  if ((standings || []).some((standing) => standing.provisional)) return [];
  const cutoff = Math.max(0, Math.floor(Number(qualificationCount) || 0));
  const groupSizes = new Map();
  (standings || []).forEach((standing) => {
    groupSizes.set(standing.rank, (groupSizes.get(standing.rank) || 0) + 1);
  });
  return (standings || []).filter((standing) => (
    standing.rank <= cutoff
    && standing.rank + groupSizes.get(standing.rank) - 1 <= cutoff
  ));
}

// ---------- 예선 진출 검증 (공통 브라우저/서버 로직) ----------

/*
 * Qualification data is deliberately kept separate from display data. The
 * snapshot below contains only identifiers, schedule topology and score
 * revisions/currentness. Names, display order and court assignment fields
 * therefore cannot invalidate an already prepared publication.
 */
function qualificationRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
    return { ...value.data, id: value.id };
  }
  return value;
}

function qualificationId(value) {
  const record = qualificationRecord(value);
  return typeof record.id === 'string' ? record.id : null;
}

function qualificationString(value) {
  return typeof value === 'string' ? value : null;
}

function qualificationNumber(value) {
  return Number.isInteger(value) ? value : (value == null ? null : Number(value));
}

function canonicalQualification(value) {
  if (Array.isArray(value)) return value.map(canonicalQualification);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalQualification(value[key])]),
    );
  }
  return value === undefined ? null : value;
}

function qualificationPairKey(a, b) {
  return [a, b].sort().join('\u0000');
}

function expectedQualificationPairs(group, teamIds) {
  const mode = group.matchMode || group.mode || group.scheduleMode || 'ring';
  if (mode === 'ring') {
    const ringCandidate = Array.isArray(group.ringOrder) && group.ringOrder.length
      ? group.ringOrder
      : [...teamIds];
    const ring = new Set(ringCandidate).size === teamIds.length
      && ringCandidate.every((id) => teamIds.includes(id))
      ? ringCandidate : [...teamIds];
    if (ring.length < 2) return [];
    if (ring.length === 2) return [qualificationPairKey(ring[0], ring[1])];
    return ring.map((id, index) => qualificationPairKey(id, ring[(index + 1) % ring.length]));
  }
  const pairs = [];
  for (let i = 0; i < teamIds.length; i += 1) {
    for (let j = i + 1; j < teamIds.length; j += 1) {
      pairs.push(qualificationPairKey(teamIds[i], teamIds[j]));
    }
  }
  return pairs;
}

function qualificationSets(value) {
  const sets = Array.isArray(value) ? value : [];
  return sets.map((set) => ({
    a: Number.isInteger(set?.a) ? set.a : null,
    b: Number.isInteger(set?.b) ? set.b : null,
  }));
}

function qualificationSnapshotMatch(value) {
  const match = qualificationRecord(value);
  const currentness = match.officialCurrent === undefined
    ? match.current : match.officialCurrent;
  return {
    id: qualificationId(match),
    division: qualificationString(match.division),
    groupId: qualificationString(match.groupId),
    teamA: qualificationString(match.teamA),
    teamB: qualificationString(match.teamB),
    round: qualificationNumber(match.round),
    index: qualificationNumber(match.index),
    sets: qualificationSets(match.sets),
    status: qualificationString(match.status),
    result: qualificationString(match.result),
    winner: qualificationString(match.winner),
    winnerSide: qualificationString(match.winnerSide),
    winnerTeam: qualificationString(match.winnerTeam?.id || match.winnerTeam),
    setsWonA: qualificationNumber(match.setsWonA),
    setsWonB: qualificationNumber(match.setsWonB),
    pointsForA: qualificationNumber(match.pointsForA),
    pointsForB: qualificationNumber(match.pointsForB),
    officialCurrent: currentness === undefined || currentness === null
      ? null : currentness === true ? true : currentness === false ? false : 'invalid',
    dependencyReady: match.dependencyReady === undefined || match.dependencyReady === null
      ? null : match.dependencyReady === true ? true : match.dependencyReady === false ? false : 'invalid',
    retracted: match.retracted === true,
    officialRevision: qualificationNumber(match.officialRevision) ?? 0,
    revision: qualificationNumber(match.revision),
    scoreRevision: qualificationNumber(match.scoreRevision),
    lastTransitionId: qualificationString(match.lastTransitionId),
    transitionId: qualificationString(match.transitionId),
  };
}

/**
 * Build the canonical, cosmetic-free preliminary input for one division.
 *
 * Records may be plain objects or `{id, data: {...}}` Firestore-like records.
 * No validation is performed here; computeQualificationState returns all
 * blockers so callers can present them without partially applying a result.
 */
export function buildQualificationSnapshot({
  division,
  qualifyPerGroup,
  groups = [],
  teams = [],
  matches = [],
} = {}) {
  const normalizeGroup = (value) => {
    const group = qualificationRecord(value);
    const id = qualificationId(group);
    return {
      id,
      division: qualificationString(group.division),
      matchMode: qualificationString(group.matchMode || group.mode || group.scheduleMode)
        || 'ring',
      ringOrder: Array.isArray(group.ringOrder)
        ? group.ringOrder.filter((item) => typeof item === 'string')
        : [],
    };
  };
  const normalizeTeam = (value) => {
    const team = qualificationRecord(value);
    return {
      id: qualificationId(team),
      division: qualificationString(team.division),
      groupId: qualificationString(team.groupId),
      name: typeof team.name === 'string' ? team.name : '',
    };
  };
  const normalizedGroups = (Array.isArray(groups) ? groups : []).map(normalizeGroup)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const normalizedTeams = (Array.isArray(teams) ? teams : []).map(normalizeTeam)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const normalizedMatches = (Array.isArray(matches) ? matches : []).map(qualificationSnapshotMatch)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const count = Number.isInteger(qualifyPerGroup)
    ? qualifyPerGroup
    : Number(qualifyPerGroup);
  return canonicalQualification({
    version: 1,
    division: qualificationString(division),
    qualifyPerGroup: Number.isFinite(count) ? Math.floor(count) : null,
    groups: normalizedGroups,
    teams: normalizedTeams,
    matches: normalizedMatches,
  });
}

function qualificationBlocker(code, message) {
  return `${code}: ${message}`;
}

function standingTeamIds(standings) {
  return standings.map((standing) => standing.teamId);
}

/**
 * Compute standings and structural blockers for a canonical snapshot.
 *
 * `ready` means all populated groups have a complete, current schedule.
 * Cutoff lottery choices are exposed through each group's cutoffSlots and
 * are validated separately, so the input remains ready while choices render.
 */
export function computeQualificationState(snapshot = {}) {
  const blockers = [];
  const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  const teams = Array.isArray(snapshot.teams) ? snapshot.teams : [];
  const matches = Array.isArray(snapshot.matches) ? snapshot.matches : [];
  const division = snapshot.division;
  const count = snapshot.qualifyPerGroup;
  const groupIds = new Set();
  const teamIds = new Set();
  const matchIds = new Set();
  const teamsByGroup = new Map();
  const matchesByGroup = new Map();

  if (!['men', 'women'].includes(division)) {
    blockers.push(qualificationBlocker('invalid_division', 'A supported division is required.'));
  }
  if (!Number.isInteger(count) || count < 1 || count > 64) {
    blockers.push(qualificationBlocker('invalid_qualification_count', 'Qualification count must be an integer from 1 to 64.'));
  }
  groups.forEach((group) => {
    if (!group.id || groupIds.has(group.id)) {
      blockers.push(qualificationBlocker('duplicate_group', `Group identifiers must be unique (${group.id || 'unknown'}).`));
      return;
    }
    groupIds.add(group.id);
    if (group.division !== division) {
      blockers.push(qualificationBlocker('foreign_group', `Group does not belong to the selected division (${group.id}).`));
    }
  });
  teams.forEach((team) => {
    if (!team.id || teamIds.has(team.id)) {
      blockers.push(qualificationBlocker('duplicate_team', `Team identifiers must be unique (${team.id || 'unknown'}).`));
      return;
    }
    teamIds.add(team.id);
    if (team.division !== division) {
      blockers.push(qualificationBlocker('foreign_team', `Team does not belong to the selected division (${team.id}).`));
    }
    if (team.groupId && !groupIds.has(team.groupId)) {
      blockers.push(qualificationBlocker('unknown_team_group', `Team ${team.id} references unknown group ${team.groupId}.`));
    }
    if (team.groupId) {
      if (!teamsByGroup.has(team.groupId)) teamsByGroup.set(team.groupId, []);
      teamsByGroup.get(team.groupId).push(team);
    }
  });
  matches.forEach((match) => {
    if (!match.id || matchIds.has(match.id)) {
      blockers.push(qualificationBlocker('duplicate_match', `Preliminary match identifiers must be unique (${match.id || 'unknown'}).`));
      return;
    }
    matchIds.add(match.id);
    if (match.division !== division) {
      blockers.push(qualificationBlocker('foreign_match', `Preliminary match does not belong to the selected division (${match.id}).`));
    }
    if (!match.groupId || !groupIds.has(match.groupId)) {
      blockers.push(qualificationBlocker('unknown_match_group', `Preliminary match ${match.id} references unknown group ${match.groupId || 'unknown'}.`));
      return;
    }
    if (!matchesByGroup.has(match.groupId)) matchesByGroup.set(match.groupId, []);
    matchesByGroup.get(match.groupId).push(match);
  });
  for (const [groupId, scheduled] of matchesByGroup) {
    if (!(teamsByGroup.get(groupId) || []).length) {
      blockers.push(qualificationBlocker('orphan_match', `Preliminary matches reference an empty group (${groupId}).`));
    }
  }

  const groupStates = [];
  for (const group of groups) {
    const groupTeams = (teamsByGroup.get(group.id) || []).slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!groupTeams.length) {
      if ((matchesByGroup.get(group.id) || []).length) {
        blockers.push(qualificationBlocker('empty_group_games', `Group ${group.id} has games but no current members.`));
      }
      continue;
    }
    const memberIds = groupTeams.map((team) => team.id);
    const memberSet = new Set(memberIds);
    const scheduled = matchesByGroup.get(group.id) || [];
    const mode = group.matchMode || 'ring';
    if (!['roundrobin', 'ring'].includes(mode)) {
      blockers.push(qualificationBlocker('invalid_schedule_mode', `Unsupported schedule mode in ${group.id}.`));
    }
    if (mode === 'ring') {
      const ring = Array.isArray(group.ringOrder) ? group.ringOrder : [];
      if (ring.length !== memberIds.length
          || new Set(ring).size !== ring.length
          || ring.some((id) => !memberSet.has(id))) {
        blockers.push(qualificationBlocker('invalid_ring_order', `Ring order must contain every member of ${group.id} exactly once.`));
      }
    }
    const expectedPairs = expectedQualificationPairs(group, memberIds);
    const expectedSet = new Set(expectedPairs);
    const seenPairs = new Set();
    let scheduleValid = memberIds.length >= 2;
    if (memberIds.length < 2) {
      blockers.push(qualificationBlocker('insufficient_group_members', `${group.id} must contain at least two teams.`));
    }
    for (const match of scheduled) {
      if (!memberSet.has(match.teamA) || !memberSet.has(match.teamB) || match.teamA === match.teamB) {
        scheduleValid = false;
        blockers.push(qualificationBlocker('foreign_match_team', `Preliminary match ${match.id} has a foreign or duplicate group member.`));
        continue;
      }
      const pair = qualificationPairKey(match.teamA, match.teamB);
      if (seenPairs.has(pair)) {
        scheduleValid = false;
        blockers.push(qualificationBlocker('duplicate_game', `Duplicate preliminary pairing in ${group.id} (${match.id}).`));
      } else {
        seenPairs.add(pair);
      }
      if (!expectedSet.has(pair)) {
        scheduleValid = false;
        blockers.push(qualificationBlocker('unexpected_game', `Preliminary pairing ${pair} is not in ${group.id}'s schedule.`));
      }
      const evaluated = evaluatePrelimMatch(match.sets);
      if (match.officialCurrent === 'invalid' || match.dependencyReady === 'invalid'
          || match.retracted
          || match.officialCurrent === false || match.status === 'retracted'
          || match.status === 'invalid' || match.status === 'unresolved'
          || match.status !== 'done'
          || !Number.isInteger(match.officialRevision) || match.officialRevision <= 0
          || evaluated.status !== 'done' || match.dependencyReady === false) {
        scheduleValid = false;
        blockers.push(qualificationBlocker(
          match.officialCurrent === false || match.status === 'retracted'
            ? 'retracted_match' : 'incomplete_match',
          `Preliminary match ${match.id} must have a current complete result.`,
        ));
      }
    }
    for (const pair of expectedPairs) {
      if (!seenPairs.has(pair)) {
        scheduleValid = false;
        blockers.push(qualificationBlocker('missing_game', `Scheduled pairing ${pair} is missing from ${group.id}.`));
      }
    }
    if (scheduled.length !== expectedPairs.length) {
      scheduleValid = false;
      blockers.push(qualificationBlocker('schedule_size', `Preliminary schedule for ${group.id} has ${scheduled.length}/${expectedPairs.length} pairings.`));
    }
    const standings = computeGroupStandings(groupTeams, scheduled);
    const seats = Math.min(count > 0 ? count : 0, groupTeams.length);
    const automatic = scheduleValid
      ? computeAutomaticQualifiers(standings, seats)
      : [];
    const rankSizes = new Map();
    standings.forEach((standing) => {
      rankSizes.set(standing.rank, (rankSizes.get(standing.rank) || 0) + 1);
    });
    const cutoffRank = standings.find((standing) => (
      standing.rank <= seats
      && standing.rank + (rankSizes.get(standing.rank) || 1) - 1 > seats
    ))?.rank;
    const cutoffCandidates = cutoffRank == null ? [] : standings
      .filter((standing) => standing.rank === cutoffRank)
      .map((standing) => standing.teamId);
    const automaticIds = standingTeamIds(automatic);
    const cutoffSlots = Math.max(0, seats - automaticIds.length);
    groupStates.push({
      groupId: group.id,
      requiredCount: seats,
      standings,
      automaticIds,
      cutoffCandidateIds: cutoffCandidates,
      cutoffSlots,
    });
  }

  if (!groupStates.length) blockers.push(qualificationBlocker('no_groups', 'At least one populated qualification group is required.'));
  const requiredCount = groupStates.reduce((sum, group) => sum + group.requiredCount, 0);
  return {
    ready: blockers.length === 0,
    blockers,
    requiredCount,
    groups: groupStates,
  };
}

/**
 * Validate an administrator's complete finalist selection. Automatic
 * qualifiers are mandatory; only the exact number of cutoff seats may be
 * supplied by a group's string-array lottery record.
 */
export function validateQualificationSelection(state, participantIds, tieSelections = {}) {
  const errors = [];
  if (!state || typeof state !== 'object' || !Array.isArray(state.groups)) {
    errors.push(qualificationBlocker('qualification_state_required', 'Qualification state is required.'));
  }
  const selections = tieSelections && typeof tieSelections === 'object' && !Array.isArray(tieSelections)
    ? tieSelections
    : null;
  const requested = Array.isArray(participantIds) ? participantIds : null;
  if (!requested) errors.push(qualificationBlocker('participant_ids_required', 'Participant IDs are required.'));
  if (!selections) errors.push(qualificationBlocker('tie_selections_required', 'Tie selections are required.'));
  const selectedIds = requested || [];
  const selectedSet = new Set();
  if (new Set(selectedIds).size !== selectedIds.length
      || selectedIds.some((id) => typeof id !== 'string' || !id)) {
    errors.push(qualificationBlocker('duplicate_participant', 'Participant IDs must be unique non-empty strings.'));
  }
  const knownTeams = new Set((state?.groups || []).flatMap((group) => (
    group.standings || []
  ).map((standing) => standing.teamId)));
  selectedIds.forEach((id) => {
    if (!knownTeams.has(id)) errors.push(qualificationBlocker('foreign_participant', `Participant ${id} is not a qualified group member.`));
    selectedSet.add(id);
  });
  for (const group of state?.groups || []) {
    const automatic = new Set(group.automaticIds || []);
    const picked = selections?.[group.groupId];
    const rawPicked = picked == null ? [] : picked;
    if (!Array.isArray(rawPicked)) {
      errors.push(qualificationBlocker('invalid_tie_selection', `Tie selection for ${group.groupId} must be a string array.`));
      continue;
    }
    const uniquePicked = [...new Set(rawPicked)];
    if (uniquePicked.length !== rawPicked.length || uniquePicked.some((id) => typeof id !== 'string' || !id)) {
      errors.push(qualificationBlocker('duplicate_tie_selection', `Tie selections for ${group.groupId} must contain unique team IDs.`));
    }
    if (uniquePicked.length !== group.cutoffSlots) {
      errors.push(qualificationBlocker('cutoff_slots_mismatch', `Cutoff selections for ${group.groupId} must fill exactly ${group.cutoffSlots} remaining seats.`));
    }
    const candidates = new Set(group.cutoffCandidateIds || []);
    uniquePicked.forEach((id) => {
      if (!candidates.has(id)) {
        errors.push(qualificationBlocker('non_candidate_selection', `Selected team ${id} is not a cutoff candidate in ${group.groupId}.`));
      }
    });
    automatic.forEach((id) => {
      if (!selectedSet.has(id)) {
        errors.push(qualificationBlocker('mandatory_qualifier_missing', `Mandatory qualifier ${id} is missing from ${group.groupId}.`));
      }
    });
    uniquePicked.forEach((id) => {
      if (!selectedSet.has(id)) {
        errors.push(qualificationBlocker('cutoff_selection_missing', `Cutoff selection ${id} is missing from participants.`));
      }
    });
    const allowed = new Set([...automatic, ...uniquePicked]);
    const groupTeamIds = (group.standings || []).map((standing) => standing.teamId);
    groupTeamIds.forEach((id) => {
      if (selectedSet.has(id) && !allowed.has(id)) {
        errors.push(qualificationBlocker('non_qualifier_selected', `Non-qualifier ${id} cannot be selected from ${group.groupId}.`));
      }
    });
    if (selectedIds.filter((id) => groupTeamIds.includes(id)).length !== group.requiredCount) {
      errors.push(qualificationBlocker('group_count_mismatch', `${group.groupId} requires exactly ${group.requiredCount} participants.`));
    }
  }
  for (const key of selections ? Object.keys(selections) : []) {
    if (!(state?.groups || []).some((group) => group.groupId === key)) {
      errors.push(qualificationBlocker('unknown_tie_group', `Tie selection references unknown group ${key}.`));
    }
  }
  // Any structural or score blocker is fatal even when the participant list
  // happens to look valid. Cutoff seats are represented by cutoffSlots.
  if ((state?.blockers || []).length) {
    errors.push(qualificationBlocker('qualification_not_ready', 'Preliminary qualification inputs are not complete and current.'));
  }
  if (selectedIds.length < 2 || selectedIds.length > 32) {
    errors.push(qualificationBlocker('participant_count', 'Final qualification requires between 2 and 32 participants.'));
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [] };
}

/**
 * Return deterministic JSON bytes for the snapshot. The function accepts
 * only the canonical object produced by buildQualificationSnapshot, but
 * canonicalises once more so callers cannot accidentally hash key-order
 * differences.
 */
export function serializeQualificationSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  // Names are useful to the caller's state renderer but are cosmetic and
  // must not participate in the server/client qualification CAS.
  const sanitized = {
    ...source,
    groups: (Array.isArray(source.groups) ? source.groups : []).map((group) => {
      const { name: _name, label: _label, displayOrder: _displayOrder, ...rest } = group || {};
      return rest;
    }),
    teams: (Array.isArray(source.teams) ? source.teams : []).map((team) => {
      const { name: _name, label: _label, displayOrder: _displayOrder, ...rest } = team || {};
      return rest;
    }),
    matches: (Array.isArray(source.matches) ? source.matches : []).map((match) => {
      const {
        name: _name, roundLabel: _roundLabel, courtId: _courtId, courtOrder: _courtOrder,
        ...rest
      } = match || {};
      return rest;
    }),
  };
  return JSON.stringify(canonicalQualification(sanitized));
}

// ---------- CSV 유틸 ----------

export function toCsvRow(values) {
  return values
    .map((v) => {
      const s = v === null || v === undefined ? '' : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    })
    .join(',');
}

export function buildCsv(headerRow, rows) {
  const lines = [toCsvRow(headerRow)];
  rows.forEach((r) => lines.push(toCsvRow(r)));
  return '﻿' + lines.join('\r\n'); // BOM 포함 (엑셀 한글 호환)
}

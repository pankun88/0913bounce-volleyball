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

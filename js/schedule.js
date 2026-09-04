/**
 * 예선 조별 라운드로빈(전체 1회씩 대결) 일정 생성 - 서클법(circle method)
 */
export function generateRoundRobin(teamIds) {
  const ids = [...teamIds];
  if (ids.length < 2) return [];
  const hasBye = ids.length % 2 === 1;
  if (hasBye) ids.push(null);

  const n = ids.length;
  const rounds = n - 1;
  const matches = [];
  let arr = [...ids];

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== null && b !== null) {
        matches.push({ teamA: a, teamB: b, round: matches.length + 1 });
      }
    }
    arr = [arr[0], ...arr.slice(2), arr[1]];
  }

  return matches;
}

/**
 * 이미 생성된 경기 문서를 팀 카드의 현재 순서로 다시 정렬한다.
 * 팀 순서만 바꿀 때 경기 문서와 입력된 결과는 그대로 두고 표시 순서만 바꾼다.
 */
export function orderExistingRoundRobinMatchIds(matches, teamIds) {
  const pairKey = (teamA, teamB) => [teamA, teamB].sort().join("\u0000");
  const matchesByPair = new Map(
    matches.map((match) => [pairKey(match.teamA, match.teamB), match.id]),
  );
  const orderedIds = generateRoundRobin(teamIds)
    .map((match) => matchesByPair.get(pairKey(match.teamA, match.teamB)))
    .filter(Boolean);
  const orderedSet = new Set(orderedIds);
  return [...orderedIds, ...matches.map((match) => match.id).filter((id) => !orderedSet.has(id))];
}

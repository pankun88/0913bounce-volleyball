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
        matches.push({ teamA: a, teamB: b, round: r + 1 });
      }
    }
    arr = [arr[0], ...arr.slice(2), arr[1]];
  }

  return matches;
}

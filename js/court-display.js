/**
 * 코트 대기열(courtAssignments)에는 경기 참조만 저장되고 팀 이름은 없다.
 * 팀 이름은 승인 여부와 무관한 공개 대진 정보이므로, 공식 경기 문서
 * (prelimMatches / divisions/{division}/finalMatches)와 팀·조 목록에서 해석한다.
 *
 * 본선은 상위 경기 결과가 승인될 때마다 참가팀이 바뀌므로, 배정 시점에
 * 이름을 복사해두면 "대진 미정"으로 굳는다. 그래서 항상 공식 문서를 참조한다.
 */

const UNKNOWN_TEAM = "대진 미정";

/** 저장·입력용 코트 식별 이름. 사용자가 과거 방식으로 붙인 끝의 "코트"는 제거한다. */
export function normalizeCourtName(value) {
  return String(value || "").trim().replace(/\s*코트$/u, "").trim();
}

/** 모든 화면에서 코트 식별 이름 뒤에 "코트"를 정확히 한 번 붙인다. */
export function formatCourtName(value, fallback = "미배정") {
  const name = normalizeCourtName(typeof value === "object" ? (value?.name || value?.label) : value);
  return name ? `${name}코트` : fallback;
}

/** Map과 일반 객체를 모두 받아 id로 이름을 찾는다. */
function lookupName(source, id) {
  if (!id || !source) return null;
  const entry = source instanceof Map ? source.get(id) : source[id];
  return entry?.name || null;
}

/** 예선은 팀 ID를, 본선은 {name} 형태의 팀 객체를 저장한다. */
function teamLabel(value, teamsById) {
  if (!value) return UNKNOWN_TEAM;
  if (typeof value === "object") return value.name || UNKNOWN_TEAM;
  return lookupName(teamsById, value) || UNKNOWN_TEAM;
}

/** 공식 경기 문서를 아직 못 받았으면 null, 받았으면 { a, b } 팀 이름. */
export function courtTeamNames(officialMatch, teamsById) {
  if (!officialMatch) return null;
  return {
    a: teamLabel(officialMatch.teamA, teamsById),
    b: teamLabel(officialMatch.teamB, teamsById),
  };
}

/** "A조 예선 · 3경기" / "4강 2경기" 같은 사람이 읽는 경기 이름. */
export function courtMatchLabel(assignment, officialMatch, groupsById) {
  if (assignment?.matchType === "final") {
    const round = officialMatch?.roundLabel
      || (officialMatch?.round ? `본선 ${officialMatch.round}라운드` : "본선");
    return Number.isInteger(officialMatch?.index) ? `${round} ${officialMatch.index + 1}경기` : round;
  }
  const groupName = lookupName(groupsById, officialMatch?.groupId);
  const parts = [groupName ? `${groupName} 예선` : "예선"];
  if (officialMatch?.round) parts.push(`${officialMatch.round}경기`);
  return parts.join(" · ");
}

/** 기록관 화면과 관객 대시보드가 함께 쓰는 표시 문구. */
export function courtMatchSummary(assignment, officialMatch, lookups = {}) {
  const teams = courtTeamNames(officialMatch, lookups.teamsById);
  return {
    label: courtMatchLabel(assignment, officialMatch, lookups.groupsById),
    teams: teams ? `${teams.a} vs ${teams.b}` : null,
  };
}

/**
 * 조별 예선 순서가 바뀌면 각 코트에서 그 조 경기들이 차지하던 자리는 유지하고,
 * 그 자리 안의 경기만 새 예선 순서대로 다시 배치한다.
 * 다른 조와 본선 경기의 코트 순서는 건드리지 않는다.
 */
export function syncCourtOrderWithPrelimOrder(assignments, orderedMatchKeys) {
  const prelimOrder = new Map(orderedMatchKeys.map((matchKey, index) => [matchKey, index]));
  const courtIds = new Set(assignments.map((assignment) => assignment.courtId || null));

  courtIds.forEach((courtId) => {
    const courtAssignments = assignments
      .map((assignment, index) => ({ assignment, index }))
      .filter(({ assignment }) => (assignment.courtId || null) === courtId)
      .sort((a, b) => (
        (a.assignment.courtOrder ?? Number.MAX_SAFE_INTEGER)
        - (b.assignment.courtOrder ?? Number.MAX_SAFE_INTEGER)
        || a.index - b.index
      ));
    const reorderedPrelim = courtAssignments
      .map(({ assignment }) => assignment)
      .filter((assignment) => prelimOrder.has(assignment.matchKey))
      .sort((a, b) => prelimOrder.get(a.matchKey) - prelimOrder.get(b.matchKey));

    let prelimIndex = 0;
    courtAssignments.forEach(({ assignment }, index) => {
      const nextAssignment = prelimOrder.has(assignment.matchKey)
        ? reorderedPrelim[prelimIndex++]
        : assignment;
      nextAssignment.courtOrder = index + 1;
    });
  });

  return assignments;
}

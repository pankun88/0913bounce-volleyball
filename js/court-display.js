/**
 * 코트 대기열(courtAssignments)에는 경기 참조만 저장되고 팀 이름은 없다.
 * 팀 이름은 승인 여부와 무관한 공개 대진 정보이므로, 공식 경기 문서
 * (prelimMatches / divisions/{division}/finalMatches)와 팀·조 목록에서 해석한다.
 *
 * 본선은 상위 경기 결과가 승인될 때마다 참가팀이 바뀌므로, 배정 시점에
 * 이름을 복사해두면 "대진 미정"으로 굳는다. 그래서 항상 공식 문서를 참조한다.
 */

const UNKNOWN_TEAM = "대진 미정";

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

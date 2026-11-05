import { computeGroupStandings } from "./match-logic.js";

/**
 * 동률 추첨으로 본선에 오른 팀 표기. 추첨 결과(tieSelections)는 순서에 의미가 없는 팀 목록이므로
 * 1위·2위로 나누지 않고 같은 순위로 묶어 「A조 1위(추첨)」처럼 표시한다(카드 폭에 맞게 짧게).
 * (서버에 저장된 추첨 근거 메모는 없다 — 선택 결과만 표시한다.)
 */
function selectedIdsFor(tieSelections, groupId) {
  const picked = tieSelections && typeof tieSelections === "object" ? tieSelections[groupId] : null;
  return Array.isArray(picked) ? picked : [];
}

/** 대진표 팀 아래 조·순위 라벨. 추첨 진출팀이면 추첨 표기를 쓴다. */
export function bracketRankLabel(teamId, { teams = [], groups = [], prelimMatches = [], tieSelections = {} } = {}) {
  const team = teams.find((item) => item.id === teamId);
  if (!team) return "";
  const group = groups.find((item) => item.id === team.groupId);
  if (!group) return "";
  const groupTeams = teams.filter((item) => item.groupId === group.id);
  const groupMatches = prelimMatches.filter((match) => match.groupId === group.id);
  const standings = computeGroupStandings(groupTeams, groupMatches);
  const standing = standings.find((item) => item.teamId === teamId);
  if (!standing) return group.name;
  if (selectedIdsFor(tieSelections, group.id).includes(teamId)) {
    return `${group.name} ${standing.rank}위(추첨)`;
  }
  return `${group.name} ${standing.rank}위`;
}

/** 공개 순위표 조 카드 아래 안내. 추첨으로 진출한 팀이 없으면 빈 문자열. */
export function tieSelectionNote(groupId, { teams = [], tieSelections = {}, nameOf = (team) => team.name } = {}) {
  const names = selectedIdsFor(tieSelections, groupId)
    .map((id) => teams.find((team) => team.id === id))
    .filter((team) => team && team.groupId === groupId)
    .map((team) => nameOf(team));
  return names.length ? `동률 — 추첨으로 ${names.join("·")} 진출` : "";
}

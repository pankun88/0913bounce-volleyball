import { getRingEdges } from "./ring-bracket.js";

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
 * 예선 경기와 통합 코트 배정 초안을 읽기 전용으로 합쳐 화면용 순서를 만든다.
 * 구조적 `round`는 대진 식별·동률 정렬에만 사용하고 실행 순서를 덮어쓰지 않는다.
 */
export function projectPrelimCourtSchedule(matches, assignments, courts) {
  const matchList = Array.isArray(matches) ? matches : [];
  const assignmentList = Array.isArray(assignments) ? assignments : [];
  const courtList = Array.isArray(courts) ? courts : [];
  const assignmentByMatchKey = new Map(
    assignmentList
      .filter((assignment) => assignment && assignment.matchKey !== undefined && assignment.matchKey !== null)
      .map((assignment) => [assignment.matchKey, assignment]),
  );
  const courtById = new Map();
  courtList.forEach((court, index) => {
    if (!court || court.id === undefined || court.id === null || courtById.has(court.id)) return;
    courtById.set(court.id, {
      index,
      name: normalizeCourtName(court.name),
    });
  });

  const numericCourtOrder = (value) => (
    typeof value === "number"
      && Number.isFinite(value)
      && Number.isInteger(value)
      && value > 0
      ? value
      : null
  );
  const structuralRound = (value) => {
    const round = typeof value === "number" ? value : Number(value);
    return Number.isFinite(round) ? round : Number.POSITIVE_INFINITY;
  };
  const structuralId = (match) => (match?.id === undefined || match?.id === null ? "" : String(match.id));
  const compareText = (left, right) => {
    const a = String(left ?? "");
    const b = String(right ?? "");
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const compareStructural = (left, right) => (
    structuralRound(left.row.match?.round) - structuralRound(right.row.match?.round)
      || compareText(structuralId(left.row.match), structuralId(right.row.match))
      || left.index - right.index
  );

  return matchList
    .map((match, index) => {
      const assignment = assignmentByMatchKey.get(match?.id);
      const courtId = typeof assignment?.courtId === "string" && assignment.courtId.trim()
        ? assignment.courtId
        : null;
      const court = courtId === null ? null : courtById.get(courtId);
      const courtOrder = numericCourtOrder(assignment?.courtOrder);
      const courtName = court?.name || "";
      const assigned = Boolean(court && courtName && courtOrder !== null);
      if (!assigned) {
        return {
          index,
          assigned: false,
          courtIndex: Number.POSITIVE_INFINITY,
          courtOrder: null,
          row: {
            match,
            courtId: null,
            courtName: "",
            courtOrder: null,
            label: "미배정",
            shortLabel: "—",
          },
        };
      }
      return {
        index,
        assigned: true,
        courtIndex: court.index,
        courtOrder,
        row: {
          match,
          courtId,
          courtName,
          courtOrder,
          label: `${formatCourtName(courtName)} · 전체 ${courtOrder}번째`,
          shortLabel: `${courtName}·${courtOrder}`,
        },
      };
    })
    .sort((left, right) => {
      if (left.assigned !== right.assigned) return left.assigned ? -1 : 1;
      if (left.assigned) {
        return left.courtIndex - right.courtIndex
          || left.courtOrder - right.courtOrder
          || compareStructural(left, right);
      }
      return compareStructural(left, right);
    })
    .map(({ row }) => row);
}

function ringTeamId(value) {
  if (value && typeof value === "object") return value.id ?? null;
  return value ?? null;
}

function ringPairMatches(match, teamA, teamB) {
  const hasTeamId = (value) => (
    value !== null
      && value !== undefined
      && !(typeof value === "string" && value.trim() === "")
  );
  if (!hasTeamId(teamA) || !hasTeamId(teamB)) return false;
  const matchA = ringTeamId(match?.teamA);
  const matchB = ringTeamId(match?.teamB);
  if (!hasTeamId(matchA) || !hasTeamId(matchB)) return false;
  return (
    (matchA === teamA && matchB === teamB)
    || (matchA === teamB && matchB === teamA)
  );
}

function assignedScheduleRow(row) {
  return Boolean(
    row
      && typeof row.courtId === "string"
      && row.courtId.trim()
      && typeof row.shortLabel === "string"
      && row.shortLabel !== "—"
      && typeof row.label === "string"
      && Number.isInteger(row.courtOrder)
      && Number.isFinite(row.courtOrder)
      && row.courtOrder > 0,
  );
}

/**
 * 링 도형의 구조적 변 순서는 그대로 두고, 각 변의 팀쌍에 해당하는
 * 통합 코트 실행 위치만 표시용으로 투영한다.
 */
export function getPrelimRingEdgeLabels(ringOrder, schedule) {
  const order = Array.isArray(ringOrder) ? ringOrder : [];
  const rows = Array.isArray(schedule) ? schedule : [];
  return getRingEdges(order.length).map(([i, j], edgeIndex) => {
    const teamA = ringTeamId(order[i]);
    const teamB = ringTeamId(order[j]);
    const row = rows.find((item) => (
      assignedScheduleRow(item) && ringPairMatches(item.match, teamA, teamB)
    ));
    return row
      ? { text: row.shortLabel, title: row.label }
      : { text: "—", title: `미배정 · 대진 ${edgeIndex + 1}` };
  });
}

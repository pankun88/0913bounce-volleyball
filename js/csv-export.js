import { toCsvRow, computeGroupStandings } from "./match-logic.js";

function linesToCsv(lines) {
  return "﻿" + lines.map((l) => toCsvRow(l)).join("\r\n");
}

function teamName(teams, id) {
  const t = teams.find((x) => x.id === id);
  return t ? t.name : id || "";
}

function setScoreText(sets) {
  return (sets || [])
    .filter((s) => Number(s.a) > 0 || Number(s.b) > 0)
    .map((s) => `${s.a}:${s.b}`)
    .join(" / ");
}

/**
 * 예선 + 본선 전체 결과를 하나의 CSV 문자열로 만든다.
 */
export function buildFullResultsCsv({ tournamentName, groups, teams, prelimMatches, finalMatches }) {
  const lines = [];

  lines.push([`■ ${tournamentName || "바운스발리볼"} 전체 결과`]);
  lines.push([`내보낸 시각`, new Date().toLocaleString("ko-KR")]);
  lines.push([]);

  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    // Firestore는 정렬 없이 구독 중이라 docId 순서로 오므로, CSV에는 항상 round 순으로 정렬해서 적는다
    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id).sort((a, b) => (a.round || 0) - (b.round || 0));
    const standings = computeGroupStandings(groupTeams, groupMatches);

    lines.push([`■ 예선 - ${g.name} 순위`]);
    lines.push(["순위", "팀", "경기", "승", "무", "패", "승점", "세트득실", "득실차", "비고"]);
    standings.forEach((s) => {
      lines.push([
        s.rank, s.name, s.played, s.win, s.draw, s.loss, s.points,
        s.setDiff, s.pointDiff, s.needsLottery ? "동률(추첨 필요)" : "",
      ]);
    });
    lines.push([]);

    lines.push([`■ 예선 - ${g.name} 경기결과`]);
    lines.push(["팀A", "팀B", "세트결과(A:B)", "결과"]);
    groupMatches.forEach((m) => {
      const resultText = m.result === "A" ? `${teamName(teams, m.teamA)} 승`
        : m.result === "B" ? `${teamName(teams, m.teamB)} 승`
        : m.result === "draw" ? "무승부" : "경기전";
      lines.push([teamName(teams, m.teamA), teamName(teams, m.teamB), setScoreText(m.sets), resultText]);
    });
    lines.push([]);
  });

  if (finalMatches && finalMatches.length) {
    lines.push(["■ 본선 토너먼트 결과"]);
    lines.push(["라운드", "팀A", "팀B", "세트결과(A:B)", "승자"]);
    const ordered = [...finalMatches].sort((a, b) => (a.round - b.round) || (a.index - b.index));
    ordered.forEach((m) => {
      const label = m.isThirdPlace ? "3·4위전" : m.roundLabel;
      const winnerName = m.winnerTeam ? m.winnerTeam.name : "";
      lines.push([
        label,
        m.teamA ? m.teamA.name : "",
        m.teamB ? m.teamB.name : "",
        setScoreText(m.sets),
        winnerName,
      ]);
    });
  }

  return linesToCsv(lines);
}

export function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

import {
  subscribeTournamentInfo, subscribeGroups, subscribeTeams,
  subscribePrelimMatches, subscribeFinalMatches,
} from "./firestore-service.js";
import { evaluatePrelimMatch, computeGroupStandings } from "./match-logic.js";
import { renderBracket } from "./bracket-render.js";

let tournamentInfo = {};
let groups = [];
let teams = [];
let prelimMatches = [];
let finalMatches = [];

initTabs();

subscribeTournamentInfo((info) => {
  tournamentInfo = info || {};
  document.getElementById("dashTitle").textContent = tournamentInfo.name || "바운스발리볼";
  document.getElementById("dashBracketTitle").textContent = (tournamentInfo.name || "바운스발리볼") + " 본선 대진표";
  renderIntro();
});

subscribeGroups((data) => {
  groups = data;
  renderIntro();
  renderGroupOverview();
  renderPrelim();
});

subscribeTeams((data) => {
  teams = data;
  renderIntro();
  renderGroupOverview();
  renderPrelim();
});

subscribePrelimMatches((data) => {
  prelimMatches = data;
  renderPrelim();
});

subscribeFinalMatches((data) => {
  finalMatches = data;
  renderBracket(document.getElementById("dashBracketContainer"), finalMatches, { editable: false });
});

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });
}

function renderIntro() {
  const el = document.getElementById("dashIntro");
  if (!el) return;
  el.textContent = `${tournamentInfo.name || "바운스발리볼"} · 참가팀 ${teams.length}팀 · ${groups.length}개 조`;
}

function renderGroupOverview() {
  const el = document.getElementById("dashGroupOverview");
  if (!groups.length) {
    el.innerHTML = '<div class="empty-hint">조 편성 정보가 아직 없습니다.</div>';
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    const box = document.createElement("div");
    box.className = "card";
    box.style.margin = "0";
    box.innerHTML = `<h3>${escapeHtml(g.name)} <span style="color:var(--muted); font-weight:400;">(${groupTeams.length}팀)</span></h3>
      <div>${groupTeams.map((t) => `<span class="team-pill">${escapeHtml(t.name)}</span>`).join(" ") || '<span class="empty-hint">팀 없음</span>'}</div>`;
    el.appendChild(box);
  });
}

function renderPrelim() {
  const el = document.getElementById("dashPrelim");
  if (!groups.length) {
    el.innerHTML = '<div class="empty-hint">예선 정보가 아직 없습니다.</div>';
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id);
    const standings = computeGroupStandings(groupTeams, groupMatches);

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h2>📋 ${escapeHtml(g.name)}</h2>`;

    if (standings.length) {
      const table = document.createElement("table");
      table.innerHTML = `<thead><tr>
        <th>순위</th><th>팀</th><th>승</th><th>무</th><th>패</th><th>승점</th><th>세트득실</th>
      </tr></thead>`;
      const tbody = document.createElement("tbody");
      standings.forEach((s) => {
        const tr = document.createElement("tr");
        if (s.rank === 1) tr.className = "rank-1";
        tr.innerHTML = `<td>${s.rank}${s.needsLottery ? '<div class="lottery-flag">동률</div>' : ""}</td>
          <td>${escapeHtml(s.name)}</td><td>${s.win}</td><td>${s.draw}</td><td>${s.loss}</td>
          <td>${s.points}</td><td>${s.setDiff >= 0 ? "+" : ""}${s.setDiff}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
    }

    const matchList = document.createElement("div");
    matchList.style.marginTop = "12px";
    groupMatches.forEach((m) => {
      const evald = evaluatePrelimMatch(m.sets || []);
      const scoreText = (m.sets || []).filter((s) => Number(s.a) > 0 || Number(s.b) > 0).map((s) => `${s.a}:${s.b}`).join(" / ");
      const badge = evald.result === "A" ? `<span class="badge win">${escapeHtml(teamName(m.teamA))} 승</span>`
        : evald.result === "B" ? `<span class="badge win">${escapeHtml(teamName(m.teamB))} 승</span>`
        : evald.result === "draw" ? '<span class="badge draw">무승부</span>'
        : evald.status === "in_progress" ? '<span class="badge">경기중</span>'
        : '<span class="badge">경기전</span>';
      const row = document.createElement("div");
      row.className = "row";
      row.style.justifyContent = "space-between";
      row.style.padding = "6px 2px";
      row.style.borderBottom = "1px solid var(--line)";
      row.style.fontSize = "13px";
      row.innerHTML = `<span>${escapeHtml(teamName(m.teamA))} vs ${escapeHtml(teamName(m.teamB))} <span style="color:var(--muted);">${scoreText}</span></span>${badge}`;
      matchList.appendChild(row);
    });
    card.appendChild(matchList);
    el.appendChild(card);
  });
}

function teamName(id) {
  const t = teams.find((x) => x.id === id);
  return t ? t.name : "?";
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

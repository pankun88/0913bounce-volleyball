import {
  subscribeTournamentInfo, subscribeGroups, subscribeTeams,
  subscribePrelimMatches, subscribeFinalMatches,
} from "./firestore-service.js";
import { evaluatePrelimMatch, computeGroupStandings } from "./match-logic.js";
import { renderBracket, displayTeamName } from "./bracket-render.js";
import { normalizeRingOrder, renderRingDiagram } from "./ring-bracket.js";

let tournamentInfo = {};
let groups = [];
let teams = [];
let prelimMatches = [];
let finalMatches = [];

initTabs();
initConnectionWatch();
initBracketFullscreen();

subscribeTournamentInfo((info) => {
  hideErrorBanner();
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
  renderBracket(document.getElementById("dashBracketContainer"), finalMatches, {
    editable: false,
    getTeamLabel: teamGroupRankLabel,
  });
});

function initConnectionWatch() {
  window.addEventListener("firestore-error", (e) => {
    const { label, err } = e.detail;
    const code = err && err.code ? ` (${err.code})` : "";
    showErrorBanner(`⚠️ ${label} 실패${code}: ${err && err.message ? err.message : err}\nFirestore 보안 규칙이 게시되어 있는지 Firebase 콘솔에서 확인해주세요.`);
  });
  window.addEventListener("firestore-timeout", (e) => {
    showErrorBanner(
      `⚠️ "${e.detail.label}" 실시간 연결이 응답하지 않습니다.\n` +
      `광고 차단/보안 확장 프로그램이 Firestore 실시간 연결을 막고 있을 수 있습니다 — 확장 프로그램을 끄거나 시크릿창에서 다시 열어보세요.\n` +
      `그래도 안 되면 다른 네트워크(예: 휴대폰 테더링)에서 시도해보세요.`
    );
  });
}

function showErrorBanner(text) {
  const el = document.getElementById("errorBanner");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
}

function hideErrorBanner() {
  const el = document.getElementById("errorBanner");
  if (el) el.classList.remove("show");
}

/** 체육관 모니터 등에 화면 꽉 채워 송출할 때 쓰는 본선 대진표 전체화면 토글.
 * 카드 전체(제목+트리)를 전체화면 대상으로 삼되, 전체화면 중에는 제목을 숨기고
 * 종료 버튼만 작게 코너에 띄워서 트리가 차지할 공간을 최대로 넓힌다.
 * container.dataset.fullscreenZoom 값을 bracket-render.js의 redraw가 읽어서,
 * 전체화면일 때는 가로/세로 모두에 맞춰(필요하면 1배 이상으로) 확대한다.
 *
 * PC/안드로이드 크롬에서는 표준 Fullscreen API(requestFullscreen)를 쓴다. 다만 iOS Safari는
 * <video> 외 일반 요소에는 이 API를 지원하지 않고, 카카오톡 등 인앱 브라우저는 API가 있어도
 * 막혀 있어 호출이 조용히 실패하는 경우가 있다 — 이런 환경에서는 버튼을 눌러도 아무 반응이
 * 없는 것처럼 보인다. 그래서 API가 없거나(없으면 즉시), 호출했는데도 일정 시간 안에 실제
 * 전체화면으로 전환되지 않으면(있어도 막혀 있으면) 카드를 화면에 고정 오버레이로 띄우는
 * "의사 전체화면"으로 자동 대체한다. */
function initBracketFullscreen() {
  const btn = document.getElementById("dashBracketFullscreenBtn");
  const card = document.getElementById("dashBracketCard");
  const container = document.getElementById("dashBracketContainer");
  if (!btn || !card || !container) return;

  let pseudoFullscreen = false;

  const applyState = (isFs) => {
    card.classList.toggle("is-fullscreen", isFs);
    btn.textContent = isFs ? "전체화면 종료" : "⛶ 전체화면";
    container.dataset.fullscreenZoom = isFs ? "1" : "";
    // 전체화면 전환 직후 바로 새 비율로 다시 그린다(ResizeObserver가 곧 한 번 더 보정해준다).
    renderBracket(container, finalMatches, { editable: false, getTeamLabel: teamGroupRankLabel });
  };

  const enterPseudoFullscreen = () => {
    pseudoFullscreen = true;
    card.classList.add("is-fullscreen-fallback");
    document.documentElement.classList.add("bracket-fallback-lock-scroll");
    applyState(true);
  };

  const exitPseudoFullscreen = () => {
    pseudoFullscreen = false;
    card.classList.remove("is-fullscreen-fallback");
    document.documentElement.classList.remove("bracket-fallback-lock-scroll");
    applyState(false);
  };

  btn.addEventListener("click", () => {
    if (pseudoFullscreen) {
      exitPseudoFullscreen();
      return;
    }
    const isNativeFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isNativeFs) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      return;
    }
    const request = card.requestFullscreen || card.webkitRequestFullscreen;
    if (!request) {
      enterPseudoFullscreen(); // 이 브라우저는 Fullscreen API 자체가 없음(예: 구형 iOS Safari)
      return;
    }
    let settled = false;
    const fallbackTimer = setTimeout(() => {
      if (!settled && !document.fullscreenElement && !document.webkitFullscreenElement) {
        settled = true;
        enterPseudoFullscreen(); // API는 있지만 실제로 전환되지 않음(인앱 브라우저 등에서 막힘)
      }
    }, 400);
    try {
      const result = request.call(card);
      if (result && typeof result.catch === "function") {
        result
          .then(() => { settled = true; clearTimeout(fallbackTimer); })
          .catch(() => {
            if (!settled) {
              settled = true;
              clearTimeout(fallbackTimer);
              enterPseudoFullscreen();
            }
          });
      }
    } catch (err) {
      settled = true;
      clearTimeout(fallbackTimer);
      enterPseudoFullscreen();
    }
  });

  const onFullscreenChange = () => {
    if (pseudoFullscreen) return; // 의사 전체화면 중에는 (관련 없는) 네이티브 이벤트를 무시
    const isFs = (document.fullscreenElement || document.webkitFullscreenElement) === card;
    applyState(isFs);
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
}

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
      <div>${groupTeams.map((t) => `<span class="team-pill">${escapeHtml(displayTeamName(t.name))}</span>`).join(" ") || '<span class="empty-hint">팀 없음</span>'}</div>`;
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
    // Firestore는 정렬 없이 구독 중이라 docId 순서로 오므로, 화면에 보여줄 때는 항상 round 순으로 정렬한다
    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id).sort((a, b) => (a.round || 0) - (b.round || 0));
    const standings = computeGroupStandings(groupTeams, groupMatches);

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h2>📋 ${escapeHtml(g.name)}</h2>`;

    if ((g.matchMode || "roundrobin") === "ring" && groupTeams.length >= 2) {
      const ringOrder = normalizeRingOrder(g.ringOrder, groupTeams.map((t) => t.id));
      const diagramHost = document.createElement("div");
      diagramHost.style.margin = "0 auto 14px";
      card.appendChild(diagramHost);
      renderRingDiagram(diagramHost, {
        ringOrder,
        teamNameById: (id) => teamName(id),
        editable: false,
      });
    }

    if (standings.length) {
      const table = document.createElement("table");
      table.className = "standings-table";
      table.innerHTML = `<thead><tr>
        <th>순위</th><th>팀</th><th>승</th><th>무</th><th>패</th><th>승점</th><th>세트득실</th><th>득실차</th>
      </tr></thead>`;
      const tbody = document.createElement("tbody");
      standings.forEach((s) => {
        const tr = document.createElement("tr");
        if (s.rank === 1) tr.className = "rank-1";
        tr.innerHTML = `<td>${s.rank}${s.needsLottery ? '<div class="lottery-flag">동률</div>' : ""}</td>
          <td>${escapeHtml(displayTeamName(s.name))}</td><td>${s.win}</td><td>${s.draw}</td><td>${s.loss}</td>
          <td>${s.points}</td><td>${s.setDiff >= 0 ? "+" : ""}${s.setDiff}</td><td>${s.pointDiff >= 0 ? "+" : ""}${s.pointDiff}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      // 컬럼이 8칸이라 좁은 화면에서 넘칠 수 있으므로, 표를 가로 스크롤 컨테이너로 감싸
      // 표 자체 비율(칸 정렬)은 깨지지 않게 하고 넘칠 때만 좌우로 밀어 보게 한다.
      const scroll = document.createElement("div");
      scroll.className = "table-scroll";
      scroll.appendChild(table);
      card.appendChild(scroll);
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
  // 화면 표시용 이름은 뒤에 붙은 코드(예: "삼화초A(A1)" → "삼화초A")를 떼어 가독성을 높인다.
  return t ? displayTeamName(t.name) : "?";
}

/** teamId가 속한 조에서의 예선 순위를 "A조 1위" 형태 문구로 만든다 (대진표 카드 라벨용, admin.js와 동일한 규칙) */
function teamGroupRankLabel(teamId) {
  const t = teams.find((tt) => tt.id === teamId);
  if (!t) return "";
  const g = groups.find((gg) => gg.id === t.groupId);
  if (!g) return "";
  const groupTeams = teams.filter((tt) => tt.groupId === g.id);
  const groupMatches = prelimMatches.filter((m) => m.groupId === g.id);
  const standings = computeGroupStandings(groupTeams, groupMatches);
  const s = standings.find((ss) => ss.teamId === teamId);
  return s ? `${g.name} ${s.rank}위` : g.name;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

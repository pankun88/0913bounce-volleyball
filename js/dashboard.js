import {
  subscribeTournamentInfo, subscribeGroups, subscribeTeams,
  subscribePrelimMatches, subscribeFinalMatches,
} from "./firestore-service.js";
import { evaluatePrelimMatch, computeGroupStandings } from "./match-logic.js";
import { renderBracket, displayTeamName } from "./bracket-render.js";
import { normalizeRingOrder, renderRingDiagram } from "./ring-bracket.js";
import { courtMatchSummary } from "./court-display.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { TOURNAMENT_ID } from "./firebase-config.js";

const DIVISIONS = ["men", "women"];
const DIVISION_LABELS = { men: "남자부", women: "여자부" };
const params = new URLSearchParams(window.location.search);
const isVenueMode = params.get("display") === "venue";
const requestedDivision = params.get("division");
const requestedTab = ["prelim", "final"].includes(params.get("tab")) ? params.get("tab") : "prelim";

let tournamentInfo = {};
let allGroups = [];
let allTeams = [];
let allPrelimMatches = [];
const finalMatchesByDivision = { men: [], women: [] };
let activeDivision = DIVISIONS.includes(requestedDivision) ? requestedDivision : "men";
let activeTab = requestedTab;
let venueTimer = null;
let venueConfigKey = "";
let venueDisplayLocked = isVenueMode;
let courtQueues = [];
let courtAssignments = [];
let courtQueuesLoaded = false;
let courtAssignmentsLoaded = false;
let isOffline = !navigator.onLine;
let maintenanceActive = false;
let courtStatusError = false;

initTabs();
initDivisionSwitch();
initConnectionWatch();
initBracketFullscreen();
activateTab(activeTab, false);
document.body.classList.toggle("venue-mode", venueDisplayLocked);
applyVenueDisplaySettings();

subscribeTournamentInfo((info) => {
  hideErrorBanner();
  tournamentInfo = info || {};
  maintenanceActive = tournamentInfo.maintenance?.active === true;
  document.getElementById("dashTitle").textContent = tournamentInfo.name || "바운스발리볼";
  setMaintenanceMode();
  applyVenueDisplaySettings();
  renderActiveDivision();
});

subscribeGroups((data) => {
  allGroups = data;
  renderActiveDivision();
});

subscribeTeams((data) => {
  allTeams = data;
  renderActiveDivision();
});

subscribePrelimMatches((data) => {
  allPrelimMatches = data;
  renderActiveDivision();
});

DIVISIONS.forEach((division) => {
  subscribeFinalMatches(division, (data) => {
    finalMatchesByDivision[division] = data;
    if (division === activeDivision) renderFinalBracket();
    renderCourtStatus();
  });
});

subscribeCourtStatus();

window.addEventListener("online", () => {
  isOffline = false;
  renderCourtStatus();
});
window.addEventListener("offline", () => {
  isOffline = true;
  renderCourtStatus();
});

function subscribeCourtStatus() {
  const base = ["tournaments", TOURNAMENT_ID];
  onSnapshot(collection(db, ...base, "courtQueues"), (snap) => {
    courtQueuesLoaded = true;
    courtStatusError = false;
    courtQueues = snap.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderCourtStatus();
  }, (err) => handleCourtStatusError("코트 대기열", err));
  onSnapshot(collection(db, ...base, "courtAssignments"), (snap) => {
    courtAssignmentsLoaded = true;
    courtStatusError = false;
    courtAssignments = snap.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderCourtStatus();
  }, (err) => handleCourtStatusError("코트 경기 배정", err));
}

function handleCourtStatusError(label, err) {
  courtStatusError = true;
  showErrorBanner(`⚠️ ${label} 구독에 실패했습니다. 코트 현황을 최신 상태로 표시할 수 없습니다.`);
  const message = document.getElementById("courtStatusMessage");
  if (message) message.textContent = "코트 현황을 불러오지 못했습니다. 연결 상태를 확인해주세요.";
  console.error(`[Firestore] ${label} 오류:`, err);
}

function divisionData(division = activeDivision) {
  const groups = allGroups.filter((group) => group.division === division);
  const groupIds = new Set(groups.map((group) => group.id));
  return {
    groups,
    teams: allTeams.filter((team) => team.division === division),
    prelimMatches: allPrelimMatches
      .filter((match) => match.division === division && groupIds.has(match.groupId))
      .map(publicMatchView),
    finalMatches: finalMatchesByDivision[division].map(publicMatchView),
  };
}

function publicMatchView(match) {
  if (Number.isInteger(match.officialRevision) && match.officialRevision > 0) return match;
  return {
    ...match,
    sets: [],
    result: null,
    winnerSide: null,
    winnerTeam: null,
    setsWonA: 0,
    setsWonB: 0,
    pointsForA: 0,
    pointsForB: 0,
    status: match.status === "in_progress" ? "in_progress" : "pending",
  };
}

function setActiveDivision(division, { updateUrl = false, announce = true } = {}) {
  if (!DIVISIONS.includes(division)) return;
  const changed = division !== activeDivision;
  activeDivision = division;
  document.body.dataset.division = division;
  document.querySelectorAll("#dashDivisionSwitch [data-division]").forEach((button) => {
    const active = button.dataset.division === division;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (updateUrl && !venueDisplayLocked) {
    const nextParams = new URLSearchParams(window.location.search);
    nextParams.set("division", division);
    nextParams.delete("display");
    history.replaceState(null, "", `${window.location.pathname}?${nextParams.toString()}`);
  }
  renderActiveDivision();
  if (changed && announce) {
    const shell = document.getElementById("dashboardShell");
    shell.classList.remove("division-refresh");
    void shell.offsetWidth;
    shell.classList.add("division-refresh");
  }
}

function renderActiveDivision() {
  if (maintenanceActive) return;
  const label = DIVISION_LABELS[activeDivision];
  document.getElementById("dashDivisionBadge").textContent = label;
  document.getElementById("dashBracketTitle").textContent = `${tournamentInfo.name || "바운스발리볼"} ${label} 본선 대진표`;
  renderPrelim();
  renderFinalBracket();
  renderCourtStatus();
}

function setMaintenanceMode() {
  const notice = document.getElementById("maintenanceNotice");
  const liveContent = document.getElementById("dashboardLiveContent");
  notice.hidden = !maintenanceActive;
  liveContent.hidden = maintenanceActive;
  document.getElementById("dashDivisionSwitch").hidden = maintenanceActive;
  if (maintenanceActive) {
    document.getElementById("dashPrelim").replaceChildren();
    document.getElementById("dashBracketContainer").replaceChildren();
    document.getElementById("courtStatusCards").replaceChildren();
  } else {
    renderCourtStatus();
  }
}

function renderCourtStatus() {
  if (maintenanceActive) return;
  const cards = document.getElementById("courtStatusCards");
  const message = document.getElementById("courtStatusMessage");
  if (!cards || !message) return;

  if (courtStatusError) {
    message.textContent = "코트 현황을 불러오지 못했습니다. 연결 상태를 확인해주세요.";
  } else if (isOffline) {
    message.textContent = "오프라인 상태입니다. 마지막으로 받은 코트 현황을 표시합니다.";
  } else if (!courtQueuesLoaded || !courtAssignmentsLoaded) {
    message.textContent = "코트 현황을 불러오는 중입니다.";
  } else if (!courtQueues.length) {
    message.textContent = "등록된 코트 대기열이 없습니다.";
  } else {
    message.textContent = "저장된 코트 대기열 기준 실시간 현황";
  }

  cards.replaceChildren();
  if (courtStatusError) {
    cards.appendChild(courtHint("코트 현황을 불러오지 못했습니다."));
    return;
  }
  if (!courtQueuesLoaded || !courtAssignmentsLoaded) {
    cards.appendChild(courtHint("코트 정보를 불러오는 중입니다."));
    return;
  }
  if (!courtQueues.length) {
    cards.appendChild(courtHint("현재 표시할 코트가 없습니다."));
    return;
  }

  const assignmentsByKey = new Map(courtAssignments.map((assignment) => [assignment.id, assignment]));
  const lookups = {
    teamsById: new Map(allTeams.map((team) => [team.id, team])),
    groupsById: new Map(allGroups.map((group) => [group.id, group])),
  };
  [...courtQueues].sort((a, b) => a.id.localeCompare(b.id, "ko")).forEach((queue) => {
    const card = document.createElement("article");
    card.className = "court-status-card";
    const title = document.createElement("h3");
    title.textContent = queue.courtName || queue.name || `${queue.id} 코트`;
    card.appendChild(title);
    card.append(
      courtMatchSlot("현재", queue.currentMatchKey, assignmentsByKey.get(queue.currentMatchKey), lookups),
      courtMatchSlot("다음", queue.nextMatchKey, assignmentsByKey.get(queue.nextMatchKey), lookups),
    );
    cards.appendChild(card);
  });
}

function courtHint(text) {
  const hint = document.createElement("div");
  hint.className = "empty-hint";
  hint.textContent = text;
  return hint;
}

function officialMatchFor(assignment) {
  if (!assignment?.matchId) return null;
  if (assignment.matchType === "final") {
    const division = assignment.divisionId || assignment.division;
    return finalMatchesByDivision[division]?.find((match) => match.id === assignment.matchId) || null;
  }
  return allPrelimMatches.find((match) => match.id === assignment.matchId) || null;
}

function courtMatchSlot(label, matchKey, assignment, lookups) {
  const slot = document.createElement("div");
  slot.className = "court-match-slot";
  const labelEl = document.createElement("strong");
  labelEl.textContent = label;
  const detail = document.createElement("div");
  detail.className = "court-match-detail";
  if (!matchKey) {
    detail.textContent = "배정된 경기 없음";
  } else if (!assignment) {
    detail.textContent = "경기 정보 확인 중";
  } else {
    const view = courtMatchSummary(assignment, officialMatchFor(assignment), lookups);
    const status = courtPublicStatus(assignment.publicStatus);
    detail.textContent = [view.label, view.teams, status].filter(Boolean).join(" · ");
  }
  slot.append(labelEl, detail);
  return slot;
}

function courtPublicStatus(status) {
  const labels = {
    under_review: "종료·검토 중",
    replay_required: "재경기 필요",
    rework_required: "재입력 필요",
    dependency_blocked: "대진 확정 대기",
    in_progress: "경기 중",
    completed: "완료",
    scheduled: "경기 예정",
  };
  return labels[status] || "경기 예정";
}

function initDivisionSwitch() {
  const switcher = document.getElementById("dashDivisionSwitch");
  switcher.querySelectorAll("[data-division]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.division === activeDivision));
    button.addEventListener("click", () => {
      if (venueDisplayLocked) return;
      setActiveDivision(button.dataset.division, { updateUrl: true });
    });
  });
  updateDivisionSwitchState();
  setActiveDivision(activeDivision, { announce: false });
}

function updateDivisionSwitchState() {
  const switcher = document.getElementById("dashDivisionSwitch");
  switcher.classList.toggle("is-venue", venueDisplayLocked);
  switcher.querySelectorAll("[data-division]").forEach((button) => {
    button.disabled = venueDisplayLocked;
    button.title = venueDisplayLocked ? "관리자 페이지의 송출 설정에 따라 자동 전환됩니다" : "";
  });
}

function applyVenueDisplaySettings() {
  const config = tournamentInfo.venueDisplay || {};
  const hasSavedSettings = ["auto", "men", "women"].includes(config.mode);
  venueDisplayLocked = isVenueMode || hasSavedSettings;
  document.body.classList.toggle("venue-mode", venueDisplayLocked);
  updateDivisionSwitchState();
  placeVenueStatus();

  if (!venueDisplayLocked) {
    stopVenueTimer();
    document.getElementById("venueSwitcher").hidden = true;
    venueConfigKey = "";
    return;
  }

  const mode = ["auto", "men", "women"].includes(config.mode) ? config.mode : "auto";
  const intervalSeconds = [10, 15, 20, 30].includes(Number(config.intervalSeconds)) ? Number(config.intervalSeconds) : 15;
  const cycleStartedAt = Number(config.cycleStartedAt) || Date.now();
  const key = `${mode}:${intervalSeconds}:${cycleStartedAt}`;
  if (key === venueConfigKey) return;
  venueConfigKey = key;
  stopVenueTimer();

  const status = document.getElementById("venueSwitcher");
  status.hidden = false;
  status.classList.toggle("is-pinned", mode !== "auto");
  if (mode === "men" || mode === "women") {
    setActiveDivision(mode);
    renderPinnedVenueStatus(mode);
    return;
  }

  const sync = () => syncVenueCycle(intervalSeconds, cycleStartedAt);
  sync();
  venueTimer = window.setInterval(sync, 250);
}

function syncVenueCycle(intervalSeconds, cycleStartedAt) {
  const intervalMs = intervalSeconds * 1000;
  const elapsed = Math.max(0, Date.now() - cycleStartedAt);
  const slot = Math.floor(elapsed / intervalMs);
  const elapsedInSlot = elapsed % intervalMs;
  const current = slot % 2 === 0 ? "men" : "women";
  const next = current === "men" ? "women" : "men";
  if (current !== activeDivision) setActiveDivision(current);

  const remainingMs = intervalMs - elapsedInSlot;
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const remainingPercent = Math.max(0, Math.min(100, (remainingMs / intervalMs) * 100));
  document.getElementById("venueCurrentDivision").textContent = `${DIVISION_LABELS[current]} 송출 중`;
  document.getElementById("venueNextDivision").textContent = `다음: ${DIVISION_LABELS[next]}`;
  document.getElementById("venueCountdown").textContent = `${remainingSeconds}초 후 전환`;
  const track = document.getElementById("venueProgressTrack");
  track.setAttribute("aria-valuenow", String(Math.round(100 - remainingPercent)));
  track.setAttribute("aria-valuetext", `${remainingSeconds}초 후 ${DIVISION_LABELS[next]}로 전환`);
  document.getElementById("venueProgressBar").style.transform = `scaleX(${remainingPercent / 100})`;
}

function renderPinnedVenueStatus(division) {
  document.getElementById("venueCurrentDivision").textContent = `${DIVISION_LABELS[division]} · 고정 송출 중`;
  document.getElementById("venueNextDivision").textContent = "";
  document.getElementById("venueCountdown").textContent = "";
  document.getElementById("venueProgressTrack").hidden = true;
}

function stopVenueTimer() {
  if (venueTimer) window.clearInterval(venueTimer);
  venueTimer = null;
  document.getElementById("venueProgressTrack").hidden = false;
}

function placeVenueStatus() {
  const status = document.getElementById("venueSwitcher");
  const card = document.getElementById("dashBracketCard");
  const home = document.getElementById("venueStatusHome");
  const inBracket = venueDisplayLocked && activeTab === "final";
  document.body.classList.toggle("venue-status-in-bracket", inBracket);
  if (inBracket) card.appendChild(status);
  else home.after(status);
}

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
  document.getElementById("errorBanner")?.classList.remove("show");
}

function initBracketFullscreen() {
  const btn = document.getElementById("dashBracketFullscreenBtn");
  const card = document.getElementById("dashBracketCard");
  const container = document.getElementById("dashBracketContainer");
  if (!btn || !card || !container) return null;

  let pseudoFullscreen = false;
  const applyState = (isFullscreen) => {
    card.classList.toggle("is-fullscreen", isFullscreen);
    btn.textContent = isFullscreen ? "전체화면 종료" : "⛶ 전체화면";
    container.dataset.fullscreenZoom = isFullscreen ? "1" : "";
    placeVenueStatus();
    renderFinalBracket();
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
    if (pseudoFullscreen) return exitPseudoFullscreen();
    const isNativeFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (isNativeFullscreen) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      return;
    }
    const request = card.requestFullscreen || card.webkitRequestFullscreen;
    if (!request) return enterPseudoFullscreen();
    let settled = false;
    const fallbackTimer = setTimeout(() => {
      if (!settled && !document.fullscreenElement && !document.webkitFullscreenElement) {
        settled = true;
        enterPseudoFullscreen();
      }
    }, 400);
    try {
      const result = request.call(card);
      if (result && typeof result.catch === "function") {
        result.then(() => {
          settled = true;
          clearTimeout(fallbackTimer);
        }).catch(() => {
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
    if (pseudoFullscreen) return;
    applyState((document.fullscreenElement || document.webkitFullscreenElement) === card);
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  return { applyState };
}

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab, true));
  });
}

function activateTab(tab, updateUrl) {
  activeTab = ["prelim", "final"].includes(tab) ? tab : "prelim";
  document.querySelectorAll(".tab-btn").forEach((button) => button.classList.toggle("active", button.dataset.tab === activeTab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${activeTab}`));
  placeVenueStatus();
  if (updateUrl) {
    const nextParams = new URLSearchParams(window.location.search);
    nextParams.set("tab", activeTab);
    history.replaceState(null, "", `${window.location.pathname}?${nextParams.toString()}`);
  }
  if (activeTab === "final") window.setTimeout(renderFinalBracket, 0);
}

function renderPrelim() {
  if (maintenanceActive) return;
  const state = divisionData();
  const el = document.getElementById("dashPrelim");
  if (!state.groups.length) {
    el.innerHTML = `<div class="empty-hint">${DIVISION_LABELS[activeDivision]} 예선 정보가 아직 없습니다.</div>`;
    return;
  }
  el.innerHTML = "";
  state.groups.forEach((group) => {
    const groupTeams = state.teams.filter((team) => team.groupId === group.id);
    const groupMatches = state.prelimMatches.filter((match) => match.groupId === group.id).sort((a, b) => (a.round || 0) - (b.round || 0));
    const standings = computeGroupStandings(groupTeams, groupMatches);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h2>📋 ${escapeHtml(group.name)}</h2>`;

    if ((group.matchMode || "roundrobin") === "ring" && groupTeams.length >= 2) {
      const ringOrder = normalizeRingOrder(group.ringOrder, groupTeams.map((team) => team.id));
      const diagramHost = document.createElement("div");
      diagramHost.style.margin = "0 auto 14px";
      card.appendChild(diagramHost);
      renderRingDiagram(diagramHost, {
        ringOrder,
        teamNameById: (id) => teamName(id, state),
        editable: false,
      });
    }

    if (standings.length) {
      const table = document.createElement("table");
      table.className = "standings-table";
      table.innerHTML = `<thead><tr><th>순위</th><th>팀</th><th>승</th><th>무</th><th>패</th><th>승점</th><th>세트득실</th><th>득실차</th></tr></thead>`;
      const tbody = document.createElement("tbody");
      standings.forEach((standing) => {
        const row = document.createElement("tr");
        if (standing.rank === 1) row.className = "rank-1";
        row.innerHTML = `<td>${standing.rank}${standing.needsLottery ? '<div class="lottery-flag">동률</div>' : ""}</td>
          <td>${escapeHtml(displayTeamName(standing.name))}</td><td>${standing.win}</td><td>${standing.draw}</td><td>${standing.loss}</td>
          <td>${standing.points}</td><td>${standing.setDiff >= 0 ? "+" : ""}${standing.setDiff}</td><td>${standing.pointDiff >= 0 ? "+" : ""}${standing.pointDiff}</td>`;
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      const scroll = document.createElement("div");
      scroll.className = "table-scroll";
      scroll.appendChild(table);
      card.appendChild(scroll);
    }

    const matchList = document.createElement("div");
    matchList.style.marginTop = "12px";
    groupMatches.forEach((match) => {
      const evaluated = evaluatePrelimMatch(match.sets || []);
      const scoreText = (match.sets || []).filter((set) => Number(set.a) > 0 || Number(set.b) > 0).map((set) => `${set.a}:${set.b}`).join(" / ");
      const badge = evaluated.result === "A" ? `<span class="badge win">${escapeHtml(teamName(match.teamA, state))} 승</span>`
        : evaluated.result === "B" ? `<span class="badge win">${escapeHtml(teamName(match.teamB, state))} 승</span>`
        : evaluated.result === "draw" ? '<span class="badge draw">무승부</span>'
        : evaluated.status === "in_progress" ? '<span class="badge">경기중</span>'
        : '<span class="badge">경기전</span>';
      const row = document.createElement("div");
      row.className = "row";
      row.style.justifyContent = "space-between";
      row.style.padding = "6px 2px";
      row.style.borderBottom = "1px solid var(--line)";
      row.style.fontSize = "13px";
      row.innerHTML = `<span>${escapeHtml(teamName(match.teamA, state))} vs ${escapeHtml(teamName(match.teamB, state))} <span style="color:var(--muted);">${scoreText}</span></span>${badge}`;
      matchList.appendChild(row);
    });
    card.appendChild(matchList);
    el.appendChild(card);
  });
}

function renderFinalBracket() {
  if (maintenanceActive) return;
  const state = divisionData();
  renderBracket(document.getElementById("dashBracketContainer"), state.finalMatches, {
    editable: false,
    getTeamLabel: (teamId) => teamGroupRankLabel(teamId, state),
  });
}

function teamName(id, state = divisionData()) {
  const team = state.teams.find((item) => item.id === id);
  return team ? displayTeamName(team.name) : "?";
}

function teamGroupRankLabel(teamId, state = divisionData()) {
  const team = state.teams.find((item) => item.id === teamId);
  if (!team) return "";
  const group = state.groups.find((item) => item.id === team.groupId);
  if (!group) return "";
  const groupTeams = state.teams.filter((item) => item.groupId === group.id);
  const groupMatches = state.prelimMatches.filter((match) => match.groupId === group.id);
  const standings = computeGroupStandings(groupTeams, groupMatches);
  const standing = standings.find((item) => item.teamId === teamId);
  return standing ? `${group.name} ${standing.rank}위` : group.name;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

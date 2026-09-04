import {
  subscribeTournamentInfo, subscribeGroups, subscribeTeams,
  subscribePrelimMatches, subscribeFinalMatches, getServerClockOffset,
} from "./firestore-service.js";
import { evaluatePrelimMatch, computeGroupStandings } from "./match-logic.js";
import { publicMatchView } from "./bracket.js";
import { renderBracket, displayTeamName } from "./bracket-render.js";
import { normalizeRingOrder, renderRingDiagram } from "./ring-bracket.js";

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
let maintenanceActive = false;
let venueServerTimeOffsetMs = null;
let venueClockRequest = null;
let venueClockRetry = null;
const FEED_IDS = ["tournament", "groups", "teams", "prelim", "men-final", "women-final"];
const feedHealth = Object.fromEntries(FEED_IDS.map((id) => [id, { state: "pending", message: "" }]));
const feedIdByLabel = {
  "대회정보": "tournament",
  "대회정보 구독": "tournament",
  "조 목록": "groups",
  "조 목록 구독": "groups",
  "팀 목록": "teams",
  "팀 목록 구독": "teams",
  "예선경기": "prelim",
  "예선경기 구독": "prelim",
  "men 본선경기": "men-final",
  "men 본선경기 구독": "men-final",
  "women 본선경기": "women-final",
  "women 본선경기 구독": "women-final",
};

initTabs();
initDivisionSwitch();
initConnectionWatch();
initBracketFullscreen();
activateTab(activeTab, false);
document.body.classList.toggle("venue-mode", venueDisplayLocked);
applyVenueDisplaySettings();
document.addEventListener("visibilitychange", () => {
  if (!isVenueMode || document.visibilityState !== "visible") return;
  stopVenueTimer();
  renderUnsyncedVenueStatus();
  venueServerTimeOffsetMs = null;
  venueConfigKey = "";
  ensureVenueServerClock();
});

subscribeTournamentInfo((info, metadata) => {
  setFeedSnapshot("tournament", metadata);
  tournamentInfo = info || {};
  maintenanceActive = tournamentInfo.maintenance?.enabled === true;
  document.getElementById("dashTitle").textContent = tournamentInfo.name || "바운스발리볼";
  setMaintenanceMode();
  applyVenueDisplaySettings();
  renderActiveDivision();
});

subscribeGroups((data, metadata) => {
  setFeedSnapshot("groups", metadata);
  allGroups = data;
  renderActiveDivision();
});

subscribeTeams((data, metadata) => {
  setFeedSnapshot("teams", metadata);
  allTeams = data;
  renderActiveDivision();
});

subscribePrelimMatches((data, metadata) => {
  setFeedSnapshot("prelim", metadata);
  allPrelimMatches = data;
  renderActiveDivision();
});

DIVISIONS.forEach((division) => {
  subscribeFinalMatches(division, (data, metadata) => {
    setFeedSnapshot(`${division}-final`, metadata);
    finalMatchesByDivision[division] = data;
    if (division === activeDivision) renderFinalBracket();
  });
});

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

function setActiveDivision(division, { updateUrl = false, announce = true } = {}) {
  if (!DIVISIONS.includes(division)) return;
  const changed = division !== activeDivision;
  activeDivision = division;
  document.body.dataset.division = division;
  ["dashDivisionBadge", "dashPrelim", "dashBracketCard", "venueSwitcher"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.dataset.divisionTheme = division;
  });
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
}

function setMaintenanceMode() {
  const notice = document.getElementById("maintenanceNotice");
  const liveContent = document.getElementById("dashboardLiveContent");
  const liveStatus = document.querySelector(".live-dot");
  notice.hidden = !maintenanceActive;
  liveContent.hidden = maintenanceActive;
  document.getElementById("dashDivisionSwitch").hidden = maintenanceActive;
  if (liveStatus) {
    liveStatus.classList.toggle("is-maintenance", maintenanceActive);
    liveStatus.setAttribute("role", "status");
    liveStatus.setAttribute("aria-live", "polite");
    liveStatus.setAttribute("aria-label", maintenanceActive ? "점검 중" : "실시간 데이터 상태");
    if (maintenanceActive) {
      liveStatus.dataset.feedHealth = "maintenance";
      liveStatus.textContent = "점검 중";
    }
  }
  if (maintenanceActive) {
    stopVenueTimer();
    venueConfigKey = "";
    document.getElementById("venueSwitcher").hidden = true;
    document.getElementById("dashPrelim").replaceChildren();
    document.getElementById("dashBracketContainer").replaceChildren();
  } else {
    updateFeedHealth();
  }
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
  venueDisplayLocked = isVenueMode;
  document.body.classList.toggle("venue-mode", venueDisplayLocked);
  updateDivisionSwitchState();
  if (maintenanceActive) {
    stopVenueTimer();
    document.getElementById("venueSwitcher").hidden = true;
    venueConfigKey = "";
    return;
  }
  placeVenueStatus();

  if (!venueDisplayLocked) {
    stopVenueTimer();
    document.getElementById("venueSwitcher").hidden = true;
    venueConfigKey = "";
    return;
  }

  const mode = ["auto", "men", "women"].includes(config.mode) ? config.mode : "auto";
  const intervalSeconds = [10, 15, 20, 30].includes(Number(config.intervalSeconds)) ? Number(config.intervalSeconds) : 15;
  const cycleStartedAt = timestampMillis(config.cycleStartedAt);
  const serverTimeOffsetMs = venueServerTimeOffsetMs;
  const key = `${mode}:${intervalSeconds}:${cycleStartedAt}:${serverTimeOffsetMs}`;
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
  if (!Number.isFinite(cycleStartedAt) || !Number.isFinite(serverTimeOffsetMs)) {
    renderUnsyncedVenueStatus();
    ensureVenueServerClock();
    return;
  }

  const sync = () => syncVenueCycle(intervalSeconds, cycleStartedAt, serverTimeOffsetMs);
  sync();
  venueTimer = window.setInterval(sync, 250);
}

function ensureVenueServerClock() {
  if (!isVenueMode || maintenanceActive || venueClockRequest || Number.isFinite(venueServerTimeOffsetMs)) return;
  if (venueClockRetry) {
    window.clearTimeout(venueClockRetry);
    venueClockRetry = null;
  }
  venueClockRequest = getServerClockOffset()
    .then((offset) => {
      venueServerTimeOffsetMs = offset;
      venueConfigKey = "";
      applyVenueDisplaySettings();
    })
    .catch(() => {
      venueServerTimeOffsetMs = null;
      stopVenueTimer();
      renderUnsyncedVenueStatus();
      venueClockRetry = window.setTimeout(() => {
        venueClockRetry = null;
        ensureVenueServerClock();
      }, 5000);
    })
    .finally(() => {
      venueClockRequest = null;
    });
}

function syncVenueCycle(intervalSeconds, cycleStartedAt, serverTimeOffsetMs) {
  const intervalMs = intervalSeconds * 1000;
  const elapsed = Math.max(0, (Date.now() + serverTimeOffsetMs) - cycleStartedAt);
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

function renderUnsyncedVenueStatus() {
  document.getElementById("venueCurrentDivision").textContent = "송출 동기화 대기";
  document.getElementById("venueNextDivision").textContent = "서버 기준 시간이 확인되면 자동 전환됩니다";
  document.getElementById("venueCountdown").textContent = "";
  document.getElementById("venueProgressTrack").hidden = true;
}

function timestampMillis(value) {
  if (Number.isFinite(value)) return Number(value);
  if (value && typeof value.toMillis === "function") {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
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
    setFeedError(feedIdByLabel[label], `${label} 실패${err?.code ? ` (${err.code})` : ""}`);
  });
  window.addEventListener("firestore-timeout", (e) => {
    setFeedError(feedIdByLabel[e.detail.label], `"${e.detail.label}" 실시간 연결이 응답하지 않습니다.`);
  });
}

function setFeedSnapshot(id, metadata) {
  const feed = feedHealth[id];
  if (!feed) return;
  const confirmed = metadata && metadata.fromCache === false && metadata.hasPendingWrites === false;
  feed.state = confirmed ? (feed.state === "error" || feed.state === "cache" ? "recovered" : "healthy") : "cache";
  feed.message = confirmed ? "" : `${id} 데이터가 서버에서 확인되지 않았습니다.`;
  updateFeedHealth();
}

function setFeedError(ids, message) {
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    if (!id || !feedHealth[id]) continue;
    feedHealth[id].state = "error";
    feedHealth[id].message = message;
  }
  updateFeedHealth();
}

function updateFeedHealth() {
  const failures = FEED_IDS.filter((id) => ['error', 'cache'].includes(feedHealth[id].state));
  const pending = FEED_IDS.filter((id) => feedHealth[id].state === "pending");
  const liveStatus = document.querySelector(".live-dot");
  if (liveStatus && !maintenanceActive) {
    const state = failures.length ? "degraded" : pending.length ? "pending" : "live";
    liveStatus.dataset.feedHealth = state;
    liveStatus.textContent = failures.length ? `일부 연결 지연 (${failures.length})` : pending.length ? "연결 확인 중" : "실시간 중계중";
    liveStatus.setAttribute("aria-label", failures.length
      ? `데이터 연결 저하: ${failures.join(", ")}`
      : pending.length ? `데이터 연결 확인 중: ${pending.join(", ")}`
      : "모든 데이터 연결 정상");
  }
  if (failures.length) {
    showErrorBanner(`⚠️ 일부 실시간 데이터 연결이 지연되고 있습니다: ${failures.map((id) => feedHealth[id].message || id).join(" / ")}`);
  } else {
    hideErrorBanner();
  }
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
      const row = document.createElement("div");
      row.className = "row";
      row.style.justifyContent = "space-between";
      row.style.padding = "6px 2px";
      row.style.borderBottom = "1px solid var(--line)";
      row.style.fontSize = "13px";
      const summary = document.createElement("span");
      summary.append(document.createTextNode(`${teamName(match.teamA, state)} vs ${teamName(match.teamB, state)} `));
      const score = document.createElement("span");
      score.style.color = "var(--muted)";
      score.textContent = scoreText;
      summary.appendChild(score);
      row.appendChild(summary);
      const result = document.createElement("span");
      result.className = evaluated.result === "A" || evaluated.result === "B" ? "badge win"
        : evaluated.result === "draw" ? "badge draw" : "badge";
      result.textContent = evaluated.result === "A" ? `${teamName(match.teamA, state)} 승`
        : evaluated.result === "B" ? `${teamName(match.teamB, state)} 승`
          : evaluated.result === "draw" ? "무승부"
            : evaluated.status === "in_progress" ? "경기중" : "경기전";
      row.appendChild(result);
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

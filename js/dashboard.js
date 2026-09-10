import {
  subscribeTournamentInfo, subscribeGroups, subscribeTeams,
  subscribePrelimMatches, subscribeFinalMatches, subscribePublicSchedule,
} from "./firestore-service.js";
import { evaluatePrelimMatch, computeGroupStandings } from "./match-logic.js";
import { publicMatchView } from "./bracket.js";
import { renderBracket, displayTeamName } from "./bracket-render.js";
import { formatCourtName, projectPrelimCourtSchedule } from "./court-display.js";

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
let publicSchedule = null;
let publicScheduleState = "loading";
let publicScheduleMessage = "순서 확인 중";
let publicScheduleIsCached = false;
let publicScheduleRetry = null;
let activeDivision = DIVISIONS.includes(requestedDivision) ? requestedDivision : "men";
let activeTab = requestedTab;
let venueTimer = null;
let venueConfigKey = "";
let venueDisplayLocked = isVenueMode;
let maintenanceActive = false;
let venueAutoStartedAt = null;
let venueAutoIntervalMs = null;
let venueAutoStartDivision = null;
let dashboardFitFrame = null;
let dashboardFitObserver = null;
let rootAuthorityState = "unavailable";
let rootAuthorityConfirmed = false;
const FEED_IDS = ["tournament", "groups", "teams", "prelim", "men-final", "women-final", "public-schedule"];
const feedHealth = Object.fromEntries(FEED_IDS.map((id) => (
  [id, { state: "pending", message: "", hasConfirmedSnapshot: false }]
)));
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
  "공개 경기 일정": "public-schedule",
  "공개 경기 일정 구독": "public-schedule",
  "공개 경기 일정 초기화": "public-schedule",
};

initTabs();
initDivisionSwitch();
initConnectionWatch();
initDashboardFullscreen();
initDashboardViewportFit();
activateTab(activeTab, false);
document.body.classList.toggle("venue-mode", venueDisplayLocked);
applyVenueDisplaySettings();
setMaintenanceMode();
scheduleDashboardFit();
document.addEventListener("visibilitychange", () => {
  if (!isVenueMode) return;
  if (document.visibilityState === "visible") {
    resumeVenueAuto();
  } else {
    stopVenueTimer();
  }
});

subscribeTournamentInfo((info, metadata) => {
  setFeedSnapshot("tournament", metadata);
  const confirmed = isServerConfirmed(metadata);
  if (confirmed || !rootAuthorityConfirmed) {
    tournamentInfo = info || {};
    maintenanceActive = tournamentInfo.maintenance?.enabled === true;
  }
  document.getElementById("dashTitle").textContent = tournamentInfo.name || "바운스발리볼";
  setMaintenanceMode();
  applyVenueDisplaySettings();
  renderActiveDivision();
});

subscribeGroups((data, metadata) => {
  if (!setFeedSnapshot("groups", metadata)) return;
  allGroups = data;
  renderActiveDivision();
});

subscribeTeams((data, metadata) => {
  if (!setFeedSnapshot("teams", metadata)) return;
  allTeams = data;
  renderActiveDivision();
});

subscribePrelimMatches((data, metadata) => {
  if (!setFeedSnapshot("prelim", metadata)) return;
  allPrelimMatches = data;
  renderActiveDivision();
});

DIVISIONS.forEach((division) => {
  subscribeFinalMatches(division, (data, metadata) => {
    if (!setFeedSnapshot(`${division}-final`, metadata)) return;
    finalMatchesByDivision[division] = data;
    if (division === activeDivision) renderFinalBracket();
  });
});

const publicScheduleSubscription = subscribePublicSchedule((data, metadata) => {
  if (data === null) {
    const accepted = setFeedPending("public-schedule", metadata, "저장된 코트 순서를 확인하는 중입니다.");
    if (!accepted) {
      if (!isServerConfirmed(metadata)) {
        publicScheduleIsCached = true;
        renderActiveDivision();
      }
      return;
    }
    publicSchedule = null;
    publicScheduleState = "loading";
    publicScheduleMessage = "순서 확인 중";
    publicScheduleIsCached = false;
    renderActiveDivision();
    return;
  }

  const normalized = normalizePublicSchedule(data);
  if (!normalized) {
    publicSchedule = null;
    publicScheduleState = "error";
    publicScheduleMessage = "순서 연결 오류";
    setFeedError("public-schedule", "공개 코트 일정 형식이 올바르지 않습니다.");
    return;
  }
  const accepted = setFeedSnapshot("public-schedule", metadata);
  const cached = metadata?.fromCache === true || metadata?.hasPendingWrites === true;
  if (!accepted && !cached) return;
  publicSchedule = normalized;
  publicScheduleState = normalized.status;
  publicScheduleMessage = normalized.status === "ready"
    ? ""
    : normalized.status === "maintenance" ? "순서 점검 중" : "순서 사용 불가";
  publicScheduleIsCached = cached;
  renderActiveDivision();
});
publicScheduleRetry = typeof publicScheduleSubscription?.retry === "function"
  ? publicScheduleSubscription.retry
  : null;

function normalizePublicSchedule(data) {
  if (!data || typeof data !== "object") return null;
  const status = ["ready", "maintenance", "unavailable"].includes(data.status) ? data.status : null;
  if (!status || !Array.isArray(data.courts) || !Array.isArray(data.assignments)) return null;

  const courts = [];
  for (const court of data.courts) {
    if (!court || typeof court.id !== "string" || !court.id.trim() || typeof court.name !== "string") return null;
    courts.push({ id: court.id, name: court.name });
  }
  const assignments = [];
  for (const assignment of data.assignments) {
    if (!assignment || typeof assignment.matchKey !== "string" || !assignment.matchKey
        || !["prelim", "final"].includes(assignment.matchType)) return null;
    const courtId = assignment.courtId === null
      ? null
      : typeof assignment.courtId === "string" && assignment.courtId.trim()
        ? assignment.courtId
        : null;
    const courtOrder = assignment.courtOrder === null
      ? null
      : typeof assignment.courtOrder === "number"
        && Number.isInteger(assignment.courtOrder)
        && Number.isFinite(assignment.courtOrder)
        && assignment.courtOrder > 0
        ? assignment.courtOrder
        : null;
    if (assignment.courtId !== null && courtId === null) return null;
    if (assignment.courtOrder !== null && courtOrder === null) return null;
    assignments.push({
      matchKey: assignment.matchKey,
      matchType: assignment.matchType,
      courtId,
      courtOrder,
    });
  }
  return { status, courts, assignments };
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
  scheduleDashboardFit();
  if (changed && announce) {
    const shell = document.getElementById("dashboardShell");
    shell.classList.remove("division-refresh");
    void shell.offsetWidth;
    shell.classList.add("division-refresh");
  }
}

function renderActiveDivision() {
  if (maintenanceActive || rootAuthorityState === "unavailable") return;
  const label = DIVISION_LABELS[activeDivision];
  document.getElementById("dashDivisionBadge").textContent = label;
  document.getElementById("dashBracketTitle").textContent = `${tournamentInfo.name || "바운스발리볼"} ${label} 본선 대진표`;
  renderPrelim();
  renderFinalBracket();
  scheduleDashboardFit();
}

function setMaintenanceMode() {
  const notice = document.getElementById("maintenanceNotice");
  const liveContent = document.getElementById("dashboardLiveContent");
  const controls = document.getElementById("dashboardControls");
  const liveStatus = document.querySelector(".live-dot");
  const rootUnavailable = rootAuthorityState === "unavailable";
  notice.hidden = !(maintenanceActive || rootUnavailable);
  notice.dataset.authorityState = rootUnavailable
    ? "unavailable"
    : maintenanceActive ? "maintenance" : "live";
  liveContent.hidden = maintenanceActive || rootUnavailable;
  if (controls) controls.hidden = maintenanceActive || rootUnavailable;
  notice.innerHTML = rootUnavailable
    ? "<h2>대회 상태 확인 중</h2><p>공식 대회 상태를 확인할 수 없어 경기 결과를 숨겼습니다. 연결을 다시 시도하는 중입니다.</p>"
    : "<h2>대회 시스템 점검 중</h2><p>점검이 끝난 뒤 경기 결과를 다시 안내합니다.</p>";
  if (liveStatus) {
    liveStatus.classList.toggle("is-maintenance", maintenanceActive || rootUnavailable);
    liveStatus.setAttribute("role", "status");
    liveStatus.setAttribute("aria-live", "polite");
    liveStatus.setAttribute("aria-label", rootUnavailable
      ? "대회 상태 확인 중"
      : maintenanceActive ? "점검 중" : "실시간 데이터 상태");
    if (rootUnavailable) {
      liveStatus.dataset.feedHealth = "reconnecting";
      liveStatus.textContent = "상태 확인 중";
    } else if (maintenanceActive) {
      liveStatus.dataset.feedHealth = "maintenance";
      liveStatus.textContent = "점검 중";
    }
  }
  if (maintenanceActive || rootUnavailable) {
    stopVenueTimer();
    venueConfigKey = "";
    document.getElementById("venueSwitcher").hidden = true;
    document.getElementById("dashPrelim").replaceChildren();
    document.getElementById("dashBracketContainer").replaceChildren();
  } else {
    updateFeedHealth();
  }
  scheduleDashboardFit();
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
  if (maintenanceActive || rootAuthorityState === "unavailable") {
    stopVenueTimer();
    document.getElementById("venueSwitcher").hidden = true;
    venueConfigKey = "";
    scheduleDashboardFit();
    return;
  }
  placeVenueStatus();

  if (!venueDisplayLocked) {
    stopVenueTimer();
    document.getElementById("venueSwitcher").hidden = true;
    venueConfigKey = "";
    scheduleDashboardFit();
    return;
  }

  const mode = ["auto", "men", "women"].includes(config.mode) ? config.mode : "auto";
  const intervalSeconds = [10, 15, 20, 30].includes(Number(config.intervalSeconds)) ? Number(config.intervalSeconds) : 15;
  const key = `${mode}:${intervalSeconds}`;
  if (key === venueConfigKey) {
    scheduleDashboardFit();
    return;
  }
  venueConfigKey = key;
  stopVenueTimer();

  const status = document.getElementById("venueSwitcher");
  status.hidden = false;
  status.classList.toggle("is-pinned", mode !== "auto");
  if (mode === "men" || mode === "women") {
    venueAutoStartedAt = null;
    venueAutoIntervalMs = null;
    venueAutoStartDivision = null;
    setActiveDivision(mode);
    renderPinnedVenueStatus(mode);
    scheduleDashboardFit();
    return;
  }

  document.getElementById("venueProgressTrack").hidden = false;
  const current = DIVISIONS.includes(activeDivision) ? activeDivision : DIVISIONS[0];
  venueAutoStartDivision = current;
  venueAutoIntervalMs = intervalSeconds * 1000;
  venueAutoStartedAt = venueNow();
  resumeVenueAuto();
  scheduleDashboardFit();
}

function venueNow() {
  return window.performance.now();
}

function syncVenueCycle(now = venueNow()) {
  if (!Number.isFinite(now) || !Number.isFinite(venueAutoStartedAt)
      || !Number.isFinite(venueAutoIntervalMs) || venueAutoIntervalMs <= 0) return;
  const elapsed = Math.max(0, now - venueAutoStartedAt);
  const intervalMs = venueAutoIntervalMs;
  const slot = Math.floor(elapsed / intervalMs);
  const elapsedInSlot = elapsed % intervalMs;
  const initialIndex = DIVISIONS.indexOf(venueAutoStartDivision);
  const current = DIVISIONS[(initialIndex + slot) % DIVISIONS.length] || DIVISIONS[0];
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

function resumeVenueAuto() {
  if (!isVenueMode || maintenanceActive || rootAuthorityState === "unavailable"
      || document.visibilityState === "hidden") return;
  if (!Number.isFinite(venueAutoStartedAt) || !Number.isFinite(venueAutoIntervalMs)) return;
  syncVenueCycle();
  if (venueTimer !== null) return;
  venueTimer = window.setInterval(() => syncVenueCycle(), 250);
}

function renderPinnedVenueStatus(division) {
  document.getElementById("venueCurrentDivision").textContent = `${DIVISION_LABELS[division]} · 고정 송출 중`;
  document.getElementById("venueNextDivision").textContent = "";
  document.getElementById("venueCountdown").textContent = "";
  document.getElementById("venueProgressTrack").hidden = true;
}

function stopVenueTimer() {
  if (venueTimer !== null) window.clearInterval(venueTimer);
  venueTimer = null;
}

function placeVenueStatus() {
  const status = document.getElementById("venueSwitcher");
  const home = document.getElementById("venueStatusHome");
  if (!status || !home) return;
  home.after(status);
  scheduleDashboardFit();
}

function initConnectionWatch() {
  window.addEventListener("firestore-error", (e) => {
    const { label, err } = e.detail;
    setFeedError(
      feedIdByLabel[label],
      `${label} 실패${err?.code ? ` (${err.code})` : ""} · 재연결 중`,
    );
  });
  window.addEventListener("firestore-timeout", (e) => {
    setFeedError(
      feedIdByLabel[e.detail.label],
      `"${e.detail.label}" 실시간 연결이 응답하지 않습니다. 재연결 중입니다.`,
    );
  });
}

function isServerConfirmed(metadata) {
  return Boolean(metadata
    && metadata.fromCache === false
    && metadata.hasPendingWrites === false);
}

function setFeedSnapshot(id, metadata) {
  const feed = feedHealth[id];
  if (!feed) return false;
  const confirmed = isServerConfirmed(metadata);
  const accepted = confirmed || !feed.hasConfirmedSnapshot;
  if (confirmed) {
    feed.hasConfirmedSnapshot = true;
    feed.state = feed.state === "error" || feed.state === "cache" ? "recovered" : "healthy";
  } else if (feed.state !== "error") {
    feed.state = "cache";
  }
  if (confirmed || feed.state !== "error") {
    feed.message = confirmed ? "" : `${id} 데이터가 서버에서 확인되지 않았습니다.`;
  }
  if (id === "tournament") {
    if (confirmed) {
      rootAuthorityConfirmed = true;
      rootAuthorityState = "confirmed";
    } else if (!rootAuthorityConfirmed || rootAuthorityState === "unavailable") {
      rootAuthorityState = "unavailable";
    } else {
      rootAuthorityState = "cache";
    }
  }
  updateFeedHealth();
  return accepted;
}

function setFeedPending(id, metadata, message) {
  const feed = feedHealth[id];
  if (!feed) return false;
  const confirmed = isServerConfirmed(metadata);
  const accepted = confirmed || !feed.hasConfirmedSnapshot;
  feed.state = confirmed ? "pending" : feed.state === "error" ? "error" : "cache";
  if (confirmed || feed.state !== "error") {
    feed.message = message || `${id} 데이터가 아직 준비되지 않았습니다.`;
  }
  updateFeedHealth();
  return accepted;
}

function setFeedError(ids, message) {
  const targetIds = Array.isArray(ids) ? ids : [ids];
  for (const id of targetIds) {
    if (!id || !feedHealth[id]) continue;
    feedHealth[id].state = "error";
    feedHealth[id].message = message;
  }
  if (targetIds.includes("tournament")) {
    rootAuthorityState = "unavailable";
    setMaintenanceMode();
  }
  if (targetIds.includes("public-schedule")) {
    publicSchedule = null;
    publicScheduleState = "error";
    publicScheduleMessage = "순서 연결 오류";
    publicScheduleIsCached = false;
    renderActiveDivision();
  }
  updateFeedHealth();
}

function updateFeedHealth() {
  const failures = FEED_IDS.filter((id) => feedHealth[id].state === "error");
  const cached = FEED_IDS.filter((id) => feedHealth[id].state === "cache");
  const pending = FEED_IDS.filter((id) => feedHealth[id].state === "pending");
  const liveStatus = document.querySelector(".live-dot");
  if (liveStatus && !maintenanceActive && rootAuthorityState !== "unavailable") {
    const state = failures.length ? "degraded" : cached.length ? "cache" : pending.length ? "pending" : "live";
    liveStatus.dataset.feedHealth = state;
    liveStatus.textContent = failures.length
      ? `일부 연결 지연 (${failures.length})`
      : cached.length ? "오프라인 캐시 표시 중" : pending.length ? "연결 확인 중" : "실시간 중계중";
    liveStatus.setAttribute("aria-label", failures.length
      ? `데이터 연결 저하: ${failures.join(", ")}`
      : cached.length ? `오프라인 캐시 표시 중: ${cached.join(", ")}`
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
  scheduleDashboardFit();
}

function hideErrorBanner() {
  const el = document.getElementById("errorBanner");
  if (!el) return;
  const changed = el.classList.contains("show");
  el.classList.remove("show");
  if (changed) scheduleDashboardFit();
}

function initDashboardFullscreen() {
  const button = document.getElementById("dashFullscreenBtn");
  if (!button) return;
  const status = document.getElementById("dashboardFullscreenStatus");

  const nativeFullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const setState = (isFullscreen) => {
    document.body.classList.toggle("dashboard-browser-fullscreen", isFullscreen);
    button.textContent = isFullscreen ? "전체화면 종료" : "⛶ 전체화면";
    button.setAttribute("aria-pressed", String(isFullscreen));
    scheduleDashboardFit();
  };
  const showStatus = (message) => {
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  };
  const clearStatus = () => {
    if (status) {
      status.textContent = "";
      status.hidden = true;
    }
  };

  button.addEventListener("click", () => {
    clearStatus();
    if (nativeFullscreenElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => Promise.resolve())).call(document);
      return;
    }
    const request = document.documentElement.requestFullscreen
      || document.documentElement.webkitRequestFullscreen;
    if (!request) {
      showStatus("이 브라우저에서는 전체화면을 지원하지 않습니다.");
      return;
    }
    try {
      const result = request.call(document.documentElement);
      if (result && typeof result.catch === "function") {
        result.then(clearStatus).catch(() => {
          setState(false);
          showStatus("전체화면 권한이 거부되었습니다.");
        });
      }
    } catch (err) {
      setState(false);
      showStatus("전체화면 권한이 거부되었습니다.");
    }
  });

  const onFullscreenChange = () => {
    const isFullscreen = Boolean(nativeFullscreenElement());
    setState(isFullscreen);
    if (isFullscreen) clearStatus();
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
}

function initDashboardViewportFit() {
  const viewport = document.getElementById("dashboardViewport");
  if (!viewport) return;
  window.addEventListener("resize", scheduleDashboardFit, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    dashboardFitObserver = new ResizeObserver(() => scheduleDashboardFit());
    dashboardFitObserver.observe(viewport);
  }
  if (document.fonts) {
    document.fonts.ready.then(() => scheduleDashboardFit()).catch(() => {});
    document.fonts.addEventListener?.("loadingdone", scheduleDashboardFit);
  }
}

function scheduleDashboardFit() {
  if (dashboardFitFrame !== null) return;
  dashboardFitFrame = window.requestAnimationFrame(() => {
    dashboardFitFrame = null;
    fitDashboardViewport();
  });
}

function dashboardPrelimLayoutWidth(viewportWidth) {
  if (activeTab !== "prelim") return viewportWidth;
  const prelim = document.getElementById("dashPrelim");
  if (!prelim) return viewportWidth;
  const cards = [...prelim.children].filter((child) => child.matches(".card"));
  if (!cards.length) return viewportWidth;
  const style = getComputedStyle(prelim);
  const columnGap = parseFloat(style.columnGap || style.gap || "16") || 16;
  const measuredCardWidth = Math.max(
    280,
    ...cards.map((card) => Math.ceil(card.scrollWidth || card.getBoundingClientRect().width || 0)),
  );
  const cardWidth = Math.min(480, measuredCardWidth);
  const columns = Math.min(cards.length, Math.max(1, Math.ceil(Math.sqrt(cards.length))));
  return Math.max(viewportWidth, columns * cardWidth + Math.max(0, columns - 1) * columnGap);
}

function setDashboardLayoutWidth(stage, width) {
  stage.style.width = `${Math.max(1, width)}px`;
}

function measureDashboardStage(stage) {
  const stageRect = stage.getBoundingClientRect();
  let left = 0;
  let top = 0;
  let right = Math.max(stage.offsetWidth || 0, stage.scrollWidth || 0);
  let bottom = Math.max(stage.offsetHeight || 0, stage.scrollHeight || 0);
  stage.querySelectorAll("*").forEach((element) => {
    if (element.hidden) return;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return;
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    left = Math.min(left, rect.left - stageRect.left);
    top = Math.min(top, rect.top - stageRect.top);
    right = Math.max(right, rect.right - stageRect.left);
    bottom = Math.max(bottom, rect.bottom - stageRect.top);
  });
  return {
    left: Math.floor(left),
    top: Math.floor(top),
    width: Math.ceil(right - left),
    height: Math.ceil(bottom - top),
  };
}

function fitDashboardViewport() {
  const viewport = document.getElementById("dashboardViewport");
  const stage = document.getElementById("dashboardStage");
  const prelim = document.getElementById("dashPrelim");
  if (prelim) prelim.classList.remove("dashboard-prelim-compact");
  if (!viewport || !stage || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;

  stage.style.transform = "none";
  stage.style.left = "0px";
  stage.style.top = "0px";
  stage.style.height = "auto";
  const viewportWidth = viewport.clientWidth;
  const viewportHeight = viewport.clientHeight;
  setDashboardLayoutWidth(stage, viewportWidth);
  const minimumWidth = dashboardPrelimLayoutWidth(viewportWidth);
  setDashboardLayoutWidth(stage, minimumWidth);

  let natural = measureDashboardStage(stage);
  if (natural.width > minimumWidth + 1 || natural.left < -1 || natural.top < -1) {
    setDashboardLayoutWidth(stage, natural.width);
    natural = measureDashboardStage(stage);
  }
  if (activeTab === "prelim" && prelim && natural.height > viewportHeight) {
    prelim.classList.add("dashboard-prelim-compact");
    natural = measureDashboardStage(stage);
  }
  const naturalWidth = Math.max(1, natural.width);
  const naturalHeight = Math.max(1, natural.height);
  const scale = Math.min(1, viewportWidth / naturalWidth, viewportHeight / naturalHeight);
  const scaledWidth = naturalWidth * scale;
  const scaledHeight = naturalHeight * scale;
  const left = Math.max(0, (viewportWidth - scaledWidth) / 2 - natural.left * scale);
  const top = Math.max(0, (viewportHeight - scaledHeight) / 2 - natural.top * scale);

  setDashboardLayoutWidth(stage, naturalWidth);
  stage.style.height = `${naturalHeight}px`;
  stage.style.transformOrigin = "top left";
  stage.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  stage.dataset.dashboardScale = String(scale);
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
  scheduleDashboardFit();
  if (updateUrl) {
    const nextParams = new URLSearchParams(window.location.search);
    nextParams.set("tab", activeTab);
    history.replaceState(null, "", `${window.location.pathname}?${nextParams.toString()}`);
  }
  if (activeTab === "final") {
    window.setTimeout(() => {
      renderFinalBracket();
      scheduleDashboardFit();
    }, 0);
  }
}

function publicScheduleNoticeText() {
  if (publicScheduleState === "ready" && publicScheduleIsCached) {
    return "저장된 순서 확인 중: 오프라인 캐시를 표시하고 있습니다.";
  }
  if (publicScheduleState === "error") return "순서 연결 오류: 저장된 코트 순서를 확인하지 못했습니다.";
  if (publicScheduleState === "maintenance") return "순서 점검 중: 경기 결과는 계속 표시됩니다.";
  if (publicScheduleState === "unavailable") return "순서 사용 불가: 경기 결과는 계속 표시됩니다.";
  return "순서 확인 중: 저장된 코트 순서를 연결하는 중입니다.";
}

function appendPublicScheduleNotice(parent) {
  if (publicScheduleState === "ready" && !publicScheduleIsCached) return;
  const notice = document.createElement("div");
  notice.className = `public-schedule-status is-${publicScheduleState}${publicScheduleIsCached ? " is-cache" : ""}`;
  notice.dataset.publicScheduleState = publicScheduleIsCached ? "cache" : publicScheduleState;
  const text = document.createElement("strong");
  text.textContent = publicScheduleNoticeText();
  notice.appendChild(text);
  if (publicScheduleState === "error" && publicScheduleRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn small";
    retry.textContent = "순서 다시 연결";
    retry.addEventListener("click", () => publicScheduleRetry());
    notice.appendChild(retry);
  }
  parent.appendChild(notice);
}

function structuralPrelimMatches(matches) {
  return [...matches].sort((left, right) => {
    const leftRound = Number(left?.round);
    const rightRound = Number(right?.round);
    const normalizedLeft = Number.isFinite(leftRound) ? leftRound : Number.POSITIVE_INFINITY;
    const normalizedRight = Number.isFinite(rightRound) ? rightRound : Number.POSITIVE_INFINITY;
    return normalizedLeft - normalizedRight
      || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
  });
}

function structuralPrelimNumbers(matches) {
  return new Map(structuralPrelimMatches(matches).map((match, index) => {
    const round = Number(match?.round);
    return [match.id, Number.isFinite(round) && round > 0 ? round : index + 1];
  }));
}

function publicPrelimSchedule(state) {
  if (publicScheduleState !== "ready" || !publicSchedule) return null;
  return projectPrelimCourtSchedule(
    state.prelimMatches,
    publicSchedule.assignments.filter((assignment) => assignment.matchType === "prelim"),
    publicSchedule.courts,
  );
}

function createPublicPrelimMatchRow(match, scheduleRow, structuralNumber, state) {
  const row = document.createElement("div");
  row.className = "prelim-match-row dashboard-prelim-match-row";
  row.dataset.prelimMatchRow = match.id;
  row.dataset.prelimMatchId = match.id;
  if (scheduleRow?.courtOrder !== null && scheduleRow?.courtOrder !== undefined) {
    row.dataset.prelimCourtOrder = String(scheduleRow.courtOrder);
  }

  const matchup = document.createElement("span");
  matchup.className = "prelim-matchup";
  const line = document.createElement("span");
  line.className = "prelim-matchup-line";
  const teamA = document.createElement("strong");
  teamA.textContent = teamName(match.teamA, state);
  const versus = document.createElement("b");
  versus.textContent = "VS";
  const teamB = document.createElement("strong");
  teamB.textContent = teamName(match.teamB, state);
  line.append(teamA, versus, teamB);
  matchup.appendChild(line);

  const scoreText = (match.sets || [])
    .filter((set) => Number(set.a) > 0 || Number(set.b) > 0)
    .map((set) => `${set.a}:${set.b}`)
    .join(" / ");
  if (scoreText) {
    const score = document.createElement("span");
    score.className = "prelim-score-text";
    score.textContent = scoreText;
    matchup.appendChild(score);
  }
  if (publicScheduleState === "ready") {
    const execution = document.createElement("span");
    execution.className = "prelim-execution-label";
    execution.dataset.prelimExecutionLabel = match.id;
    execution.textContent = scheduleRow?.label || "미배정";
    matchup.appendChild(execution);
  }
  row.append(matchup);

  const evaluated = evaluatePrelimMatch(match.sets || []);
  const result = document.createElement("span");
  result.className = evaluated.result === "A" || evaluated.result === "B" ? "badge win"
    : evaluated.result === "draw" ? "badge draw" : "badge";
  result.textContent = evaluated.result === "A" ? `${teamName(match.teamA, state)} 승`
    : evaluated.result === "B" ? `${teamName(match.teamB, state)} 승`
      : evaluated.result === "draw" ? "무승부"
        : evaluated.status === "in_progress" ? "경기중" : "경기전";
  row.appendChild(result);
  return row;
}

function appendPublicPrelimScheduleLanes(parent, groupMatches, state) {
  const schedule = publicPrelimSchedule(state) || [];
  const scheduleById = new Map(schedule.map((item) => [item.match.id, item]));
  const scheduleIndex = new Map(schedule.map((item, index) => [item.match.id, index]));
  const structuralNumbers = structuralPrelimNumbers(groupMatches);
  const laneDefinitions = [];
  const courtIds = new Set();
  publicSchedule.courts.forEach((court) => {
    if (courtIds.has(court.id)) return;
    courtIds.add(court.id);
    laneDefinitions.push([court.id, court.name]);
  });
  laneDefinitions.push(["", "미배정"]);
  const rowsByLane = new Map();
  groupMatches.forEach((match) => {
    const scheduleRow = scheduleById.get(match.id) || {
      match,
      courtId: null,
      courtOrder: null,
      label: "미배정",
    };
    const laneKey = scheduleRow.courtId || "";
    if (!rowsByLane.has(laneKey)) rowsByLane.set(laneKey, []);
    rowsByLane.get(laneKey).push({ match, scheduleRow });
  });

  const lanes = document.createElement("div");
  lanes.className = "prelim-court-lanes public-prelim-court-lanes";
  laneDefinitions.forEach(([courtId, name]) => {
    const items = rowsByLane.get(courtId);
    if (!items?.length) return;
    const lane = document.createElement("section");
    lane.className = "prelim-court-lane";
    lane.dataset.prelimCourtLane = courtId;
    const heading = document.createElement("h4");
    heading.className = "prelim-court-lane-heading";
    heading.textContent = courtId ? formatCourtName(name, "이름 없는 코트") : name;
    const list = document.createElement("div");
    list.className = "prelim-match-list";
    items.sort((left, right) => (
      (scheduleIndex.get(left.match.id) ?? Number.POSITIVE_INFINITY)
        - (scheduleIndex.get(right.match.id) ?? Number.POSITIVE_INFINITY)
    )).forEach(({ match, scheduleRow }) => {
      list.appendChild(createPublicPrelimMatchRow(
        match,
        scheduleRow,
        structuralNumbers.get(match.id) || 1,
        state,
      ));
    });
    lane.append(heading, list);
    lanes.appendChild(lane);
  });
  parent.appendChild(lanes);
}

function appendPublicPrelimStructuralList(parent, groupMatches, state) {
  const list = document.createElement("div");
  list.className = "prelim-match-list public-prelim-structural-list";
  const numbers = structuralPrelimNumbers(groupMatches);
  structuralPrelimMatches(groupMatches).forEach((match) => {
    list.appendChild(createPublicPrelimMatchRow(match, null, numbers.get(match.id) || 1, state));
  });
  parent.appendChild(list);
}

function renderPrelim() {
  if (maintenanceActive || rootAuthorityState === "unavailable") return;
  const state = divisionData();
  const el = document.getElementById("dashPrelim");
  el.replaceChildren();
  appendPublicScheduleNotice(el);
  if (!state.groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-hint";
    empty.textContent = `${DIVISION_LABELS[activeDivision]} 예선 정보가 아직 없습니다.`;
    el.appendChild(empty);
    return;
  }
  state.groups.forEach((group) => {
    const groupTeams = state.teams.filter((team) => team.groupId === group.id);
    const groupMatches = state.prelimMatches.filter((match) => match.groupId === group.id);
    const standings = computeGroupStandings(groupTeams, groupMatches);
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.prelimGroupId = group.id;
    const heading = document.createElement("h2");
    heading.textContent = `${group.name} 예선`;
    card.appendChild(heading);

    if (standings.length) {
      const table = document.createElement("table");
      table.className = "standings-table";
      table.innerHTML = `<thead><tr><th>순위</th><th>팀</th><th>승</th><th>무</th><th>패</th><th>승점</th><th><span>세트</span><wbr><span>득실</span></th><th>득실차</th></tr></thead>`;
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

    if (!groupMatches.length) {
      const empty = document.createElement("div");
      empty.className = "empty-hint";
      empty.textContent = "생성된 경기가 없습니다.";
      card.appendChild(empty);
    } else if (publicScheduleState === "ready") {
      appendPublicPrelimScheduleLanes(card, groupMatches, state);
    } else {
      appendPublicPrelimStructuralList(card, groupMatches, state);
    }
    el.appendChild(card);
  });
}

function renderFinalBracket() {
  if (maintenanceActive || rootAuthorityState === "unavailable") return;
  const state = divisionData();
  const container = document.getElementById("dashBracketContainer");
  renderBracket(container, state.finalMatches, {
    editable: false,
    viewportFit: "dashboard",
    getTeamLabel: (teamId) => teamGroupRankLabel(teamId, state),
  });
  appendFinalQualificationNotice(container, activeDivision, state.finalMatches);
  scheduleDashboardFit();
}

function appendFinalQualificationNotice(parent, division, matches) {
  if (!matches?.length) return;
  const proof = tournamentInfo.finalQualification?.[division];
  if (proof?.status === "current") return;
  const notice = document.createElement("div");
  notice.className = "qualification-stale-notice";
  notice.dataset.qualificationState = "stale";
  notice.setAttribute("role", "status");
  notice.textContent = "본선 진출팀 재확인 필요 · 이전 공개 대진";
  parent.prepend(notice);
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

import { isFirebaseConfigured, db } from "./firebase-init.js";
import {
  collection, doc, getDoc, getDocs, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { watchAuthState, login, logout, requestPasswordReset, changePassword, describeAuthError } from "./auth-service.js";
import {
  saveTournamentInfo, subscribeTournamentInfo,
  addGroup, reorderGroups, deleteGroup, deleteAllGroups, subscribeGroups,
  addTeam, deleteTeam, moveAndReorderTeam, deleteAllTeams, subscribeTeams,
  generatePrelimMatchesForGroup, subscribePrelimMatches, reorderPrelimMatches, clearAllPrelimMatches,
  setGroupMatchMode, setGroupRingOrder, clearPrelimMatchesForGroup, generateRingMatchesForGroup, resetAllRingOrders,
  publishFinalBracket, subscribeFinalMatches, clearFinalBracket,
  exportAllData, importAllData,
} from "./firestore-service.js";
import { evaluatePrelimMatch, computeGroupStandings, validateSetScore } from "./match-logic.js";
import { buildCrossGroupSeedOrder, swapFinalSeedSlots, confirmBye, placeByeTeam, generateBracket } from "./bracket.js";
import { renderBracket } from "./bracket-render.js";
import { buildFullResultsCsv, downloadCsv } from "./csv-export.js";
import { normalizeRingOrder, getRingMatchPairs, renderRingDiagram } from "./ring-bracket.js";
import { orderExistingRoundRobinMatchIds } from "./schedule.js";
import { adminWorkflowCallable } from "./workflow-service.js";
import { reconcilePlannerAssignments } from "./score-workflow.js";
import {
  courtMatchSummary, courtTeamNames, formatCourtName, normalizeCourtName, syncCourtOrderWithPrelimOrder,
} from "./court-display.js";
import { TOURNAMENT_ID } from "./firebase-config.js";

// ---------------- 상태 ----------------
let tournamentInfo = {};
let activeDivision = "men";
document.body.dataset.division = activeDivision;
let allGroups = [];
let allTeams = [];
let allPrelimMatches = [];
let groups = [];
let teams = [];
let prelimMatches = [];
let finalMatches = [];
let seedSelection = []; // 본선 진출팀 id 순서 (시드순)
let seedAutoMode = true; // true면 예선 순위 기준 추천 진출팀을 매 렌더마다 자동으로 채움 (체크박스/화살표를 직접 조작하면 false로 바뀜)
let pendingAutoSelectGroupName = null; // 방금 추가한 조 이름 — 팀 등록 select에 자동 선택용
let ringSelection = null; // 링크제 클릭배치 중 선택 상태: { type:'pool'|'vertex', teamId|index, groupId }
let isAddingGroup = false; // 저장 응답 전 중복 클릭/Enter로 같은 조가 두 번 생성되는 것을 막는다
let isAddingTeam = false; // 저장 응답 전 중복 클릭/Enter로 같은 팀이 두 번 생성되는 것을 막는다
// 대진표 자리 드래그/부전승 배치는 누를 때마다 바로 관객 화면(대시보드)에 공개되면
// 관객이 "아직 정해지지 않은" 자리 이동을 결과로 오해할 수 있다. 그래서 이 조정들은
// 일단 화면(로컬)에서만 반영해두고, 관리자가 "관객 화면에 공개" 버튼을 눌러야만
// Firestore에 저장돼 대시보드에 실제로 공유된다.
let bracketPublishPending = false;
let unsubscribeFinalMatches = null;
let reviewAssignments = [];
let reviewWorkflows = new Map();
let reviewQueues = new Map();
let reviewCourts = new Map();
let reviewAudits = new Map();
const reviewFinalMatchesByDivision = { men: [], women: [] };
let correctionPreview = null;
let unsubscribeWorkflowReviews = [];
let workflowDraftAssignments = [];
let workflowDraftCourts = [];
let workflowDirty = false;
let workflowSaveInProgress = false;
let tournamentResetInProgress = false;
let tournamentResetState = null;
const TOURNAMENT_RESET_STATE_KEY = "bounce-volleyball:tournament-reset";

const DIVISION_LABELS = { men: "남자부", women: "여자부" };
const divisionLabel = () => DIVISION_LABELS[activeDivision];

function syncDivisionThemeScopes() {
  ["divisionSetupSession", "tab-prelim", "tab-final"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.dataset.divisionTheme = activeDivision;
  });
}

function loadTournamentResetState() {
  if (tournamentResetState) return tournamentResetState;
  try {
    tournamentResetState = JSON.parse(sessionStorage.getItem(TOURNAMENT_RESET_STATE_KEY) || "null");
  } catch {
    tournamentResetState = null;
  }
  return tournamentResetState;
}

function saveTournamentResetState(state) {
  tournamentResetState = state;
  try {
    if (state) sessionStorage.setItem(TOURNAMENT_RESET_STATE_KEY, JSON.stringify(state));
    else sessionStorage.removeItem(TOURNAMENT_RESET_STATE_KEY);
  } catch {
    // 현재 페이지에서는 메모리 상태로 재시도를 이어간다.
  }
}

function refreshActiveDivisionData() {
  groups = allGroups.filter((group) => group.division === activeDivision);
  teams = allTeams.filter((team) => team.division === activeDivision);
  prelimMatches = allPrelimMatches.filter((match) => match.division === activeDivision);
  document.getElementById("teamCount").textContent = teams.length;
  renderGroupList();
  renderTeamGroupSelect();
  renderGroupTeamLists();
  renderPrelimViews();
  renderFinalTeamPicker();
  renderWorkflowCourtPlanner();
  renderScoreReviews();
}

function rebindFinalMatches() {
  unsubscribeFinalMatches?.();
  finalMatches = [];
  renderFinalBracket();
  renderFinalTeamPicker();
  unsubscribeFinalMatches = subscribeFinalMatches(activeDivision, (data) => {
    finalMatches = data;
    if (!workflowDirty) resetWorkflowDraft();
    else refreshWorkflowMatchMetadata();
    renderFinalBracket();
    renderFinalTeamPicker();
    renderWorkflowCourtPlanner();
  });
}

// 공개하지 않은 대진 조정이 남은 채로 탭을 닫거나 새로고침하면 그 조정은 그대로 사라지므로
// (다시 열면 Firestore에 저장된 마지막 공개 상태로 돌아감), 미리 경고한다.
window.addEventListener("beforeunload", (e) => {
  if (!bracketPublishPending && !workflowDirty) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---------------- 부트스트랩 ----------------

if (!isFirebaseConfigured) {
  showToast("firebase-config.js 에 Firebase 설정값을 입력해야 동기화가 동작합니다.", 6000);
}

initAuthGate();
initTabs();
initHelpTooltips();
bindStaticHandlers();
initConnectionWatch();

subscribeTournamentInfo((info) => {
  hideErrorBanner();
  setConnStatus(true);
  tournamentInfo = info || {};
  const nameInput = document.getElementById("tournamentNameInput");
  if (nameInput && !nameInput.value) nameInput.value = tournamentInfo.name || "";
  const qualifyInput = document.getElementById("qualifyPerGroupInput");
  if (qualifyInput && document.activeElement !== qualifyInput) {
    qualifyInput.value = tournamentInfo.qualifyPerGroup?.[activeDivision] || 2;
  }
  const venueDisplay = tournamentInfo.venueDisplay || {};
  document.getElementById("venueDisplayMode").value = venueDisplay.mode || "auto";
  document.getElementById("venueDisplayInterval").value = venueDisplay.intervalSeconds || 15;
  const bracketTitle = document.getElementById("bracketTitle");
  if (bracketTitle) bracketTitle.textContent = `${tournamentInfo.name || "바운스발리볼"} ${divisionLabel()} 본선 대진표`;
  renderFinalTeamPicker();
});

subscribeGroups((data) => {
  allGroups = data;
  if (!workflowDirty) resetWorkflowDraft();
  else refreshWorkflowMatchMetadata();
  refreshActiveDivisionData();
});

subscribeTeams((data) => {
  allTeams = data;
  if (!workflowDirty) resetWorkflowDraft();
  else refreshWorkflowMatchMetadata();
  refreshActiveDivisionData();
});

subscribePrelimMatches((data) => {
  allPrelimMatches = data;
  if (!workflowDirty) resetWorkflowDraft();
  else refreshWorkflowMatchMetadata();
  refreshActiveDivisionData();
});

rebindFinalMatches();

// ---------------- 연결 상태 감시 ----------------

function initConnectionWatch() {
  window.addEventListener("firestore-error", (e) => {
    const { label, err } = e.detail;
    setConnStatus(false);
    const code = err && err.code ? ` (${err.code})` : "";
    showErrorBanner(`${label} 실패${code}: ${err && err.message ? err.message : err}\nFirestore 보안 규칙이 게시되어 있는지 Firebase 콘솔에서 확인해주세요.`);
  });
  window.addEventListener("firestore-timeout", (e) => {
    setConnStatus(false);
    showErrorBanner(
      `"${e.detail.label}" 실시간 연결이 응답하지 않습니다.\n` +
      `광고 차단/보안 확장 프로그램이 Firestore 실시간 연결을 막고 있을 수 있습니다 — 확장 프로그램을 끄거나 시크릿창에서 다시 열어보세요.\n` +
      `그래도 안 되면 다른 네트워크(예: 휴대폰 테더링)에서 시도해보세요.`
    );
  });
}

function setConnStatus(ok) {
  const el = document.getElementById("connStatus");
  if (!el) return;
  el.textContent = ok ? "동기화중" : "연결 오류";
  el.style.color = ok ? "" : "#c0392b";
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

// ---------------- 탭 ----------------

/** 로그인 게이트: 로그인 전에는 loginScreen만 보이고, 로그인 후에는 appShell이 보인다.
 *  Firestore 읽기는 누구나 가능하도록 열어두므로(대시보드용) 구독 자체는 로그인 여부와
 *  무관하게 계속 동작하고, 여기서는 화면 전환과 로그인/로그아웃/비밀번호 재설정만 다룬다. */
function initAuthGate() {
  const loginScreen = document.getElementById("loginScreen");
  const appShell = document.getElementById("appShell");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const forgotBtn = document.getElementById("forgotPasswordBtn");
  const changePasswordBtn = document.getElementById("changePasswordBtn");
  const loginError = document.getElementById("loginError");
  const emailInput = document.getElementById("loginEmail");
  const passwordInput = document.getElementById("loginPassword");
  if (!loginScreen || !appShell) return;

  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.classList.add("show");
  }
  function hideLoginError() {
    loginError.classList.remove("show");
  }

  watchAuthState((user) => {
    hideLoginError();
    if (user) {
      loginScreen.style.display = "none";
      appShell.style.display = "";
      if (!unsubscribeWorkflowReviews.length) subscribeWorkflowReviews();
    } else {
      unsubscribeWorkflowReviews.forEach((unsubscribe) => unsubscribe());
      unsubscribeWorkflowReviews = [];
      reviewAssignments = [];
      reviewWorkflows = new Map();
      reviewQueues = new Map();
      reviewCourts = new Map();
      reviewAudits = new Map();
      reviewFinalMatchesByDivision.men = [];
      reviewFinalMatchesByDivision.women = [];
      loginScreen.style.display = "flex";
      appShell.style.display = "none";
      if (passwordInput) passwordInput.value = "";
    }
  });

  async function doLogin() {
    const email = (emailInput.value || "").trim();
    const password = passwordInput.value || "";
    if (!email || !password) {
      showLoginError("이메일과 비밀번호를 입력하세요.");
      return;
    }
    hideLoginError();
    loginBtn.disabled = true;
    const originalLabel = loginBtn.textContent;
    loginBtn.textContent = "로그인 중...";
    try {
      await login(email, password);
    } catch (err) {
      showLoginError(describeAuthError(err));
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = originalLabel;
    }
  }

  loginBtn?.addEventListener("click", doLogin);
  passwordInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  emailInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });

  forgotBtn?.addEventListener("click", async () => {
    const email = (emailInput.value || "").trim();
    if (!email) {
      showLoginError("비밀번호를 재설정할 이메일을 먼저 입력하세요.");
      return;
    }
    hideLoginError();
    try {
      await requestPasswordReset(email);
      showToast(`📧 ${email} 로 재설정 링크를 보냈어요. 메일을 확인하세요.`, 6000);
    } catch (err) {
      showLoginError(describeAuthError(err));
    }
  });

  logoutBtn?.addEventListener("click", async () => {
    await logout();
  });

  changePasswordBtn?.addEventListener("click", openChangePasswordModal);
}

/** 로그인된 상태에서 현재 비밀번호 확인 후 새 비밀번호로 바꾸는 모달 (관리자 페이지 내 자체 변경용) */
function openChangePasswordModal() {
  const root = document.getElementById("modalRoot");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.innerHTML = `<h3>비밀번호 변경</h3>`;

  const errorMsg = document.createElement("div");
  errorMsg.className = "modal-error-msg";
  box.appendChild(errorMsg);

  const currentInput = document.createElement("input");
  currentInput.type = "password";
  currentInput.placeholder = "현재 비밀번호";
  currentInput.autocomplete = "current-password";
  currentInput.style.width = "100%";
  currentInput.style.marginBottom = "10px";
  box.appendChild(currentInput);

  const newInput = document.createElement("input");
  newInput.type = "password";
  newInput.placeholder = "새 비밀번호 (6자 이상)";
  newInput.autocomplete = "new-password";
  newInput.style.width = "100%";
  newInput.style.marginBottom = "10px";
  box.appendChild(newInput);

  const confirmInput = document.createElement("input");
  confirmInput.type = "password";
  confirmInput.placeholder = "새 비밀번호 확인";
  confirmInput.autocomplete = "new-password";
  confirmInput.style.width = "100%";
  box.appendChild(confirmInput);

  const actions = document.createElement("div");
  actions.className = "row";
  actions.style.justifyContent = "flex-end";
  actions.style.marginTop = "12px";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn ghost";
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", () => overlay.remove());
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn primary";
  saveBtn.textContent = "변경";
  saveBtn.addEventListener("click", async () => {
    const current = currentInput.value;
    const next = newInput.value;
    const confirmNext = confirmInput.value;
    if (!current || !next || !confirmNext) {
      errorMsg.textContent = "모든 항목을 입력하세요.";
      errorMsg.classList.add("show");
      return;
    }
    if (next.length < 6) {
      errorMsg.textContent = "새 비밀번호는 6자 이상으로 입력하세요.";
      errorMsg.classList.add("show");
      return;
    }
    if (next !== confirmNext) {
      errorMsg.textContent = "새 비밀번호가 일치하지 않습니다.";
      errorMsg.classList.add("show");
      return;
    }
    errorMsg.classList.remove("show");
    saveBtn.disabled = true;
    try {
      await changePassword(current, next);
      overlay.remove();
      showToast("비밀번호가 변경되었습니다");
    } catch (err) {
      saveBtn.disabled = false;
      errorMsg.textContent = describeAuthError(err);
      errorMsg.classList.add("show");
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  root.appendChild(overlay);
  currentInput.focus();
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

function initHelpTooltips() {
  const closeAll = (except = null) => {
    document.querySelectorAll(".help-trigger.is-open").forEach((button) => {
      if (button === except) return;
      button.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
    });
  };
  document.querySelectorAll(".help-trigger").forEach((button) => button.setAttribute("aria-expanded", "false"));
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest?.(".help-trigger");
    if (!trigger) {
      closeAll();
      return;
    }
    event.stopPropagation();
    const opening = !trigger.classList.contains("is-open");
    closeAll(trigger);
    trigger.classList.toggle("is-open", opening);
    trigger.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });
}

function subscribeWorkflowReviews() {
  const root = ["tournaments", TOURNAMENT_ID];
  unsubscribeWorkflowReviews = [
    onSnapshot(collection(db, ...root, "courtAssignments"), (snap) => {
      reviewAssignments = snap.docs.map((item) => ({ id: item.id, ...item.data() }));
      if (!workflowDirty) resetWorkflowDraft();
      renderScoreReviews();
      renderWorkflowCourtPlanner();
      renderPrelimViews();
      renderFinalBracket();
    }, (err) => reportError("검수 목록 구독", err)),
    onSnapshot(collection(db, ...root, "scoreWorkflows"), (snap) => {
      reviewWorkflows = new Map(snap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
      renderScoreReviews();
      renderPrelimViews();
    }, (err) => reportError("워크플로 구독", err)),
    onSnapshot(collection(db, ...root, "courtQueues"), (snap) => {
      reviewQueues = new Map(snap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
      renderWorkflowCourtPlanner();
    }, (err) => reportError("코트 대기열 구독", err)),
    onSnapshot(collection(db, ...root, "courts"), (snap) => {
      reviewCourts = new Map(snap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
      if (!workflowDirty) resetWorkflowDraft();
      renderWorkflowCourtPlanner();
      renderScoreReviews();
      renderPrelimViews();
      renderFinalBracket();
    }, (err) => reportError("코트 목록 구독", err)),
    onSnapshot(collection(db, ...root, "auditEvents"), (snap) => {
      reviewAudits = new Map(snap.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .filter((item) => item.eventType === "submission_complete")
        .map((item) => [item.matchKey, item]));
      renderScoreReviews();
    }, (err) => reportError("검수 감사 로그 구독", err)),
    ...Object.keys(reviewFinalMatchesByDivision).map((division) => subscribeFinalMatches(division, (matches) => {
      reviewFinalMatchesByDivision[division] = matches;
      if (!workflowDirty) resetWorkflowDraft();
      else refreshWorkflowMatchMetadata();
      renderScoreReviews();
      renderWorkflowCourtPlanner();
    })),
  ];
}

function workflowTeamLabel(team) {
  if (!team) return "대진 미정";
  if (typeof team === "string") return teamName(team);
  return team.name || team.teamName || team.id || "대진 미정";
}

function workflowMatchOptions() {
  const groupById = new Map(allGroups.map((group) => [group.id, group]));
  const teamById = new Map(allTeams.map((team) => [team.id, team.name]));
  const labelTeam = (team) => typeof team === "string"
    ? (teamById.get(team) || "팀 정보 불러오는 중")
    : workflowTeamLabel(team);
  return [
    ...allPrelimMatches.map((match) => ({
      matchKey: match.id,
      matchType: "prelim",
      matchId: match.id,
      division: match.division,
      label: `${DIVISION_LABELS[match.division] || match.division} · ${groupById.get(match.groupId)?.name || "예선"} · ${match.round || "순서 미정"}경기`,
      teams: `${labelTeam(match.teamA)} vs ${labelTeam(match.teamB)}`,
      hasOfficialHistory: (match.officialRevision || 0) > 0
        || Boolean(match.result)
        || (Array.isArray(match.sets) && match.sets.some((set) => Number(set?.a) > 0 || Number(set?.b) > 0)),
    })),
    ...Object.entries(reviewFinalMatchesByDivision).flatMap(([divisionId, matches]) => matches.map((match) => ({
      matchKey: `final:${divisionId}:${match.id}`,
      matchType: "final",
      matchId: match.id,
      divisionId,
      nextMatchId: match.nextMatchId || null,
      nextSlot: match.nextSlot || null,
      dependencyReady: Boolean(match.teamA && match.teamB),
      label: `${DIVISION_LABELS[divisionId] || divisionId} · ${match.roundLabel || `본선 ${match.round || ""}라운드`} · ${(match.index ?? 0) + 1}경기`,
      teams: `${labelTeam(match.teamA)} vs ${labelTeam(match.teamB)}`,
      hasOfficialHistory: (match.officialRevision || 0) > 0
        || Boolean(match.result || match.winner || match.winnerTeam)
        || (Array.isArray(match.sets) && match.sets.some((set) => Number(set?.a) > 0 || Number(set?.b) > 0)),
    }))),
  ];
}

function resetWorkflowDraft() {
  // Firestore는 orderBy 없이 읽으면 문서 ID(=랜덤 UUID) 순으로 돌려준다.
  // 관리자가 만든 순서를 유지하려면 저장해둔 order로 정렬해야 한다.
  workflowDraftCourts = [...reviewCourts.entries()]
    .map(([id, court]) => ({
      id,
      name: normalizeCourtName(court.name || court.displayName),
      recorderName: court.recorderName || "",
      order: Number(court.order) || 0,
    }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ko"))
    .map(({ id, name, recorderName }) => ({ id, name, recorderName }));
  const persisted = new Map(reviewAssignments.map((assignment) => [assignment.matchKey || assignment.id, {
    ...assignment, matchKey: assignment.matchKey || assignment.id,
  }]));
  workflowDraftAssignments = workflowMatchOptions()
    .filter((option) => persisted.has(option.matchKey) || !option.hasOfficialHistory)
    .map((option) => ({
      ...option,
      ...(persisted.get(option.matchKey) || {}),
      matchKey: option.matchKey,
      courtId: persisted.get(option.matchKey)?.courtId || null,
    }));
  workflowDirty = false;
}

async function reloadWorkflowAuthoritativeState({ preserveDraft = false } = {}) {
  const root = ["tournaments", TOURNAMENT_ID];
  const [tournamentSnap, assignmentSnap, workflowSnap, queueSnap, courtSnap] = await Promise.all([
    getDoc(doc(db, ...root)),
    getDocs(collection(db, ...root, "courtAssignments")),
    getDocs(collection(db, ...root, "scoreWorkflows")),
    getDocs(collection(db, ...root, "courtQueues")),
    getDocs(collection(db, ...root, "courts")),
  ]);
  tournamentInfo = tournamentSnap.exists() ? { ...tournamentInfo, ...tournamentSnap.data() } : tournamentInfo;
  reviewAssignments = assignmentSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
  reviewWorkflows = new Map(workflowSnap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
  reviewQueues = new Map(queueSnap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
  reviewCourts = new Map(courtSnap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
  if (!preserveDraft) {
    workflowDirty = false;
    resetWorkflowDraft();
  }
  renderWorkflowCourtPlanner();
  renderScoreReviews();
  renderPrelimViews();
  renderFinalBracket();
}

function refreshWorkflowMatchMetadata() {
  workflowDraftAssignments = reconcilePlannerAssignments(
    workflowDraftAssignments,
    workflowMatchOptions(),
    reviewAssignments,
  );
}

function nextCourtName() {
  const used = new Set(workflowDraftCourts.map((court) => normalizeCourtName(court.name)));
  for (let index = 1; ; index += 1) {
    const candidate = String(index);
    if (!used.has(candidate)) return candidate;
  }
}

function createWorkflowCourt() {
  const courtId = `court-${crypto.randomUUID().slice(0, 8)}`;
  workflowDraftCourts.push({ id: courtId, name: nextCourtName(), recorderName: "" });
  workflowDirty = true;
  renderWorkflowCourtPlanner();
  const input = document.querySelector(`[data-court-id="${courtId}"] input`);
  input?.focus();
  input?.select();
}

function normalizeWorkflowOrders(courtId) {
  workflowDraftAssignments
    .filter((assignment) => (assignment.courtId || null) === courtId)
    .sort((a, b) => (a.courtOrder || 0) - (b.courtOrder || 0))
    .forEach((assignment, index) => { assignment.courtOrder = index + 1; });
}

function setMatchCourt(matchKey, courtId, beforeMatchKey = null) {
  const assignment = assignmentFor(matchKey);
  if (!assignment) return;
  const sourceCourtId = assignment.courtId || null;
  const targetCourtId = courtId || null;
  const target = workflowDraftAssignments
    .filter((item) => item !== assignment && (item.courtId || null) === targetCourtId)
    .sort((a, b) => (a.courtOrder || 0) - (b.courtOrder || 0));
  const targetIndex = beforeMatchKey ? target.findIndex((item) => item.matchKey === beforeMatchKey) : -1;
  target.splice(targetIndex < 0 ? target.length : targetIndex, 0, assignment);
  assignment.courtId = targetCourtId;
  target.forEach((item, index) => { item.courtOrder = index + 1; });
  if (sourceCourtId !== targetCourtId) normalizeWorkflowOrders(sourceCourtId);
  workflowDirty = true;
  renderWorkflowCourtPlanner();
}

function moveWorkflowMatch(matchKey, offset) {
  const assignment = assignmentFor(matchKey);
  if (!assignment) return;
  const courtAssignments = workflowDraftAssignments
    .filter((item) => (item.courtId || null) === (assignment.courtId || null))
    .sort((a, b) => (a.courtOrder || 0) - (b.courtOrder || 0));
  const index = courtAssignments.indexOf(assignment);
  const target = index + offset;
  if (target < 0 || target >= courtAssignments.length) return;
  [courtAssignments[index].courtOrder, courtAssignments[target].courtOrder] = [
    courtAssignments[target].courtOrder, courtAssignments[index].courtOrder,
  ];
  workflowDirty = true;
  renderWorkflowCourtPlanner();
}

function assignmentFor(matchKey) {
  return workflowDraftAssignments.find((assignment) => assignment.matchKey === matchKey);
}

/**
 * 입력 중인 코트 이름/기록관 칸만 다시 그리지 않는다. 버튼(코트 추가·삭제)에 포커스가
 * 있을 때까지 건너뛰면 새 코트 행이 화면에 나타나지 않으므로 대상은 input으로 한정한다.
 */
function renderWorkflowCourtPlanner() {
  if (!document.activeElement?.matches?.("#courtSettingsList input")) renderCourtSettings();
  renderCourtBoard();
  syncPrelimCourtSelects();
  syncPrelimCourtBadges();
  syncWorkflowSaveControls();
}

function syncWorkflowSaveControls() {
  ["courtSettingsHint", "workflowPlannerHint"].forEach((id) => {
    const hint = document.getElementById(id);
    if (!hint) return;
    hint.hidden = !workflowDirty;
    hint.textContent = workflowDirty ? "저장되지 않은 변경사항" : "";
  });
  ["setupCourtsBtn", "setupWorkflowBtn"].forEach((id) => {
    const save = document.getElementById(id);
    if (save) save.disabled = !workflowDirty;
  });
}

function markWorkflowDirty() {
  workflowDirty = true;
  syncWorkflowSaveControls();
}

function fillPrelimCourtSelect(select, matchKey) {
  const assignment = assignmentFor(matchKey);
  select.replaceChildren(new Option("미배정", ""));
  workflowDraftCourts.forEach((court) => {
    select.append(new Option(formatCourtName(court.name, "이름 없는 코트"), court.id));
  });
  select.value = assignment?.courtId || "";
  select.disabled = !assignment;
  select.title = assignment ? "이 경기의 코트를 선택하세요." : "결과가 기록된 경기는 코트에 새로 배정할 수 없습니다.";
}

function syncPrelimCourtSelects() {
  document.querySelectorAll("[data-prelim-court-match]").forEach((select) => {
    fillPrelimCourtSelect(select, select.dataset.prelimCourtMatch);
  });
}

function prelimCourtDisplay(matchKey) {
  const assignment = assignmentFor(matchKey);
  if (!assignment?.courtId) return { label: "미배정", recorderName: "" };
  const court = workflowDraftCourts.find((item) => item.id === assignment.courtId);
  if (!court) return { label: "미배정", recorderName: "" };
  return {
    label: formatCourtName(court.name),
    recorderName: court.recorderName?.trim() || "",
  };
}

function syncPrelimCourtBadges() {
  document.querySelectorAll("[data-prelim-court-badge]").forEach((badge) => {
    const court = prelimCourtDisplay(badge.dataset.prelimCourtBadge);
    badge.textContent = court.label;
    badge.classList.toggle("unassigned", court.label === "미배정");
    badge.title = court.recorderName ? `담당 기록관: ${court.recorderName}` : "";
  });
}

function renderCourtSettings() {
  const root = document.getElementById("courtSettingsList");
  if (!root) return;
  root.replaceChildren();
  if (!workflowDraftCourts.length) {
    const empty = document.createElement("p");
    empty.className = "workflow-empty";
    empty.textContent = "아직 코트가 없습니다. '+ 코트 추가'로 사용할 코트를 만드세요.";
    root.appendChild(empty);
  }
  workflowDraftCourts.forEach((court, courtIndex) => {
    const row = document.createElement("div");
    row.className = "court-settings-row";
    row.dataset.courtId = court.id;
    const order = document.createElement("span");
    order.className = "court-settings-order";
    order.textContent = `${courtIndex + 1}`;
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "예: A";
    name.value = court.name;
    resizeCourtNameInput(name);
    name.setAttribute("aria-label", `${courtIndex + 1}번째 코트 이름, 코트 제외`);
    name.addEventListener("input", () => {
      court.name = name.value;
      resizeCourtNameInput(name);
      markWorkflowDirty();
    });
    name.addEventListener("change", () => {
      court.name = normalizeCourtName(name.value);
      name.value = court.name;
      resizeCourtNameInput(name);
      renderCourtBoard();
      syncPrelimCourtSelects();
    });
    const nameField = document.createElement("label");
    nameField.className = "court-setting-field";
    const nameLabel = document.createElement("span");
    nameLabel.className = "court-setting-label";
    nameLabel.textContent = "코트 이름";
    const nameInputWrap = document.createElement("span");
    nameInputWrap.className = "court-name-input";
    const nameSuffix = document.createElement("b");
    nameSuffix.textContent = "코트";
    nameInputWrap.append(name, nameSuffix);
    nameField.append(nameLabel, nameInputWrap);
    const recorder = document.createElement("input");
    recorder.type = "text";
    recorder.placeholder = "담당 기록관 이름";
    recorder.value = court.recorderName || "";
    recorder.setAttribute("aria-label", `${formatCourtName(court.name, `${courtIndex + 1}번째 코트`)} 담당 기록관 이름`);
    recorder.addEventListener("input", () => {
      court.recorderName = recorder.value;
      markWorkflowDirty();
    });
    const recorderField = document.createElement("label");
    recorderField.className = "court-setting-field";
    const recorderLabel = document.createElement("span");
    recorderLabel.className = "court-setting-label";
    recorderLabel.textContent = "담당 기록관";
    recorderField.append(recorderLabel, recorder);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger small";
    remove.textContent = "삭제";
    remove.addEventListener("click", () => {
      if (!confirm(`'${formatCourtName(court.name, "이 코트")}'를 삭제할까요? 배정된 경기는 미배정으로 이동합니다.`)) return;
      workflowDraftAssignments.filter((assignment) => assignment.courtId === court.id)
        .forEach((assignment) => { assignment.courtId = null; });
      workflowDraftCourts = workflowDraftCourts.filter((item) => item !== court);
      normalizeWorkflowOrders(null);
      markWorkflowDirty();
      renderWorkflowCourtPlanner();
    });
    row.append(order, nameField, recorderField, remove);
    root.appendChild(row);
  });
}

function resizeCourtNameInput(input) {
  const length = Array.from(input.value.trim()).length;
  input.style.width = `${length ? Math.min(Math.max(length + 1, 3), 18) : 7}ch`;
}

/** 코트 목록·기록관·경기 배정·순서를 한 번에 서버에 저장한다. 두 저장 버튼이 공유한다. */
async function saveCourtWorkflow(button) {
  const unnamed = workflowDraftCourts.find((court) => !normalizeCourtName(court.name));
  if (unnamed) return showToast("모든 코트의 표시 이름을 입력하세요.");
  const duplicated = workflowDraftCourts
    .map((court) => normalizeCourtName(court.name))
    .find((name, index, names) => names.indexOf(name) !== index);
  if (duplicated) return showToast(`코트 이름 '${duplicated}'이(가) 중복됩니다. 기록관이 헷갈리지 않게 다르게 지어주세요.`);
  if (workflowSaveInProgress) return;
  const assignmentsByCourt = {};
  const unassignedAssignments = [];
  workflowDraftAssignments.forEach((assignment) => {
    const normalized = {
      matchKey: assignment.matchKey,
      matchId: assignment.matchId || assignment.matchKey,
      matchType: assignment.matchType || "prelim",
      courtOrder: assignment.courtOrder || 1,
      dependencyReady: assignment.dependencyReady !== false,
    };
    if (normalized.matchType === "final") {
      normalized.divisionId = assignment.divisionId || activeDivision;
      if (assignment.nextMatchId) normalized.nextMatchId = assignment.nextMatchId;
      if (assignment.nextSlot) normalized.nextSlot = assignment.nextSlot;
    } else {
      normalized.division = assignment.division || activeDivision;
    }
    if (assignment.courtId) (assignmentsByCourt[assignment.courtId] ||= []).push(normalized);
    else unassignedAssignments.push(normalized);
  });
  Object.values(assignmentsByCourt).forEach((assignments) => assignments.sort((a, b) => a.courtOrder - b.courtOrder));
  workflowSaveInProgress = true;
  try {
    const result = await runWorkflowButton(button, "코트 배정·순서 저장", () => adminWorkflowCallable("replaceCourtWorkflows", {
      courts: workflowDraftCourts.map((court) => ({ id: court.id, name: normalizeCourtName(court.name), recorderName: court.recorderName.trim() })),
      assignmentsByCourt,
      unassignedAssignments,
      expectedTopologyRevision: Number(tournamentInfo.courtTopologyRevision || 0),
      expectedQueueRevisions: Object.fromEntries(
        [...reviewQueues].map(([courtId, queue]) => [courtId, Number(queue.queueRevision || 0)]),
      ),
    }));
    if (result) {
      await reloadWorkflowAuthoritativeState();
      showToast("코트 설정과 경기 배정을 저장했습니다.");
    }
  } finally {
    workflowSaveInProgress = false;
  }
}

function workflowStatusBadge(matchKey) {
  const workflow = reviewWorkflows.get(matchKey);
  if ((workflow?.officialRevision || 0) > 0) return "승인됨";
  if ((workflow?.submissionVersion || 0) > 0 || workflow?.draftState === "submitted") return "제출됨";
  if (workflow?.draftState && workflow.draftState !== "idle") return "작성 중";
  return "대기";
}

function renderCourtBoard() {
  const root = document.getElementById("allCourtBoard");
  if (!root) return;
  const options = workflowDraftAssignments;
  root.replaceChildren();
  const columns = [[null, "미배정"], ...workflowDraftCourts.map((court) => [court.id, formatCourtName(court.name, "이름 없는 코트")])];
  columns.forEach(([courtId, name]) => {
    const column = document.createElement("section");
    column.className = "court-board-column";
    column.addEventListener("dragover", (e) => { e.preventDefault(); column.classList.add("drag-over"); });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", (e) => {
      e.preventDefault(); column.classList.remove("drag-over");
      const matchKey = e.dataTransfer.getData("text/plain");
      if (matchKey) setMatchCourt(matchKey, courtId);
    });
    const heading = document.createElement("h3");
    const count = options.filter((option) => (assignmentFor(option.matchKey)?.courtId || null) === courtId).length;
    heading.textContent = `${name} · ${count}경기`;
    column.appendChild(heading);
    const list = document.createElement("div");
    list.className = "court-board-list";
    options.filter((option) => (assignmentFor(option.matchKey)?.courtId || null) === courtId)
      .sort((a, b) => (assignmentFor(a.matchKey)?.courtOrder || 0) - (assignmentFor(b.matchKey)?.courtOrder || 0))
      .forEach((option, index, items) => {
        const assignment = assignmentFor(option.matchKey);
        const card = document.createElement("article");
        card.className = "court-board-card";
        card.dataset.divisionTheme = option.divisionId || option.division || "men";
        card.draggable = true;
        card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", option.matchKey); e.dataTransfer.effectAllowed = "move"; });
        card.addEventListener("dragover", (e) => e.preventDefault());
        card.addEventListener("drop", (e) => {
          e.preventDefault(); e.stopPropagation();
          const matchKey = e.dataTransfer.getData("text/plain");
          if (matchKey && matchKey !== option.matchKey) setMatchCourt(matchKey, courtId, option.matchKey);
        });
        card.innerHTML = `<b>${escapeHtml(option.label)}</b><span>${escapeHtml(option.teams)}</span><span class="badge">${workflowStatusBadge(option.matchKey)}</span>`;
        const controls = document.createElement("div");
        controls.className = "court-board-controls";
        const select = document.createElement("select");
        select.setAttribute("aria-label", `${option.teams} 코트 선택`);
        select.append(new Option("미배정", ""));
        workflowDraftCourts.forEach((court) => select.append(new Option(formatCourtName(court.name, "이름 없는 코트"), court.id)));
        select.value = assignment?.courtId || "";
        select.addEventListener("change", () => setMatchCourt(option.matchKey, select.value));
        controls.appendChild(select);
        [["↑", -1, index === 0], ["↓", 1, index === items.length - 1]].forEach(([text, offset, disabled]) => {
          const button = document.createElement("button");
          button.type = "button"; button.className = "workflow-icon-btn"; button.textContent = text;
          button.disabled = disabled; button.addEventListener("click", () => moveWorkflowMatch(option.matchKey, offset));
          controls.appendChild(button);
        });
        card.appendChild(controls);
        list.appendChild(card);
      });
    if (!list.children.length) list.innerHTML = '<p class="workflow-empty">경기가 없습니다.</p>';
    column.appendChild(list);
    root.appendChild(column);
  });
}

async function runWorkflowButton(button, label, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "처리 중…";
  try {
    const result = await action();
    return result?.data ?? {};
  } catch (err) {
    const errorCode = String(err?.code || "").split("/").at(-1);
    if (errorCode === "aborted" || /topology|stale|revision|version/i.test(err?.message || "")) {
      if (label === "코트 배정·순서 저장") {
        try {
          await reloadWorkflowAuthoritativeState();
          showToast("다른 관리자 변경이 반영되었습니다. 최신 상태로 다시 불러왔습니다.", 5000);
        } catch (reloadError) {
          reportError("최신 코트 상태 불러오기", reloadError);
        }
      } else {
        try {
          await reloadWorkflowAuthoritativeState({ preserveDraft: true });
          showToast(`${label} 작업이 다른 변경과 충돌해 적용되지 않았습니다. 최신 상태를 다시 불러왔습니다.`, 5000);
        } catch (reloadError) {
          reportError(`${label} 충돌 후 상태 불러오기`, reloadError);
        }
      }
      return null;
    }
    reportError(label, err);
    return null;
  } finally {
    button.disabled = label === "코트 배정·순서 저장" ? !workflowDirty : false;
    button.textContent = original;
  }
}

function requiredReason(label) {
  const reason = prompt(`${label} 사유를 입력하세요.`);
  return reason?.trim() || null;
}

function formatSets(score) {
  return (score?.sets || []).map((set) => `${set.a}:${set.b}`).join(" / ") || "점수 없음";
}

function scoreReviewDisplay(assignment) {
  const division = assignment.divisionId || assignment.division || "men";
  const officialMatch = assignment.matchType === "final"
    ? reviewFinalMatchesByDivision[division]?.find((match) => match.id === assignment.matchId)
    : allPrelimMatches.find((match) => match.id === assignment.matchId);
  const teamsById = new Map(allTeams.map((team) => [team.id, team]));
  const view = courtMatchSummary(assignment, officialMatch, {
    teamsById,
    groupsById: new Map(allGroups.map((group) => [group.id, group])),
  });
  const names = courtTeamNames(officialMatch, teamsById);
  const court = reviewCourts.get(assignment.courtId);
  const courtName = formatCourtName(court?.name || court?.displayName, "코트 미정");
  const divisionName = DIVISION_LABELS[division] || division;
  const matchParts = String(view.label || "경기 정보 불러오는 중")
    .split(" · ")
    .filter(Boolean);
  return {
    heading: [
      courtName,
      divisionName,
      view.label,
    ].filter(Boolean).join(" · "),
    courtName,
    divisionName,
    matchParts,
    teams: view.teams || "대진 정보를 불러오는 중입니다.",
    teamA: names?.a || "A팀",
    teamB: names?.b || "B팀",
  };
}

function renderScoreReviews() {
  const root = document.getElementById("scoreReviewList");
  if (!root) return;
  renderCorrectionMatchOptions();
  const pendingReviews = reviewAssignments.filter((item) => {
    const workflow = reviewWorkflows.get(item.id);
    return item.publicStatus === "under_review" && workflow?.draftState === "submitted";
  });
  const submitted = reviewAssignments.filter((item) => {
    const workflow = reviewWorkflows.get(item.id);
    return (item.publicStatus === "under_review" && workflow?.draftState === "submitted") || workflow?.lock;
  });
  const reviewTab = document.querySelector('.tab-btn[data-tab="workflow"]');
  if (reviewTab) reviewTab.textContent = pendingReviews.length ? `기록·검수 (${pendingReviews.length})` : "기록·검수";
  root.replaceChildren();
  root.className = "review-list";
  if (!submitted.length) {
    root.textContent = "검수 대기 제출이 없습니다.";
    root.className = "review-list empty-hint";
    return;
  }
  submitted.forEach((assignment) => {
    const workflow = reviewWorkflows.get(assignment.id);
    const display = scoreReviewDisplay(assignment);
    const isSubmitted = assignment.publicStatus === "under_review" && workflow.draftState === "submitted";
    const row = document.createElement("article");
    row.className = "review-card";
    row.dataset.reviewMatch = assignment.id;
    row.dataset.divisionTheme = assignment.divisionId || assignment.division || "men";
    const audit = reviewAudits.get(assignment.id);
    const submittedAt = audit?.createdAt?.toDate?.()?.toLocaleString?.()
      || workflow.submittedAt?.toDate?.()?.toLocaleString?.()
      || workflow.updatedAt?.toDate?.()?.toLocaleString?.()
      || "";
    const author = isSubmitted
      ? (audit?.actor?.name || workflow.submittedBy?.name || workflow.lock?.recorderName || "기록관")
      : (workflow.lock?.recorderName || "기록관");
    const scoreText = formatSets(workflow.submittedSnapshot || workflow.draft);
    const header = document.createElement("div");
    header.className = "review-card-header";
    const tags = document.createElement("div");
    tags.className = "review-tags";
    tags.innerHTML = [
      `<span class="review-tag court">${escapeHtml(display.courtName)}</span>`,
      `<span class="review-tag division">${escapeHtml(display.divisionName)}</span>`,
      ...display.matchParts.map((part) => `<span class="review-tag">${escapeHtml(part)}</span>`),
    ].join("");
    const state = document.createElement("span");
    state.className = `review-state ${isSubmitted ? "submitted" : "editing"}`;
    state.textContent = isSubmitted ? "검수 대기" : "입력 중";
    header.append(tags, state);
    const matchup = document.createElement("div");
    matchup.className = "review-matchup";
    matchup.innerHTML = `<strong><small>A팀</small>${escapeHtml(display.teamA)}</strong><span>VS</span><strong><small>B팀</small>${escapeHtml(display.teamB)}</strong>`;
    const meta = document.createElement("div");
    meta.className = "review-meta";
    meta.innerHTML = `<span class="review-info-chip"><small>기록관</small><strong>${escapeHtml(author)}</strong></span>`
      + (submittedAt ? `<span class="review-info-chip"><small>제출 시간</small><strong>${escapeHtml(submittedAt)}</strong></span>` : "")
      + (scoreText !== "점수 없음" ? `<span class="review-info-chip score"><small>입력 점수</small><strong>${escapeHtml(scoreText)}</strong></span>` : "");
    const actions = document.createElement("div");
    actions.className = "review-actions";
    row.append(header, matchup, meta, actions);
    const approve = document.createElement("button");
    approve.className = "btn primary small";
    approve.textContent = "승인";
    approve.addEventListener("click", async () => {
      const ok = await runWorkflowButton(approve, "점수 승인", () => adminWorkflowCallable("approveScoreReview", {
        matchKey: assignment.id,
        expectedSubmissionVersion: workflow.submissionVersion,
      }));
      if (ok) showToast("제출 점수를 승인했습니다.");
    });
    const reject = document.createElement("button");
    reject.className = "btn danger small";
    reject.textContent = "반려";
    reject.addEventListener("click", async () => {
      const reason = requiredReason("반려");
      if (!reason) return showToast("반려 사유는 필수입니다.");
      const ok = await runWorkflowButton(reject, "점수 반려", () => adminWorkflowCallable("rejectScoreReview", {
        matchKey: assignment.id,
        reason,
        expectedSubmissionVersion: workflow.submissionVersion,
        expectedQueueRevision: reviewQueues.get(assignment.courtId)?.queueRevision ?? null,
      }));
      if (ok) showToast("반려했습니다.");
    });
    const edit = document.createElement("button");
    edit.className = "btn small";
    edit.textContent = "수정·승인";
    edit.addEventListener("click", () => openAdminScoreModal(assignment, workflow));
    if (isSubmitted) actions.append(approve, reject, edit);
    if (workflow.lock) {
      const release = document.createElement("button");
      release.className = "btn danger small";
      release.textContent = "잠금 강제 해제";
      release.addEventListener("click", async () => {
        const reason = requiredReason("강제 해제");
        if (!reason) return showToast("강제 해제 사유는 필수입니다.");
        const ok = await runWorkflowButton(release, "잠금 강제 해제", () => adminWorkflowCallable("forceReleaseWorkflow", {
          matchKey: assignment.id,
          reason,
          expectedLockToken: workflow.lock.token,
          expectedQueueRevision: reviewQueues.get(assignment.courtId)?.queueRevision ?? null,
        }));
        if (ok) showToast("잠금을 강제 해제했습니다.");
      });
      actions.append(release);
    }
    root.appendChild(row);
  });
}

function renderCorrectionMatchOptions() {
  const select = document.getElementById("correctionMatchKeys");
  if (!select) return;
  const selected = new Set([...select.selectedOptions].map((option) => option.value));
  const approved = reviewAssignments.filter((assignment) => {
    const workflow = reviewWorkflows.get(assignment.id);
    return assignment.publicStatus === "completed"
      || (workflow?.officialRevision || assignment.officialRevision || 0) > 0;
  });
  select.replaceChildren();
  if (!approved.length) {
    const empty = new Option("승인된 경기가 없습니다.", "");
    empty.disabled = true;
    select.appendChild(empty);
    return;
  }
  approved.forEach((assignment) => {
    const display = scoreReviewDisplay(assignment);
    const option = new Option(`${display.heading} · ${display.teams}`, assignment.id);
    option.selected = selected.has(assignment.id);
    select.appendChild(option);
  });
}

function openAdminScoreModal(assignment, workflow) {
  const final = assignment.matchType === "final";
  const display = scoreReviewDisplay(assignment);
  openScoreModal({
    teamAName: display.teamA,
    teamBName: display.teamB,
    setLabels: final ? ["1세트 (10점)", "2세트 (10점)", "3세트 (7점)"] : ["1세트 (10점)", "2세트 (10점)"],
    targets: final ? [10, 10, 7] : [10, 10],
    existingSets: workflow.submittedSnapshot?.sets || workflow.draft?.sets || [],
    onSave: async (sets) => {
      const reason = requiredReason("관리자 직접 수정");
      if (!reason) throw new Error("정정 사유는 필수입니다.");
      await adminWorkflowCallable("directEditOfficialScore", {
        matchKey: assignment.id,
        score: { sets },
        reason,
        expectedOfficialRevision: workflow.officialRevision || 0,
      });
      showToast("관리자 수정 점수를 승인했습니다.");
    },
  });
}

// ---------------- 대회설정: 대회명 ----------------

function bindStaticHandlers() {
  document.querySelectorAll("[data-division]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextDivision = button.dataset.division;
      if (nextDivision === activeDivision) return;
      if (bracketPublishPending && !confirm(`${divisionLabel()}의 공개하지 않은 본선 대진 변경사항을 버리고 ${DIVISION_LABELS[nextDivision]}로 전환할까요?`)) return;
      activeDivision = nextDivision;
      document.body.dataset.division = activeDivision;
      syncDivisionThemeScopes();
      bracketPublishPending = false;
      seedSelection = [];
      seedAutoMode = true;
      ringSelection = null;
      // 대회설정·예선·본선에 각각 같은 부문 스위치가 있으므로 모두 같은 상태로 맞춘다.
      document.querySelectorAll("[data-division]").forEach((item) => {
        item.classList.toggle("active", item.dataset.division === activeDivision);
      });
      refreshActiveDivisionData();
      rebindFinalMatches();
      document.getElementById("qualifyPerGroupInput").value = tournamentInfo.qualifyPerGroup?.[activeDivision] || 2;
      document.getElementById("bracketTitle").textContent = `${tournamentInfo.name || "바운스발리볼"} ${divisionLabel()} 본선 대진표`;
      showToast(`${divisionLabel()}로 전환했습니다`);
    });
  });

  document.getElementById("saveTournamentNameBtn").addEventListener("click", async () => {
    const name = document.getElementById("tournamentNameInput").value.trim();
    if (!name) return showToast("대회명을 입력하세요");
    try {
      await saveTournamentInfo({ name });
      showToast("저장되었습니다");
    } catch (err) {
      reportError("대회명 저장", err);
    }
  });

  document.getElementById("saveQualifyPerGroupBtn").addEventListener("click", async () => {
    const qualifyPerGroup = Math.max(1, Number(document.getElementById("qualifyPerGroupInput").value) || 2);
    try {
      await saveTournamentInfo({ qualifyPerGroup: { ...(tournamentInfo.qualifyPerGroup || {}), [activeDivision]: qualifyPerGroup } });
      seedAutoMode = true; // 진출 팀 수 설정을 바꿨으니 추천 진출팀을 다시 계산해서 보여준다
      showToast(`${divisionLabel()} 조별 진출 팀 수를 저장했습니다`);
    } catch (err) {
      reportError("조별 진출 팀 수 저장", err);
    }
  });

  document.getElementById("addGroupBtn").addEventListener("click", addGroupFromForm);
  document.getElementById("groupNameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addGroupFromForm(); }
  });
  document.getElementById("resetGroupsBtn").addEventListener("click", async () => {
    if (!groups.length) return showToast("이미 등록된 조가 없습니다");
    if (!confirm(`${divisionLabel()}의 모든 조를 삭제할까요? 소속 팀은 모두 미배정 상태가 되고, 해당 조의 예선 대진/결과도 함께 삭제됩니다.`)) return;
    try {
      await deleteAllGroups(activeDivision);
      showToast(`${divisionLabel()} 조를 모두 초기화했습니다`);
    } catch (err) {
      reportError("조 초기화", err);
    }
  });

  document.getElementById("addTeamBtn").addEventListener("click", addTeamFromForm);
  document.getElementById("teamNameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTeamFromForm(); }
  });
  document.getElementById("teamGroupSelect").addEventListener("change", updateTeamNameInputContext);
  document.getElementById("resetTeamsBtn").addEventListener("click", async () => {
    if (!teams.length) return showToast("이미 등록된 팀이 없습니다");
    if (!confirm(`${divisionLabel()}의 모든 팀을 삭제할까요? 예선·본선 경기 기록도 함께 삭제됩니다.`)) return;
    try {
      await deleteAllTeams(activeDivision);
      showToast(`${divisionLabel()} 팀을 모두 초기화했습니다`);
    } catch (err) {
      reportError("팀 초기화", err);
    }
  });

  document.getElementById("resetPrelimBtn").addEventListener("click", async () => {
    const hasRingPlacement = groups.some((g) => (g.ringOrder || []).some(Boolean));
    if (!prelimMatches.length && !hasRingPlacement) return showToast("초기화할 예선 경기가 없습니다");
    if (!confirm(`${divisionLabel()} 모든 조의 예선 대진과 결과, 도형(링크제) 배치를 모두 초기화할까요?`)) return;
    try {
      await clearAllPrelimMatches(activeDivision);
      await resetAllRingOrders(activeDivision);
      ringSelection = null;
      showToast(`${divisionLabel()} 예선을 초기화했습니다`);
    } catch (err) {
      reportError("예선 초기화", err);
    }
  });

  document.getElementById("generateBracketBtn").addEventListener("click", onGenerateBracket);
  document.getElementById("publishBracketBtn").addEventListener("click", handlePublishBracket);
  document.getElementById("clearBracketBtn").addEventListener("click", async () => {
    if (!confirm(`${divisionLabel()} 본선 대진표를 초기화할까요? 입력된 점수도 모두 사라집니다.`)) return;
    try {
      await clearFinalBracket(activeDivision);
      bracketPublishPending = false;
      showToast(`${divisionLabel()} 대진표를 초기화했습니다`);
    } catch (err) {
      reportError("대진표 초기화", err);
    }
  });

  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    const csv = buildFullResultsCsv({
      tournamentName: `${tournamentInfo.name || "바운스발리볼"} ${divisionLabel()}`,
      groups, teams, prelimMatches, finalMatches,
    });
    const fname = `${(tournamentInfo.name || "바운스발리볼").replace(/\s+/g, "_")}_${divisionLabel()}_결과_${dateStamp()}.csv`;
    downloadCsv(fname, csv);
  });

  document.getElementById("saveVenueDisplayBtn").addEventListener("click", async () => {
    const mode = document.getElementById("venueDisplayMode").value;
    const intervalSeconds = Number(document.getElementById("venueDisplayInterval").value);
    try {
      await saveTournamentInfo({ venueDisplay: { mode, intervalSeconds, cycleStartedAt: Date.now() } });
      showToast("경기장 송출 설정을 저장했습니다");
    } catch (err) {
      reportError("경기장 송출 설정 저장", err);
    }
  });

  // 데이터 백업/복원 — 다음 학기에 이어서 쓰거나, 실수로 초기화했을 때 되돌리기 위함
  document.getElementById("backupBtn").addEventListener("click", (e) => runWorkflowButton(e.currentTarget, "백업", handleBackup));
  document.getElementById("resetTournamentBtn").addEventListener("click", async (e) => {
    if (tournamentResetInProgress) return;
    const button = e.currentTarget;
    const expectedName = tournamentInfo.name?.trim() || "바운스발리볼";
    const typedName = prompt(`대회 전체 초기화를 계속하려면 현재 대회명 "${expectedName}"을(를) 정확히 입력하세요.`);
    if (typedName !== expectedName) return showToast("대회명이 일치하지 않아 전체 초기화를 취소했습니다.");
    if (!confirm("대회의 모든 운영 데이터를 초기화할까요? 백업을 저장한 뒤 되돌릴 수 없이 초기화합니다.")) return;
    tournamentResetInProgress = true;
    const result = await runWorkflowButton(button, "대회 전체 초기화", async () => {
      let resetState = loadTournamentResetState();
      if (!resetState?.token) {
        let prepared;
        try {
          prepared = await adminWorkflowCallable("prepareTournamentReset", { expectedName });
        } catch (prepareError) {
          const code = String(prepareError?.code || "").split("/").at(-1);
          if (code !== "failed-precondition") throw prepareError;
          prepared = await adminWorkflowCallable("recoverTournamentReset");
        }
        const token = prepared.data?.token;
        if (typeof token !== "string" || !token) throw new Error("초기화 준비 토큰을 받지 못했습니다.");
        resetState = { token, backupCompleted: prepared.data?.phase === "deleting" };
        saveTournamentResetState(resetState);
      }
      if (!resetState.backupCompleted) {
        try {
          await handleBackup();
          resetState.backupCompleted = true;
          saveTournamentResetState(resetState);
        } catch (backupError) {
          try {
            await adminWorkflowCallable("cancelTournamentReset", { token: resetState.token });
            saveTournamentResetState(null);
          } catch (cancelError) {
            console.error("[대회 전체 초기화 취소 실패]", cancelError);
          }
          throw backupError;
        }
      }
      return adminWorkflowCallable("resetTournament", { token: resetState.token });
    });
    tournamentResetInProgress = false;
    if (!result?.reset) {
      showToast("초기화가 완료되지 않았습니다. 같은 브라우저에서 다시 실행하면 안전하게 이어서 처리합니다.", 6000);
      return;
    }
    saveTournamentResetState(null);
    bracketPublishPending = false;
    workflowDirty = false;
    workflowSaveInProgress = false;
    seedSelection = [];
    seedAutoMode = true;
    ringSelection = null;
    correctionPreview = null;
    showToast("대회 전체 초기화가 완료되었습니다. 최신 상태를 불러옵니다.", 3000);
    window.setTimeout(() => window.location.reload(), 300);
  });
  document.getElementById("restoreBtn").addEventListener("click", () => {
    document.getElementById("restoreFileInput").click();
  });
  document.getElementById("restoreFileInput").addEventListener("change", handleRestoreFile);

  document.getElementById("createRecorderCodeBtn").addEventListener("click", async (e) => {
    const result = await runWorkflowButton(e.currentTarget, "접근 코드 생성/재발급", () => adminWorkflowCallable("createRecorderAccessCode"));
    if (result?.code) {
      const output = document.getElementById("recorderCodeOutput");
      output.textContent = `새 접근 코드: ${result.code}`;
      output.style.display = "";
    }
  });
  document.getElementById("revokeRecorderCodeBtn").addEventListener("click", async (e) => {
    const result = await runWorkflowButton(e.currentTarget, "접근 코드 폐기", () => adminWorkflowCallable("revokeRecorderAccessCode"));
    if (result?.revoked) showToast("기록관 접근 코드를 폐기했습니다.");
  });
  document.getElementById("addCourtBtn").addEventListener("click", createWorkflowCourt);
  ["setupCourtsBtn", "setupWorkflowBtn"].forEach((id) => {
    document.getElementById(id).addEventListener("click", (e) => saveCourtWorkflow(e.currentTarget));
  });
  document.getElementById("previewCorrectionBtn").addEventListener("click", async (e) => {
    const matchKeys = [...document.getElementById("correctionMatchKeys").selectedOptions]
      .map((option) => option.value)
      .filter(Boolean);
    if (!matchKeys.length) return showToast("정정할 경기를 선택하세요.");
    const result = await runWorkflowButton(e.currentTarget, "정정 미리보기", () => adminWorkflowCallable("previewApprovedCorrection", { matchKeys }));
    if (!result) return;
    correctionPreview = { matchKeys, result };
    const active = matchKeys.filter((key) => reviewWorkflows.get(key)?.lock);
    const targetText = (result.targets || []).map((target) => {
      const assignment = reviewAssignments.find((item) => item.id === target.matchKey);
      if (!assignment) return "경기 정보 불러오는 중";
      const display = scoreReviewDisplay(assignment);
      return `${display.heading} (${display.teams})`;
    }).join(", ");
    correctionPreview.expectedQueueRevision = result.expectedQueueRevision;
    const matchLabel = (matchKey) => {
      const assignment = reviewAssignments.find((item) => item.id === matchKey);
      return assignment ? scoreReviewDisplay(assignment).heading : "없음";
    };
    const replay = (result.projection?.replayMatchKeys || []).map(matchLabel);
    const inPlace = (result.projection?.inPlaceMatchKeys || []).map(matchLabel);
    document.getElementById("correctionPreview").textContent = active.length
      ? `활성 경기 충돌: ${active.join(", ")}. active affected 경기는 정정을 적용할 수 없습니다.`
      : `대상: ${targetText}. 제자리 유지: ${inPlace.join(", ") || "없음"}; 재경기 대기: ${replay.join(", ") || "없음"}; 변경 전 ${matchLabel(result.projection?.before?.currentMatchKey)} → ${matchLabel(result.projection?.before?.nextMatchKey)}, 변경 후 ${matchLabel(result.projection?.after?.currentMatchKey)} → ${matchLabel(result.projection?.after?.nextMatchKey)}.`;
    document.getElementById("applyCorrectionBtn").disabled = active.length > 0;
  });
  document.getElementById("applyCorrectionBtn").addEventListener("click", async (e) => {
    if (!correctionPreview) return;
    const reason = requiredReason("승인 결과 정정");
    if (!reason) return showToast("정정 사유는 필수입니다.");
    if (!confirm("미리보기한 정정을 서버 계획대로 적용할까요?")) return;
    const result = await runWorkflowButton(e.currentTarget, "승인 결과 정정", () => adminWorkflowCallable("applyApprovedCorrection", {
      matchKeys: correctionPreview.matchKeys,
      reason,
      expectedQueueRevision: correctionPreview.expectedQueueRevision,
    }));
    if (result) {
      correctionPreview = null;
      document.getElementById("applyCorrectionBtn").disabled = true;
      document.getElementById("correctionPreview").textContent = "정정을 적용했습니다. 대기열이 서버 계획으로 갱신되었습니다.";
    }
  });
  document.getElementById("createMigrationBtn").addEventListener("click", async (e) => {
    const manifestId = document.getElementById("migrationManifestId").value.trim();
    if (!manifestId) return showToast("manifest ID를 입력하세요.");
    const result = await runWorkflowButton(e.currentTarget, "migration manifest 생성", () => adminWorkflowCallable("createMigrationManifest", { manifestId }));
    if (result) document.getElementById("workflowStatus").textContent = `manifest ${manifestId}: ${result.status}, unresolved ${result.unresolvedCount ?? 0}`;
  });
  document.getElementById("applyMigrationBtn").addEventListener("click", async (e) => {
    const manifestId = document.getElementById("migrationManifestId").value.trim();
    if (!manifestId) return showToast("manifest ID를 입력하세요.");
    const result = await runWorkflowButton(e.currentTarget, "migration manifest 적용", () => adminWorkflowCallable("applyMigrationManifest", { manifestId }));
    if (result?.applied) document.getElementById("workflowStatus").textContent = `manifest ${manifestId}를 적용했습니다.`;
  });
}

/** 현재 전체 데이터를 JSON 파일 하나로 저장(되돌릴 수 있는 백업) */
async function handleBackup() {
  const data = await exportAllData();
  const fname = `${(tournamentInfo.name || "바운스발리볼").replace(/\s+/g, "_")}_백업_${dateStamp()}.json`;
  downloadJson(fname, JSON.stringify(data, null, 2));
  showToast("백업 파일을 저장했습니다");
}

/** 선택한 백업 파일로 전체 데이터를 복원(현재 데이터는 전부 대체됨) */
async function handleRestoreFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // 같은 파일 다시 선택해도 change 이벤트가 또 뜨도록 비워둔다
  if (!file) return;
  if (!confirm("백업 파일로 복원하면 현재 입력된 모든 데이터(팀·조·예선·본선)가 백업 내용으로 전부 대체됩니다.\n계속할까요?")) return;
  try {
    const data = JSON.parse(await file.text());
    await importAllData(data);
    showToast("백업에서 복원했습니다");
  } catch (err) {
    reportError("복원", err);
  }
}

/** 문자열을 JSON 파일로 다운로드한다 */
function downloadJson(filename, jsonText) {
  const blob = new Blob([jsonText], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------- 대회설정: 조 / 팀 ----------------

function normalizeEntryName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
}

/** 조 추가 — 성공하면 방금 만든 조 이름을 기억해서 팀 등록 select에 자동으로 선택되게 한다 */
async function addGroupFromForm() {
  if (isAddingGroup) return;
  const input = document.getElementById("groupNameInput");
  const addBtn = document.getElementById("addGroupBtn");
  const name = input.value.trim();
  if (!name) return showToast("조 이름을 입력하세요");
  if (groups.some((group) => normalizeEntryName(group.name) === normalizeEntryName(name))) {
    return showToast("이미 등록된 조 이름입니다");
  }
  isAddingGroup = true;
  addBtn.disabled = true;
  const originalLabel = addBtn.textContent;
  addBtn.textContent = "추가 중…";
  try {
    await addGroup(name, activeDivision);
    input.value = "";
    pendingAutoSelectGroupName = name;
    input.focus();
  } catch (err) {
    reportError("조 추가", err);
  } finally {
    isAddingGroup = false;
    addBtn.disabled = false;
    addBtn.textContent = originalLabel;
  }
}

/** 팀 추가 — 조를 먼저 선택해야만 추가할 수 있다 (미배정 팀이 새로 생기지 않도록).
 *  추가 후에도 선택된 조는 그대로 유지하고 입력칸에 다시 포커스해서 연속 입력이 쉽게 한다 */
async function addTeamFromForm() {
  if (isAddingTeam) return;
  const nameInput = document.getElementById("teamNameInput");
  const groupSelect = document.getElementById("teamGroupSelect");
  const addBtn = document.getElementById("addTeamBtn");
  if (!groupSelect.value) return showToast("먼저 조를 선택하세요");
  const name = nameInput.value.trim();
  if (!name) return showToast("팀 이름을 입력하세요");
  if (teams.some((team) => (
    team.groupId === groupSelect.value &&
    normalizeEntryName(team.name) === normalizeEntryName(name)
  ))) {
    return showToast("이 조에 이미 등록된 팀 이름입니다");
  }
  isAddingTeam = true;
  addBtn.disabled = true;
  const originalLabel = addBtn.textContent;
  addBtn.textContent = "추가 중…";
  try {
    await addTeam(name, groupSelect.value, activeDivision);
    nameInput.value = "";
    nameInput.focus();
  } catch (err) {
    reportError("팀 추가", err);
  } finally {
    isAddingTeam = false;
    addBtn.disabled = !groupSelect.value;
    addBtn.textContent = originalLabel;
  }
}

/** 현재 선택된 조 이름을 팀 이름 입력칸 placeholder에 보여주고, 조가 선택되지 않으면
 *  팀 이름 입력/추가 버튼을 비활성화한다 (조 선택 전에는 팀을 등록할 수 없게 막는다) */
function updateTeamNameInputContext() {
  const sel = document.getElementById("teamGroupSelect");
  const nameInput = document.getElementById("teamNameInput");
  const addBtn = document.getElementById("addTeamBtn");
  if (!sel || !nameInput) return;
  const selectedOption = sel.options[sel.selectedIndex];
  const groupName = sel.value && selectedOption ? selectedOption.textContent : "";
  nameInput.placeholder = groupName ? `'${groupName}'에 추가할 팀 이름 (Enter)` : "먼저 조를 선택하세요";
  nameInput.disabled = !sel.value;
  if (addBtn) addBtn.disabled = !sel.value;
}

function renderGroupList() {
  const el = document.getElementById("groupList");
  if (!groups.length) {
    el.innerHTML = '<span class="empty-hint">아직 등록된 조가 없습니다.</span>';
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const pill = document.createElement("span");
    pill.className = "team-pill reorder-pill";
    pill.draggable = true;
    pill.innerHTML = `${escapeHtml(g.name)} <button title="삭제">✕</button>`;
    pill.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`${divisionLabel()} '${g.name}' 조를 삭제할까요? (소속 팀은 무소속이 됩니다)`)) return;
      try {
        await deleteGroup(g.id);
      } catch (err) {
        reportError("조 삭제", err);
      }
    });
    pill.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-bounce-group", g.id);
      e.dataTransfer.effectAllowed = "move";
      pill.classList.add("dragging");
    });
    pill.addEventListener("dragend", () => {
      pill.classList.remove("dragging");
      clearReorderIndicators(el);
    });
    pill.addEventListener("dragover", (e) => {
      if (!hasDragType(e, "application/x-bounce-group")) return;
      e.preventDefault();
      e.stopPropagation();
      showReorderIndicator(pill, e.clientX);
    });
    pill.addEventListener("dragleave", () => clearReorderIndicator(pill));
    pill.addEventListener("drop", async (e) => {
      const draggedId = e.dataTransfer.getData("application/x-bounce-group");
      if (!draggedId) return;
      e.preventDefault();
      e.stopPropagation();
      const insertAfter = pill.classList.contains("drop-after");
      clearReorderIndicators(el);
      const orderedIds = buildReorderedIds(groups.map((group) => group.id), draggedId, g.id, insertAfter);
      if (!orderedIds) return;
      try {
        await reorderGroups(orderedIds);
      } catch (err) {
        reportError("조 순서 변경", err);
      }
    });
    el.appendChild(pill);
  });
}

function renderTeamGroupSelect() {
  const sel = document.getElementById("teamGroupSelect");
  const current = sel.value;
  sel.innerHTML = '<option value="">① 조 선택</option>' +
    groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");

  // 방금 새로 만든 조가 있으면 자동으로 선택해서, 바로 이어서 팀 이름을 입력할 수 있게 한다
  if (pendingAutoSelectGroupName) {
    const target = groups.find((g) => g.name === pendingAutoSelectGroupName);
    if (target) {
      sel.value = target.id;
      pendingAutoSelectGroupName = null;
      updateTeamNameInputContext();
      return;
    }
  }
  sel.value = current;
  updateTeamNameInputContext();
}

/** 조 목록 + 미배정 목록을 그린다. 각 팀 pill은 드래그해서 다른 조(또는 미배정)로 옮길 수 있다. */
function renderGroupTeamLists() {
  const el = document.getElementById("groupTeamLists");
  const groupIds = new Set(groups.map((g) => g.id));

  if (!groups.length && !teams.length) {
    el.innerHTML = '<div class="empty-hint">먼저 조를 등록하세요.</div>';
    return;
  }

  el.innerHTML = "";
  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    const box = document.createElement("div");
    box.className = "card";
    box.style.margin = "0";
    box.innerHTML = `<h3>${escapeHtml(g.name)} <span style="color:var(--muted); font-weight:400;">(${groupTeams.length}팀)</span></h3>`;
    const list = document.createElement("div");
    list.className = "row team-dropzone";
    if (!groupTeams.length) {
      list.innerHTML = '<span class="empty-hint">팀 없음 (다른 조의 팀을 여기로 드래그해서 옮길 수 있어요)</span>';
    } else {
      groupTeams.forEach((t) => list.appendChild(createTeamPill(t, g.id)));
    }
    attachDropZone(list, g.id);
    box.appendChild(list);
    el.appendChild(box);
  });

  const noGroupTeams = teams.filter((t) => !t.groupId || !groupIds.has(t.groupId));
  if (noGroupTeams.length) {
    const box = document.createElement("div");
    box.className = "card";
    box.style.margin = "0";
    box.innerHTML = `<h3>미배정 <span style="color:var(--muted); font-weight:400;">(${noGroupTeams.length}팀)</span></h3>`;
    const list = document.createElement("div");
    list.className = "row team-dropzone";
    noGroupTeams.forEach((t) => list.appendChild(createTeamPill(t, null)));
    attachDropZone(list, null);
    box.appendChild(list);
    el.appendChild(box);
  }
}

/** 팀 하나를 드래그 가능한 pill로 만든다 (✕ 버튼으로 삭제, 드래그로 조 이동/순서 변경) */
function createTeamPill(t, groupId) {
  const pill = document.createElement("span");
  pill.className = "team-pill reorder-pill";
  pill.draggable = true;
  pill.innerHTML = `${escapeHtml(t.name)} <button title="삭제">✕</button>`;
  pill.querySelector("button").addEventListener("click", async () => {
    if (!confirm(`${divisionLabel()} '${t.name}' 팀을 삭제할까요?`)) return;
    try {
      await deleteTeam(t.id);
    } catch (err) {
      reportError("팀 삭제", err);
    }
  });
  pill.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-bounce-team", t.id);
    e.dataTransfer.effectAllowed = "move";
    pill.classList.add("dragging");
  });
  pill.addEventListener("dragend", () => {
    pill.classList.remove("dragging");
    document.querySelectorAll(".team-dropzone").forEach(clearReorderIndicators);
  });
  pill.addEventListener("dragover", (e) => {
    if (!hasDragType(e, "application/x-bounce-team")) return;
    e.preventDefault();
    e.stopPropagation();
    showReorderIndicator(pill, e.clientX);
  });
  pill.addEventListener("dragleave", () => clearReorderIndicator(pill));
  pill.addEventListener("drop", async (e) => {
    const draggedId = e.dataTransfer.getData("application/x-bounce-team");
    if (!draggedId) return;
    e.preventDefault();
    e.stopPropagation();
    const insertAfter = pill.classList.contains("drop-after");
    clearReorderIndicators(pill.parentElement);
    await persistTeamDrop(draggedId, groupId, t.id, insertAfter);
  });
  return pill;
}

/** 조 박스(또는 미배정 박스)를 드롭 영역으로 만든다. targetGroupId가 null이면 미배정으로 이동시킨다. */
function attachDropZone(list, targetGroupId) {
  list.addEventListener("dragover", (e) => {
    if (!hasDragType(e, "application/x-bounce-team")) return;
    e.preventDefault();
    list.classList.add("drag-over");
  });
  list.addEventListener("dragleave", () => {
    list.classList.remove("drag-over");
  });
  list.addEventListener("drop", async (e) => {
    const teamId = e.dataTransfer.getData("application/x-bounce-team");
    if (!teamId) return;
    e.preventDefault();
    list.classList.remove("drag-over");
    clearReorderIndicators(list);
    await persistTeamDrop(teamId, targetGroupId);
  });
}

function hasDragType(event, type) {
  return Array.from(event.dataTransfer?.types || []).includes(type);
}

function showReorderIndicator(element, clientX) {
  const insertAfter = clientX >= element.getBoundingClientRect().left + element.offsetWidth / 2;
  element.classList.toggle("drop-before", !insertAfter);
  element.classList.toggle("drop-after", insertAfter);
}

function clearReorderIndicator(element) {
  element.classList.remove("drop-before", "drop-after");
}

function clearReorderIndicators(container) {
  container.querySelectorAll(".drop-before, .drop-after").forEach(clearReorderIndicator);
}

/** draggedId를 targetId의 앞/뒤로 옮긴 새 id 배열을 만든다. 순서가 같으면 null을 반환한다. */
function buildReorderedIds(currentIds, draggedId, targetId, insertAfter) {
  if (!currentIds.includes(draggedId) || !currentIds.includes(targetId) || draggedId === targetId) return null;
  const orderedIds = currentIds.filter((id) => id !== draggedId);
  const targetIndex = orderedIds.indexOf(targetId);
  orderedIds.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedId);
  return orderedIds.every((id, index) => id === currentIds[index]) ? null : orderedIds;
}

async function persistTeamDrop(draggedId, targetGroupId, targetId = null, insertAfter = true) {
  const targetIds = teams
    .filter((team) => team.groupId === targetGroupId && team.id !== draggedId)
    .map((team) => team.id);
  let insertIndex = targetIds.length;
  if (targetId && targetId !== draggedId) {
    const targetIndex = targetIds.indexOf(targetId);
    if (targetIndex >= 0) insertIndex = targetIndex + (insertAfter ? 1 : 0);
  }
  targetIds.splice(insertIndex, 0, draggedId);

  const draggedTeam = teams.find((team) => team.id === draggedId);
  if (!draggedTeam) return;
  const sameGroup = draggedTeam.groupId === targetGroupId;
  const currentIds = teams.filter((team) => team.groupId === targetGroupId).map((team) => team.id);
  if (sameGroup && targetIds.every((id, index) => id === currentIds[index])) return;
  try {
    await moveAndReorderTeam(draggedId, targetGroupId, targetIds);
    if (sameGroup) await syncRoundRobinOrderAfterTeamReorder(targetGroupId, targetIds);
  } catch (err) {
    reportError("팀 순서 변경", err);
  }
}

async function syncRoundRobinOrderAfterTeamReorder(groupId, orderedTeamIds) {
  const group = groups.find((item) => item.id === groupId);
  if ((group?.matchMode || "ring") !== "roundrobin") return;
  const groupMatches = prelimMatches.filter((match) => match.groupId === groupId);
  if (groupMatches.length < 2) return;

  const orderedMatchIds = orderExistingRoundRobinMatchIds(groupMatches, orderedTeamIds);
  await reorderPrelimMatches(groupId, orderedMatchIds);
  syncCourtOrderWithPrelimOrder(workflowDraftAssignments, orderedMatchIds);
  workflowDirty = true;
  renderWorkflowCourtPlanner();
  showToast("참가팀 순서에 맞춰 예선 대진과 코트 경기 순서를 반영했습니다. 코트 설정·배정 저장을 눌러 확정하세요.", 5000);
}

// ---------------- 예선 ----------------

function groupHasPrelimMatches(groupId) {
  return prelimMatches.some((m) => m.groupId === groupId);
}

function groupHasScoredMatches(groupId) {
  return prelimMatches.some(
    (m) => m.groupId === groupId && (m.sets || []).some((s) => Number(s.a) > 0 || Number(s.b) > 0)
  );
}

/** 방식 전환/재배치로 기존 결과가 사라질 수 있을 때 확인을 구한다. 결과가 없으면 그냥 통과. */
function confirmIfResultsWillReset(groupId, groupName, message) {
  if (!groupHasScoredMatches(groupId)) return true;
  return confirm(`${divisionLabel()} ${message || `'${groupName}'의 기존 경기 결과가 초기화됩니다. 계속할까요?`}`);
}

/** 한 조의 예선 대진/결과와 링크제 도형 배치를 모두 초기화한다 (조별 '초기화' 버튼용) */
async function handleResetGroupPrelim(group) {
  const hasMatches = groupHasPrelimMatches(group.id);
  const hasRingPlacement = (group.ringOrder || []).some(Boolean);
  if (!hasMatches && !hasRingPlacement) return showToast(`${group.name}에 초기화할 내용이 없습니다`);
  if (!confirm(`${divisionLabel()} '${group.name}'의 예선 대진과 결과, 도형(링크제) 배치를 모두 초기화할까요?`)) return;
  try {
    await clearPrelimMatchesForGroup(group.id);
    await setGroupRingOrder(group.id, []);
    ringSelection = null;
    showToast(`${group.name} 예선을 초기화했습니다`);
  } catch (err) {
    reportError("조별 예선 초기화", err);
  }
}

// 방식 토글은 단순히 어떤 생성 화면을 보여줄지 정하는 선택일 뿐, 기존에 만들어둔 대진/결과는
// 건드리지 않는다. (실제로 데이터가 바뀌는 시점은 "대진 생성" 버튼을 누르거나 링크제 배치를
// 다 채웠을 때뿐이다.)
async function handleSetMatchMode(group, mode) {
  const current = group.matchMode || "ring";
  if (mode === current) return;
  try {
    await setGroupMatchMode(group.id, mode);
    ringSelection = null;
    showToast(`${group.name} 방식을 ${mode === "ring" ? "링크제" : "라운드로빈"}으로 변경했습니다`);
  } catch (err) {
    reportError("예선 방식 변경", err);
  }
}

async function applyRingOrderChange(group, nextRingOrder) {
  if (!confirmIfResultsWillReset(group.id, group.name)) {
    renderPrelimSetupGroups(); // 취소 시에도 선택 상태가 이미 풀렸으므로 화면을 다시 그려 정리한다
    return;
  }
  try {
    await setGroupRingOrder(group.id, nextRingOrder);
    const pairs = getRingMatchPairs(nextRingOrder);
    if (pairs) {
      await generateRingMatchesForGroup(group.id, pairs);
      showToast(`${group.name} 대진이 확정되었습니다`);
    } else if (groupHasPrelimMatches(group.id)) {
      await clearPrelimMatchesForGroup(group.id);
    }
  } catch (err) {
    reportError("링크제 배치", err);
  }
}

async function handleRingShuffle(group, groupTeams) {
  if (!confirmIfResultsWillReset(group.id, group.name, `'${group.name}'을 무작위로 다시 배치하면 기존 경기 결과가 초기화됩니다. 계속할까요?`)) return;
  const ids = groupTeams.map((t) => t.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  ringSelection = null;
  await applyRingOrderChange(group, ids);
}

function handleRingVertexDrop(group, ringOrder, data, targetIndex) {
  const next = [...ringOrder];
  if (data.type === "pool") {
    const fromIdx = next.indexOf(data.teamId);
    if (fromIdx !== -1) next[fromIdx] = null;
    next[targetIndex] = data.teamId;
  } else if (data.type === "vertex") {
    const fromIdx = data.index;
    if (fromIdx === targetIndex) return;
    [next[fromIdx], next[targetIndex]] = [next[targetIndex], next[fromIdx]];
  }
  applyRingOrderChange(group, next);
}

function handleRingPoolDrop(group, ringOrder, data) {
  if (data.type !== "vertex") return;
  const next = [...ringOrder];
  next[data.index] = null;
  applyRingOrderChange(group, next);
}

/** 클릭으로 배치하기(드래그 대체): 풀의 칩 클릭 → 선택, 꼭짓점 클릭 → 배치/교환 */
function handleVertexClick(group, ringOrder, index) {
  if (ringSelection && ringSelection.groupId !== group.id) ringSelection = null;
  if (!ringSelection) {
    if (ringOrder[index]) {
      ringSelection = { type: "vertex", index, groupId: group.id };
      renderPrelimSetupGroups();
    }
    return;
  }
  // 이미 선택된 꼭짓점을 다시 클릭 -> 선택 취소
  if (ringSelection.type === "vertex" && ringSelection.index === index) {
    ringSelection = null;
    renderPrelimSetupGroups();
    return;
  }
  const data = ringSelection;
  ringSelection = null;
  handleRingVertexDrop(group, ringOrder, data, index);
}

function handlePoolChipClick(group, ringOrder, teamId) {
  if (ringSelection && ringSelection.groupId !== group.id) ringSelection = null;
  if (ringSelection && ringSelection.type === "pool" && ringSelection.teamId === teamId) {
    ringSelection = null;
  } else {
    ringSelection = { type: "pool", teamId, groupId: group.id };
  }
  renderPrelimSetupGroups();
}

function buildRoundRobinControls(g, groupTeams) {
  const wrap = document.createElement("div");
  wrap.className = "row";
  wrap.style.marginBottom = "12px";
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = groupHasPrelimMatches(g.id) ? "라운드로빈 대진 다시 생성" : "라운드로빈 대진 생성";
  btn.addEventListener("click", async () => {
    if (!confirmIfResultsWillReset(g.id, g.name, `'${g.name}' 예선 대진을 (재)생성할까요? 기존 결과는 초기화됩니다.`)) return;
    try {
      await generatePrelimMatchesForGroup(g.id, groupTeams.map((t) => t.id));
      showToast(`${g.name} 대진을 생성했습니다`);
    } catch (err) {
      reportError("예선 대진 생성", err);
    }
  });
  wrap.appendChild(btn);
  return wrap;
}

function buildRingControls(g, groupTeams) {
  const wrap = document.createElement("div");
  wrap.className = "ring-controls";

  const groupTeamIds = groupTeams.map((t) => t.id);
  const ringOrder = normalizeRingOrder(g.ringOrder, groupTeamIds);
  if (JSON.stringify(ringOrder) !== JSON.stringify(g.ringOrder || [])) {
    setGroupRingOrder(g.id, ringOrder).catch(() => {});
  }

  const poolTeams = groupTeams.filter((t) => !ringOrder.includes(t.id));
  const filled = ringOrder.length > 0 && ringOrder.every((id) => id);
  const placedCount = ringOrder.filter(Boolean).length;

  // 안내 + 무작위 배치
  const toolbar = document.createElement("div");
  toolbar.className = "row";
  toolbar.style.marginBottom = "10px";
  toolbar.style.justifyContent = "space-between";
  const hint = document.createElement("span");
  hint.className = "empty-hint";
  hint.style.padding = "0";
  hint.textContent = filled
    ? "대진이 확정되었습니다. 다시 배치하면 결과가 초기화됩니다."
    : `팀을 도형의 꼭짓점으로 드래그하거나, 팀을 클릭한 뒤 꼭짓점을 클릭하세요 (${placedCount}/${ringOrder.length} 배치됨)`;
  const shuffleBtn = document.createElement("button");
  shuffleBtn.className = "btn small ghost";
  shuffleBtn.textContent = "무작위 배치";
  shuffleBtn.addEventListener("click", () => handleRingShuffle(g, groupTeams));
  toolbar.appendChild(hint);
  toolbar.appendChild(shuffleBtn);
  wrap.appendChild(toolbar);

  // 배치 대기 팀(풀)
  const pool = document.createElement("div");
  pool.className = "row team-pool";
  pool.addEventListener("dragover", (e) => e.preventDefault());
  pool.addEventListener("drop", (e) => {
    e.preventDefault();
    const data = safeParseJson(e.dataTransfer.getData("text/plain"));
    if (data) handleRingPoolDrop(g, ringOrder, data);
  });
  if (!poolTeams.length) {
    const span = document.createElement("span");
    span.className = "empty-hint";
    span.style.padding = "0";
    span.textContent = filled ? "" : "배치 대기 중인 팀이 없습니다.";
    pool.appendChild(span);
  } else {
    poolTeams.forEach((t) => {
      const chip = document.createElement("span");
      const isSelected = ringSelection && ringSelection.type === "pool" && ringSelection.groupId === g.id && ringSelection.teamId === t.id;
      chip.className = "team-pill ring-chip" + (isSelected ? " selected" : "");
      chip.textContent = t.name;
      chip.draggable = true;
      chip.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ type: "pool", teamId: t.id }));
      });
      chip.addEventListener("click", () => handlePoolChipClick(g, ringOrder, t.id));
      pool.appendChild(chip);
    });
  }
  wrap.appendChild(pool);

  // 도형
  const diagramHost = document.createElement("div");
  diagramHost.style.margin = "14px auto 4px";
  wrap.appendChild(diagramHost);
  const selectedVertexIndex = (ringSelection && ringSelection.type === "vertex" && ringSelection.groupId === g.id) ? ringSelection.index : null;
  renderRingDiagram(diagramHost, {
    ringOrder,
    teamNameById: (id) => teamName(id),
    editable: true,
    selectedVertexIndex,
    onVertexDrop: (data, targetIndex) => handleRingVertexDrop(g, ringOrder, data, targetIndex),
    onVertexClick: (index) => handleVertexClick(g, ringOrder, index),
  });

  return wrap;
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/** 라운드로빈 경기 목록을 드래그로 재배열한 결과(=새 round 순서)를 Firestore에 저장한다 */
async function handleMatchReorderDrop(groupId, groupMatches, draggedId, targetId) {
  if (!draggedId || draggedId === targetId) return;
  const ids = groupMatches.map((m) => m.id);
  const fromIdx = ids.indexOf(draggedId);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
  try {
    await reorderPrelimMatches(groupId, ids);
    syncCourtOrderWithPrelimOrder(workflowDraftAssignments, ids);
    workflowDirty = true;
    renderWorkflowCourtPlanner();
    showToast("경기 순서를 코트 설정에도 반영했습니다. 코트 설정·배정 저장을 눌러 확정하세요.", 5000);
  } catch (err) {
    reportError("경기 순서 변경", err);
  }
}

/** 예선 관련 화면(대회설정 탭의 생성 컨트롤 + 예선 탭의 대진표)을 함께 다시 그린다 */
function renderPrelimViews() {
  renderPrelimSetupGroups();
  renderPrelimGroups();
}

/** [대회설정] 탭: 조별 대진 방식 선택과 대진 생성 컨트롤 (링크제 배치 / 라운드로빈 생성) */
function renderPrelimSetupGroups() {
  const el = document.getElementById("prelimSetupGroups");
  if (!el) return;
  if (!groups.length) {
    el.innerHTML = '<div class="empty-hint">먼저 위에서 조를 만들고 팀을 등록하세요.</div>';
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    const mode = g.matchMode || "ring";

    const box = document.createElement("div");
    box.className = "settings-box";
    box.style.marginBottom = "12px";

    const head = document.createElement("div");
    head.className = "row";
    head.style.justifyContent = "space-between";
    head.style.marginBottom = "10px";
    const title = document.createElement("b");
    title.textContent = `${g.name} · ${groupTeams.length}팀`;
    head.appendChild(title);

    const headRight = document.createElement("span");
    headRight.className = "row";
    const modeToggle = document.createElement("span");
    modeToggle.className = "mode-toggle";
    modeToggle.innerHTML = `
      <button type="button" class="mode-btn ${mode === "ring" ? "active" : ""}" data-mode="ring">링크제</button>
      <button type="button" class="mode-btn ${mode === "roundrobin" ? "active" : ""}" data-mode="roundrobin">라운드로빈</button>`;
    modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => handleSetMatchMode(g, btn.dataset.mode));
    });
    headRight.appendChild(modeToggle);

    const resetGroupBtn = document.createElement("button");
    resetGroupBtn.type = "button";
    resetGroupBtn.className = "btn danger small";
    resetGroupBtn.title = `${g.name}의 예선 대진과 결과, 도형(링크제) 배치를 모두 삭제합니다`;
    resetGroupBtn.textContent = "초기화";
    resetGroupBtn.addEventListener("click", () => handleResetGroupPrelim(g));
    headRight.appendChild(resetGroupBtn);
    head.appendChild(headRight);
    box.appendChild(head);

    if (groupTeams.length < 2) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.style.padding = "0";
      hint.textContent = "이 조에 팀이 2팀 이상 등록되면 대진을 만들 수 있습니다.";
      box.appendChild(hint);
    } else if (mode === "ring") {
      box.appendChild(buildRingControls(g, groupTeams));
    } else {
      box.appendChild(buildRoundRobinControls(g, groupTeams));
    }

    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id).sort((a, b) => (a.round || 0) - (b.round || 0));
    const madeHint = document.createElement("div");
    madeHint.className = "prelim-match-status";
    if (!groupMatches.length) {
      madeHint.textContent = "경기 없음";
    } else {
      madeHint.textContent = `${groupMatches.length}경기 생성됨`;
    }
    box.appendChild(madeHint);

    if (groupMatches.length) {
      const reorderable = mode === "roundrobin" && groupMatches.length > 1;
      const matchList = document.createElement("div");
      matchList.className = `prelim-match-list${reorderable ? " is-reorderable" : ""}`;
      groupMatches.forEach((m, idx) => {
        const row = document.createElement("div");
        row.className = `prelim-match-row${reorderable ? " is-draggable" : ""}`;
        if (reorderable) {
          row.title = "드래그하여 경기 순서 변경";
          const handle = document.createElement("span");
          handle.className = "prelim-drag-handle";
          handle.setAttribute("aria-hidden", "true");
          handle.textContent = "⠿";
          row.appendChild(handle);
        }
        const order = document.createElement("span");
        order.className = "prelim-match-order";
        order.textContent = String(idx + 1);
        const matchup = document.createElement("span");
        matchup.className = "prelim-matchup";
        matchup.innerHTML = `<strong>${escapeHtml(teamName(m.teamA))}</strong><b>VS</b><strong>${escapeHtml(teamName(m.teamB))}</strong>`;
        row.append(order, matchup);
        const courtControl = document.createElement("label");
        courtControl.className = "prelim-court-control";
        const courtLabel = document.createElement("span");
        courtLabel.textContent = "배정 코트";
        const courtSelect = document.createElement("select");
        courtSelect.draggable = false;
        courtSelect.dataset.prelimCourtMatch = m.id;
        courtSelect.setAttribute("aria-label", `${teamName(m.teamA)} 대 ${teamName(m.teamB)} 코트 선택`);
        fillPrelimCourtSelect(courtSelect, m.id);
        courtSelect.addEventListener("mousedown", (e) => e.stopPropagation());
        courtSelect.addEventListener("click", (e) => e.stopPropagation());
        courtSelect.addEventListener("change", () => {
          const laterMatchOnCourt = groupMatches
            .slice(idx + 1)
            .find((match) => (assignmentFor(match.id)?.courtId || "") === courtSelect.value);
          setMatchCourt(m.id, courtSelect.value, laterMatchOnCourt?.id || null);
        });
        courtControl.append(courtLabel, courtSelect);
        row.appendChild(courtControl);
        if (reorderable) {
          row.draggable = true;
          row.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", m.id);
            e.dataTransfer.effectAllowed = "move";
            row.classList.add("dragging");
          });
          row.addEventListener("dragend", () => row.classList.remove("dragging"));
          row.addEventListener("dragover", (e) => {
            e.preventDefault();
            row.classList.add("drag-over-row");
          });
          row.addEventListener("dragleave", () => row.classList.remove("drag-over-row"));
          row.addEventListener("drop", (e) => {
            e.preventDefault();
            row.classList.remove("drag-over-row");
            const draggedId = e.dataTransfer.getData("text/plain");
            handleMatchReorderDrop(g.id, groupMatches, draggedId, m.id);
          });
        }
        matchList.appendChild(row);
      });
      box.appendChild(matchList);
    }

    el.appendChild(box);
  });
}

/** [예선] 탭: 조별 대진표·순위표 출력과 점수 입력 (대진 생성은 대회설정 탭에서 한다) */
function renderPrelimGroups() {
  const el = document.getElementById("prelimGroups");
  if (!groups.length) {
    el.innerHTML = '<div class="empty-hint">먼저 대회설정 탭에서 조를 만들어 주세요.</div>';
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    // Firestore는 정렬 없이 구독 중이라 docId 순서로 오므로, 화면에 보여줄 때는 항상 round 순으로 정렬한다
    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id).sort((a, b) => (a.round || 0) - (b.round || 0));
    const standings = computeGroupStandings(groupTeams, groupMatches);
    const mode = g.matchMode || "ring";

    const card = document.createElement("div");
    card.className = "card";
    const heading = document.createElement("h2");
    heading.innerHTML = `${escapeHtml(g.name)} 예선 <span style="margin-left:auto; font-weight:400; color:var(--muted); font-size:13px;">${mode === "ring" ? "링크제" : "라운드로빈"}</span>`;
    card.appendChild(heading);

    // 링크제는 배치된 도형 자체가 대진표이므로 읽기 전용으로 함께 보여준다
    if (mode === "ring" && (g.ringOrder || []).some(Boolean)) {
      const diagramHost = document.createElement("div");
      diagramHost.style.margin = "4px auto 10px";
      renderRingDiagram(diagramHost, {
        ringOrder: normalizeRingOrder(g.ringOrder, groupTeams.map((t) => t.id)),
        teamNameById: (id) => teamName(id),
        editable: false,
      });
      card.appendChild(diagramHost);
    }

    // 순위표
    if (standings.length) {
      const table = document.createElement("table");
      table.innerHTML = `<thead><tr>
        <th>순위</th><th>팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>승점</th><th>세트득실</th><th>득실차</th>
      </tr></thead>`;
      const tbody = document.createElement("tbody");
      standings.forEach((s) => {
        const tr = document.createElement("tr");
        if (s.rank === 1) tr.className = "rank-1";
        tr.innerHTML = `<td>${s.rank}${s.needsLottery ? '<div class="lottery-flag">동률·추첨필요</div>' : ""}</td>
          <td>${escapeHtml(s.name)}</td><td>${s.played}</td><td>${s.win}</td><td>${s.draw}</td><td>${s.loss}</td>
          <td>${s.points}</td><td>${s.setDiff >= 0 ? "+" : ""}${s.setDiff}</td><td>${s.pointDiff >= 0 ? "+" : ""}${s.pointDiff}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
    } else {
      const noTeamHint = document.createElement("div");
      noTeamHint.className = "empty-hint";
      noTeamHint.textContent = "참가팀이 없습니다.";
      card.appendChild(noTeamHint);
    }

    // 경기 목록 (라운드로빈은 모든 팀이 만나므로, 드래그로 경기 순서를 바꿀 수 있게 한다)
    const matchList = document.createElement("div");
    matchList.style.marginTop = "14px";
    if (!groupMatches.length) {
      matchList.innerHTML = '<div class="empty-hint">생성된 경기가 없습니다. 대회설정 탭의 \'예선 대진 방식·생성\'에서 대진을 생성하세요.</div>';
    } else {
      const reorderable = mode === "roundrobin" && groupMatches.length > 1;
      if (reorderable) {
        const dragHint = document.createElement("div");
        dragHint.className = "empty-hint";
        dragHint.style.padding = "0 4px 6px";
        dragHint.textContent = "경기 카드를 드래그해서 경기 순서를 바꿀 수 있습니다.";
        matchList.appendChild(dragHint);
      }
      groupMatches.forEach((m, idx) => {
        const row = document.createElement("div");
        row.className = "row" + (reorderable ? " match-row-draggable" : "");
        row.style.justifyContent = "space-between";
        row.style.padding = "8px 4px";
        row.style.borderBottom = "1px solid var(--line)";
        const evald = evaluatePrelimMatch(m.sets || []);
        const scoreText = (m.sets || []).filter((s) => Number(s.a) > 0 || Number(s.b) > 0).map((s) => `${s.a}:${s.b}`).join(" / ");
        const submittedWorkflow = reviewWorkflows.get(m.id);
        const pendingSets = submittedWorkflow?.draftState === "submitted"
          && Array.isArray(submittedWorkflow.submittedSnapshot?.sets)
          ? submittedWorkflow.submittedSnapshot.sets
          : [];
        const pendingScoreText = pendingSets.map((s) => `${s.a}:${s.b}`).join(" / ");
        const resultBadge = evald.result === "A" ? `<span class="badge win">${teamName(m.teamA)} 승</span>`
          : evald.result === "B" ? `<span class="badge win">${teamName(m.teamB)} 승</span>`
          : evald.result === "draw" ? '<span class="badge draw">무승부</span>'
          : evald.status === "in_progress" ? '<span class="badge">경기중</span>'
          : '<span class="badge">경기전</span>';
        const left = document.createElement("span");
        left.innerHTML = `<span class="match-order-badge">${idx + 1}</span>${escapeHtml(teamName(m.teamA))} <b>vs</b> ${escapeHtml(teamName(m.teamB))} <span style="color:var(--muted); font-size:12px;">${scoreText}</span>${pendingScoreText ? `<br><span style="color:var(--red); font-size:12px; margin-left:34px;">검수 대기 점수: ${escapeHtml(pendingScoreText)}</span>` : ""}`;
        row.appendChild(left);
        const right = document.createElement("span");
        right.className = "row";
        right.innerHTML = resultBadge + (pendingScoreText ? '<span class="badge">검수 대기</span>' : "");
        if (pendingScoreText) {
          const reviewBtn = document.createElement("button");
          reviewBtn.className = "btn primary small";
          reviewBtn.textContent = "검수하기";
          reviewBtn.addEventListener("click", () => {
            document.querySelector('.tab-btn[data-tab="workflow"]')?.click();
            requestAnimationFrame(() => {
              const reviewRow = [...document.querySelectorAll("[data-review-match]")]
                .find((item) => item.dataset.reviewMatch === m.id);
              reviewRow?.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          });
          right.appendChild(reviewBtn);
        }
        const editBtn = document.createElement("button");
        editBtn.className = "btn small";
        editBtn.textContent = evald.status === "done" ? "점수 수정" : "점수 입력";
        editBtn.addEventListener("click", () => openPrelimScoreModal(m));
        const court = prelimCourtDisplay(m.id);
        const courtBadge = document.createElement("span");
        courtBadge.className = `badge court${court.label === "미배정" ? " unassigned" : ""}`;
        courtBadge.dataset.prelimCourtBadge = m.id;
        courtBadge.textContent = court.label;
        courtBadge.title = court.recorderName ? `담당 기록관: ${court.recorderName}` : "";
        right.appendChild(courtBadge);
        right.appendChild(editBtn);
        row.appendChild(right);

        if (reorderable) {
          row.draggable = true;
          row.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", m.id);
            e.dataTransfer.effectAllowed = "move";
            row.classList.add("dragging");
          });
          row.addEventListener("dragend", () => row.classList.remove("dragging"));
          row.addEventListener("dragover", (e) => {
            e.preventDefault();
            row.classList.add("drag-over-row");
          });
          row.addEventListener("dragleave", () => row.classList.remove("drag-over-row"));
          row.addEventListener("drop", (e) => {
            e.preventDefault();
            row.classList.remove("drag-over-row");
            const draggedId = e.dataTransfer.getData("text/plain");
            handleMatchReorderDrop(g.id, groupMatches, draggedId, m.id);
          });
        }

        matchList.appendChild(row);
      });
      if (!matchList.children.length || (reorderable && matchList.children.length === 1)) {
        const empty = document.createElement("div");
        empty.className = "empty-hint";
        empty.textContent = "선택한 코트 필터에 해당하는 경기가 없습니다.";
        matchList.appendChild(empty);
      }
    }
    card.appendChild(matchList);
    el.appendChild(card);
  });
}

function teamName(id) {
  const t = teams.find((x) => x.id === id);
  return t ? t.name : "?";
}

function openPrelimScoreModal(match) {
  openScoreModal({
    teamAName: teamName(match.teamA),
    teamBName: teamName(match.teamB),
    setLabels: ["1세트 (10점)", "2세트 (10점)"],
    targets: [10, 10],
    existingSets: match.sets || [],
    onSave: async (sets) => {
      const reason = requiredReason("관리자 직접 수정");
      if (!reason) throw new Error("정정 사유는 필수입니다.");
      await adminWorkflowCallable("directEditOfficialScore", {
        matchKey: match.id,
        score: { sets },
        reason,
        expectedOfficialRevision: reviewWorkflows.get(match.id)?.officialRevision || 0,
      });
      showToast("관리자 수정 점수를 승인했습니다.");
    },
  });
}

// ---------------- 본선 ----------------

/** 숫자 앞에 +/- 부호를 붙인다 (세트득실/득실차 표시용) */
function fmtSigned(n) {
  return (n >= 0 ? "+" : "") + n;
}

/** 예선 순위 기준으로 조별 상위 N팀(대회설정의 qualifyPerGroup, 기본 2)을 추천 진출팀으로 계산한다 */
/**
 * 예선 순위를 기준으로 표준 시딩 순서(1위 전원 -> 2위 전원 -> ...)를 만든다. 단, 같은 조에서
 * 올라온 두 팀이 1라운드에서 곧바로 다시 만나는 경우만 피해서 배치한다.
 * (buildCrossGroupSeedOrder, bracket.js)
 */
function computeRecommendedSeeds() {
  const n = Math.max(1, Number(tournamentInfo.qualifyPerGroup?.[activeDivision]) || 2);
  const standingsByGroup = groups
    .map((g) => {
      const groupTeams = teams.filter((t) => t.groupId === g.id);
      if (!groupTeams.length) return null;
      const groupMatches = prelimMatches.filter((m) => m.groupId === g.id);
      // groupSize(조 인원수)를 함께 넘겨, 인원수가 적은 조의 진출팀이 부전승보다 실제
      // 경기를 먼저 배정받도록 한다(buildCrossGroupSeedOrder, bracket.js) - 조 구성이
      // 어떻든(인원수가 조마다 다르더라도) 그대로 적용되는 일반 규칙이다.
      return { groupId: g.id, groupSize: groupTeams.length, standings: computeGroupStandings(groupTeams, groupMatches) };
    })
    .filter(Boolean);

  const tiers = [];
  for (let rank = 1; rank <= n; rank++) {
    const tier = [];
    standingsByGroup.forEach(({ groupId, groupSize, standings }) => {
      const found = standings.find((s) => s.rank === rank);
      if (found) tier.push({ teamId: found.teamId, groupId, groupSize });
    });
    if (tier.length) tiers.push(tier);
  }
  return buildCrossGroupSeedOrder(tiers);
}

/** 한 팀의 진출 원칙(승점·세트득실·득실차)과, 동률일 경우 어떤 기준으로 순위가 갈렸는지 설명 문구를 만든다 */
function buildQualifyReasonText(standings, s) {
  const base = `승점 ${s.points} · 세트 ${fmtSigned(s.setDiff)} · 득실 ${fmtSigned(s.pointDiff)}`;
  const tied = standings.filter(
    (o) => o.teamId !== s.teamId && o.points === s.points && o.setDiff === s.setDiff && o.pointDiff === s.pointDiff
  );
  if (!tied.length) return base;
  const tiedNames = tied.map((o) => o.name).join(", ");
  if (s.needsLottery) {
    return `${base} → ${tiedNames}와 동률, 상대전적도 같아 추첨으로 결정 필요`;
  }
  return `${base} → ${tiedNames}와 동률, 상대전적(승자승)으로 ${s.rank}위 결정`;
}

function renderFinalTeamPicker() {
  const el = document.getElementById("finalTeamPicker");
  el.innerHTML = "";

  // 예선 순위 기준 추천 진출팀을 그대로 쓰는 중이면 매 렌더마다 최신 결과로 다시 계산한다
  if (seedAutoMode) {
    seedSelection = computeRecommendedSeeds();
  }

  // 좌측: 전체 팀 체크리스트
  const left = document.createElement("div");
  const statusText = seedAutoMode ? "" : '<span class="empty-hint" style="padding:0;">체크박스를 직접 조정한 상태입니다.</span>';
  left.innerHTML = `<h3>진출팀 선택</h3>
    <div class="row" style="justify-content:space-between; margin-bottom:8px;">
      ${statusText || "<span></span>"}
      <button type="button" class="btn small ghost" id="resetSeedAutoBtn">추천대로 다시 채우기</button>
    </div>`;
  if (!teams.length) {
    left.innerHTML += '<div class="empty-hint">등록된 팀이 없습니다.</div>';
  }

  // 조가 여러 개일 때 세로로 길게 한 줄씩 늘어놓으면 화면 오른쪽이 비어 보이므로,
  // 조 블럭을 2열 그리드로 나눠서 배치한다.
  const groupsWrap = document.createElement("div");
  groupsWrap.className = "final-team-picker-groups";
  left.appendChild(groupsWrap);

  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    if (!groupTeams.length) return;
    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id).sort((a, b) => (a.round || 0) - (b.round || 0));
    const standings = computeGroupStandings(groupTeams, groupMatches);
    const standingById = Object.fromEntries(standings.map((s) => [s.teamId, s]));

    const sub = document.createElement("div");
    sub.style.marginBottom = "10px";
    sub.innerHTML = `<div style="font-weight:700; font-size:13px; margin-bottom:6px;">${escapeHtml(g.name)}</div>`;
    groupTeams
      .sort((a, b) => ((standingById[a.id] && standingById[a.id].rank) || 99) - ((standingById[b.id] && standingById[b.id].rank) || 99))
      .forEach((t) => {
        const s = standingById[t.id];
        const row = document.createElement("label");
        row.className = "row";
        row.style.justifyContent = "flex-start";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.style.padding = "5px 0";
        row.style.borderBottom = "1px solid var(--line)";
        const checked = seedSelection.includes(t.id);
        const rankBadge = s ? `<span class="badge">예선 ${s.rank}위</span>` : "";
        // 예선 경기를 하나도 치르지 않았으면(전부 0점) 동률 설명이 무의미하므로, 실제로 경기를 치른 뒤에만 보여준다
        const hasPlayed = s && s.played > 0;
        const lotteryBadge = hasPlayed && s.needsLottery ? '<span class="badge lottery">동률·추첨필요</span>' : "";
        const reasonText = !s ? "팀 정보 없음" : hasPlayed ? buildQualifyReasonText(standings, s) : "";
        row.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""} />
          <span style="flex:1;">
            <span>${escapeHtml(t.name)} ${rankBadge} ${lotteryBadge}</span>
            ${reasonText ? `<div class="empty-hint" style="padding:2px 0 0; font-size:11.5px; line-height:1.5;">${escapeHtml(reasonText)}</div>` : ""}
          </span>`;
        row.querySelector("input").addEventListener("change", (e) => {
          seedAutoMode = false; // 직접 조작하면 추천 자동갱신은 멈추고, 이후엔 관리자가 직접 관리
          if (e.target.checked) {
            if (!seedSelection.includes(t.id)) seedSelection.push(t.id);
          } else {
            seedSelection = seedSelection.filter((id) => id !== t.id);
          }
          renderFinalTeamPicker();
        });
        sub.appendChild(row);
      });
    groupsWrap.appendChild(sub);
  });
  el.appendChild(left);

  const resetBtn = left.querySelector("#resetSeedAutoBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      seedAutoMode = true;
      renderFinalTeamPicker();
    });
  }

  // 선택목록에서 더이상 존재하지 않는 팀 제거. (예전엔 우측에 "대진목록" 미리보기를 따로 두고
  // 거기서 자리를 조정했지만, 대진표 생성 이후의 자리 조정은 항상 대진표트리에서 드래그앤드랍으로
  // 하기로 정리되어 더 이상 필요하지 않다 - 진출팀 선택 칸이 그 공간까지 전체 너비로 쓴다.)
  seedSelection = seedSelection.filter((id) => teams.some((t) => t.id === id));
}

/** teamId가 속한 조에서의 예선 순위를 "A조 1위" 형태 문구로 만든다 */
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

/** 대진표 생성도 부전승 배치·자리 조정과 마찬가지로 "아직 다듬는 중"인 단계이므로,
 * 이 시점에 곧바로 Firestore에 쓰지 않는다. generateBracket()으로 로컬에서만 새 대진표를
 * 만들어 화면에 보여주고, 부전승 배치·자리 조정까지 모두 마친 뒤 "관객 화면에 공개"를
 * 눌러야 비로소 관객 화면(대시보드)에 한 번에 반영된다. */
async function onGenerateBracket() {
  if (seedSelection.length < 2) return showToast("본선 진출팀을 2팀 이상 선택하세요");
  if (seedSelection.length > 32) return showToast("본선 진출팀은 최대 32팀까지 지원합니다");
  if (!confirm(`${divisionLabel()} ${seedSelection.length}팀으로 본선 대진표를 생성할까요? 기존 대진표는 초기화됩니다.`)) return;
  const teamsInSeedOrder = seedSelection.map((id) => ({ id, name: teamName(id) }));
  const { matches } = generateBracket(teamsInSeedOrder);
  finalMatches = matches;
  bracketPublishPending = true;
  renderFinalBracket();
  renderFinalTeamPicker();
  showToast(`${divisionLabel()} 본선 대진표를 생성했습니다 (아직 공개 안 됨). 부전승 배치·자리 조정까지 마친 뒤 '관객 화면에 공개'를 눌러주세요.`);
}

function renderFinalBracket() {
  renderByeUnassignedPanel();
  updateBracketPublishBar();
  const container = document.getElementById("finalBracketContainer");
  renderBracket(container, finalMatches, {
    editable: true,
    onEdit: openFinalScoreModal,
    onSwapSlot: handleBracketSlotSwap,
    onConfirmBye: handleConfirmBye,
    getTeamLabel: teamGroupRankLabel,
  });
}

/** 공개 막대 상태 갱신. 대진표가 있으면 항상 보이며(라운드마다 공개에 쓰도록), 공개하지 않은
 * 변경/기록이 있으면 주황 경고 + 버튼 활성화, 모두 공개됐으면 초록 + 버튼 비활성("공개 완료"). */
function updateBracketPublishBar() {
  const bar = document.getElementById("bracketPublishBar");
  const msg = document.getElementById("bracketPublishMsg");
  const btn = document.getElementById("publishBracketBtn");
  if (!bar) return;

  // 대진표가 아직 없으면 막대 자체를 숨긴다.
  const hasBracket = Array.isArray(finalMatches) && finalMatches.length > 0;
  bar.style.display = hasBracket ? "flex" : "none";
  bar.classList.toggle("is-pending", bracketPublishPending);

  if (msg) {
    msg.textContent = bracketPublishPending
      ? "공개하지 않은 변경/기록이 있습니다. 버튼을 눌러야 관객 화면에 반영됩니다."
      : "모든 변경사항이 관객 화면에 공개되어 있습니다.";
  }
  if (btn) {
    btn.disabled = !bracketPublishPending;
    btn.textContent = bracketPublishPending ? "관객 화면에 공개" : "공개 완료";
  }
}

/** "관객 화면에 공개" — 그동안 로컬에서만 조정/입력해 둔 대진·경기 기록을 한 번에 Firestore에
 * 반영해서 대시보드(관객 화면)에 실제로 공유한다. 6강·준결승·결승 등 매 라운드 결과를 입력한 뒤
 * 이 버튼을 눌러 그때그때 공개할 수 있다. */
async function handlePublishBracket() {
  if (!bracketPublishPending) return;
  try {
    // 대진표를 새로 생성했다면 경기 수/아이디 구성이 이전 공개분과 달라질 수 있으므로
    // (단순 덮어쓰기가 아니라) 더 이상 없는 경기는 지우고 전부 교체하는 publishFinalBracket을 쓴다.
    await publishFinalBracket(activeDivision, finalMatches);
    bracketPublishPending = false;
    updateBracketPublishBar();
    showToast(`${divisionLabel()} 대진표를 관객 화면에 공개했습니다`);
  } catch (err) {
    reportError("관객 화면 공개", err);
  }
}

/**
 * 부전승이 필요하지만(상대 없음) 아직 관리자가 배치하지 않은 1라운드 자리("미배정")를
 * 별도 목록으로 보여준다. 대진표에는 이 팀들이 아예 나타나지 않으므로(EMPTY 상태),
 * 여기서 "부전승으로 배치"를 눌러야만 대진표에 확정 대기(bye_pending) 카드로 나타난다.
 */
function renderByeUnassignedPanel() {
  const card = document.getElementById("byeUnassignedCard");
  const list = document.getElementById("byeUnassignedList");
  if (!card || !list) return;

  const unassigned = finalMatches
    .filter((m) => m.status === "empty" && m.byeCandidate)
    .sort((a, b) => a.index - b.index);

  card.style.display = unassigned.length ? "" : "none";
  list.innerHTML = "";

  unassigned.forEach((m) => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";
    row.style.padding = "6px 0";
    row.style.borderBottom = "1px solid var(--line)";
    row.innerHTML = `<span><b>${escapeHtml(m.byeCandidate.team.name)}</b>
      <span class="empty-hint" style="padding:0;">(${escapeHtml(m.roundLabel)} · 상대 없음)</span></span>`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small primary";
    btn.textContent = "부전승으로 배치";
    btn.addEventListener("click", () => handlePlaceByeTeam(m));
    row.appendChild(btn);

    list.appendChild(row);
  });
}

/** 미배정 부전승 후보를 실제로 대진표 자리에 배치한다(아직 다음 라운드 진출 확정은 아님).
 * 자리 배치는 결과가 아니라 위치 조정이므로, 곧바로 Firestore에 저장해 관객 화면에 공유하지
 * 않고 일단 로컬에만 반영해 둔다 — "관객 화면에 공개"를 눌러야 실제로 공유된다. */
async function handlePlaceByeTeam(match) {
  const result = placeByeTeam(finalMatches, match.id);
  if (!result.ok) {
    const msg = {
      NOT_FOUND: "해당 경기를 찾을 수 없습니다",
      NOT_EMPTY: "이미 배치되었거나 미배정 상태가 아닙니다",
    }[result.reason];
    if (msg) showToast(msg);
    return;
  }
  bracketPublishPending = true;
  renderFinalBracket();
  showToast("대진표에 부전승 대상으로 배치했습니다 (아직 공개 안 됨). '부전승 확정' 후 '관객 화면에 공개'를 눌러주세요.");
}

/** 확정 대기 중인 부전승을 관리자가 직접 확정해, 남은 팀을 다음 라운드로 올린다.
 * 이 역시 자리/진출 조정의 연장이므로 곧바로 공유하지 않고 로컬에만 반영한다. */
async function handleConfirmBye(match) {
  const result = confirmBye(finalMatches, match.id);
  if (!result.ok) {
    const msg = {
      NOT_FOUND: "해당 경기를 찾을 수 없습니다",
      NOT_BYE_PENDING: "확정 대기 중인 부전승 경기가 아닙니다",
    }[result.reason];
    if (msg) showToast(msg);
    return;
  }
  bracketPublishPending = true;
  renderFinalBracket();
  showToast("부전승을 확정했습니다 (아직 공개 안 됨). '관객 화면에 공개'를 눌러야 관객 화면에 반영됩니다.");
}

/** 대진표 카드에서 팀명을 드래그해 1라운드 두 자리를 서로 바꾼다 (경기 시작 전까지만 가능).
 * 드래그하는 동안마다 관객 화면에 바로 반영되면 "아직 정해지지 않은" 자리 이동을 결과로
 * 오해할 수 있으므로, 일단 로컬 화면에만 반영해 두고 "관객 화면에 공개"를 눌러야만
 * Firestore에 저장돼 대시보드에 공유된다. */
async function handleBracketSlotSwap(fromSlot, toSlot) {
  const result = swapFinalSeedSlots(finalMatches, fromSlot, toSlot);
  if (!result.ok) {
    const msg = {
      ROUND1_ONLY: "1라운드 경기만 대진을 바꿀 수 있습니다",
      UNASSIGNED_SLOT: "미배정 자리는 옮길 수 없습니다. '미배정 팀' 목록에서 먼저 배치하세요",
      ALREADY_STARTED: "이미 점수가 입력됐거나 부전승이 확정된 경기가 있어 대진을 바꿀 수 없습니다",
      EMPTY_MATCH: "두 자리를 바꾸면 한쪽 경기가 텅 비게 되어 적용할 수 없습니다",
    }[result.reason];
    if (msg) showToast(msg);
    return;
  }
  bracketPublishPending = true;
  renderFinalBracket();
}

function openFinalScoreModal(match) {
  openScoreModal({
    teamAName: match.teamA ? match.teamA.name : "",
    teamBName: match.teamB ? match.teamB.name : "",
    setLabels: ["1세트 (10점)", "2세트 (10점)", "3세트 (7점, 필요시만)"],
    targets: [10, 10, 7],
    existingSets: match.sets || [],
    onSave: async (sets) => {
      const reason = requiredReason("관리자 직접 수정");
      if (!reason) throw new Error("정정 사유는 필수입니다.");
      const matchKey = `final:${activeDivision}:${match.id}`;
      await adminWorkflowCallable("directEditOfficialScore", {
        matchKey,
        score: { sets },
        reason,
        expectedOfficialRevision: reviewWorkflows.get(matchKey)?.officialRevision || 0,
      });
      showToast("관리자 수정 점수를 승인했습니다.");
    },
  });
}

// ---------------- 모달 / 토스트 ----------------

function openScoreModal({ teamAName, teamBName, setLabels, targets, existingSets, onSave }) {
  const root = document.getElementById("modalRoot");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.innerHTML = `<h3>${escapeHtml(teamAName)} vs ${escapeHtml(teamBName)}</h3>`;

  const errorMsg = document.createElement("div");
  errorMsg.className = "modal-error-msg";
  box.appendChild(errorMsg);

  setLabels.forEach((label, i) => {
    const existing = existingSets[i] || { a: "", b: "" };
    const row = document.createElement("div");
    row.className = "set-input-row";
    row.innerHTML = `<label>${label}</label>
      <input type="number" min="0" max="15" data-side="a" data-idx="${i}" value="${existing.a === 0 ? 0 : existing.a || ""}" placeholder="${escapeHtml(teamAName)}" />
      :
      <input type="number" min="0" max="15" data-side="b" data-idx="${i}" value="${existing.b === 0 ? 0 : existing.b || ""}" placeholder="${escapeHtml(teamBName)}" />`;
    box.appendChild(row);
  });

  const actions = document.createElement("div");
  actions.className = "row";
  actions.style.justifyContent = "flex-end";
  actions.style.marginTop = "12px";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn ghost";
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", () => overlay.remove());
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn primary";
  saveBtn.textContent = "저장";
  saveBtn.addEventListener("click", async () => {
    const rawSets = setLabels.map((_, i) => {
      const a = box.querySelector(`input[data-side="a"][data-idx="${i}"]`).value;
      const b = box.querySelector(`input[data-side="b"][data-idx="${i}"]`).value;
      return { a: a === "" ? 0 : Number(a), b: b === "" ? 0 : Number(b) };
    });

    // 0:0(미입력)인 세트는 아직 진행 전이므로 검사하지 않고, 실제로 점수가 입력된
    // 세트만 경기규칙(상한 15점, 듀스 2점차)에 맞는지 확인한다.
    for (let i = 0; i < rawSets.length; i++) {
      const s = rawSets[i];
      if (s.a === 0 && s.b === 0) continue;
      const target = (targets && targets[i]) || 10;
      const result = validateSetScore(s.a, s.b, target);
      if (!result.ok) {
        errorMsg.textContent = `${setLabels[i]}: ${result.message}`;
        errorMsg.classList.add("show");
        return;
      }
    }
    errorMsg.classList.remove("show");

    const sets = rawSets.filter((s, i) => i < 2 || s.a > 0 || s.b > 0); // 3세트는 입력 없으면 제외
    saveBtn.disabled = true;
    try {
      await onSave(sets);
      overlay.remove();
    } catch (err) {
      saveBtn.disabled = false;
      reportError("점수 저장", err);
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  root.appendChild(overlay);
}

let toastTimer = null;
function showToast(msg, duration = 2200) {
  const el = document.getElementById("toastRoot");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

/** Firestore 등 비동기 작업 실패 시 화면에 원인을 보이게 표시 (콘솔에도 상세 로그) */
function reportError(action, err) {
  console.error(`[${action} 실패]`, err);
  const code = err && err.code ? ` (${err.code})` : "";
  showToast(`${action} 실패${code}: ${err && err.message ? err.message : err}`, 5000);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

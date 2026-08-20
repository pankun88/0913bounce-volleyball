import { isFirebaseConfigured } from "./firebase-init.js";
import { watchAuthState, login, logout, requestPasswordReset, changePassword, describeAuthError } from "./auth-service.js";
import {
  saveTournamentInfo, subscribeTournamentInfo,
  addGroup, deleteGroup, deleteAllGroups, subscribeGroups,
  addTeam, deleteTeam, updateTeam, deleteAllTeams, subscribeTeams,
  generatePrelimMatchesForGroup, updatePrelimMatchSets, subscribePrelimMatches, reorderPrelimMatches, clearAllPrelimMatches,
  setGroupMatchMode, setGroupRingOrder, clearPrelimMatchesForGroup, generateRingMatchesForGroup, resetAllRingOrders,
  publishFinalBracket, subscribeFinalMatches, clearFinalBracket,
  exportAllData, importAllData,
} from "./firestore-service.js";
import { evaluatePrelimMatch, evaluateFinalMatch, computeGroupStandings, validateSetScore } from "./match-logic.js";
import { recordMatchResult, buildCrossGroupSeedOrder, swapFinalSeedSlots, confirmBye, placeByeTeam, generateBracket } from "./bracket.js";
import { renderBracket } from "./bracket-render.js";
import { buildFullResultsCsv, downloadCsv } from "./csv-export.js";
import { normalizeRingOrder, getRingMatchPairs, renderRingDiagram } from "./ring-bracket.js";

// ---------------- 상태 ----------------
let tournamentInfo = {};
let groups = [];
let teams = [];
let prelimMatches = [];
let finalMatches = [];
let seedSelection = []; // 본선 진출팀 id 순서 (시드순)
let seedAutoMode = true; // true면 예선 순위 기준 추천 진출팀을 매 렌더마다 자동으로 채움 (체크박스/화살표를 직접 조작하면 false로 바뀜)
let pendingAutoSelectGroupName = null; // 방금 추가한 조 이름 — 팀 등록 select에 자동 선택용
let ringSelection = null; // 링크제 클릭배치 중 선택 상태: { type:'pool'|'vertex', teamId|index, groupId }
// 대진표 자리 드래그/부전승 배치는 누를 때마다 바로 관객 화면(대시보드)에 공개되면
// 관객이 "아직 정해지지 않은" 자리 이동을 결과로 오해할 수 있다. 그래서 이 조정들은
// 일단 화면(로컬)에서만 반영해두고, 관리자가 "관객 화면에 공개" 버튼을 눌러야만
// Firestore에 저장돼 대시보드에 실제로 공유된다.
let bracketPublishPending = false;

// 공개하지 않은 대진 조정이 남은 채로 탭을 닫거나 새로고침하면 그 조정은 그대로 사라지므로
// (다시 열면 Firestore에 저장된 마지막 공개 상태로 돌아감), 미리 경고한다.
window.addEventListener("beforeunload", (e) => {
  if (!bracketPublishPending) return;
  e.preventDefault();
  e.returnValue = "";
});

// ---------------- 부트스트랩 ----------------

if (!isFirebaseConfigured) {
  showToast("⚠️ firebase-config.js 에 Firebase 설정값을 입력해야 동기화가 동작합니다.", 6000);
}

initAuthGate();
initTabs();
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
    qualifyInput.value = tournamentInfo.qualifyPerGroup || 2;
  }
  const bracketTitle = document.getElementById("bracketTitle");
  if (bracketTitle) bracketTitle.textContent = (tournamentInfo.name || "바운스발리볼") + " 본선 대진표";
  renderFinalTeamPicker();
});

subscribeGroups((data) => {
  groups = data;
  renderGroupList();
  renderTeamGroupSelect();
  renderGroupTeamLists();
  renderPrelimGroups();
  renderFinalTeamPicker();
});

subscribeTeams((data) => {
  teams = data;
  document.getElementById("teamCount").textContent = teams.length;
  renderGroupTeamLists();
  renderPrelimGroups();
  renderFinalTeamPicker();
});

subscribePrelimMatches((data) => {
  prelimMatches = data;
  renderPrelimGroups();
  renderFinalTeamPicker(); // 예선 결과가 바뀌면 본선 진출팀 추천도 최신 순위를 따라가야 함
});

subscribeFinalMatches((data) => {
  finalMatches = data;
  renderFinalBracket();
  renderFinalTeamPicker(); // 대진표 생성/초기화 여부에 따라 진출팀 선택 UI도 함께 갱신
});

// ---------------- 연결 상태 감시 ----------------

function initConnectionWatch() {
  window.addEventListener("firestore-error", (e) => {
    const { label, err } = e.detail;
    setConnStatus(false);
    const code = err && err.code ? ` (${err.code})` : "";
    showErrorBanner(`⚠️ ${label} 실패${code}: ${err && err.message ? err.message : err}\nFirestore 보안 규칙이 게시되어 있는지 Firebase 콘솔에서 확인해주세요.`);
  });
  window.addEventListener("firestore-timeout", (e) => {
    setConnStatus(false);
    showErrorBanner(
      `⚠️ "${e.detail.label}" 실시간 연결이 응답하지 않습니다.\n` +
      `광고 차단/보안 확장 프로그램이 Firestore 실시간 연결을 막고 있을 수 있습니다 — 확장 프로그램을 끄거나 시크릿창에서 다시 열어보세요.\n` +
      `그래도 안 되면 다른 네트워크(예: 휴대폰 테더링)에서 시도해보세요.`
    );
  });
}

function setConnStatus(ok) {
  const el = document.getElementById("connStatus");
  if (!el) return;
  el.textContent = ok ? "동기화중" : "❌ 연결 오류";
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
    } else {
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
  box.innerHTML = `<h3>🔑 비밀번호 변경</h3>`;

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
      showToast("✅ 비밀번호가 변경되었습니다");
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

// ---------------- 대회설정: 대회명 ----------------

function bindStaticHandlers() {
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
      await saveTournamentInfo({ qualifyPerGroup });
      seedAutoMode = true; // 진출 팀 수 설정을 바꿨으니 추천 진출팀을 다시 계산해서 보여준다
      showToast("저장되었습니다");
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
    if (!confirm("등록된 모든 조를 삭제할까요? 소속 팀은 모두 미배정 상태가 되고, 해당 조의 예선 대진/결과도 함께 삭제됩니다.")) return;
    try {
      await deleteAllGroups();
      showToast("조를 모두 초기화했습니다");
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
    if (!confirm("등록된 모든 팀을 삭제할까요? 예선·본선 경기 기록도 함께 삭제됩니다.")) return;
    try {
      await deleteAllTeams();
      showToast("팀을 모두 초기화했습니다");
    } catch (err) {
      reportError("팀 초기화", err);
    }
  });

  document.getElementById("resetPrelimBtn").addEventListener("click", async () => {
    const hasRingPlacement = groups.some((g) => (g.ringOrder || []).some(Boolean));
    if (!prelimMatches.length && !hasRingPlacement) return showToast("초기화할 예선 경기가 없습니다");
    if (!confirm("모든 조의 예선 대진과 결과, 도형(링크제) 배치를 모두 초기화할까요?")) return;
    try {
      await clearAllPrelimMatches();
      await resetAllRingOrders();
      ringSelection = null;
      showToast("예선을 초기화했습니다");
    } catch (err) {
      reportError("예선 초기화", err);
    }
  });

  document.getElementById("generateBracketBtn").addEventListener("click", onGenerateBracket);
  document.getElementById("publishBracketBtn").addEventListener("click", handlePublishBracket);
  document.getElementById("clearBracketBtn").addEventListener("click", async () => {
    if (!confirm("본선 대진표를 초기화할까요? 입력된 점수도 모두 사라집니다.")) return;
    try {
      await clearFinalBracket();
      bracketPublishPending = false;
      showToast("대진표를 초기화했습니다");
    } catch (err) {
      reportError("대진표 초기화", err);
    }
  });

  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    const csv = buildFullResultsCsv({
      tournamentName: tournamentInfo.name,
      groups, teams, prelimMatches, finalMatches,
    });
    const fname = `${(tournamentInfo.name || "바운스발리볼").replace(/\s+/g, "_")}_결과_${dateStamp()}.csv`;
    downloadCsv(fname, csv);
  });

  // 데이터 백업/복원 — 다음 학기에 이어서 쓰거나, 실수로 초기화했을 때 되돌리기 위함
  document.getElementById("backupBtn").addEventListener("click", handleBackup);
  document.getElementById("restoreBtn").addEventListener("click", () => {
    document.getElementById("restoreFileInput").click();
  });
  document.getElementById("restoreFileInput").addEventListener("change", handleRestoreFile);
}

/** 현재 전체 데이터를 JSON 파일 하나로 저장(되돌릴 수 있는 백업) */
async function handleBackup() {
  try {
    const data = await exportAllData();
    const fname = `${(tournamentInfo.name || "바운스발리볼").replace(/\s+/g, "_")}_백업_${dateStamp()}.json`;
    downloadJson(fname, JSON.stringify(data, null, 2));
    showToast("백업 파일을 저장했습니다");
  } catch (err) {
    reportError("백업", err);
  }
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

/** 조 추가 — 성공하면 방금 만든 조 이름을 기억해서 팀 등록 select에 자동으로 선택되게 한다 */
async function addGroupFromForm() {
  const input = document.getElementById("groupNameInput");
  const name = input.value.trim();
  if (!name) return showToast("조 이름을 입력하세요");
  try {
    await addGroup(name);
    input.value = "";
    pendingAutoSelectGroupName = name;
    input.focus();
  } catch (err) {
    reportError("조 추가", err);
  }
}

/** 팀 추가 — 조를 먼저 선택해야만 추가할 수 있다 (미배정 팀이 새로 생기지 않도록).
 *  추가 후에도 선택된 조는 그대로 유지하고 입력칸에 다시 포커스해서 연속 입력이 쉽게 한다 */
async function addTeamFromForm() {
  const nameInput = document.getElementById("teamNameInput");
  const groupSelect = document.getElementById("teamGroupSelect");
  if (!groupSelect.value) return showToast("먼저 조를 선택하세요");
  const name = nameInput.value.trim();
  if (!name) return showToast("팀 이름을 입력하세요");
  try {
    await addTeam(name, groupSelect.value);
    nameInput.value = "";
    nameInput.focus();
  } catch (err) {
    reportError("팀 추가", err);
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
    pill.className = "team-pill";
    pill.innerHTML = `${escapeHtml(g.name)} <button title="삭제">✕</button>`;
    pill.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`'${g.name}' 조를 삭제할까요? (소속 팀은 무소속이 됩니다)`)) return;
      try {
        await deleteGroup(g.id);
      } catch (err) {
        reportError("조 삭제", err);
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
      groupTeams.forEach((t) => list.appendChild(createTeamPill(t)));
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
    noGroupTeams.forEach((t) => list.appendChild(createTeamPill(t)));
    attachDropZone(list, null);
    box.appendChild(list);
    el.appendChild(box);
  }
}

/** 팀 하나를 드래그 가능한 pill로 만든다 (✕ 버튼으로 삭제, 드래그로 다른 조에 이동) */
function createTeamPill(t) {
  const pill = document.createElement("span");
  pill.className = "team-pill";
  pill.draggable = true;
  pill.innerHTML = `${escapeHtml(t.name)} <button title="삭제">✕</button>`;
  pill.querySelector("button").addEventListener("click", async () => {
    if (!confirm(`'${t.name}' 팀을 삭제할까요?`)) return;
    try {
      await deleteTeam(t.id);
    } catch (err) {
      reportError("팀 삭제", err);
    }
  });
  pill.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", t.id);
    e.dataTransfer.effectAllowed = "move";
    pill.classList.add("dragging");
  });
  pill.addEventListener("dragend", () => {
    pill.classList.remove("dragging");
  });
  return pill;
}

/** 조 박스(또는 미배정 박스)를 드롭 영역으로 만든다. targetGroupId가 null이면 미배정으로 이동시킨다. */
function attachDropZone(list, targetGroupId) {
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    list.classList.add("drag-over");
  });
  list.addEventListener("dragleave", () => {
    list.classList.remove("drag-over");
  });
  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    list.classList.remove("drag-over");
    const teamId = e.dataTransfer.getData("text/plain");
    if (!teamId) return;
    try {
      await updateTeam(teamId, { groupId: targetGroupId });
    } catch (err) {
      reportError("팀 조 이동", err);
    }
  });
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
  return confirm(message || `'${groupName}'의 기존 경기 결과가 초기화됩니다. 계속할까요?`);
}

/** 한 조의 예선 대진/결과와 링크제 도형 배치를 모두 초기화한다 (조별 '초기화' 버튼용) */
async function handleResetGroupPrelim(group) {
  const hasMatches = groupHasPrelimMatches(group.id);
  const hasRingPlacement = (group.ringOrder || []).some(Boolean);
  if (!hasMatches && !hasRingPlacement) return showToast(`${group.name}에 초기화할 내용이 없습니다`);
  if (!confirm(`'${group.name}'의 예선 대진과 결과, 도형(링크제) 배치를 모두 초기화할까요?`)) return;
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
    renderPrelimGroups(); // 취소 시에도 선택 상태가 이미 풀렸으므로 화면을 다시 그려 정리한다
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
      renderPrelimGroups();
    }
    return;
  }
  // 이미 선택된 꼭짓점을 다시 클릭 -> 선택 취소
  if (ringSelection.type === "vertex" && ringSelection.index === index) {
    ringSelection = null;
    renderPrelimGroups();
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
  renderPrelimGroups();
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
    ? "✅ 대진이 확정되었습니다. 다시 배치하면 결과가 초기화됩니다."
    : `팀을 도형의 꼭짓점으로 드래그하거나, 팀을 클릭한 뒤 꼭짓점을 클릭하세요 (${placedCount}/${ringOrder.length} 배치됨)`;
  const shuffleBtn = document.createElement("button");
  shuffleBtn.className = "btn small ghost";
  shuffleBtn.textContent = "🎲 무작위 배치";
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
  } catch (err) {
    reportError("경기 순서 변경", err);
  }
}

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
    heading.innerHTML = `📋 ${escapeHtml(g.name)} 예선`;
    const resetGroupBtn = document.createElement("button");
    resetGroupBtn.type = "button";
    resetGroupBtn.className = "btn danger small";
    resetGroupBtn.style.marginLeft = "auto";
    resetGroupBtn.title = `${g.name}의 예선 대진과 결과, 도형(링크제) 배치를 모두 삭제합니다`;
    resetGroupBtn.textContent = "초기화";
    resetGroupBtn.addEventListener("click", () => handleResetGroupPrelim(g));
    heading.appendChild(resetGroupBtn);
    card.appendChild(heading);

    // 방식 토글
    const modeRow = document.createElement("div");
    modeRow.className = "row";
    modeRow.style.marginBottom = "12px";
    modeRow.innerHTML = `<span class="mode-toggle">
      <button type="button" class="mode-btn ${mode === "ring" ? "active" : ""}" data-mode="ring">링크제</button>
      <button type="button" class="mode-btn ${mode === "roundrobin" ? "active" : ""}" data-mode="roundrobin">라운드로빈</button>
    </span>`;
    modeRow.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => handleSetMatchMode(g, btn.dataset.mode));
    });
    card.appendChild(modeRow);

    if (groupTeams.length < 2) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "이 조에 팀이 2팀 이상 등록되면 대진을 만들 수 있습니다.";
      card.appendChild(hint);
    } else if (mode === "ring") {
      card.appendChild(buildRingControls(g, groupTeams));
    } else {
      card.appendChild(buildRoundRobinControls(g, groupTeams));
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
      matchList.innerHTML = '<div class="empty-hint">생성된 경기가 없습니다. 위에서 대진을 생성하세요.</div>';
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
        const resultBadge = evald.result === "A" ? `<span class="badge win">${teamName(m.teamA)} 승</span>`
          : evald.result === "B" ? `<span class="badge win">${teamName(m.teamB)} 승</span>`
          : evald.result === "draw" ? '<span class="badge draw">무승부</span>'
          : evald.status === "in_progress" ? '<span class="badge">경기중</span>'
          : '<span class="badge">경기전</span>';
        const left = document.createElement("span");
        left.innerHTML = `<span class="match-order-badge">${idx + 1}</span>${escapeHtml(teamName(m.teamA))} <b>vs</b> ${escapeHtml(teamName(m.teamB))} <span style="color:var(--muted); font-size:12px;">${scoreText}</span>`;
        row.appendChild(left);
        const right = document.createElement("span");
        right.className = "row";
        right.innerHTML = resultBadge;
        const editBtn = document.createElement("button");
        editBtn.className = "btn small";
        editBtn.textContent = evald.status === "done" ? "점수 수정" : "점수 입력";
        editBtn.addEventListener("click", () => openPrelimScoreModal(m));
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
      await updatePrelimMatchSets(match.id, sets);
      showToast("저장되었습니다");
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
  const n = Math.max(1, Number(tournamentInfo.qualifyPerGroup) || 2);
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
  if (!confirm(`${seedSelection.length}팀으로 본선 대진표를 생성할까요? 기존 대진표는 초기화됩니다.`)) return;
  const teamsInSeedOrder = seedSelection.map((id) => ({ id, name: teamName(id) }));
  const { matches } = generateBracket(teamsInSeedOrder);
  finalMatches = matches;
  bracketPublishPending = true;
  renderFinalBracket();
  renderFinalTeamPicker();
  showToast("본선 대진표를 생성했습니다 (아직 공개 안 됨). 부전승 배치·자리 조정까지 마친 뒤 '관객 화면에 공개'를 눌러주세요.");
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
      ? "⚠️ 공개하지 않은 변경/기록이 있습니다. 버튼을 눌러야 관객 화면에 반영됩니다."
      : "✅ 모든 변경사항이 관객 화면에 공개되어 있습니다.";
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
    await publishFinalBracket(finalMatches);
    bracketPublishPending = false;
    updateBracketPublishBar();
    showToast("관객 화면에 공개했습니다");
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
      // 경기 기록도 곧바로 관객 화면에 반영하지 않고 로컬에만 저장해 둔다. 관리자가 매 라운드
      // 결과를 입력한 뒤 "관객 화면에 공개" 버튼을 눌러야 그때 대시보드에 반영된다.
      recordMatchResult(finalMatches, match.id, sets, evaluateFinalMatch);
      bracketPublishPending = true;
      renderFinalBracket();
      showToast("기록을 저장했습니다 (아직 공개 안 됨). '관객 화면에 공개'를 눌러주세요.");
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
  showToast(`❌ ${action} 실패${code}: ${err && err.message ? err.message : err}`, 5000);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

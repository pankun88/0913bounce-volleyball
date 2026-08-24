import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { TOURNAMENT_ID, describeRecorderAuthError, exchangeRecorderAccessCode, loginWithGoogle, logoutRecorder, watchRecorderAuthState } from "./recorder-auth-service.js";
import { cancelDraft, claimCurrentMatch, saveDraft, submitDraft, subscribeAssignment, subscribeCourt, subscribeWorkflow } from "./workflow-service.js";
import { evaluateFinalMatch, evaluatePrelimMatch, finalNeedsThirdSet, validateSetScore } from "./match-logic.js";
import { courtMatchSummary, courtTeamNames, formatCourtName } from "./court-display.js";

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(["logoutButton", "connectionStatus", "authPanel", "authMessage", "identity", "googleLoginButton", "accessCodeForm", "accessCode", "accessCodeButton", "courtPanel", "courtSelect", "courtMessage", "workflowPanel", "matchSummary", "rejectionNotice", "lockNotice", "claimButton", "scoreForm", "scoreFields", "scoreLegend", "scoreError", "saveButton", "reviewButton", "cancelButton", "confirmPanel", "confirmScore", "backToEditButton", "submitButton"].map((id) => [id, $(id)]));

let courts = [];
let selectedCourtId = "";
let selectedRecorderName = "";
let queue = null;
let assignment = null;
let workflow = null;
let activeMatchKey = null;
let editToken = null;
let busy = false;
let stopCourts = () => {};
let stopCourt = () => {};
let stopQueue = () => {};
let stopAssignment = () => {};
let stopWorkflow = () => {};
let stopOfficialMatch = () => {};
let stopTeams = () => {};
let stopGroups = () => {};
let officialMatch = null;
let officialMatchKey = "";
let officialMatchState = "idle";
let teamsById = new Map();
let groupsById = new Map();

function setStatus(text) { ui.connectionStatus.textContent = text; }
function setBusy(next) {
  busy = next;
  [ui.googleLoginButton, ui.accessCodeButton, ui.claimButton, ui.saveButton, ui.reviewButton, ui.cancelButton, ui.backToEditButton, ui.submitButton].forEach((element) => { if (element) element.disabled = next; });
  ui.courtSelect.disabled = next || Boolean(editToken);
}
function stopMatchSubscriptions() { stopAssignment(); stopWorkflow(); stopOfficialMatch(); stopAssignment = () => {}; stopWorkflow = () => {}; stopOfficialMatch = () => {}; activeMatchKey = null; assignment = null; workflow = null; officialMatch = null; officialMatchKey = ""; officialMatchState = "idle"; }
function stopCourtSubscriptions() { stopCourt(); stopQueue(); stopCourt = () => {}; stopQueue = () => {}; stopMatchSubscriptions(); queue = null; }
function resetPrivateSession() { stopCourts(); stopTeams(); stopGroups(); stopCourts = () => {}; stopTeams = () => {}; stopGroups = () => {}; teamsById = new Map(); groupsById = new Map(); stopCourtSubscriptions(); courts = []; selectedCourtId = ""; selectedRecorderName = ""; editToken = null; ui.courtSelect.replaceChildren(new Option("이름을 선택하세요", "")); ui.workflowPanel.hidden = true; ui.courtPanel.hidden = true; ui.confirmPanel.hidden = true; }
function describeError(error) {
  const code = error?.code || "";
  if (code.includes("permission-denied") || code.includes("unauthenticated")) return "권한이 없거나 권한이 만료되었습니다.";
  if (code.includes("unavailable") || !navigator.onLine) return "오프라인 상태입니다. 인터넷 연결 후 다시 시도하세요.";
  if (/현재 경기|편집 권한|다른 기록관/.test(error?.message || "")) return "다른 기록관이 먼저 처리했거나 경기 상태가 바뀌었습니다.";
  return error?.message || "처리 중 오류가 발생했습니다.";
}
function isFinal() { return assignment?.matchType === "final" || assignment?.matchType === "tournament" || assignment?.phase === "final" || assignment?.phase === "finals"; }
function teamName(side) {
  const names = courtTeamNames(officialMatch, teamsById);
  return names ? names[side] : (side === "a" ? "A팀" : "B팀");
}
function courtDisplayName(court) { return formatCourtName(court, "이름 없는 코트"); }
function recorderName(court) { return typeof court?.recorderName === "string" ? court.recorderName.trim() : ""; }
function scoreFromForm() { return [...ui.scoreFields.querySelectorAll(".score-row")].map((row) => ({ a: Number(row.querySelector('[name$="-a"]').value), b: Number(row.querySelector('[name$="-b"]').value) })); }
function validateScore(forSubmit) {
  const sets = scoreFromForm();
  const targets = isFinal() ? [10, 10, 7] : [10, 10];
  for (let i = 0; i < targets.length; i += 1) {
    const result = validateSetScore(sets[i].a, sets[i].b, targets[i]);
    if (!result.ok) return { ok: false, message: `${i + 1}세트: ${result.message}` };
  }
  if (!forSubmit) return { ok: true, score: { sets } };
  const evaluation = isFinal() ? evaluateFinalMatch(sets) : evaluatePrelimMatch(sets);
  if (evaluation.status !== "done") return { ok: false, message: "끝난 경기의 모든 필요한 세트 점수를 입력하세요." };
  if (isFinal() && !finalNeedsThirdSet(sets) && (sets[2].a !== 0 || sets[2].b !== 0)) return { ok: false, message: "2세트로 승부가 끝난 경우 3세트는 0:0으로 두세요." };
  return { ok: true, score: { sets } };
}
function renderScoreForm() {
  if (officialMatchState !== "ready" || !workflow || workflow.draftState !== "editing" || !editToken) { ui.scoreForm.hidden = true; return; }
  const existing = workflow.draft?.sets || [];
  ui.scoreLegend.textContent = `${teamName("a")} vs ${teamName("b")} 점수`;
  ui.scoreFields.replaceChildren(ui.scoreLegend);
  const targets = isFinal() ? [10, 10, 7] : [10, 10];
  targets.forEach((target, index) => {
    const row = document.createElement("div"); row.className = "score-row";
    const label = document.createElement("label"); label.htmlFor = `set-${index}-a`; label.textContent = `${index + 1}세트 · ${target}점`;
    const a = document.createElement("input"); a.id = `set-${index}-a`; a.name = `set-${index}-a`; a.type = "number"; a.min = "0"; a.max = "15"; a.inputMode = "numeric"; a.value = existing[index]?.a ?? 0; a.setAttribute("aria-label", `${index + 1}세트 ${teamName("a")} 점수`);
    const colon = document.createElement("span"); colon.textContent = ":";
    const b = document.createElement("input"); b.id = `set-${index}-b`; b.name = `set-${index}-b`; b.type = "number"; b.min = "0"; b.max = "15"; b.inputMode = "numeric"; b.value = existing[index]?.b ?? 0; b.setAttribute("aria-label", `${index + 1}세트 ${teamName("b")} 점수`);
    const aEntry = document.createElement("div"); aEntry.className = "score-entry";
    const aName = document.createElement("span"); aName.textContent = teamName("a");
    aEntry.append(aName, a);
    const bEntry = document.createElement("div"); bEntry.className = "score-entry";
    const bName = document.createElement("span"); bName.textContent = teamName("b");
    bEntry.append(bName, b);
    if (isFinal() && index === 2 && !finalNeedsThirdSet(existing)) { a.disabled = true; b.disabled = true; }
    row.append(label, aEntry, colon, bEntry); ui.scoreFields.append(row);
  });
  if (isFinal()) {
    const updateThirdSet = () => {
      const thirdInputs = ui.scoreFields.querySelectorAll('.score-row:nth-of-type(3) input');
      const enabled = finalNeedsThirdSet(scoreFromForm());
      thirdInputs.forEach((input) => {
        input.disabled = !enabled;
        if (!enabled) input.value = 0;
      });
    };
    ui.scoreFields.querySelectorAll('.score-row:nth-of-type(-n+2) input').forEach((input) => input.addEventListener("input", updateThirdSet));
  }
  ui.scoreForm.hidden = false;
}

function renderMatchSummary(view) {
  const names = courtTeamNames(officialMatch, teamsById);
  const court = courts.find((item) => item.id === selectedCourtId);
  ui.matchSummary.replaceChildren();
  const meta = document.createElement("div");
  meta.className = "match-meta";
  [view.label, courtDisplayName(court)].filter(Boolean).forEach((text) => {
    const badge = document.createElement("span");
    badge.textContent = text;
    meta.appendChild(badge);
  });
  const matchup = document.createElement("div");
  matchup.className = "matchup";
  const teamA = document.createElement("strong"); teamA.textContent = names?.a || "대진 미정";
  const versus = document.createElement("span"); versus.textContent = "VS";
  const teamB = document.createElement("strong"); teamB.textContent = names?.b || "대진 미정";
  matchup.append(teamA, versus, teamB);
  ui.matchSummary.append(meta, matchup);
  if (queue?.nextMatchKey) {
    const next = document.createElement("p");
    next.className = "next-match-note";
    next.textContent = "다음 경기가 이 코트에서 대기 중입니다.";
    ui.matchSummary.appendChild(next);
  }
}

function renderConfirmScore(score) {
  ui.confirmScore.replaceChildren();
  const teams = document.createElement("div");
  teams.className = "confirm-teams";
  const teamA = document.createElement("strong"); teamA.textContent = teamName("a");
  const versus = document.createElement("span"); versus.textContent = "VS";
  const teamB = document.createElement("strong"); teamB.textContent = teamName("b");
  teams.append(teamA, versus, teamB);
  const sets = document.createElement("div");
  sets.className = "confirm-sets";
  score.sets.forEach((set, index) => {
    const row = document.createElement("div");
    row.className = "confirm-set-row";
    row.innerHTML = `<span>${index + 1}세트</span><strong>${set.a}</strong><b>:</b><strong>${set.b}</strong>`;
    sets.appendChild(row);
  });
  ui.confirmScore.append(teams, sets);
}

function renderWorkflow() {
  ui.confirmPanel.hidden = true;
  const currentMatchKey = queue?.currentMatchKey || (editToken ? activeMatchKey : null);
  if (!currentMatchKey) { ui.matchSummary.textContent = "현재 대기 중인 경기가 없습니다."; ui.claimButton.hidden = true; ui.scoreForm.hidden = true; return; }
  if (activeMatchKey !== currentMatchKey) return;
  if (officialMatchState !== "ready") {
    ui.matchSummary.textContent = officialMatchState === "error"
      ? "공식 경기 정보를 불러오지 못했습니다. 관리자에게 문의하세요."
      : "공식 경기 정보를 불러오는 중입니다.";
    ui.claimButton.hidden = true;
    ui.scoreForm.hidden = true;
    return;
  }
  const view = courtMatchSummary(assignment, officialMatch, { teamsById, groupsById });
  renderMatchSummary(view);
  const rejected = workflow?.draftState === "rejected";
  const reason = workflow?.rejectionReason || workflow?.reviewReason || workflow?.rejectedReason;
  ui.rejectionNotice.hidden = !rejected; ui.rejectionNotice.textContent = rejected ? `반려됨${reason ? `: ${reason}` : ". 점수를 수정해 다시 제출하세요."}` : "";
  const lockedByOther = assignment?.publicStatus === "in_progress"
    && (!workflow || workflow?.draftState !== "editing" || workflow?.lock?.token !== editToken);
  ui.lockNotice.hidden = !lockedByOther; ui.lockNotice.textContent = lockedByOther ? "다른 기록관이 이 경기를 입력 중입니다." : "";
  ui.claimButton.hidden = !(workflow && ["idle", "rejected"].includes(workflow.draftState) && !workflow.lock);
  renderScoreForm();
}
/** 배정은 경기 참조만 가지므로 팀이름·경기명은 공식 경기 문서에서 읽는다. */
function attachOfficialMatch(current) {
  const isFinalMatch = current?.matchType === "final";
  const divisionId = current?.divisionId || current?.division || "";
  const usable = Boolean(current?.matchId) && (!isFinalMatch || Boolean(divisionId));
  const key = usable ? `${current.matchType}:${divisionId}:${current.matchId}` : "";
  if (key === officialMatchKey) return;
  stopOfficialMatch(); stopOfficialMatch = () => {}; officialMatch = null; officialMatchKey = key;
  officialMatchState = key ? "loading" : "error";
  if (!key) { renderWorkflow(); return; }
  renderWorkflow();
  const ref = isFinalMatch
    ? doc(db, "tournaments", TOURNAMENT_ID, "divisions", divisionId, "finalMatches", current.matchId)
    : doc(db, "tournaments", TOURNAMENT_ID, "prelimMatches", current.matchId);
  stopOfficialMatch = onSnapshot(ref, (snapshot) => {
    officialMatch = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
    officialMatchState = snapshot.exists() ? "ready" : "error";
    renderWorkflow();
  }, (error) => {
    officialMatch = null;
    officialMatchState = "error";
    setStatus(describeError(error));
    renderWorkflow();
  });
}
function attachMatch(matchKey) {
  stopMatchSubscriptions(); activeMatchKey = matchKey;
  stopAssignment = subscribeAssignment(matchKey, (value) => {
    const movedCourtId = value?.courtId;
    assignment = value;
    if (editToken && value && movedCourtId !== selectedCourtId) followMovedAssignment(movedCourtId);
    attachOfficialMatch(value);
    renderWorkflow();
  }, (error) => { setStatus(describeError(error)); });
  stopWorkflow = subscribeWorkflow(matchKey, (value) => { workflow = value; if (value?.draftState !== "editing" || value?.lock?.token !== editToken) editToken = value?.lock?.token === editToken ? editToken : null; ui.courtSelect.disabled = busy || Boolean(editToken); renderWorkflow(); }, (error) => { workflow = null; renderWorkflow(); if (!assignment || assignment.publicStatus !== "in_progress") setStatus(describeError(error)); });
}
function subscribeQueue(courtId) {
  stopQueue(); stopQueue = () => {}; queue = null;
  stopQueue = onSnapshot(doc(db, "tournaments", TOURNAMENT_ID, "courtQueues", courtId), (snapshot) => {
    const nextQueue = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
    if (editToken && assignment?.courtId && assignment.courtId !== courtId) return;
    queue = nextQueue;
    if (queue?.currentMatchKey) {
      if (activeMatchKey !== queue.currentMatchKey) attachMatch(queue.currentMatchKey);
      else renderWorkflow();
    } else if (!editToken || assignment?.courtId === courtId) { stopMatchSubscriptions(); renderWorkflow(); }
    else renderWorkflow();
  }, (error) => { queue = null; setStatus(describeError(error)); renderWorkflow(); });
}
function followMovedAssignment(courtId) {
  selectedCourtId = courtId;
  stopCourt(); stopCourt = () => {};
  if (!courtId) {
    stopQueue(); stopQueue = () => {}; queue = null;
    ui.courtSelect.value = "";
    ui.courtMessage.textContent = "경기가 미배정으로 이동되었습니다. 현재 입력은 계속할 수 있습니다.";
    renderWorkflow();
    return;
  }
  stopCourt = subscribeCourt(courtId, (court) => {
    ui.courtMessage.textContent = court ? `경기가 ${courtDisplayName(court)}으로 이동되었습니다. 입력을 계속하세요.` : "배정된 코트 정보를 찾을 수 없습니다.";
  }, (error) => { setStatus(describeError(error)); });
  subscribeQueue(courtId);
}
function attachCourt(courtId) {
  stopCourtSubscriptions(); selectedCourtId = courtId; ui.workflowPanel.hidden = !courtId;
  if (!courtId) return;
  stopCourt = subscribeCourt(courtId, (court) => { ui.courtMessage.textContent = court ? `${courtDisplayName(court)} 선택됨` : "코트 정보를 찾을 수 없습니다."; }, (error) => { setStatus(describeError(error)); });
  subscribeQueue(courtId);
}
function startReadySubscriptions() {
  stopTeams(); stopGroups();
  stopTeams = onSnapshot(collection(db, "tournaments", TOURNAMENT_ID, "teams"), (snapshot) => {
    teamsById = new Map(snapshot.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
    renderWorkflow();
  }, (error) => { setStatus(describeError(error)); });
  stopGroups = onSnapshot(collection(db, "tournaments", TOURNAMENT_ID, "groups"), (snapshot) => {
    groupsById = new Map(snapshot.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
    renderWorkflow();
  }, (error) => { setStatus(describeError(error)); });
  stopCourts();
  stopCourts = onSnapshot(collection(db, "tournaments", TOURNAMENT_ID, "courts"), (snapshot) => {
    // 관리자가 코트 설정에서 만든 순서(order)를 그대로 따른다. order가 같을 때만 이름으로 가른다.
    courts = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)
        || String(a.name || a.id).localeCompare(String(b.name || b.id), "ko"));
    const namedCourts = courts.filter((court) => recorderName(court) || (editToken && court.id === selectedCourtId));
    ui.courtSelect.replaceChildren(new Option("이름을 선택하세요", ""), ...namedCourts.map((court) => {
      const displayRecorder = editToken && court.id === selectedCourtId ? selectedRecorderName : recorderName(court);
      return new Option(`${displayRecorder} (${courtDisplayName(court)})`, court.id);
    }));
    ui.courtSelect.value = selectedCourtId;
    if (!selectedCourtId) ui.courtMessage.textContent = namedCourts.length ? "기록관 이름을 선택하세요." : "배정된 기록관이 없습니다.";
  }, (error) => { setStatus(describeError(error)); });
}

watchRecorderAuthState((state) => {
  ui.logoutButton.hidden = !state.user; ui.identity.hidden = !state.user; ui.identity.textContent = state.user ? (state.user.displayName || "기록관") : "";
  ui.authPanel.hidden = Boolean(state.ready);
  if (!state.user) { ui.authPanel.hidden = false; resetPrivateSession(); ui.googleLoginButton.hidden = false; ui.accessCodeForm.hidden = true; ui.authMessage.textContent = "Google 로그인 후 대회 공용 코드를 입력하세요."; return; }
  ui.googleLoginButton.hidden = true;
  if (!state.ready) { ui.authPanel.hidden = false; resetPrivateSession(); ui.accessCodeForm.hidden = false; ui.authMessage.textContent = "권한 대기 중입니다. 공용 코드를 확인하거나 대회 점검·권한 폐기 여부를 관리자에게 문의하세요."; return; }
  ui.accessCodeForm.hidden = true; ui.authMessage.textContent = "기록관 권한이 확인되었습니다."; ui.courtPanel.hidden = false; startReadySubscriptions();
});

window.addEventListener("online", () => setStatus("온라인 상태입니다."));
window.addEventListener("offline", () => setStatus("오프라인 상태입니다. 저장과 제출은 연결 후 다시 시도하세요."));
ui.googleLoginButton.addEventListener("click", async () => { setBusy(true); try { await loginWithGoogle(); } catch (error) { ui.authMessage.textContent = describeRecorderAuthError(error); } finally { setBusy(false); } });
ui.accessCodeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  ui.authMessage.textContent = "접근 코드를 확인하고 있습니다…";
  try {
    await exchangeRecorderAccessCode(ui.accessCode.value);
    ui.accessCode.value = "";
    ui.authMessage.textContent = "접근 코드가 확인되었습니다. 기록관 권한을 불러오는 중입니다…";
  } catch (error) {
    ui.authMessage.textContent = describeRecorderAuthError(error);
  } finally {
    setBusy(false);
  }
});
ui.logoutButton.addEventListener("click", async () => { setBusy(true); try { await logoutRecorder(); } catch (error) { ui.authMessage.textContent = describeRecorderAuthError(error); } finally { setBusy(false); } });
ui.courtSelect.addEventListener("change", () => {
  const court = courts.find((item) => item.id === ui.courtSelect.value);
  selectedRecorderName = recorderName(court);
  attachCourt(ui.courtSelect.value);
});
ui.claimButton.addEventListener("click", async () => { if (!queue?.currentMatchKey || !selectedCourtId || !selectedRecorderName || busy) return; setBusy(true); try { const result = await claimCurrentMatch({ matchKey: queue.currentMatchKey, courtId: selectedCourtId, queueRevision: queue.queueRevision, recorderName: selectedRecorderName }); editToken = result.token; setStatus("배정이 완료되었습니다. 경기 입력을 시작했습니다."); } catch (error) { setStatus(describeError(error)); } finally { setBusy(false); } });
ui.scoreForm.addEventListener("submit", async (event) => { event.preventDefault(); if (busy) return; const check = validateScore(false); ui.scoreError.textContent = check.ok ? "" : check.message; if (!check.ok) return; setBusy(true); try { await saveDraft({ matchKey: activeMatchKey, token: editToken, score: check.score }); setStatus("임시 저장되었습니다."); } catch (error) { ui.scoreError.textContent = describeError(error); } finally { setBusy(false); } });
ui.reviewButton.addEventListener("click", () => { const check = validateScore(true); ui.scoreError.textContent = check.ok ? "" : check.message; if (!check.ok) return; renderConfirmScore(check.score); ui.confirmPanel.hidden = false; ui.confirmPanel.scrollIntoView({ behavior: "smooth", block: "nearest" }); });
ui.backToEditButton.addEventListener("click", () => { ui.confirmPanel.hidden = true; });
ui.submitButton.addEventListener("click", async () => { if (busy) return; const check = validateScore(true); if (!check.ok) { ui.confirmPanel.hidden = true; ui.scoreError.textContent = check.message; return; } setBusy(true); try { await submitDraft({ matchKey: activeMatchKey, courtId: selectedCourtId, token: editToken, queueRevision: queue?.queueRevision, score: check.score }); editToken = null; selectedRecorderName = ""; ui.confirmPanel.hidden = true; attachCourt(""); ui.courtSelect.value = ""; setStatus("제출되었습니다. 관리자가 [기록·검수]에서 승인하면 공식 예선 결과와 순위에 반영됩니다. 다음 경기는 기록관 이름을 새로 선택하세요."); } catch (error) { ui.scoreError.textContent = describeError(error); ui.confirmPanel.hidden = true; } finally { setBusy(false); } });
ui.cancelButton.addEventListener("click", async () => { if (busy) return; setBusy(true); try { await cancelDraft({ matchKey: activeMatchKey, courtId: selectedCourtId, token: editToken, queueRevision: queue?.queueRevision }); editToken = null; setStatus("입력을 취소했습니다."); } catch (error) { ui.scoreError.textContent = describeError(error); } finally { setBusy(false); } });

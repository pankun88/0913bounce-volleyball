import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";
import { describeRecorderAuthError, exchangeRecorderAccessCode, loginWithGoogle, logoutRecorder, watchRecorderAuthState } from "./recorder-auth-service.js";
import { TOURNAMENT_ID } from "./firebase-config.js";
import {
  canResumeCurrentMatch, claimRecorderDraft, recorderReason, resumeRecorderDraft, saveRecorderDraft,
  submitRecorderDraft, cancelRecorderDraft, operationId, recorderSessionId, rotateRecorderSessionId,
  reconcileRecorderCourtQueue, startLeaseHeartbeat, subscribeAssignment, subscribeCourt, subscribeCourtAssignments,
  subscribeWorkflow,
  fetchRecorderWorkflow,
} from "./workflow-service.js";
import { evaluateFinalMatch, evaluatePrelimMatch, finalNeedsThirdSet, normalizePlayedSets, validateSetScore } from "./match-logic.js";
import { courtMatchSummary, courtTeamNames, formatCourtName, renderMatchMeta } from "./court-display.js";
import {
  buildRecorderConfirmationModel, buildRecorderSubmitContext, reconcileRecorderSelections,
  buildRecorderCourtSchedule, reconcileRecorderSubmit, recorderRouteState, sortRecorderCourts,
  cloneRecorderDraft, readStoredRecorderDraft, reconcileRecorderSnapshot, removeStoredRecorderDraft,
  recorderDataState, reconcileRecorderAssignment, reconcileRecorderOwnership, resolveRecorderConflict,
  writeStoredRecorderDraft, buildRecorderFixtureIdentity, cloneRecorderFixtureIdentity,
  recorderFixtureIdentityEqual, reconcileRecorderDraftIdentity, preserveStoredRecorderDraft,
} from "./recorder-state.js";

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(["logoutButton","connectionStatus","actionStatus","storageStatus","dataStatus","retryDataButton","authPanel","authTitle","authMessage","identity","googleLoginButton","accessCodeForm","accessCode","accessCodeButton","courtPanel","courtTitle","courtSelect","recorderSelect","courtMessage","enterCourtButton","courtOperationsPanel","selectedCourtLabel","selectedRecorderLabel","changeCourtButton","courtScheduleList","courtScheduleStatus","courtScheduleHeading","workflowPanel","workflowTitle","matchSummary","rejectionNotice","lockNotice","saveRecoveryNotice","saveRecoveryTitle","saveRecoveryMessage","retrySaveButton","keepLocalButton","useServerButton","claimButton","scoreForm","scoreFields","scoreLegend","scoreError","saveButton","reviewButton","endButton","discardButton","discardPanel","discardTitle","discardMessage","keepDraftButton","confirmDiscardButton","confirmPanel","confirmTitle","confirmScore","confirmCourt","confirmRecorder","confirmMatchLabel","confirmTeamA","confirmTeamB","confirmSets","confirmOutcome","backToEditButton","submitButton","successPanel","successTitle"].map((id) => [id, $(id)]));
let courts = [], queue, assignment, workflow, official, teams = new Map(), groups = new Map(), courtId = "", pendingCourtId = "", recorder = "", matchKey = "", busy = false, authState, readyUid = null, lastAuthKind = "", viewState = "selection";
let fixtureIdentity = null;
let courtAssignments = [], scheduleOfficial = new Map(), scheduleState = "idle";
let stop = [], courtStops = [], matchStops = [], scheduleStops = [], scheduleMatchStops = [], officialStop = () => {}, heartbeat, heartbeatEpoch = 0, channel, reconcilingQueue = false;
let readyContextVersion = 0, courtContextVersion = 0, matchContextVersion = 0, scheduleContextVersion = 0, scheduleDetailVersion = 0;
const tabInstanceId = crypto.randomUUID();
let renderedFormKey = "";
let activeStorageKey = "";
const edit = {
  token: null, serverDraft: null, localDraft: null, dirty: false, touched: new Set(), reviewedPayload: null,
  request: "idle", savedRevision: null, inputVersion: 0, pendingSave: null, saveConflict: null,
  pendingSubmit: null, pendingEnd: null, pendingDiscard: null,
};
const dataHealth = Object.fromEntries(["courts","teams","groups","queue","court","schedule","assignment","workflow","official"]
  .map((key) => [key, { status: "idle", error: null }]));
const dataLabels = {
  courts: "코트 목록", teams: "팀 목록", groups: "조 목록", queue: "코트 대기열", schedule: "코트 경기 목록",
  court: "코트 정보", assignment: "경기 배정", workflow: "점수 워크플로", official: "공식 경기",
};
const storageFailureMessages = {
  blocked: "이 기기의 임시 점수 저장이 차단되었습니다. 화면을 닫지 말고 점수를 별도로 기록하세요.",
  malformed: "이 기기의 임시 점수가 손상되어 불러오지 못했습니다. 현재 화면의 점수를 확인한 뒤 저장하세요.",
  invalid: "이 기기의 임시 점수를 저장할 수 없습니다. 화면을 닫지 말고 점수를 별도로 기록하세요.",
  missing_identity: "이 기기의 이전 임시 점수에는 경기 식별 정보가 없어 자동으로 불러오지 않았습니다.",
  preserve_failed: "기존 임시 점수를 보존하지 못했습니다. 화면을 닫지 말고 점수를 별도로 기록하세요.",
};
const ownershipLostMessage = "입력 권한을 잃었습니다. 로컬 초안은 보관되어 있습니다.";
let ownershipWarning = null;
let submissionWarning = null;
const isFinal = () => ["final", "tournament", "finals"].includes(assignment?.matchType) || ["final", "finals"].includes(assignment?.phase);
const scoreKey = () => auth.currentUser && matchKey ? `recorder-score:${TOURNAMENT_ID}:${matchKey}:${auth.currentUser.uid}` : "";
const storageKeyForEdit = () => activeStorageKey || scoreKey();
const status = (text) => { ui.connectionStatus.textContent = text; };
const action = (text) => { ui.actionStatus.textContent = text; ui.actionStatus.hidden = !text; };
const reasonCode = (error) => error?.details?.reason || error?.details?.code || "";
const ambiguousNetworkResult = (error) => /(?:unavailable|deadline-exceeded|internal|unknown)$/.test(String(error?.code || ""));
const focus = (element) => requestAnimationFrame(() => element?.focus());
const navigateToWorkflowEntry = (context, token) => requestAnimationFrame(() => {
  if (!token || !contextIsCurrent(context) || edit.token !== token || viewState !== "operations"
      || !ui.workflowPanel || ui.workflowPanel.hidden || !ui.scoreForm || ui.scoreForm.hidden
      || isStaleTerminalCurrent()) return;
  ui.workflowTitle?.focus?.({ preventScroll: true });
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  ui.workflowPanel.scrollIntoView?.({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start",
  });
});
const displayCourt = (court) => formatCourtName(court, "이름 없는 코트");
const name = (side) => courtTeamNames(official, teams)?.[side] || (side === "a" ? "A팀" : "B팀");
const resolved = () => assignment?.dependencyReady !== false && Boolean(official?.teamA && official?.teamB);
const draftCopy = (value) => cloneRecorderDraft(value);
const selectorLocked = () => busy || Boolean(edit.token || edit.pendingSubmit || edit.pendingSave || edit.pendingEnd || edit.pendingDiscard);
const getLocalStorage = () => {
  try { return globalThis.localStorage; } catch { return null; }
};
function setStorageStatus(reason) {
  if (!ui.storageStatus) return;
  ui.storageStatus.textContent = storageFailureMessages[reason] || storageFailureMessages.blocked;
  ui.storageStatus.hidden = false;
}
function clearStorageStatus() {
  if (ui.storageStatus) { ui.storageStatus.textContent = ""; ui.storageStatus.hidden = true; }
}
function currentFixtureIdentity() {
  return cloneRecorderFixtureIdentity(fixtureIdentity);
}
function readStored() {
  const result = readStoredRecorderDraft(getLocalStorage(), storageKeyForEdit());
  if (!result.ok) setStorageStatus(result.reason);
  return result;
}
function storeDraft({ identity = currentFixtureIdentity(), storageKey = storageKeyForEdit() } = {}) {
  if (!edit.localDraft || !storageKey || !identity) return false;
  const result = writeStoredRecorderDraft(getLocalStorage(), storageKey, {
    draft: edit.localDraft, touched: [...edit.touched], revision: edit.savedRevision,
    identity,
  });
  if (result.ok) clearStorageStatus();
  else setStorageStatus(result.reason);
  return result.ok;
}
function clearStored() {
  return clearStoredKey(storageKeyForEdit(), currentFixtureIdentity());
}
function clearStoredKey(key, identity = null) {
  if (!key) return true;
  const result = removeStoredRecorderDraft(getLocalStorage(), key, identity);
  if (!result.ok) setStorageStatus(result.reason);
  else if (key === storageKeyForEdit()) clearStorageStatus();
  return result.ok;
}
function draftTeamPair(identity) {
  return `${identity?.teamAName || "A팀"} vs ${identity?.teamBName || "B팀"}`;
}
function draftScoreSummary(draft) {
  return (draft?.sets || []).map((set, index) => {
    const a = set.a === "" ? "-" : set.a;
    const b = set.b === "" ? "-" : set.b;
    return `${index + 1}세트 ${a}:${b}`;
  }).join(" · ") || "입력된 세트 없음";
}
function preserveMismatchedStoredDraft(saved) {
  if (!saved?.ok || !saved.value) return false;
  const preserved = preserveStoredRecorderDraft(getLocalStorage(), storageKeyForEdit(), saved.value);
  if (!preserved.ok) setStorageStatus(preserved.reason);
  return preserved.ok;
}
function restoreStoredAfterClaim(saved, currentIdentity, serverRevision) {
  if (!saved?.ok || !saved.found || !saved.value) return;
  const assessment = reconcileRecorderDraftIdentity({
    storedIdentity: saved.value.identity,
    currentIdentity,
  });
  const storedPair = draftTeamPair(assessment.storedIdentity);
  const currentPair = draftTeamPair(assessment.currentIdentity);
  const useStored = (message) => {
    edit.localDraft = draftCopy(saved.value.draft);
    edit.touched = new Set(saved.value.touched);
    edit.dirty = true;
    status(message);
  };
  if (assessment.status === "same_fixture" && saved.value.revision === serverRevision) {
    useStored("이 기기의 임시 점수를 이어서 입력합니다.");
    return;
  }
  if (assessment.canRestore) {
    const message = saved.value.revision === serverRevision
      ? `이 기기의 ${storedPair} 점수를 이어서 입력할까요?`
      : `이 기기의 ${storedPair} 점수가 서버 최신 ${currentPair} 기준보다 오래되었습니다. 이전 점수를 불러와 비교할까요?`;
    if (window.confirm(message)) {
      useStored("이전 기기 점수를 불러왔습니다. 확인 후 다시 저장하세요.");
    } else {
      status("서버의 최신 초안을 사용합니다.");
    }
    return;
  }
  const preserved = preserveMismatchedStoredDraft(saved);
  const warning = assessment.status === "missing_identity"
    ? `이전 기기 초안(${storedPair})에 경기 식별 정보가 없어 자동으로 불러오지 않았습니다. 현재 ${currentPair} 서버 초안을 사용합니다.`
    : `이전 기기 초안(${storedPair})과 현재 경기(${currentPair})가 달라 자동으로 불러오지 않았습니다. 현재 서버 초안을 사용합니다.`;
  const comparison = `보관 점수: ${draftScoreSummary(saved.value.draft)}`;
  status(preserved ? warning : `${warning} 이전 초안 보존에 실패했습니다.`);
  action(preserved ? `${warning} ${comparison}` : `${warning} ${comparison}`);
}
function renderCourtSelectors({ resetRecorder = false } = {}) {
  if (!ui.courtSelect || !ui.recorderSelect) return;
  const selectedCourtId = pendingCourtId || courtId || ui.courtSelect.value || "";
  const selectedRecorder = resetRecorder ? "" : (recorder || ui.recorderSelect.value || "");
  const selection = reconcileRecorderSelections(courts, selectedCourtId, selectedRecorder);
  if (viewState === "selection") pendingCourtId = selection.courtId;
  const courtOptions = [
    new Option("코트를 선택하세요", ""),
    ...sortRecorderCourts(courts).map((court) => new Option(displayCourt(court), court.id)),
  ];
  ui.courtSelect.replaceChildren(...courtOptions);
  ui.courtSelect.value = selection.courtId;
  ui.recorderSelect.replaceChildren(
    new Option(selection.court ? "이름을 선택하세요" : "먼저 코트를 선택하세요", ""),
    ...selection.availableNames.map((value) => new Option(value, value)),
  );
  ui.recorderSelect.value = selection.recorder;
  recorder = selection.recorder;
  const configuredRecorder = selection.court?.recorderName?.trim() || "";
  if (ui.courtMessage) {
    if (!selection.court) ui.courtMessage.textContent = "";
    else if (!configuredRecorder) ui.courtMessage.textContent = "관리자에게 기록관 배정을 요청하세요.";
    else if (!recorder) ui.courtMessage.textContent = `${displayCourt(selection.court)}의 담당 기록관 이름을 선택하세요.`;
    else ui.courtMessage.textContent = `${recorder} · ${displayCourt(selection.court)}`;
  }
  const locked = selectorLocked();
  ui.courtSelect.disabled = locked || viewState === "operations";
  ui.recorderSelect.disabled = locked || viewState === "operations" || !selection.court || !selection.availableNames.length;
  if (ui.enterCourtButton) {
    ui.enterCourtButton.disabled = locked || !selection.court || !selection.recorder;
  }
}
function selectedCourt() {
  return courts.find((item) => item?.id === courtId) || courts.find((item) => item?.id === pendingCourtId) || null;
}
function renderOperationsHeader() {
  const court = selectedCourt();
  if (ui.selectedCourtLabel) ui.selectedCourtLabel.textContent = court ? displayCourt(court) : "";
  if (ui.selectedRecorderLabel) ui.selectedRecorderLabel.textContent = recorder || "";
  if (ui.courtScheduleHeading) ui.courtScheduleHeading.textContent = court ? `${displayCourt(court)} 경기 일정` : "코트 경기 일정";
}
function scheduleStatusLabel(statusValue) {
  return {
    current: "현재 경기",
    next: "다음 경기",
    waiting: "대기",
    under_review: "검토 중",
    completed: "완료",
    replay: "재경기",
  }[statusValue] || "대기";
}
function renderCourtSchedule() {
  renderOperationsHeader();
  if (!ui.courtScheduleList) return;
  if (scheduleState === "loading") {
    ui.courtScheduleList.replaceChildren();
    if (ui.courtScheduleStatus) {
      ui.courtScheduleStatus.hidden = false;
      ui.courtScheduleStatus.textContent = "이 코트의 경기 목록을 불러오는 중입니다.";
    }
    return;
  }
  if (scheduleState === "error") {
    ui.courtScheduleList.replaceChildren();
    if (ui.courtScheduleStatus) {
      ui.courtScheduleStatus.hidden = false;
      ui.courtScheduleStatus.textContent = "이 코트의 경기 목록을 불러오지 못했습니다. ‘대회 데이터 다시 불러오기’를 눌러 재시도하세요.";
    }
    return;
  }
  const schedule = buildRecorderCourtSchedule({
    assignments: courtAssignments,
    queue,
    officialMatches: scheduleOfficial,
    teamsById: teams,
    groupsById: groups,
  });
  if (ui.courtScheduleStatus) {
    ui.courtScheduleStatus.hidden = Boolean(schedule.length);
    ui.courtScheduleStatus.textContent = schedule.length ? "" : "이 코트에 배정된 경기가 없습니다.";
  }
  ui.courtScheduleList.replaceChildren(...schedule.map((item) => {
    const card = document.createElement("li");
    card.className = `court-schedule-item schedule-status-${item.status}`;
    card.dataset.matchKey = item.matchKey;
    const heading = document.createElement("h3");
    renderMatchMeta(heading, {
      ...courtMatchSummary(item.assignment, item.official, { groupsById: groups }),
      courtName: displayCourt(selectedCourt()),
      courtOrder: item.courtOrder,
    });
    const matchup = document.createElement("p");
    matchup.className = "court-schedule-matchup";
    matchup.textContent = item.matchup;
    const badge = document.createElement("span");
    badge.className = "court-schedule-badge";
    badge.textContent = item.statusLabel || scheduleStatusLabel(item.status);
    card.append(heading, matchup, badge);
    if (item.score) {
      const score = document.createElement("p");
      score.className = "court-schedule-score";
      score.textContent = `공식 점수 ${item.score.sets.map((set) => `${set.a}:${set.b}`).join(" · ")}`;
      card.append(score);
    }
    if (item.isCurrent) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "primary-button court-schedule-action";
      const canClaim = isStaleTerminalCurrent() || canResumeCurrentMatch(workflow, recorder)
        || (!workflow?.lock && ["idle", "rejected"].includes(workflow?.draftState));
      button.textContent = isStaleTerminalCurrent() ? "다음 경기 확인" : edit.token ? "입력 중인 점수로 이동" : "점수 입력";
      button.disabled = viewState !== "operations" || !actionsReady() || busy || Boolean(edit.pendingSubmit)
        || item.matchKey !== matchKey || !item.eligibleCurrent || !resolved() || !(edit.token || canClaim);
      button.addEventListener("click", async () => {
        if (button.disabled || viewState !== "operations" || !item.isCurrent) return;
        if (queue?.currentMatchKey !== item.matchKey) {
          action("현재 경기 순서가 변경되었습니다. 최신 경기 목록을 확인하세요.");
          render();
          return;
        }
        const alreadyEditing = Boolean(edit.token) && !isStaleTerminalCurrent();
        if (!alreadyEditing) await ui.claimButton.onclick();
        if (alreadyEditing && edit.token && !isStaleTerminalCurrent()) navigateToWorkflowEntry(captureContext(), edit.token);
      });
      card.append(button);
    }
    return card;
  }));
}
function clearConfirmation() {
  const fields = [ui.confirmCourt, ui.confirmRecorder, ui.confirmMatchLabel, ui.confirmTeamA, ui.confirmTeamB, ui.confirmOutcome];
  fields.forEach((field) => { if (field) field.textContent = ""; });
  if (ui.confirmSets) ui.confirmSets.replaceChildren();
}
function renderConfirmation(model) {
  if (!ui.confirmScore) return;
  if (ui.confirmCourt) ui.confirmCourt.textContent = model.court;
  if (ui.confirmRecorder) ui.confirmRecorder.textContent = model.recorder;
  if (ui.confirmMatchLabel) renderMatchMeta(ui.confirmMatchLabel, {
    ...courtMatchSummary(assignment, official, { groupsById: groups }),
    courtOrder: assignment?.courtOrder ?? null,
    label: model.matchLabel,
  });
  if (ui.confirmTeamA) ui.confirmTeamA.textContent = model.teamA;
  if (ui.confirmTeamB) ui.confirmTeamB.textContent = model.teamB;
  if (ui.confirmOutcome) ui.confirmOutcome.textContent = model.outcome;
  if (ui.confirmSets) {
    ui.confirmSets.replaceChildren(...model.sets.map((set) => {
      const row = document.createElement("tr");
      const a = document.createElement("td");
      const label = document.createElement("th");
      const b = document.createElement("td");
      label.scope = "row";
      a.textContent = String(set.a);
      label.textContent = set.label;
      b.textContent = String(set.b);
      row.append(a, label, b);
      return row;
    }));
  }
}
function setDataState(key, state, error = null) {
  if (!dataHealth[key]) return;
  dataHealth[key] = recorderDataState(dataHealth[key], state, error);
  renderDataState();
}
function relevantDataKeys() {
  const keys = ["courts", "teams", "groups"];
  if (courtId && viewState === "operations") keys.push("queue", "court", "schedule");
  if (matchKey) keys.push("assignment", "workflow", "official");
  return keys;
}
function authoritativeDataReady() {
  return relevantDataKeys().every((key) => dataHealth[key]?.status === "ready");
}
function authActionsReady() {
  const uid = authState?.user?.uid || auth.currentUser?.uid || null;
  return authState?.kind === "ready" && Boolean(uid && readyUid === uid) && navigator.onLine !== false;
}
function actionsReady() {
  return authActionsReady() && authoritativeDataReady();
}
function setSnapshotState(key, metadata) {
  setDataState(key, metadata?.fromCache ? "loading" : "ready");
}
function renderDataState() {
  if (!ui.dataStatus || !ui.retryDataButton) return;
  const problems = relevantDataKeys()
    .map((key) => ({ key, ...dataHealth[key] }))
    .filter(({ status }) => status !== "ready");
  if (!problems.length) {
    ui.dataStatus.hidden = true;
    ui.dataStatus.textContent = "";
    ui.retryDataButton.hidden = true;
    return;
  }
  const errors = problems.filter(({ status }) => status === "error");
  const names = [...new Set(problems.map(({ key }) => dataLabels[key]))].join(", ");
  ui.dataStatus.hidden = false;
  ui.dataStatus.textContent = errors.length
    ? `${names}를 확인하지 못했습니다. 최신 권위 데이터를 받은 뒤 다시 시도하세요.`
    : `${names}를 확인하는 중입니다. 잠시 기다려 주세요.`;
  ui.retryDataButton.hidden = false;
  ui.retryDataButton.disabled = busy || !authActionsReady();
}
function applyActionGate() {
  syncScreenVisibility();
  const blocked = !actionsReady();
  const actionButtons = [ui.claimButton, ui.saveButton, ui.reviewButton, ui.endButton, ui.discardButton,
    ui.confirmDiscardButton, ui.keepDraftButton, ui.backToEditButton, ui.submitButton];
  actionButtons.forEach((button) => {
    if (button) button.disabled = busy || blocked;
  });
  if (ui.scoreFields) {
    ui.scoreFields.disabled = busy || blocked || !edit.token;
    ui.scoreFields.setAttribute("aria-busy", String(busy));
  }
  const selectorsDisabled = selectorLocked();
  if (ui.courtSelect) ui.courtSelect.disabled = selectorsDisabled || viewState === "operations";
  if (ui.recorderSelect) ui.recorderSelect.disabled = selectorsDisabled || viewState === "operations"
    || !ui.courtSelect?.value || ui.recorderSelect.options.length <= 1;
  if (ui.enterCourtButton) ui.enterCourtButton.disabled = selectorsDisabled
    || viewState === "operations" || !ui.courtSelect?.value || !ui.recorderSelect?.value;
  if (ui.changeCourtButton) ui.changeCourtButton.disabled = busy || viewState !== "operations";
  renderCourtSchedule();
  if (courtAssignments.some((item) => item.matchKey === matchKey && item.matchKey === queue?.currentMatchKey)) {
    ui.claimButton.hidden = true;
  }
  renderDataState();
}
function setBusy(value) {
  busy = value; edit.request = value ? "pending" : "idle";
  [ui.googleLoginButton,ui.accessCodeButton].forEach((button) => { if (button) button.disabled = value; });
  applyActionGate();
}
function fenceAmbiguousOperation() {
  if (edit.pendingSubmit) {
    ui.backToEditButton.disabled = true;
    ui.submitButton.disabled = busy || !actionsReady() || ownershipLostFor(edit.pendingSubmit);
  }
  if (edit.pendingEnd) {
    ui.scoreFields.disabled = true;
    [ui.saveButton, ui.reviewButton, ui.discardButton].forEach((button) => { button.disabled = true; });
    ui.endButton.disabled = !actionsReady() || ownershipLostFor(edit.pendingEnd);
  }
  if (edit.pendingDiscard) {
    ui.keepDraftButton.disabled = true;
    ui.confirmDiscardButton.disabled = !actionsReady() || ownershipLostFor(edit.pendingDiscard);
  }
  if (edit.pendingSave || edit.saveConflict) {
    ui.saveButton.disabled = true;
    ui.reviewButton.disabled = true;
  }
}
function stopScheduleStreams() {
  scheduleContextVersion += 1;
  scheduleDetailVersion += 1;
  scheduleStops.forEach((fn) => fn());
  scheduleStops = [];
  scheduleMatchStops.forEach((fn) => fn());
  scheduleMatchStops = [];
  courtAssignments = [];
  scheduleOfficial = new Map();
  scheduleState = "idle";
  setDataState("schedule", "idle");
}
function stopAll() {
  readyContextVersion += 1;
  courtContextVersion += 1;
  matchContextVersion += 1;
  stopScheduleStreams();
  stop.forEach((fn) => fn()); stop = [];
  courtStops.forEach((fn) => fn()); courtStops = [];
  matchStops.forEach((fn) => fn()); matchStops = [];
  officialStop(); officialStop = () => {};
  stopHeartbeat();
}
function normalizeFinal(score) {
  return { sets: normalizePlayedSets(score.sets, isFinal()) };
}
function resetMatchEditor({ preservePendingSubmit = false } = {}) {
  const reviewedPayload = preservePendingSubmit ? edit.reviewedPayload : null;
  edit.token = null;
  edit.serverDraft = null;
  edit.localDraft = null;
  edit.dirty = false;
  edit.touched.clear();
  edit.reviewedPayload = reviewedPayload;
  edit.pendingSave = null;
  edit.saveConflict = null;
  if (!preservePendingSubmit) edit.pendingSubmit = null;
  stopHeartbeat();
  renderedFormKey = "";
  if (!reviewedPayload) clearConfirmation();
  if (ui.scoreFields && ui.scoreLegend) ui.scoreFields.replaceChildren(ui.scoreLegend);
}
function clearCurrentMatch() {
  matchContextVersion += 1;
  matchStops.forEach((fn) => fn());
  matchStops = [];
  officialStop();
  officialStop = () => {};
  setDataState("assignment", "idle");
  setDataState("workflow", "idle");
  setDataState("official", "idle");
  matchKey = "";
  fixtureIdentity = null;
  assignment = workflow = official = null;
  renderedFormKey = "";
  clearConfirmation();
  if (ui.matchSummary) ui.matchSummary.textContent = "현재 대기 중인 경기가 없습니다.";
  if (ui.lockNotice) ui.lockNotice.hidden = true;
  if (ui.claimButton) ui.claimButton.hidden = true;
  if (ui.scoreForm) ui.scoreForm.hidden = true;
}
function confirmationOutcome(score) {
  const evaluation = isFinal() ? evaluateFinalMatch(score.sets) : evaluatePrelimMatch(score.sets);
  const winner = evaluation.result || evaluation.winner;
  if (winner === "A") return `${name("a")} 승리`;
  if (winner === "B") return `${name("b")} 승리`;
  if (winner === "draw") return "무승부";
  return "경기 결과 확인";
}
function formScore() {
  return { sets: [...ui.scoreFields.querySelectorAll(".score-row")].map((row) => {
    const inputs = row.querySelectorAll("input");
    return { a: inputs[0].value, b: inputs[1].value, inputs };
  }) };
}
function validate(forSubmit) {
  const raw = formScore(); ui.scoreFields.querySelectorAll("input").forEach((input) => { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-errormessage"); });
  const sets = [];
  for (let i = 0; i < raw.sets.length; i += 1) {
    const set = raw.sets[i];
    if (set.inputs[0].disabled && set.inputs[1].disabled) continue;
    const blankA = set.a.trim() === "";
    const blankB = set.b.trim() === "";
    if (!forSubmit && blankA && blankB) break;
    if (blankA || blankB) {
      const target = set.a.trim() === "" ? set.inputs[0] : set.inputs[1]; target.setAttribute("aria-invalid", "true"); target.setAttribute("aria-errormessage", "scoreError"); target.focus();
      return { ok: false, message: `${i + 1}세트 점수를 모두 입력하세요.` };
    }
    const value = { a: Number(set.a), b: Number(set.b) };
    const boundedDraft = Number.isInteger(value.a) && Number.isInteger(value.b)
      && value.a >= 0 && value.a <= 15 && value.b >= 0 && value.b <= 15;
    const check = forSubmit ? validateSetScore(value.a, value.b, isFinal() && i === 2 ? 7 : 10) : { ok: boundedDraft, message: "0~15 사이 정수를 입력하세요." };
    if (!check.ok) { set.inputs.forEach((input) => input.setAttribute("aria-invalid", "true")); set.inputs[0].focus(); return { ok: false, message: `${i + 1}세트: ${check.message}` }; }
    sets.push(value);
  }
  if (!sets.length) return { ok: false, message: "저장할 세트 점수를 입력하세요." };
  const score = normalizeFinal({ sets });
  if (forSubmit) { const evaluation = isFinal() ? evaluateFinalMatch(score.sets) : evaluatePrelimMatch(score.sets); if (evaluation.status !== "done") return { ok: false, message: "끝난 경기의 필요한 세트 점수를 입력하세요." }; }
  return { ok: true, score };
}
function renderForm() {
  if (!edit.token || !resolved() || ui.confirmPanel.hidden === false) { ui.scoreForm.hidden = true; return; }
  const formKey = `${matchKey}:${isFinal() ? "final" : "prelim"}`;
  if (renderedFormKey === formKey && ui.scoreFields.querySelector(".score-row")) {
    ui.scoreForm.hidden = false;
    return;
  }
  const previous = edit.localDraft || edit.serverDraft || { sets: [] }; const targets = isFinal() ? [10,10,7] : [10,10];
  ui.scoreLegend.textContent = `${name("a")} vs ${name("b")} 점수`; ui.scoreFields.replaceChildren(ui.scoreLegend);
  targets.forEach((target, i) => {
    const row = document.createElement("div"); row.className = "score-row"; const label = document.createElement("label"); label.textContent = `${i + 1}세트 · ${target}점`;
    const input = (side) => { const node = document.createElement("input"); node.type = "number"; node.inputMode = "numeric"; node.min = "0"; node.max = "15"; node.value = previous.sets[i]?.[side] ?? ""; node.setAttribute("aria-label", `${i + 1}세트 ${name(side)} 점수`); node.addEventListener("input", () => { edit.inputVersion += 1; edit.dirty = true; edit.touched.add(`${i}-${side}`); edit.localDraft = { sets: formScore().sets.map((set) => ({ a: set.a, b: set.b })) }; edit.reviewedPayload = null; clearConfirmation(); const stored = storeDraft(); action(stored ? "미저장" : "미저장 · 이 화면의 점수를 별도로 기록하세요."); updateThird(); }); return node; };
    const a = input("a"), b = input("b"), left = document.createElement("div"), right = document.createElement("div"), colon = document.createElement("span"); left.className = right.className = "score-entry"; colon.textContent = ":"; left.append(Object.assign(document.createElement("span"), { textContent: name("a") }), a); right.append(Object.assign(document.createElement("span"), { textContent: name("b") }), b); row.append(label,left,colon,right); ui.scoreFields.append(row);
  });
  const updateThird = () => { if (!isFinal()) return; const inputs = ui.scoreFields.querySelectorAll(".score-row:nth-of-type(3) input"); const first = formScore().sets.slice(0,2).map((set) => ({ a: Number(set.a), b: Number(set.b) })); const enabled = first.every((set) => Number.isFinite(set.a) && Number.isFinite(set.b)) && finalNeedsThirdSet([...first,{a:0,b:0}]); inputs.forEach((input) => { input.disabled = !enabled; if (!enabled) input.value = ""; }); };
  updateThird(); renderedFormKey = formKey; ui.scoreForm.hidden = false;
}
function renderSummary() {
  if (!assignment) return;
  const view = courtMatchSummary(assignment, official, { teamsById: teams, groupsById: groups });
  const meta = document.createElement("div");
  renderMatchMeta(meta, {
    ...view,
    courtName: displayCourt(selectedCourt()),
    courtOrder: assignment.courtOrder ?? null,
  });
  const matchup = document.createElement("strong");
  matchup.className = "court-schedule-matchup";
  matchup.textContent = `${name("a")} vs ${name("b")}`;
  ui.matchSummary.replaceChildren(meta, matchup);
}
function renderSaveRecovery() {
  if (!ui.saveRecoveryNotice) return;
  const pending = edit.pendingSave;
  const conflict = edit.saveConflict;
  ui.saveRecoveryNotice.hidden = !pending && !conflict;
  ui.retrySaveButton.hidden = !pending;
  ui.keepLocalButton.hidden = !conflict;
  ui.useServerButton.hidden = !conflict;
  if (pending) {
    ui.saveRecoveryTitle.textContent = "저장 결과를 확인하는 중입니다.";
    ui.saveRecoveryMessage.textContent = "연결이 끊겨 저장 결과를 확인하지 못했습니다. 최신 서버 초안이 같으면 자동으로 저장 완료 처리하며, 다르면 로컬 초안을 유지한 채 선택할 수 있습니다.";
    ui.retrySaveButton.disabled = busy || !actionsReady();
  } else if (conflict) {
    ui.saveRecoveryTitle.textContent = "서버 초안이 변경되었습니다.";
    ui.saveRecoveryMessage.textContent = "서버의 최신 초안을 덮어쓰지 않았습니다. 로컬 초안을 유지해 새 버전을 기준으로 다시 저장하거나, 서버 초안을 직접 사용할 수 있습니다.";
    ui.keepLocalButton.disabled = busy || !actionsReady();
    ui.useServerButton.disabled = busy || !actionsReady();
  }
}
function isStaleTerminalCurrent() {
  return queue?.currentMatchKey === matchKey
    && !workflow?.lock
    && (assignment?.publicStatus === "completed"
      || assignment?.publicStatus === "under_review"
      || ["submitted", "approved"].includes(workflow?.draftState));
}
let contextVersion = 0;
function bumpContext() {
  const hadPendingSave = Boolean(edit.pendingSave);
  const hadBusy = busy;
  if (edit.pendingSave?.context?.storageKey) {
    const pending = edit.pendingSave;
    const stored = writeStoredRecorderDraft(getLocalStorage(), pending.context.storageKey, {
      draft: pending.draft,
      touched: [...pending.touched],
      revision: pending.expectedRevision,
      identity: pending.fixtureIdentity || pending.context.fixtureIdentity,
    });
    if (!stored.ok) setStorageStatus(stored.reason);
  }
  if (edit.dirty && edit.localDraft && storageKeyForEdit()) storeDraft();
  contextVersion += 1;
  edit.pendingSave = null;
  edit.saveConflict = null;
  if (hadPendingSave || hadBusy) setBusy(false);
}
function captureContext() {
  return {
    version: contextVersion,
    matchKey,
    courtId,
    uid: auth.currentUser?.uid || authState?.user?.uid || null,
    storageKey: storageKeyForEdit(),
    fixtureIdentity: currentFixtureIdentity(),
  };
}
function contextIsCurrent(context) {
  return context.version === contextVersion
    && context.matchKey === matchKey
    && context.courtId === courtId
    && context.uid === (auth.currentUser?.uid || authState?.user?.uid || null)
    && ((!context.fixtureIdentity && !fixtureIdentity)
      || recorderFixtureIdentityEqual(context.fixtureIdentity, fixtureIdentity));
}
function operationContextIsCurrent(operation) {
  if (operation?.context && !contextIsCurrent(operation.context)) return false;
  if (Number.isInteger(operation?.contextVersion) && operation.contextVersion !== contextVersion) return false;
  return Boolean(operation
    && operation.matchKey === matchKey
    && operation.courtId === courtId
    && ((!operation.fixtureIdentity && !fixtureIdentity)
      || recorderFixtureIdentityEqual(operation.fixtureIdentity, fixtureIdentity)));
}
function refreshFixtureIdentity() {
  if (!assignment || !matchKey) return null;
  if (!official) {
    if (fixtureIdentity) fenceFixtureIdentity(null);
    return null;
  }
  const names = courtTeamNames(official, teams) || {};
  const next = buildRecorderFixtureIdentity({
    matchKey,
    assignment,
    official,
    workflow,
    teamAName: names.a || "",
    teamBName: names.b || "",
    previousIdentity: fixtureIdentity,
  });
  if (!next) {
    if (fixtureIdentity) fenceFixtureIdentity(null);
    return null;
  }
  if (fixtureIdentity && !recorderFixtureIdentityEqual(fixtureIdentity, next)) {
    fenceFixtureIdentity(next);
    return fixtureIdentity;
  }
  fixtureIdentity = next;
  return fixtureIdentity;
}
function fenceFixtureIdentity(nextIdentity) {
  const previousIdentity = currentFixtureIdentity();
  if (!previousIdentity || recorderFixtureIdentityEqual(previousIdentity, nextIdentity)) {
    fixtureIdentity = cloneRecorderFixtureIdentity(nextIdentity);
    return;
  }
  const hadPendingSave = Boolean(edit.pendingSave);
  const hadDirtyDraft = Boolean(edit.dirty && edit.localDraft);
  const oldStorageKey = edit.pendingSave?.context?.storageKey || storageKeyForEdit();
  bumpContext();
  fixtureIdentity = cloneRecorderFixtureIdentity(nextIdentity);
  stopHeartbeat();
  edit.token = null;
  edit.serverDraft = null;
  edit.localDraft = null;
  edit.dirty = false;
  edit.touched.clear();
  edit.savedRevision = null;
  edit.reviewedPayload = null;
  edit.saveConflict = null;
  renderedFormKey = "";
  clearConfirmation();
  if (hadPendingSave || hadDirtyDraft) {
    const saved = hadPendingSave
      ? Boolean(readStoredRecorderDraft(getLocalStorage(), oldStorageKey).found)
      : true;
    status(saved
      ? "공식 대진이 변경되어 이전 입력을 보관했습니다. 현재 대진은 서버 초안으로 시작합니다."
      : "공식 대진이 변경되었습니다. 이전 입력을 보관하지 못했으니 화면을 닫지 마세요.");
  }
}
function pendingOperationFor(kind) {
  return kind === "submit" ? edit.pendingSubmit
    : kind === "end" ? edit.pendingEnd
      : kind === "discard" ? edit.pendingDiscard : null;
}
function ownershipWarningMatches(operation) {
  return Boolean(ownershipWarning && operation
    && ownershipWarning.matchKey === operation.matchKey
    && ownershipWarning.token === operation.token
    && (!ownershipWarning.fixtureIdentity || !operation.fixtureIdentity
      || recorderFixtureIdentityEqual(ownershipWarning.fixtureIdentity, operation.fixtureIdentity)));
}
function ownershipLostFor(operation) {
  return ownershipWarning?.source === "loss" && ownershipWarningMatches(operation);
}
function clearVerifiedOperationWarning(operation) {
  if (!operation) return;
  if (ownershipWarning && !ownershipWarningMatches(operation)) return;
  if (ownershipWarning?.source === "loss") return;
  if (ownershipWarning && ui.connectionStatus?.textContent === ownershipWarning.message) status("");
  else if (ui.connectionStatus?.textContent === ownershipLostMessage) status("");
  ownershipWarning = null;
}
function showSubmissionWarning(operation, message) {
  submissionWarning = { operation, message };
  status(message);
}
function clearSubmissionWarning(operation) {
  if (submissionWarning?.operation !== operation) return;
  if (ui.connectionStatus.textContent === submissionWarning.message) status("");
  submissionWarning = null;
}
function preserveOwnershipWarning(operation) {
  return ownershipWarning?.source === "loss"
    && ownershipWarningMatches(operation)
    && ui.connectionStatus?.textContent === ownershipWarning.message;
}
function setOwnershipLostWarning(key, token, {
  force = false,
  identity = currentFixtureIdentity(),
  storageKey = storageKeyForEdit(),
} = {}) {
  if (force || edit.dirty) {
    const stored = storeDraft({ identity, storageKey });
    const message = stored
      ? ownershipLostMessage
      : "입력 권한을 잃었습니다. 로컬 초안을 저장할 수 없습니다. 화면을 닫지 마세요.";
    ownershipWarning = {
      matchKey: key,
      token,
      source: "loss",
      message,
      fixtureIdentity: cloneRecorderFixtureIdentity(identity),
      storageKey,
    };
    status(message);
    return;
  }
  ownershipWarning = null;
}
function fenceAssignmentContext(key) {
  const lostToken = edit.token;
  const lostIdentity = cloneRecorderFixtureIdentity(
    edit.pendingSave?.fixtureIdentity || edit.pendingSave?.context?.fixtureIdentity || fixtureIdentity,
  );
  const lostStorageKey = edit.pendingSave?.context?.storageKey || storageKeyForEdit();
  const pendingSaveDraft = draftCopy(edit.pendingSave?.draft);
  const pendingSaveTouched = edit.pendingSave?.touched ? [...edit.pendingSave.touched] : [];
  const pendingSaveRevision = edit.pendingSave?.expectedRevision;
  const hadPendingSave = Boolean(edit.pendingSave);
  const hadDirtyDraft = edit.dirty;
  stopHeartbeat();
  bumpContext();
  if (pendingSaveDraft && (!edit.localDraft || !hadDirtyDraft)) {
    edit.localDraft = pendingSaveDraft;
    edit.touched = new Set(pendingSaveTouched);
    edit.savedRevision = Number.isInteger(pendingSaveRevision) ? pendingSaveRevision : edit.savedRevision;
    edit.dirty = true;
  }
  edit.token = null;
  renderedFormKey = "";
  if (!edit.pendingSubmit) {
    edit.reviewedPayload = null;
    clearConfirmation();
  }
  if (hadDirtyDraft || hadPendingSave) {
    setOwnershipLostWarning(key, lostToken, {
      force: hadPendingSave,
      identity: lostIdentity,
      storageKey: lostStorageKey,
    });
  } else {
    ownershipWarning = null;
  }
  if (!queue?.currentMatchKey || queue.currentMatchKey !== key) {
    clearCurrentMatch();
  } else {
    assignment = null;
    official = null;
    setDataState("assignment", "idle");
    setDataState("official", "idle");
  }
  render();
}
function reconcileWorkflowOwnership(value, metadata, key = matchKey) {
  const result = reconcileRecorderOwnership({
    workflow: value,
    metadata,
    matchKey: key,
    token: edit.token,
    uid: auth.currentUser?.uid || authState?.user?.uid || "",
    currentFixtureIdentity: currentFixtureIdentity(),
    pendingSubmit: edit.pendingSubmit,
    pendingEnd: edit.pendingEnd,
    pendingDiscard: edit.pendingDiscard,
  });
  if (result.status === "ignore" || result.status === "none" || result.status === "owned") return result;
  if (result.status === "expected_release" || result.status === "awaiting_operation") {
    stopHeartbeat();
    if (result.status === "expected_release") clearVerifiedOperationWarning(pendingOperationFor(result.operation));
    return result;
  }
  const lostToken = edit.token;
  stopHeartbeat();
  edit.token = null;
  renderedFormKey = "";
  if (edit.dirty) {
    setOwnershipLostWarning(key, lostToken, {
      identity: currentFixtureIdentity(),
      storageKey: storageKeyForEdit(),
    });
  }
  return result;
}
function reconcileFailedOperationOwnership(kind, operation, ambiguous) {
  if (!operation || dataHealth.workflow?.status !== "ready") return;
  const result = reconcileRecorderOwnership({
    workflow,
    metadata: { fromCache: false },
    matchKey: operation.matchKey,
    token: edit.token,
    uid: auth.currentUser?.uid || authState?.user?.uid || "",
    currentFixtureIdentity: currentFixtureIdentity(),
    pendingSubmit: kind === "submit" ? operation : null,
    pendingEnd: kind === "end" ? operation : null,
    pendingDiscard: kind === "discard" ? operation : null,
  });
  if (result.status === "expected_release") {
    stopHeartbeat();
    if (!ambiguous) {
      edit.token = null;
      renderedFormKey = "";
    }
    return;
  }
  if (result.status !== "lost" && !(result.status === "awaiting_operation" && !ambiguous)) return;
  const lostToken = edit.token;
  stopHeartbeat();
  edit.token = null;
  renderedFormKey = "";
  if (edit.dirty) {
    setOwnershipLostWarning(operation.matchKey, lostToken, {
      identity: operation.fixtureIdentity || currentFixtureIdentity(),
      storageKey: operation.storageKey || storageKeyForEdit(),
    });
  }
}
function applyWorkflowSnapshot(value, metadata = null) {
  const remote = value?.draft ? draftCopy(value.draft) : null;
  const remoteRevision = Number.isInteger(value?.draftRevision) ? value.draftRevision : null;
  let reconciliation = { status: "ignore" };
  const pendingSave = edit.pendingSave;
  if (pendingSave && remoteRevision !== null && (!metadata || !metadata.fromCache)) {
    reconciliation = reconcileRecorderSnapshot({
      pendingSave,
      remoteDraft: remote,
      remoteRevision,
      currentFixtureIdentity: currentFixtureIdentity(),
    });
    if (reconciliation.status === "confirmed" && contextIsCurrent(pendingSave.context)) {
      edit.serverDraft = reconciliation.draft;
      edit.savedRevision = reconciliation.revision;
      const changedSinceSave = edit.inputVersion !== pendingSave.inputVersion;
      if (!changedSinceSave) {
        edit.localDraft = reconciliation.draft;
        edit.dirty = false;
        edit.touched.clear();
      } else {
        edit.dirty = true;
      }
      edit.pendingSave = null;
      edit.saveConflict = null;
      if (changedSinceSave) {
        const stored = storeDraft();
        action(stored ? "저장 확인됨 · 이후 변경은 미저장입니다." : "저장 확인됨 · 이후 변경을 별도로 기록하세요.");
      } else {
        const cleared = clearStored();
        action(cleared ? "저장 확인됨" : "저장 확인됨 · 임시 저장 정리에 실패했습니다.");
      }
    } else if (reconciliation.status === "conflict" && contextIsCurrent(pendingSave.context)) {
      edit.saveConflict = {
        ...reconciliation,
        localDraft: edit.inputVersion === pendingSave.inputVersion
          ? reconciliation.localDraft
          : draftCopy(edit.localDraft),
      };
      edit.pendingSave = null;
      edit.savedRevision = reconciliation.remoteRevision;
      edit.dirty = true;
      const stored = storeDraft();
      action(stored ? "서버 초안 충돌 · 로컬 초안을 보관했습니다." : "서버 초안 충돌 · 화면의 로컬 점수를 별도로 기록하세요.");
    }
  }
  if (edit.saveConflict && remoteRevision !== null && (!metadata || !metadata.fromCache)
      && remoteRevision > edit.saveConflict.remoteRevision && remote) {
    edit.saveConflict = {
      ...edit.saveConflict,
      remoteDraft: remote,
      remoteRevision,
    };
    edit.savedRevision = remoteRevision;
  }
  return { remote, remoteRevision, reconciliation };
}
async function reconcileFreshWorkflow(pendingSave) {
  const fresh = await fetchRecorderWorkflow(pendingSave.context.matchKey);
  if (!contextIsCurrent(pendingSave.context) || edit.pendingSave !== pendingSave) return "ignore";
  workflow = fresh;
  setSnapshotState("workflow", { fromCache: false });
  reconcileWorkflowOwnership(fresh, { fromCache: false }, pendingSave.context.matchKey);
  const { reconciliation } = applyWorkflowSnapshot(fresh, { fromCache: false });
  render();
  return reconciliation.status;
}
function syncScreenVisibility() {
  const confirmationActive = Boolean(
    (edit.reviewedPayload && (!edit.pendingSubmit || operationContextIsCurrent(edit.pendingSubmit)))
      || operationContextIsCurrent(edit.pendingSubmit),
  );
  const authenticatedScreen = ui.authPanel.hidden;
  ui.courtPanel.hidden = !authenticatedScreen || viewState !== "selection";
  if (ui.confirmPanel) ui.confirmPanel.hidden = !authenticatedScreen || !confirmationActive;
  if (ui.courtOperationsPanel) ui.courtOperationsPanel.hidden = !authenticatedScreen || viewState !== "operations" || confirmationActive;
  if (ui.workflowPanel) ui.workflowPanel.hidden = viewState !== "operations" || confirmationActive || !courtId;
}
function render() {
  syncScreenVisibility();
  renderOperationsHeader();
  renderCourtSchedule();
  renderDataState();
  renderSaveRecovery();
  if (viewState !== "operations" || !matchKey) {
    if (ui.claimButton) ui.claimButton.hidden = true;
    if (ui.scoreForm) ui.scoreForm.hidden = true;
    applyActionGate();
    return;
  }
  renderSummary(); const reason = workflow?.rejectionReason || workflow?.reviewReason || workflow?.rejectedReason;
  const correctingRejectedScore = workflow?.draftState === "rejected" || workflow?.resumeDraftState === "rejected";
  if (ui.rejectionNotice) {
    ui.rejectionNotice.hidden = !correctingRejectedScore;
    ui.rejectionNotice.textContent = reason ? `반려 사유: ${reason} · 관리자 요청을 반영해 수정한 뒤 다시 제출하세요.` : "반려됨: 점수를 수정해 다시 제출하세요.";
  }
  const waiting = !resolved();
  if (ui.lockNotice) {
    ui.lockNotice.hidden = !(waiting || (workflow?.lock && !edit.token));
    ui.lockNotice.textContent = waiting ? "대진이 확정되기를 기다리고 있습니다. 팀과 이전 경기 결과가 확정되면 입력할 수 있습니다." : "다른 탭 또는 기록관이 입력 중입니다.";
  }
  const selectorReady = Boolean(courtId && recorder && (ui.courtSelect?.value || pendingCourtId) === courtId);
  if (isStaleTerminalCurrent()) {
    if (ui.claimButton) {
      ui.claimButton.hidden = !selectorReady;
      ui.claimButton.disabled = reconcilingQueue || Boolean(edit.pendingSubmit) || !actionsReady();
      ui.claimButton.textContent = reconcilingQueue ? "다음 경기 확인 중…" : "다음 경기로 이동";
    }
    if (ui.scoreForm) ui.scoreForm.hidden = true;
    if (ui.lockNotice) {
      ui.lockNotice.hidden = false;
      ui.lockNotice.textContent = "이 경기는 관리자가 확정했습니다. 다음 경기로 이동하세요.";
    }
    applyActionGate();
    return;
  }
  const resumable = canResumeCurrentMatch(workflow, recorder);
  if (ui.claimButton) {
    ui.claimButton.hidden = Boolean(edit.token) || waiting || !(resumable || ["idle","rejected"].includes(workflow?.draftState));
    ui.claimButton.hidden ||= !selectorReady;
    ui.claimButton.disabled = waiting || Boolean(edit.pendingSubmit) || !selectorReady || !actionsReady();
    ui.claimButton.textContent = correctingRejectedScore ? "반려 점수 수정" : resumable ? "이전 작성 이어서 하기" : "경기 입력 시작";
  }
  renderForm();
  applyActionGate();
  fenceAmbiguousOperation();
}
function attachMatch(key) {
  const localMatchVersion = ++matchContextVersion;
  if (key !== matchKey) {
    const submittedMatch = edit.pendingSubmit?.matchKey === matchKey;
    if (submittedMatch) resetMatchEditor({ preservePendingSubmit: true });
    bumpContext();
    activeStorageKey = "";
    fixtureIdentity = null;
  }
  matchStops.forEach((fn) => fn()); matchStops = []; officialStop(); officialStop = () => {}; matchKey = key; renderedFormKey = "";
  setDataState("assignment", "loading");
  setDataState("workflow", "loading");
  setDataState("official", "idle");
  matchStops.push(subscribeAssignment(key, (value, metadata) => {
    if (localMatchVersion !== matchContextVersion || key !== matchKey || viewState !== "operations") return;
    const assignmentReconciliation = reconcileRecorderAssignment({
      assignment: value,
      metadata,
      courtId,
    });
    if (assignmentReconciliation.status === "ignore") return;
    if (assignmentReconciliation.status === "lost") {
      fenceAssignmentContext(key);
      return;
    }
    setSnapshotState("assignment", metadata);
    assignment = value;
    attachOfficial(localMatchVersion);
    render();
  }, (error) => {
    if (localMatchVersion === matchContextVersion && key === matchKey) handleMatchSubscriptionError(error, "assignment");
  }));
  matchStops.push(subscribeWorkflow(key, (value, metadata) => {
    if (localMatchVersion !== matchContextVersion || key !== matchKey || viewState !== "operations") return;
    setSnapshotState("workflow", metadata);
    workflow = value;
    reconcileWorkflowOwnership(value, metadata, key);
    const { remote, remoteRevision } = applyWorkflowSnapshot(value, metadata);
    if (!edit.dirty && !edit.pendingSave && remote && remoteRevision !== null && remoteRevision !== edit.savedRevision) {
      edit.serverDraft = remote; edit.localDraft = remote; edit.savedRevision = remoteRevision;
    }
    render();
  }, (error) => {
    if (localMatchVersion === matchContextVersion && key === matchKey) handleMatchSubscriptionError(error, "workflow");
  }));
}
function handleMatchSubscriptionError(error, key = "workflow") {
  setDataState(key, "error", error);
  if (authState?.kind === "ready" && /permission-denied/.test(String(error?.code || ""))) {
    status("경기 상태를 다시 확인할 수 없습니다. 다음 경기로 이동하거나 데이터를 다시 불러오세요.");
    render();
    return;
  }
  status(recorderReason(error));
  render();
}
function attachOfficial(expectedMatchVersion = matchContextVersion) {
  if (!assignment?.matchId) {
    official = null;
    setDataState("official", "ready");
    return;
  }
  officialStop(); officialStop = () => {};
  setDataState("official", "loading");
  const ref = assignment.matchType === "final" ? doc(db,"tournaments",TOURNAMENT_ID,"divisions",assignment.divisionId,"finalMatches",assignment.matchId) : doc(db,"tournaments",TOURNAMENT_ID,"prelimMatches",assignment.matchId);
  officialStop = onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
    if (expectedMatchVersion !== matchContextVersion || viewState !== "operations") return;
    setSnapshotState("official", snap.metadata);
    official = snap.exists() ? { id:snap.id,...snap.data() } : null;
    if (!snap.metadata?.fromCache || !fixtureIdentity) refreshFixtureIdentity();
    render();
  }, (error) => {
    if (expectedMatchVersion !== matchContextVersion || viewState !== "operations") return;
    setDataState("official", "error", error);
    status(`공식 경기 데이터를 불러오지 못했습니다. ${recorderReason(error)}`);
    render();
  });
}
function scheduleOfficialRef(item) {
  const matchId = item?.matchId || item?.id || item?.matchKey;
  if (!matchId) return null;
  if (["final", "finals", "tournament"].includes(item.matchType) || ["final", "finals"].includes(item.phase)) {
    const divisionId = item.divisionId || item.division;
    if (!divisionId) return null;
    return doc(db, "tournaments", TOURNAMENT_ID, "divisions", divisionId, "finalMatches", matchId);
  }
  return doc(db, "tournaments", TOURNAMENT_ID, "prelimMatches", matchId);
}
function subscribeScheduleOfficialDocs(items, expectedCourtVersion, expectedScheduleVersion) {
  const expectedDetailVersion = ++scheduleDetailVersion;
  scheduleMatchStops.forEach((fn) => fn());
  scheduleMatchStops = [];
  scheduleOfficial = new Map();
  items.forEach((item) => {
    const key = item?.matchKey || item?.id;
    if (!key) return;
    const ref = scheduleOfficialRef(item);
    if (!ref) {
      scheduleOfficial.set(key, null);
      return;
    }
    scheduleMatchStops.push(onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
      if (expectedCourtVersion !== courtContextVersion || expectedScheduleVersion !== scheduleContextVersion
          || expectedDetailVersion !== scheduleDetailVersion || viewState !== "operations") return;
      scheduleOfficial.set(key, snap.exists() ? { id: snap.id, ...snap.data() } : null);
      renderCourtSchedule();
    }, (error) => {
      if (expectedCourtVersion !== courtContextVersion || expectedScheduleVersion !== scheduleContextVersion
          || expectedDetailVersion !== scheduleDetailVersion) return;
      scheduleState = "error";
      setDataState("schedule", "error", error);
      status(`코트 경기 목록을 불러오지 못했습니다. ${recorderReason(error)}`);
      renderCourtSchedule();
      renderDataState();
    }));
  });
}
function subscribeCourtSchedule(expectedCourtVersion) {
  const expectedScheduleVersion = ++scheduleContextVersion;
  setDataState("schedule", "loading");
  scheduleState = "loading";
  scheduleStops.push(subscribeCourtAssignments(courtId, (items, metadata) => {
    if (expectedCourtVersion !== courtContextVersion || expectedScheduleVersion !== scheduleContextVersion
        || viewState !== "operations") return;
    courtAssignments = Array.isArray(items)
      ? items.filter((item) => item?.courtId === courtId).map((item) => ({ ...item }))
      : [];
    setSnapshotState("schedule", metadata);
    scheduleState = metadata?.fromCache ? "loading" : "ready";
    subscribeScheduleOfficialDocs(courtAssignments, expectedCourtVersion, expectedScheduleVersion);
    renderCourtSchedule();
    renderDataState();
  }, (error) => {
    if (expectedCourtVersion !== courtContextVersion || expectedScheduleVersion !== scheduleContextVersion) return;
    courtAssignments = [];
    scheduleOfficial = new Map();
    scheduleState = "error";
    setDataState("schedule", "error", error);
    status(`코트 경기 목록을 불러오지 못했습니다. ${recorderReason(error)}`);
    renderCourtSchedule();
    renderDataState();
  }));
}
function followCourtQueue() {
  // A successful submit advances the live queue before its RPC may resolve.
  // Keep its confirmation and retry context until that response is reconciled.
  if (edit.pendingSubmit && operationContextIsCurrent(edit.pendingSubmit)) return;
  if (queue?.currentMatchKey && queue.currentMatchKey !== matchKey) {
    attachMatch(queue.currentMatchKey);
  } else if (!queue?.currentMatchKey && !edit.token && (!edit.pendingSubmit || !assignment)) {
    clearCurrentMatch();
  }
}
function subscribeCourtStreams(expectedCourtVersion = courtContextVersion) {
  setDataState("queue", "loading");
  setDataState("court", "loading");
  courtStops.push(onSnapshot(doc(db,"tournaments",TOURNAMENT_ID,"courtQueues",courtId), { includeMetadataChanges: true }, (snap) => {
    if (expectedCourtVersion !== courtContextVersion || viewState !== "operations") return;
    setSnapshotState("queue", snap.metadata);
    queue = snap.exists() ? {id:snap.id,...snap.data()} : null;
    followCourtQueue();
    render();
  }, (error) => {
    if (expectedCourtVersion !== courtContextVersion) return;
    queue = null;
    setDataState("queue", "error", error);
    status(`코트 대기열을 불러오지 못했습니다. ${recorderReason(error)}`);
    render();
  }));
  courtStops.push(subscribeCourt(courtId, (court, metadata) => {
    if (expectedCourtVersion !== courtContextVersion || viewState !== "operations") return;
    setSnapshotState("court", metadata);
    renderCourtSelectors();
    render();
  }, (error) => {
    if (expectedCourtVersion !== courtContextVersion) return;
    setDataState("court", "error", error);
    status(`코트 정보를 불러오지 못했습니다. ${recorderReason(error)}`);
    render();
  }));
  subscribeCourtSchedule(expectedCourtVersion);
}
function attachCourt(value) {
  const nextCourtVersion = ++courtContextVersion;
  viewState = recorderRouteState(viewState, value ? "enter" : "change", { canEnter: Boolean(value), blocked: false });
  courtStops.forEach((fn) => fn()); courtStops = [];
  stopScheduleStreams();
  matchStops.forEach((fn) => fn()); matchStops = []; officialStop(); officialStop = () => {};
  matchContextVersion += 1;
  bumpContext();
  activeStorageKey = "";
  fixtureIdentity = null;
  courtId = value || "";
  if (value) pendingCourtId = value;
  queue = null;
  matchKey = ""; assignment = workflow = official = null;
  setDataState("queue", "idle");
  setDataState("court", "idle");
  setDataState("schedule", "idle");
  setDataState("assignment", "idle");
  setDataState("workflow", "idle");
  setDataState("official", "idle");
  if (ui.workflowPanel) ui.workflowPanel.hidden = !value;
  if (ui.successPanel) ui.successPanel.hidden = true;
  renderCourtSelectors();
  if (!value) {
    clearCurrentMatch();
    render();
    return;
  }
  subscribeCourtStreams(nextCourtVersion);
  render();
}
function subscribeReadyCollections() {
  const expectedReadyVersion = ++readyContextVersion;
  stop.forEach((fn) => fn()); stop = [];
  ["courts", "teams", "groups"].forEach((key) => setDataState(key, "loading"));
  stop.push(onSnapshot(collection(db,"tournaments",TOURNAMENT_ID,"courts"), { includeMetadataChanges: true }, (snap) => {
    if (expectedReadyVersion !== readyContextVersion || authState?.kind !== "ready") return;
    setSnapshotState("courts", snap.metadata);
    courts=snap.docs.map((item)=>({id:item.id,...item.data()}));
    renderCourtSelectors();
    render();
  }, (error) => {
    if (expectedReadyVersion !== readyContextVersion) return;
    setDataState("courts", "error", error); status(`코트 목록을 불러오지 못했습니다. ${recorderReason(error)}`); render();
  }));
  stop.push(onSnapshot(collection(db,"tournaments",TOURNAMENT_ID,"teams"), { includeMetadataChanges: true }, (snap) => {
    if (expectedReadyVersion !== readyContextVersion || authState?.kind !== "ready") return;
    setSnapshotState("teams", snap.metadata);
    teams=new Map(snap.docs.map((item)=>[item.id,{id:item.id,...item.data()}]));
    if (!snap.metadata?.fromCache || !fixtureIdentity) refreshFixtureIdentity();
    render();
  }, (error) => {
    if (expectedReadyVersion !== readyContextVersion) return;
    setDataState("teams", "error", error); status(`팀 목록을 불러오지 못했습니다. ${recorderReason(error)}`); render();
  }));
  stop.push(onSnapshot(collection(db,"tournaments",TOURNAMENT_ID,"groups"), { includeMetadataChanges: true }, (snap) => {
    if (expectedReadyVersion !== readyContextVersion || authState?.kind !== "ready") return;
    setSnapshotState("groups", snap.metadata);
    groups=new Map(snap.docs.map((item)=>[item.id,{id:item.id,...item.data()}])); render();
  }, (error) => {
    if (expectedReadyVersion !== readyContextVersion) return;
    setDataState("groups", "error", error); status(`조 목록을 불러오지 못했습니다. ${recorderReason(error)}`); render();
  }));
}
function startReady() {
  stopAll();
  subscribeReadyCollections();
  if (courtId && viewState === "operations") {
    setDataState("assignment", "idle");
    setDataState("workflow", "idle");
    setDataState("official", "idle");
    subscribeCourtStreams();
    if (matchKey) attachMatch(matchKey);
  }
}
function stopHeartbeat() {
  heartbeatEpoch += 1;
  heartbeat?.stop();
  heartbeat = null;
}
function beginHeartbeat() {
  stopHeartbeat();
  const context = captureContext();
  const token = edit.token;
  const epoch = heartbeatEpoch;
  heartbeat = startLeaseHeartbeat({
    matchKey: context.matchKey,
    token,
    queueRevision: queue?.queueRevision,
    onRenew: () => {},
    onError: (error) => {
      if (epoch !== heartbeatEpoch || !contextIsCurrent(context) || edit.token !== token) return;
      if ([edit.pendingSubmit, edit.pendingEnd, edit.pendingDiscard]
        .some((operation) => operation?.matchKey === context.matchKey && operation?.token === token)) return;
      if (["ownership_lost", "lease_expired"].includes(reasonCode(error))) {
        edit.token = null;
        renderedFormKey = "";
        if (edit.dirty) {
          setOwnershipLostWarning(context.matchKey, token, {
            identity: context.fixtureIdentity,
            storageKey: context.storageKey,
          });
        }
        else status(recorderReason(error));
        render();
      } else status(recorderReason(error));
    },
  });
}
function channelMessage(message) {
  if (message.instance === tabInstanceId) return;
  if (message.type === "probe" && message.session === recorderSessionId()) {
    channel?.postMessage({ type: "collision", target: message.instance, instance: tabInstanceId });
    return;
  }
  if (message.type === "collision" && message.target === tabInstanceId) {
    rotateRecorderSessionId();
    status("복제된 탭을 감지해 이 탭에 새 입력 세션을 만들었습니다.");
    return;
  }
  if (message.type === "claimed" && message.matchKey === matchKey && message.session !== recorderSessionId()) {
    status("다른 탭에서도 이 경기 입력을 열었습니다. 저장 전 초안을 확인하세요.");
  }
}
watchRecorderAuthState((state) => {
  const authKindChanged = state.kind !== lastAuthKind;
  lastAuthKind = state.kind;
  authState = state; ui.logoutButton.hidden = !state.user; ui.identity.hidden = !state.user; ui.identity.textContent = state.user ? `${state.user.displayName || "기록관"} · ${state.user.email || ""} · ${state.codeSource || "Google 로그인"}` : "";
  const copy = {loading:"권한을 확인하고 있습니다.",signedOut:"Google 로그인 후 대회 공용 코드를 입력하세요.",wrongProvider:"Google 계정으로 전환하세요.",codeRequired:"대회 공용 코드를 입력하세요.",staleGrant:"접근 권한이 만료되었거나 변경되었습니다. 코드를 다시 입력하세요.",disabled:"기록관 입력이 비활성화되었습니다.",maintenance:"대회 점검 중입니다.",offline:"오프라인입니다. 연결 후 권한을 다시 확인하세요.",error:"권한을 불러오지 못했습니다."};
  const transientWhileReady = readyUid === state.user?.uid && ["loading", "offline"].includes(state.kind);
  if (transientWhileReady) {
    ui.authPanel.hidden = true;
    ui.courtPanel.hidden = false;
    applyActionGate();
    if (state.kind === "offline" && edit.dirty) {
      const stored = storeDraft();
      status(stored ? "오프라인 · 로컬 초안을 보관했습니다." : "오프라인 · 로컬 초안을 저장할 수 없습니다. 화면을 닫지 마세요.");
    } else status(state.kind === "offline" ? "오프라인입니다." : "연결을 다시 확인하고 있습니다.");
    return;
  }
  ui.authMessage.textContent = copy[state.kind] || "기록관 권한이 확인되었습니다."; ui.authPanel.hidden = state.kind === "ready"; ui.courtPanel.hidden = state.kind !== "ready"; ui.googleLoginButton.hidden = !["signedOut","wrongProvider","codeRequired","staleGrant"].includes(state.kind); ui.googleLoginButton.textContent = state.user ? "다른 Google 계정 사용" : "Google로 로그인 / 계정 선택"; ui.accessCodeForm.hidden = !["codeRequired","staleGrant"].includes(state.kind);
  if (state.kind === "ready" && !busy) setBusy(false);
  if (state.kind === "ready" && readyUid !== state.user.uid) {
    bumpContext();
    if (readyUid && readyUid !== state.user.uid) {
      resetMatchEditor();
      edit.pendingSubmit = null;
      edit.pendingEnd = null;
      edit.pendingDiscard = null;
      edit.dirty = false;
      activeStorageKey = "";
      viewState = "selection";
      courtId = "";
      pendingCourtId = "";
      queue = null;
      matchKey = "";
      fixtureIdentity = null;
      assignment = workflow = official = null;
      courts = [];
      teams = new Map();
      groups = new Map();
    }
    readyUid = state.user.uid;
    startReady();
  }
  if (state.kind !== "ready" && readyUid) {
    bumpContext();
    stopAll();
    Object.keys(dataHealth).forEach((key) => setDataState(key, "idle"));
    if (!state.user) {
      clearStored();
      resetMatchEditor();
      edit.pendingEnd = null;
      edit.pendingDiscard = null;
      edit.dirty = false;
      activeStorageKey = "";
      fixtureIdentity = null;
    }
    edit.token=null;
    viewState = "selection";
    courtId = "";
    pendingCourtId = "";
    queue = null;
    matchKey = "";
    fixtureIdentity = null;
    assignment = workflow = official = null;
    courts = [];
    teams = new Map();
    groups = new Map();
    readyUid = null;
  }
  render();
  if (authKindChanged && !edit.token) focus(state.kind === "ready" ? ui.courtPanel.querySelector("h2") : ui.authTitle);
});
window.addEventListener("online", () => { status("온라인"); heartbeat?.start(); heartbeat?.reconcile(); applyActionGate(); render(); });
window.addEventListener("offline", () => {
  status("오프라인");
  heartbeat?.stop();
  if (edit.dirty) {
    const stored = storeDraft();
    action(stored ? "오프라인 · 로컬 초안을 보관했습니다." : "오프라인 · 로컬 초안을 저장할 수 없습니다. 화면을 닫지 마세요.");
  }
  applyActionGate();
});
status(navigator.onLine ? "온라인" : "오프라인");
document.addEventListener("visibilitychange", () => { if(document.hidden) heartbeat?.stop(); else { heartbeat?.start(); heartbeat?.reconcile(); } });
window.addEventListener("beforeunload", (event) => { if(edit.dirty || edit.pendingSubmit || edit.pendingEnd || edit.pendingDiscard) { event.preventDefault(); event.returnValue="완료되지 않은 기록관 작업이 있습니다."; } });
channel = "BroadcastChannel" in window ? new BroadcastChannel(`recorder:${TOURNAMENT_ID}`) : null; channel?.addEventListener("message", (event) => channelMessage(event.data));
channel?.postMessage({ type: "probe", session: recorderSessionId(), instance: tabInstanceId });
ui.googleLoginButton.onclick=async()=>{setBusy(true);try{await loginWithGoogle();}catch(error){ui.authMessage.textContent=describeRecorderAuthError(error);}finally{setBusy(false);}};
ui.accessCodeForm.onsubmit=async(event)=>{event.preventDefault();setBusy(true);try{await exchangeRecorderAccessCode(ui.accessCode.value);ui.accessCode.value="";}catch(error){ui.authMessage.textContent=describeRecorderAuthError(error);}finally{setBusy(false);}};
ui.logoutButton.onclick=async()=>{
  if ((edit.dirty || edit.token) && !window.confirm("로그아웃하면 현재 경기 잠금과 서버에 저장한 초안은 유지됩니다. 저장하지 않은 이 기기 초안은 삭제됩니다. 계속할까요?")) return;
  clearStored();
  await logoutRecorder();
};
ui.courtSelect.onchange=()=>{
  if (selectorLocked()) {
    renderCourtSelectors();
    return;
  }
  pendingCourtId = ui.courtSelect.value || "";
  recorder = "";
  renderCourtSelectors({ resetRecorder: true });
  render();
  focus(ui.recorderSelect);
};
ui.recorderSelect.onchange=()=>{
  if (selectorLocked()) {
    renderCourtSelectors();
    return;
  }
  const selection = reconcileRecorderSelections(courts, ui.courtSelect.value, ui.recorderSelect.value);
  recorder = selection.recorder;
  ui.recorderSelect.value = recorder;
  renderCourtSelectors();
  render();
};
if (ui.enterCourtButton) ui.enterCourtButton.onclick=()=>{
  if (selectorLocked()) {
    renderCourtSelectors();
    return;
  }
  const selection = reconcileRecorderSelections(courts, ui.courtSelect?.value || pendingCourtId, ui.recorderSelect?.value || recorder);
  if (!selection.courtId || !selection.recorder) {
    action("코트와 담당 기록관 이름을 모두 선택한 뒤 들어가세요.");
    return;
  }
  pendingCourtId = selection.courtId;
  recorder = selection.recorder;
  viewState = recorderRouteState(viewState, "enter", { canEnter: true });
  attachCourt(selection.courtId);
  focus(ui.courtScheduleHeading || ui.workflowTitle);
};
if (ui.changeCourtButton) ui.changeCourtButton.onclick=()=>{
  const blocked = busy || Boolean(edit.token || edit.pendingSubmit || edit.pendingSave || edit.pendingEnd || edit.pendingDiscard || edit.dirty);
  if (blocked) {
    action("현재 경기 입력을 먼저 제출하거나 입력 종료/초안 폐기까지 마친 뒤 코트를 변경하세요. 저장하지 않은 점수는 버리지 않습니다.");
    return;
  }
  pendingCourtId = courtId;
  viewState = recorderRouteState(viewState, "change", { blocked: false });
  attachCourt("");
  action("코트와 담당 기록관 이름을 다시 선택하세요.");
  focus(ui.courtSelect);
};
async function persistDraft(score, context = captureContext()) {
  if (!score || !contextIsCurrent(context) || !actionsReady() || !edit.token) return false;
  const attemptedDraft = draftCopy(score);
  if (!attemptedDraft) return false;
  const pending = {
    context,
    draft: attemptedDraft,
    expectedRevision: edit.savedRevision,
    inputVersion: edit.inputVersion,
    touched: new Set(edit.touched),
    fixtureIdentity: cloneRecorderFixtureIdentity(context.fixtureIdentity),
  };
  edit.pendingSave = pending;
  edit.saveConflict = null;
  setBusy(true);
  action("저장 중");
  try {
    const result = await saveRecorderDraft({
      matchKey: context.matchKey,
      token: edit.token,
      queueRevision: queue?.queueRevision,
      draft: attemptedDraft,
      expectedDraftRevision: pending.expectedRevision,
      final: isFinal(),
    });
    if (!contextIsCurrent(context) || edit.pendingSave !== pending) return false;
    if (!Number.isInteger(result?.draftRevision)) throw Object.assign(new Error("저장 결과를 확인할 수 없습니다."), { code: "unknown" });
    edit.pendingSave = null;
    edit.saveConflict = null;
    edit.serverDraft = attemptedDraft;
    edit.savedRevision = result.draftRevision;
    const changedSinceSave = edit.inputVersion !== pending.inputVersion;
    if (!changedSinceSave) {
      edit.localDraft = attemptedDraft;
      edit.dirty = false;
      edit.touched.clear();
      const cleared = clearStored();
      action(cleared
        ? `저장됨 ${new Date().toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}`
        : "저장됨 · 임시 저장 정리에 실패했습니다.");
    } else {
      edit.dirty = true;
      const stored = storeDraft();
      action(stored ? "저장됨 · 이후 변경은 미저장입니다." : "저장됨 · 이후 변경을 별도로 기록하세요.");
    }
    return true;
  } catch(error) {
    if (!contextIsCurrent(context) || edit.pendingSave !== pending) return false;
    const ambiguous = ambiguousNetworkResult(error);
    const stale = reasonCode(error) === "stale_revision" || /stale_revision/.test(String(error?.message || ""));
    if (ambiguous || stale) {
      try {
        const reconciliationStatus = await reconcileFreshWorkflow(pending);
        if (reconciliationStatus === "confirmed" || reconciliationStatus === "conflict") {
          ui.scoreError.textContent = "";
          return reconciliationStatus === "confirmed";
        }
      } catch (refreshError) {
        status(`최신 서버 초안을 확인하지 못했습니다. ${recorderReason(refreshError)}`);
      }
      if (!contextIsCurrent(context) || edit.pendingSave !== pending) return false;
    }
    if (!ambiguous && !stale) edit.pendingSave = null;
    const changedSinceSave = edit.inputVersion !== pending.inputVersion;
    const localDraft = changedSinceSave ? draftCopy(edit.localDraft) : attemptedDraft;
    const touched = changedSinceSave ? [...edit.touched] : [...pending.touched];
    const stored = writeStoredRecorderDraft(getLocalStorage(), context.storageKey, {
      draft: localDraft,
      touched,
      revision: pending.expectedRevision,
      identity: context.fixtureIdentity,
    });
    if (!stored.ok) setStorageStatus(stored.reason);
    else clearStorageStatus();
    action(stored.ok
      ? (ambiguous || stale ? "최신 서버 초안 확인 중 · 로컬 초안을 보관했습니다." : "저장 실패 · 로컬 초안을 보관했습니다.")
      : "저장 실패 · 이 화면의 점수를 별도로 기록하세요.");
    ui.scoreError.textContent = recorderReason(error);
    return false;
  } finally {
    if (contextIsCurrent(context)) {
      setBusy(false);
      render();
    }
  }
}
ui.claimButton.onclick=async()=>{
  if(!matchKey||busy||edit.pendingSubmit||!courtId||!recorder||!actionsReady())return;
  if (isStaleTerminalCurrent()) {
    reconcilingQueue = true;
    render();
    try {
      const result = await reconcileRecorderCourtQueue({
        courtId,
        staleMatchKey: matchKey,
        recorderName: recorder,
        expectedQueueRevision: queue.queueRevision,
      });
      status(result.currentMatchKey ? "다음 경기를 불러왔습니다." : "현재 대기 중인 다음 경기가 없습니다.");
    } catch (error) {
      status(recorderReason(error));
    } finally {
      reconcilingQueue = false;
      render();
    }
    return;
  }
  const context = captureContext();
  if (!context.fixtureIdentity) {
    action("현재 경기의 공식 식별 정보를 확인한 뒤 다시 시도하세요.");
    return;
  }
  setBusy(true);
  try {
    const fn=canResumeCurrentMatch(workflow,recorder)?resumeRecorderDraft:claimRecorderDraft;
    let result;
    try {
      result=await fn({matchKey,courtId,queueRevision:queue.queueRevision,recorderName:recorder});
    } catch(error) {
      if (workflow?.lock?.uid === auth.currentUser?.uid && reasonCode(error) === "ownership_lost"
          && window.confirm("다른 탭에서 이 경기 입력을 열고 있습니다. 그 탭의 입력권을 이어받을까요? 다른 탭의 저장되지 않은 값은 자동으로 삭제되지 않습니다.")) {
        result=await fn({matchKey,courtId,queueRevision:queue.queueRevision,recorderName:recorder,takeover:true});
      } else throw error;
    }
    if (!contextIsCurrent(context)) return;
    edit.token=result.token;
    edit.serverDraft=draftCopy(result.draft);
    edit.localDraft=edit.serverDraft;
    edit.savedRevision=result.draftRevision;
    edit.pendingSave=null;
    edit.saveConflict=null;
    edit.touched.clear();
    edit.dirty=false;
    fixtureIdentity = cloneRecorderFixtureIdentity(context.fixtureIdentity);
    activeStorageKey = scoreKey();
    const saved=readStored();
    restoreStoredAfterClaim(saved, fixtureIdentity, result.draftRevision);
    channel?.postMessage({type:"claimed",matchKey,session:recorderSessionId(),instance:tabInstanceId});
    beginHeartbeat(); renderedFormKey=""; render(); navigateToWorkflowEntry(context, edit.token);
  } catch(error) {
    if (contextIsCurrent(context)) status(recorderReason(error));
  } finally {
    if (contextIsCurrent(context)) setBusy(false);
  }
};
ui.scoreForm.onsubmit=async(event)=>{
  event.preventDefault();
  if (busy || !actionsReady() || edit.pendingSave || edit.saveConflict) return;
  const check=validate(false);
  ui.scoreError.textContent=check.ok?"":check.message;
  if(!check.ok)return;
  await persistDraft(check.score);
};
ui.retrySaveButton.onclick=async()=>{
  if (busy || !edit.pendingSave || !actionsReady()) return;
  const pending = edit.pendingSave;
  await persistDraft(pending.draft, pending.context);
};
ui.keepLocalButton.onclick=async()=>{
  if (busy || !edit.saveConflict || !actionsReady()) return;
  const resolution = resolveRecorderConflict("local", {
    ...edit.saveConflict,
    localDraft: draftCopy(edit.localDraft) || edit.saveConflict.localDraft,
  });
  if (resolution.status !== "retry") return;
  edit.savedRevision = resolution.expectedRevision;
  edit.serverDraft = draftCopy(edit.saveConflict.remoteDraft);
  edit.localDraft = draftCopy(resolution.draft);
  edit.dirty = true;
  edit.pendingSave = null;
  edit.saveConflict = null;
  const stored = storeDraft();
  action(stored ? "로컬 초안을 유지합니다. 다시 저장하세요." : "로컬 초안을 유지합니다. 화면의 점수를 별도로 기록하세요.");
  render();
};
ui.useServerButton.onclick=()=>{
  if (busy || !edit.saveConflict || !actionsReady()) return;
  const resolution = resolveRecorderConflict("remote", edit.saveConflict);
  if (resolution.status !== "use_remote") return;
  edit.serverDraft = resolution.draft;
  edit.localDraft = resolution.draft;
  edit.savedRevision = resolution.revision;
  edit.dirty = false;
  edit.inputVersion += 1;
  edit.touched.clear();
  edit.pendingSave = null;
  edit.saveConflict = null;
  const cleared = clearStored();
  action(cleared ? "서버의 최신 초안을 사용합니다." : "서버 초안을 사용했지만 임시 저장 정리에 실패했습니다.");
  renderedFormKey = "";
  render();
  focus(ui.scoreFields.querySelector("input"));
};
ui.retryDataButton.onclick=()=>{
  if (busy || !readyUid) return;
  subscribeReadyCollections();
  if (courtId && viewState === "operations") {
    courtContextVersion += 1;
    stopScheduleStreams();
    courtStops.forEach((fn) => fn());
    courtStops = [];
    queue = null;
    subscribeCourtStreams(courtContextVersion);
  }
  if (matchKey && viewState === "operations") attachMatch(matchKey);
  render();
};
ui.reviewButton.onclick=()=>{
  if (!actionsReady() || busy || edit.pendingSave || edit.saveConflict) return;
  const check=validate(true);
  ui.scoreError.textContent=check.ok?"":check.message;
  if(!check.ok)return;
  edit.reviewedPayload=Object.freeze(JSON.parse(JSON.stringify(check.score)));
  const court = courts.find((item) => item.id === courtId);
  const view = courtMatchSummary(assignment, official, { teamsById: teams, groupsById: groups });
  const confirmation = buildRecorderConfirmationModel({
    court: displayCourt(court),
    recorder,
    matchLabel: view.label || matchKey,
    teamA: name("a"),
    teamB: name("b"),
    score: edit.reviewedPayload,
    outcome: confirmationOutcome(edit.reviewedPayload),
  });
  renderConfirmation(confirmation);
  render();
  focus(ui.confirmTitle);
};
ui.backToEditButton.onclick=()=>{edit.reviewedPayload=null;clearConfirmation();render();focus(ui.scoreFields.querySelector("input"));};
ui.submitButton.onclick=async()=>{
  if (busy || (!edit.reviewedPayload && !edit.pendingSubmit) || !actionsReady()) return;
  const submittedMatchKey = matchKey;
  const submittedCourtId = courtId;
  const submittedConfirmation = edit.reviewedPayload;
  let pending = edit.pendingSubmit;
  if (!pending) {
    pending = buildRecorderSubmitContext({
      matchKey: submittedMatchKey,
      courtId: submittedCourtId,
      token: edit.token,
      queueRevision: queue?.queueRevision,
      score: edit.reviewedPayload,
      final: isFinal(),
      operationId: operationId(),
      storageKey: storageKeyForEdit(),
      submissionVersion: workflow?.submissionVersion,
      fixtureIdentity: currentFixtureIdentity(),
      contextVersion,
    });
    if (!pending) return;
    edit.pendingSubmit = pending;
  }
  setBusy(true);
  try {
    await submitRecorderDraft(pending);
    if (edit.pendingSubmit !== pending) return;
    clearVerifiedOperationWarning(pending);
    clearSubmissionWarning(pending);
    const completion = reconcileRecorderSubmit({
      pendingSubmit: pending,
      currentMatchKey: matchKey,
      currentFixtureIdentity: currentFixtureIdentity(),
      currentContextVersion: contextVersion,
      outcome: "success",
    });
    edit.pendingSubmit = completion.pendingSubmit;
    if (edit.reviewedPayload === submittedConfirmation) {
      edit.reviewedPayload = null;
      clearConfirmation();
    }
    ui.successTitle.textContent = `제출 완료 · ${draftTeamPair(pending.fixtureIdentity)}`;
    ui.successPanel.hidden = false;
    if (completion.status === "completed_stale") {
      const preserved = preserveStoredRecorderDraft(getLocalStorage(), pending.storageKey, {
        draft: pending.score,
        touched: [],
        revision: 0,
        identity: pending.fixtureIdentity,
      });
      if (!preserved.ok) setStorageStatus(preserved.reason);
      if (!edit.token && !edit.dirty && !edit.reviewedPayload && !edit.pendingSave
          && !edit.pendingEnd && !edit.pendingDiscard && viewState === "operations"
          && authActionsReady() && dataHealth.queue?.status === "ready") {
        followCourtQueue();
      }
      return;
    }
    const cleared = clearStoredKey(completion.clearStorageKey, pending.fixtureIdentity);
    if (completion.resetCurrent) {
      resetMatchEditor();
      ui.scoreError.textContent = "";
      followCourtQueue();
      action(cleared ? "제출 완료" : "제출 완료 · 임시 저장 정리에 실패했습니다.");
      focus(ui.successTitle);
    }
  } catch(error) {
    const ambiguous = ambiguousNetworkResult(error);
    if (!operationContextIsCurrent(pending)) {
      if (!ambiguous && edit.pendingSubmit === pending) edit.pendingSubmit = null;
      if (!preserveOwnershipWarning(pending)) {
        showSubmissionWarning(pending, "이전 경기 제출 응답을 확인하지 못했습니다. 현재 경기 입력은 변경하지 않았습니다.");
      }
      return;
    }
    reconcileFailedOperationOwnership("submit", pending, ambiguous);
    if (!ambiguous && edit.pendingSubmit === pending) {
      edit.pendingSubmit = null;
      if (pending.matchKey !== matchKey) {
        edit.reviewedPayload = null;
        clearConfirmation();
      }
    }
    ui.scoreError.textContent = recorderReason(error);
    if (!ambiguous && queue && dataHealth.queue?.status === "ready"
        && queue.currentMatchKey !== pending.matchKey) {
      if (edit.localDraft && !storeDraft()) {
        showSubmissionWarning(pending, "제출하지 못했고 임시 초안도 보관하지 못했습니다. 화면을 닫지 말고 입력한 점수를 별도로 기록하세요.");
        return;
      }
      resetMatchEditor();
      followCourtQueue();
      ui.scoreError.textContent = "";
      showSubmissionWarning(pending, `${draftTeamPair(pending.fixtureIdentity)} 제출 실패: ${recorderReason(error)} 입력은 임시 초안으로 보관하고 현재 경기 목록을 갱신했습니다.`);
      return;
    }
    const submitStatus = ambiguous
      ? "제출 여부를 확인하지 못했습니다. ‘점수 제출’을 다시 눌러 확인하세요."
      : `${recorderReason(error)} 점수를 수정하거나 현재 경기 상태를 다시 불러오세요.`;
    if (ambiguous && ui.confirmOutcome) ui.confirmOutcome.textContent = `제출 상태: ${submitStatus}`;
    if (!preserveOwnershipWarning(pending)) showSubmissionWarning(pending, submitStatus);
  } finally {
    setBusy(false);
    fenceAmbiguousOperation();
    render();
  }
};
ui.endButton.onclick=async()=>{
  if (!actionsReady()) return;
  edit.pendingEnd ||= {
    matchKey,
    courtId,
    token: edit.token,
    queueRevision: queue?.queueRevision,
    discardDraft: false,
    operationId: operationId(),
    draft: draftCopy(edit.serverDraft),
    storageKey: storageKeyForEdit(),
    fixtureIdentity: currentFixtureIdentity(),
    context: captureContext(),
  };
  const pending = edit.pendingEnd;
  setBusy(true);
  try {
    await cancelRecorderDraft(pending);
    if (edit.pendingEnd !== pending) return;
    if (!operationContextIsCurrent(pending)) {
      edit.pendingEnd = null;
      status("이전 경기 입력 종료 응답을 확인했습니다. 현재 경기 입력은 변경하지 않았습니다.");
      return;
    }
    clearVerifiedOperationWarning(pending);
    const keepOwnershipWarning = preserveOwnershipWarning(pending);
    edit.pendingEnd = null;
    edit.token = null;
    edit.reviewedPayload = null;
    clearConfirmation();
    stopHeartbeat();
    if (!keepOwnershipWarning) status("입력을 종료했습니다. 초안은 보관됩니다.");
    focus(ui.workflowTitle);
  } catch (error) {
    const ambiguous = ambiguousNetworkResult(error);
    if (!operationContextIsCurrent(pending)) {
      if (!ambiguous && edit.pendingEnd === pending) edit.pendingEnd = null;
      status("이전 경기 입력 종료 응답을 확인했습니다. 현재 경기 입력은 변경하지 않았습니다.");
      return;
    }
    reconcileFailedOperationOwnership("end", pending, ambiguous);
    if (!ambiguous && edit.pendingEnd === pending) edit.pendingEnd = null;
    if (!preserveOwnershipWarning(pending)) {
      status(ambiguous
        ? `${recorderReason(error)} 같은 종료 요청으로 결과를 다시 확인하세요.`
        : recorderReason(error));
    }
  } finally {
    setBusy(false);
    fenceAmbiguousOperation();
    render();
  }
};
ui.discardButton.onclick=()=>{ui.discardMessage.textContent=`${name("a")} 대 ${name("b")} 경기의 저장 초안을 삭제합니다. 이 작업은 되돌릴 수 없습니다.`;ui.discardPanel.hidden=false;focus(ui.keepDraftButton);};
ui.keepDraftButton.onclick=()=>{ui.discardPanel.hidden=true;focus(ui.scoreFields.querySelector("input"));};
ui.confirmDiscardButton.onclick=async()=>{
  if (!actionsReady()) return;
  edit.pendingDiscard ||= {
    matchKey,
    courtId,
    token: edit.token,
    queueRevision: queue?.queueRevision,
    discardDraft: true,
    operationId: operationId(),
    draft: draftCopy(edit.serverDraft),
    storageKey: storageKeyForEdit(),
    fixtureIdentity: currentFixtureIdentity(),
    context: captureContext(),
  };
  const pending = edit.pendingDiscard;
  setBusy(true);
  try {
    await cancelRecorderDraft(pending);
    if (edit.pendingDiscard !== pending) return;
    if (!operationContextIsCurrent(pending)) {
      edit.pendingDiscard = null;
      status("이전 경기 초안 폐기 응답을 확인했습니다. 현재 경기 입력은 변경하지 않았습니다.");
      return;
    }
    clearVerifiedOperationWarning(pending);
    const keepOwnershipWarning = preserveOwnershipWarning(pending);
    edit.pendingDiscard = null;
    const cleared = clearStored();
    edit.token = null;
    edit.dirty = false;
    edit.reviewedPayload = null;
    edit.localDraft = null;
    edit.serverDraft = null;
    edit.touched.clear();
    renderedFormKey = "";
    clearConfirmation();
    ui.scoreFields.replaceChildren(ui.scoreLegend);
    stopHeartbeat();
    ui.discardPanel.hidden = true;
    if (!keepOwnershipWarning) {
      status(cleared ? "초안을 폐기했습니다." : "초안을 폐기했지만 임시 저장 정리에 실패했습니다.");
    }
    focus(ui.workflowTitle);
  } catch (error) {
    const ambiguous = ambiguousNetworkResult(error);
    if (!operationContextIsCurrent(pending)) {
      if (!ambiguous && edit.pendingDiscard === pending) edit.pendingDiscard = null;
      status("이전 경기 초안 폐기 응답을 확인했습니다. 현재 경기 입력은 변경하지 않았습니다.");
      return;
    }
    reconcileFailedOperationOwnership("discard", pending, ambiguous);
    if (!ambiguous && edit.pendingDiscard === pending) edit.pendingDiscard = null;
    if (!preserveOwnershipWarning(pending)) {
      status(ambiguous
        ? `${recorderReason(error)} 같은 폐기 요청으로 결과를 다시 확인하세요.`
        : recorderReason(error));
    }
  } finally {
    setBusy(false);
    fenceAmbiguousOperation();
    render();
  }
};

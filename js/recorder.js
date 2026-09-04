import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";
import { describeRecorderAuthError, exchangeRecorderAccessCode, loginWithGoogle, logoutRecorder, watchRecorderAuthState } from "./recorder-auth-service.js";
import { TOURNAMENT_ID } from "./firebase-config.js";
import {
  canResumeCurrentMatch, claimRecorderDraft, recorderReason, resumeRecorderDraft, saveRecorderDraft,
  submitRecorderDraft, cancelRecorderDraft, operationId, recorderSessionId, rotateRecorderSessionId,
  startLeaseHeartbeat, subscribeAssignment, subscribeCourt, subscribeWorkflow,
} from "./workflow-service.js";
import { evaluateFinalMatch, evaluatePrelimMatch, finalNeedsThirdSet, normalizePlayedSets, validateSetScore } from "./match-logic.js";
import { courtMatchSummary, courtTeamNames, formatCourtName } from "./court-display.js";

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(["logoutButton","connectionStatus","actionStatus","authPanel","authTitle","authMessage","identity","googleLoginButton","accessCodeForm","accessCode","accessCodeButton","courtPanel","courtTitle","courtSelect","courtMessage","workflowPanel","workflowTitle","matchSummary","rejectionNotice","lockNotice","claimButton","scoreForm","scoreFields","scoreLegend","scoreError","saveButton","reviewButton","endButton","discardButton","discardPanel","discardTitle","discardMessage","keepDraftButton","confirmDiscardButton","confirmPanel","confirmTitle","confirmScore","backToEditButton","submitButton","successPanel","successTitle","nextSameButton","switchRecorderButton"].map((id) => [id, $(id)]));
let courts = [], queue, assignment, workflow, official, teams = new Map(), groups = new Map(), courtId = "", recorder = "", matchKey = "", busy = false, authState, readyUid = null, lastAuthKind = "";
let stop = [], courtStops = [], matchStops = [], officialStop = () => {}, heartbeat, channel;
const tabInstanceId = crypto.randomUUID();
let renderedFormKey = "";
const edit = { token: null, serverDraft: null, localDraft: null, dirty: false, touched: new Set(), reviewedPayload: null, request: "idle", savedRevision: null, pendingSubmit: null, pendingEnd: null, pendingDiscard: null };
const isFinal = () => ["final", "tournament", "finals"].includes(assignment?.matchType) || ["final", "finals"].includes(assignment?.phase);
const scoreKey = () => auth.currentUser && matchKey ? `recorder-score:${TOURNAMENT_ID}:${matchKey}:${auth.currentUser.uid}` : "";
const status = (text) => { ui.connectionStatus.textContent = text; };
const action = (text) => { ui.actionStatus.textContent = text; ui.actionStatus.hidden = !text; };
const reasonCode = (error) => error?.details?.reason || error?.details?.code || "";
const ambiguousNetworkResult = (error) => /(?:unavailable|deadline-exceeded|internal|unknown)$/.test(String(error?.code || ""));
const focus = (element) => requestAnimationFrame(() => element?.focus());
const displayCourt = (court) => formatCourtName(court, "이름 없는 코트");
const name = (side) => courtTeamNames(official, teams)?.[side] || (side === "a" ? "A팀" : "B팀");
const resolved = () => assignment?.dependencyReady !== false && Boolean(official?.teamA && official?.teamB);
const draftCopy = (value) => value ? { sets: value.sets.map(({ a, b }) => ({ a, b })) } : null;
function storeDraft() { if (edit.localDraft && scoreKey()) localStorage.setItem(scoreKey(), JSON.stringify({ draft: edit.localDraft, touched: [...edit.touched], revision: edit.savedRevision })); }
function clearStored() { if (scoreKey()) localStorage.removeItem(scoreKey()); }
function setBusy(value) {
  busy = value; edit.request = value ? "pending" : "idle";
  [ui.googleLoginButton,ui.accessCodeButton,ui.claimButton,ui.saveButton,ui.reviewButton,ui.endButton,ui.discardButton,ui.confirmDiscardButton,ui.keepDraftButton,ui.backToEditButton,ui.submitButton].forEach((button) => { if (button) button.disabled = value; });
  ui.scoreFields.disabled = value; ui.scoreFields.setAttribute("aria-busy", String(value)); ui.courtSelect.disabled = value || Boolean(edit.token);
}
function fenceAmbiguousOperation() {
  if (edit.pendingSubmit) {
    ui.backToEditButton.disabled = true;
    ui.submitButton.disabled = false;
  }
  if (edit.pendingEnd) {
    ui.scoreFields.disabled = true;
    [ui.saveButton, ui.reviewButton, ui.discardButton].forEach((button) => { button.disabled = true; });
    ui.endButton.disabled = false;
  }
  if (edit.pendingDiscard) {
    ui.keepDraftButton.disabled = true;
    ui.confirmDiscardButton.disabled = false;
  }
}
function stopAll() { stop.forEach((fn) => fn()); stop = []; courtStops.forEach((fn) => fn()); courtStops = []; matchStops.forEach((fn) => fn()); matchStops = []; officialStop(); officialStop = () => {}; heartbeat?.stop(); heartbeat = null; }
function normalizeFinal(score) {
  return { sets: normalizePlayedSets(score.sets, isFinal()) };
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
    const input = (side) => { const node = document.createElement("input"); node.type = "number"; node.inputMode = "numeric"; node.min = "0"; node.max = "15"; node.value = previous.sets[i]?.[side] ?? ""; node.setAttribute("aria-label", `${i + 1}세트 ${name(side)} 점수`); node.addEventListener("input", () => { edit.dirty = true; edit.touched.add(`${i}-${side}`); edit.localDraft = { sets: formScore().sets.map((set) => ({ a: set.a, b: set.b })) }; edit.reviewedPayload = null; storeDraft(); action("미저장"); updateThird(); }); return node; };
    const a = input("a"), b = input("b"), left = document.createElement("div"), right = document.createElement("div"), colon = document.createElement("span"); left.className = right.className = "score-entry"; colon.textContent = ":"; left.append(Object.assign(document.createElement("span"), { textContent: name("a") }), a); right.append(Object.assign(document.createElement("span"), { textContent: name("b") }), b); row.append(label,left,colon,right); ui.scoreFields.append(row);
  });
  const updateThird = () => { if (!isFinal()) return; const inputs = ui.scoreFields.querySelectorAll(".score-row:nth-of-type(3) input"); const first = formScore().sets.slice(0,2).map((set) => ({ a: Number(set.a), b: Number(set.b) })); const enabled = first.every((set) => Number.isFinite(set.a) && Number.isFinite(set.b)) && finalNeedsThirdSet([...first,{a:0,b:0}]); inputs.forEach((input) => { input.disabled = !enabled; if (!enabled) input.value = ""; }); };
  updateThird(); renderedFormKey = formKey; ui.scoreForm.hidden = false;
}
function renderSummary() {
  if (!assignment) return; const view = courtMatchSummary(assignment, official, { teamsById: teams, groupsById: groups }); ui.matchSummary.textContent = `${view.label || "현재 경기"} · ${name("a")} vs ${name("b")}`;
}
function handleMatchSubscriptionError(error) {
  if (authState?.kind === "ready" && /permission-denied/.test(String(error?.code || ""))) {
    status("경기가 완료되어 다음 경기를 불러오는 중입니다.");
    return;
  }
  status(recorderReason(error));
}
function render() {
  ui.confirmPanel.hidden = !edit.reviewedPayload;
  if (!matchKey) { ui.claimButton.hidden = true; ui.scoreForm.hidden = true; return; }
  renderSummary(); const reason = workflow?.rejectionReason || workflow?.reviewReason || workflow?.rejectedReason;
  const correctingRejectedScore = workflow?.draftState === "rejected" || workflow?.resumeDraftState === "rejected";
  ui.rejectionNotice.hidden = !correctingRejectedScore; ui.rejectionNotice.textContent = reason ? `반려 사유: ${reason} · 관리자 요청을 반영해 수정한 뒤 다시 제출하세요.` : "반려됨: 점수를 수정해 다시 제출하세요.";
  const waiting = !resolved(); ui.lockNotice.hidden = !(waiting || (workflow?.lock && !edit.token)); ui.lockNotice.textContent = waiting ? "대진이 확정되기를 기다리고 있습니다. 팀과 이전 경기 결과가 확정되면 입력할 수 있습니다." : "다른 탭 또는 기록관이 입력 중입니다.";
  const resumable = canResumeCurrentMatch(workflow, recorder); ui.claimButton.hidden = Boolean(edit.token) || waiting || !(resumable || ["idle","rejected"].includes(workflow?.draftState));
  ui.claimButton.disabled = waiting; ui.claimButton.textContent = correctingRejectedScore ? "반려 점수 수정" : resumable ? "이전 작성 이어서 하기" : "경기 입력 시작";
  renderForm();
}
function attachMatch(key) {
  matchStops.forEach((fn) => fn()); matchStops = []; officialStop(); officialStop = () => {}; matchKey = key; renderedFormKey = "";
  matchStops.push(subscribeAssignment(key, (value) => { assignment = value; attachOfficial(); render(); }, handleMatchSubscriptionError));
  matchStops.push(subscribeWorkflow(key, (value) => {
    workflow = value;
    if (edit.token && (value?.lock?.token !== edit.token || value?.lock?.sessionId === undefined)) { edit.token = null; heartbeat?.stop(); if (edit.dirty) status("입력 권한을 잃었습니다. 로컬 초안은 보관되어 있습니다."); }
    const remote = value?.draft ? draftCopy(value.draft) : null;
    if (!edit.dirty && remote && value.draftRevision !== edit.savedRevision) { edit.serverDraft = remote; edit.localDraft = remote; edit.savedRevision = value.draftRevision; }
    render();
  }, handleMatchSubscriptionError));
}
function attachOfficial() {
  if (!assignment?.matchId) return;
  officialStop(); officialStop = () => {};
  const ref = assignment.matchType === "final" ? doc(db,"tournaments",TOURNAMENT_ID,"divisions",assignment.divisionId,"finalMatches",assignment.matchId) : doc(db,"tournaments",TOURNAMENT_ID,"prelimMatches",assignment.matchId);
  officialStop = onSnapshot(ref, (snap) => { official = snap.exists() ? { id:snap.id,...snap.data() } : null; render(); }, () => { official = null; render(); });
}
function attachCourt(value) {
  courtStops.forEach((fn) => fn()); courtStops = [];
  matchStops.forEach((fn) => fn()); matchStops = []; officialStop(); officialStop = () => {};
  courtId = value; matchKey = ""; assignment = workflow = official = null; ui.workflowPanel.hidden = !value; if (!value) return;
  courtStops.push(onSnapshot(doc(db,"tournaments",TOURNAMENT_ID,"courtQueues",value), (snap) => {
    queue = snap.exists() ? {id:snap.id,...snap.data()} : null;
    if (queue?.currentMatchKey && queue.currentMatchKey !== matchKey) {
      attachMatch(queue.currentMatchKey);
    } else if (!queue?.currentMatchKey && !edit.token && !edit.pendingSubmit) {
      matchStops.forEach((fn) => fn());
      matchStops = [];
      officialStop();
      officialStop = () => {};
      matchKey = "";
      assignment = workflow = official = null;
      renderedFormKey = "";
      ui.matchSummary.textContent = "현재 대기 중인 경기가 없습니다.";
      ui.lockNotice.hidden = true;
      ui.claimButton.hidden = true;
      ui.scoreForm.hidden = true;
    }
    render();
  }));
  courtStops.push(subscribeCourt(value, (court) => { recorder = court?.recorderName?.trim() || ""; ui.courtMessage.textContent = recorder ? `${recorder} · ${displayCourt(court)}` : "기록관 배정이 없습니다."; }));
}
function startReady() {
  stopAll();
  stop.push(onSnapshot(collection(db,"tournaments",TOURNAMENT_ID,"courts"), (snap) => { courts=snap.docs.map((item)=>({id:item.id,...item.data()})); ui.courtSelect.replaceChildren(new Option("이름을 선택하세요",""),...courts.filter((court)=>court.recorderName).map((court)=>new Option(`${court.recorderName} (${displayCourt(court)})`,court.id))); }));
  stop.push(onSnapshot(collection(db,"tournaments",TOURNAMENT_ID,"teams"), (snap) => { teams=new Map(snap.docs.map((item)=>[item.id,{id:item.id,...item.data()}])); render(); }));
  stop.push(onSnapshot(collection(db,"tournaments",TOURNAMENT_ID,"groups"), (snap) => { groups=new Map(snap.docs.map((item)=>[item.id,{id:item.id,...item.data()}])); render(); }));
}
function beginHeartbeat() {
  heartbeat?.stop(); heartbeat = startLeaseHeartbeat({ matchKey, token:edit.token, queueRevision:queue?.queueRevision, onRenew:() => {}, onError:(error)=>{ status(recorderReason(error)); if (["ownership_lost", "lease_expired"].includes(reasonCode(error))) { edit.token=null; renderedFormKey=""; render(); } } });
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
    ui.saveButton.disabled = true;
    ui.submitButton.disabled = true;
    ui.endButton.disabled = true;
    ui.discardButton.disabled = true;
    status(state.kind === "offline" ? "오프라인 · 입력은 이 기기에 보관됩니다." : "연결을 다시 확인하고 있습니다.");
    return;
  }
  ui.authMessage.textContent = copy[state.kind] || "기록관 권한이 확인되었습니다."; ui.authPanel.hidden = state.kind === "ready"; ui.courtPanel.hidden = state.kind !== "ready"; ui.googleLoginButton.hidden = !["signedOut","wrongProvider","codeRequired","staleGrant"].includes(state.kind); ui.googleLoginButton.textContent = state.user ? "다른 Google 계정 사용" : "Google로 로그인 / 계정 선택"; ui.accessCodeForm.hidden = !["codeRequired","staleGrant"].includes(state.kind);
  if (state.kind === "ready" && !busy) setBusy(false);
  if (state.kind === "ready" && readyUid !== state.user.uid) { readyUid = state.user.uid; startReady(); }
  if (state.kind !== "ready" && readyUid) { stopAll(); if (!state.user) clearStored(); edit.token=null; readyUid = null; }
  if (authKindChanged && !edit.token) focus(state.kind === "ready" ? ui.courtPanel.querySelector("h2") : ui.authTitle);
});
window.addEventListener("online", () => { status("온라인"); heartbeat?.start(); heartbeat?.reconcile(); });
window.addEventListener("offline", () => { status("오프라인"); heartbeat?.stop(); if(edit.dirty) action("오프라인 로컬 보관"); });
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
ui.courtSelect.onchange=()=>{recorder=courts.find((court)=>court.id===ui.courtSelect.value)?.recorderName?.trim()||"";attachCourt(ui.courtSelect.value);};
ui.claimButton.onclick=async()=>{ if(!matchKey||busy)return; setBusy(true); try { const fn=canResumeCurrentMatch(workflow,recorder)?resumeRecorderDraft:claimRecorderDraft; let result; try { result=await fn({matchKey,courtId,queueRevision:queue.queueRevision,recorderName:recorder}); } catch(error) { if (workflow?.lock?.uid === auth.currentUser?.uid && reasonCode(error) === "ownership_lost" && window.confirm("다른 탭에서 이 경기 입력을 열고 있습니다. 그 탭의 입력권을 이어받을까요? 다른 탭의 저장되지 않은 값은 자동으로 삭제되지 않습니다.")) result=await fn({matchKey,courtId,queueRevision:queue.queueRevision,recorderName:recorder,takeover:true}); else throw error; } edit.token=result.token; edit.serverDraft=draftCopy(result.draft); edit.localDraft=edit.serverDraft; edit.savedRevision=result.draftRevision; const saved=localStorage.getItem(scoreKey()); if(saved){const parsed=JSON.parse(saved);if(parsed.revision===result.draftRevision){edit.localDraft=parsed.draft;edit.touched=new Set(parsed.touched||[]);edit.dirty=true;}else if(window.confirm("이 기기의 임시 점수가 서버의 최신 초안보다 오래되었습니다. 이전 기기 점수를 불러와 비교할까요?")){edit.localDraft=parsed.draft;edit.touched=new Set(parsed.touched||[]);edit.dirty=true;status("이전 기기 점수를 불러왔습니다. 확인 후 다시 저장하세요.");}else{status("서버의 최신 초안을 불러왔습니다.");}} channel?.postMessage({type:"claimed",matchKey,session:recorderSessionId(),instance:tabInstanceId}); beginHeartbeat(); renderedFormKey=""; render(); focus(ui.scoreFields.querySelector("input")); } catch(error) { status(recorderReason(error)); } finally {setBusy(false);} };
ui.scoreForm.onsubmit=async(event)=>{event.preventDefault();const check=validate(false);ui.scoreError.textContent=check.ok?"":check.message;if(!check.ok)return;setBusy(true);action("저장 중");try{const result=await saveRecorderDraft({matchKey,token:edit.token,queueRevision:queue?.queueRevision,draft:check.score,expectedDraftRevision:edit.savedRevision,final:isFinal()});edit.serverDraft=draftCopy(check.score);edit.localDraft=draftCopy(check.score);edit.savedRevision=result.draftRevision;edit.dirty=false;clearStored();action(`저장됨 ${new Date().toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}`);}catch(error){action("오프라인 로컬 보관");storeDraft();ui.scoreError.textContent=recorderReason(error);}finally{setBusy(false);}};
ui.reviewButton.onclick=()=>{
  const check=validate(true);
  ui.scoreError.textContent=check.ok?"":check.message;
  if(!check.ok)return;
  edit.reviewedPayload=Object.freeze(JSON.parse(JSON.stringify(check.score)));
  const court = courts.find((item) => item.id === courtId);
  const view = courtMatchSummary(assignment, official, { teamsById: teams, groupsById: groups });
  ui.confirmScore.textContent=`${recorder} · ${displayCourt(court)} · ${view.label || matchKey} · ${name("a")} ${edit.reviewedPayload.sets.map((set)=>`${set.a}:${set.b}`).join(", ")} ${name("b")}`;
  render();
  focus(ui.confirmTitle);
};
ui.backToEditButton.onclick=()=>{edit.reviewedPayload=null;render();focus(ui.scoreFields.querySelector("input"));};
ui.submitButton.onclick=async()=>{if(!edit.reviewedPayload&&!edit.pendingSubmit)return;edit.pendingSubmit ||= {matchKey,courtId,token:edit.token,queueRevision:queue?.queueRevision,score:edit.reviewedPayload,final:isFinal(),operationId:operationId()};setBusy(true);try{await submitRecorderDraft(edit.pendingSubmit);edit.pendingSubmit=null;clearStored();edit.dirty=false;edit.token=null;edit.reviewedPayload=null;edit.localDraft=null;edit.serverDraft=null;edit.touched.clear();heartbeat?.stop();ui.confirmPanel.hidden=true;ui.successPanel.hidden=false;action("제출 완료");focus(ui.successTitle);}catch(error){const ambiguous=ambiguousNetworkResult(error);if(!ambiguous)edit.pendingSubmit=null;ui.scoreError.textContent=recorderReason(error);status(ambiguous?`${recorderReason(error)} 같은 제출 요청으로 결과를 다시 확인하세요.`:`${recorderReason(error)} 점수를 수정하거나 현재 경기 상태를 다시 불러오세요.`);}finally{setBusy(false);fenceAmbiguousOperation();}};
ui.endButton.onclick=async()=>{edit.pendingEnd ||= {matchKey,courtId,token:edit.token,queueRevision:queue?.queueRevision,discardDraft:false,operationId:operationId()};setBusy(true);try{await cancelRecorderDraft(edit.pendingEnd);edit.pendingEnd=null;edit.token=null;edit.reviewedPayload=null;heartbeat?.stop();status("입력을 종료했습니다. 초안은 보관됩니다.");focus(ui.workflowTitle);}catch(error){const ambiguous=ambiguousNetworkResult(error);if(!ambiguous)edit.pendingEnd=null;status(ambiguous?`${recorderReason(error)} 같은 종료 요청으로 결과를 다시 확인하세요.`:recorderReason(error));}finally{setBusy(false);fenceAmbiguousOperation();render();}};
ui.discardButton.onclick=()=>{ui.discardMessage.textContent=`${name("a")} 대 ${name("b")} 경기의 저장 초안을 삭제합니다. 이 작업은 되돌릴 수 없습니다.`;ui.discardPanel.hidden=false;focus(ui.keepDraftButton);};
ui.keepDraftButton.onclick=()=>{ui.discardPanel.hidden=true;focus(ui.scoreFields.querySelector("input"));};
ui.confirmDiscardButton.onclick=async()=>{edit.pendingDiscard ||= {matchKey,courtId,token:edit.token,queueRevision:queue?.queueRevision,discardDraft:true,operationId:operationId()};setBusy(true);try{await cancelRecorderDraft(edit.pendingDiscard);edit.pendingDiscard=null;clearStored();edit.token=null;edit.dirty=false;edit.reviewedPayload=null;edit.localDraft=null;edit.serverDraft=null;edit.touched.clear();renderedFormKey="";ui.scoreFields.replaceChildren(ui.scoreLegend);heartbeat?.stop();ui.discardPanel.hidden=true;status("초안을 폐기했습니다.");focus(ui.workflowTitle);}catch(error){const ambiguous=ambiguousNetworkResult(error);if(!ambiguous)edit.pendingDiscard=null;status(ambiguous?`${recorderReason(error)} 같은 폐기 요청으로 결과를 다시 확인하세요.`:recorderReason(error));}finally{setBusy(false);fenceAmbiguousOperation();render();}};
ui.nextSameButton.onclick=()=>{ui.successPanel.hidden=true;attachCourt(courtId);};
ui.switchRecorderButton.onclick=()=>{ui.successPanel.hidden=true;attachCourt("");ui.courtSelect.value="";focus(ui.courtSelect);};

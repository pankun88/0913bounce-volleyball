import { isFirebaseConfigured, db } from "./firebase-init.js";
import {
  collection, doc, getDoc, getDocs, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { watchAuthState, login, logout, requestPasswordReset, changePassword, describeAuthError } from "./auth-service.js";
import {
  saveTournamentInfo, subscribeTournamentInfo,
  addGroup, renameGroup, reorderGroups, subscribeGroups,
  addTeam, moveAndReorderTeam, subscribeTeams,
  mutatePrelimStructure, subscribePrelimMatches, reorderPrelimMatches,
  setGroupMatchMode, setGroupRingOrder,
  publishFinalBracket, subscribeFinalMatches,
  exportAllData, importAllData,
} from "./firestore-service.js";
import {
  evaluatePrelimMatch,
  evaluateFinalMatch,
  computeGroupStandings,
  computeAutomaticQualifiers,
  validateSetScore,
  buildQualificationSnapshot,
  computeQualificationState,
  validateQualificationSelection,
} from "./match-logic.js";
import { buildCrossGroupSeedOrder, swapFinalSeedSlots, confirmBye, placeByeTeam, generateBracket, recordMatchResult, invalidateDescendantResults } from "./bracket.js";
import { renderBracket } from "./bracket-render.js";
import { buildFullResultsCsv, downloadCsv } from "./csv-export.js";
import { normalizeRingOrder, renderRingDiagram } from "./ring-bracket.js";
import { orderExistingRoundRobinMatchIds } from "./schedule.js";
import { adminWorkflowCallable } from "./workflow-service.js";
import {
  getPlannerVisibleAdjacent,
  groupPlannerAssignments,
  isPlannerMatchCompleted,
  movePlannerAssignment,
  movePlannerMatchByOffset,
  plannerPhaseMatches,
  reconcilePlannerAssignments,
  swapPlannerCourts,
} from "./score-workflow.js";
import { upgradeLegacyBackup } from "./backup-format.js";
import {
  courtMatchSummary, courtTeamNames, formatCourtName, normalizeCourtName,
  getPrelimRingEdgeLabels, projectPrelimCourtSchedule,
} from "./court-display.js";
import {
  correctionConfirmationState,
  correctionSelectionInfo,
  correctionSelectionKeys,
  correctionSelectionMatches,
  eligibleCorrectionCandidates,
  isCorrectionCandidateEligible,
} from "./correction-view.js";
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
let authoritativeFinalMatches = [];
let finalDraftBaseline = [];
let finalScoreDrafts = new Map();
let seedSelection = []; // 본선 진출팀 id 순서 (시드순)
let seedAutoMode = true; // true면 예선 순위 기준 추천 진출팀을 매 렌더마다 자동으로 채움 (체크박스/화살표를 직접 조작하면 false로 바뀜)
let qualificationState = null;
let qualificationServerState = null;
let qualificationServerFingerprint = "";
let qualificationTieSelections = {};
let qualificationProof = null;
let qualificationRevalidatedLocally = false;
let qualificationSourceKey = "";
let qualificationSourceInitialized = false;
let qualificationGroupsLoaded = false;
let qualificationTeamsLoaded = false;
let qualificationMatchesLoaded = false;
let qualificationDraftStale = false;
let qualificationPreparationInFlight = false;
let qualificationReplacement = null;
let qualificationPreparationError = "";
let qualificationCountInputOverride = null;
let pendingAutoSelectGroupName = null; // 방금 추가한 조 이름 — 팀 등록 select에 자동 선택용
let ringSelection = null; // 링크제 클릭배치 중 선택 상태: { type:'pool'|'vertex', teamId|index, groupId }
let isAddingGroup = false; // 저장 응답 전 중복 클릭/Enter로 같은 조가 두 번 생성되는 것을 막는다
let isAddingTeam = false; // 저장 응답 전 중복 클릭/Enter로 같은 팀이 두 번 생성되는 것을 막는다
// 대진표 자리 드래그/부전승 배치는 누를 때마다 바로 관객 화면(대시보드)에 공개되면
// 관객이 "아직 정해지지 않은" 자리 이동을 결과로 오해할 수 있다. 그래서 이 조정들은
// 일단 화면(로컬)에서만 반영해두고, 관리자가 "관객 화면에 공개" 버튼을 눌러야만
// Firestore에 저장돼 대시보드에 실제로 공유된다.
let bracketPublishPending = false;
let bracketPublishConflict = false;
let bracketPublishInFlight = false;
let unsubscribeFinalMatches = null;
let reviewAssignments = [];
let reviewWorkflows = new Map();
let reviewQueues = new Map();
let reviewCourts = new Map();
const recorderLockInventoryReady = { assignments: false, workflows: false, courts: false };
let reviewAudits = new Map();
const reviewFinalMatchesByDivision = { men: [], women: [] };
let correctionPreview = null;
let correctionPreviewGeneration = 0;
let correctionSelection = new Set();
let correctionCompletionMessage = "";
let correctionPreviewInFlight = false;
let correctionApplyInFlight = false;
let unsubscribeWorkflowReviews = [];
let workflowDraftAssignments = [];
let workflowDraftCourts = [];
let workflowDirty = false;
let workflowSaveInProgress = false;
let workflowTopologyBaseline = 0;
let workflowQueueRevisionBaseline = {};
let workflowDraftCourtSwaps = [];
let workflowPhaseFilter = "all";
const workflowCompletedDetailsOpen = new Map();
let workflowDragMatchKey = null;
let workflowDragTarget = null;
let workflowDropHighlightTimer = null;
const WORKFLOW_DRAG_HINT = "완료 경기가 분리되거나 일부 경기가 숨겨져 드래그 정렬은 제한됩니다. 코트 선택과 가능한 화살표를 사용하세요.";
const PRELIM_ORDER_GUIDANCE = "경기 진행 순서는 통합 경기 배정·순서에서 변경합니다. 도형의 팀 배치는 대진 상대를 변경합니다.";
const PRELIM_UNSAVED_PLAN_HINT = "저장되지 않은 코트 배정·진행 순서가 표시 중입니다. 통합 경기 배정·순서에서 저장하세요.";
let tournamentResetInProgress = false;
let tournamentResetState = null;
const TOURNAMENT_RESET_STATE_KEY = "bounce-volleyball:tournament-reset";
let recorderGrants = [];
let recorderGrantsLoading = false;
let recorderGrantsError = "";
let recorderGrantsLoadedCount = 0;
let recorderGrantsHistoryVisibleCount = 20;
let recorderGrantsAuthUid = null;
let recorderGrantsRefreshToken = 0;
let prelimHistoryReadiness = { status: "loading", error: null };

const DIVISION_LABELS = { men: "남자부", women: "여자부" };
const divisionLabel = () => DIVISION_LABELS[activeDivision];
const PRELIM_HISTORY_GUIDANCE = "공식 예선 이력이 있는 경기는 조·팀·예선 초기화와 대진 재생성을 할 수 없습니다. 전체 초기화로 결과를 지우지 말고, 기록·검수 탭의 ‘승인 결과 정정’에서 해당 경기를 선택해 감사 사유와 함께 정정 절차를 진행하세요.";
const PRELIM_HISTORY_DISABLED_TITLE = "공식 예선 이력이 있어 비활성화되었습니다. 기록·검수 탭에서 승인 결과 정정을 진행하세요.";
const PRELIM_HISTORY_LOADING_GUIDANCE = "예선 이력을 서버에서 확인하는 중입니다. 확인이 끝날 때까지 결과를 지울 수 있는 초기화·대진 재생성을 사용할 수 없습니다.";

function resetRecorderGrantAuth(uid) {
  recorderGrantsAuthUid = uid || null;
  recorderGrantsRefreshToken += 1;
  recorderGrantsLoading = false;
  recorderGrantsLoadedCount = 0;
  recorderGrantsHistoryVisibleCount = 20;
  recorderGrants = [];
  recorderGrantsError = "";
  const historyDetails = document.getElementById("recorderGrantHistory");
  if (historyDetails) historyDetails.open = false;
  const refreshButton = document.getElementById("refreshRecorderGrantsBtn");
  if (refreshButton) {
    refreshButton.disabled = false;
    refreshButton.textContent = "권한 목록 새로고침";
  }
  renderRecorderGrants();
}

function hasOfficialPrelimHistory(match) {
  return Number(match?.officialRevision || 0) > 0
    || Boolean(match?.result || match?.winner || match?.winnerTeam)
    || ["done", "completed"].includes(match?.status)
    || (Array.isArray(match?.sets)
      && match.sets.some((set) => Number(set?.a) > 0 || Number(set?.b) > 0));
}

function prelimMatchesForMutation(operation, groupId = null) {
  const groupOperations = new Set([
    "delete_group",
    "generate_group_round_robin",
    "generate_group_ring",
    "clear_group_prelim",
  ]);
  if (groupOperations.has(operation)) {
    return allPrelimMatches.filter((match) => match.groupId === groupId);
  }
  const activeGroupIds = new Set(
    allGroups
      .filter((group) => group.division === activeDivision)
      .map((group) => group.id),
  );
  if (operation === "delete_all_groups") {
    return allPrelimMatches.filter((match) => (
      match.division === activeDivision || activeGroupIds.has(match.groupId)
    ));
  }
  return allPrelimMatches.filter((match) => match.division === activeDivision);
}

function officialPrelimHistoryForMutation(operation, groupId = null) {
  return prelimMatchesForMutation(operation, groupId).filter(hasOfficialPrelimHistory);
}

function prelimHistoryIsReady() {
  return prelimHistoryReadiness.status === "ready";
}

function prelimHistoryReadinessGuidance() {
  if (prelimHistoryReadiness.status === "error") {
    const code = prelimHistoryReadiness.error?.code
      ? ` (${prelimHistoryReadiness.error.code})`
      : "";
    return `예선 이력을 서버에서 확인하지 못했습니다${code}. 네트워크·Firestore 연결을 복구한 뒤 새로고침해 다시 확인하세요. 확인 전에는 초기화·대진 재생성을 사용할 수 없습니다.`;
  }
  return PRELIM_HISTORY_LOADING_GUIDANCE;
}

function blockPrelimMutationUntilReady() {
  if (prelimHistoryIsReady()) return false;
  showToast(prelimHistoryReadinessGuidance(), 7000);
  return true;
}

function prelimMutationGuidance(historyMatches = []) {
  if (!historyMatches.length) return PRELIM_HISTORY_GUIDANCE;
  return `${divisionLabel()}에 공식 예선 이력이 있는 경기 ${historyMatches.length}건이 확인되어 이 작업을 중단했습니다. ${PRELIM_HISTORY_GUIDANCE}`;
}

function blockPrelimMutationWithHistory(operation, groupId = null) {
  if (blockPrelimMutationUntilReady()) return true;
  const historyMatches = officialPrelimHistoryForMutation(operation, groupId);
  if (!historyMatches.length) return false;
  showToast(prelimMutationGuidance(historyMatches), 7000);
  return true;
}

function cloneFinalMatches(matches) {
  return structuredClone(matches || []);
}

function qualificationSnapshotForCurrentData() {
  const selectedGroups = allGroups.filter((group) => group.division === activeDivision);
  const selectedGroupIds = new Set(selectedGroups.map((group) => group.id));
  const selectedTeams = allTeams.filter((team) => (
    team.division === activeDivision || selectedGroupIds.has(team.groupId)
  ));
  const selectedMatches = allPrelimMatches.filter((match) => (
    match.division === activeDivision || selectedGroupIds.has(match.groupId)
  ));
  return buildQualificationSnapshot({
    division: activeDivision,
    qualifyPerGroup: tournamentInfo.qualifyPerGroup?.[activeDivision],
    groups: selectedGroups,
    teams: selectedTeams,
    matches: selectedMatches,
  });
}

function qualificationBlockerCode(blocker) {
  if (typeof blocker === "string") return blocker.split(":", 1)[0];
  return blocker?.code || "";
}

function qualificationBlockerMessage(blocker) {
  const value = typeof blocker === "string"
    ? blocker
    : `${blocker?.code || "qualification_unknown"}:${blocker?.message || ""}`;
  const [code] = value.split(":");
  const guidance = {
    invalid_division: "선택한 부문을 확인하세요.",
    invalid_qualification_count: "조별 진출 팀 수는 허용 범위의 정수여야 합니다.",
    duplicate_group: "조 식별자가 중복되었습니다. 조 구성을 확인하세요.",
    duplicate_team: "팀 식별자가 중복되었습니다. 팀 구성을 확인하세요.",
    duplicate_match: "예선 경기 식별자가 중복되었습니다. 예선 대진을 확인하세요.",
    foreign_group: "선택한 부문에 속하지 않는 조가 있습니다.",
    foreign_team: "선택한 부문에 속하지 않는 팀이 있습니다.",
    foreign_match: "선택한 부문에 속하지 않는 예선 경기가 있습니다.",
    unknown_team_group: "팀이 존재하지 않는 조를 가리킵니다.",
    unknown_match_group: "예선 경기가 존재하지 않는 조를 가리킵니다.",
    orphan_match: "팀이 없는 조를 가리키는 예선 경기가 있습니다.",
    invalid_schedule_mode: "예선 방식이 올바르지 않습니다.",
    invalid_ring_order: "링크제 배치가 모든 팀을 정확히 한 번씩 포함해야 합니다.",
    insufficient_group_members: "조에는 최소 두 팀이 필요합니다.",
    foreign_match_team: "예선 경기의 팀이 해당 조의 팀과 일치하지 않습니다.",
    duplicate_game: "같은 팀 조합의 예선 경기가 중복되었습니다.",
    unexpected_game: "조 편성에 없는 예선 경기가 포함되었습니다.",
    retracted_match: "철회된 예선 경기가 있어 최신 공식 결과가 필요합니다.",
    incomplete_match: "모든 예선 경기에 현재의 완전한 결과가 필요합니다.",
    missing_game: "예상된 예선 경기가 빠져 있습니다.",
    schedule_size: "예선 대진 수가 조 구성과 일치하지 않습니다.",
    no_groups: "참가팀이 배정된 조가 없습니다.",
    empty_group_games: "참가팀이 없는 조에 경기 기록이 남아 있습니다. 조 구성과 기록을 확인하세요.",
    qualification_state_required: "예선 진출 상태를 먼저 확인하세요.",
    participant_ids_required: "진출팀 목록을 확인하세요.",
    tie_selections_required: "추첨 대상 선택을 확인하세요.",
    duplicate_participant: "진출팀이 중복되었거나 올바른 팀 ID가 아닙니다.",
    foreign_participant: "선택한 팀이 해당 부문의 팀이 아닙니다.",
    invalid_tie_selection: "추첨 선택은 팀 ID 배열이어야 합니다.",
    duplicate_tie_selection: "추첨 선택에서 팀을 중복 선택할 수 없습니다.",
    cutoff_slots_mismatch: "추첨 대상은 남은 자리 수만큼 정확히 선택해야 합니다.",
    non_candidate_selection: "진출선 추첨 후보만 선택할 수 있습니다.",
    mandatory_qualifier_missing: "자동 진출팀은 반드시 포함해야 합니다.",
    cutoff_selection_missing: "추첨으로 선택한 팀을 진출팀 목록에도 포함해야 합니다.",
    non_qualifier_selected: "진출 조건을 충족하지 않는 팀은 선택할 수 없습니다.",
    group_count_mismatch: "각 조의 진출팀 수가 정원과 일치해야 합니다.",
    unknown_tie_group: "존재하지 않는 조의 추첨 선택이 포함되었습니다.",
    qualification_not_ready: "참가팀이 있는 모든 조의 예선 결과를 먼저 완료하세요.",
    participant_count: "본선 진출팀은 2~32팀이어야 합니다.",
    qualification_validation_failed: "진출팀 선택 검증에 실패했습니다.",
  }[code];
  return guidance || "예선 진출 조건을 확인하고 최신 상태에서 다시 시도하세요.";
}

function qualificationGroupTeamIds(group) {
  return (group?.standings || []).map((standing) => standing.teamId).filter(Boolean);
}

function qualificationStateRequiredCount(state) {
  return Number.isInteger(state?.requiredCount) ? state.requiredCount : 0;
}

function qualificationStateBlockers(state) {
  return Array.isArray(state?.blockers) ? state.blockers : [];
}

function qualificationStateHasStructuralBlockers(state) {
  if (!state || !(state.groups || []).length) return true;
  return qualificationStateBlockers(state).length > 0;
}

function qualificationStateReadyForSelection(state) {
  return Boolean(state?.ready) && !qualificationStateHasStructuralBlockers(state);
}

function qualificationStateForCurrentData() {
  qualificationState = computeQualificationState(qualificationSnapshotForCurrentData());
  return qualificationState;
}

function canonicalQualificationTieSelections(state, selections = qualificationTieSelections) {
  const result = {};
  (state?.groups || []).forEach((group) => {
    const candidates = new Set(group.cutoffCandidateIds || []);
    const slots = Math.max(0, Number(group.cutoffSlots) || 0);
    const picked = Array.isArray(selections?.[group.groupId]) ? selections[group.groupId] : [];
    result[group.groupId] = [...new Set(picked)]
      .filter((id) => candidates.has(id))
      .slice(0, slots)
      .sort();
  });
  return result;
}

function qualificationSelectionIds(state, tieSelections = qualificationTieSelections) {
  return (state?.groups || []).flatMap((group) => [
    ...(group.automaticIds || []),
    ...(canonicalQualificationTieSelections(state, tieSelections)[group.groupId] || []),
  ]);
}

function qualificationSeedOrder(state, tieSelections = qualificationTieSelections) {
  const canonicalTies = canonicalQualificationTieSelections(state, tieSelections);
  const tiers = [];
  const maxRank = Math.max(
    0,
    ...(state?.groups || []).flatMap((group) => (
      (group.standings || []).map((standing) => Number(standing.rank) || 0)
    )),
  );
  for (let rank = 1; rank <= maxRank; rank += 1) {
    const tier = [];
    (state?.groups || []).forEach((group) => {
      const qualified = new Set([
        ...(group.automaticIds || []),
        ...(canonicalTies[group.groupId] || []),
      ]);
      (group.standings || [])
        .filter((standing) => standing.rank === rank && qualified.has(standing.teamId))
        .forEach((standing) => tier.push({
          teamId: standing.teamId,
          groupId: group.groupId,
          groupSize: qualificationGroupTeamIds(group).length,
        }));
    });
    if (tier.length) tiers.push(tier);
  }
  return buildCrossGroupSeedOrder(tiers);
}

function syncQualificationSelection(state) {
  const nextTies = canonicalQualificationTieSelections(state);
  qualificationTieSelections = nextTies;
  const ids = new Set(qualificationSelectionIds(state, nextTies));
  const previousOrder = seedSelection.filter((id) => ids.has(id));
  const recommended = qualificationSeedOrder(state, nextTies);
  seedSelection = previousOrder.length === ids.size
    ? previousOrder
    : recommended.filter((id) => ids.has(id));
  if (seedSelection.length !== ids.size) {
    ids.forEach((id) => {
      if (!seedSelection.includes(id)) seedSelection.push(id);
    });
  }
}

function qualificationHasFinalBracket() {
  return authoritativeFinalMatches.length > 0
    || finalMatches.length > 0
    || bracketPublishPending;
}

function qualificationHasFinalPlay() {
  if (finalScoreDrafts.size > 0) return true;
  const records = [
    ...authoritativeFinalMatches,
    ...finalMatches,
    ...reviewAssignments,
    ...reviewWorkflows.values(),
  ];
  return records.some((record) => (
    Number(record?.officialRevision || 0) > 0
    || Number(record?.attemptCount || 0) > 0
    || Number(record?.draftRevision || 0) > 0
    || Number(record?.submissionVersion || 0) > 0
    || ["done", "completed", "in_progress", "under_review"].includes(record?.status)
    || ["completed", "in_progress", "under_review", "replay_required", "rework_required"].includes(record?.publicStatus)
    || (Array.isArray(record?.sets) && record.sets.some((set) => Number(set?.a) > 0 || Number(set?.b) > 0))
    || (Array.isArray(record?.draft?.sets) && record.draft.sets.some((set) => Number(set?.a) > 0 || Number(set?.b) > 0))
  ));
}

function finalEntrantIds(matches = finalMatches) {
  const ids = [];
  (matches || [])
    .filter((match) => (match.round || 1) === 1)
    .forEach((match) => {
      [match.teamA?.id, match.teamB?.id, match.byeCandidate?.team?.id]
        .filter(Boolean)
        .forEach((id) => { if (!ids.includes(id)) ids.push(id); });
    });
  return ids;
}

function qualificationSourceChanged() {
  const snapshot = qualificationSnapshotForCurrentData();
  const nextKey = JSON.stringify(snapshot);
  if (!qualificationGroupsLoaded || !qualificationTeamsLoaded || !qualificationMatchesLoaded) {
    qualificationSourceKey = nextKey;
    return false;
  }
  if (!qualificationSourceInitialized) {
    qualificationSourceInitialized = true;
    qualificationSourceKey = nextKey;
    return false;
  }
  if (qualificationSourceKey === nextKey) return false;
  qualificationSourceKey = nextKey;
  if (qualificationHasFinalBracket()) {
    qualificationDraftStale = true;
    qualificationRevalidatedLocally = false;
  }
  return true;
}

function syncQualificationProofFromTournamentInfo() {
  const next = tournamentInfo.finalQualification?.[activeDivision] || null;
  const previous = qualificationProof;
  qualificationProof = next;
  if (!qualificationServerFingerprint && typeof next?.fingerprint === "string") {
    qualificationServerFingerprint = next.fingerprint;
  }
  if (!previous && next?.tieSelections && typeof next.tieSelections === "object") {
    qualificationTieSelections = Object.fromEntries(
      Object.entries(next.tieSelections)
        .filter(([, values]) => Array.isArray(values))
        .map(([groupId, values]) => [groupId, [...values]]),
    );
  }
}

function qualificationProofStatus() {
  if (!qualificationHasFinalBracket()) return "none";
  if (qualificationDraftStale) return "stale";
  if (qualificationProof?.status === "stale" && !qualificationRevalidatedLocally) return "stale";
  if (qualificationProof?.status !== "current") return "unverified";
  if (!qualificationProof.fingerprint) return "unverified";
  return "current";
}

function qualificationStructureLocked() {
  return authoritativeFinalMatches.length > 0
    && (qualificationProof != null || qualificationProofStatus() !== "none");
}

function blockQualificationStructureEdit() {
  if (!qualificationStructureLocked()) return false;
  showToast(
    "본선이 공개된 뒤 조·팀의 추가/삭제·조 이동·예선 재생성은 Rules로 차단됩니다. 표시 이름과 순서만 조정하고, 진출 근거는 다시 확인하세요.",
    7000,
  );
  return true;
}

function qualificationGuidanceForBlockers(state) {
  const messages = qualificationStateBlockers(state)
    .filter((blocker) => !["cutoff_lottery_required", "cutoff_selection_required"].includes(qualificationBlockerCode(blocker)))
    .map(qualificationBlockerMessage);
  return [...new Set(messages)];
}

function finalBaselineDescriptor(matches) {
  return (matches || [])
    .map((match) => ({
      id: match.id,
      lastTransitionId: match.lastTransitionId ?? null,
      officialRevision: Number(match.officialRevision) || 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function sameFinalBaseline(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resetFinalDraft(matches = authoritativeFinalMatches) {
  authoritativeFinalMatches = cloneFinalMatches(matches);
  finalMatches = cloneFinalMatches(matches);
  finalDraftBaseline = finalBaselineDescriptor(matches);
  finalScoreDrafts = new Map();
  bracketPublishPending = false;
  bracketPublishConflict = false;
}

function discardFinalDraft() {
  resetFinalDraft(authoritativeFinalMatches);
  renderFinalBracket();
  renderFinalTeamPicker();
}

function finalMutationAllowed() {
  if (!bracketPublishInFlight) return true;
  showToast("본선 공개 처리 중입니다. 완료 후 다시 시도하세요.", 3000);
  return false;
}

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
  qualificationSourceChanged();
  qualificationStateForCurrentData();
  document.getElementById("teamCount").textContent = teams.length;
  renderGroupList();
  renderTeamGroupSelect();
  renderGroupTeamLists();
  renderPrelimViews();
  renderFinalTeamPicker();
  renderWorkflowCourtPlanner();
  renderScoreReviews();
  updatePrelimMutationGuardUi();
  updateQualificationStructureControls();
}

function updatePrelimMutationGuardUi() {
  const guidance = document.getElementById("prelimMutationGuidance");
  const ready = prelimHistoryIsReady();
  const historyMatches = ready ? officialPrelimHistoryForMutation("clear_division_prelim") : [];
  if (guidance) {
    guidance.textContent = !ready
      ? prelimHistoryReadinessGuidance()
      : historyMatches.length
      ? prelimMutationGuidance(historyMatches)
      : PRELIM_HISTORY_GUIDANCE;
  }
  [
    ["resetGroupsBtn", "delete_all_groups", "공식 이력이 없는 경우 현재 부문의 모든 조를 삭제합니다."],
    ["resetTeamsBtn", "delete_all_teams", "공식 이력이 없는 경우 현재 부문의 모든 팀과 예선 대진을 삭제합니다."],
    ["resetPrelimBtn", "clear_division_prelim", "공식 이력이 없는 경우 현재 부문의 예선 대진을 초기화합니다."],
  ].forEach(([buttonId, operation, title]) => {
    const button = document.getElementById(buttonId);
    if (!button) return;
    const operationHistory = ready ? officialPrelimHistoryForMutation(operation) : [];
    const blocked = !ready || operationHistory.length > 0;
    button.disabled = blocked;
    button.setAttribute("aria-disabled", String(blocked));
    button.title = !ready
      ? prelimHistoryReadinessGuidance()
      : operationHistory.length ? PRELIM_HISTORY_DISABLED_TITLE : title;
  });
}

function rebindFinalMatches() {
  unsubscribeFinalMatches?.();
  resetFinalDraft([]);
  renderFinalBracket();
  renderFinalTeamPicker();
  unsubscribeFinalMatches = subscribeFinalMatches(activeDivision, (data) => {
    authoritativeFinalMatches = cloneFinalMatches(data);
    invalidateCorrectionPreview("공식 경기 결과가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
    if (!bracketPublishPending) {
      resetFinalDraft(data);
    } else if (!sameFinalBaseline(finalDraftBaseline, finalBaselineDescriptor(data))) {
      bracketPublishConflict = true;
    }
    if (!workflowDirty) resetWorkflowDraft();
    else refreshWorkflowMatchMetadata();
    renderFinalBracket();
    renderFinalTeamPicker();
    renderWorkflowCourtPlanner();
    updateQualificationStructureControls();
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
  syncQualificationProofFromTournamentInfo();
  const nameInput = document.getElementById("tournamentNameInput");
  if (nameInput && !nameInput.value) nameInput.value = tournamentInfo.name || "";
  const qualifyInput = document.getElementById("qualifyPerGroupInput");
  if (qualifyInput && qualificationCountInputOverride != null) {
    qualifyInput.value = qualificationCountInputOverride;
  } else if (qualifyInput && document.activeElement !== qualifyInput) {
    qualifyInput.value = tournamentInfo.qualifyPerGroup?.[activeDivision] || 2;
  }
  const venueDisplay = tournamentInfo.venueDisplay || {};
  document.getElementById("venueDisplayMode").value = venueDisplay.mode || "auto";
  document.getElementById("venueDisplayInterval").value = venueDisplay.intervalSeconds || 15;
  const bracketTitle = document.getElementById("bracketTitle");
  if (bracketTitle) bracketTitle.textContent = `${tournamentInfo.name || "바운스발리볼"} ${divisionLabel()} 본선 대진표`;
  qualificationSourceChanged();
  qualificationStateForCurrentData();
  renderFinalTeamPicker();
  updateQualificationStructureControls();
});

subscribeGroups((data) => {
  allGroups = data;
  qualificationGroupsLoaded = true;
  invalidateCorrectionPreview("조 정보가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
  if (!workflowDirty) resetWorkflowDraft();
  else refreshWorkflowMatchMetadata();
  refreshActiveDivisionData();
});

subscribeTeams((data) => {
  allTeams = data;
  qualificationTeamsLoaded = true;
  invalidateCorrectionPreview("팀 정보가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
  if (!workflowDirty) resetWorkflowDraft();
  else refreshWorkflowMatchMetadata();
  refreshActiveDivisionData();
});

subscribePrelimMatches((data, metadata) => {
  allPrelimMatches = data;
  qualificationMatchesLoaded = true;
  prelimHistoryReadiness = metadata?.fromCache === false && metadata?.hasPendingWrites === false
    ? { status: "ready", error: null }
    : { status: "loading", error: null };
  invalidateCorrectionPreview("공식 경기 결과가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
  if (!workflowDirty) resetWorkflowDraft();
  else refreshWorkflowMatchMetadata();
  refreshActiveDivisionData();
});

rebindFinalMatches();

// ---------------- 연결 상태 감시 ----------------

function initConnectionWatch() {
  window.addEventListener("firestore-error", (e) => {
    const { label, err } = e.detail;
    if (label === "예선경기 구독" || label === "예선경기") {
      prelimHistoryReadiness = { status: "error", error: err || new Error("예선 이력 연결 오류") };
      updatePrelimMutationGuardUi();
      renderGroupList();
      renderPrelimSetupGroups();
    }
    setConnStatus(false);
    const code = err && err.code ? ` (${err.code})` : "";
    showErrorBanner(`${label} 실패${code}: ${err && err.message ? err.message : err}\nFirestore 보안 규칙이 게시되어 있는지 Firebase 콘솔에서 확인해주세요.`);
  });
  window.addEventListener("firestore-timeout", (e) => {
    if (e.detail.label === "예선경기") {
      prelimHistoryReadiness = { status: "error", error: new Error("예선경기 실시간 연결 시간이 초과되었습니다.") };
      updatePrelimMutationGuardUi();
      renderGroupList();
      renderPrelimSetupGroups();
    }
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
    resetRecorderGrantAuth(user?.uid || null);
    if (user) {
      loginScreen.style.display = "none";
      appShell.style.display = "";
      if (!unsubscribeWorkflowReviews.length) subscribeWorkflowReviews();
      refreshRecorderGrants();
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
  Object.keys(recorderLockInventoryReady).forEach((key) => { recorderLockInventoryReady[key] = false; });
  const root = ["tournaments", TOURNAMENT_ID];
  unsubscribeWorkflowReviews = [
    onSnapshot(collection(db, ...root, "courtAssignments"), (snap) => {
      reviewAssignments = snap.docs.map((item) => ({ id: item.id, ...item.data() }));
      recorderLockInventoryReady.assignments = true;
      invalidateCorrectionPreview("경기의 코트 배정이 바뀌었습니다. 변경 내용을 다시 확인하세요.");
      if (!workflowDirty) resetWorkflowDraft();
      else refreshWorkflowMatchMetadata();
      renderScoreReviews();
      renderWorkflowCourtPlanner();
      renderPrelimViews();
      renderFinalBracket();
    }, (err) => reportError("검수 목록 구독", err)),
    onSnapshot(collection(db, ...root, "scoreWorkflows"), (snap) => {
      reviewWorkflows = new Map(snap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
      recorderLockInventoryReady.workflows = true;
      invalidateCorrectionPreview("경기의 입력 상태가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
      renderScoreReviews();
      renderWorkflowCourtPlanner();
      renderPrelimViews();
    }, (err) => reportError("워크플로 구독", err)),
    onSnapshot(collection(db, ...root, "courtQueues"), (snap) => {
      reviewQueues = new Map(snap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
      invalidateCorrectionPreview("코트의 경기 순서가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
      renderWorkflowCourtPlanner();
    }, (err) => reportError("코트 대기열 구독", err)),
    onSnapshot(collection(db, ...root, "courts"), (snap) => {
      reviewCourts = new Map(snap.docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
      recorderLockInventoryReady.courts = true;
      invalidateCorrectionPreview("코트 정보가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
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
      invalidateCorrectionPreview("공식 경기 결과가 바뀌었습니다. 변경 내용을 다시 확인하세요.");
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
    ...Object.entries(reviewFinalMatchesByDivision).flatMap(([divisionId, matches]) => matches
      .filter((match) => !["empty", "bye_pending", "bye"].includes(match.status))
      .map((match) => ({
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
  workflowDraftCourtSwaps = [];
  workflowTopologyBaseline = Number(tournamentInfo.courtTopologyRevision || 0);
  workflowQueueRevisionBaseline = Object.fromEntries(
    [...reviewQueues].map(([courtId, queue]) => [courtId, Number(queue.queueRevision || 0)]),
  );
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

async function mutatePrelimStructureAndRefresh(operation, data = {}) {
  await mutatePrelimStructure(operation, activeDivision, data);
  await reloadWorkflowAuthoritativeState();
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

function workflowCourtSwapPairKey(firstCourtId, secondCourtId) {
  return [firstCourtId, secondCourtId].sort().join("\u0000");
}

function workflowCourtSwapsMatchSavedPlan() {
  const orderedKeys = (assignments, courtId) => assignments
    .filter((item) => item.courtId === courtId)
    .sort((a, b) => (a.courtOrder || 0) - (b.courtOrder || 0))
    .map((item) => item.matchKey || item.id);
  return workflowDraftCourtSwaps.every(({ fromCourtId, toCourtId }) => (
    [[fromCourtId, toCourtId], [toCourtId, fromCourtId]].every(([sourceId, targetId]) => {
      const savedCourt = reviewCourts.get(targetId);
      const draftCourt = workflowDraftCourts.find((court) => court.id === targetId);
      if (!savedCourt || !draftCourt
          || normalizeCourtName(savedCourt.name || savedCourt.displayName) !== normalizeCourtName(draftCourt.name)
          || (savedCourt.recorderName || "").trim() !== (draftCourt.recorderName || "").trim()) return false;
      const saved = orderedKeys(reviewAssignments, sourceId);
      const draft = orderedKeys(workflowDraftAssignments, targetId);
      return saved.length === draft.length && saved.every((key, index) => key === draft[index]);
    })
  ));
}

function swapWorkflowCourts(firstCourtId, secondCourtId) {
  if (!firstCourtId || !secondCourtId || firstCourtId === secondCourtId) return;
  const pairKey = workflowCourtSwapPairKey(firstCourtId, secondCourtId);
  const existingPairIndex = workflowDraftCourtSwaps.findIndex((pair) => (
    workflowCourtSwapPairKey(pair.fromCourtId, pair.toCourtId) === pairKey
  ));
  const conflictingPair = workflowDraftCourtSwaps.find((pair, index) => (
    index !== existingPairIndex
      && [pair.fromCourtId, pair.toCourtId].some((id) => id === firstCourtId || id === secondCourtId)
  ));
  if (conflictingPair) {
    showToast("저장 전에는 같은 코트를 여러 교환에 사용할 수 없습니다.");
    return;
  }
  const firstCourt = workflowDraftCourts.find((court) => court.id === firstCourtId);
  const secondCourt = workflowDraftCourts.find((court) => court.id === secondCourtId);
  if (!firstCourt || !secondCourt) return;
  const firstAssignments = workflowDraftAssignments.filter((assignment) => assignment.courtId === firstCourtId);
  const secondAssignments = workflowDraftAssignments.filter((assignment) => assignment.courtId === secondCourtId);
  const ongoing = [...firstAssignments, ...secondAssignments].filter((assignment) => (
    assignment.publicStatus === "in_progress" || workflowStatusFor(assignment.matchKey).lock
  )).length;
  const completed = [...firstAssignments, ...secondAssignments].filter((assignment) => (
    workflowMatchCompleted(assignment.matchKey)
  )).length;
  const firstName = formatCourtName(firstCourt.name, "첫 번째 코트");
  const secondName = formatCourtName(secondCourt.name, "두 번째 코트");
  const ongoingNotice = ongoing
    ? `\n진행 중인 경기 ${ongoing}개는 기존 기록관 잠금이 해제되어 새 코트에서 다시 시작해야 합니다.`
    : "";
  const completedNotice = completed
    ? `\n완료 경기 ${completed}개도 교환 대상에 포함됩니다.`
    : "";
  if (!confirm(
    `'${firstName}'와 '${secondName}'의 전체 경기 목록을 통째로 교환할까요?`
      + "\n예정·진행 중·완료 경기를 포함하고, 각 코트 안의 경기 순서는 그대로 유지합니다."
      + ongoingNotice
      + completedNotice
      + "\n점수 초안·공식 결과·경기 이력은 보존되며 물리 코트 이름과 담당 기록관은 바뀌지 않습니다."
      + "\n기록관은 기기에서만 입력 중인 내용을 먼저 저장하세요. 저장되지 않은 기기 로컬 입력은 코트 교환으로 전송되지 않습니다."
      + "\n저장 버튼을 눌러야 서버에 적용됩니다.",
  )) return;
  workflowDraftAssignments = swapPlannerCourts(
    workflowDraftAssignments,
    firstCourtId,
    secondCourtId,
  );
  if (existingPairIndex >= 0) {
    workflowDraftCourtSwaps = workflowDraftCourtSwaps.filter((_, index) => index !== existingPairIndex);
  } else {
    workflowDraftCourtSwaps = [
      ...workflowDraftCourtSwaps,
      { fromCourtId: firstCourtId, toCourtId: secondCourtId },
    ];
  }
  workflowDirty = true;
  renderWorkflowCourtPlanner();
}

function workflowOptionFor(matchKey) {
  return workflowDraftAssignments.find((option) => option.matchKey === matchKey);
}

function workflowStatusFor(matchKey) {
  return reviewWorkflows.get(matchKey) || {};
}

function workflowMatchCompleted(matchKey) {
  const option = workflowOptionFor(matchKey);
  return isPlannerMatchCompleted(option, assignmentFor(matchKey), workflowStatusFor(matchKey));
}

function workflowMatchVisible(matchKey) {
  return plannerPhaseMatches(workflowOptionFor(matchKey), workflowPhaseFilter);
}

function workflowMatchEditable(matchKey) {
  const assignment = assignmentFor(matchKey);
  return Boolean(
    assignment
      && workflowOptionFor(matchKey)
      && workflowMatchVisible(matchKey)
      && !workflowMatchCompleted(matchKey),
  );
}

function setMatchCourt(matchKey, courtId, beforeMatchKey = null) {
  const assignment = assignmentFor(matchKey);
  if (!assignment || !workflowMatchEditable(matchKey)) return false;
  if (beforeMatchKey && (
    !workflowMatchEditable(beforeMatchKey)
      || (assignmentFor(beforeMatchKey)?.courtId || null) !== (courtId || null)
  )) return false;
  const targetCourtId = courtId || null;
  const next = movePlannerAssignment(
    workflowDraftAssignments,
    matchKey,
    targetCourtId,
    beforeMatchKey,
  );
  if (next.every((item, index) => (
    item.courtId === workflowDraftAssignments[index].courtId
      && item.courtOrder === workflowDraftAssignments[index].courtOrder
  ))) return false;
  workflowDraftAssignments = next;
  workflowDirty = true;
  renderWorkflowCourtPlanner();
  return true;
}

function moveWorkflowMatch(matchKey, offset) {
  if (!workflowMatchEditable(matchKey)) return;
  const next = movePlannerMatchByOffset(
    workflowDraftAssignments,
    workflowDraftAssignments,
    reviewWorkflows,
    matchKey,
    offset,
    workflowPhaseFilter,
  );
  const current = assignmentFor(matchKey);
  const nextCurrent = next.find((assignment) => assignment.matchKey === matchKey);
  if (!current || !nextCurrent || current.courtOrder === nextCurrent.courtOrder) return;
  workflowDraftAssignments = next;
  workflowDirty = true;
  renderWorkflowCourtPlanner();
}

function assignmentFor(matchKey) {
  return workflowDraftAssignments.find((assignment) => assignment.matchKey === matchKey);
}

function syncWorkflowPhaseFilter() {
  document.querySelectorAll("[data-workflow-phase]").forEach((button) => {
    const selected = button.dataset.workflowPhase === workflowPhaseFilter;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

/**
 * 입력 중인 코트 이름/기록관 칸만 다시 그리지 않는다. 버튼(코트 추가·삭제)에 포커스가
 * 있을 때까지 건너뛰면 새 코트 행이 화면에 나타나지 않으므로 대상은 input으로 한정한다.
 */
function renderWorkflowCourtPlanner() {
  if (!document.activeElement?.matches?.("#courtSettingsList input")) renderCourtSettings();
  syncWorkflowPhaseFilter();
  renderCourtBoard();
  syncPrelimCourtSelects();
  syncPrelimCourtBadges();
  syncPrelimExecutionProjection();
  syncPrelimWorkflowHints();
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

function prelimCourtSchedule(matches = prelimMatches) {
  return projectPrelimCourtSchedule(
    matches,
    workflowDraftAssignments.filter((assignment) => (assignment.matchType || "prelim") === "prelim"),
    workflowDraftCourts,
  );
}

function structuralPrelimMatches(matches) {
  return [...matches].sort((left, right) => (
    (Number.isFinite(Number(left.round)) ? Number(left.round) : Number.POSITIVE_INFINITY)
      - (Number.isFinite(Number(right.round)) ? Number(right.round) : Number.POSITIVE_INFINITY)
      || String(left.id || "").localeCompare(String(right.id || ""))
  ));
}

function prelimScheduleRow(matchKey, schedule = prelimCourtSchedule()) {
  return schedule.find((row) => row.match?.id === matchKey) || null;
}

function createPrelimCourtLanes(groupId) {
  const lanes = document.createElement("div");
  lanes.className = "prelim-court-lanes";
  lanes.dataset.prelimCourtLanes = groupId;
  const laneDefinitions = [
    ...workflowDraftCourts.map((court) => [court.id, formatCourtName(court.name, "이름 없는 코트")]),
    ["", "미배정"],
  ];
  laneDefinitions.forEach(([courtId, name]) => {
    const lane = document.createElement("section");
    lane.className = "prelim-court-lane";
    lane.dataset.prelimCourtLane = courtId;
    const heading = document.createElement("h4");
    heading.className = "prelim-court-lane-heading";
    heading.dataset.prelimCourtLaneHeading = courtId;
    heading.textContent = name;
    const list = document.createElement("div");
    list.className = "prelim-match-list";
    list.dataset.prelimCourtLaneList = courtId;
    lane.append(heading, list);
    lanes.appendChild(lane);
  });
  return lanes;
}

function updatePrelimCourtLaneDefinitions(lanes) {
  const desired = new Map([
    ...workflowDraftCourts.map((court) => [
      court.id,
      formatCourtName(court.name, "이름 없는 코트"),
    ]),
    ["", "미배정"],
  ]);
  const existing = new Map(
    [...lanes.querySelectorAll(":scope > [data-prelim-court-lane]")]
      .map((lane) => [lane.dataset.prelimCourtLane || "", lane]),
  );
  desired.forEach((name, courtId) => {
    let lane = existing.get(courtId);
    if (!lane) {
      lane = document.createElement("section");
      lane.className = "prelim-court-lane";
      lane.dataset.prelimCourtLane = courtId;
      const heading = document.createElement("h4");
      heading.className = "prelim-court-lane-heading";
      heading.dataset.prelimCourtLaneHeading = courtId;
      const list = document.createElement("div");
      list.className = "prelim-match-list";
      list.dataset.prelimCourtLaneList = courtId;
      lane.append(heading, list);
      lanes.appendChild(lane);
    }
    const heading = lane.querySelector("[data-prelim-court-lane-heading]");
    if (heading) heading.textContent = name;
  });
  [...desired.keys()].forEach((courtId, index) => {
    const lane = [...lanes.querySelectorAll(":scope > [data-prelim-court-lane]")]
      .find((candidate) => (candidate.dataset.prelimCourtLane || "") === courtId);
    if (lane && lanes.children[index] !== lane) {
      lanes.insertBefore(lane, lanes.children[index] || null);
    }
  });
}

function syncPrelimExecutionProjection() {
  const schedule = prelimCourtSchedule();
  const scheduleById = new Map(schedule.map((row) => [row.match.id, row]));
  const scheduleIndex = new Map(schedule.map((row, index) => [row.match.id, index]));
  const knownCourtIds = new Set(workflowDraftCourts.map((court) => court.id));
  const activeElement = document.activeElement;
  const activeSelection = activeElement && typeof activeElement.selectionStart === "number"
    ? {
      start: activeElement.selectionStart,
      end: activeElement.selectionEnd,
      direction: activeElement.selectionDirection,
    }
    : null;
  ["prelimSetupGroups", "prelimGroups"].forEach((rootId) => {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.querySelectorAll("[data-prelim-court-lanes]").forEach((lanes) => {
      const rows = [...lanes.querySelectorAll("[data-prelim-match-row]")];
      const rowsByLane = new Map();
      updatePrelimCourtLaneDefinitions(lanes);
      rows.forEach((row) => {
        const scheduleRow = scheduleById.get(row.dataset.prelimMatchRow);
        if (!scheduleRow) return;
        const laneKey = scheduleRow.courtId && knownCourtIds.has(scheduleRow.courtId)
          ? scheduleRow.courtId
          : "";
        if (!rowsByLane.has(laneKey)) rowsByLane.set(laneKey, []);
        rowsByLane.get(laneKey).push(row);
        const executionLabel = row.querySelector("[data-prelim-execution-label]");
        if (executionLabel) executionLabel.textContent = scheduleRow.label;
        const courtBadge = row.querySelector("[data-prelim-court-badge]");
        if (courtBadge) {
          courtBadge.textContent = scheduleRow.label;
          const assigned = scheduleRow.courtId && knownCourtIds.has(scheduleRow.courtId);
          courtBadge.title = assigned
            ? `실행 순서: ${scheduleRow.label}`
            : "코트가 배정되지 않았습니다.";
          courtBadge.classList.toggle("unassigned", !assigned);
        }
      });
      rowsByLane.forEach((laneRows, laneKey) => {
        const list = [...lanes.querySelectorAll("[data-prelim-court-lane-list]")]
          .find((candidate) => (candidate.dataset.prelimCourtLaneList || "") === laneKey);
        if (!list) return;
        laneRows
          .sort((left, right) => (
            (scheduleIndex.get(left.dataset.prelimMatchRow) ?? Number.POSITIVE_INFINITY)
              - (scheduleIndex.get(right.dataset.prelimMatchRow) ?? Number.POSITIVE_INFINITY)
          ))
          .forEach((row, index) => {
            const current = list.children[index] || null;
            if (current !== row) list.insertBefore(row, current);
          });
      });
      const desiredLaneIds = new Set([
        ...workflowDraftCourts.map((court) => court.id),
        "",
      ]);
      [...lanes.querySelectorAll(":scope > [data-prelim-court-lane]")]
        .forEach((lane) => {
          const laneId = lane.dataset.prelimCourtLane || "";
          if (!desiredLaneIds.has(laneId)) {
            lane.remove();
            return;
          }
          lane.hidden = !lane.querySelector("[data-prelim-match-row]");
        });
    });
  });
  if (activeElement && activeElement.isConnected && typeof activeElement.focus === "function") {
    activeElement.focus({ preventScroll: true });
    if (activeSelection && typeof activeElement.setSelectionRange === "function") {
      activeElement.setSelectionRange(
        activeSelection.start,
        activeSelection.end,
        activeSelection.direction,
      );
    }
  }

  ["prelimSetupGroups", "prelimGroups"].forEach((rootId) => {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.querySelectorAll("[data-prelim-group-id] .ring-edge-label").forEach((label) => {
      const groupNode = label.closest("[data-prelim-group-id]");
      const group = groups.find((item) => item.id === groupNode?.dataset.prelimGroupId);
      if (!group) return;
      const groupTeams = teams.filter((team) => team.groupId === group.id);
      const ringOrder = normalizeRingOrder(group.ringOrder, groupTeams.map((team) => team.id));
      const edgeLabels = getPrelimRingEdgeLabels(ringOrder, schedule);
      const edgeIndex = Number(label.dataset.ringEdgeIndex);
      const edgeLabel = edgeLabels[edgeIndex];
      if (!edgeLabel) return;
      label.textContent = edgeLabel.text;
      label.title = edgeLabel.title;
    });
  });
}

function syncPrelimWorkflowHints() {
  ["prelimSetupGroups", "prelimGroups"].forEach((rootId) => {
    const root = document.getElementById(rootId);
    if (!root) return;
    let hint = root.querySelector(":scope > [data-prelim-workflow-hint]");
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "unsaved-change prelim-workflow-hint";
      hint.dataset.prelimWorkflowHint = "true";
      root.prepend(hint);
    }
    hint.hidden = !workflowDirty;
    hint.textContent = workflowDirty ? PRELIM_UNSAVED_PLAN_HINT : "";
  });
}

function markWorkflowDirty() {
  workflowDirty = true;
  syncWorkflowSaveControls();
}

function fillPrelimCourtSelect(select, matchKey) {
  const assignment = assignmentFor(matchKey);
  const editable = workflowMatchEditable(matchKey);
  select.replaceChildren(new Option("미배정", ""));
  workflowDraftCourts.forEach((court) => {
    select.append(new Option(formatCourtName(court.name, "이름 없는 코트"), court.id));
  });
  select.value = assignment?.courtId || "";
  select.disabled = !editable;
  select.title = !assignment
    ? "코트 배정 정보가 없습니다."
    : editable
      ? "이 경기의 코트를 선택하세요."
      : "완료되었거나 잠금·검수 중인 경기는 코트를 변경할 수 없습니다.";
}

function syncPrelimCourtSelects() {
  document.querySelectorAll("[data-prelim-court-match]").forEach((select) => {
    fillPrelimCourtSelect(select, select.dataset.prelimCourtMatch);
  });
}

function prelimCourtDisplay(matchKey) {
  const scheduleRow = prelimScheduleRow(matchKey);
  const court = scheduleRow?.courtId
    ? workflowDraftCourts.find((item) => item.id === scheduleRow.courtId)
    : null;
  return {
    label: scheduleRow?.label || "미배정",
    shortLabel: scheduleRow?.shortLabel || "—",
    recorderName: court?.recorderName?.trim() || "",
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
      renderWorkflowCourtPlanner();
    });
    name.addEventListener("change", () => {
      court.name = normalizeCourtName(name.value);
      name.value = court.name;
      resizeCourtNameInput(name);
      renderWorkflowCourtPlanner();
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
  if (!workflowCourtSwapsMatchSavedPlan()) {
    return showToast("전체 교환과 해당 코트의 개별 배정·순서·설정 변경을 함께 저장할 수 없습니다. 같은 두 코트를 다시 교환해 취소한 뒤 개별 변경을 먼저 저장하고, 전체 교환을 다시 적용하세요. 다른 관리자가 변경했다면 최신 데이터를 다시 불러오세요.");
  }
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
      courtSwaps: workflowDraftCourtSwaps.map((pair) => ({ ...pair })),
      // Keep the baseline captured with this draft: accepting live snapshots here
      // would silently overwrite a concurrent topology or queue change.
      expectedTopologyRevision: workflowTopologyBaseline,
      expectedQueueRevisions: workflowQueueRevisionBaseline,
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
  const assignment = assignmentFor(matchKey);
  const workflow = workflowStatusFor(matchKey);
  if (workflowMatchCompleted(matchKey)) return "승인됨";
  if (workflow.lock || assignment?.publicStatus === "in_progress") return "경기중";
  if (assignment?.publicStatus === "under_review" || workflow.draftState === "submitted") return "제출됨";
  if (["replay_required", "rework_required"].includes(assignment?.publicStatus)
      || workflow.draftState === "rejected") return "재입력 대기";
  if (workflow.draftState === "editing") return "작성 중";
  return "대기";
}

function workflowCompletedDisclosureKey(courtId) {
  return courtId || "__unassigned__";
}

function captureWorkflowCompletedDetails() {
  document.querySelectorAll("[data-workflow-completed-court]").forEach((details) => {
    workflowCompletedDetailsOpen.set(
      details.dataset.workflowCompletedCourt,
      details.open,
    );
  });
}

function workflowBoardDragEnabled() {
  if (workflowDraftAssignments.some((option) => !plannerPhaseMatches(option, workflowPhaseFilter))) {
    return false;
  }
  // 접힌 완료 경기나 다른 부문 경기가 하나라도 숨겨지면 전체 순서를
  // 드래그 화면에서 확인할 수 없다. 완료 details를 연 경우 활성 경기만
  // 드래그할 수 있고, 완료 카드는 여전히 읽기 전용으로 남는다.
  return !workflowDraftAssignments.some((option) => (
    workflowMatchCompleted(option.matchKey)
      && !workflowCompletedDetailsOpen.get(
        workflowCompletedDisclosureKey(assignmentFor(option.matchKey)?.courtId || null),
      )
  ));
}

function workflowBoardRoot() {
  return document.getElementById("allCourtBoard");
}

function workflowOrderedCourtKeys(courtId, excludedMatchKey = null) {
  return workflowDraftAssignments
    .map((assignment, index) => ({ assignment, index }))
    .filter(({ assignment }) => (
      (assignment.courtId || null) === (courtId || null)
        && assignment.matchKey !== excludedMatchKey
    ))
    .sort((left, right) => (
      (Number.isFinite(Number(left.assignment.courtOrder))
        ? Number(left.assignment.courtOrder)
        : Number.POSITIVE_INFINITY)
        - (Number.isFinite(Number(right.assignment.courtOrder))
          ? Number(right.assignment.courtOrder)
          : Number.POSITIVE_INFINITY)
      || left.index - right.index
    ))
    .map(({ assignment }) => assignment.matchKey);
}

function workflowDropWouldChange(sourceMatchKey, targetCourtId, beforeMatchKey) {
  const source = assignmentFor(sourceMatchKey);
  if (!source || beforeMatchKey === sourceMatchKey) return false;
  const sourceCourtId = source.courtId || null;
  const destinationCourtId = targetCourtId || null;
  const destination = workflowOrderedCourtKeys(destinationCourtId, sourceMatchKey);
  const insertionIndex = beforeMatchKey
    ? destination.indexOf(beforeMatchKey)
    : destination.length;
  if (beforeMatchKey && insertionIndex < 0) return false;
  destination.splice(insertionIndex < 0 ? destination.length : insertionIndex, 0, sourceMatchKey);
  if (sourceCourtId !== destinationCourtId) return true;
  const current = workflowOrderedCourtKeys(sourceCourtId);
  return current.length !== destination.length
    || current.some((matchKey, index) => matchKey !== destination[index]);
}

function workflowListCards(list, sourceMatchKey = null) {
  if (!list) return [];
  return [...list.querySelectorAll(".court-board-card")].filter((card) => (
    !card.classList.contains("is-completed")
      && card.dataset.workflowMatchKey !== sourceMatchKey
  ));
}

function workflowElementMidpoint(element) {
  const rect = element?.getBoundingClientRect?.();
  const top = Number(rect?.top);
  const height = Number(rect?.height);
  if (Number.isFinite(top) && Number.isFinite(height) && height >= 0) {
    return top + height / 2;
  }
  const bottom = Number(rect?.bottom);
  if (Number.isFinite(top) && Number.isFinite(bottom)) return top + (bottom - top) / 2;
  const offsetTop = Number(element?.offsetTop);
  const offsetHeight = Number(element?.offsetHeight);
  if (Number.isFinite(offsetTop) && Number.isFinite(offsetHeight) && offsetHeight >= 0) {
    return offsetTop + offsetHeight / 2;
  }
  return null;
}

function workflowDragSourceKey(event) {
  if (workflowDragMatchKey) return workflowDragMatchKey;
  try {
    return event?.dataTransfer?.getData?.("text/plain") || null;
  } catch {
    return null;
  }
}

function workflowDropTargetForList(list, column, courtId, courtName, event, sourceMatchKey) {
  const cards = workflowListCards(list, sourceMatchKey);
  let insertionIndex = cards.length;
  const pointerY = Number(event?.clientY);
  if (Number.isFinite(pointerY)) {
    for (let index = 0; index < cards.length; index += 1) {
      const midpoint = workflowElementMidpoint(cards[index]);
      if (midpoint != null && pointerY <= midpoint) {
        insertionIndex = index;
        break;
      }
    }
  }
  const beforeMatchKey = cards[insertionIndex]?.dataset.workflowMatchKey || null;
  if (!workflowDropWouldChange(sourceMatchKey, courtId, beforeMatchKey)) return null;
  return {
    sourceMatchKey,
    targetCourtId: courtId || null,
    beforeMatchKey,
    insertionIndex,
    position: workflowDropPosition(sourceMatchKey, courtId, beforeMatchKey),
    list,
    column,
    targetCard: null,
    referenceCard: cards[insertionIndex] || null,
    previousCard: cards[insertionIndex - 1] || null,
    courtName,
  };
}

function workflowDropTargetForCard(card, column, courtId, courtName, event, sourceMatchKey) {
  if (!card || card.dataset.workflowMatchKey === sourceMatchKey) return null;
  const list = card.parentElement;
  const cards = workflowListCards(list, sourceMatchKey);
  const targetIndex = cards.indexOf(card);
  if (targetIndex < 0) return null;
  const midpoint = workflowElementMidpoint(card);
  const before = midpoint == null || Number(event?.clientY) <= midpoint;
  const insertionIndex = targetIndex + (before ? 0 : 1);
  const beforeMatchKey = cards[insertionIndex]?.dataset.workflowMatchKey || null;
  if (!workflowDropWouldChange(sourceMatchKey, courtId, beforeMatchKey)) return null;
  return {
    sourceMatchKey,
    targetCourtId: courtId || null,
    beforeMatchKey,
    insertionIndex,
    position: workflowDropPosition(sourceMatchKey, courtId, beforeMatchKey),
    list,
    column,
    targetCard: card,
    referenceCard: cards[insertionIndex] || null,
    previousCard: cards[insertionIndex - 1] || null,
    before,
    courtName,
  };
}

function workflowDropPosition(sourceMatchKey, targetCourtId, beforeMatchKey) {
  const destination = workflowOrderedCourtKeys(targetCourtId, sourceMatchKey);
  const insertionIndex = beforeMatchKey
    ? destination.indexOf(beforeMatchKey)
    : destination.length;
  return (insertionIndex < 0 ? destination.length : insertionIndex) + 1;
}

function clearWorkflowDragTarget() {
  workflowDragTarget = null;
  const board = workflowBoardRoot();
  if (!board) return;
  board.querySelectorAll(".court-board-drop-indicator").forEach((indicator) => indicator.remove());
  board.querySelectorAll(".workflow-drop-target").forEach((card) => card.classList.remove("workflow-drop-target"));
  board.querySelectorAll(".court-board-column").forEach((column) => column.classList.remove("drag-over"));
}

function clearWorkflowDragState() {
  clearWorkflowDragTarget();
  workflowDragMatchKey = null;
  const board = workflowBoardRoot();
  if (!board) return;
  board.querySelectorAll(".workflow-drag-source").forEach((card) => card.classList.remove("workflow-drag-source"));
}

function setWorkflowDragTarget(target) {
  if (workflowDragTarget
      && workflowDragTarget.sourceMatchKey === target?.sourceMatchKey
      && workflowDragTarget.targetCourtId === target?.targetCourtId
      && workflowDragTarget.beforeMatchKey === target?.beforeMatchKey
      && workflowDragTarget.list === target?.list
      && workflowDragTarget.targetCard === target?.targetCard
      && workflowDragTarget.indicator?.parentNode) {
    return;
  }
  clearWorkflowDragTarget();
  if (!target?.list || !target?.column) return;
  workflowDragTarget = target;
  target.column.classList.add("drag-over");
  target.targetCard?.classList.add("workflow-drop-target");
  const indicator = document.createElement("div");
  indicator.className = "court-board-drop-indicator";
  indicator.setAttribute("role", "status");
  indicator.setAttribute("aria-live", "polite");
  indicator.dataset.workflowDropPosition = String(target.position);
  indicator.dataset.workflowDropCourt = target.targetCourtId || "unassigned";
  indicator.dataset.workflowDropPlacement = target.before === false
    || (!target.beforeMatchKey && target.previousCard)
    ? "after"
    : "before";
  const label = document.createElement("strong");
  label.textContent = `${target.courtName} · ${target.position}번째 슬롯`;
  const detail = document.createElement("span");
  detail.textContent = target.targetCard
    ? target.before ? "대상 경기 앞에 놓기" : "대상 경기 뒤에 놓기"
    : target.beforeMatchKey ? "다음 경기 앞에 놓기" : "목록 마지막에 놓기";
  indicator.append(label, detail);
  target.list.insertBefore(indicator, target.referenceCard || null);
  const listRect = target.list.getBoundingClientRect?.();
  const referenceRect = target.referenceCard?.getBoundingClientRect?.();
  const previousRect = target.previousCard?.getBoundingClientRect?.();
  const listTop = Number(listRect?.top);
  const referenceTop = Number(referenceRect?.top);
  const previousBottom = Number(previousRect?.bottom);
  const boundary = Number.isFinite(listTop) && Number.isFinite(referenceTop)
    ? referenceTop - listTop
    : Number.isFinite(listTop) && Number.isFinite(previousBottom)
      ? previousBottom - listTop
      : null;
  indicator.style.top = `${Math.max(0, boundary ?? 0)}px`;
  target.indicator = indicator;
}

function highlightWorkflowDrop(matchKey) {
  if (workflowDropHighlightTimer) clearTimeout(workflowDropHighlightTimer);
  const board = workflowBoardRoot();
  const card = [...(board?.querySelectorAll(".court-board-card") || [])]
    .find((candidate) => candidate.dataset.workflowMatchKey === matchKey);
  if (!card) {
    workflowDropHighlightTimer = null;
    return;
  }
  card.classList.add("workflow-drop-confirmed");
  workflowDropHighlightTimer = setTimeout(() => {
    card.classList.remove("workflow-drop-confirmed");
    workflowDropHighlightTimer = null;
  }, 850);
}

function commitWorkflowDragDrop(target, sourceMatchKey = workflowDragMatchKey) {
  if (!sourceMatchKey || !target || !workflowBoardDragEnabled()
      || !workflowMatchEditable(sourceMatchKey)) {
    clearWorkflowDragState();
    return false;
  }
  const { targetCourtId, beforeMatchKey } = target;
  if (beforeMatchKey && (
    !workflowMatchEditable(beforeMatchKey)
      || (assignmentFor(beforeMatchKey)?.courtId || null) !== (targetCourtId || null)
  )) {
    clearWorkflowDragState();
    return false;
  }
  clearWorkflowDragTarget();
  const moved = setMatchCourt(sourceMatchKey, targetCourtId, beforeMatchKey);
  clearWorkflowDragState();
  if (moved) highlightWorkflowDrop(sourceMatchKey);
  return moved;
}

function handleWorkflowCardDragOver(event, card, option, column, courtId, courtName) {
  const sourceMatchKey = workflowDragSourceKey(event);
  if (!sourceMatchKey || !workflowBoardDragEnabled() || !workflowMatchEditable(sourceMatchKey)) {
    clearWorkflowDragTarget();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (!workflowMatchEditable(option.matchKey) || sourceMatchKey === option.matchKey) {
    clearWorkflowDragTarget();
    return;
  }
  const target = workflowDropTargetForCard(
    card,
    column,
    courtId,
    courtName,
    event,
    sourceMatchKey,
  );
  if (target) setWorkflowDragTarget(target);
  else clearWorkflowDragTarget();
}

function handleWorkflowCardDrop(event, card, option, column, courtId, courtName) {
  event.preventDefault();
  event.stopPropagation();
  const sourceMatchKey = workflowDragSourceKey(event);
  if (!sourceMatchKey || !workflowBoardDragEnabled() || !workflowMatchEditable(sourceMatchKey)) {
    clearWorkflowDragState();
    return;
  }
  const target = workflowDragTarget;
  if (!target
      || target.sourceMatchKey !== sourceMatchKey
      || target.column !== column
      || target.targetCard !== card
      || target.targetCourtId !== (courtId || null)) {
    clearWorkflowDragState();
    return;
  }
  commitWorkflowDragDrop(target, sourceMatchKey);
}

function createWorkflowBoardCard(
  option,
  courtId,
  completed,
  dragEnabled,
  prelimSchedule = prelimCourtSchedule(allPrelimMatches),
) {
  const assignment = assignmentFor(option.matchKey);
  const card = document.createElement("article");
  card.className = `court-board-card${completed ? " is-completed" : ""}`;
  card.dataset.divisionTheme = option.divisionId || option.division || "men";
  card.dataset.workflowMatchKey = option.matchKey;
  const boardCourtName = formatCourtName(
    workflowDraftCourts.find((court) => court.id === courtId)?.name,
    courtId ? "이름 없는 코트" : "미배정",
  );
  if (!completed && dragEnabled) {
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
      if (!workflowBoardDragEnabled() || !workflowMatchEditable(option.matchKey)) {
        event.preventDefault();
        return;
      }
      clearWorkflowDragState();
      workflowDragMatchKey = option.matchKey;
      card.classList.add("workflow-drag-source");
      event.dataTransfer?.setData("text/plain", option.matchKey);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => clearWorkflowDragState());
    card.addEventListener("dragover", (event) => {
      handleWorkflowCardDragOver(event, card, option, card.closest(".court-board-column"), courtId, boardCourtName);
    });
    card.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && card.contains(event.relatedTarget)) return;
      if (workflowDragTarget?.targetCard === card) clearWorkflowDragTarget();
    });
    card.addEventListener("drop", (event) => {
      handleWorkflowCardDrop(event, card, option, card.closest(".court-board-column"), courtId, boardCourtName);
    });
  } else {
    card.draggable = false;
  }
  const prelimMatch = option.matchType === "prelim"
    ? allPrelimMatches.find((match) => match.id === option.matchKey)
    : null;
  const boardLabel = document.createElement("b");
  // 예선 카드는 구조상 "대진 N" 대신 코트별 배정 위치(코트·N라운드)를 그대로 보여준다.
  const executionLabel = prelimMatch
    ? prelimScheduleRow(option.matchKey, prelimSchedule)?.label
    : null;
  boardLabel.textContent = prelimMatch
    ? (executionLabel || "순서 미배정")
    : option.label;
  card.appendChild(boardLabel);
  const teams = document.createElement("span");
  teams.textContent = option.teams;
  const status = document.createElement("span");
  status.className = "badge";
  status.textContent = workflowStatusBadge(option.matchKey);
  card.append(teams, status);
  if (completed) return card;

  const controls = document.createElement("div");
  controls.className = "court-board-controls";
  const select = document.createElement("select");
  select.setAttribute("aria-label", `${option.teams} 코트 선택`);
  select.append(new Option("미배정", ""));
  workflowDraftCourts.forEach((court) => select.append(new Option(formatCourtName(court.name, "이름 없는 코트"), court.id)));
  select.value = assignment?.courtId || "";
  select.addEventListener("change", () => setMatchCourt(option.matchKey, select.value));
  controls.appendChild(select);

  const adjacent = getPlannerVisibleAdjacent(
    workflowDraftAssignments,
    workflowDraftAssignments,
    reviewWorkflows,
    option.matchKey,
    workflowPhaseFilter,
  );
  [
    ["↑", -1, adjacent.previousMatchKey, "이전 활성 경기와 순서 바꾸기"],
    ["↓", 1, adjacent.nextMatchKey, "다음 활성 경기와 순서 바꾸기"],
  ].forEach(([text, offset, targetKey, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workflow-icon-btn";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.disabled = !targetKey || !workflowMatchEditable(targetKey);
    button.addEventListener("click", () => moveWorkflowMatch(option.matchKey, offset));
    controls.appendChild(button);
  });
  card.appendChild(controls);
  return card;
}

function renderCourtBoard() {
  clearWorkflowDragState();
  const root = document.getElementById("allCourtBoard");
  if (!root) return;
  if (!root.dataset.workflowDragBound) {
    root.dataset.workflowDragBound = "true";
    root.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && root.contains(event.relatedTarget)) return;
      clearWorkflowDragTarget();
    });
  }
  const options = workflowDraftAssignments;
  const prelimSchedule = prelimCourtSchedule(allPrelimMatches);
  captureWorkflowCompletedDetails();
  syncWorkflowPhaseFilter();
  const dragEnabled = workflowBoardDragEnabled();
  const dragHint = document.getElementById("workflowDragHint");
  if (dragHint) {
    dragHint.hidden = dragEnabled;
    dragHint.textContent = dragEnabled ? "" : WORKFLOW_DRAG_HINT;
  }
  const grouped = groupPlannerAssignments(options, options, workflowPhaseFilter);
  root.replaceChildren();
  const columns = [[null, "미배정"], ...workflowDraftCourts.map((court) => [court.id, formatCourtName(court.name, "이름 없는 코트")])];
  columns.forEach(([courtId, name]) => {
    const column = document.createElement("section");
    column.className = "court-board-column";
    column.addEventListener("dragover", (event) => {
      const cardTarget = event.target?.closest?.(".court-board-card");
      if (cardTarget && column.contains(cardTarget)) {
        clearWorkflowDragTarget();
        return;
      }
      const sourceMatchKey = workflowDragSourceKey(event);
      if (!sourceMatchKey || !workflowBoardDragEnabled() || !workflowMatchEditable(sourceMatchKey)) {
        clearWorkflowDragTarget();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const target = workflowDropTargetForList(
        list,
        column,
        courtId,
        name,
        event,
        sourceMatchKey,
      );
      if (target) setWorkflowDragTarget(target);
      else clearWorkflowDragTarget();
    });
    column.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && column.contains(event.relatedTarget)) return;
      if (workflowDragTarget?.column === column) clearWorkflowDragTarget();
      else column.classList.remove("drag-over");
    });
    column.addEventListener("drop", (event) => {
      const cardTarget = event.target?.closest?.(".court-board-card");
      if (cardTarget && column.contains(cardTarget)) return;
      event.preventDefault();
      event.stopPropagation();
      const sourceMatchKey = workflowDragSourceKey(event);
      if (!sourceMatchKey || !workflowBoardDragEnabled() || !workflowMatchEditable(sourceMatchKey)) {
        clearWorkflowDragState();
        return;
      }
      const target = workflowDragTarget;
      if (!target
          || target.sourceMatchKey !== sourceMatchKey
          || target.column !== column
          || target.targetCard
          || target.targetCourtId !== (courtId || null)) {
        clearWorkflowDragState();
        return;
      }
      commitWorkflowDragDrop(target, sourceMatchKey);
    });
    const heading = document.createElement("h3");
    const headingName = document.createElement("span");
    headingName.textContent = name;
    const visible = (grouped.get(courtId) || [])
      .slice()
      .sort((left, right) => (
        (assignmentFor(left.matchKey)?.courtOrder || 0)
          - (assignmentFor(right.matchKey)?.courtOrder || 0)
      ));
    const active = visible.filter((option) => !workflowMatchCompleted(option.matchKey));
    const completed = visible.filter((option) => workflowMatchCompleted(option.matchKey));
    const counts = document.createElement("span");
    counts.className = "court-board-counts";
    const upcomingCount = document.createElement("span");
    upcomingCount.className = "court-board-count upcoming";
    upcomingCount.textContent = `진행 예정 ${active.length}경기`;
    const completedCount = document.createElement("span");
    completedCount.className = "court-board-count completed";
    completedCount.textContent = `완료 ${completed.length}경기`;
    counts.append(upcomingCount, completedCount);
    heading.append(headingName, counts);
    let swapControls = null;
    if (courtId && workflowDraftCourts.length > 1) {
      const target = document.createElement("select");
      target.className = "court-board-swap-target";
      target.setAttribute("aria-label", `${name} 경기 목록을 교환할 코트`);
      workflowDraftCourts
        .filter((court) => court.id !== courtId)
        .forEach((court) => target.append(new Option(
          formatCourtName(court.name, "이름 없는 코트"),
          court.id,
        )));
      const swap = document.createElement("button");
      swap.type = "button";
      swap.className = "btn small";
      swap.textContent = "전체 교환";
      swap.setAttribute("aria-label", `${name}와 다른 코트의 전체 경기 목록 교환`);
      swap.title = "예정·진행 중·완료 경기를 모두 다른 코트와 교환";
      swap.addEventListener("click", () => {
        if (target.value) swapWorkflowCourts(courtId, target.value);
      });
      swapControls = document.createElement("div");
      swapControls.className = "court-board-swap-controls";
      swapControls.append(target, swap);
    }
    column.appendChild(heading);
    if (swapControls) column.appendChild(swapControls);
    const list = document.createElement("div");
    list.className = "court-board-list";
    active.forEach((option) => {
      list.appendChild(createWorkflowBoardCard(option, courtId, false, dragEnabled, prelimSchedule));
    });
    if (!list.children.length) list.innerHTML = '<p class="workflow-empty">경기가 없습니다.</p>';
    column.appendChild(list);
    if (completed.length) {
      const details = document.createElement("details");
      details.className = "court-board-completed";
      details.dataset.workflowCompletedCourt = workflowCompletedDisclosureKey(courtId);
      details.open = workflowCompletedDetailsOpen.get(details.dataset.workflowCompletedCourt) === true;
      details.addEventListener("toggle", () => {
        workflowCompletedDetailsOpen.set(
          details.dataset.workflowCompletedCourt,
          details.open,
        );
      });
      const summary = document.createElement("summary");
      summary.textContent = `완료 경기 ${completed.length}개`;
      const completedList = document.createElement("div");
      completedList.className = "court-board-completed-list";
      completed.forEach((option) => {
        completedList.appendChild(createWorkflowBoardCard(option, courtId, true, false, prelimSchedule));
      });
      details.append(summary, completedList);
      column.appendChild(details);
    }
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

function buildReviewScoreboard(display, scoreSource, scoreState = "draft") {
  const sets = Array.isArray(scoreSource?.sets)
    ? scoreSource.sets.filter((set) => Number.isInteger(set?.a) && Number.isInteger(set?.b))
    : [];
  if (!sets.length) return null;
  const winsA = sets.filter((set) => set.a > set.b).length;
  const winsB = sets.filter((set) => set.b > set.a).length;
  const board = document.createElement("section");
  board.className = "review-scoreboard";
  const scoreLabels = {
    submitted: { short: "제출", title: "기록관 제출 점수" },
    draft: { short: "임시", title: "현재 임시 점수" },
    official: { short: "공식", title: "현재 공식 점수" },
  };
  const scoreLabel = scoreLabels[scoreState] || scoreLabels.draft;
  board.setAttribute("aria-label", `${display.teamA} 대 ${display.teamB} 세트별 ${scoreLabel.short} 점수`);

  const heading = document.createElement("div");
  heading.className = "review-score-heading";
  const title = document.createElement("strong");
  title.textContent = scoreLabel.title;
  const total = document.createElement("span");
  total.textContent = `세트 스코어 ${winsA} : ${winsB}`;
  heading.append(title, total);

  const table = document.createElement("table");
  table.className = "review-score-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["세트", display.teamA, display.teamB].forEach((label, index) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    if (index > 0) cell.className = "review-score-team";
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);

  const body = document.createElement("tbody");
  sets.forEach((set, index) => {
    const row = document.createElement("tr");
    const setLabel = document.createElement("th");
    setLabel.scope = "row";
    setLabel.textContent = `${index + 1}세트`;
    const scoreA = document.createElement("td");
    const scoreB = document.createElement("td");
    scoreA.textContent = String(set.a);
    scoreB.textContent = String(set.b);
    if (set.a > set.b) scoreA.className = "set-winner";
    if (set.b > set.a) scoreB.className = "set-winner";
    row.append(setLabel, scoreA, scoreB);
    body.appendChild(row);
  });
  table.append(head, body);
  board.append(heading, table);
  return board;
}

function renderScoreReviews() {
  const root = document.getElementById("scoreReviewList");
  if (!root) return;
  renderCorrectionMatchCards();
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
    const submittedAt = workflow.submittedAt?.toDate?.()?.toLocaleString?.()
      || audit?.createdAt?.toDate?.()?.toLocaleString?.()
      || workflow.updatedAt?.toDate?.()?.toLocaleString?.()
      || "";
    const author = isSubmitted
      ? (workflow.submission?.recorder?.name || "기록관")
      : (workflow.lock?.recorderName || "기록관");
    const scoreSource = workflow.submittedSnapshot || workflow.draft;
    const scoreboard = buildReviewScoreboard(display, scoreSource, isSubmitted ? "submitted" : "draft");
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
      + (submittedAt ? `<span class="review-info-chip"><small>제출 시간</small><strong>${escapeHtml(submittedAt)}</strong></span>` : "");
    const actions = document.createElement("div");
    actions.className = "review-actions";
    row.append(header, matchup);
    if (scoreboard) row.append(scoreboard);
    row.append(meta, actions);
    const approve = document.createElement("button");
    approve.className = "btn primary small";
    approve.textContent = assignment.matchType === "final" ? "공개 초안에 반영" : "승인";
    approve.addEventListener("click", async () => {
      if (assignment.matchType === "final") {
        stageSubmittedFinalReview(assignment, workflow);
        return;
      }
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
    if (isSubmitted) {
      actions.append(approve, reject);
    }
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

function recorderGrantTime(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString() : "기록 없음";
}

function shortRecorderUid(uid) {
  const value = String(uid || "");
  if (value.length <= 14) return value;
  return `${value.slice(0, 7)}…${value.slice(-5)}`;
}

function recorderGrantState(grant) {
  if (grant.effectiveStatus === "revoked") return { label: "접근 취소됨", className: "revoked" };
  if (grant.effectiveStatus === "expired") return { label: "만료됨", className: "expired" };
  if (grant.effectiveStatus === "superseded") return { label: "이전 코드 권한", className: "expired" };
  if (grant.effectiveStatus === "disabled") return { label: "전체 비활성", className: "expired" };
  return { label: "활성", className: "active" };
}

const RECORDER_GRANT_EFFECTIVE_STATUSES = new Set([
  "active", "expired", "revoked", "superseded", "disabled",
]);
const RECORDER_GRANT_STATUSES = new Set(["active", "revoked"]);

function recorderGrantDisplayEmail(grant) {
  return grant.email || "이메일 정보 없음";
}

function recorderGrantDisplayName(grant) {
  return grant.displayName || "이름 정보 없음";
}

function appendRecorderGrantMeta(parent, label, value) {
  const item = document.createElement("span");
  const labelNode = document.createElement("small");
  labelNode.textContent = label;
  const valueNode = document.createElement("span");
  valueNode.textContent = value;
  item.append(labelNode, valueNode);
  parent.appendChild(item);
}

function recorderGrantConfirmationName(grant) {
  return `${recorderGrantDisplayEmail(grant)} / ${recorderGrantDisplayName(grant)}`;
}

function createRecorderGrantCard(grant) {
  const state = recorderGrantState(grant);
  const row = document.createElement("article");
  row.className = "recorder-grant-card";
  row.dataset.recorderGrantStatus = grant.effectiveStatus;
  row.dataset.recorderGrantKind = grant.effectiveStatus === "active" ? "active" : "history";

  const identity = document.createElement("div");
  identity.className = "recorder-grant-identity";
  const email = document.createElement("strong");
  email.className = "recorder-grant-email";
  email.textContent = recorderGrantDisplayEmail(grant);
  const displayName = document.createElement("span");
  displayName.className = "recorder-grant-display-name";
  displayName.textContent = recorderGrantDisplayName(grant);
  identity.append(email, displayName);
  if (grant.accountDeleted) {
    const accountDeleted = document.createElement("span");
    accountDeleted.className = "recorder-grant-account-deleted";
    accountDeleted.textContent = "삭제된 로그인 계정";
    identity.appendChild(accountDeleted);
  }

  const details = document.createElement("div");
  details.className = "recorder-grant-details";
  appendRecorderGrantMeta(details, "발급", recorderGrantTime(grant.issuedAt));
  appendRecorderGrantMeta(details, "마지막 사용", recorderGrantTime(grant.lastUsedAt));
  appendRecorderGrantMeta(details, "만료", recorderGrantTime(grant.expiresAt));
  if (grant.revokedAt != null) {
    appendRecorderGrantMeta(details, "접근 취소", recorderGrantTime(grant.revokedAt));
  }

  const badge = document.createElement("span");
  badge.className = `recorder-grant-state ${state.className}`;
  badge.textContent = state.label;

  const accountDetails = document.createElement("details");
  accountDetails.className = "recorder-grant-account";
  const accountSummary = document.createElement("summary");
  accountSummary.textContent = "계정 정보";
  const accountBody = document.createElement("div");
  accountBody.className = "recorder-grant-account-body";
  const uidLabel = document.createElement("small");
  uidLabel.textContent = "UID";
  const uid = document.createElement("button");
  uid.type = "button";
  uid.className = "recorder-uid";
  uid.textContent = shortRecorderUid(grant.uid);
  uid.title = `${grant.uid} 복사`;
  uid.setAttribute("aria-label", `기록관 UID ${grant.uid} 복사`);
  uid.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(grant.uid);
      showToast("기록관 UID를 복사했습니다.");
    } catch {
      showToast("UID 복사에 실패했습니다. 브라우저 권한을 확인하세요.");
    }
  });
  accountBody.append(uidLabel, uid);
  accountDetails.append(accountSummary, accountBody);

  row.append(identity, badge, details, accountDetails);
  if (grant.status !== "revoked") {
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "btn danger small";
    revoke.textContent = "접근 권한 취소";
    revoke.addEventListener("click", async () => {
      const name = recorderGrantConfirmationName(grant);
      if (!confirm(`${name}의 기록관 접근 권한을 취소할까요?\n이 작업은 접근 권한만 취소하며 로그인 계정 자체는 삭제하지 않습니다.\n다른 기록관의 권한, 입력 중인 초안 및 잠금은 변경되지 않습니다.`)) return;
      const result = await runWorkflowButton(
        revoke,
        "계정별 접근 권한 취소",
        () => adminWorkflowCallable("revokeRecorderGrant", { uid: grant.uid }),
      );
      if (result?.revoked) {
        showToast("해당 계정의 기록관 접근 권한을 취소했습니다.");
        refreshRecorderGrants();
      }
    });
    row.appendChild(revoke);
  }
  return row;
}

function renderRecorderGrantHistory(history) {
  const historyDetails = document.getElementById("recorderGrantHistory");
  const historySummary = document.getElementById("recorderGrantHistorySummary");
  const historyRoot = document.getElementById("recorderGrantHistoryList");
  const moreButton = document.getElementById("recorderGrantHistoryMoreBtn");
  if (!historyDetails || !historySummary || !historyRoot || !moreButton) return;
  historyRoot.replaceChildren();
  historySummary.textContent = `이력 (${history.length}건)`;
  history.slice(0, recorderGrantsHistoryVisibleCount).forEach((grant) => {
    historyRoot.appendChild(createRecorderGrantCard(grant));
  });
  moreButton.hidden = recorderGrantsHistoryVisibleCount >= history.length;
  moreButton.disabled = false;
  if (!moreButton.recorderGrantHistoryBound) {
    moreButton.recorderGrantHistoryBound = true;
    moreButton.addEventListener("click", () => {
      recorderGrantsHistoryVisibleCount += 20;
      renderRecorderGrants();
    });
  }
  historyDetails.hidden = false;
}

function renderRecorderGrants() {
  const root = document.getElementById("recorderGrantList");
  const status = document.getElementById("recorderGrantStatus");
  const historyDetails = document.getElementById("recorderGrantHistory");
  const historyRoot = document.getElementById("recorderGrantHistoryList");
  const moreButton = document.getElementById("recorderGrantHistoryMoreBtn");
  if (!root || !status) return;
  root.replaceChildren();
  if (historyRoot) historyRoot.replaceChildren();
  if (historyDetails) historyDetails.hidden = true;
  if (moreButton) moreButton.hidden = true;
  if (recorderGrantsLoading) {
    status.textContent = `권한 목록을 불러오는 중입니다. ${recorderGrantsLoadedCount}개 확인`;
    return;
  }
  if (recorderGrantsError) {
    status.textContent = recorderGrantsError;
    return;
  }
  const active = recorderGrants.filter((grant) => grant.effectiveStatus === "active");
  const history = recorderGrants.filter((grant) => grant.effectiveStatus !== "active");
  status.textContent = active.length
    ? `${active.length}개 활성 접근 권한`
    : "활성 접근 권한이 없습니다.";
  active.forEach((grant) => root.appendChild(createRecorderGrantCard(grant)));
  renderRecorderGrantHistory(history);
}

function recorderGrantDateValue(value) {
  return value === null
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validateRecorderGrant(grant) {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
    throw new Error("권한 목록 항목 형식이 올바르지 않습니다.");
  }
  if (typeof grant.uid !== "string" || !grant.uid
    || !Number.isInteger(grant.version) || grant.version < 0
    || !RECORDER_GRANT_STATUSES.has(grant.status)
    || !RECORDER_GRANT_EFFECTIVE_STATUSES.has(grant.effectiveStatus)
    || !recorderGrantDateValue(grant.issuedAt)
    || !recorderGrantDateValue(grant.lastUsedAt)
    || !recorderGrantDateValue(grant.expiresAt)
    || !recorderGrantDateValue(grant.revokedAt)
    || !(typeof grant.email === "string" || grant.email === null)
    || !(typeof grant.displayName === "string" || grant.displayName === null)
    || typeof grant.accountDeleted !== "boolean") {
    throw new Error("권한 목록 항목 형식이 올바르지 않습니다.");
  }
  return grant;
}

function validateRecorderGrantPage(payload, seenUids, seenCursors, currentCursor) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Object.prototype.hasOwnProperty.call(payload, "grants")
    || !Object.prototype.hasOwnProperty.call(payload, "nextCursor")
    || !Array.isArray(payload.grants)
    || payload.grants.length > 100
    || !(payload.nextCursor === null
      || (typeof payload.nextCursor === "string"
        && payload.nextCursor.length > 0
        && payload.nextCursor.length <= 128
        && !payload.nextCursor.includes("/")))) {
    throw new Error("권한 목록 응답 형식이 올바르지 않습니다.");
  }
  const grants = payload.grants.map((grant) => {
    const valid = validateRecorderGrant(grant);
    if (seenUids.has(valid.uid)) throw new Error("권한 목록에 중복된 계정이 있습니다.");
    seenUids.add(valid.uid);
    return valid;
  });
  if (payload.nextCursor !== null
    && (payload.nextCursor === currentCursor || seenCursors.has(payload.nextCursor))) {
    throw new Error("권한 목록 페이지 커서가 반복되었습니다.");
  }
  if (payload.nextCursor !== null
    && (grants.length === 0 || grants.at(-1).uid !== payload.nextCursor)) {
    throw new Error("권한 목록 페이지 커서가 마지막 항목과 일치하지 않습니다.");
  }
  if (payload.nextCursor !== null) seenCursors.add(payload.nextCursor);
  return { grants, nextCursor: payload.nextCursor };
}

async function refreshRecorderGrants() {
  if (recorderGrantsLoading || !recorderGrantsAuthUid) return;
  const requestToken = ++recorderGrantsRefreshToken;
  const requestUid = recorderGrantsAuthUid;
  const isCurrentRequest = () => requestToken === recorderGrantsRefreshToken
    && requestUid === recorderGrantsAuthUid;
  recorderGrantsLoading = true;
  recorderGrantsError = "";
  recorderGrants = [];
  recorderGrantsLoadedCount = 0;
  recorderGrantsHistoryVisibleCount = 20;
  const historyDetails = document.getElementById("recorderGrantHistory");
  if (historyDetails) historyDetails.open = false;
  const refreshButton = document.getElementById("refreshRecorderGrantsBtn");
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = "불러오는 중…";
  }
  renderRecorderGrants();
  const grants = [];
  const seenUids = new Set();
  const seenCursors = new Set();
  let cursor = null;
  try {
    while (true) {
      const requestData = cursor === null ? {} : { cursor };
      const result = await adminWorkflowCallable("listRecorderGrants", requestData);
      if (!isCurrentRequest()) return;
      const page = validateRecorderGrantPage(
        result?.data,
        seenUids,
        seenCursors,
        cursor,
      );
      grants.push(...page.grants);
      recorderGrantsLoadedCount = grants.length;
      renderRecorderGrants();
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    if (!isCurrentRequest()) return;
    recorderGrants = grants.sort((a, b) => (
      Number(b.issuedAt || 0) - Number(a.issuedAt || 0)
    ));
    recorderGrantsError = "";
  } catch (err) {
    if (!isCurrentRequest()) return;
    recorderGrants = [];
    recorderGrantsError = "권한 목록을 불러오지 못했습니다. 새로고침해 다시 확인하세요.";
    reportError("기록관 권한 목록", err);
  } finally {
    if (!isCurrentRequest()) return;
    recorderGrantsLoading = false;
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = "권한 목록 새로고침";
    }
    renderRecorderGrants();
  }
}

function activeRecorderLockList() {
  return reviewAssignments
    .map((assignment) => ({ assignment, workflow: reviewWorkflows.get(assignment.id) }))
    .filter(({ workflow }) => workflow?.lock && workflow.draftState === "editing")
    .map(({ assignment, workflow }) => {
      const court = reviewCourts.get(assignment.courtId);
      const display = scoreReviewDisplay(assignment);
      return {
        recorder: `${workflow.lock.recorderName || "이름 없음"} (${shortRecorderUid(workflow.lock.uid)})`,
        court: court?.name ? formatCourtName(court.name) : "미배정 코트",
        match: `${[display.divisionName, ...display.matchParts].filter(Boolean).join(" · ") || "경기"} [${assignment.id}]`,
      };
    });
}

function confirmGlobalRecorderCodeAction(actionLabel) {
  if (!Object.values(recorderLockInventoryReady).every(Boolean)) {
    showToast("현재 편집 잠금 목록을 아직 불러오는 중입니다. 잠시 후 다시 시도하세요.", 5000);
    return false;
  }
  const locks = activeRecorderLockList();
  const affected = locks.length
    ? `\n\n현재 편집 잠금 ${locks.length}건(유지됨):\n${locks.map((item) => `- 기록관 ${item.recorder} / ${item.court} / ${item.match}`).join("\n")}`
    : "\n\n현재 편집 잠금은 없습니다.";
  return confirm(`${actionLabel}하면 모든 기록관의 기존 접근 권한이 무효화됩니다. 초안과 잠금은 자동 해제하거나 삭제하지 않습니다.${affected}\n\n초안·잠금을 유지한 채 진행하려면 확인을, 취소하려면 취소를 누르세요. 잠금 해제는 검수 목록의 ‘잠금 강제 해제’로 별도 처리합니다.`);
}

function correctionOfficialMatch(assignment) {
  const division = assignment.divisionId || assignment.division || "men";
  return assignment.matchType === "final"
    ? reviewFinalMatchesByDivision[division]?.find((match) => match.id === assignment.matchId)
    : allPrelimMatches.find((match) => match.id === assignment.matchId);
}

function correctionCandidate(assignment) {
  const officialMatch = correctionOfficialMatch(assignment);
  const display = scoreReviewDisplay(assignment);
  const names = courtTeamNames(
    officialMatch,
    new Map(allTeams.map((team) => [team.id, team])),
  );
  const court = reviewCourts.get(assignment.courtId);
  const groupReady = assignment.matchType === "final"
    || Boolean(officialMatch?.groupId && allGroups.some((group) => group.id === officialMatch.groupId));
  const scoreReady = Array.isArray(officialMatch?.sets)
    && officialMatch.sets.some((set) => Number.isInteger(set?.a) && Number.isInteger(set?.b));
  const entitiesReady = Boolean(
    officialMatch
      && court
      && (assignment.divisionId || assignment.division)
      && groupReady
      && scoreReady
      && names?.a
      && names?.b
      && names.a !== "대진 미정"
      && names.b !== "대진 미정",
  );
  return {
    id: assignment.id,
    assignment,
    workflow: reviewWorkflows.get(assignment.id),
    officialMatch,
    display,
    entitiesReady,
  };
}

function correctionCandidates() {
  return reviewAssignments.map(correctionCandidate);
}

function correctionEligibleCandidates() {
  return eligibleCorrectionCandidates(correctionCandidates());
}

function correctionMetadataBadges(display) {
  const parts = display.matchParts || [];
  const combined = parts.join(" · ") || "경기";
  let groupPhase = parts.length > 1 ? parts[0] : combined;
  let match = parts.length > 1 ? parts.slice(1).join(" · ") : "";
  if (!match) {
    const parsed = combined.match(/^(.*?)(?:\s+(\d+경기))$/u);
    if (parsed) {
      groupPhase = parsed[1];
      match = parsed[2];
    }
  }
  return [
    ["court", display.courtName],
    ["division", display.divisionName],
    ["group-phase", groupPhase],
    ["match", match || "경기"],
  ];
}

function appendCorrectionMeta(parent, display) {
  const meta = document.createElement("div");
  meta.className = "correction-card-meta correction-meta";
  correctionMetadataBadges(display).forEach(([kind, text]) => {
    const badge = document.createElement("span");
    badge.className = "correction-meta-badge";
    badge.dataset.kind = kind;
    badge.textContent = text;
    meta.appendChild(badge);
  });
  parent.appendChild(meta);
}

function appendCorrectionScoreboard(parent, candidate, scoreState = "official") {
  const scoreboard = buildReviewScoreboard(
    candidate.display,
    candidate.officialMatch || candidate.workflow?.officialSnapshot,
    scoreState,
  );
  if (scoreboard) parent.appendChild(scoreboard);
}

function correctionCard(candidate, { selectable = true, selected = false } = {}) {
  const card = document.createElement(selectable ? "label" : "article");
  card.className = "correction-match-card";
  if (selected) card.classList.add("is-selected");
  card.dataset.correctionMatch = "true";
  if (selectable) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "correction-match-checkbox";
    checkbox.dataset.matchKey = candidate.id;
    checkbox.checked = selected;
    checkbox.setAttribute("aria-label", `${candidate.display.teamA} 대 ${candidate.display.teamB} 정정 대상 선택`);
    card.appendChild(checkbox);
  }
  const content = document.createElement("div");
  content.className = "correction-card-content";
  appendCorrectionMeta(content, candidate.display);
  appendCorrectionScoreboard(content, candidate);
  card.appendChild(content);
  return card;
}

function renderCorrectionStatus(candidates) {
  const status = document.getElementById("correctionStatus");
  const count = document.getElementById("correctionSelectionCount");
  if (!status || !count) return;
  const selectedInfo = correctionSelectionInfo(correctionSelection, candidates);
  count.textContent = `${correctionSelection.size}경기 선택`;
  if (!candidates.length) {
    const loading = !recorderLockInventoryReady.assignments
      || !recorderLockInventoryReady.workflows
      || !recorderLockInventoryReady.courts;
    status.textContent = loading
      ? "승인된 공식 경기 정보를 불러오는 중입니다."
      : "현재 정정할 승인 경기가 없습니다.";
    return;
  }
  status.textContent = selectedInfo.courtId
    ? `${correctionSelection.size}경기 선택 · ${formatCourtName(reviewCourts.get(selectedInfo.courtId)?.name, "선택한 코트")}만 선택할 수 있습니다. 한 코트씩 진행하세요.`
    : "같은 코트의 승인 경기만 여러 개 선택할 수 있습니다. 코트가 다르면 한 코트씩 진행하세요.";
}

function updateCorrectionControls(candidates = correctionCandidates()) {
  const selectedInfo = correctionSelectionInfo(correctionSelection, candidates);
  const activeLocks = selectedInfo.selectedCandidates
    .filter((candidate) => candidate.workflow?.lock)
    .map((candidate) => candidate.id);
  const reason = document.getElementById("correctionReason")?.value || "";
  const acknowledged = document.getElementById("correctionAcknowledge")?.checked || false;
  const state = correctionConfirmationState({
    selectedKeys: correctionSelection,
    preview: correctionPreview,
    generation: correctionPreviewGeneration,
    reason,
    acknowledged,
    activeLocks,
  });
  const previewButton = document.getElementById("previewCorrectionBtn");
  if (previewButton) {
    previewButton.disabled = correctionPreviewInFlight || correctionApplyInFlight
      || !selectedInfo.selectedCandidates.length
      || !selectedInfo.sameCourt
      || activeLocks.length > 0;
  }
  const panel = document.getElementById("correctionApplyPanel");
  if (panel) panel.hidden = !state.previewValid;
  const applyButton = document.getElementById("applyCorrectionBtn");
  if (applyButton) applyButton.disabled = correctionPreviewInFlight || correctionApplyInFlight || !state.canApply;
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  document.querySelectorAll("#correctionMatchList .correction-match-checkbox").forEach((checkbox) => {
    const candidate = candidatesById.get(checkbox.dataset.matchKey);
    checkbox.disabled = correctionApplyInFlight || !candidate
      || Boolean(selectedInfo.courtId && candidate.assignment.courtId !== selectedInfo.courtId);
  });
  const reasonInput = document.getElementById("correctionReason");
  const acknowledgement = document.getElementById("correctionAcknowledge");
  if (reasonInput) reasonInput.disabled = correctionApplyInFlight;
  if (acknowledgement) acknowledgement.disabled = correctionApplyInFlight;
  const guidance = document.getElementById("correctionApplyGuidance");
  if (guidance && state.previewValid && activeLocks.length) {
    guidance.textContent = "선택한 경기의 기록 입력 잠금이 해제될 때까지 적용할 수 없습니다. 잠시 후 최신 상태를 확인하세요.";
  }
  const stage = !state.hasSelection ? "choose" : !state.previewValid ? "preview" : "reason";
  document.querySelectorAll("#correctionSection .correction-step").forEach((step, index) => {
    step.classList.toggle("is-current", (stage === "choose" && index === 0)
      || (stage === "preview" && index === 1)
      || (stage === "reason" && index === 2));
  });
  const status = document.getElementById("correctionStatus");
  if (status) status.dataset.stage = stage;
}

function renderCorrectionMatchCards() {
  const root = document.getElementById("correctionMatchList");
  if (!root) return;
  const candidates = correctionCandidates();
  const eligible = correctionEligibleCandidates();
  const nextSelection = correctionSelectionKeys(correctionSelection, candidates);
  const selectionChanged = !correctionSelectionMatches(correctionSelection, nextSelection);
  correctionSelection = nextSelection;
  if (selectionChanged && correctionPreview) {
    invalidateCorrectionPreview(
      "선택한 경기 중 현재 정정할 수 없는 경기가 있어 선택을 다시 확인하세요.",
      { clearReason: true },
    );
  }
  root.replaceChildren();
  if (!eligible.length) {
    renderCorrectionStatus(eligible);
    updateCorrectionControls(eligible);
    return;
  }
  const selectedInfo = correctionSelectionInfo(correctionSelection, eligible);
  eligible.forEach((candidate) => {
    const selected = correctionSelection.has(candidate.id);
    const unavailable = selectedInfo.courtId && selectedInfo.courtId !== candidate.assignment.courtId;
    const card = correctionCard(candidate, { selected });
    if (unavailable) card.classList.add("is-unavailable");
    const checkbox = card.querySelector(".correction-match-checkbox");
    if (checkbox) {
      checkbox.disabled = correctionApplyInFlight || Boolean(unavailable);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) correctionSelection.add(candidate.id);
        else correctionSelection.delete(candidate.id);
        invalidateCorrectionPreview(
          "선택한 경기가 바뀌었습니다. ‘변경 내용 확인’을 다시 눌러주세요.",
          { clearReason: true },
        );
        renderCorrectionMatchCards();
      });
    }
    root.appendChild(card);
  });
  renderCorrectionStatus(eligible);
  updateCorrectionControls(candidates);
}

function correctionMatchLabel(matchKey, requireEligible = false) {
  const candidate = correctionCandidates().find((item) => item.id === matchKey);
  if (!candidate || (requireEligible && !isCorrectionCandidateEligible(candidate))) return null;
  return candidate;
}

function renderCorrectionQueueCard(title, matchKey, modifier) {
  const card = document.createElement("article");
  card.className = `correction-preview-card correction-preview-queue ${modifier}`;
  const heading = document.createElement("h5");
  heading.textContent = title;
  card.appendChild(heading);
  const candidate = correctionMatchLabel(matchKey);
  if (!candidate) {
    const empty = document.createElement("p");
    empty.className = "correction-guidance";
    empty.textContent = "대기 경기 없음";
    card.appendChild(empty);
    return card;
  }
  const name = document.createElement("strong");
  name.textContent = `${candidate.display.teamA} vs ${candidate.display.teamB}`;
  card.appendChild(name);
  appendCorrectionMeta(card, candidate.display);
  return card;
}

function renderCorrectionPreviewGuidance(message) {
  const preview = document.getElementById("correctionPreview");
  if (!preview) return;
  const guidance = document.createElement("p");
  guidance.className = "correction-guidance correction-preview-guidance";
  guidance.textContent = message;
  preview.replaceChildren(guidance);
  const panel = document.getElementById("correctionApplyPanel");
  if (panel) panel.hidden = true;
}

function renderCorrectionPreview(result, matchKeys, activeLocks) {
  const preview = document.getElementById("correctionPreview");
  if (!preview) return;
  preview.replaceChildren();
  const projection = result.projection || {};
  const replayKeys = new Set(projection.replayMatchKeys || []);
  const inPlaceKeys = new Set(projection.inPlaceMatchKeys || []);
  const warning = document.createElement("div");
  warning.className = "correction-score-withdrawal";
  warning.setAttribute("role", "note");
  warning.innerHTML = "<strong>관객 화면에서도 기존 결과가 취소됩니다</strong><span>기록관이 점수를 다시 입력하고 관리자가 승인해야 공식 결과로 반영됩니다. 이 화면에서 새 점수를 입력하거나 실제 경기를 다시 진행하는 것은 아닙니다. 본선은 연결된 다음 경기의 출전 팀도 바뀔 수 있습니다.</span>";
  preview.appendChild(warning);

  const affected = document.createElement("section");
  affected.className = "correction-preview-affected";
  const affectedHeading = document.createElement("h4");
  affectedHeading.textContent = "선택한 정정 대상";
  affected.appendChild(affectedHeading);
  const affectedGrid = document.createElement("div");
  affectedGrid.className = "correction-preview-grid correction-preview-selected";
  matchKeys.forEach((matchKey) => {
    const candidate = correctionMatchLabel(matchKey, true);
    if (!candidate) return;
    const card = correctionCard(candidate, { selectable: false, selected: true });
    card.classList.add("correction-preview-card");
    const impactBadge = document.createElement("span");
    impactBadge.className = "correction-preview-impact-badge";
    impactBadge.textContent = replayKeys.has(matchKey)
      ? "재입력 대기열로 이동"
      : inPlaceKeys.has(matchKey)
        ? "현재 위치 유지"
        : "서버 계획 확인 필요";
    card.appendChild(impactBadge);
    affectedGrid.appendChild(card);
  });
  affected.appendChild(affectedGrid);
  preview.appendChild(affected);

  const queueGrid = document.createElement("div");
  queueGrid.className = "correction-preview-grid";
  const before = projection.before || {};
  const after = projection.after || {};
  queueGrid.append(
    renderCorrectionQueueCard("변경 전 현재 경기", before.currentMatchKey, "correction-preview-card--before"),
    renderCorrectionQueueCard("변경 전 다음 경기", before.nextMatchKey, "correction-preview-card--before"),
    renderCorrectionQueueCard("변경 후 현재 경기", after.currentMatchKey, "correction-preview-card--after"),
    renderCorrectionQueueCard("변경 후 다음 경기", after.nextMatchKey, "correction-preview-card--after"),
  );
  preview.appendChild(queueGrid);

  const impact = document.createElement("div");
  impact.className = "correction-preview-impact correction-guidance";
  const replayCount = (projection.replayMatchKeys || []).length;
  const inPlaceCount = (projection.inPlaceMatchKeys || []).length;
  impact.textContent = activeLocks.length
    ? "선택한 경기의 입력 잠금이 활성화되어 있어 아직 적용할 수 없습니다."
    : `정정 후 ${replayCount}경기는 재입력 대기열로 이동하고, ${inPlaceCount}경기는 현재 대기열 위치를 유지합니다.`;
  preview.appendChild(impact);
  const panel = document.getElementById("correctionApplyPanel");
  if (panel) panel.hidden = false;
}

function invalidateCorrectionPreview(
  message = "점수를 다시 입력할 경기를 고른 뒤 ‘변경 내용 확인’을 눌러주세요.",
  { clearReason = false, success = false } = {},
) {
  const hadPreview = Boolean(correctionPreview);
  if (success) correctionCompletionMessage = message;
  else if (clearReason || hadPreview) correctionCompletionMessage = "";
  correctionPreview = null;
  correctionPreviewGeneration += 1;
  const reason = document.getElementById("correctionReason");
  const acknowledgement = document.getElementById("correctionAcknowledge");
  if (reason && (clearReason || success)) reason.value = "";
  if (acknowledgement) acknowledgement.checked = false;
  const reasonError = document.getElementById("correctionReasonError");
  if (reasonError) {
    reasonError.hidden = true;
    reasonError.textContent = "";
  }
  renderCorrectionPreviewGuidance(
    hadPreview
      ? message
      : correctionCompletionMessage || "점수를 다시 입력할 경기를 고른 뒤 ‘변경 내용 확인’을 눌러주세요.",
  );
  updateCorrectionControls();
}

function stageSubmittedFinalReview(assignment, workflow) {
  const division = assignment.divisionId || assignment.division;
  if (division !== activeDivision) {
    showToast(`${DIVISION_LABELS[division] || division} 본선으로 전환한 뒤 공개 초안에 반영하세요.`, 4000);
    return;
  }
  if (!finalMutationAllowed()) return;
  const match = finalMatches.find((item) => item.id === assignment.matchId);
  const sets = workflow.submittedSnapshot?.sets || workflow.draft?.sets;
  if (!match || !Array.isArray(sets) || evaluateFinalMatch(sets).status !== "done") {
    showToast("현재 본선 대진과 제출 점수를 확인할 수 없습니다.", 4000);
    return;
  }
  const official = authoritativeFinalMatches.find((item) => item.id === match.id);
  const changed = JSON.stringify(official?.sets || []) !== JSON.stringify(sets);
  const reason = (official?.officialRevision || 0) > 0 && changed
    ? requiredReason("승인된 본선 점수 정정")
    : "";
  if ((official?.officialRevision || 0) > 0 && changed && !reason) {
    showToast("승인된 점수를 바꾸려면 정정 사유가 필요합니다.");
    return;
  }
  stageFinalScoreDraft(match.id, sets, reason);
  showToast("제출 점수를 로컬 본선 초안에 반영했습니다. 관객 화면에 공개해야 확정됩니다.");
}

// ---------------- 대회설정: 대회명 ----------------

async function saveQualificationCount() {
  const input = document.getElementById("qualifyPerGroupInput");
  const rawValue = input.value;
  const qualifyPerGroup = Number(rawValue);
  if (!Number.isInteger(qualifyPerGroup) || qualifyPerGroup < 1 || qualifyPerGroup > 32) {
    return showToast("조별 진출 팀 수는 1~32 사이 정수여야 합니다.", 5000);
  }
  qualificationCountInputOverride = rawValue;
  try {
    await adminWorkflowCallable("setQualificationCount", {
      division: activeDivision,
      count: qualifyPerGroup,
    });
    qualificationCountInputOverride = null;
    tournamentInfo = {
      ...tournamentInfo,
      qualifyPerGroup: {
        ...(tournamentInfo.qualifyPerGroup || {}),
        [activeDivision]: qualifyPerGroup,
      },
    };
    qualificationSourceChanged();
    qualificationStateForCurrentData();
    renderFinalTeamPicker();
    seedAutoMode = true; // 진출 팀 수 설정을 바꿨으니 추천 진출팀을 다시 계산해서 보여준다
    showToast(`${divisionLabel()} 조별 진출 팀 수를 저장했습니다`);
  } catch (err) {
    input.value = rawValue;
    reportError("조별 진출 팀 수 저장", err);
  }
}

function bindStaticHandlers() {
  document.querySelectorAll("[data-division]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextDivision = button.dataset.division;
      if (nextDivision === activeDivision) return;
      if (!finalMutationAllowed()) return;
      if (bracketPublishPending && !confirm(`${divisionLabel()}의 공개하지 않은 본선 대진 변경사항을 버리고 ${DIVISION_LABELS[nextDivision]}로 전환할까요?`)) return;
      activeDivision = nextDivision;
      document.body.dataset.division = activeDivision;
      syncDivisionThemeScopes();
      bracketPublishPending = false;
      seedSelection = [];
      seedAutoMode = true;
      qualificationState = null;
      qualificationServerState = null;
      qualificationServerFingerprint = "";
      qualificationTieSelections = {};
      qualificationProof = null;
      qualificationRevalidatedLocally = false;
      qualificationSourceInitialized = false;
      qualificationSourceKey = "";
      qualificationDraftStale = false;
      qualificationReplacement = null;
      qualificationPreparationError = "";
      qualificationCountInputOverride = null;
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

  document.getElementById("saveQualifyPerGroupBtn").addEventListener("click", saveQualificationCount);

  document.getElementById("addGroupBtn").addEventListener("click", addGroupFromForm);
  document.getElementById("groupNameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addGroupFromForm(); }
  });
  document.getElementById("resetGroupsBtn").addEventListener("click", async () => {
    if (blockQualificationStructureEdit()) return;
    if (blockPrelimMutationUntilReady()) return;
    if (!groups.length) return showToast("이미 등록된 조가 없습니다");
    if (blockPrelimMutationWithHistory("delete_all_groups")) return;
    if (!confirm(`${divisionLabel()}의 모든 조를 삭제할까요? 소속 팀은 모두 미배정 상태가 되고, 공식 이력이 없는 해당 조의 예선 대진도 함께 삭제됩니다.`)) return;
    try {
      await mutatePrelimStructureAndRefresh("delete_all_groups");
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
    if (blockQualificationStructureEdit()) return;
    if (blockPrelimMutationUntilReady()) return;
    if (!teams.length) return showToast("이미 등록된 팀이 없습니다");
    if (blockPrelimMutationWithHistory("delete_all_teams")) return;
    if (!confirm(`${divisionLabel()}의 모든 팀을 삭제할까요? 공식 이력이 없는 예선 경기와 팀 정보도 함께 삭제됩니다.`)) return;
    try {
      await mutatePrelimStructureAndRefresh("delete_all_teams");
      showToast(`${divisionLabel()} 팀을 모두 초기화했습니다`);
    } catch (err) {
      reportError("팀 초기화", err);
    }
  });

  document.getElementById("resetPrelimBtn").addEventListener("click", async () => {
    if (blockQualificationStructureEdit()) return;
    if (blockPrelimMutationUntilReady()) return;
    const hasRingPlacement = groups.some((g) => (g.ringOrder || []).some(Boolean));
    if (!prelimMatches.length && !hasRingPlacement) return showToast("초기화할 예선 경기가 없습니다");
    if (blockPrelimMutationWithHistory("clear_division_prelim")) return;
    if (!confirm(`${divisionLabel()} 공식 이력이 없는 모든 조의 예선 대진과 도형(링크제) 배치를 초기화할까요?`)) return;
    try {
      await mutatePrelimStructureAndRefresh("clear_division_prelim");
      ringSelection = null;
      showToast(`${divisionLabel()} 예선을 초기화했습니다`);
    } catch (err) {
      reportError("예선 초기화", err);
    }
  });

  document.getElementById("generateBracketBtn").addEventListener("click", onGenerateBracket);
  document.getElementById("publishBracketBtn").addEventListener("click", handlePublishBracket);
  document.getElementById("clearBracketBtn").addEventListener("click", async () => {
    if (!finalMutationAllowed()) return;
    if (qualificationHasFinalPlay()) {
      return showToast("실제 진행된 본선은 대진표 초기화로 우회할 수 없습니다.", 6000);
    }
    if (!confirm(`${divisionLabel()}의 아직 시작하지 않은 본선 대진표를 초기화할까요? 기록이 시작된 경기가 있으면 안전을 위해 초기화가 거부됩니다.`)) return;
    try {
      if (authoritativeFinalMatches.length) {
        await adminWorkflowCallable("clearFinalStructure", { division: activeDivision });
      }
      resetFinalDraft([]);
      qualificationProof = null;
      qualificationServerState = null;
      qualificationServerFingerprint = "";
      qualificationTieSelections = {};
      qualificationDraftStale = false;
      qualificationRevalidatedLocally = false;
      qualificationReplacement = null;
      renderFinalBracket();
      renderFinalTeamPicker();
      updateQualificationStructureControls();
      showToast(`${divisionLabel()} 본선 대진표를 초기화했습니다.`);
    } catch (err) {
      reportError("본선 대진표 초기화", err);
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
      await saveTournamentInfo({ venueDisplay: { mode, intervalSeconds } });
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
      if (resetState?.token && !resetState.backupCompleted) {
        await adminWorkflowCallable("cancelTournamentReset", { token: resetState.token });
        saveTournamentResetState(null);
        resetState = null;
      }
      if (!resetState?.token) {
        // 백업 export는 일관된 snapshot을 위해 maintenance 중에는 거부된다.
        // 따라서 reset maintenance를 시작하기 전에 먼저 안전 백업을 내려받는다.
        await handleBackup();
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
        resetState = { token, backupCompleted: true };
        saveTournamentResetState(resetState);
      }
      return adminWorkflowCallable("resetTournament", { token: resetState.token });
    });
    tournamentResetInProgress = false;
    if (!result) return;
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
    correctionSelection = new Set();
    correctionCompletionMessage = "";
    showToast("대회 전체 초기화가 완료되었습니다. 최신 상태를 불러옵니다.", 3000);
    window.setTimeout(() => window.location.reload(), 300);
  });
  document.getElementById("restoreBtn").addEventListener("click", () => {
    document.getElementById("restoreFileInput").click();
  });
  document.getElementById("restoreFileInput").addEventListener("change", handleRestoreFile);

  document.getElementById("createRecorderCodeBtn").addEventListener("click", async (e) => {
    if (!confirmGlobalRecorderCodeAction("접근 코드를 재발급")) return;
    const result = await runWorkflowButton(e.currentTarget, "접근 코드 생성/재발급", () => adminWorkflowCallable("createRecorderAccessCode"));
    if (result?.code) {
      const output = document.getElementById("recorderCodeOutput");
      output.textContent = `새 접근 코드: ${result.code}`;
      output.style.display = "";
      refreshRecorderGrants();
    }
  });
  document.getElementById("revokeRecorderCodeBtn").addEventListener("click", async (e) => {
    if (!confirmGlobalRecorderCodeAction("접근 코드를 전체 폐기")) return;
    const result = await runWorkflowButton(e.currentTarget, "접근 코드 폐기", () => adminWorkflowCallable("revokeRecorderAccessCode"));
    if (result?.revoked) {
      const output = document.getElementById("recorderCodeOutput");
      output.textContent = "";
      output.style.display = "none";
      showToast("기록관 접근 코드를 폐기했습니다.");
      refreshRecorderGrants();
    }
  });
  document.getElementById("refreshRecorderGrantsBtn").addEventListener("click", refreshRecorderGrants);
  document.querySelectorAll("[data-workflow-phase]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!["all", "prelim", "final"].includes(button.dataset.workflowPhase)) return;
      workflowPhaseFilter = button.dataset.workflowPhase;
      syncWorkflowPhaseFilter();
      renderCourtBoard();
    });
  });
  document.getElementById("addCourtBtn").addEventListener("click", createWorkflowCourt);
  ["setupCourtsBtn", "setupWorkflowBtn"].forEach((id) => {
    document.getElementById(id).addEventListener("click", (e) => saveCourtWorkflow(e.currentTarget));
  });
  document.getElementById("correctionReason").addEventListener("input", () => {
    const error = document.getElementById("correctionReasonError");
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
    updateCorrectionControls();
  });
  document.getElementById("correctionAcknowledge").addEventListener("change", () => updateCorrectionControls());
  document.getElementById("previewCorrectionBtn").addEventListener("click", async (e) => {
    if (correctionPreviewInFlight || correctionApplyInFlight) return;
    const candidates = correctionCandidates();
    correctionSelection = correctionSelectionKeys(correctionSelection, candidates);
    const selectedInfo = correctionSelectionInfo(correctionSelection, candidates);
    if (!correctionSelection.size) return showToast("정정할 경기를 선택하세요.");
    if (!selectedInfo.sameCourt) return showToast("한 코트의 경기만 선택해 미리보기를 확인하세요.");
    if (selectedInfo.selectedCandidates.some((candidate) => candidate.workflow?.lock)) {
      return showToast("기록 입력 잠금이 활성화된 경기는 잠금이 해제된 뒤 정정할 수 있습니다.");
    }
    const matchKeys = [...correctionSelection].sort();
    const previewGeneration = correctionPreviewGeneration;
    correctionPreviewInFlight = true;
    document.getElementById("correctionAcknowledge").checked = false;
    updateCorrectionControls(candidates);
    let result;
    try {
      result = await runWorkflowButton(e.currentTarget, "정정 미리보기", () => adminWorkflowCallable("previewApprovedCorrection", { matchKeys }));
    } finally {
      correctionPreviewInFlight = false;
    }
    if (!result) {
      invalidateCorrectionPreview("정정 미리보기를 불러오지 못했습니다. 최신 상태를 확인한 뒤 다시 미리보기를 실행하세요.");
      return;
    }
    const currentMatchKeys = [...correctionSelection].sort();
    if (previewGeneration !== correctionPreviewGeneration
      || !correctionSelectionMatches(currentMatchKeys, matchKeys)) {
      invalidateCorrectionPreview("미리보기 중 선택 또는 서버 상태가 변경되었습니다. 다시 미리보기를 실행하세요.");
      return;
    }
    if (!result.planToken) {
      invalidateCorrectionPreview("서버 계획 토큰을 받지 못해 정정 미리보기를 적용할 수 없습니다.");
      return;
    }
    const active = matchKeys.filter((key) => reviewWorkflows.get(key)?.lock);
    correctionPreview = {
      planToken: result.planToken,
      matchKeys,
      generation: correctionPreviewGeneration,
      projection: result.projection || {},
      result,
    };
    renderCorrectionPreview(result, matchKeys, active);
    updateCorrectionControls();
  });
  document.getElementById("applyCorrectionBtn").addEventListener("click", async (e) => {
    if (correctionApplyInFlight || correctionPreviewInFlight) return;
    const candidates = correctionCandidates();
    correctionSelection = correctionSelectionKeys(correctionSelection, candidates);
    const selectedInfo = correctionSelectionInfo(correctionSelection, candidates);
    const reasonInput = document.getElementById("correctionReason");
    const acknowledgement = document.getElementById("correctionAcknowledge");
    const reason = reasonInput?.value?.trim() || "";
    const state = correctionConfirmationState({
      selectedKeys: correctionSelection,
      preview: correctionPreview,
      generation: correctionPreviewGeneration,
      reason,
      acknowledged: acknowledgement?.checked,
      activeLocks: selectedInfo.selectedCandidates
        .filter((candidate) => candidate.workflow?.lock)
        .map((candidate) => candidate.id),
    });
    if (!state.canApply) {
      const error = document.getElementById("correctionReasonError");
      if (error && !state.hasReason) {
        error.hidden = false;
        error.textContent = "정정 사유를 입력하세요.";
      }
      updateCorrectionControls(candidates);
      return showToast(
        state.hasConflictingLock
          ? "활성 입력 잠금이 있는 경기의 정정은 적용할 수 없습니다."
          : "미리보기, 정정 사유, 확인 체크를 모두 완료하세요.",
      );
    }
    const planToken = correctionPreview.planToken;
    correctionApplyInFlight = true;
    updateCorrectionControls(candidates);
    let result;
    try {
      result = await runWorkflowButton(e.currentTarget, "승인 결과 정정", () => adminWorkflowCallable("applyApprovedCorrection", {
        planToken,
        reason,
      }));
    } finally {
      correctionApplyInFlight = false;
    }
    if (!result) {
      invalidateCorrectionPreview("정정 적용에 실패했습니다. 최신 상태를 확인한 뒤 다시 미리보기를 실행하세요.");
      return;
    }
    if (result) {
      correctionSelection = new Set();
      invalidateCorrectionPreview(
        "정정을 적용했습니다. 공식 점수가 취소되고 재입력 대기열이 서버 계획에 따라 갱신되었습니다.",
        { clearReason: true, success: true },
      );
      renderCorrectionMatchCards();
      showToast("승인 취소 및 재입력 요청을 적용했습니다.");
    }
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
  e.target.value = ""; // 같은 파일 다시 선택해도 change 이벤트이 또 뜨도록 비워둔다
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    let data = raw;
    let legacyDivision = "";
    if (raw?.version === 1) {
      const explicitDivision = document.getElementById("legacyRestoreDivision")?.value || "";
      const legacyHint = `${file.name} ${raw.info?.name || ""}`;
      const inferredDivision = /(?:girl|여자|여성|여초|소녀)/i.test(legacyHint)
        ? "women"
        : /(?:boy|남자|남성|남초)/i.test(legacyHint)
          ? "men"
          : "";
      legacyDivision = explicitDivision || inferredDivision;
      if (!legacyDivision) {
        throw new Error("초기 버전 백업의 경기 부문을 남자부 또는 여자부로 먼저 선택하세요.");
      }
      data = upgradeLegacyBackup(raw, legacyDivision);
    }
    const legacyNotice = legacyDivision
      ? `\n\n초기 버전 데이터를 ${legacyDivision === "women" ? "여자부" : "남자부"}로 변환해 복원합니다.`
      : "";
    if (!confirm(`백업 파일로 복원하면 현재 입력된 모든 데이터(팀·조·예선·본선)가 백업 내용으로 전부 대체됩니다.${legacyNotice}\n계속할까요?`)) return;
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
  if (blockQualificationStructureEdit()) return;
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
  if (blockQualificationStructureEdit()) return;
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
  const locked = qualificationStructureLocked();
  nameInput.disabled = locked || !sel.value;
  if (addBtn) {
    addBtn.disabled = locked || !sel.value;
    if (locked) addBtn.title = "본선 공개 후 팀 추가는 Rules로 차단됩니다.";
  }
}

function updateQualificationStructureControls() {
  const locked = qualificationStructureLocked();
  const addGroup = document.getElementById("addGroupBtn");
  const groupInput = document.getElementById("groupNameInput");
  if (addGroup) {
    addGroup.disabled = locked || isAddingGroup;
    if (locked) addGroup.title = "본선 공개 후 조 추가는 Rules로 차단됩니다.";
  }
  if (groupInput) groupInput.disabled = locked;
  updateTeamNameInputContext();
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
    const label = document.createElement("span");
    label.className = "group-pill-name";
    label.textContent = g.name;
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "group-pill-action";
    renameButton.title = "조 이름 변경";
    renameButton.setAttribute("aria-label", `${g.name} 조 이름 변경`);
    renameButton.textContent = "수정";
    renameButton.addEventListener("click", async () => {
      const entered = prompt(`'${g.name}'의 새 조 이름을 입력하세요.`, g.name);
      if (entered == null) return;
      const nextName = entered.trim().replace(/\s+/g, " ");
      if (!nextName) return showToast("조 이름을 입력하세요.");
      if (nextName.length > 40) return showToast("조 이름은 40자 이내로 입력하세요.");
      if (normalizeEntryName(nextName) === normalizeEntryName(g.name)) return;
      if (groups.some((group) => group.id !== g.id
        && normalizeEntryName(group.name) === normalizeEntryName(nextName))) {
        return showToast("이미 등록된 조 이름입니다.");
      }
      renameButton.disabled = true;
      try {
        await renameGroup(g.id, nextName);
        showToast(`'${g.name}'을(를) '${nextName}'으로 변경했습니다.`);
      } catch (err) {
        reportError("조 이름 변경", err);
      } finally {
        renameButton.disabled = false;
      }
    });
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "group-pill-action delete";
    deleteButton.title = "삭제";
    deleteButton.setAttribute("aria-label", `${g.name} 조 삭제`);
    deleteButton.textContent = "✕";
    const ready = prelimHistoryIsReady();
    const groupHistory = ready ? officialPrelimHistoryForMutation("delete_group", g.id) : [];
    const groupBlocked = qualificationStructureLocked() || !ready || groupHistory.length > 0;
    deleteButton.disabled = groupBlocked;
    deleteButton.setAttribute("aria-disabled", String(groupBlocked));
    deleteButton.title = !ready
      ? prelimHistoryReadinessGuidance()
      : qualificationStructureLocked()
      ? "본선 공개 후 조 삭제는 Rules로 차단됩니다. 표시 이름·순서만 조정하세요."
      : groupHistory.length ? PRELIM_HISTORY_DISABLED_TITLE : "삭제";
    deleteButton.addEventListener("click", async () => {
      if (blockQualificationStructureEdit()) return;
      if (blockPrelimMutationWithHistory("delete_group", g.id)) return;
      if (!confirm(`${divisionLabel()} '${g.name}' 조를 삭제할까요? (공식 이력이 없는 예선 대진만 함께 삭제되고 소속 팀은 무소속이 됩니다)`)) return;
      try {
        await mutatePrelimStructureAndRefresh("delete_group", { groupId: g.id });
      } catch (err) {
        reportError("조 삭제", err);
      }
    });
    pill.append(label, renameButton, deleteButton);
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
  const deleteButton = pill.querySelector("button");
  const ready = prelimHistoryIsReady();
  const structureLocked = qualificationStructureLocked();
  deleteButton.disabled = structureLocked || !ready;
  deleteButton.setAttribute("aria-disabled", String(structureLocked || !ready));
  if (structureLocked) deleteButton.title = "본선 공개 후 팀 삭제는 Rules로 차단됩니다. 표시 이름·순서만 조정하세요.";
  else if (!ready) deleteButton.title = prelimHistoryReadinessGuidance();
  deleteButton.addEventListener("click", async () => {
    if (blockQualificationStructureEdit()) return;
    if (blockPrelimMutationUntilReady()) return;
    if (!confirm(`${divisionLabel()} '${t.name}' 팀을 삭제할까요?`)) return;
    try {
      await mutatePrelimStructureAndRefresh("delete_team", { teamId: t.id });
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
  if (qualificationStructureLocked() && !sameGroup) {
    blockQualificationStructureEdit();
    return;
  }
  if (!sameGroup && prelimMatches.some((match) => (
    match.groupId === draggedTeam.groupId || match.groupId === targetGroupId
  ))) {
    showToast("예선 대진이 생성된 조 사이에서는 팀을 옮길 수 없습니다. 해당 조의 예선을 먼저 초기화하세요.", 5000);
    return;
  }
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
  showToast("참가팀 순서에 맞춰 예선 대진 순서를 반영했습니다. 코트 실행 순서는 변경되지 않습니다.", 5000);
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

/** 방식 전환/재배치로 기존 대진이 대체될 때 확인을 구한다. 공식 이력은 별도 사전 차단한다. */
function confirmIfResultsWillReset(groupId, groupName, message) {
  if (!groupHasScoredMatches(groupId)) return true;
  return confirm(`${divisionLabel()} ${message || `'${groupName}'의 기존 대진이 대체됩니다. 계속할까요?`}`);
}

/** 한 조의 예선 대진/결과와 링크제 도형 배치를 모두 초기화한다 (조별 '초기화' 버튼용) */
async function handleResetGroupPrelim(group) {
  if (blockQualificationStructureEdit()) return;
  const hasMatches = groupHasPrelimMatches(group.id);
  const hasRingPlacement = (group.ringOrder || []).some(Boolean);
  if (!hasMatches && !hasRingPlacement) return showToast(`${group.name}에 초기화할 내용이 없습니다`);
  if (blockPrelimMutationWithHistory("clear_group_prelim", group.id)) return;
  if (!confirm(`${divisionLabel()} '${group.name}'의 공식 이력이 없는 예선 대진과 도형(링크제) 배치를 초기화할까요?`)) return;
  try {
    await mutatePrelimStructureAndRefresh("clear_group_prelim", { groupId: group.id, ringOrder: [] });
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
  if (blockQualificationStructureEdit()) return;
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
  if (blockQualificationStructureEdit()) return;
  if (blockPrelimMutationUntilReady()) {
    renderPrelimSetupGroups();
    return;
  }
  const operation = nextRingOrder.length >= 2 && nextRingOrder.every(Boolean)
    ? "generate_group_ring"
    : groupHasPrelimMatches(group.id) ? "clear_group_prelim" : null;
  if (operation && blockPrelimMutationWithHistory(operation, group.id)) {
    renderPrelimSetupGroups();
    return;
  }
  if (!confirmIfResultsWillReset(group.id, group.name)) {
    renderPrelimSetupGroups(); // 취소 시에도 선택 상태가 이미 풀렸으므로 화면을 다시 그려 정리한다
    return;
  }
  try {
    if (nextRingOrder.length >= 2 && nextRingOrder.every(Boolean)) {
      await mutatePrelimStructureAndRefresh("generate_group_ring", {
        groupId: group.id,
        ringOrder: nextRingOrder,
      });
      showToast(`${group.name} 대진이 확정되었습니다`);
    } else if (groupHasPrelimMatches(group.id)) {
      await mutatePrelimStructureAndRefresh("clear_group_prelim", {
        groupId: group.id,
        ringOrder: nextRingOrder,
      });
    } else {
      await setGroupRingOrder(group.id, nextRingOrder);
    }
  } catch (err) {
    reportError("링크제 배치", err);
  }
}

async function handleRingShuffle(group, groupTeams) {
  if (blockQualificationStructureEdit()) return;
  if (blockPrelimMutationWithHistory("generate_group_ring", group.id)) return;
  if (!confirmIfResultsWillReset(group.id, group.name, `'${group.name}'을 무작위로 다시 배치하면 공식 이력이 없는 기존 대진만 대체됩니다. 계속할까요?`)) return;
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
  const ready = prelimHistoryIsReady();
  const groupHistory = ready ? officialPrelimHistoryForMutation("generate_group_round_robin", g.id) : [];
  const blocked = qualificationStructureLocked() || !ready || groupHistory.length > 0;
  btn.disabled = blocked;
  btn.setAttribute("aria-disabled", String(blocked));
  btn.title = !ready
    ? prelimHistoryReadinessGuidance()
    : qualificationStructureLocked()
    ? "본선 공개 후 예선 대진 재생성은 Rules로 차단됩니다."
    : groupHistory.length ? PRELIM_HISTORY_DISABLED_TITLE : "공식 이력이 없는 경우 라운드로빈 대진을 생성합니다.";
  btn.addEventListener("click", async () => {
    if (blockQualificationStructureEdit()) return;
    if (blockPrelimMutationWithHistory("generate_group_round_robin", g.id)) return;
    if (!confirmIfResultsWillReset(g.id, g.name, `'${g.name}' 예선 대진을 (재)생성할까요? 공식 이력이 없는 기존 대진만 대체됩니다.`)) return;
    try {
      await mutatePrelimStructureAndRefresh("generate_group_round_robin", {
        groupId: g.id,
        teamIds: groupTeams.map((team) => team.id),
      });
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
  const poolTeams = groupTeams.filter((t) => !ringOrder.includes(t.id));
  const filled = ringOrder.length > 0 && ringOrder.every((id) => id);
  const placedCount = ringOrder.filter(Boolean).length;
  const ready = prelimHistoryIsReady();
  const groupHistory = ready ? officialPrelimHistoryForMutation("generate_group_ring", g.id) : [];
  const blocked = qualificationStructureLocked() || !ready || groupHistory.length > 0;

  // 안내 + 무작위 배치
  const toolbar = document.createElement("div");
  toolbar.className = "row";
  toolbar.style.marginBottom = "10px";
  toolbar.style.justifyContent = "space-between";
  const hint = document.createElement("span");
  hint.className = "empty-hint";
  hint.style.padding = "0";
  hint.textContent = blocked
    ? qualificationStructureLocked()
      ? "본선 공개 후 링크제 배치 변경은 Rules로 차단됩니다."
      : !ready ? prelimHistoryReadinessGuidance() : prelimMutationGuidance(groupHistory)
    : filled
    ? "대진이 확정되었습니다. 공식 이력이 없는 경우 다시 배치하면 기존 대진이 초기화됩니다."
    : `팀을 도형의 꼭짓점으로 드래그하거나, 팀을 클릭한 뒤 꼭짓점을 클릭하세요 (${placedCount}/${ringOrder.length} 배치됨)`;
  const shuffleBtn = document.createElement("button");
  shuffleBtn.className = "btn small ghost";
  shuffleBtn.textContent = "무작위 배치";
  shuffleBtn.disabled = blocked;
  shuffleBtn.setAttribute("aria-disabled", String(blocked));
  if (blocked) {
    shuffleBtn.title = qualificationStructureLocked()
      ? "본선 공개 후 링크제 배치 변경은 Rules로 차단됩니다."
      : PRELIM_HISTORY_DISABLED_TITLE;
  }
  shuffleBtn.addEventListener("click", () => {
    if (blockQualificationStructureEdit()) return;
    handleRingShuffle(g, groupTeams);
  });
  toolbar.appendChild(hint);
  toolbar.appendChild(shuffleBtn);
  wrap.appendChild(toolbar);

  // 배치 대기 팀(풀)
  const pool = document.createElement("div");
  pool.className = "row team-pool";
  if (!blocked) {
    pool.addEventListener("dragover", (e) => e.preventDefault());
    pool.addEventListener("drop", (e) => {
      e.preventDefault();
      const data = safeParseJson(e.dataTransfer.getData("text/plain"));
      if (data) handleRingPoolDrop(g, ringOrder, data);
    });
  }
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
      chip.draggable = !blocked;
      if (!blocked) {
        chip.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", JSON.stringify({ type: "pool", teamId: t.id }));
        });
        chip.addEventListener("click", () => handlePoolChipClick(g, ringOrder, t.id));
      }
      pool.appendChild(chip);
    });
  }
  wrap.appendChild(pool);

  // 도형
  const diagramHost = document.createElement("div");
  diagramHost.style.margin = "14px auto 4px";
  wrap.appendChild(diagramHost);
  const selectedVertexIndex = (ringSelection && ringSelection.type === "vertex" && ringSelection.groupId === g.id) ? ringSelection.index : null;
  const edgeLabels = getPrelimRingEdgeLabels(ringOrder, prelimCourtSchedule());
  renderRingDiagram(diagramHost, {
    ringOrder,
    teamNameById: (id) => teamName(id),
    edgeLabels,
    editable: !blocked,
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

/** 예선 관련 화면(대회설정 탭의 생성 컨트롤 + 예선 탭의 대진표)을 함께 다시 그린다 */
function renderPrelimViews() {
  renderPrelimSetupGroups();
  renderPrelimGroups();
  syncPrelimExecutionProjection();
  syncPrelimWorkflowHints();
}

function createPrelimMatchup(match, scheduleRow) {
  const matchup = document.createElement("span");
  matchup.className = "prelim-matchup";
  const line = document.createElement("span");
  line.className = "prelim-matchup-line";
  const teamA = document.createElement("strong");
  teamA.textContent = teamName(match.teamA);
  const versus = document.createElement("b");
  versus.textContent = "VS";
  const teamB = document.createElement("strong");
  teamB.textContent = teamName(match.teamB);
  line.append(teamA, versus, teamB);
  const execution = document.createElement("span");
  execution.className = "prelim-execution-label";
  execution.dataset.prelimExecutionLabel = match.id;
  execution.textContent = scheduleRow?.label || "미배정";
  matchup.append(line, execution);
  return matchup;
}

function createPrelimResultBadge(match, evaluated) {
  const badge = document.createElement("span");
  badge.className = "badge";
  if (evaluated.result === "A") {
    badge.classList.add("win");
    badge.textContent = `${teamName(match.teamA)} 승`;
  } else if (evaluated.result === "B") {
    badge.classList.add("win");
    badge.textContent = `${teamName(match.teamB)} 승`;
  } else if (evaluated.result === "draw") {
    badge.classList.add("draw");
    badge.textContent = "무승부";
  } else if (evaluated.status === "in_progress") {
    badge.textContent = "경기중";
  } else {
    badge.textContent = "경기전";
  }
  return badge;
}

function appendPrelimScheduleLanes(parent, groupId, groupMatches, rowFactory) {
  const schedule = prelimCourtSchedule();
  const scheduleById = new Map(schedule.map((row) => [row.match.id, row]));
  const scheduleIndex = new Map(schedule.map((row, index) => [row.match.id, index]));
  const knownCourtIds = new Set(workflowDraftCourts.map((court) => court.id));
  const lanes = createPrelimCourtLanes(groupId);
  const rowsByLane = new Map();
  groupMatches.forEach((match) => {
    const scheduleRow = scheduleById.get(match.id) || {
      match,
      courtId: null,
      label: "미배정",
      shortLabel: "—",
    };
    const laneKey = scheduleRow.courtId && knownCourtIds.has(scheduleRow.courtId)
      ? scheduleRow.courtId
      : "";
    if (!rowsByLane.has(laneKey)) rowsByLane.set(laneKey, []);
    rowsByLane.get(laneKey).push({ match, scheduleRow });
  });
  rowsByLane.forEach((items, laneKey) => {
    const laneList = [...lanes.querySelectorAll("[data-prelim-court-lane-list]")]
      .find((list) => (list.dataset.prelimCourtLaneList || "") === laneKey);
    if (!laneList) return;
    items
      .sort((left, right) => (
        (scheduleIndex.get(left.match.id) ?? Number.POSITIVE_INFINITY)
          - (scheduleIndex.get(right.match.id) ?? Number.POSITIVE_INFINITY)
      ))
      .forEach(({ match, scheduleRow }) => {
        laneList.appendChild(rowFactory(match, scheduleRow));
      });
  });
  lanes.querySelectorAll("[data-prelim-court-lane]").forEach((lane) => {
    lane.hidden = !lane.querySelector("[data-prelim-match-row]");
  });
  parent.appendChild(lanes);
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
    const ready = prelimHistoryIsReady();
    const groupHistory = ready ? officialPrelimHistoryForMutation("clear_group_prelim", g.id) : [];
    const groupBlocked = qualificationStructureLocked() || !ready || groupHistory.length > 0;

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
      btn.disabled = qualificationStructureLocked();
      if (qualificationStructureLocked()) {
        btn.title = "본선 공개 후 예선 방식 변경은 Rules로 차단됩니다.";
      }
      btn.addEventListener("click", () => handleSetMatchMode(g, btn.dataset.mode));
    });
    headRight.appendChild(modeToggle);

    const resetGroupBtn = document.createElement("button");
    resetGroupBtn.type = "button";
    resetGroupBtn.className = "btn danger small";
    resetGroupBtn.title = !ready
      ? prelimHistoryReadinessGuidance()
      : qualificationStructureLocked()
        ? "본선 공개 후 예선 초기화는 Rules로 차단됩니다."
      : groupHistory.length
        ? PRELIM_HISTORY_DISABLED_TITLE
        : `${g.name}의 공식 이력이 없는 예선 대진과 도형(링크제) 배치를 삭제합니다`;
    resetGroupBtn.textContent = "초기화";
    resetGroupBtn.disabled = groupBlocked;
    resetGroupBtn.setAttribute("aria-disabled", String(groupBlocked));
    resetGroupBtn.addEventListener("click", () => handleResetGroupPrelim(g));
    headRight.appendChild(resetGroupBtn);
    head.appendChild(headRight);
    box.appendChild(head);

    if (groupBlocked) {
      const guardHint = document.createElement("div");
      guardHint.className = "empty-hint";
      guardHint.style.padding = "0 0 10px";
      guardHint.textContent = !ready
        ? prelimHistoryReadinessGuidance()
        : qualificationStructureLocked()
        ? "본선 공개 후 조·팀·예선 구조 변경은 Rules로 차단됩니다. 표시 이름과 순서만 조정하세요."
        : prelimMutationGuidance(groupHistory);
      box.appendChild(guardHint);
    }

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

    const groupMatches = structuralPrelimMatches(prelimMatches.filter((m) => m.groupId === g.id));
    const madeHint = document.createElement("div");
    madeHint.className = "prelim-match-status";
    if (!groupMatches.length) {
      madeHint.textContent = "경기 없음";
    } else {
      madeHint.textContent = `${groupMatches.length}경기 생성됨`;
    }
    box.appendChild(madeHint);

    const guidance = document.createElement("p");
    guidance.className = "empty-hint prelim-order-guidance";
    guidance.textContent = PRELIM_ORDER_GUIDANCE;
    box.appendChild(guidance);
    if (groupMatches.length) {
      appendPrelimScheduleLanes(box, g.id, groupMatches, (m, scheduleRow) => {
        const row = document.createElement("div");
        row.className = "prelim-match-row";
        row.dataset.prelimMatchRow = m.id;
        row.dataset.prelimMatchId = m.id;
        const matchup = createPrelimMatchup(m, scheduleRow);
        row.append(matchup);
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
        courtSelect.addEventListener("change", () => setMatchCourt(m.id, courtSelect.value));
        courtControl.append(courtLabel, courtSelect);
        row.appendChild(courtControl);
        return row;
      });
    }

    box.dataset.prelimGroupId = g.id;
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
    const groupMatches = structuralPrelimMatches(prelimMatches.filter((m) => m.groupId === g.id));
    const schedule = prelimCourtSchedule();
    const standings = computeGroupStandings(groupTeams, groupMatches);
    const mode = g.matchMode || "ring";

    const card = document.createElement("div");
    card.className = "card";
    card.dataset.prelimGroupId = g.id;
    const heading = document.createElement("h2");
    heading.innerHTML = `${escapeHtml(g.name)} 예선 <span style="margin-left:auto; font-weight:400; color:var(--muted); font-size:13px;">${mode === "ring" ? "링크제" : "라운드로빈"}</span>`;
    card.appendChild(heading);

    // 링크제는 배치된 도형 자체가 대진표이므로 읽기 전용으로 함께 보여준다
    if (mode === "ring" && (g.ringOrder || []).some(Boolean)) {
      const diagramHost = document.createElement("div");
      diagramHost.style.margin = "4px auto 10px";
      const ringOrder = normalizeRingOrder(g.ringOrder, groupTeams.map((t) => t.id));
      renderRingDiagram(diagramHost, {
        ringOrder,
        teamNameById: (id) => teamName(id),
        edgeLabels: getPrelimRingEdgeLabels(ringOrder, schedule),
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

    const guidance = document.createElement("p");
    guidance.className = "empty-hint prelim-order-guidance";
    guidance.textContent = PRELIM_ORDER_GUIDANCE;
    card.appendChild(guidance);
    if (!groupMatches.length) {
      const empty = document.createElement("div");
      empty.className = "empty-hint";
      empty.textContent = "생성된 경기가 없습니다. 대회설정 탭의 '예선 대진 방식·생성'에서 대진을 생성하세요.";
      card.appendChild(empty);
    } else {
      appendPrelimScheduleLanes(card, g.id, groupMatches, (m, scheduleRow) => {
        const row = document.createElement("div");
        row.className = "prelim-score-row";
        row.dataset.prelimMatchRow = m.id;
        row.dataset.prelimMatchId = m.id;
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
        const left = createPrelimMatchup(m, scheduleRow);
        if (scoreText) {
          const score = document.createElement("span");
          score.className = "prelim-score-text";
          score.textContent = scoreText;
          left.appendChild(score);
        }
        if (pendingScoreText) {
          const pending = document.createElement("span");
          pending.className = "prelim-pending-score";
          pending.textContent = `검수 대기 점수: ${pendingScoreText}`;
          left.appendChild(pending);
        }
        row.appendChild(left);
        const right = document.createElement("span");
        right.className = "row";
        right.appendChild(createPrelimResultBadge(m, evald));
        if (pendingScoreText) {
          const pendingBadge = document.createElement("span");
          pendingBadge.className = "badge";
          pendingBadge.textContent = "검수 대기";
          right.appendChild(pendingBadge);
        }
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
        return row;
      });
    }
    el.appendChild(card);
  });
}

function teamName(id) {
  const t = teams.find((x) => x.id === id);
  return t ? t.name : "?";
}

function canonicalOfficialRevision(value) {
  if (value == null) return 0;
  return Number.isInteger(value) ? value : null;
}

function prelimDirectScoreContext(matchId) {
  const match = allPrelimMatches.find((item) => item.id === matchId);
  const assignment = reviewAssignments.find((item) => (
    (item.matchKey || item.id) === matchId && (item.matchType || "prelim") === "prelim"
  ));
  const workflow = reviewWorkflows.get(matchId);
  if (!match || !assignment || !workflow) {
    return { error: "코트 배정과 기록 워크플로가 준비된 예선 경기만 관리자 점수 입력을 할 수 있습니다." };
  }

  const states = [assignment.publicStatus, workflow.draftState, workflow.status]
    .filter(Boolean)
    .map((state) => String(state).toLowerCase());
  if (workflow.lock || states.some((state) => state === "editing" || state === "locked")) {
    return { error: "기록관이 점수를 입력 중이거나 잠금 상태입니다. 기록관 작업이 끝난 뒤 진행하세요." };
  }
  if (states.some((state) => state === "submitted" || state === "under_review")) {
    return { error: "기록관 점수가 제출되어 검수 중입니다. 점수를 바꾸지 말고 승인하거나 반려하여 정정을 요청하세요." };
  }
  if (states.some((state) => [
    "rejected", "replay", "replay_required", "rework", "rework_required",
  ].includes(state))) {
    return { error: "반려 또는 재입력 절차가 진행 중인 경기입니다. 기록관의 재입력·재제출을 기다리세요." };
  }

  const officialRevision = canonicalOfficialRevision(match.officialRevision);
  const assignmentRevision = canonicalOfficialRevision(assignment.officialRevision);
  const workflowRevision = canonicalOfficialRevision(workflow.officialRevision);
  if (officialRevision == null || officialRevision !== assignmentRevision || officialRevision !== workflowRevision) {
    return { error: "공식 점수 버전이 변경되었거나 동기화되지 않았습니다. 최신 상태를 확인한 뒤 다시 여세요." };
  }

  const pristine = assignment.publicStatus === "scheduled"
    && workflow.draftState === "idle"
    && !(workflow.draft?.sets?.length)
    && !workflow.submittedSnapshot
    && (workflow.draftRevision ?? 0) === 0
    && (workflow.submissionVersion ?? 0) === 0
    && (assignment.attemptCount ?? 0) === 0;
  const approved = assignment.publicStatus === "completed" && workflow.draftState === "approved";
  if (!pristine && !approved) {
    return { error: "관리자 직접 입력은 아직 기록되지 않은 배정 경기 또는 승인된 공식 점수의 정정에만 사용할 수 있습니다." };
  }

  const courtId = assignment.courtId || null;
  let queueRevision = null;
  if (pristine && courtId) {
    const queue = reviewQueues.get(courtId);
    if (!Number.isInteger(queue?.queueRevision)) {
      return { error: "배정 코트의 대기열 정보를 확인할 수 없습니다. 코트 대기열이 동기화된 뒤 다시 시도하세요." };
    }
    queueRevision = queue.queueRevision;
  }
  return {
    matchId,
    officialRevision,
    queueRevision,
    courtId,
    teamAId: match.teamA || null,
    teamBId: match.teamB || null,
    requiresQueueCas: pristine && Boolean(courtId),
  };
}

function prelimDirectScoreContextIsCurrent(snapshot) {
  const current = prelimDirectScoreContext(snapshot.matchId);
  return !current.error
    && current.matchId === snapshot.matchId
    && current.officialRevision === snapshot.officialRevision
    && current.queueRevision === snapshot.queueRevision
    && current.courtId === snapshot.courtId
    && current.teamAId === snapshot.teamAId
    && current.teamBId === snapshot.teamBId
    && current.requiresQueueCas === snapshot.requiresQueueCas;
}

function openPrelimScoreModal(match) {
  const snapshot = prelimDirectScoreContext(match.id);
  if (snapshot.error) {
    showToast(snapshot.error, 5000);
    return;
  }
  openScoreModal({
    teamAName: teamName(match.teamA),
    teamBName: teamName(match.teamB),
    setLabels: ["1세트 (10점)", "2세트 (10점)"],
    targets: [10, 10],
    existingSets: match.sets || [],
    onSave: async (sets) => {
      if (!prelimDirectScoreContextIsCurrent(snapshot)) {
        throw new Error("경기·팀·코트·대기열 또는 공식 점수 버전이 변경되었습니다. 최신 상태에서 점수 입력을 다시 여세요.");
      }
      const reason = requiredReason("관리자 직접 수정");
      if (!reason) throw new Error("정정 사유는 필수입니다.");
      const request = {
        matchKey: snapshot.matchId,
        score: { sets },
        reason,
        expectedOfficialRevision: snapshot.officialRevision,
      };
      if (snapshot.requiresQueueCas) request.expectedQueueRevision = snapshot.queueRevision;
      await adminWorkflowCallable("directEditOfficialScore", request);
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
      const standings = computeGroupStandings(groupTeams, groupMatches);
      return {
        groupId: g.id,
        groupSize: groupTeams.length,
        standings,
        qualifiers: computeAutomaticQualifiers(standings, n),
      };
    })
    .filter(Boolean);

  const tiers = [];
  for (let rank = 1; rank <= n; rank++) {
    const tier = [];
    standingsByGroup.forEach(({ groupId, groupSize, qualifiers }) => {
      qualifiers
        .filter((s) => s.rank === rank)
        .forEach((s) => tier.push({ teamId: s.teamId, groupId, groupSize }));
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
    const lotteryPeers = standings
      .filter((o) => o.teamId !== s.teamId && o.rank === s.rank)
      .map((o) => o.name)
      .join(", ");
    return `${base} → ${lotteryPeers}와 동률, 상대전적도 같아 추첨으로 결정 필요`;
  }
  return `${base} → ${tiedNames}와 동률, 상대전적(승자승)으로 ${s.rank}위 결정`;
}

function qualificationSelectionValidation(state, participantIds = seedSelection, tieSelections = qualificationTieSelections) {
  try {
    return validateQualificationSelection(
      state,
      participantIds,
      canonicalQualificationTieSelections(state, tieSelections),
    );
  } catch (error) {
    return {
      ok: false,
      errors: [{ code: "qualification_validation_failed", message: error?.message || String(error) }],
    };
  }
}

function qualificationValidationMessages(result) {
  return (result?.errors || []).map(qualificationBlockerMessage);
}

function qualificationPublishContext(state, participantIds = finalEntrantIds(finalMatches)) {
  const context = {
    expectedPrelimFingerprint: qualificationServerFingerprint,
    tieSelections: canonicalQualificationTieSelections(state, qualificationTieSelections),
  };
  if (qualificationReplacement?.mode === "replace_unplayed") {
    context.replacementMode = "replace_unplayed";
    context.replacementReason = qualificationReplacement.reason;
  }
  return context;
}

function updateQualificationProofUi() {
  const banner = document.getElementById("qualificationProofBanner");
  if (!banner) return;
  const status = qualificationProofStatus();
  const messages = qualificationGuidanceForBlockers(qualificationState);
  banner.hidden = (!qualificationHasFinalBracket() && !messages.length && !qualificationPreparationError)
    || (status === "current" && !messages.length && !qualificationPreparationError);
  banner.style.padding = "8px 10px";
  banner.style.margin = "0 0 10px";
  banner.style.borderRadius = "6px";
  banner.style.background = status === "current" ? "var(--surface-2, #eef8f0)" : "var(--surface-warn, #fff4e5)";
  banner.style.color = status === "current" ? "var(--green-dark, #176b35)" : "var(--red-dark, #8a2d1f)";
  banner.className = `qualification-proof-banner ${status === "current" ? "is-current" : "is-review"}`;
  if (status === "stale") {
    banner.textContent = qualificationHasFinalPlay()
      ? "예선 원본이 바뀌어 본선 진출 근거가 오래되었습니다. 실제 진행 경기가 있어 대진 교체로 우회할 수 없습니다. ‘진출팀 다시 확인’으로 같은 진출팀이 여전히 유효한지 확인하세요."
      : "예선 원본이 바뀌어 본선 초안의 진출 근거가 오래되었습니다. 점수·초안은 보존되어 있습니다. ‘진출팀 다시 확인’으로 같은 진출팀을 재검증하거나, 사유를 남겨 미진행 초안을 교체하세요.";
  } else if (status === "unverified") {
    banner.textContent = "기존 본선에 검증된 예선 진출 근거가 없습니다. 진출팀을 다시 확인한 뒤 공개하세요.";
  } else if (messages.length) {
    banner.textContent = messages.join(" ");
  } else if (qualificationPreparationError) {
    banner.textContent = qualificationPreparationError;
  } else {
    banner.textContent = "예선 진출 근거가 최신입니다.";
  }
  if (qualificationPreparationError && status !== "stale") {
    banner.textContent += ` ${qualificationPreparationError}`;
  }
}

async function prepareFinalQualificationFromServer() {
  if (qualificationPreparationInFlight) return null;
  qualificationPreparationInFlight = true;
  qualificationPreparationError = "";
  try {
    const response = await adminWorkflowCallable("prepareFinalQualification", {
      division: activeDivision,
    });
    const data = response?.data || response;
    if (!data || typeof data.fingerprint !== "string" || !data.state) {
      throw new Error("서버에서 예선 진출 검증 결과를 받지 못했습니다.");
    }
    qualificationServerFingerprint = data.fingerprint;
    qualificationServerState = data.state;
    qualificationTieSelections = canonicalQualificationTieSelections(
      data.state,
      qualificationTieSelections,
    );
    const localState = qualificationStateForCurrentData();
    syncQualificationSelection(localState);
    updateQualificationProofUi();
    return data;
  } catch (error) {
    qualificationPreparationError = error?.message || String(error);
    updateQualificationProofUi();
    throw error;
  } finally {
    qualificationPreparationInFlight = false;
  }
}

async function handleQualificationRevalidation() {
  if (qualificationPreparationInFlight) return;
  const beforeParticipants = finalEntrantIds(finalMatches);
  try {
    const prepared = await prepareFinalQualificationFromServer();
    const serverState = prepared.state;
    const localSelection = qualificationSelectionValidation(
      serverState,
      beforeParticipants.length ? beforeParticipants : seedSelection,
      qualificationTieSelections,
    );
    if (!localSelection.ok) {
      qualificationPreparationError = qualificationValidationMessages(localSelection).join(" ");
      updateQualificationProofUi();
      renderFinalTeamPicker();
      showToast(qualificationPreparationError, 6000);
      return;
    }
    qualificationTieSelections = canonicalQualificationTieSelections(
      serverState,
      localSelection.tieSelections || qualificationTieSelections,
    );
    qualificationServerState = serverState;
    qualificationDraftStale = false;
    qualificationRevalidatedLocally = true;
    qualificationPreparationError = "";
    renderFinalTeamPicker();
    renderFinalBracket();
    showToast("예선 진출팀을 다시 확인했습니다. 기존 본선 점수와 초안은 보존됩니다.", 5000);
  } catch (error) {
    reportError("진출팀 다시 확인", error);
  }
}

async function handleQualificationReplacement() {
  if (qualificationHasFinalPlay()) {
    showToast("실제 진행된 본선은 초안 교체로 우회할 수 없습니다. 진출팀을 다시 확인하거나 정정 절차를 진행하세요.", 6000);
    return;
  }
  const reasonInput = document.getElementById("qualificationReplacementReason");
  const reason = (reasonInput?.value || "").trim();
  if (!reason) {
    reasonInput?.focus();
    showToast("미진행 본선 초안을 교체하려면 사유를 입력하세요.", 5000);
    return;
  }
  qualificationReplacement = { reason, mode: "replace_unplayed" };
  const prepared = await prepareFinalQualificationFromServer().catch((error) => {
    reportError("본선 초안 교체 준비", error);
    return null;
  });
  if (!prepared) return;
  const state = prepared.state;
  const localSelection = qualificationSelectionValidation(state, seedSelection, qualificationTieSelections);
  if (!localSelection.ok) {
    qualificationPreparationError = qualificationValidationMessages(localSelection).join(" ");
    renderFinalTeamPicker();
    showToast(qualificationPreparationError, 6000);
    return;
  }
  const warning = `${divisionLabel()} 미진행 본선 초안을 예선 최신 진출팀으로 교체합니다.
사유: ${reason}
현재 입력된 점수·자리 조정은 이 초안 교체로 사라질 수 있습니다. 계속할까요?`;
  if (!confirm(warning)) return;
  const teamsInSeedOrder = seedSelection.map((id) => ({ id, name: teamName(id) }));
  const { matches } = generateBracket(teamsInSeedOrder);
  finalMatches = matches;
  qualificationReplacement = { reason, mode: "replace_unplayed" };
  qualificationDraftStale = false;
  qualificationRevalidatedLocally = true;
  bracketPublishPending = true;
  renderFinalBracket();
  renderFinalTeamPicker();
  showToast("미진행 본선 초안을 교체했습니다. 사유와 함께 관객 화면에 공개해야 서버에 확정됩니다.", 6000);
}

function renderFinalTeamPicker() {
  const el = document.getElementById("finalTeamPicker");
  el.innerHTML = "";
  const state = qualificationStateForCurrentData();
  syncQualificationSelection(state);
  el.dataset.qualificationReady = String(Boolean(state?.ready && qualificationStateReadyForSelection(state)));
  el.dataset.qualificationRequiredCount = String(qualificationStateRequiredCount(state));
  updateQualificationProofUi();
  updateBracketPublishBar();

  const left = document.createElement("div");
  left.innerHTML = `<h3>진출팀 선택</h3>
    <div class="row" style="justify-content:space-between; margin-bottom:8px;">
      <span class="empty-hint" style="padding:0;">자동 진출팀은 잠겨 있고, 추첨 컷오프 후보만 선택할 수 있습니다.</span>
      <button type="button" class="btn small ghost" id="resetSeedAutoBtn">예선 기준 다시 계산</button>
    </div>`;
  if (!teams.length) {
    left.innerHTML += '<div class="empty-hint">등록된 팀이 없습니다.</div>';
  }
  if (qualificationStateHasStructuralBlockers(state)) {
    const guidance = qualificationGuidanceForBlockers(state);
    const block = document.createElement("div");
    block.className = "empty-hint";
    block.style.padding = "6px 0";
    block.textContent = guidance.length
      ? `참가팀이 있는 모든 조의 예선을 완료해야 합니다. ${guidance.join(" ")}`
      : "참가팀이 있는 모든 조의 예선 경기와 결과를 완료해야 합니다.";
    left.appendChild(block);
  }
  const required = qualificationStateRequiredCount(state);
  if (required > 0) {
    const countHint = document.createElement("div");
    countHint.className = "empty-hint";
    countHint.style.padding = "0 0 8px";
    countHint.textContent = `전체 진출 정원 ${required}팀 · 현재 선택 ${seedSelection.length}팀`;
    left.appendChild(countHint);
  }

  // 조가 여러 개일 때 세로로 길게 한 줄씩 늘어놓으면 화면 오른쪽이 비어 보이므로,
  // 조 블럭을 2열 그리드로 나눠서 배치한다.
  const groupsWrap = document.createElement("div");
  groupsWrap.className = "final-team-picker-groups";
  left.appendChild(groupsWrap);

  groups.forEach((g) => {
    const groupState = (state.groups || []).find((item) => item.groupId === g.id);
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    if (!groupTeams.length) return;
    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id).sort((a, b) => (a.round || 0) - (b.round || 0));
    const standings = groupState?.standings || computeGroupStandings(groupTeams, groupMatches);
    const standingById = Object.fromEntries(standings.map((s) => [s.teamId, s]));
    const automaticIds = new Set(groupState?.automaticIds || []);
    const cutoffCandidateIds = new Set(groupState?.cutoffCandidateIds || []);
    const cutoffSlots = Math.max(0, Number(groupState?.cutoffSlots) || 0);
    const selectedCutoff = qualificationTieSelections[g.id] || [];

    const sub = document.createElement("div");
    sub.style.marginBottom = "10px";
    const cutoffWarning = cutoffSlots
      ? `<div class="lottery-flag">추첨 후보 중 ${cutoffSlots}팀을 선택하세요 (현재 ${selectedCutoff.length}/${cutoffSlots}).</div>`
      : "";
    sub.innerHTML = `<div style="font-weight:700; font-size:13px; margin-bottom:6px;">${escapeHtml(g.name)}</div>${cutoffWarning}`;
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
        const automatic = automaticIds.has(t.id);
        const cutoffCandidate = cutoffCandidateIds.has(t.id);
        const checked = automatic || selectedCutoff.includes(t.id);
        const rankBadge = s ? `<span class="badge">예선 ${s.rank}위</span>` : "";
        // 예선 경기를 하나도 치르지 않았으면(전부 0점) 동률 설명이 무의미하므로, 실제로 경기를 치른 뒤에만 보여준다
        const hasPlayed = s && s.played > 0;
        const lotteryBadge = hasPlayed && s.needsLottery ? '<span class="badge lottery">동률·추첨필요</span>' : "";
        const reasonText = !s ? "팀 정보 없음" : hasPlayed ? buildQualifyReasonText(standings, s) : "";
        const editable = cutoffCandidate
          && cutoffSlots > 0
          && qualificationStateReadyForSelection(state);
        const disabledReason = automatic
          ? "자동 진출팀은 필수 선택입니다."
          : editable
          ? ""
          : "예선 미완료 또는 진출선 밖의 팀입니다.";
        row.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""} ${editable ? "" : "disabled"} />
          <span style="flex:1;">
            <span>${escapeHtml(t.name)} ${rankBadge} ${lotteryBadge}</span>
            ${reasonText ? `<div class="empty-hint" style="padding:2px 0 0; font-size:11.5px; line-height:1.5;">${escapeHtml(reasonText)}</div>` : ""}
          </span>`;
        const input = row.querySelector("input");
        input.dataset.teamId = t.id;
        input.dataset.groupId = g.id;
        input.dataset.qualificationRole = automatic ? "automatic" : cutoffCandidate ? "cutoff" : "blocked";
        input.title = disabledReason;
        input.addEventListener("change", (e) => {
          const next = new Set(qualificationTieSelections[g.id] || []);
          if (e.target.checked) {
            if (next.size >= cutoffSlots) {
              showToast(`'${g.name}'은(는) 남은 ${cutoffSlots}자리만 선택할 수 있습니다.`);
              renderFinalTeamPicker();
              return;
            }
            next.add(t.id);
          } else {
            next.delete(t.id);
          }
          qualificationTieSelections[g.id] = [...next];
          seedAutoMode = true;
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
      qualificationTieSelections = {};
      seedAutoMode = true;
      renderFinalTeamPicker();
    });
  }

  if (finalScoreDrafts.size) {
    const exportDraft = document.createElement("button");
    exportDraft.type = "button";
    exportDraft.className = "btn small ghost";
    exportDraft.textContent = "본선 점수 초안 JSON 내보내기";
    exportDraft.title = "예선 원본 변경이나 명시적 교체 전에 현재 점수 초안을 보관합니다.";
    exportDraft.addEventListener("click", () => {
      const stamp = dateStamp();
      downloadJson(
        `본선_점수초안_${activeDivision}_${stamp}.json`,
        JSON.stringify({
          version: 1,
          division: activeDivision,
          expectedPrelimFingerprint: qualificationServerFingerprint || null,
          matches: cloneFinalMatches(finalMatches),
          scoreDrafts: [...finalScoreDrafts.values()].map((draft) => structuredClone(draft)),
        }, null, 2),
      );
      showToast("본선 점수 초안을 JSON으로 내보냈습니다.", 4000);
    });
    left.appendChild(exportDraft);
  }

  const actions = document.createElement("div");
  actions.className = "row";
  actions.style.marginTop = "12px";
  actions.style.gap = "8px";
  const revalidate = document.createElement("button");
  revalidate.type = "button";
  revalidate.className = "btn small ghost";
  revalidate.id = "revalidateQualificationBtn";
  revalidate.textContent = qualificationPreparationInFlight ? "확인 중…" : "진출팀 다시 확인";
  revalidate.disabled = qualificationPreparationInFlight;
  revalidate.addEventListener("click", handleQualificationRevalidation);
  actions.appendChild(revalidate);
  if (qualificationDraftStale && !qualificationHasFinalPlay()) {
    const replacement = document.createElement("button");
    replacement.type = "button";
    replacement.className = "btn small danger";
    replacement.id = "replaceQualificationBtn";
    replacement.textContent = "미진행 초안 교체";
    replacement.addEventListener("click", handleQualificationReplacement);
    actions.appendChild(replacement);

    const reason = document.createElement("textarea");
    reason.id = "qualificationReplacementReason";
    reason.rows = 2;
    reason.maxLength = 500;
    reason.setAttribute("aria-label", "미진행 본선 초안 교체 사유");
    reason.placeholder = "초안 교체 사유 (필수)";
    reason.value = qualificationReplacement?.reason || "";
    reason.style.width = "100%";
    reason.style.marginTop = "6px";
    left.appendChild(reason);
  }
  left.appendChild(actions);
  el.appendChild(left);
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
  if (!finalMutationAllowed()) return;
  const localState = qualificationStateForCurrentData();
  if (!qualificationStateReadyForSelection(localState)) {
    const messages = qualificationGuidanceForBlockers(localState);
    return showToast(
      messages.length
        ? `모든 조의 예선을 완료해야 합니다. ${messages.join(" ")}`
        : "참가팀이 있는 모든 조의 예선 경기와 결과를 완료하세요.",
      6000,
    );
  }
  const localSelection = qualificationSelectionValidation(localState, seedSelection, qualificationTieSelections);
  if (!localSelection.ok) {
    const message = qualificationValidationMessages(localSelection).join(" ");
    return showToast(message || "진출팀 선택을 확인하세요.", 6000);
  }
  if (qualificationDraftStale && qualificationHasFinalBracket()) {
    return showToast("예선 원본이 바뀌었습니다. 먼저 ‘진출팀 다시 확인’ 또는 미진행 초안 교체를 진행하세요.", 6000);
  }
  if (qualificationHasFinalPlay() && qualificationHasFinalBracket()) {
    return showToast("실제 진행된 본선은 새 대진표 생성으로 우회할 수 없습니다.", 6000);
  }
  if (!confirm(
    `${divisionLabel()} ${seedSelection.length}팀으로 본선 대진표를 생성할까요?\n`
    + "기존 본선 초안과 입력된 점수·자리 조정은 확인 후 교체됩니다.",
  )) return;
  let prepared;
  try {
    prepared = await prepareFinalQualificationFromServer();
  } catch (error) {
    reportError("본선 대진표 생성 전 진출팀 확인", error);
    return;
  }
  const serverSelection = qualificationSelectionValidation(
    prepared.state,
    seedSelection,
    qualificationTieSelections,
  );
  if (!serverSelection.ok) {
    qualificationPreparationError = qualificationValidationMessages(serverSelection).join(" ");
    renderFinalTeamPicker();
    showToast(qualificationPreparationError || "서버 기준 진출팀 선택을 확인하세요.", 6000);
    return;
  }
  qualificationTieSelections = canonicalQualificationTieSelections(
    prepared.state,
    serverSelection.tieSelections || qualificationTieSelections,
  );
  qualificationServerState = prepared.state;
  qualificationDraftStale = false;
  qualificationRevalidatedLocally = true;
  qualificationReplacement = null;
  const teamsInSeedOrder = seedSelection.map((id) => ({ id, name: teamName(id) }));
  const { matches } = generateBracket(teamsInSeedOrder);
  finalMatches = matches;
  finalScoreDrafts = new Map();
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
  const hasBracket = finalMatches.length > 0 || authoritativeFinalMatches.length > 0 || bracketPublishPending;
  bar.style.display = hasBracket ? "flex" : "none";
  bar.classList.toggle("is-pending", bracketPublishPending || bracketPublishConflict);
  const qualificationStateForPublish = qualificationServerState || qualificationStateForCurrentData();
  const qualificationValidation = qualificationSelectionValidation(
    qualificationStateForPublish,
    finalEntrantIds(finalMatches),
    qualificationTieSelections,
  );
  const qualificationNeedsReview = qualificationDraftStale
    || !qualificationServerFingerprint
    || qualificationStateHasStructuralBlockers(qualificationStateForPublish)
    || !qualificationValidation.ok
    || (authoritativeFinalMatches.length > 0
      && qualificationProofStatus() !== "current")
    || (!authoritativeFinalMatches.length && !bracketPublishPending
      && qualificationProofStatus() !== "current");

  if (msg) {
    msg.textContent = bracketPublishConflict
      ? "공개 기준이 변경되었습니다. 로컬 초안을 버린 뒤 최신 대진표를 확인하세요."
      : qualificationNeedsReview
      ? "예선 진출 근거를 다시 확인해야 공개할 수 있습니다. 현재 초안과 점수는 보존됩니다."
      : bracketPublishPending
      ? "공개하지 않은 변경/기록이 있습니다. 버튼을 눌러야 관객 화면에 반영됩니다."
      : "모든 변경사항이 관객 화면에 공개되어 있습니다.";
  }
  if (btn) {
    btn.disabled = (!bracketPublishPending && !bracketPublishConflict)
      || bracketPublishInFlight
      || (qualificationNeedsReview && !bracketPublishConflict);
    btn.textContent = bracketPublishConflict ? "로컬 초안 버리기" : bracketPublishInFlight ? "공개 중…" : bracketPublishPending ? "관객 화면에 공개" : "공개 완료";
  }
}

/** "관객 화면에 공개" — 그동안 로컬에서만 조정/입력해 둔 대진·경기 기록을 한 번에 Firestore에
 * 반영해서 대시보드(관객 화면)에 실제로 공유한다. 6강·준결승·결승 등 매 라운드 결과를 입력한 뒤
 * 이 버튼을 눌러 그때그때 공개할 수 있다. */
async function handlePublishBracket() {
  if ((!bracketPublishPending && !bracketPublishConflict) || bracketPublishInFlight) return;
  if (bracketPublishConflict) {
    if (!confirm("최신 공개본과 충돌했습니다. 로컬 본선 초안과 점수 기록을 버릴까요?")) return;
    discardFinalDraft();
    showToast("로컬 본선 초안을 버리고 최신 공개본을 불러왔습니다.");
    return;
  }
  const qualificationStateForPublish = qualificationServerState || qualificationStateForCurrentData();
  const finalParticipants = finalEntrantIds(finalMatches);
  const qualificationValidation = qualificationSelectionValidation(
    qualificationStateForPublish,
    finalParticipants,
    qualificationTieSelections,
  );
  if (qualificationDraftStale) {
    showToast("예선 원본이 바뀌었습니다. 먼저 ‘진출팀 다시 확인’을 완료하세요.", 6000);
    return;
  }
  if (!qualificationServerFingerprint) {
    showToast("공개 전에 ‘진출팀 다시 확인’으로 서버 검증을 받아야 합니다.", 6000);
    return;
  }
  if (authoritativeFinalMatches.length > 0 && qualificationProofStatus() !== "current") {
    showToast("기존 본선의 진출 근거가 오래되었습니다. 먼저 ‘진출팀 다시 확인’을 완료하세요.", 6000);
    return;
  }
  if (qualificationStateHasStructuralBlockers(qualificationStateForPublish)) {
    const messages = qualificationGuidanceForBlockers(qualificationStateForPublish);
    showToast(messages.join(" ") || "참가팀이 있는 모든 조의 예선을 완료해야 공개할 수 있습니다.", 6000);
    return;
  }
  if (!qualificationValidation.ok) {
    const message = qualificationValidationMessages(qualificationValidation).join(" ");
    showToast(message || "본선 진출팀을 다시 확인하세요.", 6000);
    return;
  }
  bracketPublishInFlight = true;
  updateBracketPublishBar();
  try {
    const qualificationContext = qualificationPublishContext(
      qualificationStateForPublish,
      finalParticipants,
    );
    const response = await publishFinalBracket(
      activeDivision,
      finalDraftBaseline,
      finalMatches.map(finalStructureMatch),
      [...finalScoreDrafts.values()],
      qualificationContext,
    );
    const canonicalMatches = response.matches || response.finalMatches;
    if (!Array.isArray(canonicalMatches)) throw new Error("공개 결과에 표준 본선 대진표가 없습니다.");
    resetFinalDraft(canonicalMatches);
    qualificationProof = {
      ...(qualificationProof || {}),
      status: "current",
      fingerprint: qualificationServerFingerprint,
      participantIds: [...new Set(finalParticipants)].sort(),
      tieSelections: qualificationContext.tieSelections,
    };
    qualificationRevalidatedLocally = false;
    qualificationDraftStale = false;
    qualificationReplacement = null;
    qualificationPreparationError = "";
    updateBracketPublishBar();
    showToast(`${divisionLabel()} 대진표를 관객 화면에 공개했습니다`);
  } catch (err) {
    qualificationPreparationError = err?.message || String(err);
    updateQualificationProofUi();
    reportError("관객 화면 공개", err);
  } finally {
    bracketPublishInFlight = false;
    updateBracketPublishBar();
  }
}

function finalStructureMatch(match) {
  const {
    sets, result, winner, winnerSide, winnerTeam,
    setsWonA, setsWonB, pointsForA, pointsForB,
    officialRevision, lastTransitionId,
    ...structure
  } = match;
  if (structure.status === "done" || structure.status === "in_progress") structure.status = "pending";
  if (structure.round > 1) {
    structure.teamA = null;
    structure.teamB = null;
    structure.teamASource = null;
    structure.teamBSource = null;
  }
  if (!structure.nextMatchId) structure.nextSlot = null;
  return structure;
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
  if (!finalMutationAllowed()) return;
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
  if (!finalMutationAllowed()) return;
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
  if (!finalMutationAllowed()) return;
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
  if (!finalMutationAllowed()) return;
  if (isFinalScoreStagingBlocked(match)) {
    showToast("기록관 워크플로가 진행 중인 본선 경기는 로컬로 점수를 수정할 수 없습니다.", 4000);
    return;
  }
  const modalContext = finalScoreModalContext(match);
  openScoreModal({
    teamAName: match.teamA ? match.teamA.name : "",
    teamBName: match.teamB ? match.teamB.name : "",
    setLabels: ["1세트 (10점)", "2세트 (10점)", "3세트 (7점, 필요시만)"],
    targets: [10, 10, 7],
    existingSets: match.sets || [],
    requireComplete: true,
    onSave: async (sets) => {
      if (!finalMutationAllowed()) throw new Error("본선 공개 처리 중입니다. 완료 후 다시 입력하세요.");
      if (!finalScoreModalContextIsCurrent(modalContext)) {
        bracketPublishConflict = true;
        updateBracketPublishBar();
        throw new Error("대진 또는 공개 기준이 변경되었습니다. 로컬 초안을 버리고 최신 대진표를 확인하세요.");
      }
      const result = evaluateFinalMatch(sets);
      if (result.status !== "done") throw new Error("본선 점수는 승자가 확정된 완전한 경기 결과여야 합니다.");
      const official = authoritativeFinalMatches.find((item) => item.id === modalContext.matchId);
      const approved = (official?.officialRevision || 0) > 0;
      const scoreChanged = JSON.stringify(official?.sets || []) !== JSON.stringify(sets);
      if (approved && !scoreChanged) {
        showToast("승인된 본선 점수와 동일합니다. 공개할 변경사항이 없습니다.");
        return;
      }
      const correctionReason = approved && scoreChanged ? requiredReason("승인된 본선 점수 정정") : null;
      if (approved && scoreChanged && !correctionReason) throw new Error("승인된 점수를 바꾸려면 정정 사유가 필요합니다.");

      stageFinalScoreDraft(modalContext.matchId, sets, correctionReason || "");
      showToast("본선 점수를 로컬 초안에 저장했습니다. 아직 관객 화면에 공개되지 않았습니다.");
    },
  });
}

function finalScoreModalContext(match) {
  return {
    division: activeDivision,
    baseline: structuredClone(finalDraftBaseline),
    authoritativeBaseline: finalBaselineDescriptor(authoritativeFinalMatches),
    matchId: match.id,
    teamAId: match.teamA?.id || null,
    teamBId: match.teamB?.id || null,
  };
}

function finalScoreModalContextIsCurrent(context) {
  const match = finalMatches.find((item) => item.id === context.matchId);
  return context.division === activeDivision
    && sameFinalBaseline(context.baseline, finalDraftBaseline)
    && sameFinalBaseline(context.authoritativeBaseline, finalBaselineDescriptor(authoritativeFinalMatches))
    && Boolean(match)
    && (match.teamA?.id || null) === context.teamAId
    && (match.teamB?.id || null) === context.teamBId;
}

function stageFinalScoreDraft(matchId, sets, reason) {
  const current = finalMatches.find((item) => item.id === matchId);
  if (!current) throw new Error("본선 경기를 찾을 수 없습니다.");
  const result = evaluateFinalMatch(sets);
  if (result.status !== "done") throw new Error("본선 점수는 승자가 확정된 완전한 경기 결과여야 합니다.");
  const previousWinnerId = current.winnerTeam?.id || null;
  if (previousWinnerId && previousWinnerId !== (result.winner === "A" ? current.teamA?.id : current.teamB?.id)) {
    invalidateDescendantResults(finalMatches, matchId).forEach((id) => finalScoreDrafts.delete(id));
  }
  recordMatchResult(finalMatches, matchId, sets, evaluateFinalMatch);
  const workflow = reviewWorkflows.get(`final:${activeDivision}:${matchId}`);
  finalScoreDrafts.set(matchId, {
    matchId, sets: structuredClone(sets), reason,
    expectedSubmissionVersion: workflow?.submissionVersion || 0,
  });
  bracketPublishPending = true;
  renderFinalBracket();
}

function isFinalScoreStagingBlocked(match) {
  const matchKey = `final:${activeDivision}:${match.id}`;
  const workflow = reviewWorkflows.get(matchKey);
  const assignment = reviewAssignments.find((item) => item.id === matchKey);
  const states = [workflow?.draftState, workflow?.status, assignment?.publicStatus, match.workflowStatus]
    .filter(Boolean)
    .map((state) => String(state).toLowerCase());
  return Boolean(workflow?.lock) || states.some((state) => [
    "editing", "locked", "submitted", "rejected", "replay", "replay_required",
    "rework_required", "under_review", "in_progress",
  ].includes(state));
}

// ---------------- 모달 / 토스트 ----------------

function openScoreModal({ teamAName, teamBName, setLabels, targets, existingSets, requireComplete = false, onSave }) {
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
    if (requireComplete && evaluateFinalMatch(sets).status !== "done") {
      errorMsg.textContent = "본선 경기는 승자가 확정된 완전한 점수를 입력하세요.";
      errorMsg.classList.add("show");
      return;
    }
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
  if (err?.details?.reason === "qualification_unverified"
      || String(err?.message || "") === "qualification_unverified") {
    showToast(`${action}을(를) 중단했습니다. 본선 진출팀을 다시 확인한 뒤 진행하세요. 기존 기록은 유지됩니다.`, 7000);
    return;
  }
  if (/preliminary match has official history/i.test(String(err?.message || ""))) {
    showToast(`${action}을(를) 중단했습니다. ${PRELIM_HISTORY_GUIDANCE}`, 7000);
    return;
  }
  const code = err && err.code ? ` (${err.code})` : "";
  showToast(`${action} 실패${code}: ${err && err.message ? err.message : err}`, 5000);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

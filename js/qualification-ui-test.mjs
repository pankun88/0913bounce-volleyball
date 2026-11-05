import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  buildQualificationSnapshot,
  computeQualificationState,
  validateQualificationSelection,
  computeByeLotteryState,
  validateByeSelection,
  evaluateFinalMatch,
  normalizePlayedSets,
} from "./match-logic.js";
import { buildCrossGroupSeedOrder, generateBracket, recordMatchResult, invalidateDescendantResults, swapFinalSeedSlots, finalSlotsLocked } from "./bracket.js";

const adminSource = fs.readFileSync(new URL("./admin.js", import.meta.url), "utf8");

function extractFunctionSource(name) {
  const asyncMarker = `async function ${name}(`;
  const normalMarker = `function ${name}(`;
  const marker = adminSource.includes(asyncMarker) ? asyncMarker : normalMarker;
  const start = adminSource.indexOf(marker);
  if (start < 0) throw new Error(`Admin function not found: ${name}`);
  const open = adminSource.indexOf("{", start + marker.length);
  if (open < 0) throw new Error(`Admin function body not found: ${name}`);
  let depth = 0;
  let mode = "code";
  let escaped = false;
  for (let index = open; index < adminSource.length; index += 1) {
    const current = adminSource[index];
    const next = adminSource[index + 1];
    if (mode === "line-comment") {
      if (current === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (current === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "single" || mode === "double" || mode === "template") {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if ((mode === "single" && current === "'")
        || (mode === "double" && current === '"')
        || (mode === "template" && current === "`")) {
        mode = "code";
      }
      continue;
    }
    if (current === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
      continue;
    }
    if (current === "'") {
      mode = "single";
      continue;
    }
    if (current === '"') {
      mode = "double";
      continue;
    }
    if (current === "`") {
      mode = "template";
      continue;
    }
    if (current === "{") depth += 1;
    if (current === "}") {
      depth -= 1;
      if (depth === 0) return adminSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed admin function: ${name}`);
}

function loadAdminFunctions(names, values = {}) {
  const context = vm.createContext({
    console,
    JSON,
    Math,
    Map,
    Set,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Promise,
    structuredClone,
    buildQualificationSnapshot,
    computeQualificationState,
    validateQualificationSelection,
    computeByeLotteryState,
    validateByeSelection,
    evaluateFinalMatch,
    normalizePlayedSets,
    recordMatchResult,
    invalidateDescendantResults,
    swapFinalSeedSlots,
    finalSlotsLocked,
    buildCrossGroupSeedOrder,
    generateBracket,
    FINAL_PUBLISH_NEXT_STEP: "본선 탭에서 ‘관객·기록관 화면에 공개’를 눌러야 다음 경기가 열립니다",
    ...values,
  });
  names.forEach((name) => vm.runInContext(extractFunctionSource(name), context));
  return context;
}

function call(context, name, ...args) {
  context.__adminArgs = args;
  return vm.runInContext(`${name}(...__adminArgs)`, context);
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

const finishedSets = [{ a: 10, b: 8 }, { a: 10, b: 8 }];

function prelimMatch(id, groupId, teamA, teamB, division = "men") {
  return {
    id,
    division,
    groupId,
    teamA,
    teamB,
    sets: finishedSets,
    status: "done",
    officialCurrent: true,
    officialRevision: 1,
  };
}

function qualificationFixture() {
  return {
    groups: [{ id: "g1", division: "men", matchMode: "roundrobin" }],
    teams: [
      { id: "a", division: "men", groupId: "g1", name: "A" },
      { id: "b", division: "men", groupId: "g1", name: "B" },
      { id: "c", division: "men", groupId: "g1", name: "C" },
    ],
    matches: [
      prelimMatch("m1", "g1", "a", "b"),
      prelimMatch("m2", "g1", "a", "c"),
      prelimMatch("m3", "g1", "b", "c"),
    ],
  };
}

function testActualSourceInvalidationAndForeignRecords() {
  const fixture = qualificationFixture();
  const context = loadAdminFunctions([
    "qualificationSnapshotForCurrentData",
    "qualificationSourceChanged",
    "qualificationHasFinalBracket",
    "qualificationPostFinalCorrected",
    "qualificationHasFinalPlay",
  ], {
    activeDivision: "men",
    tournamentInfo: { qualifyPerGroup: { men: 2 } },
    allGroups: fixture.groups,
    allTeams: [
      ...fixture.teams,
      { id: "foreign-team", division: "women", groupId: "g1", name: "Foreign" },
    ],
    allPrelimMatches: [
      ...fixture.matches,
      prelimMatch("foreign-match", "g1", "a", "b", "women"),
    ],
    groups: fixture.groups,
    teams: fixture.teams,
    prelimMatches: fixture.matches,
    finalMatches: [{ id: "final-1" }],
    authoritativeFinalMatches: [],
    bracketPublishPending: false,
    finalScoreDrafts: new Map([["final-1", { sets: finishedSets }]]),
    qualificationInfoLoaded: true,
    qualificationGroupsLoaded: true,
    qualificationTeamsLoaded: true,
    qualificationMatchesLoaded: true,
    qualificationSourceInitialized: false,
    qualificationSourceKey: "",
    qualificationDraftStale: false,
    qualificationProof: null,
  });

  const snapshot = jsonValue(call(context, "qualificationSnapshotForCurrentData"));
  assert.deepEqual(
    snapshot.teams.map((team) => team.id).sort(),
    ["a", "b", "c", "foreign-team"],
    "selected group members are retained even when their division label is stale",
  );
  assert.deepEqual(
    snapshot.matches.map((match) => match.id).sort(),
    ["foreign-match", "m1", "m2", "m3"],
    "selected group matches are retained even when their division label is stale",
  );

  assert.equal(call(context, "qualificationSourceChanged"), false);
  const drafts = context.finalScoreDrafts;
  context.allPrelimMatches = context.allPrelimMatches.map((match) => (
    match.id === "m1" ? { ...match, officialRevision: 2 } : match
  ));
  assert.equal(call(context, "qualificationSourceChanged"), true);
  assert.equal(context.qualificationDraftStale, true);
  assert.equal(context.finalScoreDrafts, drafts, "source invalidation preserves the actual score-draft Map");
  assert.deepEqual([...context.finalScoreDrafts.keys()], ["final-1"]);
}

async function testActualPreparationPublishContextAndCount() {
  const state = {
    ready: true,
    blockers: [],
    requiredCount: 2,
    groups: [{
      groupId: "g1",
      requiredCount: 2,
      automaticIds: ["a"],
      cutoffCandidateIds: ["b", "c"],
      cutoffSlots: 1,
      standings: [{ teamId: "a", rank: 1 }, { teamId: "b", rank: 2 }, { teamId: "c", rank: 2 }],
    }],
  };
  let selectionSyncCalls = 0;
  const preparationContext = loadAdminFunctions([
    "qualificationBlockerMessage",
    "qualificationValidationMessages",
    "qualificationGroupTeamIds",
    "canonicalQualificationTieSelections",
    "prepareFinalQualificationFromServer",
    "qualificationPublishContext",
    "finalByeLotteryState",
    "finalByeSelectionComplete",
  ], {
    finalByeSelection: null,
    qualificationPreparationInFlight: false,
    qualificationPreparationError: "",
    qualificationServerFingerprint: "",
    qualificationServerState: null,
    qualificationTieSelections: { g1: ["b", "invalid"] },
    qualificationReplacement: null,
    qualificationStateForCurrentData: () => state,
    syncQualificationSelection: () => { selectionSyncCalls += 1; },
    updateQualificationProofUi: () => {},
    adminWorkflowCallable: async (name, payload) => {
      assert.equal(name, "prepareFinalQualification");
      assert.deepEqual(jsonValue(payload), { division: "men" });
      return { data: { fingerprint: "f".repeat(64), state } };
    },
    activeDivision: "men",
  });
  const prepared = await call(preparationContext, "prepareFinalQualificationFromServer");
  assert.equal(prepared.fingerprint, "f".repeat(64));
  assert.equal(preparationContext.qualificationServerFingerprint, "f".repeat(64));
  assert.equal(selectionSyncCalls, 1, "actual preparation updates actual selection state");
  assert.deepEqual(
    jsonValue(call(preparationContext, "qualificationPublishContext", state, ["a", "b"])),
    { expectedPrelimFingerprint: "f".repeat(64), tieSelections: { g1: ["b"] } },
    "actual publish context carries the captured preparation fingerprint and canonical ties",
  );

  const mappingContext = loadAdminFunctions([
    "qualificationBlockerMessage",
    "qualificationValidationMessages",
  ]);
  const korean = jsonValue(call(mappingContext, "qualificationValidationMessages", {
    errors: ["non_qualifier_selected:team-c", "qualification_not_ready:details"],
  }));
  assert.deepEqual(korean, [
    "진출 조건을 충족하지 않는 팀은 선택할 수 없습니다.",
    "참가팀이 있는 모든 조의 예선 결과를 먼저 완료하세요.",
  ], "qualification guidance is Korean and code-specific");

  const calls = [];
  const input = { value: "3" };
  const countContext = loadAdminFunctions(["saveQualificationCount"], {
    activeDivision: "men",
    tournamentInfo: { qualifyPerGroup: { men: 2 } },
    qualificationCountInputOverride: null,
    seedAutoMode: true,
    document: { getElementById: (id) => {
      assert.equal(id, "qualifyPerGroupInput");
      return input;
    } },
    adminWorkflowCallable: async (...args) => {
      calls.push(args);
      return { data: { count: 3 } };
    },
    qualificationSourceChanged: () => {},
    qualificationStateForCurrentData: () => state,
    renderFinalTeamPicker: () => {},
    divisionLabel: () => "남자부",
    showToast: () => {},
    reportError: (action, error) => { throw new Error(`${action}: ${error}`); },
  });
  await call(countContext, "saveQualificationCount");
  assert.deepEqual(jsonValue(calls), [["setQualificationCount", { division: "men", count: 3 }]], "actual count handler uses the callable");
  assert.equal(countContext.tournamentInfo.qualifyPerGroup.men, 3);
}

function testActualSelectionState() {
  const selectionContext = loadAdminFunctions([
    "qualificationGroupTeamIds",
    "canonicalQualificationTieSelections",
    "qualificationSelectionIds",
    "qualificationSeedOrder",
    "syncQualificationSelection",
    "finalByeLotteryState",
    "syncFinalByeSelection",
  ], {
    finalByeSelection: null,
    qualificationTieSelections: { g1: ["b", "not-a-candidate"] },
    seedSelection: [],
    buildCrossGroupSeedOrder: (tiers) => tiers.flat(),
  });
  const state = {
    ready: true,
    blockers: [],
    requiredCount: 2,
    groups: [{
      groupId: "g1",
      requiredCount: 2,
      automaticIds: ["a"],
      cutoffCandidateIds: ["b", "c"],
      cutoffSlots: 1,
      standings: [{ teamId: "a", rank: 1 }, { teamId: "b", rank: 2 }, { teamId: "c", rank: 2 }],
    }],
  };
  const canonical = jsonValue(call(selectionContext, "canonicalQualificationTieSelections", state));
  assert.deepEqual(canonical, { g1: ["b"] });
  call(selectionContext, "syncQualificationSelection", state);
  assert.deepEqual(
    jsonValue(selectionContext.seedSelection),
    ["a", "b"],
    "actual sync keeps mandatory and selected cutoff teams",
  );
  assert.deepEqual(
    jsonValue(call(selectionContext, "qualificationSelectionIds", state)),
    ["a", "b"],
  );
}

function finalUiFixture() {
  const fixture = qualificationFixture();
  const state = computeQualificationState(buildQualificationSnapshot({
    division: "men",
    qualifyPerGroup: 2,
    ...fixture,
  }));
  const elements = Object.fromEntries([
    "qualificationProofBanner", "bracketPublishBar", "bracketPublishMsg", "publishBracketBtn",
    "bracketPublishTitle",
  ].map((id) => [id, { style: {}, dataset: {}, classList: { toggle() {} } }]));
  const calls = [];
  const toasts = [];
  const errors = [];
  const confirmations = [];
  const context = loadAdminFunctions([
    "cloneFinalMatches", "finalBaselineDescriptor", "sameFinalBaseline", "resetFinalDraft", "finalMutationAllowed",
    "qualificationHasFinalBracket", "qualificationHasFinalPlay", "finalEntrantIds",
    "qualificationProofStatus", "qualificationPostFinalCorrected", "qualificationBlockerCode", "qualificationBlockerMessage",
    "qualificationStateBlockers", "qualificationStateHasStructuralBlockers",
    "qualificationStateReadyForSelection", "qualificationGuidanceForBlockers",
    "qualificationGroupTeamIds", "canonicalQualificationTieSelections",
    "qualificationSelectionIds", "qualificationSeedOrder", "syncQualificationSelection",
    "qualificationSelectionValidation", "qualificationValidationMessages",
    "qualificationPublishContext", "prepareFinalQualificationFromServer",
    "handleQualificationRevalidation", "updateQualificationProofUi",
    "onGenerateBracket", "handleClearBracket", "updateBracketPublishBar",
    "handlePublishBracket", "finalStructureMatch", "hasRecordedFinalStructureChanges", "discardFinalDraft",
    "handleBracketSlotSwap",
    "stageSubmittedFinalReview", "stageFinalScoreDraft", "finalPublicationErrorMessage",
    "openFinalScoreModal", "isFinalScoreStagingBlocked", "finalScoreModalContext", "finalScoreModalContextIsCurrent",
    "finalByeLotteryState", "syncFinalByeSelection", "finalByeSelectionComplete", "finalByeSelectionProblem",
    "finalPublicationStatus", "updateFinalPublicationIndicators",
  ], {
    activeDivision: "men",
    finalByeSelection: null,
    DIVISION_LABELS: { men: "남자부", women: "여자부" },
    qualificationState: state,
    qualificationStateForCurrentData: () => state,
    qualificationProof: null,
    qualificationRevalidatedLocally: false,
    qualificationServerFingerprint: "",
    qualificationServerState: null,
    qualificationTieSelections: {},
    qualificationReplacement: null,
    qualificationDraftStale: false,
    qualificationPreparationInFlight: false,
    qualificationPreparationError: "",
    seedSelection: ["a", "b"],
    finalMatches: [],
    authoritativeFinalMatches: [],
    finalDraftBaseline: [],
    finalScoreDrafts: new Map(),
    bracketPublishPending: false,
    bracketPublishConflict: false,
    bracketPublishInFlight: false,
    reviewAssignments: [
      { id: "m1", matchType: "prelim", divisionId: "men", publicStatus: "completed", attemptCount: 1 },
      { id: "final:women:r1m0", matchType: "final", divisionId: "women", publicStatus: "under_review" },
    ],
    reviewWorkflows: new Map([
      ["m1", { draftRevision: 2, submissionVersion: 1, draft: { sets: finishedSets } }],
      ["final:women:r1m0", { draftState: "submitted", submissionVersion: 1 }],
    ]),
    document: { getElementById: (id) => elements[id], querySelector: () => null },
    teamName: (id) => fixture.teams.find((team) => team.id === id)?.name || id,
    divisionLabel: () => "남자부",
    confirm: (message) => { confirmations.push(message); return true; },
    showToast: (message) => toasts.push(message),
    reportError: (action, error) => errors.push({ action, error }),
    updateQualificationStructureControls: () => {},
    adminWorkflowCallable: async (name, payload) => {
      calls.push([name, jsonValue(payload)]);
      if (name === "prepareFinalQualification") return { data: { fingerprint: "f".repeat(64), state } };
      assert.equal(name, "clearFinalStructure");
      return { data: { cleared: true } };
    },
    publishFinalBracket: async (...args) => {
      calls.push(["publishFinalBracket", jsonValue(args)]);
      return { matches: args[2] };
    },
  });
  context.renderFinalTeamPicker = () => call(context, "updateQualificationProofUi");
  context.renderFinalBracket = () => call(context, "updateBracketPublishBar");
  return { context, elements, calls, toasts, errors, confirmations };
}

async function testGeneratedBracketWarningsAndReset() {
  const { context, elements, calls, errors, confirmations } = finalUiFixture();
  await call(context, "onGenerateBracket");
  assert.ok(context.finalMatches.length > 0, "completed preliminary results generate a bracket");
  assert.equal(call(context, "qualificationProofStatus"), "current");
  assert.equal(context.qualificationProof, null, "draft validation does not invent persisted proof");
  assert.equal(elements.qualificationProofBanner.hidden, true, "new validated drafts show no missing-proof warning");
  assert.equal(elements.publishBracketBtn.disabled, false);
  assert.equal(call(context, "qualificationHasFinalPlay"), false, "preliminary and other-division records are excluded");

  await call(context, "onGenerateBracket");
  assert.equal(calls.filter(([name]) => name === "prepareFinalQualification").length, 2,
    "regeneration is not blocked by completed preliminary records");
  await call(context, "handleClearBracket");
  assert.equal(context.finalMatches.length, 0);
  assert.equal(context.qualificationServerFingerprint, "");
  assert.equal(context.qualificationRevalidatedLocally, false);
  assert.equal(elements.qualificationProofBanner.hidden, true);
  assert.equal(calls.some(([name]) => name === "clearFinalStructure"), false, "local reset does not mutate the server");
  assert.match(confirmations.at(-1), /예선 결과는 유지/);
  assert.equal(context.reviewAssignments[0].attemptCount, 1, "preliminary records remain intact");

  await call(context, "onGenerateBracket");
  await call(context, "handlePublishBracket");
  assert.equal(context.qualificationProof.status, "current");
  assert.equal(context.bracketPublishPending, false);
  assert.equal(context.authoritativeFinalMatches.length, context.finalMatches.length);
  await call(context, "handleClearBracket");
  assert.deepEqual(calls.at(-1), ["clearFinalStructure", { division: "men" }]);
  assert.equal(context.authoritativeFinalMatches.length, 0);
  assert.deepEqual(errors, []);
}

async function testRevalidationCanActuallyPublish() {
  for (const proof of [null, { status: "stale", fingerprint: "old" }]) {
    const { context, elements, calls, errors } = finalUiFixture();
    const matches = generateBracket([{ id: "a", name: "A" }, { id: "b", name: "B" }]).matches;
    matches[0].sets = finishedSets;
    matches[0].officialRevision = 1;
    matches[0].status = "done";
    call(context, "resetFinalDraft", matches);
    context.qualificationProof = proof;
    context.qualificationDraftStale = Boolean(proof);
    const originalMatches = context.finalMatches;
    const originalDrafts = context.finalScoreDrafts;
    await call(context, "handleQualificationRevalidation");
    assert.equal(context.finalMatches, originalMatches, "revalidation preserves played final scores");
    assert.equal(context.finalScoreDrafts, originalDrafts, "revalidation preserves drafts");
    assert.equal(call(context, "qualificationProofStatus"), "current");
    assert.equal(elements.qualificationProofBanner.hidden, true);
    assert.equal(context.bracketPublishPending, true, "proof-only changes require publication");
    assert.equal(elements.publishBracketBtn.disabled, false, "successful revalidation unlocks publication");
    assert.equal(context.qualificationProof, proof, "stored proof is not overwritten before publishing");
    await call(context, "handlePublishBracket");
    assert.equal(calls.at(-1)[0], "publishFinalBracket");
    assert.equal(calls.at(-1)[1][4].expectedPrelimFingerprint, "f".repeat(64));
    assert.equal(context.qualificationProof.status, "current");
    assert.deepEqual(errors, []);
  }
}

async function testRealFinalPlayStillBlocksReset() {
  const { context, calls, toasts, confirmations } = finalUiFixture();
  await call(context, "onGenerateBracket");
  const originalMatches = context.finalMatches;
  const assignment = { id: "final:men:r1m0", matchType: "final", divisionId: "men", publicStatus: "scheduled" };
  context.reviewAssignments.push(assignment);
  context.reviewWorkflows.set(assignment.id, { draftState: "idle", draft: { sets: [{ a: 0, b: 0 }] } });
  assert.equal(call(context, "qualificationHasFinalPlay"), false, "scheduled, untouched finals do not count as played");
  for (const record of [
    { draftState: "editing" },
    { draftState: "submitted" },
    { draftState: "rejected" },
    { draftRevision: 1 },
    { submissionVersion: 1 },
    { draft: { sets: [{ a: 1, b: 0 }] } },
    { submittedSnapshot: { sets: [{ a: 0, b: 1 }] } },
  ]) {
    context.reviewWorkflows.set(assignment.id, record);
    const beforeCalls = calls.length;
    const beforeConfirmations = confirmations.length;
    await call(context, "handleClearBracket");
    assert.equal(context.finalMatches, originalMatches);
    assert.equal(calls.length, beforeCalls, "no deletion request is sent for real final records");
    assert.equal(confirmations.length, beforeConfirmations);
    assert.match(toasts.at(-1), /본선 점수 입력·제출 기록/);
  }
  context.reviewWorkflows.delete(assignment.id);
  assignment.attemptCount = 1;
  assert.equal(call(context, "qualificationHasFinalPlay"), true);
  assignment.attemptCount = 0;
  context.finalMatches[0].officialRevision = 1;
  assert.equal(call(context, "qualificationHasFinalPlay"), true);
  context.finalMatches[0].officialRevision = 0;
  context.finalScoreDrafts.set(context.finalMatches[0].id, { sets: finishedSets });
  assert.equal(call(context, "qualificationHasFinalPlay"), true, "local final score drafts are still protected");
}

async function testInvalidQualificationAndFailedResetStayBlocked() {
  const { context, elements, calls, errors } = finalUiFixture();
  await call(context, "onGenerateBracket");
  context.qualificationDraftStale = true;
  call(context, "updateQualificationProofUi");
  call(context, "updateBracketPublishBar");
  assert.equal(elements.qualificationProofBanner.hidden, false);
  assert.equal(elements.publishBracketBtn.disabled, true);
  const beforeCalls = calls.length;
  await call(context, "handlePublishBracket");
  assert.equal(calls.length, beforeCalls, "source changes still block publication");

  context.qualificationDraftStale = false;
  const originalMatches = structuredClone(context.finalMatches);
  context.finalMatches[0].teamB = { id: "c", name: "C" };
  await call(context, "handleQualificationRevalidation");
  call(context, "updateBracketPublishBar");
  assert.equal(elements.qualificationProofBanner.hidden, false, "invalid entrants still warn after revalidation");
  assert.equal(elements.publishBracketBtn.disabled, true);
  assert.equal(call(context, "qualificationProofStatus"), "unverified");

  call(context, "resetFinalDraft", originalMatches);
  context.qualificationProof = { status: "current", fingerprint: "f".repeat(64) };
  const retainedMatches = context.finalMatches;
  context.confirm = () => false;
  await call(context, "handleClearBracket");
  assert.equal(context.finalMatches, retainedMatches, "cancelled reset preserves the bracket");
  context.confirm = () => true;
  context.adminWorkflowCallable = async () => { throw new Error("Server rejected concurrent final input"); };
  await call(context, "handleClearBracket");
  assert.equal(context.finalMatches, retainedMatches, "server rejection never clears local records");
  assert.equal(context.qualificationProof.status, "current");
  assert.equal(errors.length, 1);
}

async function testSubmittedFinalStagingAndPublicationErrors() {
  const { context, elements, calls } = finalUiFixture();
  await call(context, "onGenerateBracket");
  const matchId = context.finalMatches[0].id;
  const key = `final:men:${matchId}`;
  context.reviewWorkflows.set(key, { submissionVersion: 3 });
  const workflow = {
    draftState: "submitted", submissionVersion: 1, submission: { version: 1 },
    submittedSnapshot: { sets: [{ b: 8, a: 10 }, { b: 8, a: 10 }, { a: 0, b: 0 }] },
  };
  call(context, "stageSubmittedFinalReview", { matchId, divisionId: "men" }, workflow);
  const draft = context.finalScoreDrafts.get(matchId);
  assert.equal(draft.expectedSubmissionVersion, 1, "capture the reviewed version, not a later subscription");
  assert.deepEqual(jsonValue(draft.sets), finishedSets, "capture canonical played sets");
  context.finalMatches[0].sets[0].a = 11;
  assert.equal(draft.sets[0].a, 10, "bracket display and publication draft do not alias");
  assert.equal(workflow.submittedSnapshot.sets[0].a, 10, "staging never mutates submitted evidence");

  const rejected = { code: "functions/failed-precondition", details: { reason: "final_submission_changed" } };
  const beforeCalls = calls.length;
  context.publishFinalBracket = async () => { throw rejected; };
  await call(context, "handlePublishBracket");
  const message = call(context, "finalPublicationErrorMessage", rejected);
  assert.equal(elements.qualificationProofBanner.textContent, message, "publication error appears once");
  assert.match(message, /최신 제출/);
  assert.match(elements.qualificationProofBanner.className, /is-review/);
  assert.equal(context.finalScoreDrafts.get(matchId), draft, "failed publication preserves the reviewed draft");
  assert.equal(context.bracketPublishPending, true);
  assert.equal(calls.length, beforeCalls);

  const invalid = { ...workflow, submission: { version: 2 } };
  call(context, "stageSubmittedFinalReview", { matchId, divisionId: "men" }, invalid);
  assert.equal(context.finalScoreDrafts.get(matchId), draft, "inconsistent submission metadata cannot replace a reviewed draft");
}

function testFinalStructureProjection() {
  const context = loadAdminFunctions(["finalStructureMatch"]);
  const root = {
    id: "semi-a", round: 1, roundLabel: "준결승", index: 0,
    teamA: { id: "a", name: "A" }, teamB: { id: "b", name: "B" },
    teamASource: { type: "fixedTeam", teamId: "a" },
    teamBSource: { type: "fixedTeam", teamId: "b" },
    status: "done", byeCandidate: null, nextMatchId: "final", nextSlot: "A",
    officialCurrent: true, officialRevision: 2, lastTransitionId: "approved",
    sets: finishedSets, winnerTeam: { id: "a", name: "A" }, winnerSide: "A",
    pointsForA: 20, attemptCount: 1, officialSnapshot: { sets: finishedSets },
    serverMetadata: { revision: 3 },
  };
  const before = structuredClone(root);
  const projected = call(context, "finalStructureMatch", root);
  assert.deepEqual(jsonValue(projected), {
    id: "semi-a", round: 1, roundLabel: "준결승", index: 0,
    teamA: { id: "a", name: "A" }, teamB: { id: "b", name: "B" },
    teamASource: { type: "fixedTeam", teamId: "a" },
    teamBSource: { type: "fixedTeam", teamId: "b" },
    status: "pending", byeCandidate: null, nextMatchId: "final", nextSlot: "A",
  }, "server result and workflow fields never re-enter the structure payload");
  projected.teamA.name = "Changed locally";
  assert.deepEqual(root, before, "projection does not mutate or alias saved server results");
  const final = call(context, "finalStructureMatch", {
    ...root, id: "final", round: 2, nextMatchId: null, nextSlot: "A",
  });
  assert.equal(final.teamA, null);
  assert.equal(final.teamB, null);
  assert.equal(final.teamASource, null);
  assert.equal(final.teamBSource, null);
  assert.equal(final.nextSlot, null);
  const bye = call(context, "finalStructureMatch", {
    ...root, status: "bye", teamB: null, teamBSource: null,
  });
  assert.equal(bye.status, "bye", "confirmed byes remain structural outcomes");
}

async function testRetractedBracketLocksAndRecovery() {
  const { context, elements, calls, toasts } = finalUiFixture();
  await call(context, "onGenerateBracket");
  const matches = structuredClone(context.finalMatches);
  Object.assign(matches[0], { officialRevision: 1, officialCurrent: false, sets: [], status: "pending" });
  call(context, "resetFinalDraft", matches);
  context.qualificationProof = { status: "current", fingerprint: "f".repeat(64) };
  const id = context.finalMatches[0].id;
  const before = jsonValue(context.finalMatches);
  assert.equal(finalSlotsLocked(context.finalMatches), true, "retracted approvals still lock slots");
  assert.deepEqual(swapFinalSeedSlots(context.finalMatches, { matchId: id, side: "A" }, { matchId: id, side: "B" }),
    { ok: false, reason: "ALREADY_STARTED" });
  await call(context, "handleBracketSlotSwap", { matchId: id, side: "A" }, { matchId: id, side: "B" });
  assert.deepEqual(jsonValue(context.finalMatches), before, "UI handler and bracket helper both preserve recorded orientation");

  // A draft already altered by an older screen can recover without a failing server write.
  const swapLocal = () => {
    const match = context.finalMatches[0];
    [match.teamA, match.teamB] = [match.teamB, match.teamA];
    [match.teamASource, match.teamBSource] = [match.teamBSource, match.teamASource];
    context.bracketPublishPending = true;
  };
  swapLocal();
  call(context, "updateBracketPublishBar");
  assert.equal(elements.publishBracketBtn.textContent, "저장된 대진으로 복구");
  const beforeCalls = calls.length;
  context.confirm = () => false;
  await call(context, "handlePublishBracket");
  assert.equal(call(context, "hasRecordedFinalStructureChanges"), true, "cancelled recovery leaves local changes intact");
  context.confirm = () => true;
  await call(context, "handlePublishBracket");
  assert.deepEqual(jsonValue(context.finalMatches), before);
  assert.equal(calls.length, beforeCalls, "recovery does not publish or rewrite official results");
  assert.equal(context.bracketPublishPending, false);
  assert.equal(call(context, "hasRecordedFinalStructureChanges"), false);

  swapLocal();
  context.finalScoreDrafts.set(id, { matchId: id, sets: finishedSets });
  const scoredDraft = context.finalScoreDrafts.get(id);
  await call(context, "handlePublishBracket");
  assert.equal(context.finalScoreDrafts.get(id), scoredDraft, "ambiguous score orientation is not silently reversed or discarded");
  assert.equal(call(context, "hasRecordedFinalStructureChanges"), true);
  assert.equal(calls.length, beforeCalls);
  assert.match(toasts.at(-1), /자동으로 복구하지 않았습니다/);

  call(context, "resetFinalDraft", matches);
  const source = context.finalMatches[0].teamASource;
  context.finalMatches[0].teamASource = Object.fromEntries(Object.entries(source).reverse());
  assert.equal(call(context, "hasRecordedFinalStructureChanges"), false, "object key order is not a bracket change");
  context.finalMatches[0].officialRevision = 0;
  context.authoritativeFinalMatches[0].officialRevision = 0;
  context.reviewAssignments.push({ id: `final:men:${id}`, matchType: "final", divisionId: "men" });
  context.reviewWorkflows.set(`final:men:${id}`, { draftState: "editing", draftRevision: 1 });
  const activeBefore = jsonValue(context.finalMatches);
  await call(context, "handleBracketSlotSwap", { matchId: id, side: "A" }, { matchId: id, side: "B" });
  assert.deepEqual(jsonValue(context.finalMatches), activeBefore, "private recorder activity also locks displayed slots");
}

async function testAdministratorReentryAfterCorrection() {
  const { context, calls } = finalUiFixture();
  await call(context, "onGenerateBracket");
  const matches = structuredClone(context.finalMatches);
  Object.assign(matches[0], { officialRevision: 1, officialCurrent: false, sets: [], status: "pending" });
  call(context, "resetFinalDraft", matches);
  const matchId = matches[0].id;
  const key = `final:men:${matchId}`;
  const assignment = { id: key, matchType: "final", divisionId: "men", publicStatus: "replay_required" };
  const workflow = {
    draftState: "rejected", lock: null, submissionVersion: 2, officialRevision: 1,
    submittedSnapshot: { sets: finishedSets },
  };
  context.reviewAssignments.push(assignment);
  context.reviewWorkflows.set(key, workflow);
  let modal;
  context.openScoreModal = (options) => { modal = options; };
  assert.equal(call(context, "isFinalScoreStagingBlocked", context.finalMatches[0]), false);
  call(context, "openFinalScoreModal", context.finalMatches[0]);
  assert.ok(modal, "reentry waiting opens the administrator score modal");
  const correctedSets = [{ a: 5, b: 10 }, { a: 10, b: 8 }, { a: 4, b: 7 }];
  assert.equal(modal.reasonRequired, true, "an approved final score can only be changed with a reason field in the modal");
  await assert.rejects(modal.onSave(correctedSets, ""), /정정 사유가 필요/, "saving without a reason is refused");
  await assert.rejects(modal.onSave(correctedSets, "   "), /정정 사유가 필요/, "a blank reason is refused");
  assert.equal(context.finalScoreDrafts.size, 0, "a refused save leaves no draft behind");
  await modal.onSave(correctedSets, "승인 취소 후 관리자 재입력");
  const draft = context.finalScoreDrafts.get(matchId);
  assert.equal(draft.expectedSubmissionVersion, 2);
  assert.equal(draft.reason, "승인 취소 후 관리자 재입력");
  assert.deepEqual(jsonValue(draft.sets), correctedSets);
  assert.deepEqual(workflow.submittedSnapshot.sets, finishedSets, "manual reentry does not mutate original submission evidence");
  await call(context, "handlePublishBracket");
  assert.equal(calls.at(-1)[0], "publishFinalBracket");
  assert.deepEqual(calls.at(-1)[1][3][0].sets, correctedSets);
  assert.equal(calls.at(-1)[1][3][0].expectedSubmissionVersion, 2);

  for (const state of [
    { draftState: "editing", lock: null },
    { draftState: "submitted", lock: null },
    { draftState: "rejected", lock: { token: "active-recorder" } },
  ]) {
    context.reviewWorkflows.set(key, { ...workflow, ...state });
    modal = null;
    call(context, "openFinalScoreModal", context.finalMatches[0]);
    assert.equal(modal, null, "actual recorder ownership or pending review remains protected");
  }
  context.reviewWorkflows.set(key, workflow);
  call(context, "openFinalScoreModal", context.finalMatches[0]);
  context.reviewWorkflows.set(key, { ...workflow, submissionVersion: 3 });
  await assert.rejects(modal.onSave(correctedSets, "승인 취소 후 관리자 재입력"), /제출 기록이 바뀌었습니다/);
  assert.equal(context.finalScoreDrafts.size, 0, "a changed submission version cannot be silently adopted");
  context.reviewWorkflows.set(key, workflow);
  call(context, "openFinalScoreModal", context.finalMatches[0]);
  context.reviewWorkflows.set(key, { ...workflow, draftState: "editing", lock: { token: "new-claim" } });
  await assert.rejects(modal.onSave(correctedSets, "승인 취소 후 관리자 재입력"), /입력 또는 제출이 시작되었습니다/);
  assert.equal(context.finalScoreDrafts.size, 0, "recorder input starting after the modal opens prevents overwrite");
}

// 항목 2 회귀: 공개·검증이 끝난 본선은 부문 전환·새로고침 뒤에도 서버 기록(finalQualification)으로
// current 상태여야 하며, 기록이 없거나 stale이면 경고가 그대로 나와야 한다.
function testPublishedProofSurvivesDivisionSwitchAndReload() {
  const fingerprint = "a".repeat(64);
  const proof = (status) => ({
    status,
    fingerprint,
    participantIds: ["a", "b"],
    tieSelections: { g1: [] },
    reason: "published",
  });
  const published = [{ id: "m_r1_0", round: 1, teamA: { id: "a" }, teamB: { id: "b" }, status: "pending" }];
  const toasts = [];
  const elements = {
    qualifyPerGroupInput: { value: "" },
    bracketTitle: { textContent: "" },
  };
  const context = loadAdminFunctions([
    "switchActiveDivision",
    "syncQualificationProofFromTournamentInfo",
    "qualificationProofStatus", "qualificationPostFinalCorrected",
    "qualificationHasFinalBracket",
    "finalMutationAllowed",
  ], {
    activeDivision: "men",
    DIVISION_LABELS: { men: "남자부", women: "여자부" },
    tournamentInfo: {
      name: "대회",
      qualifyPerGroup: { men: 2, women: 1 },
      finalQualification: { men: proof("current"), women: proof("current") },
    },
    bracketPublishPending: false,
    bracketPublishInFlight: false,
    seedSelection: [],
    seedAutoMode: true,
    qualificationState: null,
    qualificationServerState: null,
    qualificationServerFingerprint: "",
    qualificationTieSelections: {},
    qualificationProof: proof("current"),
    qualificationRevalidatedLocally: false,
    qualificationSourceInitialized: true,
    qualificationSourceKey: "x",
    qualificationDraftStale: false,
    qualificationReplacement: null,
    qualificationPreparationError: "",
    qualificationCountInputOverride: null,
    finalByeSelection: null,
    ringSelection: null,
    finalMatches: [],
    authoritativeFinalMatches: [],
    document: {
      body: { dataset: {} },
      getElementById: (id) => elements[id],
      querySelectorAll: () => [],
    },
    syncDivisionThemeScopes: () => {},
    refreshActiveDivisionData: () => {},
    // 구독이 새 부문의 공개본을 돌려주는 상황을 흉내 낸다.
    rebindFinalMatches: () => {
      context.authoritativeFinalMatches = structuredClone(published);
      context.finalMatches = structuredClone(published);
    },
    divisionLabel: () => (context.activeDivision === "men" ? "남자부" : "여자부"),
    confirm: () => true,
    showToast: (message) => toasts.push(message),
  });
  assert.equal(call(context, "switchActiveDivision", "women"), true);
  assert.equal(context.activeDivision, "women");
  assert.equal(context.qualificationProof?.status, "current",
    "division switch reloads the new division's persisted proof instead of leaving it null");
  assert.equal(context.qualificationServerFingerprint, fingerprint,
    "division switch restores the persisted server fingerprint");
  assert.equal(call(context, "qualificationProofStatus"), "current",
    "a published, verified final is not reported as unverified after switching divisions");

  // 동일한 전환에서 서버 기록이 없으면 경고가 그대로 나온다.
  delete context.tournamentInfo.finalQualification.men;
  assert.equal(call(context, "switchActiveDivision", "men"), true);
  assert.equal(context.qualificationProof, null);
  assert.equal(call(context, "qualificationProofStatus"), "unverified",
    "a final without a persisted proof still warns");

  // stale 기록도 그대로 stale로 보인다.
  context.tournamentInfo.finalQualification.women = proof("stale");
  assert.equal(call(context, "switchActiveDivision", "women"), true);
  assert.equal(call(context, "qualificationProofStatus"), "stale");
  assert.equal(call(context, "switchActiveDivision", "women"), false, "switching to the active division is a no-op");
}

// 7번 캡처 회귀: 화면을 새로 열어 qualificationDraftStale 이 false 여도 서버 기록이 stale 이면
// 안내문이 가리키는 '새 순위로 대진 다시 만들기' 버튼을 만들 수 있어야 한다.
function testReplacementAvailableAfterReload() {
  const bracket = [{ id: "m_r1_0", round: 1, teamA: { id: "a" }, teamB: { id: "b" }, status: "pending" }];
  const context = loadAdminFunctions([
    "qualificationReplacementAvailable", "qualificationProofStatus", "qualificationPostFinalCorrected",
    "qualificationHasFinalBracket", "qualificationHasFinalPlay",
  ], {
    activeDivision: "men",
    qualificationDraftStale: false,
    qualificationRevalidatedLocally: false,
    qualificationServerFingerprint: "",
    qualificationServerState: null,
    qualificationTieSelections: {},
    qualificationProof: { status: "stale", fingerprint: "f".repeat(64) },
    finalMatches: structuredClone(bracket),
    authoritativeFinalMatches: structuredClone(bracket),
    finalScoreDrafts: new Map(),
    reviewAssignments: [],
    reviewWorkflows: new Map(),
  });
  assert.equal(call(context, "qualificationReplacementAvailable"), true,
    "a reloaded page with a stale server proof still offers replacement before final play");
  context.qualificationProof = { status: "current", fingerprint: "f".repeat(64) };
  assert.equal(call(context, "qualificationReplacementAvailable"), false,
    "a current proof does not offer replacement");
  context.qualificationProof = { status: "stale", fingerprint: "f".repeat(64) };
  context.finalScoreDrafts.set("m_r1_0", { sets: [] });
  assert.equal(call(context, "qualificationReplacementAvailable"), false,
    "replacement is never offered after final play");
}

// 항목 2 회귀: 대회 문서(qualifyPerGroup)가 조·팀·예선보다 늦게 도착해도 첫 기준선을 빈 값으로
// 잡아 멀쩡한 본선을 'stale'로 오판하지 않아야 한다.
function testLateTournamentInfoDoesNotStaleAPublishedFinal() {
  const fixture = qualificationFixture();
  const context = loadAdminFunctions([
    "qualificationSnapshotForCurrentData",
    "qualificationSourceChanged",
    "qualificationHasFinalBracket",
    "qualificationPostFinalCorrected",
    "qualificationHasFinalPlay",
  ], {
    activeDivision: "men",
    tournamentInfo: {},
    allGroups: fixture.groups,
    allTeams: fixture.teams,
    allPrelimMatches: fixture.matches,
    finalMatches: [{ id: "m_r1_0" }],
    authoritativeFinalMatches: [{ id: "m_r1_0" }],
    bracketPublishPending: false,
    qualificationInfoLoaded: false,
    qualificationGroupsLoaded: true,
    qualificationTeamsLoaded: true,
    qualificationMatchesLoaded: true,
    qualificationSourceInitialized: false,
    qualificationSourceKey: "",
    qualificationDraftStale: false,
    qualificationRevalidatedLocally: false,
    qualificationProof: null,
  });
  assert.equal(call(context, "qualificationSourceChanged"), false, "collections before tournament info only set a provisional key");
  assert.equal(context.qualificationSourceInitialized, false);
  context.tournamentInfo = { qualifyPerGroup: { men: 2 } };
  context.qualificationInfoLoaded = true;
  assert.equal(call(context, "qualificationSourceChanged"), false, "first complete load initialises the baseline");
  assert.equal(context.qualificationDraftStale, false,
    "late tournament info does not mark a published final as stale");
  context.tournamentInfo = { qualifyPerGroup: { men: 3 } };
  assert.equal(call(context, "qualificationSourceChanged"), true, "real later changes still invalidate the final");
  assert.equal(context.qualificationDraftStale, true);
}

// 항목 1: 본선 공개 상태 문구가 기록관 입력 가능 여부를 분명히 알린다.
function testFinalPublicationStatusCopy() {
  const context = loadAdminFunctions(["finalPublicationStatus"]);
  const status = (input) => jsonValue(call(context, "finalPublicationStatus", {
    hasBracket: true, published: false, pending: false, conflict: false, structureChanged: false,
    needsReview: false, byeProblem: "", stagedScores: 0, ...input,
  }));
  const draft = status({ pending: true });
  assert.equal(draft.state, "pending");
  assert.equal(draft.title, "공개 전 — 기록관이 점수를 입력할 수 없음");
  assert.match(draft.message, /기록관에게 본선 경기가 없/);
  const staged = status({ pending: true, published: true, stagedScores: 2 });
  assert.match(staged.message, /본선 점수 2건은 공개해야 공식 결과/);
  assert.match(staged.message, /다음 라운드/);
  assert.match(staged.message, /본선 탭에서 ‘관객·기록관 화면에 공개’를 눌러야 다음 경기가 열립니다/);
  const live = status({ published: true });
  assert.equal(live.state, "published");
  assert.equal(live.title, "공개됨 — 기록관 입력 가능");
  const blocked = status({ pending: true, byeProblem: "부전승 추첨 필요" });
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.message, /부전승 추첨 필요/);
  assert.equal(status({ pending: true, conflict: true }).state, "blocked");
  assert.equal(status({ hasBracket: false }).state, "none");
}

// 항목 3: 3개 조 · 6팀 · 8강 → 조 1위 3팀 중 2팀 부전승 추첨을 기록해 대진표를 만들고 공개한다.
function byeLotteryFixture() {
  const groups = ["A", "B", "C"].map((name) => ({ id: name, division: "women", matchMode: "roundrobin" }));
  const teams = groups.flatMap((group) => [1, 2, 3].map((rank) => ({
    id: `${group.id}${rank}`, division: "women", groupId: group.id, name: `${group.id}조${rank}`,
  })));
  const won = [{ a: 10, b: 5 }, { a: 10, b: 5 }];
  const matches = groups.flatMap((group) => [
    [`${group.id}1`, `${group.id}2`], [`${group.id}1`, `${group.id}3`], [`${group.id}2`, `${group.id}3`],
  ].map(([teamA, teamB], index) => ({
    id: `${group.id}-${index}`, division: "women", groupId: group.id, teamA, teamB,
    sets: won, status: "done", officialCurrent: true, officialRevision: 1,
  })));
  const state = computeQualificationState(buildQualificationSnapshot({
    division: "women", qualifyPerGroup: 2, groups, teams, matches,
  }));
  return { groups, teams, matches, state };
}

async function testByeLotteryGeneratesAndPublishes() {
  const { teams, state } = byeLotteryFixture();
  assert.equal(state.ready, true);
  const toasts = [];
  const calls = [];
  const elements = Object.fromEntries([
    "qualificationProofBanner", "bracketPublishBar", "bracketPublishMsg", "publishBracketBtn", "bracketPublishTitle",
  ].map((id) => [id, { style: {}, dataset: {}, classList: { toggle() {} } }]));
  const context = loadAdminFunctions([
    "cloneFinalMatches", "finalBaselineDescriptor", "resetFinalDraft", "finalMutationAllowed",
    "qualificationHasFinalBracket", "qualificationHasFinalPlay", "finalEntrantIds",
    "qualificationProofStatus", "qualificationPostFinalCorrected", "qualificationBlockerCode", "qualificationBlockerMessage",
    "qualificationStateBlockers", "qualificationStateHasStructuralBlockers",
    "qualificationStateReadyForSelection", "qualificationGuidanceForBlockers",
    "qualificationGroupTeamIds", "canonicalQualificationTieSelections",
    "qualificationSelectionIds", "qualificationSeedOrder", "syncQualificationSelection",
    "qualificationSelectionValidation", "qualificationValidationMessages",
    "qualificationPublishContext", "prepareFinalQualificationFromServer",
    "updateQualificationProofUi", "onGenerateBracket", "updateBracketPublishBar",
    "handlePublishBracket", "finalStructureMatch", "hasRecordedFinalStructureChanges",
    "finalByeLotteryState", "syncFinalByeSelection", "finalByeSelectionComplete", "finalByeSelectionProblem",
    "finalPublicationStatus", "updateFinalPublicationIndicators",
  ], {
    activeDivision: "women",
    DIVISION_LABELS: { men: "남자부", women: "여자부" },
    qualificationState: state,
    qualificationStateForCurrentData: () => state,
    qualificationProof: null,
    qualificationRevalidatedLocally: false,
    qualificationServerFingerprint: "",
    qualificationServerState: null,
    qualificationTieSelections: {},
    qualificationReplacement: null,
    qualificationDraftStale: false,
    qualificationPreparationInFlight: false,
    qualificationPreparationError: "",
    finalByeSelection: null,
    seedSelection: [],
    seedAutoMode: true,
    finalMatches: [],
    authoritativeFinalMatches: [],
    finalDraftBaseline: [],
    finalScoreDrafts: new Map(),
    bracketPublishPending: false,
    bracketPublishConflict: false,
    bracketPublishInFlight: false,
    reviewAssignments: [],
    reviewWorkflows: new Map(),
    document: { getElementById: (id) => elements[id], querySelector: () => null },
    teamName: (id) => teams.find((team) => team.id === id)?.name || id,
    divisionLabel: () => "여자부",
    confirm: () => true,
    showToast: (message) => toasts.push(message),
    reportError: (action, error) => { throw error; },
    updateQualificationStructureControls: () => {},
    adminWorkflowCallable: async (name, payload) => {
      calls.push([name, jsonValue(payload)]);
      return { data: { fingerprint: "f".repeat(64), state } };
    },
    publishFinalBracket: async (...args) => {
      calls.push(["publishFinalBracket", jsonValue(args)]);
      return { matches: args[2] };
    },
  });
  context.renderFinalTeamPicker = () => {
    call(context, "syncQualificationSelection", state);
    call(context, "updateQualificationProofUi");
    call(context, "updateBracketPublishBar");
  };
  context.renderFinalBracket = () => call(context, "updateBracketPublishBar");
  context.renderFinalTeamPicker();
  assert.deepEqual([...context.seedSelection].sort(), ["A1", "A2", "B1", "B2", "C1", "C2"]);
  const lottery = jsonValue(call(context, "finalByeLotteryState", state, context.seedSelection));
  assert.deepEqual(lottery.candidateIds, ["A1", "B1", "C1"], "all three group winners are BYE candidates");
  assert.equal(lottery.slots, 2);
  assert.equal(lottery.required, true);

  await call(context, "onGenerateBracket");
  assert.equal(context.finalMatches.length, 0, "generation is blocked until the BYE lottery is recorded");
  assert.match(toasts.at(-1), /부전승 후보 3팀 중 2팀을 추첨/);

  // 현장 추첨: B조 1위와 C조 1위가 부전승, A조 1위는 1라운드 경기.
  context.finalByeSelection = { candidateIds: ["A1", "B1", "C1"], selectedIds: ["B1", "C1"], reason: "감독자 회의 제비뽑기" };
  context.seedSelection = [];
  context.renderFinalTeamPicker();
  await call(context, "onGenerateBracket");
  const roots = context.finalMatches.filter((match) => match.round === 1);
  assert.equal(roots.length, 4, "six finalists use an eight-slot bracket");
  const byeIds = roots.filter((match) => match.byeCandidate).map((match) => match.byeCandidate.team.id).sort();
  assert.deepEqual(byeIds, ["B1", "C1"], "lottery winners receive the two BYE slots");
  const a1Match = roots.find((match) => match.teamA?.id === "A1" || match.teamB?.id === "A1");
  assert.ok(a1Match && a1Match.teamA && a1Match.teamB, "the remaining group winner plays a round-one match");
  roots.filter((match) => match.teamA && match.teamB).forEach((match) => {
    assert.notEqual(match.teamA.id[0], match.teamB.id[0], "round-one matches avoid same-group pairs");
  });
  assert.equal(elements.publishBracketBtn.disabled, false);
  assert.equal(elements.bracketPublishTitle.textContent, "공개 전 — 기록관이 점수를 입력할 수 없음");

  await call(context, "handlePublishBracket");
  const publish = calls.find(([name]) => name === "publishFinalBracket");
  assert.ok(publish, "the bracket is published");
  assert.deepEqual(publish[1][4].byeSelection, {
    candidateIds: ["A1", "B1", "C1"],
    selectedIds: ["B1", "C1"],
    reason: "감독자 회의 제비뽑기",
  }, "the lottery record is sent with the publication for server validation");
  assert.equal(context.bracketPublishPending, false);
  assert.equal(elements.bracketPublishTitle.textContent, "공개됨 — 기록관 입력 가능");

  // 추첨과 다른 부전승 배치는 공개 전에 막힌다.
  context.finalByeSelection = { candidateIds: ["A1", "B1", "C1"], selectedIds: ["A1", "B1"], reason: "오기록" };
  context.bracketPublishPending = true;
  const publishCount = calls.filter(([name]) => name === "publishFinalBracket").length;
  await call(context, "handlePublishBracket");
  assert.equal(calls.filter(([name]) => name === "publishFinalBracket").length, publishCount);
  assert.match(toasts.at(-1), /부전승 자리가 추첨 결과와 다릅니다/);
  assert.equal(elements.publishBracketBtn.disabled, true);
}

async function runQualificationUiSuite() {
  testPublishedProofSurvivesDivisionSwitchAndReload();
  testLateTournamentInfoDoesNotStaleAPublishedFinal();
  testFinalPublicationStatusCopy();
  testReplacementAvailableAfterReload();
  await testByeLotteryGeneratesAndPublishes();
  testActualSourceInvalidationAndForeignRecords();
  testActualSelectionState();
  await testActualPreparationPublishContextAndCount();
  await testGeneratedBracketWarningsAndReset();
  await testRevalidationCanActuallyPublish();
  await testRealFinalPlayStillBlocksReset();
  await testInvalidQualificationAndFailedResetStayBlocked();
  await testSubmittedFinalStagingAndPublicationErrors();
  testFinalStructureProjection();
  await testRetractedBracketLocksAndRecovery();
  await testAdministratorReentryAfterCorrection();
  console.log("qualification UI fixtures passed");
}

await runQualificationUiSuite();

export {
  runQualificationUiSuite,
  extractFunctionSource,
  loadAdminFunctions,
};

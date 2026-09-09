import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  buildQualificationSnapshot,
  computeQualificationState,
} from "./match-logic.js";

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
    qualificationGroupsLoaded: true,
    qualificationTeamsLoaded: true,
    qualificationMatchesLoaded: true,
    qualificationSourceInitialized: false,
    qualificationSourceKey: "",
    qualificationDraftStale: false,
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
  ], {
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
  ], {
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

async function runQualificationUiSuite() {
  testActualSourceInvalidationAndForeignRecords();
  testActualSelectionState();
  await testActualPreparationPublishContextAndCount();
  console.log("qualification UI fixtures passed");
}

await runQualificationUiSuite();

export {
  runQualificationUiSuite,
  extractFunctionSource,
  loadAdminFunctions,
};

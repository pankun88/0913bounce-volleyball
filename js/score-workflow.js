const READY = 'ready';
const ACTIVE_STATUS = 'in_progress';
const NORMAL_STATUS = 'scheduled';

/**
 * 코트 배정 초안을 편집하는 동안 새 대진이 생성돼도 기존 선택을 보존하면서
 * 새 경기를 초안에 합친다. 공식 기록이 있는 경기는 서버 배정이 있을 때만 넣는다.
 */
export function reconcilePlannerAssignments(currentAssignments, matchOptions, persistedAssignments = []) {
  const persisted = new Map(persistedAssignments.map((assignment) => [
    assignment.matchKey || assignment.id,
    { ...assignment, matchKey: assignment.matchKey || assignment.id },
  ]));
  const merged = currentAssignments.flatMap((assignment) => {
    const option = matchOptions.find((item) => item.matchKey === assignment.matchKey);
    const saved = persisted.get(assignment.matchKey);
    return option ? [{
      ...assignment,
      ...option,
      ...(saved && Object.hasOwn(saved, 'publicStatus') ? { publicStatus: saved.publicStatus } : {}),
      matchKey: option.matchKey,
    }] : [];
  });
  const mergedKeys = new Set(merged.map((assignment) => assignment.matchKey));

  matchOptions.forEach((option) => {
    if (mergedKeys.has(option.matchKey)) return;
    const saved = persisted.get(option.matchKey);
    if (!saved && option.hasOfficialHistory) return;
    merged.push({
      ...option,
      ...(saved || {}),
      matchKey: option.matchKey,
      courtId: saved?.courtId || null,
    });
    mergedKeys.add(option.matchKey);
  });
  return merged;
}

const PLANNER_PHASES = new Set(['all', 'prelim', 'final']);

function normalizePlannerPhase(phase) {
  return PLANNER_PHASES.has(phase) ? phase : 'all';
}

function plannerMatchKey(item) {
  return item?.matchKey || item?.id || null;
}

function plannerEntriesByKey(items) {
  if (items instanceof Map) {
    return new Map(items);
  }
  if (Array.isArray(items)) {
    return new Map(items
      .map((item) => [plannerMatchKey(item), item])
      .filter(([key]) => key));
  }
  if (items && typeof items === 'object') {
    return new Map(Object.entries(items));
  }
  return new Map();
}

export function plannerPhaseMatches(option, phase = 'all') {
  const normalizedPhase = normalizePlannerPhase(phase);
  return normalizedPhase === 'all' || option?.matchType === normalizedPhase;
}

/**
 * 현재 대진 상태에서 완료 경기로 접어둘 수 있는지 판정한다.
 * officialRevision만 남은 과거 결과나 잠금·재입력 상태는 완료로 취급하지 않는다.
 */
export function isPlannerMatchCompleted(option, assignment, workflow = {}) {
  if (!assignment || workflow?.lock) return false;
  if (assignment.publicStatus !== 'completed') return false;
  return workflow.draftState === 'approved';
}

/**
 * 표시 필터와 무관하게 옵션 배열의 순서를 유지한 채 코트별로 묶는다.
 * 반환된 Map과 배열은 모두 새 컨테이너이며 입력을 정렬하거나 수정하지 않는다.
 */
export function groupPlannerAssignments(options = [], assignments = [], phase = 'all') {
  const assignmentByKey = plannerEntriesByKey(assignments);
  const groups = new Map();
  options.forEach((option) => {
    if (!plannerPhaseMatches(option, phase)) return;
    const assignment = assignmentByKey.get(plannerMatchKey(option));
    const courtId = assignment?.courtId || null;
    if (!groups.has(courtId)) groups.set(courtId, []);
    groups.get(courtId).push(option);
  });
  return groups;
}

function plannerCanonicalCourtEntries(options, assignments) {
  const optionByKey = plannerEntriesByKey(options);
  const assignmentEntries = Array.isArray(assignments)
    ? assignments
    : assignments instanceof Map
    ? [...assignments.entries()].map(([key, assignment]) => (
      plannerMatchKey(assignment) ? assignment : { ...assignment, matchKey: key }
    ))
    : assignments && typeof assignments === 'object'
    ? Object.entries(assignments).map(([key, assignment]) => (
      plannerMatchKey(assignment) ? assignment : { ...assignment, matchKey: key }
    ))
    : [];
  const entries = [];
  const seen = new Set();
  assignmentEntries.forEach((assignment, index) => {
    const key = plannerMatchKey(assignment);
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push({
      key,
      assignment,
      option: optionByKey.get(key) || null,
      sourceIndex: index,
    });
  });
  (Array.isArray(options) ? options : []).forEach((option, index) => {
    const key = plannerMatchKey(option);
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push({
      key,
      assignment: null,
      option,
      sourceIndex: assignmentEntries.length + index,
    });
  });
  return entries;
}

function plannerCourtOrder(entry) {
  const order = Number(entry?.assignment?.courtOrder);
  return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

function plannerAssignmentOrder(assignment) {
  const order = Number(assignment?.courtOrder);
  return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

/**
 * 전체(필터 전) 코트 순서에서 바로 붙은 이웃만 반환한다.
 * 중간 경기가 완료·숨김 상태면 그 너머의 경기로 건너뛰지 않는다.
 */
export function getPlannerVisibleAdjacent(
  options = [],
  assignments = [],
  workflows = new Map(),
  matchKey,
  phase = 'all',
) {
  const assignmentByKey = plannerEntriesByKey(assignments);
  const workflowByKey = plannerEntriesByKey(workflows);
  const entries = plannerCanonicalCourtEntries(options, assignments);
  const current = entries.find((entry) => entry.key === matchKey);
  if (!current?.option || !current.assignment || !plannerPhaseMatches(current.option, phase)) {
    return { previousMatchKey: null, nextMatchKey: null };
  }
  const courtId = current.assignment.courtId || null;
  const siblings = entries
    .filter((entry) => (entry.assignment?.courtId || null) === courtId)
    .sort((left, right) => plannerCourtOrder(left) - plannerCourtOrder(right)
      || left.sourceIndex - right.sourceIndex);
  const currentIndex = siblings.findIndex((entry) => entry.key === matchKey);
  if (currentIndex < 0 || isPlannerMatchCompleted(
    current.option,
    current.assignment,
    workflowByKey.get(matchKey) || {},
  )) {
    return { previousMatchKey: null, nextMatchKey: null };
  }
  const visibleActive = (entry) => Boolean(
    entry?.option
      && plannerPhaseMatches(entry.option, phase)
      && !isPlannerMatchCompleted(
        entry.option,
        entry.assignment || assignmentByKey.get(entry.key),
        workflowByKey.get(entry.key) || {},
      ),
  );
  const previous = siblings[currentIndex - 1];
  const next = siblings[currentIndex + 1];
  return {
    previousMatchKey: visibleActive(previous) ? previous.key : null,
    nextMatchKey: visibleActive(next) ? next.key : null,
  };
}

/**
 * 경기의 코트만 바꾸거나 beforeMatchKey 앞에 삽입한다.
 * beforeMatchKey가 없으면 항상 전체 대상 코트의 진짜 끝에 붙여 필터와 무관한
 * 상대 순서를 보존한다. 입력 배열과 항목은 변경하지 않는다.
 */
export function movePlannerAssignment(assignments = [], matchKey, targetCourtId = null, beforeMatchKey = null) {
  const next = (Array.isArray(assignments) ? assignments : []).map((item) => ({ ...item }));
  const assignment = next.find((item) => plannerMatchKey(item) === matchKey);
  if (!assignment) return next;
  const sourceCourtId = assignment.courtId || null;
  const destinationCourtId = targetCourtId || null;
  if (beforeMatchKey === matchKey) return next;
  const destination = next
    .filter((item) => item !== assignment && (item.courtId || null) === destinationCourtId)
    .sort((left, right) => plannerAssignmentOrder(left) - plannerAssignmentOrder(right));
  const insertionIndex = beforeMatchKey
    ? destination.findIndex((item) => plannerMatchKey(item) === beforeMatchKey)
    : -1;
  destination.splice(insertionIndex < 0 ? destination.length : insertionIndex, 0, assignment);
  assignment.courtId = destinationCourtId;
  destination.forEach((item, index) => { item.courtOrder = index + 1; });
  if (sourceCourtId !== destinationCourtId) {
    next
      .filter((item) => (item.courtId || null) === sourceCourtId)
      .sort((left, right) => plannerAssignmentOrder(left) - plannerAssignmentOrder(right))
      .forEach((item, index) => { item.courtOrder = index + 1; });
  }
  return next;
}

/**
 * 두 코트의 전체 경기 목록을 통째로 교환한다.
 * 표시 필터나 완료 경기 접힘과 무관하게 입력된 모든 배정을 대상으로 하며,
 * 각 코트 안의 기존 courtOrder 순서는 그대로 유지한다. 입력 배열과 항목은
 * 변경하지 않는다.
 */
export function swapPlannerCourts(assignments = [], firstCourtId, secondCourtId) {
  const next = (Array.isArray(assignments) ? assignments : []).map((item) => ({ ...item }));
  const first = firstCourtId || null;
  const second = secondCourtId || null;
  if (!first || !second || first === second) return next;

  const orderedByCourt = (courtId) => next
    .map((assignment, index) => ({ assignment, index }))
    .filter(({ assignment }) => (assignment.courtId || null) === courtId)
    .sort((left, right) => (
      plannerAssignmentOrder(left.assignment) - plannerAssignmentOrder(right.assignment)
        || left.index - right.index
    ))
    .map(({ assignment }) => assignment);
  const firstEntries = orderedByCourt(first);
  const secondEntries = orderedByCourt(second);
  firstEntries.forEach((assignment, index) => {
    assignment.courtId = second;
    assignment.courtOrder = index + 1;
  });
  secondEntries.forEach((assignment, index) => {
    assignment.courtId = first;
    assignment.courtOrder = index + 1;
  });
  return next;
}

/**
 * 표시 가능한 바로 옆 경기와만 순서를 바꾼다. 숨겨진 경기나 완료 경기를
 * 사이에 두고 건너뛰는 결과는 만들지 않는다.
 */
export function movePlannerMatchByOffset(
  options = [],
  assignments = [],
  workflows = new Map(),
  matchKey,
  offset,
  phase = 'all',
) {
  if (offset !== -1 && offset !== 1) {
    return (Array.isArray(assignments) ? assignments : []).map((item) => ({ ...item }));
  }
  const adjacent = getPlannerVisibleAdjacent(options, assignments, workflows, matchKey, phase);
  const targetKey = offset < 0 ? adjacent.previousMatchKey : adjacent.nextMatchKey;
  if (!targetKey) {
    return (Array.isArray(assignments) ? assignments : []).map((item) => ({ ...item }));
  }
  const next = (Array.isArray(assignments) ? assignments : []).map((item) => ({ ...item }));
  const current = next.find((item) => plannerMatchKey(item) === matchKey);
  const target = next.find((item) => plannerMatchKey(item) === targetKey);
  if (!current || !target) return next;
  [current.courtOrder, target.courtOrder] = [target.courtOrder, current.courtOrder];
  return next;
}

function cloneQueue(queue, changes = {}) {
  return {
    ...queue,
    priorityEntries: [...(queue.priorityEntries || [])],
    ...changes,
  };
}

function assignmentFor(assignments, matchKey) {
  const assignment = assignments[matchKey];
  if (!assignment) throw new Error(`Unknown match key: ${matchKey}`);
  return assignment;
}

function workflowFor(workflows, matchKey) {
  return workflows[matchKey] || {};
}

function hasLock(workflow) {
  return Boolean(workflow.lock && workflow.lock.token);
}

function isActive(assignments, workflows, matchKey) {
  if (!matchKey) return false;
  const assignment = assignmentFor(assignments, matchKey);
  if (assignment.publicStatus === 'under_review' || assignment.publicStatus === 'completed') return false;
  return assignment.publicStatus === ACTIVE_STATUS || hasLock(workflowFor(workflows, matchKey));
}

function isNormalEligible(assignments, workflows, priorityKeys, matchKey) {
  if (!matchKey || priorityKeys.has(matchKey)) return false;
  const assignment = assignmentFor(assignments, matchKey);
  const workflow = workflowFor(workflows, matchKey);
  return assignment.publicStatus === NORMAL_STATUS
    && assignment.dependencyReady !== false
    && workflow.draftState !== 'submitted'
    && !hasLock(workflow);
}

function comparePriority(a, b) {
  return a.enqueueSequence - b.enqueueSequence
    || (a.pathDepth || 0) - (b.pathDepth || 0)
    || (a.courtOrder || 0) - (b.courtOrder || 0)
    || a.matchKey.localeCompare(b.matchKey);
}

export function assertQueueOwnership(queue, assignments, workflows) {
  const entries = queue.priorityEntries || [];
  const seen = new Set();
  for (const entry of entries) {
    assignmentFor(assignments, entry.matchKey);
    if (seen.has(entry.matchKey)) throw new Error(`Duplicate priority entry: ${entry.matchKey}`);
    seen.add(entry.matchKey);
    if (!Number.isInteger(entry.enqueueSequence) || entry.enqueueSequence < 0) {
      throw new Error(`Invalid priority sequence: ${entry.matchKey}`);
    }
  }
  if (queue.normalCursorMatchKey && seen.has(queue.normalCursorMatchKey)) {
    throw new Error(`Dual normal/priority ownership: ${queue.normalCursorMatchKey}`);
  }
  if (queue.normalCursorMatchKey
      && !isNormalEligible(assignments, workflows, seen, queue.normalCursorMatchKey)
      && !(assignmentFor(assignments, queue.normalCursorMatchKey).publicStatus === ACTIVE_STATUS
        && workflowFor(workflows, queue.normalCursorMatchKey).draftState !== 'submitted')) {
    throw new Error(`Stale or ineligible normal cursor: ${queue.normalCursorMatchKey}`);
  }
}

export function deriveEligibleNormal(startMatchKey, assignments, workflows, priorityEntries = []) {
  const priorityKeys = new Set(priorityEntries.map((entry) => entry.matchKey));
  const visited = new Set();
  let matchKey = startMatchKey;
  while (matchKey) {
    if (visited.has(matchKey)) throw new Error(`Cyclic court assignment: ${matchKey}`);
    visited.add(matchKey);
    if (isNormalEligible(assignments, workflows, priorityKeys, matchKey)) return matchKey;
    matchKey = assignmentFor(assignments, matchKey).nextCourtMatchKey || null;
  }
  return null;
}

function readyEntries(queue) {
  return (queue.priorityEntries || []).filter((entry) => entry.eligibility === READY).sort(comparePriority);
}

function nextNormalAfter(matchKey, assignments, workflows, priorityEntries) {
  if (!matchKey) return null;
  return deriveEligibleNormal(
    assignmentFor(assignments, matchKey).nextCourtMatchKey || null,
    assignments,
    workflows,
    priorityEntries,
  );
}

/** Canonical projection for every court queue reader and mutation. */
export function selectQueueView(queue, assignments, workflows) {
  assertQueueOwnership(queue, assignments, workflows);
  const entries = queue.priorityEntries || [];
  const ready = readyEntries(queue);
  const current = queue.currentMatchKey;
  const currentEntry = entries.find((entry) => entry.matchKey === current);
  const activeKeys = Object.keys(assignments).filter((matchKey) => isActive(assignments, workflows, matchKey));
  if (activeKeys.length > 1) throw new Error(`Multiple active court matches: ${activeKeys.join(',')}`);
  let currentMatchKey = null;

  if (activeKeys.length) {
    currentMatchKey = activeKeys[0];
  } else if (currentEntry && currentEntry.eligibility === READY) {
    currentMatchKey = current;
  } else if (ready.length) {
    currentMatchKey = ready[0].matchKey;
  } else if (queue.normalCursorMatchKey) {
    currentMatchKey = queue.normalCursorMatchKey;
  }

  const remainingReady = ready.filter((entry) => entry.matchKey !== currentMatchKey);
  let nextMatchKey = remainingReady.length ? remainingReady[0].matchKey : null;
  if (!nextMatchKey) {
    if (currentEntry || entries.some((entry) => entry.matchKey === currentMatchKey)) {
      nextMatchKey = queue.normalCursorMatchKey || null;
    } else if (currentMatchKey === queue.normalCursorMatchKey) {
      nextMatchKey = nextNormalAfter(currentMatchKey, assignments, workflows, entries);
    } else if (!currentMatchKey) {
      nextMatchKey = queue.normalCursorMatchKey || null;
    }
  }
  return { currentMatchKey, nextMatchKey };
}

export function projectQueue(queue, assignments, workflows) {
  const view = selectQueueView(queue, assignments, workflows);
  return cloneQueue(queue, view);
}

export function insertPriorityEntry(queue, assignments, workflows, entry) {
  if (!entry || !entry.matchKey || !entry.kind) throw new Error('Priority entry requires matchKey and kind');
  assertQueueOwnership(queue, assignments, workflows);
  assignmentFor(assignments, entry.matchKey);
  if (queue.normalCursorMatchKey === entry.matchKey) {
    throw new Error(`Dual normal/priority ownership: ${entry.matchKey}`);
  }
  const entries = queue.priorityEntries || [];
  const existing = entries.find((item) => item.matchKey === entry.matchKey);
  let priorityEntries;
  let nextPrioritySequence = queue.nextPrioritySequence || 0;
  if (existing) {
    const sourceTransitionIds = [...new Set([...(existing.sourceTransitionIds || []), ...(entry.sourceTransitionIds || [])])];
    priorityEntries = entries.map((item) => item === existing ? { ...item, sourceTransitionIds } : item);
  } else {
    const assigned = assignmentFor(assignments, entry.matchKey);
    const enqueueSequence = nextPrioritySequence;
    priorityEntries = [...entries, {
      entryId: entry.entryId || `${entry.kind}:${entry.matchKey}`,
      matchKey: entry.matchKey,
      kind: entry.kind,
      enqueueSequence,
      pathDepth: entry.pathDepth || 0,
      courtOrder: entry.courtOrder ?? assigned.courtOrder ?? 0,
      eligibility: entry.eligibility || READY,
      sourceTransitionIds: [...new Set(entry.sourceTransitionIds || [])],
    }];
    nextPrioritySequence += 1;
  }
  return projectQueue(cloneQueue(queue, { priorityEntries, nextPrioritySequence }), assignments, workflows);
}

export function consumeCurrentAndAdvance(queue, assignments, workflows, matchKey = queue.currentMatchKey) {
  if (queue.currentMatchKey !== matchKey) throw new Error(`Stale current match: ${matchKey}`);
  assignmentFor(assignments, matchKey);
  const currentEntry = (queue.priorityEntries || []).find((entry) => entry.matchKey === matchKey);
  let normalCursorMatchKey = queue.normalCursorMatchKey || null;
  let priorityEntries = queue.priorityEntries || [];
  if (currentEntry) {
    priorityEntries = priorityEntries.filter((entry) => entry.matchKey !== matchKey);
  } else {
    if (matchKey !== normalCursorMatchKey) throw new Error(`Current normal does not own cursor: ${matchKey}`);
    normalCursorMatchKey = nextNormalAfter(matchKey, assignments, workflows, priorityEntries);
  }
  return projectQueue(cloneQueue(queue, {
    priorityEntries,
    normalCursorMatchKey,
    queueRevision: (queue.queueRevision || 0) + 1,
  }), assignments, workflows);
}

export function projectReturnState(queue, assignments, workflows, matchKey, returnState) {
  assignmentFor(assignments, matchKey);
  const nextWorkflows = { ...workflows, [matchKey]: { ...workflowFor(workflows, matchKey), ...returnState, lock: null } };
  return projectQueue(queue, assignments, nextWorkflows);
}

export const projectCancel = projectReturnState;
export const projectForceRelease = projectReturnState;

export function planRejectedRework(queue, assignments, workflows, matchKey, transitionId) {
  const assignment = assignmentFor(assignments, matchKey);
  const workflow = workflowFor(workflows, matchKey);
  if (assignment.publicStatus !== 'under_review' || workflow.draftState !== 'submitted') {
    throw new Error(`Rejected rework requires submitted match: ${matchKey}`);
  }
  const nextAssignments = { ...assignments, [matchKey]: { ...assignment, publicStatus: 'replay_required' } };
  const nextWorkflows = { ...workflows, [matchKey]: { ...workflow, draftState: 'rejected', lock: null } };
  const nextQueue = insertPriorityEntry(queue, nextAssignments, nextWorkflows, {
    matchKey, kind: 'rejected_rework', eligibility: READY, sourceTransitionIds: [transitionId],
  });
  return { queue: nextQueue, assignments: nextAssignments, workflows: nextWorkflows };
}

export function classifyCorrectionTarget(assignment, workflow) {
  const hasHistory = Boolean(workflow.submissionVersion || workflow.submittedSnapshot || workflow.officialRevision || workflow.draftState === 'submitted' || assignment.publicStatus !== NORMAL_STATUS);
  return hasHistory ? 'priority' : 'in_place';
}

export function planCorrectionReplay(queue, assignments, workflows, targets, transitionId) {
  for (const matchKey of targets) {
    const assignment = assignmentFor(assignments, matchKey);
    if (isActive(assignments, workflows, matchKey)) throw new Error(`Affected correction is active: ${matchKey}`);
    if (classifyCorrectionTarget(assignment, workflowFor(workflows, matchKey)) === 'in_place') continue;
  }
  let nextQueue = queue;
  let nextAssignments = { ...assignments };
  let nextWorkflows = { ...workflows };
  for (const matchKey of targets) {
    const assignment = assignmentFor(nextAssignments, matchKey);
    const workflow = workflowFor(nextWorkflows, matchKey);
    if (classifyCorrectionTarget(assignment, workflow) === 'in_place') continue;
    nextAssignments[matchKey] = { ...assignment, publicStatus: 'replay_required' };
    nextWorkflows[matchKey] = { ...workflow, draftState: 'rejected', lock: null };
    nextQueue = insertPriorityEntry(nextQueue, nextAssignments, nextWorkflows, {
      matchKey,
      kind: 'correction_replay',
      eligibility: assignment.dependencyReady === false ? 'blocked_dependency' : READY,
      sourceTransitionIds: [transitionId],
    });
  }
  return { queue: projectQueue(nextQueue, nextAssignments, nextWorkflows), assignments: nextAssignments, workflows: nextWorkflows };
}

export function activateDependencyEntries(queue, assignments, workflows, readyMatchKeys) {
  const ready = readyMatchKeys instanceof Set ? readyMatchKeys : new Set(readyMatchKeys);
  const priorityEntries = (queue.priorityEntries || []).map((entry) => (
    entry.eligibility === 'blocked_dependency' && ready.has(entry.matchKey)
      ? { ...entry, eligibility: READY }
      : entry
  ));
  return projectQueue(cloneQueue(queue, { priorityEntries }), assignments, workflows);
}

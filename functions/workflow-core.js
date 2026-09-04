// This workflow is intentionally single-tournament.  Callable entry points
// reject every caller-provided identifier other than this canonical root.
const TOURNAMENT_ID = 'main';

const READY = 'ready';
const ACTIVE_STATUS = 'in_progress';
const NORMAL_STATUS = 'scheduled';

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

function assertQueueOwnership(queue, assignments, workflows) {
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
      && !isActive(assignments, workflows, queue.normalCursorMatchKey)) {
    throw new Error(`Stale or ineligible normal cursor: ${queue.normalCursorMatchKey}`);
  }
}

function deriveEligibleNormal(startMatchKey, assignments, workflows, priorityEntries = []) {
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
function selectQueueView(queue, assignments, workflows) {
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

function projectQueue(queue, assignments, workflows) {
  const view = selectQueueView(queue, assignments, workflows);
  return cloneQueue(queue, view);
}

/**
 * Rebuild a court's normal cursor from its persisted assignment order while
 * retaining priority work and any active recorder ownership.
 */
function projectCourtQueue(queue, assignments, workflows) {
  const ordered = Object.values(assignments).sort((a, b) => (
    (a.courtOrder || 0) - (b.courtOrder || 0)
    || a.matchKey.localeCompare(b.matchKey)
  ));
  const assignedKeys = new Set(ordered.map((assignment) => assignment.matchKey));
  const priorityEntries = (queue.priorityEntries || [])
    .filter((entry) => assignedKeys.has(entry.matchKey))
    .map((entry) => ({
      ...entry,
      courtOrder: assignmentFor(assignments, entry.matchKey).courtOrder || 0,
    }));
  const priorityKeys = new Set(priorityEntries.map((entry) => entry.matchKey));
  const activeNormal = ordered.find((assignment) => (
    !priorityKeys.has(assignment.matchKey)
    && isActive(assignments, workflows, assignment.matchKey)
  ));
  const normalCursorMatchKey = activeNormal?.matchKey
    || deriveEligibleNormal(ordered[0]?.matchKey || null, assignments, workflows, priorityEntries);
  return projectQueue(cloneQueue(queue, { priorityEntries, normalCursorMatchKey }), assignments, workflows);
}

/**
 * Removes a set of match keys from a court topology without retaining stale
 * queue ownership.  Persistence and state-history validation belong to the
 * caller; this is deliberately a pure projection.
 */
function planCourtRemoval(assignments, workflows, removedMatchKeys) {
  const removed = new Set(removedMatchKeys);
  const survivingAssignments = Object.fromEntries(
    Object.entries(assignments).filter(([matchKey]) => !removed.has(matchKey)),
  );
  const survivingWorkflows = Object.fromEntries(
    Object.entries(workflows).filter(([matchKey]) => !removed.has(matchKey)),
  );
  return { assignments: survivingAssignments, workflows: survivingWorkflows };
}

function insertPriorityEntry(queue, assignments, workflows, entry) {
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

function consumeCurrentAndAdvance(queue, assignments, workflows, matchKey = queue.currentMatchKey) {
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

function projectReturnState(queue, assignments, workflows, matchKey, returnState) {
  assignmentFor(assignments, matchKey);
  const nextWorkflows = { ...workflows, [matchKey]: { ...workflowFor(workflows, matchKey), ...returnState, lock: null } };
  return projectQueue(queue, assignments, nextWorkflows);
}

const projectCancel = projectReturnState;
const projectForceRelease = projectReturnState;

function planRejectedRework(queue, assignments, workflows, matchKey, transitionId) {
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

function classifyCorrectionTarget(assignment, workflow) {
  const hasHistory = Boolean(workflow.submissionVersion || workflow.submittedSnapshot || workflow.officialRevision || workflow.draftState === 'submitted' || assignment.publicStatus !== NORMAL_STATUS);
  return hasHistory ? 'priority' : 'in_place';
}

function planCorrectionReplay(queue, assignments, workflows, targets, transitionId) {
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

function activateDependencyEntries(queue, assignments, workflows, readyMatchKeys) {
  const ready = readyMatchKeys instanceof Set ? readyMatchKeys : new Set(readyMatchKeys);
  const priorityEntries = (queue.priorityEntries || []).map((entry) => (
    entry.eligibility === 'blocked_dependency' && ready.has(entry.matchKey)
      ? { ...entry, eligibility: READY }
      : entry
  ));
  return projectQueue(cloneQueue(queue, { priorityEntries }), assignments, workflows);
}

export {
  TOURNAMENT_ID,
  assertQueueOwnership,
  deriveEligibleNormal,
  selectQueueView,
  projectQueue,
  projectCourtQueue,
  planCourtRemoval,
  insertPriorityEntry,
  consumeCurrentAndAdvance,
  projectReturnState,
  projectCancel,
  projectForceRelease,
  planRejectedRework,
  classifyCorrectionTarget,
  planCorrectionReplay,
  activateDependencyEntries,
};

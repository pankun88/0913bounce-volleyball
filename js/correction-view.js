/**
 * Pure state helpers for the approved-result correction controls.
 *
 * The admin page owns Firestore data and DOM rendering; these helpers keep
 * eligibility, selection, and the two-step confirmation guard deterministic.
 */

const REENTRY_STATUSES = new Set(["replay_required", "under_review", "scheduled"]);
const REENTRY_WORKFLOW_STATES = new Set(["rejected", "submitted", "editing"]);

function candidateKey(candidate) {
  return candidate?.id || candidate?.assignment?.id || null;
}

function revisionOf(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision > 0 ? revision : 0;
}

/**
 * Return whether a candidate still represents a current, approved official
 * match with enough public entities for a card to be rendered.
 */
export function isCorrectionCandidateEligible(candidate = {}) {
  const assignment = candidate.assignment || {};
  const workflow = candidate.workflow || {};
  const officialMatch = candidate.officialMatch;
  if (!candidateKey(candidate) || !assignment.courtId || !officialMatch) return false;
  if (candidate.entitiesReady === false || officialMatch.officialCurrent === false) return false;
  if (REENTRY_STATUSES.has(assignment.publicStatus)
      || REENTRY_WORKFLOW_STATES.has(workflow.draftState)) return false;

  const revision = Math.max(
    revisionOf(assignment.officialRevision),
    revisionOf(workflow.officialRevision),
    revisionOf(officialMatch.officialRevision),
  );
  const approved = assignment.publicStatus === "completed"
    || workflow.draftState === "approved"
    || revision > 0;
  return approved && revision > 0;
}

export function eligibleCorrectionCandidates(candidates = []) {
  return candidates.filter(isCorrectionCandidateEligible);
}

export function correctionSelectionKeys(selectedKeys, candidates = []) {
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  const eligible = new Set(
    eligibleCorrectionCandidates(candidates).map(candidateKey).filter(Boolean),
  );
  return new Set([...selected].filter((key) => eligible.has(key)));
}

export function correctionSelectionInfo(selectedKeys, candidates = []) {
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const selectedCandidates = [...selected].map((key) => byKey.get(key)).filter(Boolean);
  const courtIds = new Set(selectedCandidates.map((candidate) => candidate.assignment?.courtId).filter(Boolean));
  return {
    selectedCandidates,
    courtIds,
    courtId: courtIds.size === 1 ? [...courtIds][0] : null,
    sameCourt: courtIds.size <= 1,
  };
}

export function correctionSelectionMatches(left, right) {
  const leftKeys = [...(left instanceof Set ? left : new Set(left || []))].sort();
  const rightKeys = [...(right instanceof Set ? right : new Set(right || []))].sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]);
}

/**
 * A preview is bound to both the selected keys and the state generation that
 * produced its server plan token.
 */
export function correctionConfirmationState({
  selectedKeys,
  preview,
  generation,
  reason = "",
  acknowledged = false,
  activeLocks = false,
} = {}) {
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  const previewValid = Boolean(
    preview
      && Number.isInteger(preview.generation)
      && preview.generation === generation
      && correctionSelectionMatches(selected, preview.matchKeys)
      && preview.planToken,
  );
  const hasReason = typeof reason === "string" && Boolean(reason.trim());
  const hasSelection = selected.size > 0;
  const hasConflictingLock = Array.isArray(activeLocks) ? activeLocks.length > 0 : Boolean(activeLocks);
  return {
    hasSelection,
    previewValid,
    hasReason,
    acknowledged: Boolean(acknowledged),
    hasConflictingLock,
    canApply: hasSelection && previewValid && hasReason && Boolean(acknowledged) && !hasConflictingLock,
  };
}

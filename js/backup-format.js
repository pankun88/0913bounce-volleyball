/**
 * Backup normalization is deliberately a format boundary. It never carries
 * authentication material: access-code configuration, administrators, and
 * recorder grants belong to the live deployment, not a portable backup.
 */
const PRIVATE_BACKUP_KEYS = new Set([
  "accesscode", "accesscodes", "accesscodesecret", "accesscodehash", "codesecret",
  "admins", "adminmembers", "adminuids", "adminids", "recordergrant", "recordergrants",
  "grant", "grants", "recorderaccess", "accessconfig",
]);

function safeBackupValue(value) {
  if (Array.isArray(value)) return value.map(safeBackupValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_BACKUP_KEYS.has(key.toLowerCase()))
    .map(([key, item]) => [key, safeBackupValue(item)]));
}

function invalidBackup() {
  throw new Error("올바른 백업 파일이 아닙니다.");
}

function documentArray(value) {
  if (!Array.isArray(value)) invalidBackup();
  const ids = new Set();
  value.forEach((item) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id ||
        !item.data || typeof item.data !== "object" || Array.isArray(item.data) || ids.has(item.id)) {
      invalidBackup();
    }
    ids.add(item.id);
  });
  return value;
}

function matchKey(item) {
  return item.data.matchKey || item.id;
}

function validateQueueBackup(queues, assignments, workflows) {
  const assignmentKeys = new Set(assignments.map(matchKey));
  const assignmentCourts = new Map(assignments.map((item) => [matchKey(item), item.data.courtId || null]));
  const assignmentByKey = new Map(assignments.map((item) => [matchKey(item), item.data]));
  const workflowByKey = new Map(workflows.map((item) => [matchKey(item), item.data]));

  queues.forEach((item) => {
    const queue = item.data;
    const courtId = queue.courtId || item.id;
    if (!Number.isInteger(queue.queueRevision) || queue.queueRevision < 0) invalidBackup();
    if (!Number.isInteger(queue.nextPrioritySequence) || queue.nextPrioritySequence < 0) invalidBackup();
    if (!Array.isArray(queue.priorityEntries)) invalidBackup();

    const priorityKeys = new Set();
    const prioritySequences = new Set();
    queue.priorityEntries.forEach((entry) => {
      if (!entry || typeof entry.matchKey !== "string" || !assignmentKeys.has(entry.matchKey) ||
          !Number.isInteger(entry.enqueueSequence) || entry.enqueueSequence < 0 ||
          priorityKeys.has(entry.matchKey) || prioritySequences.has(entry.enqueueSequence)) {
        invalidBackup();
      }
      if (assignmentCourts.get(entry.matchKey) && assignmentCourts.get(entry.matchKey) !== courtId) invalidBackup();
      priorityKeys.add(entry.matchKey);
      prioritySequences.add(entry.enqueueSequence);
    });
    if (prioritySequences.size && queue.nextPrioritySequence <= Math.max(...prioritySequences)) invalidBackup();

    ["currentMatchKey", "nextMatchKey", "normalCursorMatchKey"].forEach((field) => {
      if (queue[field] != null && (typeof queue[field] !== "string" || !assignmentKeys.has(queue[field]))) {
        invalidBackup();
      }
      if (queue[field] && assignmentCourts.get(queue[field]) && assignmentCourts.get(queue[field]) !== courtId) invalidBackup();
    });
    if (queue.normalCursorMatchKey && priorityKeys.has(queue.normalCursorMatchKey)) invalidBackup();
    if (queue.currentMatchKey && queue.nextMatchKey === queue.currentMatchKey) invalidBackup();
    if (queue.normalCursorMatchKey) {
      const assignment = assignmentByKey.get(queue.normalCursorMatchKey);
      const workflow = workflowByKey.get(queue.normalCursorMatchKey) || {};
      const eligible = assignment.publicStatus === "scheduled" && assignment.dependencyReady !== false &&
        workflow.draftState === "idle" && !(workflow.lock && workflow.lock.token);
      const activeNormal = assignment.publicStatus === "in_progress" && workflow.draftState !== "submitted";
      if (!eligible && !activeNormal) invalidBackup();
    }
  });
}

function normalizeV3(data) {
  const requiredArrays = [
    "groups", "teams", "prelimMatches", "officialRevisions", "courts",
    "courtAssignments", "courtQueues", "scoreWorkflows", "auditEvents", "restoreManifests",
  ];
  requiredArrays.forEach((field) => documentArray(data[field]));
  if (!data.finalMatches || !Array.isArray(data.finalMatches.men) || !Array.isArray(data.finalMatches.women)) {
    invalidBackup();
  }
  documentArray(data.finalMatches.men);
  documentArray(data.finalMatches.women);
  if (!data.maintenance || typeof data.maintenance !== "object" || Array.isArray(data.maintenance) ||
      typeof data.maintenance.enabled !== "boolean") {
    invalidBackup();
  }

  data.courtAssignments.forEach(({ data: assignment }) => {
    if (!Number.isInteger(assignment.attemptCount) || assignment.attemptCount < 0) invalidBackup();
  });
  validateQueueBackup(data.courtQueues, data.courtAssignments, data.scoreWorkflows);
  return data;
}

/**
 * Normalize only known safe backup schemas. v1/v2 remain migration input
 * (version 2); unresolved legacy data is never relabeled as schema v3.
 */
export function normalizeBackupData(rawData) {
  const data = safeBackupValue(rawData);
  if (!data || data.type !== "backup") invalidBackup();

  if (data.version === 1) {
    if (!Array.isArray(data.groups) || !Array.isArray(data.teams) ||
        !Array.isArray(data.prelimMatches) || !Array.isArray(data.finalMatches)) {
      invalidBackup();
    }

    const tournamentName = String(data.info?.name || "").toLowerCase();
    const division = /girl|여자|여성/.test(tournamentName) ? "women" : "men";
    const addDivision = (item) => ({
      ...item,
      data: { ...(item.data || {}), division },
    });
    const info = data.info ? { ...data.info } : data.info;
    if (info && typeof info.qualifyPerGroup === "number") {
      info.qualifyPerGroup = { [division]: info.qualifyPerGroup };
    }

    return {
      ...data,
      version: 2,
      info,
      groups: data.groups.map(addDivision),
      teams: data.teams.map(addDivision),
      prelimMatches: data.prelimMatches.map(addDivision),
      finalMatches: {
        men: division === "men" ? data.finalMatches : [],
        women: division === "women" ? data.finalMatches : [],
      },
    };
  }

  if (data.version === 2 && Array.isArray(data.groups) && Array.isArray(data.teams) &&
      Array.isArray(data.prelimMatches) && data.finalMatches &&
      Array.isArray(data.finalMatches.men) && Array.isArray(data.finalMatches.women)) {
    return data;
  }

  if (data.version === 3) return normalizeV3(data);
  invalidBackup();
}

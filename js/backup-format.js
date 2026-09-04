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
const RESTORABLE_ROOT_FIELDS = [
  "name", "qualifyPerGroup", "venueDisplay", "courtTopologyRevision",
];
const BUSINESS_PATH = /^tournaments\/([^/]+)\/(?:(groups|teams|prelimMatches|officialRevisions|courts|courtAssignments|courtQueues|scoreWorkflows|auditEvents)\/([^/]+)|divisions\/(men|women)\/finalMatches\/([^/]+))$/;
const FIRESTORE_VALUE_TAG = "__bounceFirestoreValue";

function safeBackupValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(safeBackupValue);
  if (typeof value !== "object") invalidBackup();
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalidBackup();
  if (Object.hasOwn(value, FIRESTORE_VALUE_TAG)) {
    if (Object.keys(value).length !== 3 || value[FIRESTORE_VALUE_TAG] !== "timestamp" ||
        typeof value.seconds !== "string" || !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value.seconds) ||
        !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1_000_000_000) {
      invalidBackup();
    }
    return { [FIRESTORE_VALUE_TAG]: "timestamp", seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_BACKUP_KEYS.has(key.toLowerCase()))
    .map(([key, item]) => [key, safeBackupValue(item)]));
}

function invalidBackup() {
  throw new Error("올바른 백업 파일이 아닙니다.");
}

export function restorableRootData(info) {
  if (info == null) return {};
  if (typeof info !== "object" || Array.isArray(info) ||
      (Object.getPrototypeOf(info) !== Object.prototype && Object.getPrototypeOf(info) !== null)) invalidBackup();
  return Object.fromEntries(RESTORABLE_ROOT_FIELDS
    .filter((field) => Object.hasOwn(info, field))
    .map((field) => [field, safeBackupValue(info[field])]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function restorePayloadMatches(savedPayload, payload) {
  return JSON.stringify(canonical(savedPayload)) === JSON.stringify(canonical(payload));
}

export function selectRestoreRecovery({ activeManifestId, savedState, payload, newManifestId }) {
  const reuseSaved = Boolean(
    activeManifestId
    && savedState?.manifestId === activeManifestId
    && restorePayloadMatches(savedState.payload, payload)
  );
  const manifestId = reuseSaved ? savedState.manifestId : newManifestId;
  return {
    manifestId,
    priorManifestId: activeManifestId || null,
    reuseSaved,
    supersede: Boolean(activeManifestId && activeManifestId !== manifestId),
  };
}

/**
 * Convert the server's exact-restorable path chunks into the portable v3
 * backup shape used by import normalization and downloaded backup files.
 */
export function backupFromServerExport(response) {
  if (!response || response.version !== 3 || typeof response.tournamentId !== "string" ||
      !Array.isArray(response.chunks)) invalidBackup();
  const backup = {
    app: "bounce-volleyball",
    type: "backup",
    version: 3,
    tournamentId: response.tournamentId,
    info: restorableRootData(response.rootData),
    groups: [],
    teams: [],
    prelimMatches: [],
    finalMatches: { men: [], women: [] },
    officialRevisions: [],
    courts: [],
    courtAssignments: [],
    courtQueues: [],
    scoreWorkflows: [],
    auditEvents: [],
  };
  const collections = {
    groups: backup.groups,
    teams: backup.teams,
    prelimMatches: backup.prelimMatches,
    officialRevisions: backup.officialRevisions,
    courts: backup.courts,
    courtAssignments: backup.courtAssignments,
    courtQueues: backup.courtQueues,
    scoreWorkflows: backup.scoreWorkflows,
    auditEvents: backup.auditEvents,
  };
  const paths = new Set();
  response.chunks.forEach((chunk) => {
    if (!chunk || !Array.isArray(chunk.documents)) invalidBackup();
    chunk.documents.forEach((item) => {
      const match = typeof item?.path === "string" && BUSINESS_PATH.exec(item.path);
      if (!match || match[1] !== response.tournamentId || !item.data ||
          typeof item.data !== "object" || Array.isArray(item.data) || paths.has(item.path)) invalidBackup();
      paths.add(item.path);
      if (match[2]) collections[match[2]].push({ id: match[3], data: safeBackupValue(item.data) });
      else backup.finalMatches[match[4]].push({ id: match[5], data: safeBackupValue(item.data) });
    });
  });
  return normalizeV3(backup);
}

function documentArray(value) {
  if (!Array.isArray(value)) invalidBackup();
  const ids = new Set();
  value.forEach((item) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || item.id.includes("/") ||
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
  const allowedFields = [
    "app", "type", "version", "tournamentId", "info",
    "groups", "teams", "prelimMatches", "finalMatches", "officialRevisions",
    "courts", "courtAssignments", "courtQueues", "scoreWorkflows", "auditEvents",
  ];
  if (data.app !== "bounce-volleyball"
      || data.tournamentId !== "main"
      || !Object.hasOwn(data, "info")
      || !data.info || typeof data.info !== "object" || Array.isArray(data.info)
      || Object.keys(data).length !== allowedFields.length
      || allowedFields.some((field) => !Object.hasOwn(data, field))
      || Object.keys(data).some((field) => !allowedFields.includes(field))) {
    invalidBackup();
  }
  const requiredArrays = [
    "groups", "teams", "prelimMatches", "officialRevisions", "courts",
    "courtAssignments", "courtQueues", "scoreWorkflows", "auditEvents",
  ];
  requiredArrays.forEach((field) => documentArray(data[field]));
  if (!data.finalMatches || !Array.isArray(data.finalMatches.men) || !Array.isArray(data.finalMatches.women)) {
    invalidBackup();
  }
  documentArray(data.finalMatches.men);
  documentArray(data.finalMatches.women);
  data.courtAssignments.forEach(({ data: assignment }) => {
    if (!Number.isInteger(assignment.attemptCount) || assignment.attemptCount < 0) invalidBackup();
  });
  validateQueueBackup(data.courtQueues, data.courtAssignments, data.scoreWorkflows);
  data.info = restorableRootData(data.info);
  return data;
}

/** Portable backups have one exact, type-preserving schema: v3. */
export function normalizeBackupData(rawData) {
  const data = safeBackupValue(rawData);
  if (!data || data.type !== "backup") invalidBackup();
  if (data.version === 3) return normalizeV3(data);
  invalidBackup();
}

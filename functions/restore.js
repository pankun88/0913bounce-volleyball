import crypto from 'node:crypto';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { TOURNAMENT_ID, assertQueueOwnership, projectQueue } from './workflow-core.js';

const db = () => getFirestore();
const root = () => db().collection('tournaments').doc(TOURNAMENT_ID);
const ROOT_FIELDS = new Set(['name', 'qualifyPerGroup', 'venueDisplay', 'courtTopologyRevision']);
const COLLECTIONS = [
  'groups', 'teams', 'prelimMatches', 'divisions/men/finalMatches', 'divisions/women/finalMatches',
  'officialRevisions', 'courts', 'courtAssignments', 'courtQueues', 'scoreWorkflows', 'auditEvents',
];
const pathPrefix = `tournaments/${TOURNAMENT_ID}/`;
const allowedPath = new RegExp(`^${pathPrefix}(?:groups|teams|prelimMatches|officialRevisions|courts|courtAssignments|courtQueues|scoreWorkflows|auditEvents)/[^/]+$|^${pathPrefix}divisions/(?:men|women)/finalMatches/[^/]+$`);
const FIRESTORE_VALUE_TAG = '__bounceFirestoreValue';
const MIN_TIMESTAMP_SECONDS = -62135596800;
const MAX_TIMESTAMP_SECONDS = 253402300799;
const MAX_RESTORE_CHUNKS = 100;
const MAX_RESTORE_CHUNK_BYTES = 2_500_000;
const MAX_RESTORE_TOTAL_BYTES = 25_000_000;

async function admin(request, { allowRestoreMaintenance = false } = {}) {
  if (request.data?.tournamentId !== TOURNAMENT_ID) throw new HttpsError('invalid-argument', 'Unknown tournament.');
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  if (!(await root().collection('admins').doc(request.auth.uid).get()).exists) throw new HttpsError('permission-denied', 'Seeded administrator required.');
  const maintenance = (await root().get()).data()?.maintenance;
  if (maintenance?.enabled === true && (!allowRestoreMaintenance || maintenance.reset)) throw new HttpsError('failed-precondition', 'Tournament maintenance is active.');
  return request.auth.uid;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function checksum(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function portableFirestoreValue(value) {
  if (value instanceof Timestamp) {
    return { [FIRESTORE_VALUE_TAG]: 'timestamp', seconds: String(value.seconds), nanoseconds: value.nanoseconds };
  }
  if (Array.isArray(value)) return value.map(portableFirestoreValue);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new HttpsError('failed-precondition', 'Unsupported Firestore value in backup.');
  if (!plainObject(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new HttpsError('failed-precondition', 'Unsupported Firestore value in backup.');
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portableFirestoreValue(item)]));
}
function restoreFirestoreValue(value) {
  if (Array.isArray(value)) return value.map(restoreFirestoreValue);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new HttpsError('invalid-argument', 'Unsupported restore value.');
  if (!plainObject(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new HttpsError('invalid-argument', 'Unsupported restore value.');
  }
  if (Object.hasOwn(value, FIRESTORE_VALUE_TAG)) {
    if (Object.keys(value).length !== 3 || value[FIRESTORE_VALUE_TAG] !== 'timestamp' ||
        typeof value.seconds !== 'string' || !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value.seconds) ||
        !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1_000_000_000) {
      throw new HttpsError('invalid-argument', 'Unknown or malformed Firestore value tag.');
    }
    const seconds = Number(value.seconds);
    if (!Number.isSafeInteger(seconds) || seconds < MIN_TIMESTAMP_SECONDS || seconds > MAX_TIMESTAMP_SECONDS) {
      throw new HttpsError('invalid-argument', 'Timestamp is out of range.');
    }
    return new Timestamp(seconds, value.nanoseconds);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreFirestoreValue(item)]));
}
function validateRootData(rootData) {
  if (!plainObject(rootData) || Object.keys(rootData).some((key) => !ROOT_FIELDS.has(key))) throw new HttpsError('invalid-argument', 'rootData contains unsupported fields.');
  restoreFirestoreValue(rootData);
  if (Object.hasOwn(rootData, 'name')
      && (typeof rootData.name !== 'string' || rootData.name.length > 200)) {
    throw new HttpsError('invalid-argument', 'rootData name is invalid.');
  }
  if (Object.hasOwn(rootData, 'qualifyPerGroup')) {
    const qualify = rootData.qualifyPerGroup;
    if (!plainObject(qualify)
        || Object.keys(qualify).some((key) => !['men', 'women'].includes(key))
        || !Object.keys(qualify).length
        || Object.values(qualify).some((value) => !Number.isInteger(value) || value < 1 || value > 64)) {
      throw new HttpsError('invalid-argument', 'rootData qualifyPerGroup is invalid.');
    }
  }
  if (Object.hasOwn(rootData, 'venueDisplay')) {
    const venue = rootData.venueDisplay;
    if (!plainObject(venue)
        || Object.keys(venue).some((key) => !['mode', 'intervalSeconds', 'cycleStartedAt'].includes(key))
        || !['auto', 'men', 'women'].includes(venue.mode)
        || ![10, 15, 20, 30].includes(venue.intervalSeconds)
        || (Object.hasOwn(venue, 'cycleStartedAt') && !Number.isFinite(venue.cycleStartedAt))) {
      throw new HttpsError('invalid-argument', 'rootData venueDisplay is invalid.');
    }
  }
  if (Object.hasOwn(rootData, 'courtTopologyRevision')
      && (!Number.isInteger(rootData.courtTopologyRevision) || rootData.courtTopologyRevision < 0)) {
    throw new HttpsError('invalid-argument', 'rootData courtTopologyRevision is invalid.');
  }
  return canonical(rootData);
}
function validatePayload(data) {
  const { manifestId, rootData, chunks } = data || {};
  const required = ['tournamentId', 'manifestId', 'rootData', 'chunks'];
  if (!plainObject(data)
      || Object.keys(data).length !== required.length
      || required.some((key) => !Object.hasOwn(data, key))
      || data.tournamentId !== TOURNAMENT_ID
      || typeof manifestId !== 'string'
      || !manifestId
      || !Array.isArray(chunks)
      || chunks.length > MAX_RESTORE_CHUNKS) {
    throw new HttpsError('invalid-argument', 'Exact manifestId, rootData, and chunks payload required.');
  }
  const normalizedRoot = validateRootData(rootData);
  const paths = new Set();
  const normalized = chunks.map((chunk, index) => {
    if (!plainObject(chunk) || !Array.isArray(chunk.documents)) throw new HttpsError('invalid-argument', 'Malformed restore chunk.');
    const documents = chunk.documents.map((item) => {
      if (!plainObject(item) || !allowedPath.test(item.path) || !plainObject(item.data)) throw new HttpsError('invalid-argument', 'Unsafe or malformed restore path.');
      if (paths.has(item.path)) throw new HttpsError('invalid-argument', 'Duplicate restore path.');
      paths.add(item.path);
      restoreFirestoreValue(item.data);
      return { path: item.path, data: canonical(item.data) };
    });
    if (Buffer.byteLength(JSON.stringify(documents)) > MAX_RESTORE_CHUNK_BYTES) {
      throw new HttpsError('invalid-argument', 'Restore chunk exceeds the byte limit.');
    }
    return { index, documents };
  });
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_RESTORE_TOTAL_BYTES) {
    throw new HttpsError('invalid-argument', 'Restore payload exceeds the aggregate byte limit.');
  }
  validateGraph(normalized.flatMap((chunk) => chunk.documents));
  return { manifestId, rootData: normalizedRoot, chunks: normalized, paths: [...paths] };
}
function graphError(message) { throw new HttpsError('invalid-argument', `Invalid restore graph: ${message}`); }
function validateGraph(documents) {
  const docs = new Map(documents.map((item) => [item.path, item.data]));
  const get = (collection, id) => docs.get(`${pathPrefix}${collection}/${id}`);
  const assignments = documents.filter((item) => item.path.startsWith(`${pathPrefix}courtAssignments/`));
  const workflows = documents.filter((item) => item.path.startsWith(`${pathPrefix}scoreWorkflows/`));
  const queues = documents.filter((item) => item.path.startsWith(`${pathPrefix}courtQueues/`));
  const courts = documents.filter((item) => item.path.startsWith(`${pathPrefix}courts/`));
  const assignmentMap = Object.fromEntries(assignments.map((item) => [item.path.split('/').at(-1), item.data]));
  const workflowMap = Object.fromEntries(workflows.map((item) => [item.path.split('/').at(-1), item.data]));
  for (const [id, assignment] of Object.entries(assignmentMap)) {
    if (assignment.matchKey !== id) graphError('assignment ID must equal matchKey');
    if (!workflowMap[id]) graphError('assignment workflow missing');
    const match = assignment.matchType === 'prelim'
      ? get('prelimMatches', assignment.matchId)
      : assignment.matchType === 'final'
        ? get(`divisions/${assignment.divisionId || assignment.division}/finalMatches`, assignment.matchId)
        : null;
    if (!match) graphError('official selector missing');
    if (assignment.courtId !== null && assignment.courtId !== undefined) {
      if (!get('courts', assignment.courtId) || !get('courtQueues', assignment.courtId)) graphError('assigned court or queue missing');
      if (assignment.nextCourtMatchKey && assignmentMap[assignment.nextCourtMatchKey]?.courtId !== assignment.courtId) graphError('assignment next key crosses courts');
    }
  }
  for (const id of Object.keys(workflowMap)) if (!assignmentMap[id]) graphError('workflow assignment missing');
  for (const item of courts) {
    const id = item.path.split('/').at(-1);
    if (!get('courtQueues', id)) graphError('court queue missing');
  }
  for (const item of queues) {
    const id = item.path.split('/').at(-1); const queue = item.data;
    if (queue.courtId !== id || !get('courts', id)) graphError('queue ID must equal an existing courtId');
    const courtAssignments = Object.fromEntries(Object.entries(assignmentMap).filter(([, assignment]) => assignment.courtId === id));
    for (const key of [queue.currentMatchKey, queue.nextMatchKey, queue.normalCursorMatchKey, ...(queue.priorityEntries || []).map((entry) => entry.matchKey)]) {
      if (key !== null && key !== undefined && !courtAssignments[key]) graphError('queue references foreign assignment');
    }
    try {
      assertQueueOwnership(queue, courtAssignments, Object.fromEntries(Object.keys(courtAssignments).map((key) => [key, workflowMap[key]])));
      const projection = projectQueue(queue, courtAssignments, Object.fromEntries(Object.keys(courtAssignments).map((key) => [key, workflowMap[key]])));
      if (projection.currentMatchKey !== queue.currentMatchKey || projection.nextMatchKey !== queue.nextMatchKey) graphError('queue projection mismatch');
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      graphError(error.message || 'queue ownership invalid');
    }
  }
}
async function assertRestoreTransaction(tx, manifestId, { starting = false } = {}) {
  const tournament = await tx.get(root());
  const maintenance = tournament.data()?.maintenance || {};
  if (starting) {
    if (maintenance.enabled === true) throw new HttpsError('failed-precondition', 'Tournament maintenance is active.');
    return;
  }
  if (maintenance.enabled !== true || maintenance.reset || maintenance.restoreManifestId !== manifestId) throw new HttpsError('failed-precondition', 'Current restore maintenance lease required.');
}
function manifestRef(manifestId) { return root().collection('restoreManifests').doc(manifestId); }
function chunkMetadata(chunk) {
  return { index: chunk.index, checksum: checksum(chunk.documents), count: chunk.documents.length };
}
function chunkDescriptor(chunk) {
  return {
    ...chunkMetadata(chunk),
    documents: chunk.documents.map((item) => ({ path: item.path, checksum: checksum(item.data) })),
  };
}
async function assertLease(manifestId) {
  const tournament = await root().get();
  const maintenance = tournament.data()?.maintenance || {};
  if (maintenance.enabled !== true || maintenance.reset || maintenance.restoreManifestId !== manifestId) throw new HttpsError('failed-precondition', 'Current restore maintenance lease required.');
}

export async function beginRestore(request) {
  const uid = await admin(request, { allowRestoreMaintenance: true });
  const payload = validatePayload(request.data);
  const manifest = manifestRef(payload.manifestId);
  return db().runTransaction(async (tx) => {
    const old = await tx.get(manifest);
    const metadata = payload.chunks.map(chunkMetadata);
    if (old.exists) {
      const previous = old.data();
      if (previous.rootDataChecksum !== checksum(payload.rootData) || checksum(previous.chunks) !== checksum(metadata)) throw new HttpsError('already-exists', 'Restore manifest payload differs.');
      if (previous.status !== 'promoted') await assertRestoreTransaction(tx, payload.manifestId);
      return { manifestId: payload.manifestId, status: previous.status };
    }
    await assertRestoreTransaction(tx, payload.manifestId, { starting: true });
    tx.create(manifest, { manifestId: payload.manifestId, status: 'staged', rootData: payload.rootData, rootDataChecksum: checksum(payload.rootData), chunks: metadata, createdBy: uid, createdAt: FieldValue.serverTimestamp() });
    payload.chunks.forEach((chunk) => tx.create(manifest.collection('chunks').doc(String(chunk.index)), chunkDescriptor(chunk)));
    tx.set(root(), {
      maintenance: { enabled: true, restoreManifestId: payload.manifestId },
    }, { mergeFields: ['maintenance'] });
    return { manifestId: payload.manifestId, status: 'staged' };
  });
}

export async function supersedeRestore(request) {
  await admin(request, { allowRestoreMaintenance: true });
  const { priorManifestId, ...nextData } = request.data || {};
  if (typeof priorManifestId !== 'string' || !priorManifestId) throw new HttpsError('invalid-argument', 'priorManifestId required.');
  const payload = validatePayload(nextData);
  if (payload.manifestId === priorManifestId) throw new HttpsError('invalid-argument', 'Replacement manifest ID required.');
  const prior = manifestRef(priorManifestId);
  const replacement = manifestRef(payload.manifestId);
  return db().runTransaction(async (tx) => {
    const [priorSnap, replacementSnap] = await Promise.all([tx.get(prior), tx.get(replacement)]);
    if (!priorSnap.exists) throw new HttpsError('not-found', 'Prior restore manifest not found.');
    const metadata = payload.chunks.map(chunkMetadata);
    if (replacementSnap.exists) {
      const existing = replacementSnap.data();
      if (existing.rootDataChecksum !== checksum(payload.rootData) || checksum(existing.chunks) !== checksum(metadata)) throw new HttpsError('already-exists', 'Replacement manifest payload differs.');
      if (priorSnap.data().status === 'superseded' && priorSnap.data().supersededBy === payload.manifestId) {
        await assertRestoreTransaction(tx, payload.manifestId);
        return { priorManifestId, manifestId: payload.manifestId, status: existing.status };
      }
      throw new HttpsError('already-exists', 'Replacement manifest ID is already in use.');
    }
    await assertRestoreTransaction(tx, priorManifestId);
    tx.create(replacement, { manifestId: payload.manifestId, status: 'staged', rootData: payload.rootData, rootDataChecksum: checksum(payload.rootData), chunks: metadata, supersedes: priorManifestId, createdAt: FieldValue.serverTimestamp() });
    payload.chunks.forEach((chunk) => tx.create(replacement.collection('chunks').doc(String(chunk.index)), chunkDescriptor(chunk)));
    tx.update(prior, { status: 'superseded', supersededBy: payload.manifestId, supersededAt: FieldValue.serverTimestamp() });
    tx.set(root(), {
      maintenance: { enabled: true, restoreManifestId: payload.manifestId },
    }, { mergeFields: ['maintenance'] });
    return { priorManifestId, manifestId: payload.manifestId, status: 'staged' };
  });
}

export async function exportTournamentBackup(request) {
  await admin(request);
  return db().runTransaction(async (tx) => {
    const tournament = await tx.get(root());
    if (tournament.data()?.maintenance?.enabled === true) {
      throw new HttpsError('failed-precondition', 'Cannot export a backup during maintenance.');
    }
    const rootData = Object.fromEntries([...ROOT_FIELDS]
      .filter((field) => Object.hasOwn(tournament.data() || {}, field))
      .map((field) => [field, tournament.data()[field]]));
    const snapshots = await Promise.all(COLLECTIONS.map((collectionPath) => tx.get(root().collection(collectionPath))));
    return {
      version: 3,
      tournamentId: TOURNAMENT_ID,
      rootData: portableFirestoreValue(rootData),
      chunks: [{ index: 0, documents: snapshots.flatMap((snapshot) => snapshot.docs.map((snap) => ({
        path: snap.ref.path, data: portableFirestoreValue(snap.data()),
      }))) }],
    };
  });
}

export async function resumeRestore(request) {
  await admin(request, { allowRestoreMaintenance: true });
  const { manifestId, chunkIndex, chunk: suppliedChunk } = request.data || {};
  if (!plainObject(suppliedChunk) || !Array.isArray(suppliedChunk.documents)) {
    throw new HttpsError('invalid-argument', 'Restore chunk payload required.');
  }
  const suppliedDocuments = suppliedChunk.documents.map((item) => {
    if (!plainObject(item) || !allowedPath.test(item.path) || !plainObject(item.data)) {
      throw new HttpsError('invalid-argument', 'Unsafe or malformed restore path.');
    }
    restoreFirestoreValue(item.data);
    return { path: item.path, data: canonical(item.data) };
  });
  if (new Set(suppliedDocuments.map((item) => item.path)).size !== suppliedDocuments.length
      || Buffer.byteLength(JSON.stringify(suppliedDocuments)) > MAX_RESTORE_CHUNK_BYTES) {
    throw new HttpsError('invalid-argument', 'Malformed or oversized restore chunk.');
  }
  const manifest = manifestRef(manifestId);
  return db().runTransaction(async (tx) => {
    const meta = await tx.get(manifest);
    if (!meta.exists) throw new HttpsError('not-found', 'Restore manifest not found.');
    if (['pruned', 'verified', 'promoted'].includes(meta.data().status)) return { manifestId, chunkIndex, applied: true };
    await assertRestoreTransaction(tx, manifestId);
    const chunk = await tx.get(manifest.collection('chunks').doc(String(chunkIndex)));
    const expected = meta.data().chunks.find((item) => item.index === chunkIndex);
    if (!chunk.exists || !expected) throw new HttpsError('not-found', 'Restore chunk not found.');
    const descriptor = suppliedDocuments.map((item) => ({ path: item.path, checksum: checksum(item.data) }));
    if (expected.checksum !== checksum(suppliedDocuments)
        || chunk.data().checksum !== expected.checksum
        || checksum(chunk.data().documents) !== checksum(descriptor)) {
      throw new HttpsError('failed-precondition', 'Checksum mismatch.');
    }
    for (const item of suppliedDocuments) tx.set(db().doc(item.path), restoreFirestoreValue(item.data));
    tx.set(chunk.ref, { appliedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(manifest, { status: 'restoring' }, { merge: true });
    return { manifestId, chunkIndex, applied: true };
  });
}

export async function pruneRestore(request) {
  await admin(request, { allowRestoreMaintenance: true });
  const manifest = manifestRef(request.data?.manifestId);
  const meta = await manifest.get();
  if (!meta.exists) throw new HttpsError('not-found', 'Restore manifest not found.');
  if (['verified', 'promoted'].includes(meta.data().status)) return { manifestId: manifest.id, pruned: true };
  await assertLease(manifest.id);
  const chunks = await manifest.collection('chunks').get();
  if (meta.data().chunks.length !== chunks.docs.length || chunks.docs.some((snap) => !snap.data().appliedAt)) throw new HttpsError('failed-precondition', 'All chunks must be applied.');
  if (meta.data().prunedAt) return { manifestId: manifest.id, pruned: true };
  const desired = new Set(chunks.docs.flatMap((snap) => (
    snap.data().documents || []
  ).map((item) => item.path)));
  const stale = [];
  for (const collectionPath of COLLECTIONS) {
    const snapshot = await root().collection(collectionPath).get();
    for (const snap of snapshot.docs) if (!desired.has(snap.ref.path)) stale.push(snap.ref);
  }
  if (stale.length) {
    await db().runTransaction(async (tx) => {
      await assertRestoreTransaction(tx, manifest.id);
      stale.slice(0, 400).forEach((ref) => tx.delete(ref));
    });
    return { manifestId: manifest.id, pruned: false, remaining: stale.length - Math.min(stale.length, 400) };
  }
  return db().runTransaction(async (tx) => {
    await assertRestoreTransaction(tx, manifest.id);
    const current = await tx.get(manifest);
    if (current.data().prunedAt) return { manifestId: manifest.id, pruned: true };
    const updates = { updatedAt: FieldValue.serverTimestamp() };
    for (const field of ROOT_FIELDS) {
      updates[field] = Object.hasOwn(meta.data().rootData, field)
        ? restoreFirestoreValue(meta.data().rootData[field])
        : FieldValue.delete();
    }
    tx.set(root(), updates, { merge: true });
    tx.update(manifest, { status: 'pruned', prunedAt: FieldValue.serverTimestamp() });
    return { manifestId: manifest.id, pruned: true };
  });
}

export async function verifyRestore(request) {
  await admin(request, { allowRestoreMaintenance: true });
  const manifest = manifestRef(request.data?.manifestId);
  const meta = await manifest.get();
  if (!meta.exists) throw new HttpsError('not-found', 'Restore manifest not found.');
  if (['verified', 'promoted'].includes(meta.data().status)) return { manifestId: manifest.id, verified: true };
  await assertLease(manifest.id);
  if (!meta.data().prunedAt) throw new HttpsError('failed-precondition', 'Restore must be pruned first.');
  const chunks = await manifest.collection('chunks').get();
  if (
    meta.data().chunks.length !== chunks.docs.length
    || chunks.docs.some((snap) => {
      const expected = meta.data().chunks.find((chunk) => chunk.index === snap.data().index);
      return !expected || !snap.data().appliedAt || expected.checksum !== snap.data().checksum;
    })
    || meta.data().chunks.some((expected) => !chunks.docs.some((snap) => snap.data().index === expected.index))
  ) throw new HttpsError('failed-precondition', 'Restore chunk checksum mismatch.');
  const documents = chunks.docs.flatMap((snap) => snap.data().documents || []);
  const expected = new Map(documents.map((item) => [item.path, item.checksum]));
  const actual = new Map();
  for (const collectionPath of COLLECTIONS) {
    const snapshot = await root().collection(collectionPath).get();
    snapshot.docs.forEach((snap) => actual.set(snap.ref.path, snap.data()));
  }
  if (actual.size !== expected.size || [...expected].some(([path, expectedChecksum]) =>
    !actual.has(path) || checksum(portableFirestoreValue(actual.get(path))) !== expectedChecksum
  )) throw new HttpsError('failed-precondition', 'Restore path or checksum mismatch.');
  try {
    validateGraph([...actual].map(([path, data]) => ({ path, data })));
  } catch (error) {
    if (error instanceof HttpsError) throw new HttpsError('failed-precondition', error.message);
    throw error;
  }
  const rootSnapshot = (await root().get()).data() || {};
  const actualRoot = Object.fromEntries([...ROOT_FIELDS]
    .filter((field) => Object.hasOwn(meta.data().rootData, field))
    .map((field) => [field, portableFirestoreValue(rootSnapshot[field])]));
  if (
    [...ROOT_FIELDS].some((field) => !Object.hasOwn(meta.data().rootData, field) && Object.hasOwn(rootSnapshot, field))
    || checksum(actualRoot) !== meta.data().rootDataChecksum
  ) throw new HttpsError('failed-precondition', 'Restore root checksum mismatch.');
  const queues = await root().collection('courtQueues').get();
  for (const queue of queues.docs) {
    const assignments = await root().collection('courtAssignments').where('courtId', '==', queue.id).get();
    const assignmentMap = Object.fromEntries(assignments.docs.map((snap) => [snap.id, snap.data()]));
    const workflowMap = Object.fromEntries((await Promise.all(assignments.docs.map((snap) => root().collection('scoreWorkflows').doc(snap.id).get()))).map((snap) => [snap.id, snap.exists ? snap.data() : null]));
    assertQueueOwnership(queue.data(), assignmentMap, workflowMap);
    const projection = projectQueue(queue.data(), assignmentMap, workflowMap);
    if (projection.currentMatchKey !== queue.data().currentMatchKey || projection.nextMatchKey !== queue.data().nextMatchKey) throw new HttpsError('failed-precondition', 'Queue projection mismatch.');
  }
  return db().runTransaction(async (tx) => {
    await assertRestoreTransaction(tx, manifest.id);
    const current = await tx.get(manifest);
    if (!current.data().prunedAt) throw new HttpsError('failed-precondition', 'Restore must be pruned first.');
    tx.update(manifest, { status: 'verified', verifiedAt: FieldValue.serverTimestamp() });
    return { manifestId: manifest.id, verified: true };
  });
}

export async function promoteRestore(request) {
  await admin(request, { allowRestoreMaintenance: true });
  const manifest = manifestRef(request.data?.manifestId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(manifest);
    if (!snap.exists) throw new HttpsError('not-found', 'Restore manifest not found.');
    if (snap.data().status === 'promoted') return { manifestId: snap.id, promoted: true };
    await assertRestoreTransaction(tx, manifest.id);
    if (snap.data().status !== 'verified') throw new HttpsError('failed-precondition', 'Restore must be verified first.');
    tx.update(snap.ref, { status: 'promoted', promotedAt: FieldValue.serverTimestamp() });
    tx.set(root(), { maintenance: { enabled: false } }, { mergeFields: ['maintenance'] });
    return { manifestId: snap.id, promoted: true };
  });
}

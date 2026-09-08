import { isDeepStrictEqual } from 'node:util';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

export const TOURNAMENT_ID = 'main';
const PUBLIC_SCHEDULE_COLLECTION = 'publicSchedule';
const PUBLIC_SCHEDULE_DOCUMENT = 'current';
const VALID_MATCH_TYPES = new Set(['prelim', 'final']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventSnapshotData(value) {
  if (typeof value?.data === 'function') {
    return value.exists === false ? null : value.data() || {};
  }
  if (value?.exists === false) return null;
  return isRecord(value) ? value : null;
}

function entryData(entry) {
  return isRecord(entry?.data) ? entry.data : {};
}

function entryId(entry) {
  if (typeof entry?.id === 'string' && entry.id) return entry.id;
  return null;
}

function compareText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeCourtName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s*코트$/u, '').trim();
}

function persistedCourtOrder(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const order = Number(value);
  return Number.isFinite(order) ? order : 0;
}

function publicCourtOrder(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Build the only shape that may be written to the public schedule document.
 * `root` is current plain root data (or null), and each source entry is
 * `{ id, data }`, where `id` is the persisted document ID.
 */
export function buildPublicSchedule({
  root = null,
  courts: sourceCourts = [],
  assignments: sourceAssignments = [],
} = {}) {
  const rootData = isRecord(root) ? root : null;
  const maintenance = rootData?.maintenance?.enabled === true;
  const courtEntries = Array.isArray(sourceCourts) ? sourceCourts : [];
  const assignmentEntries = Array.isArray(sourceAssignments) ? sourceAssignments : [];
  const courts = [];
  const courtCandidates = rootData && !maintenance
    ? courtEntries.map((entry) => {
      const data = entryData(entry);
      const id = entryId(entry);
      const name = normalizeCourtName(data.name);
      if (!id || !name) return null;
      return { id, name, order: persistedCourtOrder(data.order) };
    }).filter(Boolean)
    : [];
  courtCandidates.sort((left, right) => (
    left.order - right.order
      || left.name.localeCompare(right.name, 'ko')
      || compareText(left.name, right.name)
      || compareText(left.id, right.id)
  ));
  const courtIds = new Set();
  courtCandidates.forEach((court) => {
    if (courtIds.has(court.id)) return;
    courtIds.add(court.id);
    courts.push({ id: court.id, name: court.name });
  });
  const courtIndex = new Map(courts.map((court, index) => [court.id, index]));

  const assignments = [];
  if (rootData && !maintenance) {
    assignmentEntries.forEach((entry) => {
      const data = entryData(entry);
      const matchKey = entryId(entry);
      if (!matchKey || !VALID_MATCH_TYPES.has(data.matchType)) return;
      const knownCourt = typeof data.courtId === 'string'
        && data.courtId.length > 0
        && courtIndex.has(data.courtId)
        && publicCourtOrder(data.courtOrder) !== null;
      const courtId = knownCourt ? data.courtId : null;
      assignments.push({
        matchKey,
        matchType: data.matchType,
        courtId,
        courtOrder: knownCourt ? publicCourtOrder(data.courtOrder) : null,
        courtIndex: knownCourt ? courtIndex.get(data.courtId) : Number.POSITIVE_INFINITY,
      });
    });
  }
  assignments.sort((left, right) => (
    left.courtIndex - right.courtIndex
      || (left.courtOrder ?? Number.POSITIVE_INFINITY)
        - (right.courtOrder ?? Number.POSITIVE_INFINITY)
      || compareText(left.matchKey, right.matchKey)
  ));

  return {
    status: !rootData ? 'unavailable' : maintenance ? 'maintenance' : 'ready',
    courts,
    assignments: assignments.map(({ matchKey, matchType, courtId, courtOrder }) => ({
      matchKey,
      matchType,
      courtId,
      courtOrder,
    })),
  };
}

function samePublicSchedule(existing, expected) {
  return isDeepStrictEqual(existing, expected);
}

function refs(firestore, tournamentId) {
  const tournament = firestore.collection('tournaments').doc(tournamentId);
  return {
    tournament,
    courts: tournament.collection('courts'),
    assignments: tournament.collection('courtAssignments'),
    publicSchedule: tournament.collection(PUBLIC_SCHEDULE_COLLECTION).doc(PUBLIC_SCHEDULE_DOCUMENT),
  };
}

function snapshotField(snapshot, path) {
  const data = eventSnapshotData(snapshot);
  return path.reduce((value, key) => value?.[key], data);
}

function eventAffects(event, paths) {
  const before = event?.data?.before;
  const after = event?.data?.after;
  if (!before || !after
      || Boolean(before.exists) !== Boolean(after.exists)) return true;
  return paths.some((path) => snapshotField(before, path) !== snapshotField(after, path));
}

/**
 * Re-read authoritative current state and publish the sanitized projection.
 * Event snapshots are used only to skip writes that cannot affect the
 * projection; delayed events never supply source data.
 */
export async function publishPublicSchedule(tournamentId = TOURNAMENT_ID, firestore) {
  if (tournamentId !== TOURNAMENT_ID) return { skipped: true };
  const database = firestore || getFirestore();
  const target = refs(database, tournamentId);
  return database.runTransaction(async (transaction) => {
    const [rootSnap, courtSnap, assignmentSnap, existingSnap] = await Promise.all([
      transaction.get(target.tournament),
      transaction.get(target.courts),
      transaction.get(target.assignments),
      transaction.get(target.publicSchedule),
    ]);
    const payload = buildPublicSchedule({
      root: rootSnap.exists ? rootSnap.data() : null,
      courts: courtSnap.docs.map((snapshot) => ({ id: snapshot.id, data: snapshot.data() })),
      assignments: assignmentSnap.docs.map((snapshot) => ({ id: snapshot.id, data: snapshot.data() })),
    });
    const existing = existingSnap.exists ? existingSnap.data() : null;
    const changed = !samePublicSchedule(existing, payload);
    if (changed) transaction.set(target.publicSchedule, payload);
    return { status: payload.status, changed };
  });
}

export async function onCourtWritten(event) {
  if (!eventAffects(event, [['name'], ['order']])) return { skipped: true };
  return publishPublicSchedule(typeof event?.params?.tournamentId === 'string'
    ? event.params.tournamentId
    : null);
}

export async function onAssignmentWritten(event) {
  if (!eventAffects(event, [['matchType'], ['courtId'], ['courtOrder']])) return { skipped: true };
  return publishPublicSchedule(typeof event?.params?.tournamentId === 'string'
    ? event.params.tournamentId
    : null);
}

export async function onTournamentWritten(event) {
  if (!eventAffects(event, [['maintenance', 'enabled']])) return { skipped: true };
  return publishPublicSchedule(typeof event?.params?.tournamentId === 'string'
    ? event.params.tournamentId
    : null);
}

export async function ensurePublicSchedule(request) {
  if (request?.data?.tournamentId !== TOURNAMENT_ID) {
    throw new HttpsError('invalid-argument', 'Unknown tournament.');
  }
  const result = await publishPublicSchedule(TOURNAMENT_ID);
  return { status: result.status };
}

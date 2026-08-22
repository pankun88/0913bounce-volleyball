import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { TOURNAMENT_ID } from './workflow-core.js';

const db = () => getFirestore();
const root = () => db().collection('tournaments').doc(TOURNAMENT_ID);
async function requireAdmin(request) { if (request.data?.tournamentId !== TOURNAMENT_ID) throw new HttpsError('invalid-argument', 'Unknown tournament.'); if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.'); if (!(await root().collection('admins').doc(request.auth.uid).get()).exists) throw new HttpsError('permission-denied', 'Seeded administrator required.'); return request.auth.uid; }
function classify(match) {
  const sets = Array.isArray(match.sets) ? match.sets : [];
  if (!sets.length || sets.every((s) => Number(s.a) === 0 && Number(s.b) === 0)) return 'empty';
  if (match.status === 'done' && (match.result || match.winner)) return 'fully_valid_done';
  if (sets.some((s) => Number.isFinite(Number(s.a)) && Number.isFinite(Number(s.b)))) return 'partial';
  return 'invalid';
}
export async function createMigrationManifest(request) {
  const uid = await requireAdmin(request); const manifestId = request.data?.manifestId; if (typeof manifestId !== 'string' || !manifestId) throw new HttpsError('invalid-argument', 'manifestId required.');
  const existing = await root().collection('migrationManifests').doc(manifestId).get(); if (existing.exists) return existing.data();
  const [prelim, divisions] = await Promise.all([root().collection('prelimMatches').get(), root().collection('divisions').get()]); const items=[];
  for (const snap of prelim.docs) items.push({ path:snap.ref.path, classification:classify(snap.data()), fixedTeam:request.data?.fixedTeam ?? null });
  for (const division of divisions.docs) { const finals=await division.ref.collection('finalMatches').get(); finals.forEach((snap)=>items.push({path:snap.ref.path,classification:classify(snap.data()),fixedTeam:request.data?.fixedTeam ?? null})); }
  const unresolved=items.filter((item)=>item.classification === 'partial' || item.classification === 'invalid'); const data={manifestId, status:unresolved.length?'blocked':'ready', fixedTeam:request.data?.fixedTeam ?? null, items, unresolvedCount:unresolved.length, createdBy:uid, createdAt:FieldValue.serverTimestamp()}; await root().collection('migrationManifests').doc(manifestId).create(data); return { ...data, createdAt: null };
}
export async function applyMigrationManifest(request) {
  await requireAdmin(request); const manifestId=request.data?.manifestId; const manifestRef=root().collection('migrationManifests').doc(manifestId);
  return db().runTransaction(async(tx)=>{const snap=await tx.get(manifestRef); if(!snap.exists) throw new HttpsError('not-found','Manifest not found.'); const data=snap.data(); if(data.status==='applied') return {manifestId,applied:true}; if(data.status!=='ready' || data.unresolvedCount) throw new HttpsError('failed-precondition','Unresolved migration entries must be fixed first.'); tx.update(manifestRef,{status:'applied',appliedAt:FieldValue.serverTimestamp()}); return {manifestId,applied:true};});
}

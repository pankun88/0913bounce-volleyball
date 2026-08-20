import {
  collection, doc, setDoc, addDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot, query, orderBy, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { TOURNAMENT_ID } from "./firebase-config.js";
import { evaluatePrelimMatch } from "./match-logic.js";
import { generateRoundRobin } from "./schedule.js";
import { generateBracket } from "./bracket.js";

const TID = TOURNAMENT_ID;

const tDoc = () => doc(db, "tournaments", TID);
const groupsCol = () => collection(db, "tournaments", TID, "groups");
const teamsCol = () => collection(db, "tournaments", TID, "teams");
const prelimCol = () => collection(db, "tournaments", TID, "prelimMatches");
const finalCol = () => collection(db, "tournaments", TID, "finalMatches");

// ---------- 대회 설정 ----------

export async function saveTournamentInfo(data) {
  await setDoc(tDoc(), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}

export function subscribeTournamentInfo(cb) {
  return onSnapshot(tDoc(), (snap) => cb(snap.exists() ? snap.data() : null));
}

// ---------- 조 ----------

export async function addGroup(name) {
  await addDoc(groupsCol(), { name, order: Date.now() });
}

export async function deleteGroup(id) {
  await deleteDoc(doc(groupsCol(), id));
}

export function subscribeGroups(cb) {
  return onSnapshot(query(groupsCol(), orderBy("order")), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// ---------- 팀 ----------

export async function addTeam(name, groupId) {
  await addDoc(teamsCol(), { name, groupId: groupId || null, order: Date.now(), advanced: false });
}

export async function updateTeam(id, data) {
  await updateDoc(doc(teamsCol(), id), data);
}

export async function deleteTeam(id) {
  await deleteDoc(doc(teamsCol(), id));
}

export function subscribeTeams(cb) {
  return onSnapshot(query(teamsCol(), orderBy("order")), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// ---------- 예선 ----------

/** 해당 조의 기존 예선 경기를 모두 지우고 라운드로빈 일정을 새로 만든다 */
export async function generatePrelimMatchesForGroup(groupId, teamIds) {
  const existing = await getDocs(prelimCol());
  const batch = writeBatch(db);
  existing.docs.forEach((d) => {
    if (d.data().groupId === groupId) batch.delete(d.ref);
  });
  const pairs = generateRoundRobin(teamIds);
  pairs.forEach((p) => {
    const ref = doc(prelimCol());
    batch.set(ref, {
      groupId,
      teamA: p.teamA,
      teamB: p.teamB,
      round: p.round,
      sets: [],
      status: "pending",
      result: null,
      createdAt: Date.now(),
    });
  });
  await batch.commit();
}

export async function updatePrelimMatchSets(matchId, sets) {
  const evald = evaluatePrelimMatch(sets);
  await updateDoc(doc(prelimCol(), matchId), {
    sets,
    status: evald.status,
    result: evald.result,
    setsWonA: evald.setsWonA,
    setsWonB: evald.setsWonB,
    pointsForA: evald.pointsForA,
    pointsForB: evald.pointsForB,
  });
}

export function subscribePrelimMatches(cb) {
  return onSnapshot(prelimCol(), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// ---------- 본선 ----------

/** 기존 본선 대진표를 모두 지우고 새로 생성한다 */
export async function generateFinalBracket(teamsInSeedOrder) {
  const existing = await getDocs(finalCol());
  const batch = writeBatch(db);
  existing.docs.forEach((d) => batch.delete(d.ref));

  const { matches } = generateBracket(teamsInSeedOrder);
  matches.forEach((m) => {
    batch.set(doc(finalCol(), m.id), m);
  });
  await batch.commit();
}

export async function saveFinalMatches(matches) {
  const batch = writeBatch(db);
  matches.forEach((m) => {
    batch.set(doc(finalCol(), m.id), m, { merge: true });
  });
  await batch.commit();
}

export function subscribeFinalMatches(cb) {
  return onSnapshot(finalCol(), (snap) => {
    cb(snap.docs.map((d) => d.data()));
  });
}

export async function clearFinalBracket() {
  const existing = await getDocs(finalCol());
  const batch = writeBatch(db);
  existing.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

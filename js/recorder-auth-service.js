import {
  GoogleAuthProvider, browserSessionPersistence, getRedirectResult, onAuthStateChanged,
  setPersistence, signInWithPopup, signInWithRedirect, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { auth, db, functions } from "./firebase-init.js";
import { TOURNAMENT_ID } from "./firebase-config.js";

const google = "google.com";
const timestampMs = (value) => value?.toMillis?.() ?? 0;
const provider = () => new GoogleAuthProvider().setCustomParameters({ prompt: "select_account" });

function state(user, root, challenge, grant, admin, activeProvider, offline = false) {
  if (offline) return { kind: "offline", user, ready: false };
  if (!user) return { kind: "signedOut", user: null, ready: false };
  if (activeProvider !== google && !admin) return { kind: "wrongProvider", user, ready: false };
  if (root?.maintenance?.enabled === true) return { kind: "maintenance", user, ready: false };
  if (root?.recorderFeatureEnabled !== true || challenge?.enabled !== true) return { kind: "disabled", user, ready: false };
  if (!grant) return { kind: "codeRequired", user, ready: false, codeSource: "대회 공용 코드" };
  if (grant.uid !== user.uid || grant.status !== "active" || grant.version !== challenge?.version || timestampMs(grant.expiresAt) <= Date.now()) {
    return { kind: "staleGrant", user, ready: false, codeSource: "대회 공용 코드" };
  }
  return { kind: "ready", user, ready: true, grantVersion: grant.version, codeSource: "대회 공용 코드" };
}

export function watchRecorderAuthState(cb) {
  let stops = []; let active = true; let latestUser = null; let authGeneration = 0; let expiryTimer = null; let recompute = () => {};
  const clear = () => { stops.forEach((stop) => stop()); stops = []; if (expiryTimer) window.clearTimeout(expiryTimer); expiryTimer = null; };
  const emit = (value) => { if (active) cb(value); };
  const stopAuth = onAuthStateChanged(auth, async (user) => {
    const generation = ++authGeneration;
    clear(); latestUser = user;
    if (!user) { emit(state(null)); return; }
    let root; let challenge; let grant; let admin; let failed = false;
    let activeProvider = "";
    const loaded = { root: false, challenge: false, grant: false, admin: false, provider: false };
    const update = () => {
      if (!active || auth.currentUser?.uid !== user.uid) return;
      if (!Object.values(loaded).every(Boolean)) {
        emit({ kind: "loading", user, ready: false });
        return;
      }
      const next = failed ? { kind: navigator.onLine ? "error" : "offline", user, ready: false } : state(user, root, challenge, grant, admin, activeProvider);
      emit(next);
      if (expiryTimer) window.clearTimeout(expiryTimer);
      expiryTimer = null;
      if (next.kind === "ready") {
        expiryTimer = window.setTimeout(update, Math.max(1, timestampMs(grant.expiresAt) - Date.now() + 50));
      }
    };
    recompute = update;
    const watch = (key, path, assign) => onSnapshot(doc(db, ...path), (snap) => {
      assign(snap.exists() ? snap.data() : null);
      loaded[key] = true;
      update();
    }, () => {
      loaded[key] = true;
      failed = true;
      update();
    });
    try {
      activeProvider = (await user.getIdTokenResult()).signInProvider || "";
    } catch {
      failed = true;
    }
    if (!active || generation !== authGeneration || auth.currentUser?.uid !== user.uid) return;
    loaded.provider = true;
    stops = [
      watch("root", ["tournaments", TOURNAMENT_ID], (value) => { root = value; }),
      watch("challenge", ["tournaments", TOURNAMENT_ID, "recorderAccessChallenge", "current"], (value) => { challenge = value; }),
      watch("grant", ["tournaments", TOURNAMENT_ID, "recorderGrants", user.uid], (value) => { grant = value; }),
      watch("admin", ["tournaments", TOURNAMENT_ID, "admins", user.uid], (value) => { admin = Boolean(value); }),
    ];
    update();
  });
  const online = () => {
    if (!latestUser) return;
    recompute();
  };
  const offline = () => emit({ kind: "offline", user: auth.currentUser, ready: false });
  window.addEventListener("online", online); window.addEventListener("offline", offline);
  getRedirectResult(auth).catch((error) => emit({ kind: "error", user: auth.currentUser, ready: false, error }));
  return () => { active = false; clear(); stopAuth(); window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
}

export async function loginWithGoogle() {
  await setPersistence(auth, browserSessionPersistence);
  try { return await signInWithPopup(auth, provider()); }
  catch (error) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error.code)) {
      await signInWithRedirect(auth, provider());
      return null;
    }
    throw error;
  }
}
export async function exchangeRecorderAccessCode(code) {
  if (!auth.currentUser) throw Object.assign(new Error("Google 로그인이 필요합니다."), { code: "auth/google-login-required" });
  if (!/^[A-Za-z0-9_-]{24}$/.test(code.trim())) throw Object.assign(new Error("접근 코드는 24자 영문·숫자·-_ 형식입니다."), { code: "functions/invalid-argument" });
  return (await httpsCallable(functions, "exchangeRecorderAccessCode")({ tournamentId: TOURNAMENT_ID, code: code.trim() })).data;
}
export const logoutRecorder = () => signOut(auth);
export function describeRecorderAuthError(error) {
  const code = error?.code || "";
  if (code.includes("popup-closed")) return "Google 로그인을 취소했습니다.";
  if (code.includes("popup-blocked")) return "팝업이 차단되었습니다. 리디렉션 로그인을 사용하세요.";
  if (code.includes("code_invalid")) return "접근 코드를 확인하세요.";
  if (code.includes("code_rate_limited")) return "코드 입력이 잠시 제한되었습니다.";
  if (code.includes("grant_revoked") || error?.details?.reason === "grant_revoked" || /grant_revoked/.test(error?.message || "")) return "이 계정의 기록관 권한이 폐기되었습니다. 운영진에게 문의하세요.";
  if (code.includes("network") || code.includes("unavailable")) return "네트워크 연결을 확인하세요.";
  return error?.message || "인증 처리 중 오류가 발생했습니다.";
}

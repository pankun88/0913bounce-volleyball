// 기록관은 Google 로그인과 현재 접근 코드 grant를 모두 충족할 때만 준비 상태가 된다.
import {
  GoogleAuthProvider,
  browserSessionPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { auth, db, functions } from "./firebase-init.js";

export const TOURNAMENT_ID = "main";

const GOOGLE_PROVIDER_ID = "google.com";

function isGoogleUser(user) {
  return Boolean(user?.providerData?.some((provider) => provider.providerId === GOOGLE_PROVIDER_ID));
}

function recorderState(user, challenge, grant, tournamentEnabled) {
  const grantVersion = Number.isInteger(grant?.version) ? grant.version : null;
  const challengeVersion = Number.isInteger(challenge?.version) ? challenge.version : null;
  const ready = Boolean(
    user
    && isGoogleUser(user)
    && tournamentEnabled === true
    && challenge?.enabled === true
    && grant?.uid === user.uid
    && grantVersion !== null
    && grantVersion === challengeVersion,
  );

  return {
    user: user || null,
    ready,
    grantVersion,
  };
}

/**
 * Google 사용자, 공개된 현재 access version, 그리고 자기 grant를 함께 관찰한다.
 * 버전 변경·폐기·권한 오류는 모두 ready=false로 fail closed 처리한다.
 */
export function watchRecorderAuthState(cb) {
  let stopGrant = () => {};
  let stopChallenge = () => {};
  let stopTournament = () => {};
  let active = true;

  const stopAuth = onAuthStateChanged(auth, (user) => {
    stopGrant();
    stopChallenge();
    stopTournament();
    stopGrant = () => {};
    stopChallenge = () => {};
    stopTournament = () => {};

    if (!user || !isGoogleUser(user)) {
      cb(recorderState(user, null, null, false));
      return;
    }

    const uid = user.uid;
    let challenge = null;
    let grant = null;
    let tournamentEnabled = false;
    const emit = () => {
      if (!active || auth.currentUser?.uid !== uid) return;
      cb(recorderState(auth.currentUser, challenge, grant, tournamentEnabled));
    };

    stopTournament = onSnapshot(
      doc(db, "tournaments", TOURNAMENT_ID),
      (snapshot) => {
        tournamentEnabled = snapshot.exists() && snapshot.data().recorderFeatureEnabled === true;
        emit();
      },
      () => {
        tournamentEnabled = false;
        emit();
      },
    );
    stopChallenge = onSnapshot(
      doc(db, "tournaments", TOURNAMENT_ID, "recorderAccessChallenge", "current"),
      (snapshot) => {
        challenge = snapshot.exists() ? snapshot.data() : null;
        emit();
      },
      () => {
        challenge = null;
        emit();
      },
    );
    stopGrant = onSnapshot(
      doc(db, "tournaments", TOURNAMENT_ID, "recorderGrants", uid),
      (snapshot) => {
        grant = snapshot.exists() ? snapshot.data() : null;
        emit();
      },
      () => {
        grant = null;
        emit();
      },
    );
  });

  return () => {
    active = false;
    stopGrant();
    stopChallenge();
    stopTournament();
    stopAuth();
  };
}

export async function loginWithGoogle() {
  await setPersistence(auth, browserSessionPersistence);
  return signInWithPopup(auth, new GoogleAuthProvider());
}

/**
 * 코드 원문은 Callable 요청에만 사용하며 브라우저 저장소나 반환값에 남기지 않는다.
 */
export async function exchangeRecorderAccessCode(code) {
  const user = auth.currentUser;
  if (!isGoogleUser(user)) {
    const err = new Error("Google 로그인이 필요합니다.");
    err.code = "auth/google-login-required";
    throw err;
  }
  if (typeof code !== "string" || !code.trim()) {
    const err = new Error("접근 코드를 입력하세요.");
    err.code = "functions/invalid-argument";
    throw err;
  }

  const result = await httpsCallable(functions, "exchangeRecorderAccessCode")({
    tournamentId: TOURNAMENT_ID,
    code: code.trim(),
  });
  const data = result?.data;
  if (
    !data
    || data.tournamentId !== TOURNAMENT_ID
    || !Number.isInteger(data.grantVersion)
    || data.grantVersion < 1
  ) {
    const err = new Error("접근 권한 확인 응답이 올바르지 않습니다.");
    err.code = "functions/internal";
    throw err;
  }

  const response = {
    tournamentId: TOURNAMENT_ID,
    grantVersion: data.grantVersion,
  };
  if (data.expiresAt !== undefined) response.expiresAt = data.expiresAt;
  return response;
}

export async function logoutRecorder() {
  await signOut(auth);
}

export function describeRecorderAuthError(err) {
  const code = err?.code || "";
  if (code.includes("popup-closed-by-user")) return "Google 로그인을 취소했습니다.";
  if (code.includes("popup-blocked")) return "팝업이 차단되었습니다. 브라우저에서 팝업을 허용해주세요.";
  if (code.includes("account-exists-with-different-credential")) {
    return "다른 로그인 방법으로 등록된 이메일입니다.";
  }
  if (code.includes("google-login-required")) return "Google 로그인이 필요합니다.";
  if (code.includes("permission-denied") || code.includes("unauthenticated")) {
    return "기록관 접근 권한이 없습니다.";
  }
  if (code.includes("invalid-argument")) return "접근 코드를 확인해주세요.";
  if (code.includes("failed-precondition")) return "현재 기록관 접근이 허용되지 않았습니다.";
  if (code.includes("unavailable") || code.includes("network-request-failed")) {
    return "네트워크 오류로 요청에 실패했어요. 인터넷 연결을 확인해주세요.";
  }
  return "처리 중 오류가 발생했습니다." + (code ? ` (${code})` : "");
}

// 관리자 페이지 로그인/로그아웃/비밀번호 재설정을 담당하는 모듈.
// Firebase Authentication(이메일/비밀번호) 사용 — 대시보드(공개 읽기)는 영향 없음.
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  setPersistence,
  browserSessionPersistence,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";

const TOURNAMENT_ID = "main";

function adminMembershipRef(uid) {
  return doc(db, "tournaments", TOURNAMENT_ID, "admins", uid);
}

/** 로그인 상태가 바뀔 때마다 cb(user|null)를 호출한다. 같은 탭에서 새로고침해도
 *  로그인은 유지되지만, 브라우저(탭)를 완전히 닫으면 세션이 사라져 다시 로그인해야 한다.
 *  인증 사용자라도 seeded admins/{uid} membership이 없으면 null을 전달한다. */
export function watchAuthState(cb) {
  let stopMembership = () => {};
  let active = true;

  const stopAuth = onAuthStateChanged(auth, (user) => {
    stopMembership();
    stopMembership = () => {};

    if (!user) {
      cb(null);
      return;
    }

    const uid = user.uid;
    stopMembership = onSnapshot(
      adminMembershipRef(uid),
      (membership) => {
        if (!active || auth.currentUser?.uid !== uid) return;
        cb(membership.exists() ? auth.currentUser : null);
      },
      () => {
        if (!active || auth.currentUser?.uid !== uid) return;
        cb(null);
      },
    );
  });

  return () => {
    active = false;
    stopMembership();
    stopAuth();
  };
}

export async function login(email, password) {
  // 브라우저를 닫으면 로그아웃되도록 세션 단위 persistence를 사용한다.
  await setPersistence(auth, browserSessionPersistence);
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const membership = await getDoc(adminMembershipRef(credential.user.uid));
  if (!membership.exists()) {
    await signOut(auth);
    const err = new Error("관리자 권한이 없는 계정입니다.");
    err.code = "auth/not-admin";
    throw err;
  }
}

export async function logout() {
  await signOut(auth);
}

/** 등록된 이메일로 비밀번호 재설정 링크를 보낸다. (Firebase가 메일 발송까지 처리) */
export async function requestPasswordReset(email) {
  await sendPasswordResetEmail(auth, email);
}

/** 로그인된 상태에서 현재 비밀번호를 확인한 뒤 새 비밀번호로 바꾼다(관리자 페이지 내 직접 변경용).
 *  보안을 위해 비밀번호를 바꾸기 전에 현재 비밀번호로 재인증을 먼저 거친다. */
export async function changePassword(currentPassword, newPassword) {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error("로그인이 필요합니다.");
  }
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, newPassword);
}

/** Firebase Auth 에러 코드를 사용자에게 보여줄 한국어 메시지로 변환한다. */
export function describeAuthError(err) {
  const code = err && err.code ? err.code : "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "이메일 또는 비밀번호가 올바르지 않습니다.";
  }
  if (code.includes("too-many-requests")) {
    return "너무 많이 시도했어요. 잠시 후 다시 시도해주세요.";
  }
  if (code.includes("invalid-email")) {
    return "올바른 이메일 형식이 아닙니다.";
  }
  if (code.includes("weak-password")) {
    return "비밀번호는 6자 이상으로 입력하세요.";
  }
  if (code.includes("requires-recent-login")) {
    return "보안을 위해 다시 로그인한 뒤 시도해주세요.";
  }
  if (code.includes("network-request-failed")) {
    return "네트워크 오류로 요청에 실패했어요. 인터넷 연결을 확인해주세요.";
  }
  if (code.includes("not-admin") || code.includes("permission-denied")) {
    return "관리자 권한이 없는 계정입니다.";
  }
  return "처리 중 오류가 발생했습니다." + (code ? ` (${code})` : "");
}

// ⚠️ Firebase 콘솔 > 프로젝트 설정 > 일반 > 내 앱(웹) > SDK 설정 및 구성 에서
// 아래 6개 값을 복사해 붙여넣으세요. (Firestore Database를 미리 생성해두어야 합니다)
export const firebaseConfig = {
  apiKey: "AIzaSyAQvcnhBOVvEtWDzNR0kQ-GP6AzdwriSqQ",
  authDomain: "bounce-0913-edu-cup-2026.firebaseapp.com",
  projectId: "bounce-0913-edu-cup-2026",
  storageBucket: "bounce-0913-edu-cup-2026.firebasestorage.app",
  messagingSenderId: "597078666146",
  appId: "1:597078666146:web:82506fb2476afb997060fb",
};

// 이 배포는 Rules·Functions와 함께 단일 대회 루트 `main`에 고정되어 있다.
// 클라이언트에서 이 값만 바꾸면 서버와 권한 경계가 분리되므로 변경하지 않는다.
export const TOURNAMENT_ID = "main";

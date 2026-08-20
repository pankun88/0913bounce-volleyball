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

// 한 대회 단위로 데이터를 구분하는 ID. 같은 Firebase 프로젝트로 여러 대회를
// 운영하려면 대회마다 다른 문자열로 바꿔서 사용하세요.
export const TOURNAMENT_ID = "main";

// ⚠️ Firebase 콘솔 > 프로젝트 설정 > 일반 > 내 앱(웹) > SDK 설정 및 구성 에서
// 아래 6개 값을 복사해 붙여넣으세요. (Firestore Database를 미리 생성해두어야 합니다)
export const firebaseConfig = {
  apiKey: "AIzaSyAEYhHTVOovIYcJ089E0AEyteJn_5n5F_U",
  authDomain: "bbounce-cdb31.firebaseapp.com",
  projectId: "bbounce-cdb31",
  storageBucket: "bbounce-cdb31.firebasestorage.app",
  messagingSenderId: "869407492572",
  appId: "1:869407492572:web:85f4565ce83219c9b36719",
};

// 한 대회 단위로 데이터를 구분하는 ID. 같은 Firebase 프로젝트로 여러 대회를
// 운영하려면 대회마다 다른 문자열로 바꿔서 사용하세요.
export const TOURNAMENT_ID = "main";

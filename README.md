# 바운스발리볼 대진표 웹앱

고정 Firebase 프로젝트 **`bounce-0913-edu-cup-2026`**의 단일 대회 **`main`**을 운영하는 관리자·기록관·관객용 웹앱입니다.

- 관리자: `https://bounce-0913-edu-cup-2026.web.app/admin.html`
- 기록관: `https://bounce-0913-edu-cup-2026.web.app/recorder.html`
- 대시보드: `https://bounce-0913-edu-cup-2026.web.app/dashboard.html`

## 준비

필수 도구는 Node.js 22, Java 21, Python 3입니다. Java는 Firebase Emulator 실행에 필요하고 Python은 로컬 정적 서버에 사용합니다.

의존성은 lockfile대로만 설치합니다.

```bash
npm ci
npm --prefix functions ci
```

로컬 화면은 다음으로 열 수 있습니다.

```bash
python3 -m http.server 8765
```

`http://localhost:8765/admin.html`로 접속합니다. `file://`로 HTML을 직접 열지 마세요.

## Firebase Console 초기 설정

프로젝트는 새로 만들거나 설정값을 교체하지 말고 **`bounce-0913-edu-cup-2026`**를 사용합니다.

1. Firebase Console에서 이 프로젝트의 Firestore Database를 활성화합니다.
2. **Authentication > Sign-in method**에서 관리자용 **Email/Password**와 기록관용 **Google** 공급자를 활성화합니다.
3. **Authentication > Settings > Authorized domains**에 `bounce-0913-edu-cup-2026.web.app`, `bounce-0913-edu-cup-2026.firebaseapp.com`, `localhost` 및 실제 사용하는 사용자 정의 도메인을 등록합니다.
4. 관리자 이메일/비밀번호 계정을 Authentication에서 만듭니다. 해당 계정의 UID를 확인합니다.
5. 신뢰할 수 있는 Firebase Admin SDK 또는 Console의 Firestore 데이터 편집기로 `tournaments/main` 문서와 `tournaments/main/admins/{관리자 UID}` 문서를 한 번만 부트스트랩합니다. `admins/{UID}` 문서는 빈 객체여도 됩니다. 이 경로는 관리자 권한의 신뢰 루트이므로 일반 클라이언트 쓰기로 만들지 않습니다.

관리자 계정으로 `admin.html`에 로그인한 뒤 대회 설정을 입력합니다. 기록관은 `recorder.html`에서 Google 로그인 후, 관리자가 발급한 현재 대회 접근 코드를 입력해야 합니다. 관리자는 접근 코드를 교체하거나 폐기할 수 있으며, 폐기 후에는 새 코드가 필요합니다.

## 검사

```bash
npm run test:unit
npm run test:emulator
npm run test:release
```

## 배포

Firebase CLI는 프로젝트의 고정 버전을 사용합니다. Google 계정으로 로그인한 뒤 다음 명령을 그대로 실행합니다.

```bash
npx firebase login
npx firebase deploy --project bounce-0913-edu-cup-2026 --only hosting,functions,firestore:rules,firestore:indexes
```

배포 전에는 현재 프로젝트와 단일 대회 `main`을 유지하는지 확인합니다. Hosting, Functions, Rules, Indexes는 함께 배포합니다.

## 백업과 정확 복원

관리자 화면에서 백업을 내려받고 안전한 별도 위치에 보관합니다. 복원은 관리자 로그인과 `tournaments/main/admins/{UID}` 멤버십이 필요하며, 유지보수 잠금 아래에서 기존 사업 문서를 정확히 교체합니다.

휴대용 백업은 **v3 전용**입니다. Firestore Timestamp는 JSON 안전 태그로 저장되고 복원 시 Firestore Timestamp로 되돌아갑니다. 체크섬은 이 인코딩 표현을 대상으로 하며, 알 수 없는 태그·프로토타입·지원하지 않는 값은 복원 전에 거부됩니다. 인증 정보, 관리자 멤버십, 기록관 접근 코드는 백업하거나 복원하지 않습니다.

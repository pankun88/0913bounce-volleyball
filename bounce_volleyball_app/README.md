# 바운스발리볼 대진표 웹앱

관리자 페이지(`admin.html`)에서 경기 결과를 입력하면 실시간 대시보드(`dashboard.html`)에 바로 반영됩니다.
Firebase(Firestore)로 동기화하며, Firebase Hosting으로 인터넷 주소(URL)에 배포할 수 있습니다.

## 1. Firebase 프로젝트 준비

1. https://console.firebase.google.com 에서 프로젝트를 엽니다(없으면 새로 만들기).
2. 왼쪽 메뉴 **빌드 > Firestore Database** 에서 데이터베이스를 생성합니다(테스트 모드로 시작해도 됩니다).
3. **프로젝트 설정(⚙️) > 일반 > 내 앱** 에서 웹 앱을 추가하고, 표시되는 `firebaseConfig` 값을 복사합니다.
4. `js/firebase-config.js` 파일을 열어 `YOUR_API_KEY` 등 6개 값을 방금 복사한 값으로 교체합니다.

## 1.5 연결 테스트 (선택)

`connection-test.html` 을 브라우저로 열면 `js/firebase-config.js` 값으로 실제 Firestore 쓰기·읽기·삭제가 되는지 바로 확인할 수 있습니다 (배포 전/후 모두 사용 가능). 실패하면 화면에 원인(설정값 오타, Firestore Database 미생성, 보안 규칙 미배포 등)이 표시됩니다.

## 2. 배포 (Firebase Hosting)

터미널에서 이 폴더로 이동한 뒤:

```bash
npm install -g firebase-tools   # 처음 한 번만
firebase login                  # 구글 계정으로 로그인
```

`.firebaserc` 파일의 `YOUR_PROJECT_ID`를 본인의 Firebase 프로젝트 ID로 바꾼 뒤:

```bash
firebase deploy --only hosting,firestore:rules
```

배포가 끝나면 터미널에 `https://프로젝트ID.web.app` 형태의 주소가 나옵니다.
- `https://프로젝트ID.web.app/admin.html` → 관리자 페이지 (대회 진행자만 사용, 외부 공유 금지)
- `https://프로젝트ID.web.app/dashboard.html` → 관객 공유용 실시간 대시보드

수정할 때마다 같은 `firebase deploy --only hosting` 명령으로 다시 배포하면 됩니다.

> 로그인 기능 없이 누구나 쓸 수 있게 만든 간단한 도구입니다. 관리자 페이지 주소는 관계자에게만 알려주세요.

## 3. 사용 방법

### 대회설정 탭
1. 대회명을 입력하고 저장합니다.
2. 조(1조, 2조 …)를 추가합니다.
3. 팀 이름을 입력하고 소속 조를 선택해 팀을 등록합니다.

### 예선 탭
1. 각 조마다 "일정 생성" 버튼을 누르면 조 내 모든 팀이 한 번씩 맞붙는 라운드로빈 일정이 만들어집니다.
2. 경기마다 "점수 입력"으로 세트 점수를 넣으면 승점/순위가 자동 계산됩니다(승3·무1·패0, 세트득실→득실차→승자승 순으로 순위 결정. 모두 동률이면 "동률·추첨필요" 표시가 뜨며 추첨은 직접 진행해 주세요).

### 본선 탭
1. 좌측에서 본선 진출팀을 체크합니다(예선 순위가 참고용으로 표시됩니다).
2. 우측 시드 순서를 화살표로 조정합니다(1번 시드가 대진표에서 가장 유리한 위치에 배정됩니다).
3. "대진표 생성"을 누르면 4~32팀 어떤 인원이어도 자동으로 대진표(부전승 포함)와 3·4위전이 만들어집니다.
4. 각 경기 박스의 "점수 입력"으로 세트 점수를 넣으면 승자가 자동으로 다음 라운드에 배정됩니다.

### 결과 내보내기
대회설정 탭 하단의 "전체 결과 CSV 다운로드"로 예선 순위·경기결과·본선 결과를 하나의 CSV 파일로 저장할 수 있습니다 (엑셀에서 한글 깨짐 없이 열립니다).

## 경기 규칙 (자동 적용됨)

- 예선: 2세트제, 1·2세트 모두 10점. 1세트씩 나눠 가지면(1:1) 무승부.
- 본선: 3세트제, 1·2세트 10점, 3세트(필요시) 7점. 2세트 먼저 따면 경기 종료.
- 듀스는 2점차 승리, 15점 도달 시 즉시 종료(상한).
- 예선 순위: 승점 → 세트득실 → 득실차 → 승자승 → (그래도 동률이면 추첨, 화면에 표시됨).

## 폴더 구조

```
admin.html / dashboard.html / index.html
css/style.css, css/bracket.css
js/match-logic.js   세트·경기 판정, 조 순위 계산
js/schedule.js       예선 라운드로빈 일정 생성
js/bracket.js        본선 대진표 생성/진행(부전승, 3·4위전)
js/bracket-render.js 대진표 화면 렌더링(관리자/대시보드 공용)
js/csv-export.js     CSV 내보내기
js/firestore-service.js  Firestore 데이터 연동
js/firebase-config.js    ⚠️ Firebase 설정값 (직접 입력 필요)
js/test.mjs          핵심 로직 단위 테스트 (node js/test.mjs)
```

# 바운스발리볼 대진표 웹앱

Firebase 프로젝트 **`bounce-0913-edu-cup-2026`**의 단일 대회 **`main`**을 운영하는 관리자·기록관·관객용 웹앱입니다. 브라우저용 Firebase 설정과 대회 ID는 [`js/firebase-config.js`](js/firebase-config.js)에 고정되어 있습니다.

## 배포 화면

- 관리자: <https://bounce-0913-edu-cup-2026.web.app/admin.html>
- 기록관: <https://bounce-0913-edu-cup-2026.web.app/recorder.html>
- 관객 대시보드: <https://bounce-0913-edu-cup-2026.web.app/dashboard.html?display=venue&tab=prelim>

## 문서 안내

| 문서 | 용도 |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | 경기 규칙과 기본 도메인 요구사항 |
| [`개발_워크플로우_가이드.md`](개발_워크플로우_가이드.md) | 설치, 로컬 실행, 공유 경기 로직, 에뮬레이터 검사, 인증 초기화, 승인된 배포 절차 |
| [`인수인계_노트.md`](인수인계_노트.md) | 현재 운영 상태, 최신 배포·복구 절차, 운영자 주의사항 |
| [`문제해결기록.md`](문제해결기록.md) | 과거 버그와 수정의 역사적 기록 |

규칙·운영 상태·과거 해결책은 위 문서에서 확인하고 이 README에는 반복해서 적지 않습니다.

## 주요 구성

- `admin.html` — 대회 설정, 예선·본선, 기록·검수 관리
- `recorder.html` — Google 로그인과 대회 접근 코드로 사용하는 기록관 화면
- `dashboard.html` — 관객용 실시간 공개 화면
- `js/` — 브라우저 UI와 Firebase 클라이언트
- `functions/` — 서버 검증과 워크플로 함수
- `firestore.rules`, `firestore.indexes.json`, `firebase.json` — 데이터 권한·인덱스·호스팅/에뮬레이터 구성
- `test/`, `functions/test/` — 자동 검사 모음

처음 개발하거나 검사·배포할 때는 [개발 워크플로우 가이드](개발_워크플로우_가이드.md)를 먼저 읽고, 운영 변경은 [인수인계 노트](인수인계_노트.md)를 따릅니다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GENERIC_ERROR_MESSAGE, REASON_MESSAGES, describeError, koreanErrorMessage } from './error-messages.js';

const hasHangul = (text) => /[가-힣]/.test(text);
const hasEnglishWord = (text) => /[A-Za-z]{4,}/.test(text.replace(/Google/g, ''));

// reason 코드: details.reason, message 단독, 문장 속에 섞인 경우 모두 같은 한국어 문장.
for (const [reason, text] of Object.entries(REASON_MESSAGES)) {
  assert.ok(hasHangul(text), reason);
  assert.equal(koreanErrorMessage({ code: 'functions/aborted', message: reason, details: { reason } }), text);
  assert.equal(koreanErrorMessage({ message: reason }), text, `${reason} as message`);
}
assert.equal(koreanErrorMessage({ message: 'internal: lease_expired' }), REASON_MESSAGES.lease_expired);

// 부전승 코드
assert.match(koreanErrorMessage({ message: 'bye_reason_required: x' }), /메모/);

// 한국어 서버 문구는 그대로
assert.equal(koreanErrorMessage({ message: '이미 결과가 기록된 경기는 새 기록관 대기열에 배정할 수 없습니다.' }), '이미 결과가 기록된 경기는 새 기록관 대기열에 배정할 수 없습니다.');

// 알 수 없는 영어는 숨기고 일반 문구, known=false
for (const error of [new Error('Some brand new server failure.'), { code: 'functions/internal', message: 'INTERNAL' }, 'weird', null, undefined, {}]) {
  const result = describeError(error);
  assert.equal(result.text, GENERIC_ERROR_MESSAGE);
  assert.equal(result.known, false);
}
assert.equal(GENERIC_ERROR_MESSAGE, '처리하지 못했습니다. 잠시 후 다시 시도하고, 계속되면 운영본부에 알려 주세요.');

// 네트워크·권한 코드
assert.match(koreanErrorMessage({ code: 'functions/unavailable', message: 'Service unavailable' }), /인터넷 연결/);
assert.match(koreanErrorMessage({ code: 'functions/deadline-exceeded', message: 'deadline-exceeded' }), /인터넷 연결/);
assert.match(koreanErrorMessage({ message: 'Failed to fetch' }), /인터넷 연결/);
assert.match(koreanErrorMessage({ code: 'functions/unauthenticated', message: 'unauthenticated' }), /로그인/);
assert.match(koreanErrorMessage({ code: 'functions/permission-denied', message: 'permission-denied' }), /권한/);
assert.match(koreanErrorMessage({ code: 'functions/aborted', message: 'aborted' }), /새로 고친 뒤/);

// 마침표·정규식 규칙: 대표 대회 당일 메시지
const samples = {
  'Authentication required.': /로그인/,
  'Current recorder grant required.': /대회 공용 코드/,
  'Submission version changed.': /기록·검수/,
  'Official revision changed.': /새로 고친 뒤/,
  'A correction reason is required.': /사유/,
  'Court queue changed. Refresh and try again.': /새로 고친 뒤/,
  'Stale recorder ownership or queue revision.': /입력 다시 시작/,
  'No active lock to release.': /해제/,
  'Tournament maintenance is active.': /점검/,
  'Final assignment is not publishable.': /본선/,
  'Preliminary match has official history: m-1.': /점수 수정/,
  'Live recorder lock must remain with 김기록.': /잠금 강제 해제/,
  'Group has official or live preliminary history: g1.': /예선/,
};
for (const [message, expected] of Object.entries(samples)) {
  const text = koreanErrorMessage({ code: 'functions/failed-precondition', message });
  assert.match(text, expected, message);
  assert.ok(!hasEnglishWord(text), message);
}

// 서버 소스의 모든 영어 HttpsError/bad() 문구가 한국어로 바뀌어야 한다(일반 문구로 떨어지면 실패).
const sources = ['admin-workflow.js', 'index.js', 'public-schedule.js', 'restore.js', 'workflow-core.js']
  .map((name) => readFileSync(new URL(`../functions/${name}`, import.meta.url), 'utf8')).join('\n');
const messages = new Set();
for (const match of sources.matchAll(/HttpsError\(\s*['"][a-z-]+['"],\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) messages.add(match[2]);
for (const match of sources.matchAll(/\bbad\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) messages.add(match[2]);
const english = [...messages].filter((message) => !hasHangul(message))
  .map((message) => message.replace(/\$\{[^}]*\}/g, 'x1'));
assert.ok(english.length > 100, `expected >100 server messages, got ${english.length}`);
const unmapped = english.filter((message) => !describeError({ code: 'functions/failed-precondition', message }).known);
assert.deepEqual(unmapped, [], `unmapped server messages:\n${unmapped.join('\n')}`);
for (const message of english) {
  const text = koreanErrorMessage({ code: 'functions/failed-precondition', message });
  assert.ok(hasHangul(text) && !hasEnglishWord(text), `${message} -> ${text}`);
}
console.log(`error-messages: ${english.length} server messages mapped`);

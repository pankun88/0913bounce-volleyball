// 서버(Cloud Functions)의 HttpsError 문구는 영어입니다. 서버는 바꾸지 않고 화면에서 한국어로 바꿔 보여 줍니다.
// 각 문장은 「무슨 일이 있었는지 + 무엇을 눌러야 하는지」를 담습니다. 이 파일은 다른 모듈을 가져오지 않습니다(테스트에서 단독 실행).

export const GENERIC_ERROR_MESSAGE = "처리하지 못했습니다. 잠시 후 다시 시도하고, 계속되면 운영본부에 알려 주세요.";

const REFRESH = "화면을 새로 고친 뒤 다시 눌러 주세요.";
const BACKUP_KEPT = "기존 기록은 그대로 유지됩니다.";

// 서버가 details.reason(또는 message 자체)으로 보내는 코드.
export const REASON_MESSAGES = {
  code_invalid: "대회 공용 코드가 맞지 않습니다. 코드를 다시 확인해 입력해 주세요.",
  code_rate_limited: "코드를 여러 번 잘못 입력해 잠시 제한되었습니다. 잠시 기다린 뒤 다시 입력해 주세요.",
  grant_revoked: "이 계정의 기록관 권한이 폐기되었습니다. 운영본부에서 새 코드를 받아 다시 입력해 주세요.",
  lease_expired: "입력 시간이 끝났습니다. ‘입력 다시 시작’을 눌러 이어서 입력하세요.",
  operation_mismatch: `이전 요청과 달라 처리하지 못했습니다. ${REFRESH}`,
  ownership_lost: "다른 사람이나 다른 화면이 이 경기 입력을 이어받았습니다.",
  prelim_correction_after_finals: "본선 경기가 이미 진행되어, 순위가 바뀌는 예선 점수 수정은 할 수 없습니다. 대회 본부가 정정하기로 결정한 경우에만 ‘비상용 기능 보기’에서 처리하세요.",
  qualification_unverified: "본선 진출팀을 다시 확인해야 합니다. 관리자에게 확인을 요청하세요. (관리자는 ‘현재 순위로 확인’을 누른 뒤 진행)",
  recorder_name_changed: "담당 기록관 이름이 바뀌었습니다. 코트를 다시 선택해 주세요.",
  stale_queue: "경기 순서가 바뀌었습니다. 화면이 새로 바뀐 뒤 다시 눌러 주세요.",
  stale_revision: "다른 곳에서 먼저 저장한 점수가 있습니다. 화면의 안내에 따라 선택하세요.",
  submitted: "이미 제출된 경기입니다.",
  unresolved_teams: "대진이 확정되기를 기다리고 있습니다. 앞 경기가 끝난 뒤 다시 눌러 주세요.",
  downstream_final_history: "이 점수를 바꾸면 이미 진행된 다음 본선 경기와 맞지 않습니다. 본선 기록을 먼저 확인하세요.",
  downstream_final_workflow_history: "다음 본선 경기가 입력·검수 중이라 바꿀 수 없습니다. 그 경기를 마친 뒤 다시 시도하세요.",
  final_submission_changed: `검수한 제출 점수가 현재 기록과 다릅니다. ‘기록·검수’에서 최신 제출을 확인하고 다시 반영하세요. ${BACKUP_KEPT}`,
  final_workflow_busy: `입력·검수 중인 본선 경기는 바꿀 수 없습니다. 입력·검수를 마친 뒤 다시 공개하세요. ${BACKUP_KEPT}`,
  recorded_final_structure_changed: `기록이 있는 경기의 팀 자리나 대진 연결이 바뀌었습니다. 저장된 대진으로 복구하고 점수만 정정하세요. ${BACKUP_KEPT}`,
  prelim_changed: "예선 결과가 바뀌었습니다. ‘현재 순위로 확인’을 누른 뒤 다시 진행하세요.",
  maintenance: "대회 점검 중입니다. 점검이 끝난 뒤 다시 시도하세요.",
  recorder_access_required: "기록관 권한이 필요합니다. 대회 코드를 다시 입력하세요.",
};

// [정규식(마침표 뺀 영어 문구에 적용), 한국어 안내]
const MESSAGE_RULES = [
  // 로그인·권한·접근 코드
  [/^Authentication required$/i, "로그인이 필요합니다. 다시 로그인한 뒤 눌러 주세요."],
  [/^Google recorder sign-in required$/i, "Google 계정으로 로그인해야 합니다. ‘Google로 로그인’을 누르세요."],
  [/^Current recorder grant required$/i, "기록관 권한이 없거나 만료되었습니다. 대회 공용 코드를 다시 입력하세요."],
  [/^Recorder grant not found$/i, "이 계정의 기록관 권한을 찾지 못했습니다. 운영본부에 알려 주세요."],
  [/^Seeded administrator required$/i, "관리자 계정으로만 할 수 있습니다. 관리자 계정으로 로그인했는지 확인하세요."],
  [/^Access code does not exist$/i, "해당 접근 코드가 없습니다. 목록을 새로 고친 뒤 다시 확인하세요."],
  [/^Grant uid required$/i, `대상 기록관을 찾지 못했습니다. ${REFRESH}`],
  [/^Invalid grant cursor$/i, `기록관 목록 위치가 맞지 않습니다. ${REFRESH}`],
  [/^Only the same recorder can resume this draft$/i, "다른 기록관이 입력 중인 경기입니다. 같은 계정·같은 이름으로만 이어서 입력할 수 있습니다."],
  // 점검·초기화
  [/^Tournament maintenance is already active$/i, "이미 대회 점검 중입니다. 현재 점검이 끝난 뒤 다시 시도하세요."],
  [/^Tournament maintenance is active$/i, "대회 점검 중입니다. 점검이 끝난 뒤 다시 시도하세요."],
  [/^Cannot export a backup during maintenance$/i, "점검 중에는 백업을 내려받을 수 없습니다. 점검이 끝난 뒤 다시 시도하세요."],
  [/^Active reset can only be recovered by its owner or after 15 minutes$/i, "다른 관리자가 초기화를 진행 중입니다. 그 관리자가 끝내거나 15분이 지난 뒤 다시 시도하세요."],
  [/^Current reset owner and token required$/i, "초기화를 시작한 화면에서만 이어갈 수 있습니다. 처음부터 다시 시작하세요."],
  [/^Reset token required$/i, "초기화 확인 정보가 없습니다. 처음부터 다시 시작하세요."],
  [/^Reset execution was superseded$/i, "다른 초기화 작업이 먼저 진행되었습니다. 화면을 새로 고쳐 상태를 확인하세요."],
  [/^Tournament data deletion did not complete$/i, "데이터 삭제가 끝나지 않았습니다. 같은 초기화를 한 번 더 실행해 마무리하세요."],
  [/^Current tournament name required$/i, "현재 대회 이름을 정확히 입력해야 합니다."],
  [/^Tournament name changed\b.*/i, "대회 이름이 바뀌었습니다. 화면을 새로 고치고 이름을 다시 확인한 뒤 눌러 주세요."],
  [/^Unknown tournament$/i, "대회 정보를 찾지 못했습니다. 화면을 새로 고쳐 주세요."],
  [/^Tournament (root )?not found$/i, "대회 정보를 찾지 못했습니다. 화면을 새로 고쳐 주세요."],
  // 점수 제출·승인·정정
  [/^Score is required$/i, "점수가 입력되지 않았습니다. 세트 점수를 입력한 뒤 다시 눌러 주세요."],
  [/^Complete score required$/i, "빠진 세트 점수가 있습니다. 모든 세트 점수를 채운 뒤 다시 눌러 주세요."],
  [/^Score values must be integers$/i, "점수는 정수만 입력할 수 있습니다. 점수를 확인해 주세요."],
  [/^Score contains an incomplete or invalid set$/i, "규칙에 맞지 않거나 덜 입력된 세트가 있습니다. 점수를 다시 확인해 주세요."],
  [/^Score contains too many sets$/i, "세트 수가 규칙보다 많습니다. 점수를 다시 확인해 주세요."],
  [/^Sets after a final winner are not allowed$/i, "이미 승부가 난 뒤의 세트 점수가 들어 있습니다. 마지막 세트를 지우고 다시 확인하세요."],
  [/^Draft sets must be bounded integers$/i, "세트 점수는 0~15 사이의 정수여야 합니다. 점수를 확인해 주세요."],
  [/^Score drafts must be unique matchId, sets and reason records$/i, `수정 점수 정보가 올바르지 않습니다. ${REFRESH}`],
  [/^Score draft references an unknown final match$/i, `없는 본선 경기의 점수가 들어 있습니다. ${REFRESH}`],
  [/^Submission version changed$/i, "그사이 제출 내용이 바뀌었습니다. ‘기록·검수’를 새로 고쳐 최신 제출을 확인한 뒤 다시 처리하세요."],
  [/^Submission or queue revision changed$/i, "그사이 제출 내용이나 경기 순서가 바뀌었습니다. 화면을 새로 고쳐 최신 상태를 확인하세요."],
  [/^Only submitted reviews can be approved$/i, "제출된 점수만 승인할 수 있습니다. 이미 처리된 경기일 수 있으니 목록을 새로 고치세요."],
  [/^Only submitted reviews can be rejected$/i, "제출된 점수만 반려할 수 있습니다. 이미 처리된 경기일 수 있으니 목록을 새로 고치세요."],
  [/^Official revision changed$/i, "다른 곳에서 이 경기 공식 결과를 먼저 바꿨습니다. 화면을 새로 고친 뒤 다시 수정하세요."],
  [/^A correction reason is required$/i, "정정 사유를 입력해야 합니다. 사유를 적고 다시 눌러 주세요."],
  [/^A final score correction reason is required$/i, "본선 점수 정정 사유를 입력해야 합니다. 사유를 적고 다시 눌러 주세요."],
  [/^Reason and submission revision are required$/i, `사유 또는 제출 정보가 없습니다. 사유를 적고 ${REFRESH}`],
  [/^A post-final correction requires a direct edit with a reason$/i, "결승 이후 정정은 사유를 적은 직접 수정으로만 할 수 있습니다."],
  [/^Correction plan changed$/i, "정정 대상이 그사이 바뀌었습니다. 미리보기를 다시 열어 확인한 뒤 진행하세요."],
  [/^Correction targets must share one assigned court$/i, "정정할 경기는 같은 코트에 배정된 경기여야 합니다. 경기를 다시 선택하세요."],
  [/^Correction target official match not found$/i, `정정할 공식 경기를 찾지 못했습니다. ${REFRESH}`],
  [/^Unknown correction target$/i, `정정할 경기를 찾지 못했습니다. ${REFRESH}`],
  [/^Approved correction exceeds transaction write limit$/i, "한 번에 정정할 경기가 너무 많습니다. 경기를 나누어 따로 처리하세요."],
  [/^Approved preliminary score state is inconsistent$/i, "승인된 예선 점수 상태가 맞지 않습니다. 운영본부에 알려 주세요."],
  [/^A score change conflicts with downstream final history$/i, "이 점수를 바꾸면 이미 진행된 본선 기록과 맞지 않습니다. 본선 기록을 먼저 확인하세요."],
  [/^Downstream final match not found\b.*/i, `다음 본선 경기를 찾지 못했습니다. ${REFRESH}`],
  [/^Final correction match not found\b.*/i, `정정할 본선 경기를 찾지 못했습니다. ${REFRESH}`],
  [/^A preliminary correction is blocked after real final play$/i, "본선 경기가 이미 진행되어 예선 정정을 할 수 없습니다. 대회 본부가 결정한 경우에만 ‘비상용 기능 보기’에서 처리하세요."],
  [/^Preliminary match has official history\b.*/i, "공식 예선 이력이 있는 경기는 조·팀·예선 초기화와 대진 재생성을 할 수 없습니다. 예선 탭에서 해당 경기의 ‘점수 수정’으로 고치세요."],
  [/^(Team|Group) has official or live preliminary history\b.*/i, "공식 예선 이력이 있어 조·팀을 바꾸거나 삭제할 수 없습니다. 예선 탭의 ‘점수 수정’으로 고치세요."],
  [/^Direct preliminary scoring requires a pristine assignment or approved official score$/i, "기록관이 입력·제출 중인 경기는 직접 수정할 수 없습니다. 입력·검수를 마친 뒤 다시 시도하세요."],
  // 잠금·입력권
  [/^Lock owner or queue revision changed$/i, "입력권이나 경기 순서가 그사이 바뀌었습니다. 화면을 새로 고쳐 다시 확인하세요."],
  [/^Stale recorder ownership or queue revision$/i, "입력권이나 경기 순서가 바뀌었습니다. 화면을 새로 고친 뒤 ‘입력 다시 시작’을 누르세요."],
  [/^Match ownership required$/i, "이 경기의 입력권이 없습니다. 화면을 새로 고친 뒤 ‘경기 입력 시작’을 누르세요."],
  [/^matchKey and token are required$/i, "입력 정보가 없습니다. 화면을 새로 고친 뒤 ‘경기 입력 시작’을 누르세요."],
  [/^A release reason and lock token are required$/i, `강제 해제 사유가 없거나 잠금 정보가 바뀌었습니다. ${REFRESH}`],
  [/^No active lock to release$/i, "풀 수 있는 잠금이 없습니다. 이미 해제된 경기이니 목록을 새로 고치세요."],
  [/^Live recorder lock must remain with\b.*/i, "기록관이 입력 중이라 이 작업을 할 수 없습니다. 먼저 잠금 강제 해제를 하거나 기록관의 제출을 기다리세요."],
  [/^Only one editing match can occupy a court$/i, "한 코트에서는 한 경기만 입력할 수 있습니다. 진행 중인 경기를 먼저 마치세요."],
  [/^Current match is still recordable$/i, "현재 경기가 아직 입력 가능한 상태입니다. 화면을 새로 고쳐 현재 경기를 입력하세요."],
  [/^Match workflow not found$/i, `경기 입력 정보를 찾지 못했습니다. ${REFRESH}`],
  [/^Recorder workflow not found$/i, `경기 입력 정보를 찾지 못했습니다. ${REFRESH}`],
  [/^Match not found$/i, `경기를 찾지 못했습니다. ${REFRESH}`],
  [/^Official match not found\b.*/i, `공식 경기를 찾지 못했습니다. ${REFRESH}`],
  [/^Workflow has no matching assignment\b.*/i, `경기 배정 정보가 맞지 않습니다. ${REFRESH}`],
  [/^Match, court and recorder name required$/i, "코트나 기록관 이름이 선택되지 않았습니다. 코트와 이름을 다시 선택하세요."],
  [/^Match, court, recorder and session required$/i, "코트나 기록관 이름이 선택되지 않았습니다. 코트와 이름을 다시 선택하세요."],
  [/^sessionId( and discardDraft)? required$/i, `화면 정보가 없습니다. ${REFRESH}`],
  [/^matchKeys? required$/i, `경기 정보가 없습니다. ${REFRESH}`],
  [/^operationId required$/i, `요청 정보가 없습니다. ${REFRESH}`],
  // 코트·대기열
  [/^Court queue changed\b.*/i, "코트 경기 순서가 그사이 바뀌었습니다. 화면을 새로 고친 뒤 다시 눌러 주세요."],
  [/^Court queue revision changed$/i, "코트 경기 순서가 그사이 바뀌었습니다. 화면을 새로 고친 뒤 다시 눌러 주세요."],
  [/^Queue revision changed$/i, "코트 경기 순서가 그사이 바뀌었습니다. 화면을 새로 고친 뒤 다시 눌러 주세요."],
  [/^Court topology revision changed$/i, "다른 관리자가 코트 구성을 먼저 바꿨습니다. 화면을 새로 고친 뒤 다시 저장하세요."],
  [/^Queue projection mismatch$/i, "코트 대기열 상태가 맞지 않습니다. 화면을 새로 고친 뒤에도 같으면 운영본부에 알려 주세요."],
  [/^Court queue could not advance$/i, "다음 경기로 넘어가지 못했습니다. 화면을 새로 고친 뒤 다시 눌러 주세요."],
  [/^Court queue not found\b.*/i, `코트 대기열을 찾지 못했습니다. ${REFRESH}`],
  [/^Court, stale match, recorder and queue revision required$/i, `코트·경기 정보가 부족합니다. ${REFRESH}`],
  [/^Queue revision required for an assigned match$/i, `배정된 경기의 순서 정보가 없습니다. ${REFRESH}`],
  [/^Unassigned matches cannot include a queue revision$/i, `배정되지 않은 경기입니다. ${REFRESH}`],
  [/^Duplicate or invalid match assignment$/i, "같은 경기가 두 번 배정되었거나 올바르지 않은 경기가 있습니다. 코트 배정을 확인하세요."],
  [/^Every court needs a unique id, display name and recorder name$/i, "코트마다 서로 다른 코트 이름과 기록관 이름이 필요합니다. 비어 있거나 겹친 이름을 고치세요."],
  [/^Assignments must belong to a registered court$/i, "등록되지 않은 코트에 경기가 배정되어 있습니다. 코트 배정을 확인하세요."],
  [/^Court workflow (payload is too large|replacement exceeds transaction write limit)$/i, "한 번에 저장할 코트 배정이 너무 많습니다. 일부씩 나누어 저장하세요."],
  [/^courts, assignments, court swaps\b.*/i, `코트 저장 정보가 부족합니다. ${REFRESH}`],
  [/^planToken matchKeys must be sorted and unique$/i, `미리보기 정보가 맞지 않습니다. 미리보기를 다시 열어 주세요.`],
  [/^reason and a valid planToken are required$/i, "사유 또는 미리보기 정보가 없습니다. 미리보기를 다시 연 뒤 사유를 적고 진행하세요."],
  [/^(A whole-court swap|Court swaps|Too many court swaps)\b.*/i, "코트 전체 맞바꾸기 조건에 맞지 않습니다. 서로 다른 두 코트를 선택하고 이름·기록관은 그대로 두세요."],
  [/^Assignment (division mismatch|has no (official match selector|workflow))\b.*/i, `경기 배정 정보가 맞지 않습니다. ${REFRESH}`],
  [/^Assignment workflow is not pristine\b.*/i, "이미 입력이 시작된 경기는 배정을 바꿀 수 없습니다. 입력을 마치거나 잠금을 해제한 뒤 다시 시도하세요."],
  [/^Court assignment has no workflow\b.*/i, `경기 배정 정보가 맞지 않습니다. ${REFRESH}`],
  [/^Court, stale match\b.*/i, `코트·경기 정보가 부족합니다. ${REFRESH}`],
  // 본선 공개·부전승·진출
  [/^Final assignment is not publishable$/i, "아직 공개할 수 없는 본선 경기입니다. 대진과 진출팀을 확인하세요."],
  [/^Final scores must be published through the final publication workflow$/i, "본선 점수는 ‘관객 화면 공개’ 절차로 반영합니다. 공개 초안에 반영 후 공개를 누르세요."],
  [/^Final publication baseline changed$/i, "그사이 본선 공개 상태가 바뀌었습니다. 화면을 새로 고친 뒤 다시 공개하세요."],
  [/^Expected final baseline is invalid$/i, `본선 공개 기준 정보가 맞지 않습니다. ${REFRESH}`],
  [/^Exact (final publication|final structure clear|preliminary structure|qualification preparation) payload required$/i, `요청 정보가 맞지 않습니다. ${REFRESH}`],
  [/^A confirmed BYE requires exactly one entrant$/i, "부전승은 진출팀이 한 팀인 자리에만 확정할 수 있습니다. 대진표를 확인하세요."],
  [/^(Final BYE candidate|Final root BYE candidates)\b.*/i, "부전승 후보 팀이 올바르지 않습니다. ‘현재 순위로 확인’을 누른 뒤 부전승 추첨을 다시 확인하세요."],
  [/^An unplaced BYE candidate requires an empty final root$/i, "부전승 후보가 아직 배치되지 않았습니다. 부전승 자리에 배치한 뒤 진행하세요."],
  [/^Final qualification requires between 2 and 32 entrants$/i, "본선 진출팀은 2팀 이상 32팀 이하여야 합니다. 조별 진출 팀 수를 확인하세요."],
  [/^A final bracket may contain at most 31 matches$/i, "본선 대진표는 31경기까지 만들 수 있습니다. 진출 팀 수를 확인하세요."],
  [/^Qualification count must be an integer from 1 to 64$/i, "조별 진출 팀 수는 1~64 사이 정수여야 합니다."],
  [/^Qualification count change would invalidate played finalists$/i, "이미 경기한 본선 팀이 있어 진출 팀 수를 바꿀 수 없습니다."],
  [/^Preliminary qualification input changed$/i, "그사이 예선 결과가 바뀌었습니다. ‘현재 순위로 확인’을 누른 뒤 다시 진행하세요."],
  [/^An unverified publication cannot change final entrants$/i, "진출팀을 확인하지 않아 본선 팀을 바꿀 수 없습니다. ‘현재 순위로 확인’을 먼저 누르세요."],
  [/^Final structure exists( for this division| in an affected division)$/i, "이미 본선 대진표가 있습니다. 먼저 본선 대진표 초기화 후 다시 시도하세요."],
  [/^(Played final entrants cannot change|Final entrants must exactly match.*|Final root entrants must exactly match.*|Derived final entrants cannot be supplied.*)$/i, "이미 진행됐거나 확정된 본선 진출팀은 바꿀 수 없습니다. ‘현재 순위로 확인’ 후 다시 진행하세요."],
  [/^(A stale pre-play publication requires replace_unplayed|replace_unplayed\b.*|Explicit replace_unplayed mode requires a reason)\b.*/i, "경기 전 본선 대진을 교체하려면 사유를 적고 ‘대진 교체’로 진행해야 합니다. 이미 경기가 진행됐다면 교체할 수 없습니다."],
  [/^A final (entrant requires|score requires) .*/i, `본선 대진표 구성이 올바르지 않습니다. ${REFRESH} 계속되면 대진표를 다시 생성하세요.`],
  [/^Final (entrant|graph|match structure|round layout|rounds|root|assignment|queue|workflow|match is not|matches must|championship|publication exceeds|structure clear exceeds)\b.*/i, `본선 대진표 구성이 올바르지 않습니다. ${REFRESH} 계속되면 대진표를 다시 생성하세요.`],
  [/^Root final entrants cannot use an upstream source$/i, `본선 대진표 구성이 올바르지 않습니다. ${REFRESH}`],
  [/^Supported division required$/i, "부문(남자부/여자부)을 선택해야 합니다."],
  [/^Final assignments require divisionId$/i, "부문(남자부/여자부)을 선택해야 합니다."],
  [/^Prelim assignments require division$/i, "부문(남자부/여자부)을 선택해야 합니다."],
  [/^Group required$/i, "조를 선택해야 합니다."],
  [/^Team required$/i, "팀을 선택해야 합니다."],
  [/^(Group does not belong to this division|Team does not belong to this division|Group has a cross-division team membership|Preliminary match division does not match its group)$/i, "다른 부문의 조·팀이 섞여 있습니다. 부문을 확인하세요."],
  [/^Team is referenced by a preliminary match$/i, "예선 경기에 포함된 팀이라 삭제할 수 없습니다. 예선 대진을 먼저 초기화하세요."],
  [/^Team order (must contain every group team exactly once|required)$/i, `팀 순서 정보가 맞지 않습니다. ${REFRESH}`],
  [/^(Ring order|Partial ring order)\b.*/i, "링크제 배치는 조의 모든 팀을 한 번씩 포함해야 합니다. 배치를 확인하세요."],
  [/^Participant structure mutation exceeds transaction write limit$/i, "한 번에 바꿀 조·팀이 너무 많습니다. 나누어 처리하세요."],
  [/^Preliminary structure mutation exceeds transaction write limit$/i, "한 번에 바꿀 예선 구성이 너무 많습니다. 나누어 처리하세요."],
  [/^Final (publication|structure clear) exceeds transaction write limit$/i, "한 번에 바꿀 본선 경기가 너무 많습니다. 운영본부에 알려 주세요."],
  // 백업·복원
  [/^Checksum mismatch$/i, "백업 파일이 손상되었습니다. 다른 백업 파일로 시도하세요."],
  [/^Restore (chunk |root |target )?.*(checksum mismatch|malformed|incomplete|exceeds|payload required|not found)\b.*/i, "백업 복원 중 오류가 났습니다. 백업 파일이 맞는지 확인하고 처음부터 다시 시도하세요."],
  [/^(Restore|Replacement|Prior|priorManifestId|Exact manifestId|Duplicate restore|Malformed|Unsafe|Unsupported (restore|Firestore)|Unknown or malformed|Timestamp is out|rootData|Invalid restore graph|Current restore|Replacement manifest).*/i, "백업 복원 중 오류가 났습니다. 백업 파일이 맞는지 확인하고 처음부터 다시 시도하세요."],
];

const BYE_MESSAGES = {
  bye_selection_invalid: "부전승 추첨 기록을 확인하세요.",
  bye_lottery_not_required: "이 대진은 부전승 추첨이 필요하지 않습니다. 추첨 기록을 지우고 다시 시도하세요.",
  bye_reason_required: "부전승 추첨 메모(추첨 방법·입회자 등)를 입력하세요.",
  bye_candidates_mismatch: "부전승 추첨 후보가 현재 예선 순위와 다릅니다. ‘현재 순위로 확인’을 누르세요.",
  bye_slots_mismatch: "부전승 자리 수만큼 추첨 당첨 팀을 선택하세요.",
  bye_non_candidate: "부전승 추첨 후보만 당첨 팀으로 선택할 수 있습니다.",
  bye_placement_mismatch: "대진표의 부전승 자리가 추첨 결과와 다릅니다. 추첨 당첨 팀을 부전승 자리에 두거나 대진표를 다시 생성하세요.",
  bye_pending: "부전승 확정을 기다리는 경기가 있습니다. 부전승을 확정한 뒤 진행하세요.",
};

// Firebase 오류 코드만 알 수 있을 때(문구가 없거나 영어 일반 문구)의 안내.
const CODE_MESSAGES = {
  unavailable: "인터넷 연결이 불안정합니다. 연결을 확인한 뒤 다시 눌러 주세요.",
  "deadline-exceeded": "응답이 늦어지고 있습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.",
  unauthenticated: "로그인이 풀렸습니다. 다시 로그인한 뒤 눌러 주세요.",
  "permission-denied": "이 작업을 할 권한이 없습니다. 올바른 계정으로 로그인했는지 확인하세요.",
  "resource-exhausted": "요청이 너무 많습니다. 잠시 기다린 뒤 다시 눌러 주세요.",
  aborted: "다른 변경과 겹쳐 적용되지 않았습니다. 화면을 새로 고친 뒤 다시 눌러 주세요.",
  "not-found": "대상을 찾지 못했습니다. 화면을 새로 고친 뒤 다시 눌러 주세요.",
  "already-exists": "이미 처리된 요청입니다. 화면을 새로 고쳐 상태를 확인하세요.",
};

const reasonOf = (error) => {
  const fromDetails = error?.details?.reason || error?.details?.code;
  if (typeof fromDetails === "string" && fromDetails) return fromDetails;
  const message = String(error?.message || "").trim();
  if (REASON_MESSAGES[message]) return message;
  const embedded = message.match(/\b([a-z]+(?:_[a-z]+)+)\b/);
  return embedded && REASON_MESSAGES[embedded[1]] ? embedded[1] : "";
};

const bareCode = (error) => String(error?.code || "").split("/").at(-1);

/**
 * 오류를 화면에 보여 줄 한국어 문장으로 바꿉니다. 영어 원문은 절대 그대로 반환하지 않습니다.
 * @returns {{ text: string, known: boolean }} known=false 이면 일반 안내문입니다.
 */
export function describeError(error) {
  const reason = reasonOf(error);
  if (reason && REASON_MESSAGES[reason]) return { text: REASON_MESSAGES[reason], known: true };
  const raw = String(error?.message ?? (typeof error === "string" ? error : "")).trim();
  const bye = raw.match(/^(bye_[a-z_]+)\b/);
  if (bye && BYE_MESSAGES[bye[1]]) return { text: BYE_MESSAGES[bye[1]], known: true };
  const normalized = raw.replace(/\.+$/, "").trim();
  if (normalized) {
    for (const [pattern, text] of MESSAGE_RULES) {
      if (pattern.test(normalized)) return { text, known: true };
    }
  }
  // 서버가 이미 한국어로 보낸 문구(영어 단어가 섞이지 않은 것)는 그대로 보여 줍니다.
  if (/[가-힣]/.test(raw) && !/[A-Za-z]{4,}/.test(raw)) return { text: raw, known: true };
  const code = bareCode(error);
  if (/(?:unavailable|network)/.test(code) || /^(?:network|offline)/i.test(raw) || /failed to fetch|network error|offline/i.test(raw)) {
    return { text: CODE_MESSAGES.unavailable, known: true };
  }
  // 코드만으로는 구체적인 원인을 알 수 없는 일반 코드는 대표 안내를 쓰되, 알 수 없는 영어 문구는 숨깁니다.
  if ((!normalized || normalized.toLowerCase() === code) && CODE_MESSAGES[code]) return { text: CODE_MESSAGES[code], known: true };
  if (["deadline-exceeded", "unauthenticated", "permission-denied", "resource-exhausted"].includes(code)) {
    return { text: CODE_MESSAGES[code], known: true };
  }
  return { text: GENERIC_ERROR_MESSAGE, known: false };
}

/** 문장만 필요할 때. */
export function koreanErrorMessage(error) {
  return describeError(error).text;
}

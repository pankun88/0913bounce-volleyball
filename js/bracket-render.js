import { groupByRound, publicMatchView } from "./bracket.js";
import { evaluateFinalMatch } from "./match-logic.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 본선 대진표에 표시할 팀 이름에서, 뒤에 붙은 조/시드 코드(예: "삼화초A(A1)" → "삼화초A")를
 * 떼어낸다. 사용자가 팀 이름을 수동 입력할 때 "(A1)", "(C2)"처럼 붙여두는데, 대진표에서는
 * 조/순위 라벨(예: "A조 1위")이 따로 보이므로 이 코드는 군더더기다. 데이터(저장된 이름)는
 * 건드리지 않고 화면 표시용으로만 떼어낸다. 괄호 안이 영문/숫자뿐인 맨 끝 한 덩어리만 제거한다. */
export function displayTeamName(name) {
  const s = String(name == null ? "" : name);
  const stripped = s.replace(/\s*\([A-Za-z0-9]+\)\s*$/, "").trim();
  return stripped || s; // 이름 전체가 코드뿐이면 원래 이름을 그대로 둔다(안전장치)
}

/**
 * 본선 대진표를 컨테이너에 그린다 (관리자/대시보드 공용).
 * @param {HTMLElement} container
 * @param {object[]} matches generateBracket() 결과 또는 Firestore에서 읽은 동일 구조
 * @param {{editable?:boolean, onEdit?:(match)=>void}} options
 */
export function renderBracket(container, matches, options = {}) {
  disposeBracketRender(container);
  container.innerHTML = "";
  if (!matches || matches.length === 0) {
    container.innerHTML = '<div class="empty-hint">아직 본선 대진표가 생성되지 않았습니다.</div>';
    return;
  }

  // A public match can carry progress metadata, but score/result fields are
  // renderable only after an approval revision exists. Do not read workflow or
  // submission data here; those documents are intentionally private.
  const publicMatches = options.editable ? matches : matches.map(publicMatchView);
  const { rounds } = groupByRound(publicMatches);

  // 아무 경기도 시작되지 않았을 때만(=점수가 하나도 입력되지 않았을 때만) 1라운드 카드에서
  // 팀을 드래그해 자리를 바꿀 수 있게 한다. 점수가 들어간 뒤에는 대진을 되돌리기 까다로워지므로 막는다.
  const locked = publicMatches.some(
    (m) => (m.sets && m.sets.length) || m.status === "done" || m.status === "in_progress" || m.status === "bye"
  );
  const canSwapSlots = Boolean(options.editable && options.onSwapSlot && !locked);

  if (canSwapSlots) {
    const hint = document.createElement("div");
    hint.className = "empty-hint bracket-swap-hint";
    hint.textContent = "1라운드 팀명을 드래그해서 대진(부전승 포함)을 직접 조정할 수 있습니다.";
    container.appendChild(hint);
  }

  const root = document.createElement("div");
  root.className = "bracket-root";

  // 세로형 대진표: 라운드를 위에서 아래로 쌓고, 각 라운드 안에서는 경기를 가로로 나열한다.
  const track = document.createElement("div");
  track.className = "bracket-track";

  // 카드 크기는 PC·모바일 동일하게 자연 크기로 두고, 화면에 맞추는 일은 아래 redraw에서
  // transform: scale()로 트리 전체를 통째로 줄여서 처리한다. (예전엔 모바일에서 카드 자체를
  // 줄이고 zoom으로 맞췄는데, zoom 속성은 iOS Safari에서 동작하지 않아 모바일에서 전혀
  // 축소되지 않고 가로로 넘쳐 흐르는 문제가 있었다. transform: scale()은 모든 브라우저에서
  // 동작하므로, 카드는 자연 크기 그대로 두고 트리만 비율을 유지한 채 줄이면 글자 잘림이나
  // 세트 표 헤더 줄바꿈 없이 깔끔하게 화면에 맞는다.)
  const cardWidth = 178;
  const gap = 56;
  container.style.setProperty("--bracket-card-width", `${cardWidth}px`);
  container.style.setProperty("--bracket-card-gap", `${gap}px`);

  const round1Count = rounds.length ? rounds[0].matches.length : 1;
  const trackWidth = round1Count * cardWidth + (round1Count - 1) * gap + 20;
  track.style.width = `${trackWidth}px`;

  // 우승이 확정됐다면 마지막(결승) 경기를 기억해 둔다 - 트리를 다 그린 뒤 우승 세레모니를 건다.
  let decidedFinalMatch = null;

  rounds.forEach((roundObj, ri) => {
    // 마지막 라운드 = 결승. 다른 라운드와 똑같이 평범하게 보이지 않도록 별도로 강조한다.
    const isFinalRound = ri === rounds.length - 1;
    // 결승전이 끝나 우승팀이 결정됐는지 - 결정됐다면 "결승" 타이틀을 그 자리에서 그대로
    // 우승팀 발표로 바꿔서 보여준다. (예전엔 카드 위에 우승 배너를 별도로 끼워넣었는데,
    // 그러면 그 아래 카드 자리가 밀려나 보여서 불편하다는 피드백이 있었다. 새 배너를
    // 추가하는 대신 이미 있는 "결승" 타이틀 자리의 문구만 바꾸면 레이아웃이 전혀 움직이지 않는다.)
    const finalMatch = isFinalRound ? roundObj.matches[0] : null;
    const isChampionDecided = Boolean(finalMatch && finalMatch.status === "done" && finalMatch.winnerSide);
    if (isChampionDecided) decidedFinalMatch = finalMatch;

    const col = document.createElement("div");
    col.className = "bracket-round";
    col.style.width = `${trackWidth}px`;

    const title = document.createElement("div");
    title.className =
      "bracket-round-title" + (isFinalRound ? " is-final-title" : "") + (isChampionDecided ? " is-champion-title" : "");
    if (isFinalRound) {
      // 트로피 아이콘은 글자보다 한층 더 크게 보여줘서 "결승=우승전" 느낌을 확 살린다.
      const icon = document.createElement("span");
      icon.className = "bracket-final-title-icon";
      icon.textContent = "\u{1F3C6}";
      const label = document.createElement("span");
      label.className = "bracket-final-title-label";
      if (isChampionDecided) {
        const champion = finalMatch.winnerSide === "A" ? finalMatch.teamA : finalMatch.teamB;
        label.textContent = `${champion ? displayTeamName(champion.name) : ""} 우승!`;
      } else {
        label.textContent = roundObj.label;
      }
      title.appendChild(icon);
      title.appendChild(label);
    } else {
      title.textContent = roundObj.label;
    }
    col.appendChild(title);

    const matchesWrap = document.createElement("div");
    matchesWrap.className = "bracket-round-matches";
    matchesWrap.style.width = `${trackWidth}px`;

    roundObj.matches.forEach((m) => {
      const slot = document.createElement("div");
      slot.className = "bracket-slot";
      slot.appendChild(renderMatchCard(m, { ...options, canSwapSlots, isFinalRound }));
      matchesWrap.appendChild(slot);
    });

    col.appendChild(matchesWrap);
    track.appendChild(col);
  });

  root.appendChild(track);
  container.appendChild(root);

  // 우승이 확정됐고 편집 화면(관리자)이 아니라면(=관객 대시보드), 우승팀의 첫 라운드 팀명을
  // 클릭하면 불꽃 세레모니가 재생되도록 건다. (관리자 화면은 팀명 드래그 등과 겹치므로 제외)
  if (!options.editable && decidedFinalMatch) {
    const champ = decidedFinalMatch.winnerSide === "A" ? decidedFinalMatch.teamA : decidedFinalMatch.teamB;
    if (champ) setupChampionCeremony(track, container, publicMatches, champ, decidedFinalMatch);
  }

  // 트리를 화면에 맞춰 비율 그대로 축소/확대한다. transform: scale()을 쓰는 이유는
  // 모든 브라우저(특히 iOS Safari·인앱 브라우저)에서 똑같이 동작하기 때문이다. 다만
  // transform은 레이아웃 박스 크기를 바꾸지 않아서, 그대로 두면 부모(container)가 원래
  // 크기 기준으로 넘쳐서 가로/세로 스크롤이 생긴다. 그래서 track을 absolute로 띄우고
  // 부모 래퍼(root)의 크기를 "스케일된 실제 크기"로 직접 맞춰, 스크롤 없이 딱 들어가게 한다.
  // root 높이를 바꾸면 container 높이도 바뀌어 ResizeObserver가 다시 redraw를 부르는데,
  // 같은 입력이면 굳이 다시 그릴 필요가 없다. 마지막으로 처리한 폭/높이/전체화면 여부를
  // 기억해 두고, 그대로면 건너뛰어 불필요한 재계산(과 옵저버 루프 경고)을 막는다.
  let lastKey = "";

  const redraw = () => {
    // 탭이 숨겨진(display:none) 상태면 크기가 0이라 계산이 무의미하므로 건너뛴다.
    // 이후 탭이 보이게 되면 ResizeObserver가 다시 redraw를 불러준다.
    if (container.clientWidth === 0) return;

    const fsMode = container.dataset.fullscreenZoom === "1";
    const key = `${container.clientWidth}x${container.clientHeight}x${fsMode ? 1 : 0}`;
    if (key === lastKey) return;
    lastKey = key;

    // 측정과 연결선 계산은 항상 배율 1(transform 없는) 상태에서 해야 좌표가 자연 좌표계와
    // 일치한다. 한 번의 redraw() 안에서 동기적으로 transform을 껐다 켜므로 깜빡임은 없다.
    track.style.transform = "none";

    const wrapStyle = getComputedStyle(container);
    const padX = parseFloat(wrapStyle.paddingLeft || "0") + parseFloat(wrapStyle.paddingRight || "0");
    const padY = parseFloat(wrapStyle.paddingTop || "0") + parseFloat(wrapStyle.paddingBottom || "0");
    const available = container.clientWidth - padX;
    const naturalHeight = track.offsetHeight || 1;
    const widthFactor = available / trackWidth;

    const isMobile = window.innerWidth <= 720;

    let factor;
    if (fsMode) {
      // 전체화면(주로 PC 모니터 송출용): 가로뿐 아니라 세로까지 맞춰, 화면 안에 트리 전체가
      // 잘리지 않고 들어가는 한도 내에서 최대한 크게(1배 초과 확대도 허용) 보여준다.
      // 약간의 안전 여유(0.98배)를 둔다.
      const availableHeight = container.clientHeight - padY;
      const heightFactor = availableHeight > 0 ? availableHeight / naturalHeight : widthFactor;
      factor = Math.max(0.2, Math.min(widthFactor, heightFactor) * 0.98);
    } else if (isMobile) {
      // 모바일 일반 화면: 처음엔 전체 대진표가 한눈에 들어오도록 가로 폭에 맞춰 줄여서
      // 보여준다. 자세한 정보는 사용자가 두 손가락으로 확대(핀치 줌)하고 스크롤해서 본다.
      // (트리가 화면보다 좁으면 1배 그대로.)
      factor = Math.min(1, widthFactor);
    } else {
      // PC 일반 화면: 자연 크기(1배) 그대로. 화면보다 넓으면 가로 스크롤로 확인하고,
      // 한눈에 보고 싶으면 '전체화면' 버튼을 쓴다.
      factor = 1;
    }

    // 연결선은 배율 1 상태에서 그린다(자연 좌표계 기준). 이후 track을 scale하면 SVG도 함께 축소된다.
    drawConnectors(track, rounds);

    track.style.transformOrigin = "top left";
    track.style.transform = `scale(${factor})`;
    // 부모 래퍼를 스케일된 실제 크기로 맞춰서, 남는 여백이나 스크롤이 생기지 않게 한다.
    root.style.width = `${trackWidth * factor}px`;
    root.style.height = `${naturalHeight * factor}px`;
  };

  requestAnimationFrame(redraw);

  // 탭 전환처럼 display:none -> block 으로 바뀌는 것도 "크기 변화"로 감지되므로,
  // 한 번만 실행되는 resize 리스너 대신 ResizeObserver로 계속 감시한다.
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => redraw());
    ro.observe(container);
    container.__bracketRenderState = { observer: ro, timers: new Set() };
  } else {
    window.addEventListener("resize", redraw);
    container.__bracketRenderState = { resizeListener: redraw, timers: new Set() };
  }
}

/** Remove all per-container rendering resources before replacing its contents. */
export function disposeBracketRender(container) {
  const state = container?.__bracketRenderState;
  if (state?.observer) state.observer.disconnect();
  if (state?.resizeListener) window.removeEventListener("resize", state.resizeListener);
  state?.timers?.forEach((timer) => clearTimeout(timer));
  if (container) {
    container.__bracketResizeObserver?.disconnect();
    container.__bracketResizeObserver = null;
    container.querySelectorAll(".champion-celebrate-layer, .bracket-fire-line").forEach((el) => el.remove());
    container.querySelectorAll(".champion-aflame").forEach((el) => el.classList.remove("champion-aflame"));
    container.__bracketRenderState = null;
  }
}

function schedule(container, callback, delay) {
  const state = container.__bracketRenderState;
  const timer = setTimeout(() => {
    state?.timers?.delete(timer);
    callback();
  }, delay);
  state?.timers?.add(timer);
  return timer;
}

function renderMatchCard(match, options) {
  const wrap = document.createElement("div");
  wrap.className = "match-card-wrap";

  const card = document.createElement("div");
  card.className =
    "match-card" +
    (match.status === "done" ? " is-done" : "") +
    (options.isFinalRound ? " is-final" : "");
  card.dataset.matchId = match.id;

  // 대진(팀A : 팀B)을 가로 한 줄로 보여주고, 팀명 바로 아래에는 세트 스코어를 "2:1" 형태로 작게 붙인다
  const playedSets = (match.sets || []).filter((s) => Number(s.a) > 0 || Number(s.b) > 0);
  const evald = playedSets.length ? evaluateFinalMatch(playedSets) : null;

  const vs = document.createElement("div");
  vs.className = "match-vs";
  if (match.status === "bye" || match.status === "bye_pending") {
    // 부전승(확정 대기 포함) 경기는 상대가 없으므로 "A : B" 형태 대신, 콜론 없이 "팀명(부전승)"을 가로 한 줄로 보여준다.
    vs.appendChild(renderByeVsRow(match, options));
  } else {
    vs.appendChild(renderVsSide(match, "A", options));
    const sep = document.createElement("span");
    sep.className = "match-vs-sep";
    sep.textContent = ":";
    vs.appendChild(sep);
    vs.appendChild(renderVsSide(match, "B", options));
  }
  card.appendChild(vs);

  card.appendChild(renderVsScore(match, evald));

  // 관리자 화면(editable)에서는 부전승·대기중 카드도 버튼 자리를 똑같이 차지해야
  // 같은 라운드 안에서 카드 높이가 들쭉날쭉해지지 않는다. 누를 수 없으면 비활성 버튼으로 자리만 맡아둔다.
  if (options.editable) {
    const canEdit = match.teamA && match.teamB && match.status !== "bye" && match.status !== "bye_pending";
    // 부전승은 더 이상 자동으로 확정되지 않으므로, 확정 대기 중('bye_pending')이면 관리자가
    // 직접 누를 수 있는 "부전승 확정" 버튼을 보여준다. 이미 확정된 부전승('bye')은 비활성 표시만 한다.
    const canConfirmBye = match.status === "bye_pending" && Boolean(options.onConfirmBye);
    const btn = document.createElement("button");
    btn.type = "button";
    if (canEdit) {
      btn.className = "match-edit-btn";
      btn.textContent = match.status === "done" ? "점수 수정" : "점수 입력";
      btn.addEventListener("click", () => options.onEdit && options.onEdit(match));
    } else if (canConfirmBye) {
      btn.className = "match-edit-btn match-confirm-bye-btn";
      btn.textContent = "부전승 확정";
      btn.addEventListener("click", () => options.onConfirmBye(match));
    } else {
      btn.className = "match-edit-btn is-disabled";
      btn.disabled = true;
      btn.textContent = match.status === "bye" ? "부전승 확정됨" : match.status === "empty" ? "미배정" : "대기중";
    }
    card.appendChild(btn);
  }
  wrap.appendChild(card);

  // 세트별 득점 테이블은 점수 입력 여부와 무관하게 항상 만들어 둔다.
  // 그래야 점수를 입력한 카드와 아직 입력 전인 카드의 높이가 같아져서, 같은 라운드 안에서 카드 위치가 흔들리지 않는다.
  wrap.appendChild(renderSetTable(match, playedSets));

  return wrap;
}

/** 팀명 아래에, getTeamLabel 콜백(전달된 경우)으로 "A조 1위" 같은 조/순위 라벨을 작게 붙인다.
 * 대진표트리는 카드에 팀명만 보여서 자리 교체(드래그앤드랍) 시 어느 조 몇 위인지 헷갈리기 쉬우므로,
 * 호버 없이 항상 보이는 라벨로 표시해 해결한다. */
function appendGroupLabel(container, team, options) {
  if (!options || typeof options.getTeamLabel !== "function") return;
  const label = team ? options.getTeamLabel(team.id) : null;
  // 라벨이 있는 카드와 없는 카드(미배정 등)가 같은 라운드에 섞이면 카드 높이가 달라지고,
  // 그 결과 연결선이 카드마다 다른 높이에서 출발해 어긋나 보인다. 라벨이 없어도 같은 줄을
  // 그대로 만들어 자리를 차지하게 해서, 같은 라운드 안 카드 높이가 항상 같아지게 한다.
  const el = document.createElement("span");
  el.className = "match-vs-group" + (label ? "" : " is-empty");
  el.textContent = label || "\u00A0";
  container.appendChild(el);
}

/** 대진 줄 한쪽(팀명)을 만든다. 1라운드 + 미시작 상태면 드래그로 다른 자리와 바꿀 수 있다 */
function renderVsSide(match, side, options) {
  const team = side === "A" ? match.teamA : match.teamB;
  const isWinner = match.winnerSide === side;

  const col = document.createElement("div");
  col.className = "match-vs-side";

  const canSwap = Boolean(options && options.canSwapSlots && match.round === 1 && match.status !== "empty");
  if (canSwap) {
    col.classList.add("slot-draggable");
    col.draggable = true;
    col.dataset.matchId = match.id;
    col.dataset.side = side;
    col.addEventListener("dragstart", (e) => {
      // isBye:false로 표시해, 부전승 자리에서 드롭을 받을 때 "실제 경기 팀이 들어온 것"임을 구분할 수 있게 한다.
      e.dataTransfer.setData("text/plain", JSON.stringify({ matchId: match.id, side, isBye: false }));
      e.dataTransfer.effectAllowed = "move";
      col.classList.add("dragging");
    });
    col.addEventListener("dragend", () => col.classList.remove("dragging"));
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("slot-drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("slot-drag-over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("slot-drag-over");
      let from = null;
      try { from = JSON.parse(e.dataTransfer.getData("text/plain")); } catch (err) { from = null; }
      if (!from || !from.matchId) return;
      options.onSwapSlot(from, { matchId: match.id, side });
    });
  }

  const name = document.createElement("span");
  name.className = "match-vs-name" + (isWinner ? " is-winner" : "");
  name.textContent = team ? displayTeamName(team.name) : "";
  if (team) name.dataset.teamId = team.id; // 우승 세레모니에서 우승팀 이름 칸을 찾기 위함
  col.appendChild(name);

  // 조/순위 라벨은 1라운드(예선에서 막 올라온 자리)에서만 보여준다 - 2라운드부터는 이미 본선에서
  // 만난 상대이므로 출신 조/순위 정보가 더는 중요하지 않고, 라벨이 라운드마다 누적되면 카드만
  // 복잡해진다.
  if (match.round === 1) appendGroupLabel(col, team, options);

  return col;
}

/**
 * 부전승 경기 줄을 만든다. 상대가 없으므로 "A : B"처럼 두 칸으로 나누지 않고,
 * 콜론 없이 "팀명(부전승)"을 가로 한 줄로 보여준다(줄이 늘어나면 연결선 위치가 흐트러지므로
 * 한 줄을 유지하는 것이 중요하다).
 * 드래그(이 팀을 다른 자리로 옮기기)는 실제 팀이 있는 자리(side) 기준으로, 드롭(다른 팀을
 * 부전승 자리로 끌어오기)은 비어 있는 자리(emptySide) 기준으로 처리해, 기존 자리 교체 로직을
 * 그대로 재사용한다.
 */
function renderByeVsRow(match, options) {
  // 이름+태그 한 줄(.match-vs-bye-line)은 그대로 유지하고, 조/순위 라벨은 그 아래 별도 줄로 붙인다
  // (연결선 계산은 카드 전체 높이를 기준으로 다시 그려지므로 줄이 하나 늘어도 문제없다).
  const realSide = match.teamA ? "A" : "B";
  const emptySide = realSide === "A" ? "B" : "A";
  const team = match.teamA || match.teamB;
  const isWinner = match.winnerSide === realSide;

  const row = document.createElement("div");
  row.className = "match-vs-bye-inline";

  const canSwap = Boolean(options && options.canSwapSlots && match.round === 1);
  if (canSwap) {
    row.classList.add("slot-draggable");
    row.draggable = true;
    row.dataset.matchId = match.id;
    row.dataset.side = realSide;
    row.addEventListener("dragstart", (e) => {
      // isBye:true로 표시해 두면, 드롭 받는 쪽(다른 부전승 자리)에서 "부전승끼리 자리만 바꾸는 것"인지
      // "실제 경기 중인 팀이 부전승 자리로 들어오는 것"인지 구분할 수 있다.
      e.dataTransfer.setData("text/plain", JSON.stringify({ matchId: match.id, side: realSide, isBye: true }));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("slot-drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("slot-drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("slot-drag-over");
      let from = null;
      try { from = JSON.parse(e.dataTransfer.getData("text/plain")); } catch (err) { from = null; }
      if (!from || !from.matchId) return;
      // 드래그해 온 팀이 "다른 부전승 자리"의 팀이면(부전승<->부전승), 이쪽도 실제 팀이 있는
      // 자리(realSide)를 기준으로 교체해야 두 부전승이 그대로 자리만 맞바뀐다.
      // 반대로 실제 경기 중이던 팀을 끌어온 것이면, 빈 자리(emptySide)에 넣어야 진짜 대결이 성립한다.
      const targetSide = from.isBye ? realSide : emptySide;
      options.onSwapSlot(from, { matchId: match.id, side: targetSide });
    });
  }

  const line = document.createElement("span");
  line.className = "match-vs-bye-line";

  const name = document.createElement("span");
  name.className = "match-vs-name" + (isWinner ? " is-winner" : "");
  name.textContent = team ? displayTeamName(team.name) : "";
  if (team) name.dataset.teamId = team.id; // 우승 세레모니용
  line.appendChild(name);

  const tag = document.createElement("span");
  tag.className = "match-vs-bye-tag" + (match.status === "bye_pending" ? " is-pending" : "");
  tag.textContent = match.status === "bye_pending" ? "(부전승 대기)" : "(부전승)";
  line.appendChild(tag);
  row.appendChild(line);

  // 부전승도 1라운드에서만 조/순위 라벨을 보여준다(위 renderVsSide와 동일한 이유).
  if (match.round === 1) appendGroupLabel(row, team, options);

  return row;
}

/** 팀명 아래, 이긴 세트 수를 "2:1" 형태(가운데 한 줄)로 작게 보여준다. 입력 전이면 "–:–"로 자리만 맡아둔다 */
function renderVsScore(match, evald) {
  const row = document.createElement("div");
  row.className = "match-vs-score";

  const aNum = document.createElement("span");
  aNum.className = "match-vs-score-num" + (match.winnerSide === "A" ? " is-winner" : "");
  aNum.textContent = evald ? evald.setsWonA : "–";
  row.appendChild(aNum);

  const sep = document.createElement("span");
  sep.className = "match-vs-score-sep";
  sep.textContent = ":";
  row.appendChild(sep);

  const bNum = document.createElement("span");
  bNum.className = "match-vs-score-num" + (match.winnerSide === "B" ? " is-winner" : "");
  bNum.textContent = evald ? evald.setsWonB : "–";
  row.appendChild(bNum);

  return row;
}

// 본선 경기는 최대 3세트(10·10·7점)까지 치르므로, 칸 수를 3으로 고정해 둔다.
// (실제로 2세트에서 끝나도 3세트 칸은 빈 칸으로 남겨 모든 카드의 테이블 크기를 동일하게 맞춘다)
const FINAL_SET_SLOTS = 3;

/** 세트별 득점 상황을 박스 아래 작은 가로 테이블로 만든다. 아직 입력 전인 칸은 빈 칸(–)으로 둔다. */
function renderSetTable(match, playedSets) {
  const table = document.createElement("table");
  table.className = "match-set-table";

  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (let i = 0; i < FINAL_SET_SLOTS; i++) {
    const th = document.createElement("th");
    th.textContent = `${i + 1}세트`;
    headRow.appendChild(th);
  }
  table.appendChild(headRow);

  [["A", match.teamA], ["B", match.teamB]].forEach(([side, team]) => {
    const row = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.className = "match-set-table-name" + (match.winnerSide === side ? " is-winner" : "");
    nameTd.textContent = team ? displayTeamName(team.name) : "";
    row.appendChild(nameTd);
    for (let i = 0; i < FINAL_SET_SLOTS; i++) {
      const s = playedSets[i];
      const td = document.createElement("td");
      td.textContent = s ? (side === "A" ? s.a : s.b) : "–";
      row.appendChild(td);
    }
    table.appendChild(row);
  });

  return table;
}

function drawConnectors(track, rounds) {
  let svg = track.querySelector("svg.bracket-lines");
  if (svg) svg.remove();
  svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "bracket-lines");
  track.prepend(svg);

  const trackRect = track.getBoundingClientRect();
  svg.setAttribute("width", track.scrollWidth);
  svg.setAttribute("height", track.scrollHeight);

  rounds.forEach((roundObj, ri) => {
    if (ri === rounds.length - 1) return;
    roundObj.matches.forEach((m) => {
      if (!m.nextMatchId) return;
      const fromEl = track.querySelector(`[data-match-id="${m.id}"]`);
      const toEl = track.querySelector(`[data-match-id="${m.nextMatchId}"]`);
      if (!fromEl || !toEl) return;
      const fr = fromEl.getBoundingClientRect();
      // 도착 지점은 카드 박스가 아니라 "카드+세트별 득점 테이블"을 합친 블록의 아래쪽 끝으로 잡는다.
      // 그래야 선이 다음 라운드 카드의 세트 테이블을 가로지르지 않고 그 아래쪽 빈 공간으로 지나간다.
      const toBlockEl = toEl.closest(".match-card-wrap") || toEl;
      const tr = toBlockEl.getBoundingClientRect();
      // 세로형(결승이 위로 갈수록): 이전 라운드 카드 위쪽 중앙 -> 다음 라운드 블록 아래쪽 중앙으로 이어준다
      const x1 = fr.left + fr.width / 2 - trackRect.left;
      const y1 = fr.top - trackRect.top;
      const x2 = tr.left + tr.width / 2 - trackRect.left;
      const y2 = tr.bottom - trackRect.top;
      const midY = y1 + (y2 - y1) / 2;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`);
      path.setAttribute("class", "bracket-line");
      // 우승 세레모니에서 이 연결선이 어느 경기에서 어느 경기로 가는지 찾기 위함.
      // d가 from카드(아래)에서 시작해 to카드(위)로 끝나므로, stroke-dashoffset 애니메이션이
      // 자연스럽게 아래(1라운드)→위(결승) 방향으로 불꽃을 그린다.
      path.dataset.from = m.id;
      path.dataset.to = m.nextMatchId;
      svg.appendChild(path);
    });
  });
}

// ===================== 우승 세레모니 =====================

/** 우승팀의 첫 라운드 팀명에 클릭 트리거(반짝이는 힌트 + 클릭 핸들러)를 건다. */
function setupChampionCeremony(track, container, matches, champ, finalMatch) {
  // 우승팀이 거쳐 올라온 경기들(매 경기 승자였으므로 우승팀이 들어있는 경기)을 라운드 순으로 모은다.
  const path = matches
    .filter((m) => (m.teamA && m.teamA.id === champ.id) || (m.teamB && m.teamB.id === champ.id))
    .sort((a, b) => (a.round || 0) - (b.round || 0));
  if (!path.length) return;

  const first = path[0];
  const startEl = track.querySelector(
    `.match-card[data-match-id="${first.id}"] .match-vs-name[data-team-id="${champ.id}"]`
  );
  if (!startEl) return;

  startEl.classList.add("champion-trigger");
  startEl.title = "클릭하면 우승 세레모니가 재생됩니다 🔥";
  startEl.addEventListener("click", (e) => {
    e.stopPropagation();
    playChampionCeremony(track, container, path, champ, finalMatch);
  });
}

/** SVG에 불꽃용 그라디언트/광채 필터 정의를 한 번만 추가한다. */
function ensureChampionFireDefs(svg) {
  if (svg.querySelector("#championFireGradient")) return;
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.innerHTML =
    '<linearGradient id="championFireGradient" x1="0" y1="1" x2="0" y2="0">' +
    '<stop offset="0%" stop-color="#ff2d00"/>' +
    '<stop offset="45%" stop-color="#ff8c00"/>' +
    '<stop offset="100%" stop-color="#ffe14a"/>' +
    "</linearGradient>" +
    '<filter id="championFireGlow" x="-60%" y="-60%" width="220%" height="220%">' +
    '<feGaussianBlur stdDeviation="3.2" result="b"/>' +
    '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>' +
    "</filter>";
  svg.insertBefore(defs, svg.firstChild);
}

/** 우승팀의 연결선을 1라운드→결승 순서로 불꽃이 타고 올라가게 하고, 마지막에 우승 이펙트를 터뜨린다. */
function playChampionCeremony(track, container, path, champ, finalMatch) {
  const svg = track.querySelector("svg.bracket-lines");
  if (!svg) return;

  // 이전 재생 잔여물 정리(다시 클릭하면 재생).
  svg.querySelectorAll(".bracket-fire-line").forEach((el) => el.remove());
  const prevLayer = container.querySelector(".champion-celebrate-layer");
  if (prevLayer) prevLayer.remove();
  track.querySelectorAll(".champion-aflame").forEach((el) => el.classList.remove("champion-aflame"));

  ensureChampionFireDefs(svg);

  // 우승팀 경로의 연결선들(아래→위)을 순서대로 모은다.
  const segs = [];
  for (let i = 0; i < path.length - 1; i++) {
    const seg = svg.querySelector(`path.bracket-line[data-from="${path[i].id}"]`);
    if (seg) segs.push(seg);
  }

  const perSeg = 650; // 연결선 한 칸당 불꽃이 타오르는 시간(ms)
  segs.forEach((seg, i) => {
    const len = seg.getTotalLength();
    const fire = document.createElementNS(SVG_NS, "path");
    fire.setAttribute("d", seg.getAttribute("d"));
    fire.setAttribute("class", "bracket-fire-line");
    fire.style.strokeDasharray = `${len}`;
    fire.style.strokeDashoffset = `${len}`;
    svg.appendChild(fire);
    schedule(container, () => {
      fire.getBoundingClientRect(); // 레이아웃 강제 후 트랜지션 시작
      fire.style.transition = `stroke-dashoffset ${perSeg}ms linear`;
      fire.style.strokeDashoffset = "0";
    }, i * perSeg);
  });

  const total = Math.max(1, segs.length) * perSeg;

  // 불꽃이 결승까지 도달할 즈음 우승팀 학교명에 불을 붙인다.
  schedule(container, () => {
    const nameEl = track.querySelector(
      `.match-card[data-match-id="${finalMatch.id}"] .match-vs-name[data-team-id="${champ.id}"]`
    );
    if (nameEl) nameEl.classList.add("champion-aflame");
  }, Math.max(0, total - 120));

  // 마지막에 우승 이펙트(섬광 + 불티 + 우승 배너)를 터뜨린다.
  schedule(container, () => burstChampionCelebration(container, champ), total);
}

/** 화면을 덮는 우승 이펙트: 금빛 섬광 + 위로 솟는 불티들 + 가운데 "우승!" 배너. */
function burstChampionCelebration(container, champ) {
  const layer = document.createElement("div");
  layer.className = "champion-celebrate-layer";

  const flash = document.createElement("div");
  flash.className = "champion-flash";
  layer.appendChild(flash);

  const burst = document.createElement("div");
  burst.className = "champion-burst";
  burst.textContent = `🔥 ${displayTeamName(champ.name)} 우승! 🔥`;
  layer.appendChild(burst);

  const emojis = ["🔥", "🔥", "🔥", "✨", "🎉", "⭐"];
  const riseBase = container.clientHeight || 400;
  for (let i = 0; i < 34; i++) {
    const ember = document.createElement("span");
    ember.className = "champion-ember";
    ember.textContent = emojis[i % emojis.length];
    ember.style.left = `${Math.random() * 100}%`;
    ember.style.fontSize = `${16 + Math.random() * 18}px`;
    ember.style.setProperty("--rise", `${Math.round(riseBase * (0.55 + Math.random() * 0.4))}px`);
    ember.style.setProperty("--drift", `${Math.round(Math.random() * 140 - 70)}px`);
    ember.style.setProperty("--rot", `${Math.round(Math.random() * 260 - 130)}deg`);
    ember.style.setProperty("--dur", `${(1.3 + Math.random() * 1.1).toFixed(2)}s`);
    ember.style.animationDelay = `${(Math.random() * 0.6).toFixed(2)}s`;
    layer.appendChild(ember);
  }

  container.appendChild(layer);
  schedule(container, () => layer.remove(), 4600);
}

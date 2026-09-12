/**
 * 링크제(꼭짓점 도형) 예선 대진 - 공용 로직 + 렌더링
 *
 * 링크제: N개 팀을 N각형(폴리곤)의 꼭짓점에 배치하고, "인접한" 꼭짓점끼리만 대결한다.
 * (대각선으로 마주보는 팀과는 경기하지 않음 - 라운드로빈과의 차이점)
 *
 * 관리자 대회설정과 예선 화면에서 같은 도형을 사용한다.
 */

/** 꼭짓점 배열을 현재 조 소속 팀 목록에 맞춰 정리한다 (길이 = 팀 수, 빠진 자리는 null) */
export function normalizeRingOrder(ringOrder, groupTeamIds) {
  const validIds = new Set(groupTeamIds);
  let ring = (Array.isArray(ringOrder) ? ringOrder : []).filter(
    (id) => id === null || id === undefined ? true : validIds.has(id)
  ).map((id) => (id === undefined ? null : id));

  // 중복 제거(안전장치)
  const seen = new Set();
  ring = ring.map((id) => {
    if (id !== null && seen.has(id)) return null;
    if (id !== null) seen.add(id);
    return id;
  });

  if (ring.length > groupTeamIds.length) ring = ring.slice(0, groupTeamIds.length);
  while (ring.length < groupTeamIds.length) ring.push(null);
  return ring;
}

/** N개 꼭짓점을 원형으로 배치했을 때, 서로 인접한 꼭짓점 인덱스 쌍(=경기 목록)을 구한다 */
export function getRingEdges(n) {
  if (n < 2) return [];
  if (n === 2) return [[0, 1]];
  const edges = [];
  for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n]);
  return edges;
}

/** 모든 꼭짓점이 채워졌을 때만 대진(팀쌍) 목록을 반환, 미완성이면 null */
export function getRingMatchPairs(ringOrder) {
  const n = ringOrder.length;
  if (n < 2 || ringOrder.some((id) => !id)) return null;
  return getRingEdges(n).map(([i, j]) => ({ teamA: ringOrder[i], teamB: ringOrder[j] }));
}

/** N각형 꼭짓점들의 (x, y) 좌표를 계산한다 (중앙 기준 원형 배치, 맨 위부터 시계방향) */
export function getRingPositions(n, size = 260, margin = 38) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - margin;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return pts;
}

/**
 * 각 변 중앙에서 바깥쪽으로 gap만큼 떨어진 라벨 기준점을 계산한다.
 * translateX/Y는 라벨의 선에 가까운 모서리/변을 기준점에 맞추는 백분율이다.
 * 라벨 너비나 줄 수가 달라져도 카드 테두리와 선 사이의 간격을 유지한다.
 * 반환 순서는 getRingEdges(n)의 구조적 변 순서이며 실제 경기 진행 순서가 아니다.
 */
export function getRingEdgeLabelPositions(n, size = 260, margin = 38, gap = 6) {
  const cx = size / 2;
  const cy = size / 2;
  const positions = getRingPositions(n, size, margin);
  const alignment = (value) => Math.abs(value) < 1e-6 ? -50 : value > 0 ? 0 : -100;
  return getRingEdges(n).map(([i, j]) => {
    const mx = (positions[i].x + positions[j].x) / 2;
    const my = (positions[i].y + positions[j].y) / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // 2팀일 때 변 중앙은 도형 중심과 같으므로 선의 수직 방향을 사용한다.
    const normalX = dist < 1e-6 ? positions[j].y - positions[i].y : dx;
    const normalY = dist < 1e-6 ? positions[i].x - positions[j].x : dy;
    const length = Math.hypot(normalX, normalY);
    const nx = length > 1e-6 ? normalX / length : 0;
    const ny = length > 1e-6 ? normalY / length : 0;
    return {
      x: mx + nx * gap,
      y: my + ny * gap,
      translateX: alignment(nx),
      translateY: alignment(ny),
    };
  });
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * 링크제 도형을 container 안에 그린다.
 * @param {HTMLElement} container
 * @param {object} opts
 *   - ringOrder: (teamId|null)[]
 *   - teamNameById: (id) => string
 *   - editable: boolean - true면 드래그/클릭으로 꼭짓점 배치 가능
 *   - onVertexDrop: (data, targetIndex) => void  (data = {type:'pool', teamId} | {type:'vertex', index})
 *   - onVertexClick: (index) => void
 *   - selectedVertexIndex: number|null - 클릭 선택(이동 중)인 꼭짓점 표시용
 *   - edgeLabels: {text:string,title:string}[]|undefined - 코트·라운드 라벨(생략하면 대진 번호)
 */
export function renderRingDiagram(container, opts) {
  const {
    ringOrder, teamNameById, editable = false,
    onVertexDrop, onVertexClick, selectedVertexIndex = null, edgeLabels,
  } = opts;

  const n = ringOrder.length;
  // 코트·라운드를 생략하지 않는 라벨과 팀 카드가 겹치지 않도록 간격을 확보한다.
  const minimumCenterGap = 240;
  const radius = n > 1 ? minimumCenterGap / (2 * Math.sin(Math.PI / n)) : 0;
  // 바깥쪽에 놓이는 최대 150px 라벨도 스크롤 영역 안에 남도록 여백을 둔다.
  const margin = n <= 4 ? 88 : 164;
  const size = Math.max(260, Math.ceil((radius + margin) * 2));
  const positions = getRingPositions(n, size, margin);
  const edges = getRingEdges(n);
  const filled = n > 0 && ringOrder.every((id) => id);

  container.innerHTML = "";
  container.className = "ring-diagram-scroll";
  container.style.width = "100%";
  container.style.maxWidth = "100%";
  container.style.overflowX = "auto";
  const stage = document.createElement("div");
  stage.className = "ring-diagram";
  stage.style.width = `${size}px`;
  stage.style.height = `${size}px`;
  container.appendChild(stage);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "ring-lines");
  edges.forEach(([i, j]) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", positions[i].x);
    line.setAttribute("y1", positions[i].y);
    line.setAttribute("x2", positions[j].x);
    line.setAttribute("y2", positions[j].y);
    line.setAttribute("class", "ring-edge" + (filled ? " done" : ""));
    svg.appendChild(line);
  });
  stage.appendChild(svg);

  // 카드 중심이 아닌 선에 가까운 테두리를 기준으로 간격을 맞춘다.
  const labelPositions = getRingEdgeLabelPositions(n, size, margin);
  edges.forEach((_, idx) => {
    const pos = labelPositions[idx];
    const label = document.createElement("div");
    label.className = "ring-edge-label" + (filled ? " done" : "");
    label.style.left = pos.x + "px";
    label.style.top = pos.y + "px";
    label.style.transform = `translate(${pos.translateX}%, ${pos.translateY}%)`;
    label.dataset.ringEdgeIndex = String(idx);
    const edgeLabel = Array.isArray(edgeLabels) ? edgeLabels[idx] : null;
    label.textContent = edgeLabel?.text ?? `대진 ${idx + 1}`;
    label.title = edgeLabel?.title ?? `대진 ${idx + 1} · 코트 배정 정보 없음`;
    stage.appendChild(label);
  });

  ringOrder.forEach((teamId, i) => {
    const pos = positions[i];
    const slot = document.createElement("div");
    const isSelected = editable && selectedVertexIndex === i;
    slot.className = "ring-vertex" + (teamId ? " filled" : " empty") + (isSelected ? " selected" : "");
    slot.style.left = pos.x + "px";
    slot.style.top = pos.y + "px";
    slot.textContent = teamId ? (teamNameById(teamId) || "?") : "+";
    slot.dataset.index = String(i);

    if (editable) {
      slot.draggable = !!teamId;
      slot.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ type: "vertex", index: i }));
      });
      slot.addEventListener("dragover", (e) => e.preventDefault());
      slot.addEventListener("dragenter", () => slot.classList.add("drag-over"));
      slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
      slot.addEventListener("drop", (e) => {
        e.preventDefault();
        slot.classList.remove("drag-over");
        const data = safeParseJson(e.dataTransfer.getData("text/plain"));
        if (data && onVertexDrop) onVertexDrop(data, i);
      });
      slot.addEventListener("click", () => {
        if (onVertexClick) onVertexClick(i);
      });
    }
    stage.appendChild(slot);
  });
}

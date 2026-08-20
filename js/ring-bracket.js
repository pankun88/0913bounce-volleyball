/**
 * 링크제(꼭짓점 도형) 예선 대진 - 공용 로직 + 렌더링
 *
 * 링크제: N개 팀을 N각형(폴리곤)의 꼭짓점에 배치하고, "인접한" 꼭짓점끼리만 대결한다.
 * (대각선으로 마주보는 팀과는 경기하지 않음 - 라운드로빈과의 차이점)
 *
 * 이 파일은 admin.js(편집 가능)와 dashboard.js(읽기 전용) 양쪽에서 공통으로 사용한다.
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
 * 각 변(=경기)의 라벨 표시 위치를 계산한다. 변의 중앙에서 중심 반대 방향으로 살짝 띄워
 * 선/꼭짓점과 겹치지 않게 한다. 반환 순서 = getRingEdges(n)의 순서 = 경기 순서(1경기, 2경기...).
 */
export function getRingEdgeLabelPositions(n, size = 260, margin = 38, offset = 9) {
  const cx = size / 2;
  const cy = size / 2;
  const positions = getRingPositions(n, size, margin);
  return getRingEdges(n).map(([i, j]) => {
    const mx = (positions[i].x + positions[j].x) / 2;
    const my = (positions[i].y + positions[j].y) / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-6) return { x: mx, y: my };
    return { x: mx + (dx / dist) * offset, y: my + (dy / dist) * offset };
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
 */
export function renderRingDiagram(container, opts) {
  const {
    ringOrder, teamNameById, editable = false,
    onVertexDrop, onVertexClick, selectedVertexIndex = null,
  } = opts;

  const n = ringOrder.length;
  const size = 260;
  const positions = getRingPositions(n, size);
  const edges = getRingEdges(n);
  const filled = n > 0 && ringOrder.every((id) => id);

  container.innerHTML = "";
  container.className = "ring-diagram";
  container.style.width = size + "px";
  container.style.height = size + "px";

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
  container.appendChild(svg);

  // 경기 순서 라벨: 변(=인접한 두 팀의 대진) 중앙에 1경기, 2경기... 순서를 작게 표시
  const labelPositions = getRingEdgeLabelPositions(n, size);
  edges.forEach((_, idx) => {
    const pos = labelPositions[idx];
    const label = document.createElement("div");
    label.className = "ring-edge-label" + (filled ? " done" : "");
    label.style.left = pos.x + "px";
    label.style.top = pos.y + "px";
    label.textContent = String(idx + 1);
    label.title = `${idx + 1}경기`;
    container.appendChild(label);
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
    container.appendChild(slot);
  });
}

import { groupByRound } from "./bracket.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 본선 대진표를 컨테이너에 그린다 (관리자/대시보드 공용).
 * @param {HTMLElement} container
 * @param {object[]} matches generateBracket() 결과 또는 Firestore에서 읽은 동일 구조
 * @param {{editable?:boolean, onEdit?:(match)=>void}} options
 */
export function renderBracket(container, matches, options = {}) {
  container.innerHTML = "";
  if (!matches || matches.length === 0) {
    container.innerHTML = '<div class="empty-hint">아직 본선 대진표가 생성되지 않았습니다.</div>';
    return;
  }

  const { rounds, thirdPlace } = groupByRound(matches);

  const root = document.createElement("div");
  root.className = "bracket-root";

  if (thirdPlace) {
    const tpWrap = document.createElement("div");
    tpWrap.className = "bracket-thirdplace";
    const label = document.createElement("div");
    label.className = "bracket-third-label";
    label.textContent = "🥉 3·4위전";
    tpWrap.appendChild(label);
    tpWrap.appendChild(renderMatchCard(thirdPlace, options));
    root.appendChild(tpWrap);
  }

  const track = document.createElement("div");
  track.className = "bracket-track";

  const round1Count = rounds.length ? rounds[0].matches.length : 1;
  const cardHeight = 70;
  const gap = 14;
  const trackHeight = round1Count * cardHeight + (round1Count - 1) * gap + 20;
  track.style.minHeight = `${trackHeight}px`;

  rounds.forEach((roundObj) => {
    const col = document.createElement("div");
    col.className = "bracket-round";
    col.style.height = `${trackHeight}px`;

    const title = document.createElement("div");
    title.className = "bracket-round-title";
    title.textContent = roundObj.label;
    col.appendChild(title);

    const matchesWrap = document.createElement("div");
    matchesWrap.className = "bracket-round-matches";

    roundObj.matches.forEach((m) => {
      const slot = document.createElement("div");
      slot.className = "bracket-slot";
      slot.appendChild(renderMatchCard(m, options));
      matchesWrap.appendChild(slot);
    });

    col.appendChild(matchesWrap);
    track.appendChild(col);
  });

  root.appendChild(track);
  container.appendChild(root);

  requestAnimationFrame(() => drawConnectors(track, rounds));
  window.addEventListener("resize", () => drawConnectors(track, rounds), { once: true });
}

function renderMatchCard(match, options) {
  const card = document.createElement("div");
  card.className = "match-card" + (match.status === "done" ? " is-done" : "") + (match.isThirdPlace ? " is-third" : "");
  card.dataset.matchId = match.id;

  card.appendChild(renderSide(match, "A"));
  card.appendChild(renderSide(match, "B"));

  const canEdit = options.editable && match.teamA && match.teamB && match.status !== "bye";
  if (canEdit) {
    const btn = document.createElement("button");
    btn.className = "match-edit-btn";
    btn.type = "button";
    btn.textContent = match.status === "done" ? "점수 수정" : "점수 입력";
    btn.addEventListener("click", () => options.onEdit && options.onEdit(match));
    card.appendChild(btn);
  }
  return card;
}

function renderSide(match, side) {
  const team = side === "A" ? match.teamA : match.teamB;
  const row = document.createElement("div");
  row.className = "match-side" + (match.winnerSide === side ? " is-winner" : "");

  const name = document.createElement("span");
  name.className = "match-team-name";
  name.textContent = team ? team.name : match.status === "bye" ? "(부전승)" : "TBD";
  row.appendChild(name);

  if (match.sets && match.sets.length) {
    const score = document.createElement("span");
    score.className = "match-score";
    score.textContent = match.sets
      .filter((s) => Number(s.a) > 0 || Number(s.b) > 0)
      .map((s) => (side === "A" ? s.a : s.b))
      .join("-");
    row.appendChild(score);
  }
  return row;
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
      const tr = toEl.getBoundingClientRect();
      const x1 = fr.right - trackRect.left;
      const y1 = fr.top + fr.height / 2 - trackRect.top;
      const x2 = tr.left - trackRect.left;
      const y2 = tr.top + tr.height / 2 - trackRect.top;
      const midX = x1 + (x2 - x1) / 2;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`);
      path.setAttribute("class", "bracket-line");
      svg.appendChild(path);
    });
  });
}

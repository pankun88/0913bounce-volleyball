import { isFirebaseConfigured } from "./firebase-init.js";
import {
  saveTournamentInfo, subscribeTournamentInfo,
  addGroup, deleteGroup, subscribeGroups,
  addTeam, deleteTeam, subscribeTeams,
  generatePrelimMatchesForGroup, updatePrelimMatchSets, subscribePrelimMatches,
  generateFinalBracket, saveFinalMatches, subscribeFinalMatches, clearFinalBracket,
} from "./firestore-service.js";
import { evaluatePrelimMatch, evaluateFinalMatch, computeGroupStandings } from "./match-logic.js";
import { recordMatchResult } from "./bracket.js";
import { renderBracket } from "./bracket-render.js";
import { buildFullResultsCsv, downloadCsv } from "./csv-export.js";

// ---------------- 상태 ----------------
let tournamentInfo = {};
let groups = [];
let teams = [];
let prelimMatches = [];
let finalMatches = [];
let seedSelection = []; // 본선 진출팀 id 순서 (시드순)

// ---------------- 부트스트랩 ----------------

if (!isFirebaseConfigured) {
  showToast("⚠️ firebase-config.js 에 Firebase 설정값을 입력해야 동기화가 동작합니다.", 6000);
}

initTabs();
bindStaticHandlers();

subscribeTournamentInfo((info) => {
  tournamentInfo = info || {};
  const nameInput = document.getElementById("tournamentNameInput");
  if (nameInput && !nameInput.value) nameInput.value = tournamentInfo.name || "";
  const bracketTitle = document.getElementById("bracketTitle");
  if (bracketTitle) bracketTitle.textContent = (tournamentInfo.name || "바운스발리볼") + " 본선 대진표";
});

subscribeGroups((data) => {
  groups = data;
  renderGroupList();
  renderTeamGroupSelect();
  renderGroupTeamLists();
  renderPrelimGenerateButtons();
  renderPrelimGroups();
  renderFinalTeamPicker();
});

subscribeTeams((data) => {
  teams = data;
  document.getElementById("teamCount").textContent = teams.length;
  renderGroupTeamLists();
  renderPrelimGroups();
  renderFinalTeamPicker();
});

subscribePrelimMatches((data) => {
  prelimMatches = data;
  renderPrelimGroups();
});

subscribeFinalMatches((data) => {
  finalMatches = data;
  renderFinalBracket();
});

// ---------------- 탭 ----------------

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });
}

// ---------------- 대회설정: 대회명 ----------------

function bindStaticHandlers() {
  document.getElementById("saveTournamentNameBtn").addEventListener("click", async () => {
    const name = document.getElementById("tournamentNameInput").value.trim();
    if (!name) return showToast("대회명을 입력하세요");
    await saveTournamentInfo({ name });
    showToast("저장되었습니다");
  });

  document.getElementById("addGroupBtn").addEventListener("click", async () => {
    const input = document.getElementById("groupNameInput");
    const name = input.value.trim();
    if (!name) return showToast("조 이름을 입력하세요");
    await addGroup(name);
    input.value = "";
  });

  document.getElementById("addTeamBtn").addEventListener("click", async () => {
    const nameInput = document.getElementById("teamNameInput");
    const groupSelect = document.getElementById("teamGroupSelect");
    const name = nameInput.value.trim();
    if (!name) return showToast("팀 이름을 입력하세요");
    await addTeam(name, groupSelect.value || null);
    nameInput.value = "";
  });

  document.getElementById("generateBracketBtn").addEventListener("click", onGenerateBracket);
  document.getElementById("clearBracketBtn").addEventListener("click", async () => {
    if (!confirm("본선 대진표를 초기화할까요? 입력된 점수도 모두 사라집니다.")) return;
    await clearFinalBracket();
    showToast("대진표를 초기화했습니다");
  });

  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    const csv = buildFullResultsCsv({
      tournamentName: tournamentInfo.name,
      groups, teams, prelimMatches, finalMatches,
    });
    const fname = `${(tournamentInfo.name || "바운스발리볼").replace(/\s+/g, "_")}_결과_${dateStamp()}.csv`;
    downloadCsv(fname, csv);
  });
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------- 대회설정: 조 / 팀 ----------------

function renderGroupList() {
  const el = document.getElementById("groupList");
  if (!groups.length) {
    el.innerHTML = '<span class="empty-hint">아직 등록된 조가 없습니다.</span>';
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const pill = document.createElement("span");
    pill.className = "team-pill";
    pill.innerHTML = `${escapeHtml(g.name)} <button title="삭제">✕</button>`;
    pill.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`'${g.name}' 조를 삭제할까요? (소속 팀은 무소속이 됩니다)`)) return;
      await deleteGroup(g.id);
    });
    el.appendChild(pill);
  });
}

function renderTeamGroupSelect() {
  const sel = document.getElementById("teamGroupSelect");
  const current = sel.value;
  sel.innerHTML = '<option value="">조 선택</option>' +
    groups.map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
  sel.value = current;
}

function renderGroupTeamLists() {
  const el = document.getElementById("groupTeamLists");
  if (!groups.length) {
    el.innerHTML = '<div class="empty-hint">먼저 조를 등록하세요.</div>';
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    const box = document.createElement("div");
    box.className = "card";
    box.style.margin = "0";
    box.innerHTML = `<h3>${escapeHtml(g.name)} <span style="color:var(--muted); font-weight:400;">(${groupTeams.length}팀)</span></h3>`;
    const list = document.createElement("div");
    list.className = "row";
    if (!groupTeams.length) {
      list.innerHTML = '<span class="empty-hint">팀 없음</span>';
    } else {
      groupTeams.forEach((t) => {
        const pill = document.createElement("span");
        pill.className = "team-pill";
        pill.innerHTML = `${escapeHtml(t.name)} <button title="삭제">✕</button>`;
        pill.querySelector("button").addEventListener("click", async () => {
          if (!confirm(`'${t.name}' 팀을 삭제할까요?`)) return;
          await deleteTeam(t.id);
        });
        list.appendChild(pill);
      });
    }
    box.appendChild(list);
    el.appendChild(box);
  });

  const noGroupTeams = teams.filter((t) => !t.groupId);
  if (noGroupTeams.length) {
    const box = document.createElement("div");
    box.className = "card";
    box.style.margin = "0";
    box.innerHTML = `<h3>미배정</h3>`;
    const list = document.createElement("div");
    list.className = "row";
    noGroupTeams.forEach((t) => {
      const pill = document.createElement("span");
      pill.className = "team-pill";
      pill.innerHTML = `${escapeHtml(t.name)} <button title="삭제">✕</button>`;
      pill.querySelector("button").addEventListener("click", async () => {
        if (!confirm(`'${t.name}' 팀을 삭제할까요?`)) return;
        await deleteTeam(t.id);
      });
      list.appendChild(pill);
    });
    box.appendChild(list);
    el.appendChild(box);
  }
}

// ---------------- 예선 ----------------

function renderPrelimGenerateButtons() {
  const el = document.getElementById("prelimGenerateButtons");
  if (!groups.length) {
    el.innerHTML = '<span class="empty-hint">먼저 대회설정 탭에서 조를 만들어 주세요.</span>';
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = `${g.name} 일정 생성`;
    btn.addEventListener("click", async () => {
      const groupTeams = teams.filter((t) => t.groupId === g.id);
      if (groupTeams.length < 2) return showToast(`${g.name}에 팀이 2팀 이상 필요합니다`);
      if (!confirm(`${g.name} 예선 일정을 (재)생성할까요? 기존 결과는 초기화됩니다.`)) return;
      await generatePrelimMatchesForGroup(g.id, groupTeams.map((t) => t.id));
      showToast(`${g.name} 일정을 생성했습니다`);
    });
    el.appendChild(btn);
  });
}

function renderPrelimGroups() {
  const el = document.getElementById("prelimGroups");
  if (!groups.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = "";
  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id);
    const standings = computeGroupStandings(groupTeams, groupMatches);

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h2>📋 ${escapeHtml(g.name)} 예선</h2>`;

    // 순위표
    if (standings.length) {
      const table = document.createElement("table");
      table.innerHTML = `<thead><tr>
        <th>순위</th><th>팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>승점</th><th>세트득실</th><th>득실차</th>
      </tr></thead>`;
      const tbody = document.createElement("tbody");
      standings.forEach((s) => {
        const tr = document.createElement("tr");
        if (s.rank === 1) tr.className = "rank-1";
        tr.innerHTML = `<td>${s.rank}${s.needsLottery ? '<div class="lottery-flag">동률·추첨필요</div>' : ""}</td>
          <td>${escapeHtml(s.name)}</td><td>${s.played}</td><td>${s.win}</td><td>${s.draw}</td><td>${s.loss}</td>
          <td>${s.points}</td><td>${s.setDiff >= 0 ? "+" : ""}${s.setDiff}</td><td>${s.pointDiff >= 0 ? "+" : ""}${s.pointDiff}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
    } else {
      card.innerHTML += '<div class="empty-hint">참가팀이 없습니다.</div>';
    }

    // 경기 목록
    const matchList = document.createElement("div");
    matchList.style.marginTop = "14px";
    if (!groupMatches.length) {
      matchList.innerHTML = '<div class="empty-hint">생성된 경기가 없습니다. 위에서 일정을 생성하세요.</div>';
    } else {
      groupMatches.forEach((m) => {
        const row = document.createElement("div");
        row.className = "row";
        row.style.justifyContent = "space-between";
        row.style.padding = "8px 4px";
        row.style.borderBottom = "1px solid var(--line)";
        const evald = evaluatePrelimMatch(m.sets || []);
        const scoreText = (m.sets || []).filter((s) => Number(s.a) > 0 || Number(s.b) > 0).map((s) => `${s.a}:${s.b}`).join(" / ");
        const resultBadge = evald.result === "A" ? `<span class="badge win">${teamName(m.teamA)} 승</span>`
          : evald.result === "B" ? `<span class="badge win">${teamName(m.teamB)} 승</span>`
          : evald.result === "draw" ? '<span class="badge draw">무승부</span>'
          : '<span class="badge">경기전</span>';
        row.innerHTML = `<span>${escapeHtml(teamName(m.teamA))} <b>vs</b> ${escapeHtml(teamName(m.teamB))} <span style="color:var(--muted); font-size:12px;">${scoreText}</span></span>`;
        const right = document.createElement("span");
        right.className = "row";
        right.innerHTML = resultBadge;
        const editBtn = document.createElement("button");
        editBtn.className = "btn small";
        editBtn.textContent = evald.status === "done" ? "점수 수정" : "점수 입력";
        editBtn.addEventListener("click", () => openPrelimScoreModal(m));
        right.appendChild(editBtn);
        row.appendChild(right);
        matchList.appendChild(row);
      });
    }
    card.appendChild(matchList);
    el.appendChild(card);
  });
}

function teamName(id) {
  const t = teams.find((x) => x.id === id);
  return t ? t.name : "?";
}

function openPrelimScoreModal(match) {
  openScoreModal({
    teamAName: teamName(match.teamA),
    teamBName: teamName(match.teamB),
    setLabels: ["1세트 (10점)", "2세트 (10점)"],
    existingSets: match.sets || [],
    onSave: async (sets) => {
      await updatePrelimMatchSets(match.id, sets);
      showToast("저장되었습니다");
    },
  });
}

// ---------------- 본선 ----------------

function renderFinalTeamPicker() {
  const el = document.getElementById("finalTeamPicker");
  el.innerHTML = "";

  // 좌측: 전체 팀 체크리스트
  const left = document.createElement("div");
  left.innerHTML = "<h3>진출팀 선택</h3>";
  if (!teams.length) {
    left.innerHTML += '<div class="empty-hint">등록된 팀이 없습니다.</div>';
  }
  groups.forEach((g) => {
    const groupTeams = teams.filter((t) => t.groupId === g.id);
    if (!groupTeams.length) return;
    const groupMatches = prelimMatches.filter((m) => m.groupId === g.id);
    const standings = computeGroupStandings(groupTeams, groupMatches);
    const rankById = Object.fromEntries(standings.map((s) => [s.teamId, s.rank]));

    const sub = document.createElement("div");
    sub.style.marginBottom = "10px";
    sub.innerHTML = `<div style="font-weight:700; font-size:13px; margin-bottom:6px;">${escapeHtml(g.name)}</div>`;
    groupTeams
      .sort((a, b) => (rankById[a.id] || 99) - (rankById[b.id] || 99))
      .forEach((t) => {
        const row = document.createElement("label");
        row.className = "row";
        row.style.justifyContent = "flex-start";
        row.style.gap = "8px";
        row.style.padding = "3px 0";
        const checked = seedSelection.includes(t.id);
        row.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""} /> ${escapeHtml(t.name)} ${rankById[t.id] ? `<span class="badge">예선 ${rankById[t.id]}위</span>` : ""}`;
        row.querySelector("input").addEventListener("change", (e) => {
          if (e.target.checked) {
            if (!seedSelection.includes(t.id)) seedSelection.push(t.id);
          } else {
            seedSelection = seedSelection.filter((id) => id !== t.id);
          }
          renderFinalTeamPicker();
        });
        sub.appendChild(row);
      });
    left.appendChild(sub);
  });
  el.appendChild(left);

  // 우측: 시드 순서
  const right = document.createElement("div");
  right.innerHTML = "<h3>시드 순서 (1번 시드부터)</h3>";
  // 선택목록에서 더이상 존재하지 않는 팀 제거
  seedSelection = seedSelection.filter((id) => teams.some((t) => t.id === id));
  if (!seedSelection.length) {
    right.innerHTML += '<div class="empty-hint">좌측에서 진출팀을 선택하세요.</div>';
  } else {
    seedSelection.forEach((id, idx) => {
      const row = document.createElement("div");
      row.className = "row";
      row.style.justifyContent = "space-between";
      row.style.padding = "5px 8px";
      row.style.background = "var(--cream-light)";
      row.style.borderRadius = "8px";
      row.style.marginBottom = "5px";
      row.innerHTML = `<span><b>${idx + 1}</b>. ${escapeHtml(teamName(id))}</span>`;
      const btns = document.createElement("span");
      btns.className = "row";
      const upBtn = document.createElement("button");
      upBtn.className = "btn small ghost";
      upBtn.textContent = "↑";
      upBtn.disabled = idx === 0;
      upBtn.addEventListener("click", () => {
        [seedSelection[idx - 1], seedSelection[idx]] = [seedSelection[idx], seedSelection[idx - 1]];
        renderFinalTeamPicker();
      });
      const downBtn = document.createElement("button");
      downBtn.className = "btn small ghost";
      downBtn.textContent = "↓";
      downBtn.disabled = idx === seedSelection.length - 1;
      downBtn.addEventListener("click", () => {
        [seedSelection[idx + 1], seedSelection[idx]] = [seedSelection[idx], seedSelection[idx + 1]];
        renderFinalTeamPicker();
      });
      btns.appendChild(upBtn);
      btns.appendChild(downBtn);
      row.appendChild(btns);
      right.appendChild(row);
    });
  }
  el.appendChild(right);
}

async function onGenerateBracket() {
  if (seedSelection.length < 2) return showToast("본선 진출팀을 2팀 이상 선택하세요");
  if (seedSelection.length > 32) return showToast("본선 진출팀은 최대 32팀까지 지원합니다");
  if (!confirm(`${seedSelection.length}팀으로 본선 대진표를 생성할까요? 기존 대진표는 초기화됩니다.`)) return;
  const teamsInSeedOrder = seedSelection.map((id) => ({ id, name: teamName(id) }));
  await generateFinalBracket(teamsInSeedOrder);
  showToast("본선 대진표를 생성했습니다");
}

function renderFinalBracket() {
  const container = document.getElementById("finalBracketContainer");
  renderBracket(container, finalMatches, { editable: true, onEdit: openFinalScoreModal });
}

function openFinalScoreModal(match) {
  openScoreModal({
    teamAName: match.teamA ? match.teamA.name : "",
    teamBName: match.teamB ? match.teamB.name : "",
    setLabels: ["1세트 (10점)", "2세트 (10점)", "3세트 (7점, 필요시만)"],
    existingSets: match.sets || [],
    onSave: async (sets) => {
      recordMatchResult(finalMatches, match.id, sets, evaluateFinalMatch);
      await saveFinalMatches(finalMatches);
      showToast("저장되었습니다");
    },
  });
}

// ---------------- 모달 / 토스트 ----------------

function openScoreModal({ teamAName, teamBName, setLabels, existingSets, onSave }) {
  const root = document.getElementById("modalRoot");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.innerHTML = `<h3>${escapeHtml(teamAName)} vs ${escapeHtml(teamBName)}</h3>`;

  setLabels.forEach((label, i) => {
    const existing = existingSets[i] || { a: "", b: "" };
    const row = document.createElement("div");
    row.className = "set-input-row";
    row.innerHTML = `<label>${label}</label>
      <input type="number" min="0" max="15" data-side="a" data-idx="${i}" value="${existing.a === 0 ? 0 : existing.a || ""}" placeholder="${escapeHtml(teamAName)}" />
      :
      <input type="number" min="0" max="15" data-side="b" data-idx="${i}" value="${existing.b === 0 ? 0 : existing.b || ""}" placeholder="${escapeHtml(teamBName)}" />`;
    box.appendChild(row);
  });

  const actions = document.createElement("div");
  actions.className = "row";
  actions.style.justifyContent = "flex-end";
  actions.style.marginTop = "12px";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn ghost";
  cancelBtn.textContent = "취소";
  cancelBtn.addEventListener("click", () => overlay.remove());
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn primary";
  saveBtn.textContent = "저장";
  saveBtn.addEventListener("click", async () => {
    const sets = setLabels.map((_, i) => {
      const a = box.querySelector(`input[data-side="a"][data-idx="${i}"]`).value;
      const b = box.querySelector(`input[data-side="b"][data-idx="${i}"]`).value;
      return { a: a === "" ? 0 : Number(a), b: b === "" ? 0 : Number(b) };
    }).filter((s, i) => i < 2 || s.a > 0 || s.b > 0); // 3세트는 입력 없으면 제외
    saveBtn.disabled = true;
    await onSave(sets);
    overlay.remove();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  root.appendChild(overlay);
}

let toastTimer = null;
function showToast(msg, duration = 2200) {
  const el = document.getElementById("toastRoot");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

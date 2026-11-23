// 桶狭間 1560 — ヘックスウォーゲーム試作エンジン
// ルール概要:
// - ターン制（織田フェイズ → 今川フェイズ）。全8ターン。
// - 移動はダイクストラで到達可能ヘックスを計算（地形コスト＋敵ZOCで停止）。
// - 戦闘は戦力比によるCRT（戦闘結果表）を1d6で解決。損害（戦力減少）と退却。
// - 今川本陣は「油断」状態で開始し、織田軍の接近・戦闘・時間経過で「警戒」に移る。
// - 通説モードでは第4ターンに豪雨。今川軍の防御が落ち、警戒判定も鈍る。
"use strict";

const HEX_SIZE = 34;
const MARGIN = 36;
const SQRT3 = Math.sqrt(3);

const state = {
  mode: "rain",
  turn: 1,
  phase: "oda", // "oda" | "imagawa" | "over"
  units: [],
  selected: null,
  reachable: new Map(), // "col,row" -> cost
  alarmed: false,
  busy: false,
  log: []
};

// ---------- 座標ユーティリティ（odd-r オフセット座標） ----------
function key(col, row) { return col + "," + row; }
function inBounds(col, row) { return col >= 0 && col < SCENARIO.cols && row >= 0 && row < SCENARIO.rows; }
function terrainAt(col, row) { return TERRAIN[SCENARIO.map[row][col]]; }
function neighbors(col, row) {
  const even = (row % 2 === 0);
  const offs = even
    ? [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]]
    : [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];
  const out = [];
  for (const [dc, dr] of offs) {
    const c = col + dc, r = row + dr;
    if (inBounds(c, r)) out.push([c, r]);
  }
  return out;
}
function toCube(col, row) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  return [x, -x - z, z];
}
function distance(aCol, aRow, bCol, bRow) {
  const [ax, ay, az] = toCube(aCol, aRow);
  const [bx, by, bz] = toCube(bCol, bRow);
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}
function center(col, row) {
  return {
    x: MARGIN + HEX_SIZE * SQRT3 * (col + 0.5 * (row & 1)),
    y: MARGIN + HEX_SIZE * 1.5 * row + HEX_SIZE
  };
}
function unitAt(col, row) {
  return state.units.find(u => u.alive && u.col === col && u.row === row) || null;
}
function enemyOf(unit) { return unit.side === "oda" ? "imagawa" : "oda"; }
function inEnemyZoc(col, row, side) {
  const foe = side === "oda" ? "imagawa" : "oda";
  return state.units.some(u => u.alive && u.side === foe && distance(u.col, u.row, col, row) === 1);
}

// ---------- 初期化 ----------
function initGame() {
  state.units = SCENARIO.units.map(u => ({
    ...u, maxStr: u.str, alive: true, moved: false, attacked: false
  }));
  state.turn = 1;
  state.phase = "oda";
  state.selected = null;
  state.reachable = new Map();
  state.alarmed = state.mode === "frontal";
  state.busy = false;
  state.log = [];
  document.getElementById("log").innerHTML = "";
  log(`ゲーム開始（${state.mode === "rain" ? "通説モード：豪雨の奇襲" : "正面攻撃モード"}）。`);
  log("織田軍は善照寺〜太子ヶ根に結集。今川本陣は田楽狭間にあり、油断している。");
  if (state.mode === "frontal") log("正面攻撃モード：今川本陣は最初から警戒している。織田軍は丘陵から攻撃すると戦力+1。");
  updateStatus();
  draw();
}

// ---------- ログ・表示 ----------
function log(msg) {
  state.log.push(msg);
  const el = document.getElementById("log");
  const p = document.createElement("p");
  p.textContent = msg;
  el.appendChild(p);
  el.scrollTop = el.scrollHeight;
}
function isRainTurn() { return state.mode === "rain" && state.turn === 4; }
function updateStatus() {
  document.getElementById("turn-info").textContent = `ターン ${Math.min(state.turn, SCENARIO.maxTurns)} / ${SCENARIO.maxTurns}`;
  document.getElementById("phase-info").textContent =
    state.phase === "oda" ? "織田軍フェイズ" : state.phase === "imagawa" ? "今川軍フェイズ" : "終了";
  document.getElementById("weather-info").textContent = isRainTurn() ? "☔ 豪雨" : "";
  const camp = state.units.find(u => u.id === "yoshimoto");
  document.getElementById("alarm-info").textContent =
    camp && camp.alive ? (state.alarmed ? "本陣：警戒" : "本陣：油断") : "";
  document.getElementById("end-phase").disabled = state.busy || state.phase !== "oda";
}

// ---------- 戦力計算 ----------
function attackStrength(unit) {
  let s = unit.str;
  if (state.mode === "rain" && isRainTurn() && unit.side === "oda") s += 1; // 豪雨に乗じた攻撃
  if (state.mode === "frontal" && unit.side === "oda" && terrainAt(unit.col, unit.row).name === "丘陵") s += 1;
  return Math.max(1, s);
}
function defenseStrength(unit) {
  let s = unit.str + terrainAt(unit.col, unit.row).def;
  if (unit.side === "imagawa" && (unit.guard || unit.hq) && !state.alarmed) s -= 2; // 油断
  if (state.mode === "rain" && isRainTurn() && unit.side === "imagawa") s -= 2; // 豪雨で混乱
  return Math.max(1, s);
}

// ---------- 移動 ----------
function computeReachable(unit) {
  const result = new Map();
  const dist = new Map();
  const startK = key(unit.col, unit.row);
  dist.set(startK, 0);
  const pq = [[0, unit.col, unit.row]];
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [cost, c, r] = pq.shift();
    if (cost > (dist.get(key(c, r)) ?? Infinity)) continue;
    // 敵ZOCに入ったらそこで停止（開始ヘックスを除く）
    const stopped = !(c === unit.col && r === unit.row) && inEnemyZoc(c, r, unit.side);
    if (stopped) continue;
    for (const [nc, nr] of neighbors(c, r)) {
      const occ = unitAt(nc, nr);
      if (occ && occ.side !== unit.side) continue; // 敵ユニットのヘックスには入れない
      let step = terrainAt(nc, nr).cost;
      if (inEnemyZoc(nc, nr, unit.side)) step += 2;
      const nCost = cost + step;
      if (nCost > unit.mp) continue;
      const nk = key(nc, nr);
      if (nCost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nCost);
        if (!occ) result.set(nk, nCost); // 味方のいるヘックスは通過のみ
        pq.push([nCost, nc, nr]);
      }
    }
  }
  return result;
}

// ---------- 戦闘 ----------
const CRT = [
  // 比率列: [0]<1:2 [1]1:2 [2]1:1 [3]2:1 [4]3:1 [5]4:1以上 / 各 [攻損失, 守損失, 守退却]
  [[3, 0, 0], [2, 0, 0], [2, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]],
  [[2, 0, 0], [2, 0, 0], [1, 0, 0], [1, 0, 1], [0, 1, 1], [0, 2, 1]],
  [[2, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 1], [0, 2, 1], [0, 2, 2]],
  [[1, 0, 0], [1, 1, 0], [0, 1, 1], [0, 2, 1], [0, 2, 2], [0, 99, 0]],
  [[1, 1, 0], [0, 1, 1], [0, 2, 1], [0, 2, 2], [0, 3, 2], [0, 99, 0]],
  [[0, 1, 1], [0, 2, 1], [0, 2, 2], [0, 3, 2], [0, 99, 0], [0, 99, 0]]
];
function crtColumn(ratio) {
  if (ratio < 0.5) return 0;
  if (ratio < 1.0) return 1;
  if (ratio < 1.5) return 2;
  if (ratio < 2.5) return 3;
  if (ratio < 3.5) return 4;
  return 5;
}
function applyLoss(unit, loss) {
  if (loss >= 99) { unit.str = 0; }
  else { unit.str -= loss; }
  if (unit.str <= 0) {
    unit.alive = false;
    log(`　${unit.name} は壊滅した。`);
  }
}
function retreat(unit, hexes, attacker) {
  for (let i = 0; i < hexes && unit.alive; i++) {
    const options = neighbors(unit.col, unit.row)
      .filter(([c, r]) => !unitAt(c, r))
      .sort((a, b) => distance(b[0], b[1], attacker.col, attacker.row) - distance(a[0], a[1], attacker.col, attacker.row));
    const safe = options.filter(([c, r]) => !inEnemyZoc(c, r, unit.side));
    const pick = (safe.length ? safe : options)[0];
    if (!pick) { applyLoss(unit, 1); log(`　${unit.name} は退却できず追加損害。`); continue; }
    unit.col = pick[0]; unit.row = pick[1];
  }
}
function resolveCombat(attacker, defender) {
  const aStr = attackStrength(attacker);
  const dStr = defenseStrength(defender);
  const ratio = aStr / dStr;
  const die = 1 + Math.floor(Math.random() * 6);
  const [aLoss, dLoss, dRet] = CRT[crtColumn(ratio)][die - 1];
  log(`⚔ ${attacker.name}（戦力${aStr}）→ ${defender.name}（防御${dStr}）比${ratio.toFixed(1)}:1、ダイス${die}：攻-${aLoss === 99 ? "壊滅" : aLoss} 守-${dLoss === 99 ? "壊滅" : dLoss}${dRet ? ` 守退却${dRet}` : ""}`);
  if (defender.side === "imagawa" && (defender.guard || defender.hq)) triggerAlarm("本陣が攻撃を受けた");
  applyLoss(defender, dLoss);
  if (defender.alive && dRet) retreat(defender, dRet, attacker);
  applyLoss(attacker, aLoss);
  attacker.attacked = true;
  checkVictory();
}

// ---------- 警戒 ----------
function triggerAlarm(reason) {
  if (!state.alarmed) {
    state.alarmed = true;
    log(`⚠ 今川本陣が警戒態勢に入った（${reason}）。`);
    updateStatus();
  }
}
function checkAlarm() {
  if (state.alarmed) return;
  const campUnits = state.units.filter(u => u.alive && u.side === "imagawa" && (u.guard || u.hq));
  const range = isRainTurn() ? 1 : 2;
  const near = state.units.some(u => u.alive && u.side === "oda" &&
    campUnits.some(c => distance(u.col, u.row, c.col, c.row) <= range));
  if (near) triggerAlarm("織田軍の接近を探知");
  else if (state.turn >= 5) triggerAlarm("時間経過");
}

// ---------- 勝敗 ----------
function checkVictory() {
  const yoshi = state.units.find(u => u.id === "yoshimoto");
  const nobu = state.units.find(u => u.id === "nobunaga");
  if (yoshi && !yoshi.alive) {
    endGame(true, state.turn <= 5 ? "織田軍の大勝利" : "織田軍の勝利",
      `今川義元は討ち取られた（ターン${state.turn}）。今川軍は総崩れとなり、歴史通りの結末となった。`);
    return true;
  }
  if (nobu && !nobu.alive) {
    endGame(false, "今川軍の勝利", "織田信長本隊が壊滅した。尾張の小大名の挑戦はここで潰えた。");
    return true;
  }
  return false;
}
function judgeAtEnd() {
  const yoshi = state.units.find(u => u.id === "yoshimoto");
  if (yoshi && yoshi.alive && yoshi.str * 2 <= yoshi.maxStr) {
    endGame(true, "織田軍の小勝利", "8ターン終了。本陣は壊滅的な打撃を受けたが、義元自身は脱出した。今川軍の尾張侵攻は頓挫した。");
  } else {
    endGame(false, "今川軍の勝利", "8ターン終了。今川義元は本陣を守り切った。信長の賭けは実らなかった。");
  }
}
function endGame(odaWon, title, text) {
  state.phase = "over";
  document.getElementById("end-title").textContent = title;
  document.getElementById("end-text").textContent = text;
  document.getElementById("end-overlay").classList.remove("hidden");
  log(`■ ${title}：${text}`);
  updateStatus();
  draw();
}

// ---------- 今川軍AI ----------
function aiTakeTurn(done) {
  const actors = state.units.filter(u => u.alive && u.side === "imagawa");
  let i = 0;
  const step = () => {
    if (state.phase === "over") { done(); return; }
    if (i >= actors.length) { done(); return; }
    const u = actors[i++];
    if (u.alive) aiActivate(u);
    draw();
    if (checkVictory()) { done(); return; }
    setTimeout(step, 350);
  };
  step();
}
function bestAttackTarget(u) {
  const foes = state.units.filter(v => v.alive && v.side === "oda" &&
    distance(u.col, u.row, v.col, v.row) === 1);
  if (!foes.length) return null;
  foes.sort((a, b) => defenseStrength(a) - defenseStrength(b));
  return foes[0];
}
function aiActivate(u) {
  // 本陣・警固は動かない（攻撃のみ）
  if (!u.guard && !u.hq) {
    const target = nearestFoe(u);
    const goal = target || { col: 1, row: 1 }; // 織田がいなければ善照寺方面へ前進
    if (!(target && distance(u.col, u.row, target.col, target.row) === 1)) {
      const reach = computeReachable(u);
      let best = null, bestScore = Infinity;
      for (const k of reach.keys()) {
        const [c, r] = k.split(",").map(Number);
        const d = distance(c, r, goal.col, goal.row);
        if (d < bestScore) { bestScore = d; best = [c, r]; }
      }
      if (best && (best[0] !== u.col || best[1] !== u.row)) {
        u.col = best[0]; u.row = best[1];
      }
    }
  }
  const foe = bestAttackTarget(u);
  if (foe) {
    const ratio = attackStrength(u) / defenseStrength(foe);
    if (ratio >= 0.9) { resolveCombat(u, foe); return; }
  }
}
function nearestFoe(u) {
  const foes = state.units.filter(v => v.alive && v.side === "oda");
  if (!foes.length) return null;
  foes.sort((a, b) => distance(u.col, u.row, a.col, a.row) - distance(u.col, u.row, b.col, b.row));
  return foes[0];
}

// ---------- ターン進行 ----------
function endPhase() {
  if (state.phase !== "oda" || state.busy) return;
  state.selected = null;
  state.reachable = new Map();
  state.phase = "imagawa";
  state.busy = true;
  checkAlarm();
  updateStatus();
  draw();
  log(`— ターン${state.turn} 今川軍フェイズ —`);
  aiTakeTurn(() => {
    state.busy = false;
    if (state.phase === "over") { updateStatus(); draw(); return; }
    if (state.turn >= SCENARIO.maxTurns) { judgeAtEnd(); return; }
    state.turn++;
    state.phase = "oda";
    for (const u of state.units) { u.moved = false; u.attacked = false; }
    if (isRainTurn()) log("☔ 激しい豪雨が戦場を叩く。今川軍は混乱している。");
    checkAlarm();
    log(`— ターン${state.turn} 織田軍フェイズ —`);
    updateStatus();
    draw();
  });
}

// ---------- 入力 ----------
function hexFromEvent(ev) {
  const rect = ev.target.getBoundingClientRect();
  const scaleX = ev.target.width / rect.width;
  const scaleY = ev.target.height / rect.height;
  const px = (ev.clientX - rect.left) * scaleX;
  const py = (ev.clientY - rect.top) * scaleY;
  let best = null, bestD = Infinity;
  for (let r = 0; r < SCENARIO.rows; r++) {
    for (let c = 0; c < SCENARIO.cols; c++) {
      const { x, y } = center(c, r);
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) { bestD = d; best = [c, r]; }
    }
  }
  return bestD <= HEX_SIZE * 1.05 ? best : null;
}
function showUnitInfo(u, col, row) {
  const el = document.getElementById("unit-detail");
  if (u) {
    const t = terrainAt(u.col, u.row);
    const camp = u.side === "imagawa" && (u.guard || u.hq);
    el.innerHTML = `<strong>${u.name}</strong>（${u.side === "oda" ? "織田軍" : "今川軍"}）<br>` +
      `戦力 ${u.str} / ${u.maxStr}（攻撃時 ${attackStrength(u)}・防御時 ${defenseStrength(u)}）<br>` +
      `地形：${t.name}${camp ? `／本陣は現在「${state.alarmed ? "警戒" : "油断"}」` : ""}` +
      (u.side === "oda" && state.phase === "oda" ? `<br>移動：${u.moved ? "済" : "可"}／攻撃：${u.attacked ? "済" : "可"}` : "");
  } else if (col !== undefined) {
    const t = terrainAt(col, row);
    el.innerHTML = `地形：${t.name}（移動コスト ${t.cost}、防御ボーナス +${t.def}）`;
  }
}
function onTap(ev) {
  if (state.phase !== "oda" || state.busy) return;
  const hex = hexFromEvent(ev);
  if (!hex) return;
  const [c, r] = hex;
  const clicked = unitAt(c, r);
  const sel = state.selected;
  if (sel && clicked && clicked.side === "imagawa" && !sel.attacked &&
      distance(sel.col, sel.row, c, r) === 1) {
    resolveCombat(sel, clicked);
    state.selected = state.units.find(u => u.id === sel.id && u.alive) ? sel : null;
    showUnitInfo(state.selected, c, r);
    updateStatus();
    draw();
    return;
  }
  if (sel && !clicked && state.reachable.has(key(c, r)) && !sel.moved && !sel.attacked) {
    sel.col = c; sel.row = r; sel.moved = true;
    state.reachable = new Map();
    showUnitInfo(sel);
    draw();
    return;
  }
  if (clicked && clicked.side === "oda") {
    state.selected = clicked;
    state.reachable = (!clicked.moved && !clicked.attacked) ? computeReachable(clicked) : new Map();
    showUnitInfo(clicked);
  } else {
    state.selected = clicked && clicked.side === "imagawa" ? state.selected : null;
    if (!clicked) { state.reachable = new Map(); }
    showUnitInfo(clicked, c, r);
  }
  draw();
}

// ---------- 描画 ----------
function hexPath(ctx, x, y, size) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i - 30);
    const hx = x + size * Math.cos(angle);
    const hy = y + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
  }
  ctx.closePath();
}
function draw() {
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 地形
  for (let r = 0; r < SCENARIO.rows; r++) {
    for (let c = 0; c < SCENARIO.cols; c++) {
      const { x, y } = center(c, r);
      const t = terrainAt(c, r);
      hexPath(ctx, x, y, HEX_SIZE - 1);
      ctx.fillStyle = t.color;
      ctx.fill();
      ctx.strokeStyle = "rgba(90,74,40,0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
      const ch = SCENARIO.map[r][c];
      ctx.fillStyle = "rgba(60,48,20,0.75)";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      if (ch === "f" || ch === "C") {
        ctx.strokeStyle = "#4a3b20";
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 8, y - 18, 16, 13);
      }
      if (ch === "h") ctx.fillText("▲", x, y - 12);
      if (ch === "w") ctx.fillText("🌲", x, y - 10);
      if (ch === "v") ctx.fillText("谷", x, y - 12);
    }
  }
  // 移動可能ヘックス
  if (state.selected && state.phase === "oda") {
    for (const k of state.reachable.keys()) {
      const [c, r] = k.split(",").map(Number);
      const { x, y } = center(c, r);
      hexPath(ctx, x, y, HEX_SIZE - 3);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.stroke();
    }
  }
  // 地名
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  for (const lb of SCENARIO.labels) {
    const { x, y } = center(lb.col, lb.row);
    ctx.fillStyle = "rgba(43,36,24,0.85)";
    ctx.fillText(lb.text, x, y + HEX_SIZE - 6);
  }
  // ユニット
  for (const u of state.units) {
    if (!u.alive) continue;
    const { x, y } = center(u.col, u.row);
    const done = state.phase === "oda" && u.side === "oda" && u.attacked;
    ctx.globalAlpha = done ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(x, y, HEX_SIZE * 0.44, 0, Math.PI * 2);
    ctx.fillStyle = u.side === "oda" ? "#b03a2e" : "#2e4053";
    ctx.fill();
    ctx.lineWidth = u.hq ? 3.5 : 2;
    ctx.strokeStyle = u.hq ? "#f2c230" : "#fffdf6";
    ctx.stroke();
    if (state.selected === u) {
      ctx.beginPath();
      ctx.arc(x, y, HEX_SIZE * 0.56, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffdf3a";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(u.short, x, y - 1);
    ctx.font = "bold 13px sans-serif";
    ctx.fillText(String(u.str), x, y + 14);
    ctx.globalAlpha = 1;
  }
  // 豪雨オーバーレイ
  if (isRainTurn() && state.phase !== "over") {
    ctx.fillStyle = "rgba(70,90,120,0.13)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

// ---------- 起動 ----------
document.getElementById("map").addEventListener("click", onTap);
document.getElementById("end-phase").addEventListener("click", endPhase);
document.getElementById("restart").addEventListener("click", () => { initGame(); showUnitInfo(null); });
document.getElementById("again").addEventListener("click", () => {
  document.getElementById("end-overlay").classList.add("hidden");
  initGame();
  showUnitInfo(null);
});
document.getElementById("start-game").addEventListener("click", () => {
  state.mode = document.querySelector('input[name="mode"]:checked').value;
  document.getElementById("start-overlay").style.display = "none";
  initGame();
});
initGame();

// 桶狭間 1560 — ヘックスウォーゲーム試作エンジン
// ルール概要:
// - ターン制（織田フェイズ → 今川フェイズ）。全8ターン。
// - 移動はダイクストラで到達可能ヘックスを計算（地形コスト＋敵ZOCで停止）。
// - 戦闘は戦力比によるCRT（戦闘結果表）を1d6で解決。損害（戦力減少）と退却。
// - 今川本陣は「油断」状態で開始し、織田軍の接近・戦闘・時間経過で「警戒」に移る。
// - 通説モードでは第4ターンに豪雨。今川軍の防御が落ち、警戒判定も鈍る。
// - 開始時に指揮する軍（織田／今川）を選択可能。選ばなかった側はAIが指揮する。
"use strict";

const HEX_SIZE = 34;
const MARGIN = 36;
const SQRT3 = Math.sqrt(3);

const state = {
  mode: "rain",
  player: "oda", // プレイヤーが指揮する軍（もう一方はAI）
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
function sideLabel(side) { return side === "oda" ? "織田軍" : "今川軍"; }
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
  log(state.player === "oda"
    ? "あなたは織田軍を指揮する。今川義元本陣を討ち取れば勝利。"
    : "あなたは今川軍を指揮する。序盤、本陣は油断している。織田軍（AI）が本陣を狙って接近してくる。本陣を守り切れ。");
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
    state.phase === "over" ? "終了" :
    `${sideLabel(state.phase)}フェイズ（${state.phase === state.player ? "あなた" : "AI"}）`;
  document.getElementById("weather-info").textContent = isRainTurn() ? "☔ 豪雨" : "";
  const camp = state.units.find(u => u.id === "yoshimoto");
  document.getElementById("alarm-info").textContent =
    camp && camp.alive ? (state.alarmed ? "本陣：警戒" : "本陣：油断") : "";
  document.getElementById("end-phase").disabled = state.busy || state.phase !== state.player;
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
    log(`　${sideLabel(unit.side)}の${unit.name} は壊滅した。`);
  }
}
function retreat(unit, hexes, attacker) {
  for (let i = 0; i < hexes && unit.alive; i++) {
    const options = neighbors(unit.col, unit.row)
      .filter(([c, r]) => !unitAt(c, r))
      .sort((a, b) => distance(b[0], b[1], attacker.col, attacker.row) - distance(a[0], a[1], attacker.col, attacker.row));
    const safe = options.filter(([c, r]) => !inEnemyZoc(c, r, unit.side));
    const pick = (safe.length ? safe : options)[0];
    if (!pick) { applyLoss(unit, 1); log(`　${sideLabel(unit.side)}の${unit.name} は退却できず追加損害。`); continue; }
    unit.col = pick[0]; unit.row = pick[1];
  }
}
function resolveCombat(attacker, defender) {
  const aStr = attackStrength(attacker);
  const dStr = defenseStrength(defender);
  const ratio = aStr / dStr;
  const die = 1 + Math.floor(Math.random() * 6);
  const [aLoss, dLoss, dRet] = CRT[crtColumn(ratio)][die - 1];
  log(`⚔ ${sideLabel(attacker.side)}・${attacker.name}（戦力${aStr}）→ ${sideLabel(defender.side)}・${defender.name}（防御${dStr}）比${ratio.toFixed(1)}:1、ダイス${die}：攻-${aLoss === 99 ? "壊滅" : aLoss} 守-${dLoss === 99 ? "壊滅" : dLoss}${dRet ? ` 守退却${dRet}` : ""}`);
  fxCombat(defender, die); // 演出層への通知（見た目のみ。結果には影響しない）
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
    sfx("alarm");
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
    endGame("oda", state.turn <= 5 ? "織田軍の大勝利" : "織田軍の勝利",
      `今川義元は討ち取られた（ターン${state.turn}）。今川軍は総崩れとなり、歴史通りの結末となった。`);
    return true;
  }
  if (nobu && !nobu.alive) {
    endGame("imagawa", "今川軍の勝利", "織田信長本隊が壊滅した。尾張の小大名の挑戦はここで潰えた。");
    return true;
  }
  return false;
}
function judgeAtEnd() {
  const yoshi = state.units.find(u => u.id === "yoshimoto");
  if (yoshi && yoshi.alive && yoshi.str * 2 <= yoshi.maxStr) {
    endGame("oda", "織田軍の小勝利", "8ターン終了。本陣は壊滅的な打撃を受けたが、義元自身は脱出した。今川軍の尾張侵攻は頓挫した。");
  } else {
    endGame("imagawa", "今川軍の勝利", "8ターン終了。今川義元は本陣を守り切った。信長の賭けは実らなかった。");
  }
}
function endGame(winner, baseTitle, text) {
  state.phase = "over";
  const title = `${winner === state.player ? "勝利" : "敗北"} ― ${baseTitle}`;
  document.getElementById("end-title").textContent = title;
  document.getElementById("end-text").textContent = text;
  document.getElementById("end-overlay").classList.remove("hidden");
  sfx(winner === state.player ? "win" : "lose");
  log(`■ ${title}：${text}`);
  updateStatus();
  draw();
}

// ---------- AI（両軍共用ドライバ） ----------
function aiTakeTurn(side, done) {
  const actors = state.units.filter(u => u.alive && u.side === side);
  let i = 0;
  const step = () => {
    if (state.phase === "over") { done(); return; }
    if (i >= actors.length) { done(); return; }
    const u = actors[i++];
    if (u.alive) {
      const pc = u.col, pr = u.row;
      aiActivate(u);
      if (u.alive && (u.col !== pc || u.row !== pr)) sfx("step"); // AIの移動には弱い足音
    }
    draw();
    if (checkVictory()) { done(); return; }
    setTimeout(step, 350);
  };
  step();
}
function bestAttackTarget(u) {
  const foeSide = enemyOf(u);
  const foes = state.units.filter(v => v.alive && v.side === foeSide &&
    distance(u.col, u.row, v.col, v.row) === 1);
  if (!foes.length) return null;
  // 織田軍は隣接していれば義元本陣を最優先で狙う
  if (u.side === "oda") {
    const hq = foes.find(v => v.hq);
    if (hq) return hq;
  }
  foes.sort((a, b) => defenseStrength(a) - defenseStrength(b));
  return foes[0];
}
function nearestFoe(u) {
  const foeSide = enemyOf(u);
  const foes = state.units.filter(v => v.alive && v.side === foeSide);
  if (!foes.length) return null;
  foes.sort((a, b) => distance(u.col, u.row, a.col, a.row) - distance(u.col, u.row, b.col, b.row));
  return foes[0];
}
function aiActivate(u) {
  if (u.side === "imagawa") aiActivateImagawa(u);
  else aiActivateOda(u);
}

// ---------- 今川軍AI（従来ロジック） ----------
function aiActivateImagawa(u) {
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

// ---------- 織田軍AI ----------
// 方針: 全軍で今川本陣（義元）を主目標に、街道・丘陵側から前進して隣接すれば攻撃する。
// 本陣関係（義元・警固）以外との戦闘にはこだわらず、本陣への前進を優先する。
// 通説モードでは豪雨（ターン4）に合わせて攻勢を強める: ターン1〜3は本陣から
// 3ヘックスの線で待機し（油断を保ち）、本陣関係は叩かない。豪雨のターンに一気に詰める。
// 正面攻撃モードでは最初から着実に圧迫する。信長本隊は敗北条件そのものなので、
// 不利な戦闘と包囲される位置を避ける。善照寺守備隊は砦に留まる。
function aiActivateOda(u) {
  if (u.id === "zenshoji") { // 守備隊は動かない（攻撃のみ）
    const foe = bestAttackTarget(u);
    if (foe && attackStrength(u) / defenseStrength(foe) >= 0.9) resolveCombat(u, foe);
    return;
  }
  const camp = state.units.find(v => v.id === "yoshimoto");
  const campAlive = !!(camp && camp.alive);
  const rainWait = state.mode === "rain" && state.turn < 4 && campAlive;
  const foeNow = bestAttackTarget(u);
  if (!(foeNow && (foeNow.guard || foeNow.hq))) {
    // 本陣関係に隣接していない場合は、本陣方面への前進を優先する
    // （本隊が半減したら善照寺方面へ退く）
    const retreating = u.hq && u.str * 2 <= u.maxStr;
    const goal = retreating ? { col: 1, row: 1 } : (campAlive ? camp : nearestFoe(u));
    if (goal) {
      const campUnits = state.units.filter(v => v.alive && v.side === "imagawa" && (v.guard || v.hq));
      const reach = computeReachable(u);
      const scoreOf = (c, r) => {
        const dGoal = distance(c, r, goal.col, goal.row);
        const t = terrainAt(c, r);
        let s = t.cost - t.def * 2; // 街道（低コスト）を進み、防御の利く地形を好む
        if (rainWait && !retreating) {
          let dCamp = Infinity;
          for (const v of campUnits) dCamp = Math.min(dCamp, distance(c, r, v.col, v.row));
          s += dGoal * 10;
          if (dCamp < 3) s += (3 - dCamp) * 1000; // 待機線の内側には入らない
        } else {
          s += dGoal * 100;
        }
        if (dGoal > 1 && inEnemyZoc(c, r, u.side)) s += 15; // 攻撃位置以外では敵ZOCに留まらない
        // 敵に囲まれる位置を避ける（本隊は強めに）
        const adj = state.units.filter(v => v.alive && v.side === "imagawa" &&
          distance(c, r, v.col, v.row) === 1).length;
        s += adj * (u.hq ? 45 : 12);
        return s;
      };
      let best = null, bestScore = Infinity;
      const curScore = scoreOf(u.col, u.row);
      for (const k of reach.keys()) {
        const [c, r] = k.split(",").map(Number);
        const s = scoreOf(c, r);
        if (s < bestScore) { bestScore = s; best = [c, r]; }
      }
      if (best && bestScore < curScore) { u.col = best[0]; u.row = best[1]; }
    }
  }
  const foe = bestAttackTarget(u);
  if (foe) {
    if (rainWait && (foe.guard || foe.hq)) return; // 豪雨までは本陣関係を叩かない
    const ratio = attackStrength(u) / defenseStrength(foe);
    const need = (u.hq && !foe.hq) ? 1.3 : 0.9; // 本隊は雑兵戦で消耗しない
    if (ratio >= need) resolveCombat(u, foe);
  }
}

// ---------- ターン進行 ----------
// 1ターンは織田フェイズ → 今川フェイズ。今川フェイズの終了でターンが進む。
// プレイヤーの軍は入力待ち、AIの軍は startPhase が自動で動かす。
function startPhase() {
  log(`— ターン${state.turn} ${sideLabel(state.phase)}フェイズ${state.phase === state.player ? "（あなた）" : "（AI）"} —`);
  sfx("phase");
  if (state.phase === state.player) {
    state.busy = false;
    updateStatus();
    draw();
    return;
  }
  state.busy = true;
  updateStatus();
  draw();
  aiTakeTurn(state.phase, () => {
    state.busy = false;
    if (state.phase === "over") { updateStatus(); draw(); return; }
    advancePhase();
  });
}
function advancePhase() {
  state.selected = null;
  state.reachable = new Map();
  if (state.phase === "oda") {
    state.phase = "imagawa";
    checkAlarm();
    startPhase();
    return;
  }
  // 今川フェイズ終了＝ターン終了
  if (state.turn >= SCENARIO.maxTurns) { judgeAtEnd(); return; }
  state.turn++;
  for (const u of state.units) { u.moved = false; u.attacked = false; }
  state.phase = "oda";
  if (isRainTurn()) log("☔ 激しい豪雨が戦場を叩く。今川軍は混乱している。");
  checkAlarm();
  startPhase();
}
function endPhase() {
  if (state.phase !== state.player || state.busy) return;
  advancePhase();
}
function kickoff() {
  // ゲーム開始直後、先手（織田）がAIなら自動でそのフェイズを動かす
  if (state.phase !== "over" && state.phase !== state.player) startPhase();
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
      (u.side === state.player && state.phase === state.player ? `<br>移動：${u.moved ? "済" : "可"}／攻撃：${u.attacked ? "済" : "可"}` : "");
  } else if (col !== undefined) {
    const t = terrainAt(col, row);
    el.innerHTML = `地形：${t.name}（移動コスト ${t.cost}、防御ボーナス +${t.def}）`;
  }
}
function onTap(ev) {
  if (state.phase !== state.player || state.busy) return;
  const hex = hexFromEvent(ev);
  if (!hex) return;
  const [c, r] = hex;
  const clicked = unitAt(c, r);
  const sel = state.selected;
  if (sel && clicked && clicked.side !== state.player && !sel.attacked &&
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
    sfx("move");
    state.reachable = new Map();
    showUnitInfo(sel);
    draw();
    return;
  }
  if (clicked && clicked.side === state.player) {
    state.selected = clicked;
    sfx("tap");
    state.reachable = (!clicked.moved && !clicked.attacked) ? computeReachable(clicked) : new Map();
    showUnitInfo(clicked);
  } else {
    state.selected = clicked && clicked.side !== state.player ? state.selected : null;
    if (!clicked) { state.reachable = new Map(); }
    showUnitInfo(clicked, c, r);
  }
  draw();
}

// ---------- 描画・演出（プレゼンテーション層） ----------
// この節は見た目専用であり、ゲームの状態（state、ユニットの col/row/str 等）は
// 一切変更しない。ユニットの表示位置は renderPos で補間し、論理位置へ滑らかに
// 追随させる（移動・退却・AI の移動すべて同じ仕組みで滑って見える）。
// 戦闘演出は resolveCombat から fxCombat() で通知を受けるだけにとどめる。
const renderPos = new Map(); // unit.id -> {x, y} 表示用ピクセル座標
const combatFx = [];         // {x, y, die, t0} 戦闘フラッシュ＋ダイス表示
let rainDrops = null;        // 豪雨の雨粒 {x, y, len, sp}
let paperTex = null;         // 和紙テクスチャ（オフスクリーンに一度だけ生成）

// 効果音への通知（sound.js の Snd）。音響まわりの失敗がゲームに影響しないよう、
// ここで全て握りつぶす。sound.js が読み込まれていなくても安全。
function sfx(name, arg) {
  try {
    if (typeof Snd !== "undefined" && Snd && typeof Snd[name] === "function") Snd[name](arg);
  } catch (e) { /* 音響の失敗は無視する */ }
}

// 戦闘演出の登録（resolveCombat から呼ばれる。ゲーム結果には影響しない）
function fxCombat(defender, die) {
  const { x, y } = center(defender.col, defender.row);
  combatFx.push({ x, y, die, t0: performance.now() });
  sfx("combat");
}

// ヘックス座標から決定的に 0..1 を返す（装飾の配置をフレーム間で安定させる）
function hash2(c, r, k) {
  let n = (c * 374761393 + r * 668265263 + (k || 0) * 1442695041) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// 和紙テクスチャ（染みムラ＋紙の粒・繊維）をオフスクリーンに生成
function getPaper(w, h) {
  if (paperTex) return paperTex;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d");
  g.fillStyle = "#eadfc0";
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) {
    const x = hash2(i, 7, 1) * w, y = hash2(3, i, 2) * h, r = 90 + hash2(i, i, 3) * 190;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, i % 2 === 0 ? "rgba(150,120,60,0.055)" : "rgba(255,252,240,0.06)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 2400; i++) {
    const x = hash2(i, 11, 4) * w, y = hash2(13, i, 5) * h;
    g.fillStyle = i % 3 === 0 ? "rgba(120,95,45,0.05)" : "rgba(255,255,246,0.05)";
    g.fillRect(x, y, 1.4, 1.4);
  }
  g.strokeStyle = "rgba(130,105,55,0.045)";
  g.lineWidth = 1;
  for (let i = 0; i < 130; i++) {
    const x = hash2(i, 21, 6) * w, y = hash2(23, i, 7) * h, len = 6 + hash2(i, i, 8) * 16;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + (hash2(i, 5, 9) - 0.5) * 2); g.stroke();
  }
  paperTex = cv;
  return cv;
}

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
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ---------- 地形の装飾 ----------
function drawHillDecor(ctx, x, y, c, r) {
  const mounds = [[-11, 4, 16], [10, 6, 13], [-1, -7, 11]];
  for (let i = 0; i < mounds.length; i++) {
    const px = x + mounds[i][0] + (hash2(c, r, 20 + i) - 0.5) * 4;
    const py = y + mounds[i][1];
    const w = mounds[i][2], h = w * 0.58;
    ctx.beginPath();
    ctx.moveTo(px - w / 2, py + h / 2);
    ctx.quadraticCurveTo(px, py - h, px + w / 2, py + h / 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(133,95,45,0.55)";
    ctx.fill();
    // 右腹に陰影
    ctx.beginPath();
    ctx.moveTo(px, py - h * 0.82);
    ctx.quadraticCurveTo(px + w * 0.18, py - h * 0.05, px + w / 2, py + h / 2);
    ctx.lineTo(px, py + h / 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(96,64,28,0.35)";
    ctx.fill();
  }
}
function drawTree(ctx, x, y, s) {
  ctx.fillStyle = "#5d4028";
  ctx.fillRect(x - 1, y + 3 * s, 2, 3.4 * s);
  ctx.beginPath();
  ctx.moveTo(x, y - 6 * s);
  ctx.lineTo(x - 4.6 * s, y + 1.6 * s);
  ctx.lineTo(x + 4.6 * s, y + 1.6 * s);
  ctx.closePath();
  ctx.fillStyle = "#4c7038";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - 3.4 * s);
  ctx.lineTo(x - 3.8 * s, y + 3.6 * s);
  ctx.lineTo(x + 3.8 * s, y + 3.6 * s);
  ctx.closePath();
  ctx.fillStyle = "#5d8146";
  ctx.fill();
}
function drawWoodsDecor(ctx, x, y, c, r) {
  const spots = [[-13, -5], [11, -10], [1, 8], [-4, -14]];
  for (let i = 0; i < spots.length; i++) {
    const px = x + spots[i][0] + (hash2(c, r, 30 + i) - 0.5) * 5;
    const py = y + spots[i][1] + (hash2(c, r, 40 + i) - 0.5) * 4;
    drawTree(ctx, px, py, 0.9 + hash2(c, r, 50 + i) * 0.35);
  }
}
function drawRavineDecor(ctx, x, y, c, r) {
  ctx.fillStyle = "rgba(70,55,28,0.18)";
  ctx.beginPath();
  ctx.ellipse(x, y + 3, 15, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(74,58,30,0.5)";
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 7 + (hash2(c, r, 60 + i) - 0.5) * 3;
    ctx.beginPath();
    ctx.moveTo(x - 15, y + off - 3);
    ctx.quadraticCurveTo(x, y + off + 4, x + 15, y + off - 3);
    ctx.stroke();
  }
}
function drawPlainDecor(ctx, x, y, c, r) {
  ctx.strokeStyle = "rgba(110,95,40,0.35)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const px = x + (hash2(c, r, 70 + i) - 0.5) * 34;
    const py = y + (hash2(c, r, 80 + i) - 0.5) * 26;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px - 1.6, py - 4);
    ctx.moveTo(px + 1.8, py);
    ctx.lineTo(px + 3, py - 3.6);
    ctx.stroke();
  }
}
function drawFortIcon(ctx, x, y, isCastle) {
  ctx.save();
  ctx.translate(x, y - 12);
  if (isCastle) {
    // 石垣
    ctx.fillStyle = "#7d7466";
    ctx.beginPath();
    ctx.moveTo(-11, 8); ctx.lineTo(-8, 0); ctx.lineTo(8, 0); ctx.lineTo(11, 8);
    ctx.closePath(); ctx.fill();
    // 白壁
    ctx.fillStyle = "#f2ecdc";
    ctx.fillRect(-7, -7, 14, 7);
    ctx.strokeStyle = "rgba(60,50,35,0.6)";
    ctx.lineWidth = 0.8;
    ctx.strokeRect(-7, -7, 14, 7);
    // 屋根
    ctx.fillStyle = "#4c4438";
    ctx.beginPath();
    ctx.moveTo(-10, -7); ctx.lineTo(0, -13); ctx.lineTo(10, -7);
    ctx.closePath(); ctx.fill();
  } else {
    // 柵（丸太塀）
    ctx.strokeStyle = "#5d4630";
    ctx.lineWidth = 2;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 5, 6);
      ctx.lineTo(i * 5, -5 - (i === 0 ? 2 : 0));
      ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(12, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-12, 4); ctx.lineTo(12, 4); ctx.stroke();
  }
  ctx.restore();
}
// 街道：隣接する街道ヘックス同士を中心線で結び、滑らかな道として描く
function drawRoads(ctx) {
  const roadSet = new Set();
  for (let r = 0; r < SCENARIO.rows; r++)
    for (let c = 0; c < SCENARIO.cols; c++)
      if (SCENARIO.map[r][c] === "r") roadSet.add(key(c, r));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [w, col] of [[11, "rgba(168,140,84,0.9)"], [7, "#efdfae"]]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    for (const k of roadSet) {
      const [c, r] = k.split(",").map(Number);
      const a = center(c, r);
      for (const [nc, nr] of neighbors(c, r)) {
        if (!roadSet.has(key(nc, nr))) continue;
        if (key(nc, nr) < k) continue; // 各区間は一度だけ描く
        const b = center(nc, nr);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();
  }
}

// ---------- 家紋（大将格カウンター用、Canvas パスで描画） ----------
function drawKamon(ctx, x, y, side) {
  ctx.beginPath();
  ctx.arc(x, y, 8.6, 0, Math.PI * 2);
  ctx.fillStyle = "#f6efdb";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(50,38,20,0.65)";
  ctx.stroke();
  ctx.fillStyle = side === "oda" ? "#a33327" : "#2e4053";
  if (side === "oda") {
    // 織田木瓜：上下左右に膨らむ四弁を楕円で近似
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 2 * i;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * 3.1, y + Math.sin(a) * 3.1, 3.9, 2.5, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = "#f6efdb";
    ctx.fill();
  } else {
    // 足利二つ引：丸に二本の横線
    ctx.fillRect(x - 5.4, y - 3.1, 10.8, 2.1);
    ctx.fillRect(x - 5.4, y + 1.1, 10.8, 2.1);
  }
}

// ---------- ユニットカウンター ----------
const COUNTER_W = 52, COUNTER_H = 42;
function drawUnit(ctx, u, now) {
  let rp = renderPos.get(u.id);
  if (!rp) {
    const ctr = center(u.col, u.row);
    rp = { x: ctr.x, y: ctr.y };
    renderPos.set(u.id, rp);
  }
  const x = rp.x, y = rp.y;
  const done = state.phase === state.player && u.side === state.player && u.attacked;
  ctx.save();
  ctx.globalAlpha = done ? 0.55 : 1;
  // 影
  roundRectPath(ctx, x - COUNTER_W / 2 + 2, y - COUNTER_H / 2 + 3, COUNTER_W, COUNTER_H, 6);
  ctx.fillStyle = "rgba(46,32,12,0.3)";
  ctx.fill();
  // 本体（縦グラデーション）
  const grad = ctx.createLinearGradient(x, y - COUNTER_H / 2, x, y + COUNTER_H / 2);
  if (u.side === "oda") { grad.addColorStop(0, "#c0452f"); grad.addColorStop(1, "#93301f"); }
  else { grad.addColorStop(0, "#3a5878"); grad.addColorStop(1, "#26394f"); }
  roundRectPath(ctx, x - COUNTER_W / 2, y - COUNTER_H / 2, COUNTER_W, COUNTER_H, 6);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = u.hq ? 3 : 1.6;
  ctx.strokeStyle = u.hq ? "#f2c230" : "#f3ead2";
  ctx.stroke();
  // 選択中ハイライト（脈動する金の枠）
  if (state.selected === u) {
    const pad = 3.4 + Math.sin(now / 220) * 0.9;
    roundRectPath(ctx, x - COUNTER_W / 2 - pad, y - COUNTER_H / 2 - pad,
      COUNTER_W + pad * 2, COUNTER_H + pad * 2, 8);
    ctx.strokeStyle = "#ffdf3a";
    ctx.lineWidth = 2.6;
    ctx.stroke();
  }
  // 家紋（大将格のみ、左上）
  if (u.hq) drawKamon(ctx, x - COUNTER_W / 2 + 11, y - COUNTER_H / 2 + 11, u.side);
  // 指揮官名
  ctx.fillStyle = "#fff8ea";
  ctx.font = "bold 12px 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(u.short, u.hq ? x + 5 : x, y - 8);
  // 戦力・移動力
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,248,234,0.95)";
  ctx.fillText("戦" + u.str, x - COUNTER_W / 2 + 6, y + 10);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,248,234,0.75)";
  ctx.fillText("移" + u.mp, x + COUNTER_W / 2 - 6, y + 10);
  ctx.textAlign = "center";
  // ステップロス：彩度を落とし、ひび（欠け）を入れる
  if (u.str < u.maxStr) {
    const severity = 1 - u.str / u.maxStr;
    roundRectPath(ctx, x - COUNTER_W / 2, y - COUNTER_H / 2, COUNTER_W, COUNTER_H, 6);
    ctx.fillStyle = `rgba(52,48,44,${0.16 + severity * 0.3})`;
    ctx.fill();
    ctx.strokeStyle = "rgba(28,20,12,0.6)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 6, y - COUNTER_H / 2 + 1);
    ctx.lineTo(x - 2, y - 6);
    ctx.lineTo(x - 5, y + 1);
    ctx.lineTo(x, y + 8);
    ctx.stroke();
    if (severity >= 0.5) {
      ctx.beginPath();
      ctx.moveTo(x + 12, y - COUNTER_H / 2 + 1);
      ctx.lineTo(x + 9, y - 4);
      ctx.lineTo(x + 13, y + 4);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ---------- 本陣の焚火と煙 ----------
function drawCampfire(ctx, now) {
  const camp = state.units.find(u => u.id === "yoshimoto");
  if (!camp || !camp.alive) return;
  const rp = renderPos.get(camp.id);
  const ctr = rp || center(camp.col, camp.row);
  const fx0 = ctr.x + 22, fy = ctr.y - 14;
  // 炎（ちらつき）
  const fl = 1 + Math.sin(now / 90) * 0.16 + Math.sin(now / 37) * 0.07;
  ctx.beginPath();
  ctx.ellipse(fx0, fy - 3 * fl, 3.2, 5 * fl, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(232,110,30,0.85)";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(fx0, fy - 2 * fl, 1.7, 2.8 * fl, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(250,200,80,0.95)";
  ctx.fill();
  // 薪
  ctx.strokeStyle = "#5d4028";
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(fx0 - 4, fy + 2); ctx.lineTo(fx0 + 4, fy + 3); ctx.stroke();
  // 煙（立ちのぼって風に流れる）
  for (let i = 0; i < 10; i++) {
    const age = ((now / 2600) + i / 10) % 1;
    const sx = fx0 + Math.sin(age * 5 + i * 1.7) * 3.5 + age * 9;
    const sy = fy - 8 - age * 36;
    const sr = 2.6 + age * 8;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(105,100,95,${0.30 * (1 - age) * Math.min(1, age * 7)})`;
    ctx.fill();
  }
}

// ---------- 戦闘演出（フラッシュ＋ダイス） ----------
function drawCombatFx(ctx, now) {
  const pips = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  for (const f of combatFx) {
    const age = now - f.t0;
    if (age < 0 || age > 1400) continue;
    if (age < 480) {
      const p = age / 480;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 8 + p * 36, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,214,90,${0.85 * (1 - p)})`;
      ctx.lineWidth = 3.5 * (1 - p) + 0.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(f.x, f.y, 20 * (1 - p) + 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,240,180,${0.35 * (1 - p)})`;
      ctx.fill();
    }
    // ダイス（防御側ヘックスの上にポップ表示）
    const pop = age < 130 ? 0.55 + 0.45 * (age / 130) : 1;
    const fade = age > 1050 ? Math.max(0, 1 - (age - 1050) / 350) : 1;
    const s = 30 * pop;
    const dx = f.x - s / 2, dy = f.y - HEX_SIZE - s - 4;
    ctx.save();
    ctx.globalAlpha = fade;
    roundRectPath(ctx, dx, dy, s, s, 6 * pop);
    ctx.fillStyle = "#fffdf4";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#4a3a20";
    ctx.stroke();
    ctx.fillStyle = f.die === 1 ? "#b03a2e" : "#33302a";
    for (const p of pips[f.die]) {
      const gx = (p % 3 - 1) * s * 0.26, gy = (Math.floor(p / 3) - 1) * s * 0.26;
      ctx.beginPath();
      ctx.arc(f.x + gx, dy + s / 2 + gy, s * 0.085, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// ---------- 豪雨 ----------
function ensureRain(w, h) {
  if (rainDrops) return;
  rainDrops = [];
  for (let i = 0; i < 120; i++) {
    rainDrops.push({ x: Math.random() * w, y: Math.random() * h, len: 9 + Math.random() * 8, sp: 340 + Math.random() * 260 });
  }
}
function updateRain(dt, w, h) {
  ensureRain(w, h);
  const s = dt / 1000;
  for (const d of rainDrops) {
    d.y += d.sp * s;
    d.x -= d.sp * 0.18 * s;
    if (d.y > h + 12) { d.y = -12; d.x = Math.random() * (w + 40); }
    if (d.x < -12) d.x = w + 8;
  }
}
function drawRain(ctx, w, h) {
  ctx.fillStyle = "rgba(70,90,120,0.13)";
  ctx.fillRect(0, 0, w, h);
  if (!rainDrops) return;
  ctx.strokeStyle = "rgba(205,220,240,0.5)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (const d of rainDrops) {
    ctx.moveTo(d.x, d.y);
    ctx.lineTo(d.x - d.len * 0.18, d.y + d.len);
  }
  ctx.stroke();
}

// ---------- 演出の更新とアニメーションループ ----------
function updateFx(dt, now) {
  const canvas = document.getElementById("map");
  // ユニット表示位置を論理位置へ補間（遠距離の瞬間移動はスナップ）
  const f = 1 - Math.exp(-dt / 85);
  for (const u of state.units) {
    const ctr = center(u.col, u.row);
    const rp = renderPos.get(u.id);
    if (!rp) { renderPos.set(u.id, { x: ctr.x, y: ctr.y }); continue; }
    const dx = ctr.x - rp.x, dy = ctr.y - rp.y;
    if (Math.hypot(dx, dy) > HEX_SIZE * 4) { rp.x = ctr.x; rp.y = ctr.y; }
    else { rp.x += dx * f; rp.y += dy * f; }
  }
  for (let i = combatFx.length - 1; i >= 0; i--) {
    if (now - combatFx[i].t0 > 1450) combatFx.splice(i, 1);
  }
  if (isRainTurn() && state.phase !== "over") updateRain(dt, canvas.width, canvas.height);
  sfx("syncRain", isRainTurn() && state.phase !== "over"); // 雨音を雨アニメーションと連動
}
let lastFrameT = 0;
function animate(t) {
  const dt = lastFrameT ? Math.min(64, t - lastFrameT) : 16;
  lastFrameT = t;
  updateFx(dt, t);
  draw(t);
  requestAnimationFrame(animate);
}

// ---------- 描画本体 ----------
function draw(now) {
  if (now === undefined) now = performance.now();
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  // 和紙背景
  ctx.drawImage(getPaper(W, H), 0, 0);
  // 地形
  for (let r = 0; r < SCENARIO.rows; r++) {
    for (let c = 0; c < SCENARIO.cols; c++) {
      const { x, y } = center(c, r);
      const t = terrainAt(c, r);
      hexPath(ctx, x, y, HEX_SIZE - 1);
      ctx.fillStyle = t.color;
      ctx.fill();
      // ヘックスごとの微妙な濃淡
      const v = hash2(c, r, 90);
      hexPath(ctx, x, y, HEX_SIZE - 1);
      ctx.fillStyle = v > 0.5
        ? `rgba(255,252,235,${(v - 0.5) * 0.10})`
        : `rgba(105,80,35,${(0.5 - v) * 0.10})`;
      ctx.fill();
      ctx.strokeStyle = "rgba(90,74,40,0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
      const ch = SCENARIO.map[r][c];
      if (ch === "h") drawHillDecor(ctx, x, y, c, r);
      else if (ch === "w") drawWoodsDecor(ctx, x, y, c, r);
      else if (ch === "v") drawRavineDecor(ctx, x, y, c, r);
      else if (ch === "f") drawFortIcon(ctx, x, y, false);
      else if (ch === "C") drawFortIcon(ctx, x, y, true);
      else if (ch === ".") drawPlainDecor(ctx, x, y, c, r);
    }
  }
  // 街道（滑らかな線）
  drawRoads(ctx);
  // 移動可能ヘックス
  if (state.selected && state.phase === state.player) {
    for (const k of state.reachable.keys()) {
      const [c, r] = k.split(",").map(Number);
      const { x, y } = center(c, r);
      hexPath(ctx, x, y, HEX_SIZE - 2.5);
      ctx.fillStyle = "rgba(255,244,196,0.42)";
      ctx.fill();
      ctx.strokeStyle = "rgba(150,112,36,0.9)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(130,98,32,0.55)";
      ctx.fill();
    }
  }
  // 地名（明朝＋縁取りで可読性を上げる）
  ctx.font = "bold 12px 'Hiragino Mincho ProN', 'Yu Mincho', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (const lb of SCENARIO.labels) {
    const { x, y } = center(lb.col, lb.row);
    const ty = y + HEX_SIZE - 4;
    ctx.lineWidth = 3.4;
    ctx.strokeStyle = "rgba(246,239,219,0.92)";
    ctx.strokeText(lb.text, x, ty);
    ctx.fillStyle = "rgba(52,40,18,0.92)";
    ctx.fillText(lb.text, x, ty);
  }
  // 攻撃可能な敵のハイライト（選択中ユニットに隣接する敵軍）
  if (state.selected && state.phase === state.player && state.selected.side === state.player && !state.selected.attacked) {
    for (const u of state.units) {
      if (!u.alive || u.side === state.player) continue;
      if (distance(state.selected.col, state.selected.row, u.col, u.row) !== 1) continue;
      const { x, y } = center(u.col, u.row);
      ctx.beginPath();
      ctx.arc(x, y, HEX_SIZE * 0.52 + Math.sin(now / 200) * 2, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(200,40,25,0.85)";
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
  }
  // ユニット
  for (const u of state.units) {
    if (!u.alive) continue;
    drawUnit(ctx, u, now);
  }
  // 本陣の焚火・煙
  drawCampfire(ctx, now);
  // 戦闘演出
  drawCombatFx(ctx, now);
  // 地図の枠（二重罫）
  ctx.strokeStyle = "#6d5326";
  ctx.lineWidth = 3;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  ctx.lineWidth = 1;
  ctx.strokeRect(10.5, 10.5, W - 21, H - 21);
  // 豪雨（ターン4・通説モードのみ。描画だけなので操作は妨げない）
  if (isRainTurn() && state.phase !== "over") {
    drawRain(ctx, W, H);
  }
}

// ---------- 起動 ----------
// サウンドUI（ヘッダのトグルボタンと開始オーバーレイのチェックボックスを同期させる）
function refreshSoundUi() {
  let on = true;
  try { if (typeof Snd !== "undefined" && Snd) on = Snd.isOn(); } catch (e) { /* 既定はオン表示 */ }
  const btn = document.getElementById("sound-toggle");
  if (btn) btn.textContent = on ? "🔊 音オン" : "🔇 音オフ";
  const chk = document.getElementById("sound-check");
  if (chk) chk.checked = on;
}
document.getElementById("map").addEventListener("click", onTap);
document.getElementById("end-phase").addEventListener("click", endPhase);
document.getElementById("restart").addEventListener("click", () => { sfx("tap"); initGame(); showUnitInfo(null); kickoff(); });
document.getElementById("again").addEventListener("click", () => {
  sfx("tap");
  document.getElementById("end-overlay").classList.add("hidden");
  initGame();
  showUnitInfo(null);
  kickoff();
});
document.getElementById("sound-toggle").addEventListener("click", () => {
  try {
    if (typeof Snd !== "undefined" && Snd) { Snd.unlock(); Snd.toggle(); }
  } catch (e) { /* 音響の失敗は無視する */ }
  refreshSoundUi();
  sfx("tap"); // オンにしたときだけ鳴る（オフにしたときは無音）
});
document.getElementById("sound-check").addEventListener("change", (ev) => {
  try { if (typeof Snd !== "undefined" && Snd) Snd.setOn(ev.target.checked); } catch (e) { /* 音響の失敗は無視する */ }
  refreshSoundUi();
});
document.getElementById("start-game").addEventListener("click", () => {
  state.mode = document.querySelector('input[name="mode"]:checked').value;
  state.player = document.querySelector('input[name="side"]:checked').value;
  // 音のオン／オフを開始オーバーレイのチェックに合わせ、この操作で AudioContext を起こす
  try {
    if (typeof Snd !== "undefined" && Snd) {
      const chk = document.getElementById("sound-check");
      if (chk) Snd.setOn(chk.checked);
      Snd.unlock();
    }
  } catch (e) { /* 音響の失敗は無視する */ }
  sfx("tap");
  refreshSoundUi();
  document.getElementById("start-overlay").style.display = "none";
  initGame();
  kickoff();
});
refreshSoundUi();
initGame();
requestAnimationFrame(animate);

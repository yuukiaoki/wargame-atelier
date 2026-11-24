// 三十年戦争 1630–32 — 作戦級ウォーゲーム試作エンジン
// ルール概要（SPI『フリードリヒ大王』式の作戦級。数値はすべて自前設計）:
// - 軍は「リーダー＋戦力ポイント(SP)」のスタック。移動力は 1d6＋指揮能力で決まる。
// - シークエンス: フェイズ側の移動 → 非フェイズ側の強行軍（反応移動）→
//   戦闘（同一ヘックスで自動発生）。野戦を強要するには相手ターンに踏み込む。
// - 戦闘は両軍の実効戦力比による自前CRTで解決し、損害は自軍SP基準のパーセント。
// - 要塞・都市には守備隊がおり、強襲のほか包囲（ターン経過で陥落判定）も可能。
// - 補給源から離れた軍と、冬季に野外にある軍は損耗する。
// - グスタフ・アドルフが戦死すればスウェーデン側のサドンデス敗北。
"use strict";

// ---------- 乱数（シード付き。ハーネス検証用に再現可能にする） ----------
let _rngState = 1;
function seedRng(seed) {
  _rngState = (seed >>> 0) || 1;
}
function rng() {
  _rngState = (_rngState + 0x6D2B79F5) >>> 0;
  let t = _rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rollDie() { return 1 + Math.floor(rng() * 6); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- 座標ユーティリティ（odd-r オフセット座標、桶狭間と同方式） ----------
const HEX_SIZE = 27;
const MARGIN = 30;
const SQRT3 = Math.sqrt(3);
function key(col, row) { return col + "," + row; }
function inBounds(col, row) { return col >= 0 && col < SCENARIO.cols && row >= 0 && row < SCENARIO.rows; }
function terrainAt(col, row) { return TERRAIN[SCENARIO.map[row][col]]; }
function isSea(col, row) { return SCENARIO.map[row][col] === "~"; }
function isRiver(col, row) { return RIVERS.has(key(col, row)); }
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

// ---------- ゲーム状態 ----------
const STAGES = ["sweden-move", "imperial-fm", "combat-sweden", "imperial-move", "sweden-fm", "combat-imperial", "endturn"];
const STAGE_LABEL = {
  "sweden-move": "スウェーデン軍 移動",
  "imperial-fm": "皇帝軍 強行軍（反応）",
  "combat-sweden": "戦闘（スウェーデン軍の攻撃）",
  "imperial-move": "皇帝軍 移動",
  "sweden-fm": "スウェーデン軍 強行軍（反応）",
  "combat-imperial": "戦闘（皇帝軍の攻撃）",
  "endturn": "ターン終了処理"
};
const state = {
  player: "sweden", // "sweden" | "imperial" | "none"（AI対AI）
  turn: 1,
  stage: "sweden-move",
  armies: [],
  cities: [],
  losses: { sweden: 0, imperial: 0 },
  flags: { saxonJoined: false, sacked: false },
  siege: new Map(), // cityId -> {side, turns}
  pendingStorms: [], // 強襲/包囲の判断待ちの軍ID（プレイヤーの戦闘ステージ用）
  selected: null,
  reachable: new Map(),
  fmEligible: new Set(),
  over: false,
  winner: null, // "sweden" | "imperial" | "draw"
  log: [],
  _stageCount: 0
};
function otherSide(side) { return side === "sweden" ? "imperial" : "sweden"; }
function sideLabel(side) { return side === "sweden" ? "スウェーデン軍" : "皇帝・同盟軍"; }
function quarterOf(turn) { return SCENARIO.quarters[turn - 1]; }
function isWinter() { return quarterOf(state.turn).q === 4; }
function turnLabel() {
  const q = quarterOf(state.turn);
  return `${q.y}年第${q.q}四半期（ターン ${state.turn} / ${SCENARIO.maxTurns}）`;
}

// ---------- 参照ヘルパー ----------
function cityAt(col, row) { return state.cities.find(c => c.col === col && c.row === row) || null; }
function armiesAt(col, row, side) {
  return state.armies.filter(a => a.alive && a.col === col && a.row === row && (!side || a.side === side));
}
function ratingEff(army) { return army.leaderAlive ? army.rating : 0; }
function hexStrength(col, row, side) {
  const list = armiesAt(col, row, side);
  const sp = list.reduce((s, a) => s + a.sp, 0);
  const rating = list.reduce((m, a) => Math.max(m, ratingEff(a)), 0);
  return { sp, rating, armies: list };
}
function cityBonus(city) { return city ? (city.fortress ? 4 : 2) : 0; }
function defenseBonus(col, row, defSide) {
  let b = isRiver(col, row) ? 2 : 0;
  const city = cityAt(col, row);
  if (city && city.side === defSide) b += cityBonus(city);
  return b;
}

// ---------- 初期化 ----------
function startGame(playerSide, seed) {
  seedRng(seed || (Date.now() % 2147483647));
  state.player = playerSide;
  state.turn = 1;
  state.stage = "sweden-move";
  state.armies = ARMIES.filter(a => a.arrive === 0 && !a.event).map(a => ({
    ...a, maxSp: a.sp, alive: true, leaderAlive: true, moved: false, fmMoved: false, mp: 0, fmMp: 0
  }));
  state.cities = CITIES.map(c => ({ ...c, maxGarrison: c.garrison }));
  state.losses = { sweden: 0, imperial: 0 };
  state.flags = { saxonJoined: false, sacked: false };
  state.siege = new Map();
  state.pendingStorms = [];
  state.selected = null;
  state.reachable = new Map();
  state.fmEligible = new Set();
  state.over = false;
  state.winner = null;
  state.log = [];
  state._stageCount = 0;
  log("1630年6月、グスタフ・アドルフがウーゼドム島に上陸。スウェーデン軍がポメラニアに橋頭堡を築いた。");
  log("皇帝軍はティリーを北上させる。マクデブルクは皇帝軍に抵抗している。");
  log(state.player === "none" ? "（AI対AIの自動対戦）"
    : state.player === "sweden" ? "あなたはスウェーデン軍を指揮する。ドイツを南下し、皇帝軍を打ち破れ。"
    : "あなたは皇帝・カトリック同盟軍を指揮する。スウェーデン軍を北へ追い返せ。");
  beginStage();
}

// ---------- ログ・表示（DOMが無い環境では内部配列のみ） ----------
function el(id) {
  return (typeof document !== "undefined") ? document.getElementById(id) : null;
}
function log(msg) {
  state.log.push(msg);
  const box = el("log");
  if (box && typeof document !== "undefined") {
    const p = document.createElement("p");
    p.textContent = msg;
    box.appendChild(p);
    box.scrollTop = box.scrollHeight;
  }
}
function sfx(name, arg) {
  try {
    if (typeof Snd !== "undefined" && Snd && typeof Snd[name] === "function") Snd[name](arg);
  } catch (e) { /* 音響の失敗は無視する */ }
}

// ---------- 移動 ----------
// 移動コスト: 平地1、河川ヘックスは+1、海は進入不可。
// 敵野戦軍のいるヘックスには入れるが、そこで移動終了（通過不可）。
// 敵守備隊だけの都市ヘックスにも入れるが、そこで移動終了。
// 強行軍(fm)では敵野戦軍のヘックスに入れない。
function stepCost(fromC, fromR, toC, toR, army, fm) {
  if (isSea(toC, toR)) return Infinity;
  let cost = terrainAt(toC, toR).cost;
  if (isRiver(toC, toR)) cost += 1;
  return cost;
}
function isTerminalHex(col, row, army, fm) {
  const foe = armiesAt(col, row, otherSide(army.side));
  if (foe.length) return true;
  const city = cityAt(col, row);
  if (city && city.side !== army.side && city.garrison > 0) return true;
  return false;
}
function computeReachable(army, mp, fm) {
  const result = new Map();
  const dist = new Map();
  dist.set(key(army.col, army.row), 0);
  const pq = [[0, army.col, army.row]];
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [cost, c, r] = pq.shift();
    if (cost > (dist.get(key(c, r)) ?? Infinity)) continue;
    const here = !(c === army.col && r === army.row);
    if (here && isTerminalHex(c, r, army, fm)) continue; // 終端ヘックスからは先へ進まない
    for (const [nc, nr] of neighbors(c, r)) {
      if (isSea(nc, nr)) continue;
      if (fm && armiesAt(nc, nr, otherSide(army.side)).length) continue; // 強行軍では敵軍ヘックス不可
      const nCost = cost + stepCost(c, r, nc, nr, army, fm);
      if (nCost > mp) continue;
      const nk = key(nc, nr);
      if (nCost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nCost);
        if (!(nc === army.col && nr === army.row)) result.set(nk, nCost);
        pq.push([nCost, nc, nr]);
      }
    }
  }
  return result;
}
function moveArmyTo(army, c, r) {
  army.col = c; army.row = r;
}

// ---------- 戦闘 ----------
// 自前CRT。列は実効戦力比（攻撃側/防御側）、行は1d6。
// 値は [攻撃側損害%, 防御側損害%, 防御側退却ヘックス数]。損害は自軍総SP基準。
const CRT = [
  // 比率 <0.6
  [[40, 0, 0], [35, 5, 0], [30, 5, 0], [25, 10, 0], [20, 10, 0], [15, 15, 0]],
  // 0.6–0.9
  [[35, 5, 0], [30, 10, 0], [25, 10, 0], [20, 15, 1], [15, 15, 1], [10, 20, 1]],
  // 0.9–1.3
  [[30, 10, 0], [25, 15, 0], [20, 15, 1], [15, 20, 1], [15, 25, 1], [10, 30, 1]],
  // 1.3–1.8
  [[25, 15, 0], [20, 20, 1], [15, 25, 1], [10, 25, 1], [10, 30, 2], [5, 35, 2]],
  // 1.8–2.6
  [[20, 20, 1], [15, 25, 1], [10, 30, 1], [10, 35, 2], [5, 40, 2], [5, 45, 2]],
  // 2.6以上
  [[15, 25, 1], [10, 30, 1], [10, 35, 2], [5, 40, 2], [5, 50, 2], [0, 60, 2]]
];
function crtColumn(ratio) {
  if (ratio < 0.6) return 0;
  if (ratio < 0.9) return 1;
  if (ratio < 1.3) return 2;
  if (ratio < 1.8) return 3;
  if (ratio < 2.6) return 4;
  return 5;
}
// 損害をSP比例で配分する（大きい軍から端数を吸収）。実際に失ったSPを返す。
function distributeLoss(list, totalLoss) {
  const totalSp = list.reduce((s, a) => s + a.sp, 0);
  if (!list.length || totalLoss <= 0 || totalSp <= 0) return 0;
  const sorted = [...list].sort((a, b) => b.sp - a.sp);
  let assigned = 0;
  const shares = sorted.map(a => {
    const sh = Math.min(a.sp, Math.round(totalLoss * a.sp / totalSp));
    assigned += sh;
    return sh;
  });
  let rest = totalLoss - assigned;
  for (let i = 0; rest > 0 && i < sorted.length; i++) {
    const add = Math.min(sorted[i].sp - shares[i], rest);
    shares[i] += add; rest -= add;
  }
  let lost = 0;
  sorted.forEach((a, i) => {
    const before = a.sp;
    a.sp -= shares[i];
    lost += before - a.sp;
    if (a.sp <= 0) { a.sp = 0; a.alive = false; }
  });
  return lost;
}
// 軍の壊滅に伴うリーダーの運命。true を返したらゲーム終了（王の戦死）。
function leaderFateOnDestruction(army) {
  if (!army.leaderAlive) return false;
  army.leaderAlive = false;
  const die = rollDie();
  if (die <= 4) {
    log(`　${army.name} は軍と運命を共にした（戦死・捕縛）。`);
    if (army.king) { endGame("imperial", "グスタフ・アドルフ戦死", "スウェーデン王グスタフ・アドルフが戦死した。スウェーデン軍のドイツ遠征はここに潰えた。"); return true; }
  } else {
    log(`　${army.name} は脱出したが、軍は四散した。`);
    if (army.king) log("　グスタフ・アドルフは辛くも脱出した。");
  }
  return false;
}
// 戦闘後のリーダー戦死チェック（その陣営が15%以上の損害を受けた場合）。
// 最上位リーダーが対象になった場合、同ヘックスの別リーダーが「弾除け」になり得る。
function leaderCasualtyCheck(col, row, side, lossPct) {
  if (state.over || lossPct < 15) return;
  const list = armiesAt(col, row, side).filter(a => a.leaderAlive);
  if (!list.length) return;
  const senior = [...list].sort((a, b) => (b.rating - a.rating) || (b.sp - a.sp))[0];
  for (const army of list) {
    if (state.over) return;
    if (!army.leaderAlive) continue;
    let threshold = 1;
    if (army.id === "tilly" && state.turn >= 8) threshold = 2; // 1632年、レヒ川畔の致命傷
    if (rollDie() > threshold) continue;
    // 戦死対象が決まった
    if (army === senior) {
      const shields = list.filter(a => a !== army && a.leaderAlive);
      if (shields.length && rollDie() <= 4) {
        const shield = [...shields].sort((a, b) => a.rating - b.rating)[0];
        shield.leaderAlive = false;
        log(`　${shield.name} が ${army.name} の弾除けとなって戦死した。`);
        continue;
      }
    }
    army.leaderAlive = false;
    log(`　${army.name} が戦死した！`);
    if (army.king) {
      endGame("imperial", "グスタフ・アドルフ戦死", "グスタフ・アドルフが戦死した。リュッツェンの悲劇が現実のものとなった。");
      return;
    }
    log(`　${army.short}軍は後任の指揮官が引き継いだ（指揮能力低下）。`);
  }
}
// 退却（防御側）。1ヘックスごとに戦場から遠ざかる先を選ぶ。
function retreatArmies(list, fromCol, fromRow, atkSide, hexes) {
  for (const army of list) {
    if (!army.alive) continue;
    for (let i = 0; i < hexes; i++) {
      const options = neighbors(army.col, army.row)
        .filter(([c, r]) => !isSea(c, r) && !armiesAt(c, r, atkSide).length)
        .sort((a, b) => distance(b[0], b[1], fromCol, fromRow) - distance(a[0], a[1], fromCol, fromRow));
      const pick = options[0];
      if (!pick || distance(pick[0], pick[1], fromCol, fromRow) <= distance(army.col, army.row, fromCol, fromRow)) {
        // 退却できない分は追加損害
        const extra = Math.min(army.sp, Math.max(1, Math.round(army.sp * 0.1)));
        army.sp -= extra;
        state.losses[army.side] += extra;
        log(`　${army.name} は退却できず追加損害を受けた。`);
        if (army.sp <= 0) { army.sp = 0; army.alive = false; leaderFateOnDestruction(army); }
        break;
      }
      army.col = pick[0]; army.row = pick[1];
    }
  }
}
// 都市の支配確定チェック（守備隊が壊滅し、一方の野戦軍だけが残れば支配が移る）
function checkCityControl(col, row) {
  const city = cityAt(col, row);
  if (!city || city.garrison > 0) return;
  const swe = armiesAt(col, row, "sweden").length > 0;
  const imp = armiesAt(col, row, "imperial").length > 0;
  if (swe === imp) return;
  const newSide = swe ? "sweden" : "imperial";
  if (city.side === newSide) return;
  const oldSide = city.side;
  city.side = newSide;
  log(`　${city.name} は ${sideLabel(newSide)} の手に落ちた。`);
  // 占領軍は最大の軍から1SPを割いて新たな守備隊を置く（損害には数えない）
  const occupier = armiesAt(col, row, newSide).sort((a, b) => b.sp - a.sp)[0];
  if (occupier && occupier.sp >= 3) {
    occupier.sp -= 1;
    city.garrison = 1;
    log(`　${occupier.name} は ${city.name} に守備隊 1SP を残した。`);
  }
  if (city.id === "magdeburg" && newSide === "imperial" && !state.flags.sacked) {
    state.flags.sacked = true;
    log("■ マクデブルクの略奪：皇帝軍の兵士による大略奪と虐殺は全欧州に衝撃を与えた（皇帝側は最終VP-5）。");
    triggerSaxon("マクデブルクの惨事");
  }
  return oldSide;
}
// 同一ヘックスの野戦（両陣営の野戦軍がいる場合）
function resolveFieldBattle(col, row, atkSide) {
  const defSide = otherSide(atkSide);
  const atk = hexStrength(col, row, atkSide);
  const def = hexStrength(col, row, defSide);
  if (!atk.armies.length || !def.armies.length) return;
  const city = cityAt(col, row);
  const garrisonCounts = city && city.side === defSide && city.garrison > 0;
  const defSpTotal = def.sp + (garrisonCounts ? city.garrison : 0);
  const A = atk.sp + atk.rating * 2;
  const D = defSpTotal + def.rating * 2 + defenseBonus(col, row, defSide);
  const ratio = A / Math.max(1, D);
  const die = rollDie();
  const [aPct, dPct, dRet] = CRT[crtColumn(ratio)][die - 1];
  const atkLoss = Math.round(atk.sp * aPct / 100);
  const defLoss = Math.round(defSpTotal * dPct / 100);
  log(`⚔ ${turnLabel()}：${city ? city.name + "付近" : "野戦"}の戦闘 ― ${sideLabel(atkSide)} 実効${A} 対 ${sideLabel(defSide)} 実効${D}（比 ${ratio.toFixed(1)}、ダイス ${die}）`);
  sfx("combat");
  const lostA = distributeLoss(atk.armies, atkLoss);
  state.losses[atkSide] += lostA;
  // 防御側の損害は野戦軍から先に受ける
  let remaining = defLoss;
  const lostDField = distributeLoss(def.armies, remaining);
  state.losses[defSide] += lostDField;
  remaining -= lostDField;
  // 野戦軍が全滅・退却しても損害枠が残れば守備隊が受ける（同一ヘックスの戦闘として扱う）
  let garrisonLost = 0;
  if (garrisonCounts && remaining > 0) {
    garrisonLost = Math.min(city.garrison, remaining);
    city.garrison -= garrisonLost;
    state.losses[defSide] += garrisonLost;
  }
  log(`　損害：${sideLabel(atkSide)} -${lostA}SP／${sideLabel(defSide)} -${lostDField + garrisonLost}SP`);
  // 壊滅した軍のリーダー
  for (const a of [...atk.armies, ...def.armies]) {
    if (!a.alive && a.sp <= 0 && a._fateChecked !== state._stageCount) {
      a._fateChecked = state._stageCount;
      if (leaderFateOnDestruction(a)) return;
    }
  }
  if (state.over) return;
  // リーダー戦死チェック
  leaderCasualtyCheck(col, row, atkSide, atk.sp > 0 ? lostA / atk.sp * 100 : 0);
  leaderCasualtyCheck(col, row, defSide, defSpTotal > 0 ? (lostDField + garrisonLost) / defSpTotal * 100 : 0);
  if (state.over) return;
  // 退却
  if (dRet > 0) {
    const survivors = def.armies.filter(a => a.alive);
    if (survivors.length) {
      log(`　${sideLabel(defSide)} は ${dRet} ヘックス退却した。`);
      retreatArmies(survivors, col, row, atkSide, dRet);
    }
  }
  checkCityControl(col, row);
}
// 強襲（守備隊だけの都市ヘックスへの攻撃）
function resolveStorm(col, row, atkSide) {
  const city = cityAt(col, row);
  if (!city || city.garrison <= 0 || city.side === atkSide) return;
  const atk = hexStrength(col, row, atkSide);
  if (!atk.armies.length) return;
  const D = city.garrison + defenseBonus(col, row, city.side);
  const A = atk.sp + atk.rating * 2;
  const ratio = A / Math.max(1, D);
  const die = rollDie();
  const [aPct, dPct] = CRT[crtColumn(ratio)][die - 1];
  const atkLoss = Math.round(atk.sp * aPct / 100);
  const defLoss = Math.round(city.garrison * dPct / 100);
  log(`⚔ ${city.name} への強襲 ― 実効${A} 対 守備隊実効${D}（比 ${ratio.toFixed(1)}、ダイス ${die}）`);
  sfx("combat");
  const lostA = distributeLoss(atk.armies, atkLoss);
  state.losses[atkSide] += lostA;
  const garrisonBefore = city.garrison;
  city.garrison = Math.max(0, city.garrison - defLoss);
  state.losses[city.side] += garrisonBefore - city.garrison;
  log(`　損害：攻撃側 -${lostA}SP／守備隊 -${garrisonBefore - city.garrison}SP`);
  for (const a of atk.armies) {
    if (!a.alive && a.sp <= 0 && a._fateChecked !== state._stageCount) {
      a._fateChecked = state._stageCount;
      if (leaderFateOnDestruction(a)) return;
    }
  }
  if (state.over) return;
  leaderCasualtyCheck(col, row, atkSide, atk.sp > 0 ? lostA / atk.sp * 100 : 0);
  if (city.garrison <= 0) {
    log(`　${city.name} の守備隊は壊滅した。`);
    checkCityControl(col, row);
  } else {
    log(`　${city.name} の守備隊は持ちこたえた（残 ${city.garrison}SP）。包囲が続く。`);
  }
}

// ---------- イベント・増援 ----------
function placeArmy(def) {
  const entry = def.entry || [[def.col, def.row]];
  let spot = entry.find(([c, r]) => !armiesAt(c, r, otherSide(def.side)).length) || entry[0];
  const army = {
    ...def, maxSp: def.sp, alive: true, leaderAlive: true,
    moved: false, fmMoved: false, mp: 0, fmMp: 0, col: spot[0], row: spot[1]
  };
  state.armies.push(army);
  return army;
}
function triggerSaxon(reason) {
  if (state.flags.saxonJoined) return;
  state.flags.saxonJoined = true;
  log(`■ ザクセン参戦（${reason}）：選帝侯ヨハン・ゲオルク1世がスウェーデンと同盟した。`);
  sfx("alarm");
  // ドレスデン：皇帝側の野戦軍がいなければザクセン側に帰属する（守備隊はザクセン軍）
  const dresden = state.cities.find(c => c.id === "dresden");
  if (dresden && !armiesAt(dresden.col, dresden.row, "imperial").length) {
    dresden.side = "sweden";
    log("　ドレスデンはザクセン軍の支配に戻った。");
  }
  const def = ARMIES.find(a => a.id === "arnim");
  const army = placeArmy(def);
  log(`　アルニム率いるザクセン軍 ${army.sp}SP が ${cityAt(army.col, army.row)?.name || "戦域"} に参戦した。`);
}
function placeReinforcements(turn) {
  for (const def of ARMIES) {
    if (def.arrive === turn && !def.event) {
      const army = placeArmy(def);
      const placeName = cityAt(army.col, army.row)?.name || "戦域";
      if (def.id === "wallenstein") {
        log("■ ヴァレンシュタイン復帰：解任されていたヴァレンシュタインが皇帝の懇願で再び軍を率いる。ボヘミアで編成した大軍が北上してきた。");
      } else if (def.id === "gallas") {
        log("■ ガラスがイタリア戦線から帰還し、レーゲンスブルク方面に着任した。");
      } else if (def.id === "bernhard") {
        log("■ ザクセン＝ヴァイマル公ベルンハルトがスウェーデン軍に合流した。");
      }
      log(`　増援：${army.name} ${army.sp}SP が ${placeName} に登場。`);
      sfx("alarm");
    }
  }
  if (turn === 5 && !state.flags.saxonJoined) {
    triggerSaxon("ブライテンフェルト前夜の同盟");
  }
}

// ---------- 包囲（ターン終了時に解決） ----------
function processSieges() {
  for (const city of state.cities) {
    const keyId = city.id;
    if (city.garrison <= 0) { state.siege.delete(keyId); continue; }
    const defenders = armiesAt(city.col, city.row, city.side);
    const besiegers = armiesAt(city.col, city.row, otherSide(city.side));
    if (!besiegers.length || defenders.length) { state.siege.delete(keyId); continue; }
    const side = besiegers[0].side;
    const cur = state.siege.get(keyId);
    const turns = (cur && cur.side === side) ? cur.turns + 1 : 1;
    state.siege.set(keyId, { side, turns });
    const besiegerSp = besiegers.reduce((s, a) => s + a.sp, 0);
    const bonus = besiegerSp >= city.garrison * 3 ? 1 : 0;
    const die = rollDie();
    const total = die + turns + bonus;
    log(`包囲：${city.name}（${turns}ターン目）― 陥落判定 ダイス${die}＋経過${turns}＋兵力${bonus}＝${total}（7以上で陥落）`);
    if (total >= 7) {
      state.losses[city.side] += city.garrison;
      log(`　${city.name} は陥落した（守備隊 ${city.garrison}SP 壊滅）。`);
      city.garrison = 0;
      state.siege.delete(keyId);
      checkCityControl(city.col, city.row);
    }
  }
}

// ---------- 補給・損耗 ----------
const SUPPLY_RANGE = 6;
const BOHEMIA_SOURCES = [[19, 13], [20, 13], [21, 13], [21, 12]];
function supplySources(side) {
  // 補給源は支配下の都市すべて（都市が兵站拠点になる）。皇帝側はボヘミア方面も。
  const src = [];
  for (const city of state.cities) {
    if (city.side === side) src.push([city.col, city.row]);
  }
  if (side === "imperial") src.push(...BOHEMIA_SOURCES);
  return src;
}
function isSupplied(army) {
  const city = cityAt(army.col, army.row);
  if (city && city.side === army.side) return true;
  const src = supplySources(army.side);
  return src.some(([c, r]) => distance(army.col, army.row, c, r) <= SUPPLY_RANGE);
}
function applyAttrition(army, lostSp, reason) {
  if (lostSp <= 0 || !army.alive) return;
  army.sp -= lostSp;
  state.losses[army.side] += lostSp;
  log(`　${army.name} は${reason}で ${lostSp}SP を失った。`);
  if (army.sp <= 0) {
    army.sp = 0; army.alive = false;
    log(`　${army.name} の軍は四散した。`);
    army.leaderAlive = false;
  }
}
function processSupplyAndWinter() {
  const winter = isWinter();
  for (const army of state.armies) {
    if (!army.alive) continue;
    if (!isSupplied(army) && rollDie() <= 2) {
      applyAttrition(army, 1, "補給途絶");
      if (state.over) return;
    }
    if (!army.alive) continue;
    if (winter) {
      const city = cityAt(army.col, army.row);
      const sheltered = city && city.side === army.side;
      if (!sheltered && rollDie() <= 1) {
        applyAttrition(army, 1, "冬季損耗");
        if (state.over) return;
      }
    }
  }
}

// ---------- 勝敗 ----------
function vpScore(side) {
  let vp = state.cities.filter(c => c.side === side).reduce((s, c) => s + c.vp, 0);
  vp -= state.losses[side];
  if (side === "imperial" && state.flags.sacked) vp -= 5;
  return vp;
}
function checkAnnihilation() {
  if (state.over) return true;
  const swe = state.armies.some(a => a.alive && a.side === "sweden");
  const imp = state.armies.some(a => a.alive && a.side === "imperial");
  if (!swe) { endGame("imperial", "スウェーデン軍壊滅", "スウェーデン軍の野戦軍は壊滅した。ドイツ遠征は終わった。"); return true; }
  if (!imp) { endGame("sweden", "皇帝軍壊滅", "皇帝・同盟軍の野戦軍は壊滅した。スウェーデンの勝利は決定的となった。"); return true; }
  return false;
}
function judgeAtEnd() {
  const sv = vpScore("sweden"), iv = vpScore("imperial");
  log(`最終VP：スウェーデン軍 ${sv}／皇帝・同盟軍 ${iv}（支配都市VP − 累積損害${state.flags.sacked ? " − マクデブルク略奪5" : ""}）`);
  if (sv > iv) endGame("sweden", "スウェーデン軍の勝利", `1632年末、VP ${sv} 対 ${iv}。スウェーデン軍はドイツに確固たる地歩を築いた。`);
  else if (iv > sv) endGame("imperial", "皇帝・同盟軍の勝利", `1632年末、VP ${iv} 対 ${sv}。皇帝軍はスウェーデンの南下を食い止めた。`);
  else endGame("draw", "引き分け", `1632年末、VP ${sv} 対 ${iv} で互角。戦争はなお続く。`);
}
function endGame(winner, baseTitle, text) {
  if (state.over) return;
  state.over = true;
  state.winner = winner;
  state.stage = "over";
  log(`■ ${baseTitle}：${text}`);
  const title = winner === "draw" ? `引き分け ― ${baseTitle}`
    : `${winner === state.player ? "勝利" : "敗北"} ― ${baseTitle}`;
  const titleEl = el("end-title"), textEl = el("end-text"), overlay = el("end-overlay");
  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;
  if (overlay) overlay.classList.remove("hidden");
  if (state.player !== "none") sfx(winner === state.player ? "win" : "lose");
  updateStatus();
  draw();
}

// ---------- ターン終了処理 ----------
function endTurn() {
  // 守備隊が壊滅した都市は、そのヘックスを単独占拠している側の支配に移る
  for (const city of state.cities) checkCityControl(city.col, city.row);
  if (state.over) return;
  processSieges();
  if (state.over) return;
  processSupplyAndWinter();
  if (state.over) return;
  if (checkAnnihilation()) return;
  if (state.turn >= SCENARIO.maxTurns) { judgeAtEnd(); return; }
  state.turn++;
  log(`===== ${turnLabel()} =====`);
  if (isWinter()) log("❄ 冬季ターン：移動力-2、野外の軍は冬季損耗の恐れ。");
  placeReinforcements(state.turn);
  state.stage = "sweden-move";
  beginStage();
}

// ---------- フェイズ進行 ----------
function stageSide(stage) {
  if (stage === "sweden-move" || stage === "combat-sweden") return "sweden";
  if (stage === "imperial-move" || stage === "combat-imperial") return "imperial";
  if (stage === "imperial-fm") return "imperial";
  if (stage === "sweden-fm") return "sweden";
  return null;
}
function isPlayerStage() {
  const side = stageSide(state.stage);
  return side !== null && side === state.player;
}
function beginStage() {
  if (state.over) { updateStatus(); draw(); return; }
  if (++state._stageCount > 600) throw new Error("stage loop overflow");
  const stage = state.stage;
  const side = stageSide(stage);
  state.selected = null;
  state.reachable = new Map();
  if (stage.endsWith("-move")) {
    // 移動ステージ：その陣営の全軍に移動力を振る
    for (const army of state.armies) {
      if (!army.alive || army.side !== side) continue;
      army.mp = clamp(rollDie() + ratingEff(army) - (isWinter() ? 2 : 0), 1, 9);
      army.moved = false;
    }
    log(`― ${turnLabel()}：${STAGE_LABEL[stage]} ―`);
    sfx("phase");
    if (side === state.player) { updateStatus(); draw(); return; }
    for (const army of state.armies.filter(a => a.alive && a.side === side)) {
      aiMoveArmy(army);
      if (state.over) break;
    }
    if (!state.over) advanceStage();
    return;
  }
  if (stage.endsWith("-fm")) {
    // 強行軍ステージ：敵野戦軍に接した軍だけが反応移動できる
    state.fmEligible = new Set();
    for (const army of state.armies) {
      if (!army.alive || army.side !== side) continue;
      if (!inContact(army)) continue;
      army.fmMp = clamp(rollDie() - (isWinter() ? 2 : 0), 1, 6);
      army.fmMoved = false;
      state.fmEligible.add(army.id);
    }
    if (!state.fmEligible.size) { advanceStage(); return; }
    log(`― ${STAGE_LABEL[stage]}（対象 ${state.fmEligible.size} 軍）―`);
    if (side === state.player) { updateStatus(); draw(); return; }
    for (const id of [...state.fmEligible]) {
      const army = state.armies.find(a => a.id === id);
      if (army && army.alive) aiForcedMarch(army);
    }
    advanceStage();
    return;
  }
  if (stage.startsWith("combat-")) {
    // 戦闘ステージ：野戦は自動解決。守備隊だけのヘックスは強襲/包囲の判断。
    log(`― ${STAGE_LABEL[stage]} ―`);
    const hexes = new Set();
    for (const army of state.armies) {
      if (!army.alive || army.side !== side) continue;
      if (armiesAt(army.col, army.row, otherSide(side)).length) hexes.add(key(army.col, army.row));
    }
    for (const k of hexes) {
      const [c, r] = k.split(",").map(Number);
      resolveFieldBattle(c, r, side);
      if (state.over) { updateStatus(); draw(); return; }
    }
    // 強襲/包囲の判断待ち
    state.pendingStorms = [];
    for (const army of state.armies) {
      if (!army.alive || army.side !== side) continue;
      const city = cityAt(army.col, army.row);
      if (city && city.side !== side && city.garrison > 0 &&
          !armiesAt(army.col, army.row, otherSide(side)).length) {
        if (!state.pendingStorms.includes(army.id)) state.pendingStorms.push(army.id);
      }
    }
    if (!state.pendingStorms.length) { advanceStage(); return; }
    if (side === state.player) { updateStatus(); draw(); return; }
    for (const id of [...state.pendingStorms]) {
      const army = state.armies.find(a => a.id === id);
      if (army && army.alive) aiStormDecision(army);
      if (state.over) break;
    }
    state.pendingStorms = [];
    if (!state.over) advanceStage();
    return;
  }
  if (stage === "endturn") {
    endTurn();
    return;
  }
}
function advanceStage() {
  if (state.over) { updateStatus(); draw(); return; }
  state.selected = null;
  state.reachable = new Map();
  const idx = STAGES.indexOf(state.stage);
  state.stage = STAGES[(idx + 1) % STAGES.length];
  beginStage();
}
function inContact(army) {
  const foe = otherSide(army.side);
  if (armiesAt(army.col, army.row, foe).length) return true;
  return neighbors(army.col, army.row).some(([c, r]) => armiesAt(c, r, foe).length > 0);
}

// ---------- AI ----------
// 目的ヘックスの候補を作る（敵都市、弱い敵軍、脅かされた自軍要塞）
function aiObjectives(army) {
  const objs = [];
  const foe = otherSide(army.side);
  for (const city of state.cities) {
    if (city.side === army.side) {
      // 自軍都市の防衛：敵軍が3ヘックス以内にいれば救援対象
      const threatened = state.armies.some(a => a.alive && a.side === foe &&
        distance(a.col, a.row, city.col, city.row) <= 3);
      if (threatened && city.vp >= 3) objs.push({ c: city.col, r: city.row, value: 25 });
    } else {
      objs.push({ c: city.col, r: city.row, value: city.vp * 12 - city.garrison * 2 });
    }
  }
  // 弱い敵軍は狩り対象
  for (const foeArmy of state.armies) {
    if (!foeArmy.alive || foeArmy.side !== foe) continue;
    const foeTotal = hexStrength(foeArmy.col, foeArmy.row, foe).sp;
    if (foeTotal < army.sp * 0.8) objs.push({ c: foeArmy.col, r: foeArmy.row, value: 15 });
  }
  // ティリーとパッペンハイムはマクデブルクを最優先（史実の包囲）
  const mag = state.cities.find(c => c.id === "magdeburg");
  if ((army.id === "tilly" || army.id === "pappenheim") && mag && mag.side !== "imperial") {
    objs.push({ c: mag.col, r: mag.row, value: 60 });
  }
  // ヴァレンシュタインはグスタフ・アドルフを狙う
  if (army.id === "wallenstein") {
    const king = state.armies.find(a => a.id === "gustavus" && a.alive);
    if (king) objs.push({ c: king.col, r: king.row, value: 30 });
  }
  return objs;
}
function aiDestinationScore(army, c, r, objs) {
  let best = Infinity;
  for (const o of objs) best = Math.min(best, distance(c, r, o.c, o.r) * 6 - o.value);
  const foe = otherSide(army.side);
  const foeHere = hexStrength(c, r, foe);
  if (foeHere.armies.length) {
    const friendsHere = hexStrength(c, r, army.side).sp + (army.col === c && army.row === r ? 0 : army.sp);
    if (foeHere.sp > friendsHere * 1.25) best += 10000; // 無謀な戦闘は避ける
    else best += 5;
  } else {
    const city = cityAt(c, r);
    if (city && city.side !== army.side && city.garrison > 0) {
      // 強襲・包囲は同ヘックスの友軍合計で解決されるため、進入可否も合計で判断する
      const groupSp = army.sp + (army.col === c && army.row === r ? 0 : hexStrength(c, r, army.side).sp);
      if (groupSp < city.garrison) best += 10000;
      else best += 2; // 目標ヘックスへの進入を妨げない程度の小ペナルティ
    }
  }
  // 補給圏外は避ける
  const probe = { ...army, col: c, row: r };
  if (!isSupplied(probe)) best += 12;
  return best;
}
function aiMoveArmy(army) {
  if (!army.alive || army.moved) return;
  const foe = otherSide(army.side);
  // 敵と同ヘックスにいて互角以上なら留まる（戦闘ステージで決着）
  const foeHere = hexStrength(army.col, army.row, foe);
  if (foeHere.armies.length) {
    const friendsHere = hexStrength(army.col, army.row, army.side).sp;
    if (friendsHere >= foeHere.sp) { army.moved = true; return; }
  }
  const objs = aiObjectives(army);
  const reach = computeReachable(army, army.mp, false);
  let bestHex = null, bestScore = aiDestinationScore(army, army.col, army.row, objs);
  for (const k of reach.keys()) {
    const [c, r] = k.split(",").map(Number);
    const s = aiDestinationScore(army, c, r, objs);
    if (s < bestScore) { bestScore = s; bestHex = [c, r]; }
  }
  if (bestHex) { moveArmyTo(army, bestHex[0], bestHex[1]); sfx("step"); }
  army.moved = true;
}
function aiForcedMarch(army) {
  if (!army.alive || army.fmMoved) return;
  const foe = otherSide(army.side);
  const foeHere = hexStrength(army.col, army.row, foe);
  const friendsHere = hexStrength(army.col, army.row, army.side).sp;
  const adjacentFoeMax = Math.max(0, ...neighbors(army.col, army.row)
    .map(([c, r]) => hexStrength(c, r, foe).sp));
  const mustFlee = foeHere.armies.length && foeHere.sp > friendsHere * 0.9;
  const shouldFlee = !foeHere.armies.length && adjacentFoeMax > army.sp * 1.3;
  if (!mustFlee && !shouldFlee) { army.fmMoved = true; return; }
  const reach = computeReachable(army, army.fmMp, true);
  const safety = (c, r) => {
    let minD = Infinity;
    for (const f of state.armies) {
      if (f.alive && f.side === foe) minD = Math.min(minD, distance(c, r, f.col, f.row));
    }
    let cityD = Infinity;
    for (const city of state.cities) {
      if (city.side === army.side) cityD = Math.min(cityD, distance(c, r, city.col, city.row));
    }
    return (minD === Infinity ? 20 : minD) * 10 - (cityD === Infinity ? 0 : cityD) * 3;
  };
  let bestHex = null, bestScore = safety(army.col, army.row);
  for (const k of reach.keys()) {
    const [c, r] = k.split(",").map(Number);
    const s = safety(c, r);
    if (s > bestScore) { bestScore = s; bestHex = [c, r]; }
  }
  if (bestHex) {
    moveArmyTo(army, bestHex[0], bestHex[1]);
    applyFmAttrition(army);
  }
  army.fmMoved = true;
}
function applyFmAttrition(army) {
  const threshold = isWinter() ? 2 : 1;
  if (rollDie() <= threshold) {
    log(`　${army.name} は強行軍で損耗した。`);
    applyAttrition(army, 1, "強行軍");
  }
}
function aiStormDecision(army) {
  const city = cityAt(army.col, army.row);
  if (!city) return;
  // 強襲は同ヘックスの友軍全軍で解決されるため、判断も合計SPで行う
  const groupSp = hexStrength(army.col, army.row, army.side).sp;
  if (groupSp >= city.garrison * 2.5 || (state.turn >= 9 && groupSp >= city.garrison * 1.5)) {
    resolveStorm(army.col, army.row, army.side);
  }
  // それ以外は包囲継続（ターン終了時の包囲処理に委ねる）
}

// ---------- プレイヤー操作（UIとハーネスで共用） ----------
function playerSelect(army) {
  if (state.over) return false;
  if (state.stage.endsWith("-move") && isPlayerStage() &&
      army.side === state.player && !army.moved) {
    state.selected = army;
    state.reachable = computeReachable(army, army.mp, false);
    sfx("tap");
    return true;
  }
  if (state.stage.endsWith("-fm") && isPlayerStage() &&
      army.side === state.player && state.fmEligible.has(army.id) && !army.fmMoved) {
    state.selected = army;
    state.reachable = computeReachable(army, army.fmMp, true);
    sfx("tap");
    return true;
  }
  return false;
}
function playerTapHex(c, r) {
  const sel = state.selected;
  if (!sel || !state.reachable.has(key(c, r))) return false;
  moveArmyTo(sel, c, r);
  sfx("move");
  if (state.stage.endsWith("-fm")) {
    sel.fmMoved = true;
    applyFmAttrition(sel);
  } else {
    sel.moved = true;
  }
  state.selected = null;
  state.reachable = new Map();
  updateStatus();
  draw();
  return true;
}
function playerEndStage() {
  if (state.over || !isPlayerStage()) return false;
  if (state.stage.startsWith("combat-") && state.pendingStorms.length) return false;
  advanceStage();
  return true;
}
function playerStormChoice(storm) {
  if (!state.pendingStorms.length || !isPlayerStage()) return false;
  const id = state.pendingStorms[0];
  const army = state.armies.find(a => a.id === id);
  state.pendingStorms.shift();
  if (army && army.alive && storm) resolveStorm(army.col, army.row, army.side);
  if (!state.pendingStorms.length && !state.over) advanceStage();
  else { updateStatus(); draw(); }
  return true;
}

// ---------- 表示 ----------
function updateStatus() {
  const turnEl = el("turn-info"), phaseEl = el("phase-info"),
    vpEl = el("vp-info"), eventEl = el("event-info"), endBtn = el("end-phase");
  if (!turnEl) return;
  turnEl.textContent = state.over ? "終了" : turnLabel();
  phaseEl.textContent = state.over ? "ゲーム終了"
    : `${STAGE_LABEL[state.stage]}${isPlayerStage() ? "（あなた）" : state.player === "none" ? "（AI）" : "（AI）"}`;
  vpEl.textContent = `VP スウェーデン ${vpScore("sweden")} ／ 皇帝 ${vpScore("imperial")}`;
  const notes = [];
  if (isWinter() && !state.over) notes.push("❄ 冬季");
  if (state.flags.saxonJoined) notes.push("ザクセン参戦済");
  if (state.flags.sacked) notes.push("マクデブルク略奪");
  eventEl.textContent = notes.join("／");
  if (endBtn) {
    const stage = state.stage;
    endBtn.disabled = state.over || !isPlayerStage() ||
      (stage.startsWith("combat-") && state.pendingStorms.length > 0);
    endBtn.textContent = stage.endsWith("-fm") ? "強行軍を終える"
      : stage.startsWith("combat-") ? "戦闘を終える" : "移動を終える";
  }
  const stormBox = el("storm-box");
  if (stormBox) {
    if (state.pendingStorms.length && isPlayerStage() && !state.over) {
      const army = state.armies.find(a => a.id === state.pendingStorms[0]);
      const city = army ? cityAt(army.col, army.row) : null;
      stormBox.style.display = "block";
      const info = el("storm-info");
      if (info && army && city) {
        info.textContent = `${army.name}（${army.sp}SP）が ${city.name}（守備隊 ${city.garrison}SP、${city.fortress ? "要塞" : "都市"}）に迫っている。強襲するか、包囲を続けるか。`;
      }
    } else {
      stormBox.style.display = "none";
    }
  }
}
function showArmyInfo(army, col, row) {
  const box = el("unit-detail");
  if (!box) return;
  if (army) {
    const city = cityAt(army.col, army.row);
    const supplied = isSupplied(army);
    box.innerHTML = `<strong>${army.name}</strong>（${sideLabel(army.side)}）<br>` +
      `戦力 ${army.sp} SP／指揮能力 ${army.leaderAlive ? army.rating : "0（指揮官不在）"}<br>` +
      `位置：${city ? city.name : "野外"}${isRiver(army.col, army.row) ? "（河川ヘックス）" : ""}／補給：${supplied ? "良好" : "途絶の恐れ"}<br>` +
      (army.side === state.player && state.stage.endsWith("-move") && isPlayerStage()
        ? `移動力 ${army.moved ? "移動済" : army.mp}` : "") +
      (army.side === state.player && state.stage.endsWith("-fm") && isPlayerStage() && state.fmEligible.has(army.id)
        ? `強行軍移動力 ${army.fmMoved ? "移動済" : army.fmMp}` : "");
  } else if (col !== undefined) {
    const city = cityAt(col, row);
    if (city) {
      box.innerHTML = `<strong>${city.name}</strong>（${sideLabel(city.side)}支配、VP ${city.vp}）<br>` +
        `${city.fortress ? "要塞" : "都市"}${city.port ? "・港湾" : ""}／守備隊 ${city.garrison} SP` +
        `${isRiver(col, row) ? "／河川ヘックス" : ""}` +
        `${state.siege.has(city.id) ? `<br>包囲中（${state.siege.get(city.id).turns}ターン経過）` : ""}`;
    } else {
      box.innerHTML = `地形：${isSea(col, row) ? "海（進入不可）" : isRiver(col, row) ? "河川（移動コスト+1、防御+2）" : "平地"}`;
    }
  }
}

// ---------- 描画（プレゼンテーション層。状態は変更しない） ----------
const renderPos = new Map();
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
function draw() {
  const canvas = el("map");
  if (!canvas || typeof canvas.getContext !== "function") return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#e9e2c8";
  ctx.fillRect(0, 0, W, H);
  // ヘックス
  for (let r = 0; r < SCENARIO.rows; r++) {
    for (let c = 0; c < SCENARIO.cols; c++) {
      const { x, y } = center(c, r);
      hexPath(ctx, x, y, HEX_SIZE - 0.5);
      ctx.fillStyle = terrainAt(c, r).color;
      ctx.fill();
      ctx.strokeStyle = "rgba(110, 95, 55, 0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
      if (isRiver(c, r) && !isSea(c, r)) {
        ctx.strokeStyle = "rgba(70, 120, 180, 0.75)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - HEX_SIZE * 0.55, y + 3);
        ctx.bezierCurveTo(x - HEX_SIZE * 0.2, y - 4, x + HEX_SIZE * 0.2, y + 5, x + HEX_SIZE * 0.55, y - 3);
        ctx.stroke();
      }
    }
  }
  // 到達可能ヘックス
  if (state.selected) {
    ctx.fillStyle = "rgba(255, 246, 200, 0.55)";
    for (const k of state.reachable.keys()) {
      const [c, r] = k.split(",").map(Number);
      const { x, y } = center(c, r);
      hexPath(ctx, x, y, HEX_SIZE - 1.5);
      ctx.fill();
    }
  }
  // 地方名ラベル
  ctx.fillStyle = "rgba(90, 78, 48, 0.55)";
  ctx.font = "italic 13px 'Hiragino Mincho ProN', serif";
  ctx.textAlign = "center";
  for (const lab of SCENARIO.labels) {
    const { x, y } = center(lab.col, lab.row);
    ctx.fillText(lab.text, x, y - 8);
  }
  // 都市
  for (const city of state.cities) {
    const { x, y } = center(city.col, city.row);
    const ownerColor = city.side === "sweden" ? "#1d4e89" : "#4a4238";
    if (city.fortress) {
      ctx.fillStyle = "#6d5b39";
      ctx.fillRect(x - 9, y - 12, 18, 13);
      ctx.fillRect(x - 9, y - 16, 4, 5);
      ctx.fillRect(x - 2, y - 16, 4, 5);
      ctx.fillRect(x + 5, y - 16, 4, 5);
      ctx.strokeStyle = ownerColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 11, y - 18, 22, 20);
    } else {
      ctx.fillStyle = "#8a744c";
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 4);
      ctx.lineTo(x, y - 14);
      ctx.lineTo(x + 8, y - 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - 7, y - 4, 14, 8);
    }
    if (city.port) {
      ctx.fillStyle = "rgba(40, 90, 150, 0.9)";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("港", x + 9, y - 6);
    }
    ctx.font = "bold 10px 'Hiragino Kaku Gothic ProN', sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 250, 230, 0.85)";
    const label = `${city.name} ${city.garrison > 0 ? "守" + city.garrison : ""}`;
    ctx.strokeText(label, x, y + 15);
    ctx.fillStyle = "#33270f";
    ctx.fillText(label, x, y + 15);
    if (state.siege.has(city.id)) {
      ctx.strokeStyle = "rgba(200, 90, 30, 0.9)";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y - 5, 17, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // 軍カウンター
  const byHex = new Map();
  for (const army of state.armies) {
    if (!army.alive) continue;
    const k = key(army.col, army.row);
    if (!byHex.has(k)) byHex.set(k, []);
    byHex.get(k).push(army);
  }
  for (const [k, list] of byHex) {
    list.forEach((army, idx) => {
      const { x, y } = center(army.col, army.row);
      if (!renderPos.has(army.id)) renderPos.set(army.id, { x, y });
      const rp = renderPos.get(army.id);
      rp.x += (x - rp.x) * 0.25;
      rp.y += (y - rp.y) * 0.25;
      const ox = rp.x + (idx % 2) * 10 - 5, oy = rp.y + 8 + Math.floor(idx / 2) * 6;
      const f = FACTIONS[army.faction];
      const w = 52, h = 34;
      ctx.save();
      ctx.shadowColor = "rgba(40,30,10,0.4)";
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 1;
      roundRectPath(ctx, ox - w / 2, oy - h / 2, w, h, 4);
      ctx.fillStyle = f.body;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = state.selected === army ? "#ffd94d" : "rgba(0,0,0,0.55)";
      ctx.lineWidth = state.selected === army ? 3 : 1;
      ctx.stroke();
      ctx.fillStyle = f.band;
      ctx.fillRect(ox - w / 2 + 2, oy - h / 2 + 2, w - 4, 4);
      ctx.fillStyle = f.text;
      ctx.textAlign = "center";
      ctx.font = "bold 9px 'Hiragino Kaku Gothic ProN', sans-serif";
      const nm = army.short.length > 7 ? army.short.slice(0, 7) : army.short;
      ctx.fillText(army.leaderAlive ? nm : nm + "(代)", ox, oy + 3);
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(`SP${army.sp} ☆${ratingEff(army)}`, ox, oy + 15);
      ctx.restore();
    });
  }
  // 接敵ヘックスの赤リング
  ctx.strokeStyle = "rgba(190, 50, 35, 0.65)";
  ctx.lineWidth = 2;
  for (let r = 0; r < SCENARIO.rows; r++) {
    for (let c = 0; c < SCENARIO.cols; c++) {
      if (armiesAt(c, r, "sweden").length && armiesAt(c, r, "imperial").length) {
        const { x, y } = center(c, r);
        hexPath(ctx, x, y, HEX_SIZE - 2);
        ctx.stroke();
      }
    }
  }
  // 外枠
  ctx.strokeStyle = "#8a6d3b";
  ctx.lineWidth = 3;
  ctx.strokeRect(3, 3, W - 6, H - 6);
}
function animate() {
  draw();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(animate);
}

// ---------- 入力（ブラウザのみ） ----------
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
  return bestD <= HEX_SIZE * 1.1 ? best : null;
}
function onTap(ev) {
  if (state.over) return;
  const hex = hexFromEvent(ev);
  if (!hex) return;
  const [c, r] = hex;
  if (isPlayerStage() && state.selected && state.reachable.has(key(c, r))) {
    playerTapHex(c, r);
    return;
  }
  const mine = armiesAt(c, r, state.player);
  if (isPlayerStage() && mine.length) {
    // 自軍が複数いる場合は未行動の軍を優先して選ぶ
    const target = mine.find(a => state.stage.endsWith("-fm") ? !a.fmMoved : !a.moved) || mine[0];
    if (playerSelect(target)) { showArmyInfo(target); draw(); return; }
    showArmyInfo(target);
    draw();
    return;
  }
  const any = armiesAt(c, r)[0];
  state.selected = null;
  state.reachable = new Map();
  showArmyInfo(any || null, c, r);
  draw();
}

// ---------- 起動（ブラウザのみ） ----------
function refreshSoundUi() {
  let on = true;
  try { if (typeof Snd !== "undefined" && Snd) on = Snd.isOn(); } catch (e) { /* 既定はオン表示 */ }
  const btn = el("sound-toggle");
  if (btn) btn.textContent = on ? "🔊 音オン" : "🔇 音オフ";
  const chk = el("sound-check");
  if (chk) chk.checked = on;
}
if (typeof document !== "undefined" && typeof window !== "undefined") {
  document.getElementById("map").addEventListener("click", onTap);
  document.getElementById("end-phase").addEventListener("click", () => { playerEndStage(); });
  document.getElementById("storm-btn").addEventListener("click", () => { playerStormChoice(true); });
  document.getElementById("siege-btn").addEventListener("click", () => { playerStormChoice(false); });
  document.getElementById("restart").addEventListener("click", () => {
    sfx("tap");
    document.getElementById("end-overlay").classList.add("hidden");
    startGame(state.player === "none" ? "sweden" : state.player);
  });
  document.getElementById("again").addEventListener("click", () => {
    sfx("tap");
    document.getElementById("end-overlay").classList.add("hidden");
    startGame(state.player === "none" ? "sweden" : state.player);
  });
  document.getElementById("sound-toggle").addEventListener("click", () => {
    try {
      if (typeof Snd !== "undefined" && Snd) { Snd.unlock(); Snd.toggle(); }
    } catch (e) { /* 音響の失敗は無視する */ }
    refreshSoundUi();
    sfx("tap");
  });
  document.getElementById("sound-check").addEventListener("change", (ev) => {
    try { if (typeof Snd !== "undefined" && Snd) Snd.setOn(ev.target.checked); } catch (e) { /* 無視 */ }
    refreshSoundUi();
  });
  document.getElementById("start-game").addEventListener("click", () => {
    const side = document.querySelector('input[name="side"]:checked').value;
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
    const logBox = document.getElementById("log");
    if (logBox) logBox.innerHTML = "";
    startGame(side);
    updateStatus();
    draw();
  });
  refreshSoundUi();
  // 開始画面の裏で初期配置だけ見せておく
  seedRng(42);
  state.armies = ARMIES.filter(a => a.arrive === 0 && !a.event).map(a => ({
    ...a, maxSp: a.sp, alive: true, leaderAlive: true, moved: false, fmMoved: false, mp: 0, fmMp: 0
  }));
  state.cities = CITIES.map(c => ({ ...c, maxGarrison: c.garrison }));
  draw();
  requestAnimationFrame(animate);
}

// ---------- ハーネス用エクスポート（Node検証） ----------
function runAiGame(seed) {
  startGame("none", seed);
  return {
    winner: state.winner,
    turns: state.turn,
    vpSweden: vpScore("sweden"),
    vpImperial: vpScore("imperial"),
    losses: { ...state.losses },
    logLines: state.log.length
  };
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { startGame, runAiGame, state, SCENARIO, CRT, vpScore };
}

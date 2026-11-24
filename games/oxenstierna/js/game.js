// 『宰相』第1部（1632–44）— ゲームエンジン＋UI
// 構成: 前半は DOM に依存しないコアロジック（globalThis.Chancellor として公開し、
// ヘッドレス検証からも駆動できる）、後半がブラウザ UI。
(function () {
"use strict";

var DATA = globalThis.CHANCELLOR_DATA;

// ---------- 乱数（シード付き、mulberry32） ----------
var rngState = 1;
function rngSeed(seed) {
rngState = (seed >>> 0) || 1;
}
function rng() {
rngState = (rngState + 0x6D2B79F5) >>> 0;
var t = rngState;
t = Math.imul(t ^ (t >>> 15), t | 1);
t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function d6() { return 1 + Math.floor(rng() * 6);}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v));}

// ---------- 状態 ----------
var S = null; // ゲーム状態

function areaData(id) { return DATA.AREAS[id];}
function control(id) { return S.areas[id].control;}
function generalOf(army) { return DATA.GENERALS[army.key];}
function abilityOf(army) {
if (typeof army.abilityOverride === "number") return army.abilityOverride;
return generalOf(army).ability;
}
function traitOf(army) { return generalOf(army).trait || "steady";}
function armyLabel(army) {
if (army.generalLabel) return army.generalLabel;
var sh = generalOf(army).short;
return /軍$/.test(sh)? sh: sh + "軍";
}
function armiesIn(areaId, side) {
return S.armies.filter(function (a) {
return a.alive && a.area === areaId && (!side || a.side === side);
});
}
function findArmyByKey(key) {
for (var i = 0; i < S.armies.length; i++) {
if (S.armies[i].alive && S.armies[i].key === key) return S.armies[i];
}
return null;
}
function log(msg) {
S.log.push(msg);
if (S.log.length > 400) S.log.splice(0, S.log.length - 400);
}
function addTrack(name, delta) {
S[name] = clamp(S[name] + delta, 0, 100);
}

function makeArmy(def) {
return {
id: def.key, key: def.key, side: def.side, area: def.area,
sp: def.sp, maxSP: def.maxSP, supply: def.supply, alive: true,
directive: "defend", target: null, funding: 0, lastRatio: null,
movedFrom: null, movedInto: null, intent: null,
abilityOverride: null, generalLabel: null
};
}

// ---------- ゲーム開始 ----------
function newGame(seed) {
rngSeed(seed || 1);
S = {
year: DATA.START_YEAR,
phase: "event", // event | decision | over
onEventsDone: "start",
treasury: DATA.START_TREASURY,
subsidyBase: DATA.START_SUBSIDY_BASE,
subsidyBonus: 0,
homeTaxMod: 0,
copperMod: 0,
trust: DATA.START_TRUST,
people: DATA.START_PEOPLE,
cohesion: DATA.START_COHESION,
prestige: 0,
scoreBonus: 0,
flags: {},
bankruptYears: 0,
landSales: 0,
franceNegUsed: 0,
areas: {},
armies: [],
eventQueue: [],
pendingEvent: null,
firedEvents: {},
usedRandom: {},
usedActions: {},
log: [],
reports: [],
lastIncome: null,
battlesThisYear: [],
wonBattleThisYear: false,
result: null,
defeatReason: null
};
Object.keys(DATA.AREAS).forEach(function (id) {
S.areas[id] = { control: DATA.AREAS[id].control};
S["areaContribMod_" + id] = 0;
});
DATA.INITIAL_ARMIES.forEach(function (def) { S.armies.push(makeArmy(def));});
log("1632年11月、リュッツェンでグスタフ・アドルフ王が戦死した。後見政府を率いる国家宰相アクセル・オクセンシェルナとして、戦争と国家を1644年まで運ぶことがあなたの役目である。");
startYear();
return S;
}

// ---------- 年開始：増援・収入・報告・開始イベント ----------
function startYear() {
// 増援
DATA.SPAWNS.forEach(function (sp) {
if (sp.year === S.year &&!findArmyByKey(sp.key)) {
S.armies.push(makeArmy(sp));
log(sp.note);
}
});
// 1643年：バイエルン軍の指揮官にメルシー
if (S.year === 1643) {
var bav = findArmyByKey("bavarian");
if (bav && abilityOf(bav) < 3) {
bav.abilityOverride = 3;
log("バイエルン軍の指揮官に名将メルシーが就いた（バイエルン軍の指揮能力が3になった）。");
}
}
// 収入
var inc = computeIncome();
S.lastIncome = inc;
S.treasury += inc.total;
log("【" + S.year + "年 歳入】本国税収" + inc.home + "、関税・銅" + inc.customs +
"、フランス補助金" + inc.subsidy + "、分担金" + inc.contributions +
(inc.heilbronnCost? "、同盟維持費−" + inc.heilbronnCost: "") +
" ＝ 合計" + inc.total + "。国庫は" + S.treasury + "。");
S.reports = genReports();
S.usedActions = {};
queueScripted("start");
S.onEventsDone = "start";
advanceEvent();
}

function computeIncome() {
var home = Math.max(0, DATA.HOME_TAX + S.homeTaxMod);
var customs = Math.max(0, DATA.CUSTOMS + S.copperMod);
S.copperMod = 0; // 一回限りの修正はここで消費
var subsidy = S.subsidyBase + S.subsidyBonus;
var contributions = 0;
Object.keys(DATA.AREAS).forEach(function (id) {
var a = DATA.AREAS[id];
if (!a.contribution) return;
var base = a.contribution + (S["areaContribMod_" + id] || 0);
var c = control(id);
if (c === "sweden") contributions += base;
else if (c === "ally") contributions += Math.floor(base / 2) + (S.flags.heilbronn? 1: 0);
});
var heilbronnCost = S.flags.heilbronn? 3: 0;
return {
home: home, customs: customs, subsidy: subsidy,
contributions: contributions, heilbronnCost: heilbronnCost,
total: home + customs + subsidy + contributions - heilbronnCost
};
}

function genReports() {
var lines = [];
S.armies.forEach(function (a) {
if (!a.alive || a.side!== "sw") return;
var need = a.sp;
var line = armyLabel(a) + "（" + areaData(a.area).name + "、戦力" + a.sp + "/" + a.maxSP +
"、給養" + a.supply + "）：維持費は" + need + "。";
if (a.lastRatio === null) line += "着任したばかりである。";
else if (a.lastRatio >= 1) line += "十分な支給を受けている。";
else if (a.lastRatio >= 0.5) line += "支給が不足気味だと訴えている。";
else line += "兵が飢えている。このままでは軍が持たない。";
if (traitOf(a) === "aggressive" && a.lastRatio!== null && a.lastRatio < 1) {
line += "攻勢のための追加資金を強く求めている。";
}
lines.push(line);
});
var strongest = null;
S.armies.forEach(function (a) {
if (a.alive && a.side === "imp" && (!strongest || a.sp > strongest.sp)) strongest = a;
});
if (strongest) {
lines.push("敵情：最大の敵軍は" + armyLabel(strongest) + "（" + areaData(strongest.area).name +
"、戦力" + strongest.sp + "）。");
}
return lines;
}

// ---------- イベント ----------
function eventConditionOk(ev) {
if (S.firedEvents[ev.id]) return false;
if (ev.requiresFlag &&!S.flags[ev.requiresFlag]) return false;
if (ev.forbidsFlag && S.flags[ev.forbidsFlag]) return false;
if (ev.requiresArmy &&!findArmyByKey(ev.requiresArmy)) return false;
if (ev.when === "wonBattle" &&!S.wonBattleThisYear) return false;
return true;
}
function queueScripted(timing) {
DATA.SCRIPTED_EVENTS.forEach(function (ev) {
if (ev.year === S.year && ev.timing === timing && eventConditionOk(ev)) {
S.eventQueue.push(ev);
}
});
}
function queueRandom() {
if (S.year >= DATA.END_YEAR) return;
if (rng() >= 0.55) return;
var pool = DATA.RANDOM_EVENTS.filter(function (ev) {
return!S.usedRandom[ev.id] && eventConditionOk(ev);
});
if (!pool.length) return;
var ev = pool[Math.floor(rng() * pool.length)];
S.usedRandom[ev.id] = true;
S.eventQueue.push(ev);
}
function advanceEvent() {
if (S.eventQueue.length) {
S.pendingEvent = S.eventQueue.shift();
S.phase = "event";
return;
}
S.pendingEvent = null;
if (S.onEventsDone === "start") {
S.phase = "decision";
} else if (S.onEventsDone === "yearEnd") {
postYearEnd();
}
}
function pendingEvent() { return S? S.pendingEvent: null;}

function chooseEvent(idx) {
var ev = S.pendingEvent;
if (!ev) return { ok: false};
var choice = ev.choices[clamp(idx, 0, ev.choices.length - 1)];
S.firedEvents[ev.id] = true;
S.pendingEvent = null;
log("【" + ev.title + "】" + choice.label);
if (choice.effects) applyEffects(choice.effects);
// イベントで信任・民心が尽きたら即座に敗北
if (S.trust <= 0) return finishDefeat("失脚");
if (S.people <= 0) return finishDefeat("国内の崩壊");
advanceEvent();
return { ok: true};
}

function applyEffects(eff) {
if (!eff) return;
if (typeof eff.treasury === "number") S.treasury += eff.treasury;
if (typeof eff.trust === "number") addTrack("trust", eff.trust);
if (typeof eff.people === "number") addTrack("people", eff.people);
if (typeof eff.cohesion === "number") addTrack("cohesion", eff.cohesion);
if (typeof eff.prestige === "number") S.prestige += eff.prestige;
if (typeof eff.scoreBonus === "number") S.scoreBonus += eff.scoreBonus;
if (typeof eff.homeTaxMod === "number") S.homeTaxMod += eff.homeTaxMod;
if (typeof eff.copperMod === "number") S.copperMod += eff.copperMod;
if (typeof eff.subsidyBaseSet === "number") S.subsidyBase = eff.subsidyBaseSet;
if (typeof eff.subsidyBonus === "number") S.subsidyBonus = clamp(S.subsidyBonus + eff.subsidyBonus, 0, 4);
if (eff.flag) S.flags[eff.flag] = true;
if (eff.areaContributionMod) {
Object.keys(eff.areaContributionMod).forEach(function (id) {
S["areaContribMod_" + id] = (S["areaContribMod_" + id] || 0) + eff.areaContributionMod[id];
});
}
if (eff.custom) runCustom(eff.custom);
}

// ---------- イベントの個別処理 ----------
function spawnArmy(key, area, sp, maxSP) {
if (findArmyByKey(key)) return null;
var a = makeArmy({ key: key, side: "imp", area: area, sp: sp, maxSP: maxSP, supply: 2});
S.armies.push(a);
return a;
}
function doSaxonyDefect() {
if (S.flags.saxonyDefected) return;
S.flags.saxonyDefected = true;
S.areas.saxony.control = "imperial";
spawnArmy("saxon", "saxony", 5, 6);
log("ザクセンは皇帝側へ移り、ザクセン軍がザクセンに現れた。");
armiesIn("saxony", "sw").forEach(function (a) {
var dest =!armiesIn("brandenburg", "imp").length? "brandenburg": "pommern";
a.area = dest;
a.sp -= 1;
log(armyLabel(a) + "はザクセンを慌しく退き、" + areaData(dest).name + "へ退いた（戦力−1）。");
if (a.sp <= 0) destroyArmy(a, "離反の混乱で四散した。");
});
}
function runCustom(name) {
var a, cands, pick;
switch (name) {
case "saxonyDefectNow":
doSaxonyDefect();
break;
case "successionA":
a = findArmyByKey("baner");
if (a) { a.key = "torstensson"; log("主力軍の指揮はトルステンソンに引き継がれた。");}
break;
case "successionB":
a = findArmyByKey("baner");
if (a) {
a.abilityOverride = 1;
a.generalLabel = "主力軍（暫定指揮）";
a.sp = Math.max(1, a.sp - 1);
S.flags.successionInternal = true;
log("主力軍は副将の暫定指揮となった（戦力−1、指揮能力1）。");
}
break;
case "successionArrive":
a = findArmyByKey("baner");
if (a) {
a.key = "torstensson";
a.abilityOverride = null;
a.generalLabel = null;
log("主力軍はトルステンソン軍となった。");
}
break;
case "denmarkAttack":
S.flags.denmarkWar = true;
spawnArmy("danish", "denmark", 6, 7);
a = findArmyByKey("torstensson") || strongestSwedishInGermany();
if (a && a.area!== "westfalen") {
a.area = "westfalen";
log(armyLabel(a) + "は皇帝軍の追撃をかわし、ヴェストファーレンへ北転した。デンマークと開戦した。");
} else {
log("デンマークと開戦した。");
}
break;
case "denmarkIgnore":
S.flags.denmarkThreat = true;
break;
case "plagueHit":
cands = S.armies.filter(function (x) { return x.alive && x.side === "sw" && x.area!== "sweden";});
if (cands.length) {
pick = cands[Math.floor(rng() * cands.length)];
pick.sp -= 1;
log(armyLabel(pick) + "が疫病で戦力−1。");
if (pick.sp <= 0) destroyArmy(pick, "疫病で壊滅した。");
}
break;
case "enemyDeathHit":
cands = S.armies.filter(function (x) { return x.alive && x.side === "imp";});
if (cands.length) {
pick = cands[Math.floor(rng() * cands.length)];
pick.sp -= 2;
log(armyLabel(pick) + "が将軍の病死で戦力−2。");
if (pick.sp <= 0) destroyArmy(pick, "将軍の死で四散した。");
}
break;
case "franceRefuse":
if (S.subsidyBonus > 0) S.subsidyBonus -= 1;
else addTrack("trust", -2);
break;
case "christinaB":
if (S.trust >= 60) { S.scoreBonus += 2; log("宰相は権限を押し切った。");}
else { S.scoreBonus -= 4; log("女王との溝が深まった。");}
break;
}
}
function strongestSwedishInGermany() {
var best = null;
S.armies.forEach(function (a) {
if (a.alive && a.side === "sw" && a.area!== "sweden" && (!best || a.sp > best.sp)) best = a;
});
return best;
}
function destroyArmy(a, note) {
a.sp = 0;
a.alive = false;
log(armyLabel(a) + "は" + (note || "壊滅した。"));
}

// ---------- 意思決定フェイズのアクション（外交・国内政策） ----------
var ACTIONS = [
{ id: "tax", name: "臨時増税", desc: "国庫+8、民心−8", oncePerTurn: true,
can: function () { return true;},
run: function () { S.treasury += 8; addTrack("people", -8); log("臨時増税を実施した（国庫+8、民心−8）。");}},
{ id: "sellLand", name: "王領地の売却", desc: "国庫+12、本国税収−2（恒常）、信任+3、民心−3 ※3回まで",
can: function () { return S.landSales < 3;},
run: function () {
S.landSales += 1; S.treasury += 12; S.homeTaxMod -= 2;
addTrack("trust", 3); addTrack("people", -3);
log("王領地を売却した（国庫+12、本国税収は恒常的に−2）。将来の王権の基盤は細る。");
}},
{ id: "relief", name: "負担緩和", desc: "国庫−6、民心+9", cost: 6, oncePerTurn: true,
can: function () { return true;},
run: function () { addTrack("people", 9); log("本国の負担を緩和した（民心+9）。");}},
{ id: "council", name: "評議会への工作", desc: "国庫−4、評議会の信任+7", cost: 4, oncePerTurn: true,
can: function () { return true;},
run: function () { addTrack("trust", 7); log("評議会の有力者に働きかけた（信任+7）。");}},
{ id: "franceNeg", name: "フランスとの交渉", desc: "国庫−4、補助金の加算+2（最大+4）※2回まで", cost: 4,
can: function () { return S.franceNegUsed < 2 && S.subsidyBonus < 4;},
run: function () {
S.franceNegUsed += 1; S.subsidyBonus = clamp(S.subsidyBonus + 2, 0, 4);
log("フランスと交渉し、補助金の加算を得た（補助金+2/年）。");
}},
{ id: "concede", name: "諸侯への譲歩", desc: "国庫−5、諸侯の結束+10", cost: 5, oncePerTurn: true,
can: function () { return true;},
run: function () { addTrack("cohesion", 10); log("同盟諸侯に譲歩した（結束+10）。");}}
];
function availableActions() {
return ACTIONS.map(function (act) {
var usable = true, reason = "";
if (S.phase!== "decision") { usable = false; reason = "意思決定フェイズではない";}
else if (act.oncePerTurn && S.usedActions[act.id]) { usable = false; reason = "今年は実施済み";}
else if (!act.can()) { usable = false; reason = "条件を満たさない";}
else if (act.cost && S.treasury < act.cost) { usable = false; reason = "国庫が足りない";}
return { id: act.id, name: act.name, desc: act.desc, cost: act.cost || 0, usable: usable, reason: reason};
});
}
function doAction(id) {
var act = null;
ACTIONS.forEach(function (x) { if (x.id === id) act = x;});
if (!act) return { ok: false, error: "不明なアクション"};
var info = availableActions().filter(function (x) { return x.id === id;})[0];
if (!info.usable) return { ok: false, error: info.reason};
if (act.cost) S.treasury -= act.cost;
S.usedActions[id] = true;
act.run();
return { ok: true};
}

// ---------- 移動ヘルパ ----------
function pathTo(from, to) {
if (from === to) return [from];
var prev = {};
prev[from] = null;
var queue = [from];
while (queue.length) {
var cur = queue.shift();
var links = areaData(cur).links;
for (var i = 0; i < links.length; i++) {
var nx = links[i];
if (!(nx in prev)) {
prev[nx] = cur;
if (nx === to) {
var path = [to];
var p = cur;
while (p!== null) { path.unshift(p); p = prev[p];}
return path;
}
queue.push(nx);
}
}
}
return null;
}
function validTargets(army) {
var out = [];
var adj = areaData(army.area).links;
adj.forEach(function (id) {
if (id === "sweden") return;
if (id === "denmark" &&!S.flags.denmarkWar) return;
out.push(id);
});
if (traitOf(army) === "fast") {
adj.forEach(function (mid) {
if (mid === "sweden") return;
if (mid === "denmark" &&!S.flags.denmarkWar) return;
if (armiesIn(mid, "imp").length) return; // 敵軍のいるエリアは抜けられない
areaData(mid).links.forEach(function (id) {
if (id === army.area || id === "sweden") return;
if (id === "denmark" &&!S.flags.denmarkWar) return;
if (out.indexOf(id) < 0) out.push(id);
});
});
}
return out;
}

// ---------- 意思決定の確定 → 戦争解決 → 年末 ----------
function upkeepNeed(army, directiveType) {
if (directiveType === "forage") return 0;
if (directiveType === "return") return Math.ceil(army.sp / 2);
return army.sp;
}

function submitDecisions(decisions) {
if (S.phase!== "decision") return { ok: false, error: "意思決定フェイズではない"};
decisions = decisions || {};
var funding = decisions.funding || {};
var directives = decisions.directives || {};
var total = 0;
S.armies.forEach(function (a) {
if (a.alive && a.side === "sw") {
var f = Math.max(0, Math.floor(funding[a.id] || 0));
a.funding = f;
total += f;
var d = directives[a.id] || { type: "defend", target: null};
if (["advance", "defend", "forage", "return"].indexOf(d.type) < 0) d.type = "defend";
if (d.type === "advance") {
if (!d.target || validTargets(a).indexOf(d.target) < 0) {
d = { type: "defend", target: null};
}
}
a.directive = d.type;
a.target = d.target || null;
}
});
if (total > Math.max(0, S.treasury)) {
return { ok: false, error: "配分の合計が国庫を超えている"};
}
S.treasury -= total;
// 資金配分の効果（給養・補充）
S.armies.forEach(function (a) {
if (!a.alive || a.side!== "sw") return;
var need = upkeepNeed(a, a.directive);
var paid = a.funding;
var ratio = need === 0? 1: paid / need;
a.lastRatio = ratio;
if (a.directive === "forage") {
// 現地調達：給養は維持されるが、土地と同盟が傷つく
var c = control(a.area);
if (c === "ally") { addTrack("cohesion", -3); log(armyLabel(a) + "は同盟地で現地調達を行った（諸侯の結束−3）。");}
else if (c === "sweden" && a.area!== "sweden") { addTrack("cohesion", -1);}
else if (a.area === "sweden") { addTrack("people", -3); log(armyLabel(a) + "が本国で調達を行い、民心が傷ついた（民心−3）。");}
} else if (a.directive === "return") {
if (paid >= need) {
a.supply = clamp(a.supply + 2, 0, 3);
a.sp = Math.min(a.maxSP, a.sp + 1);
} else if (ratio < 0.5) {
a.supply = clamp(a.supply - 1, 0, 3);
}
} else if (ratio >= 1) {
a.supply = clamp(a.supply + 1, 0, 3);
var surplus = paid - need;
var add = Math.floor(surplus / 2);
if (add > 0) {
var before = a.sp;
a.sp = Math.min(a.maxSP, a.sp + add);
if (a.sp > before) log(armyLabel(a) + "に補充が回り、戦力" + before + "→" + a.sp + "。");
}
} else if (ratio < 0.5) {
a.supply = clamp(a.supply - 1, 0, 3);
if (a.supply <= 0) {
a.sp -= 2;
log(armyLabel(a) + "は支給の途絶で兵を失った（戦力−2）。");
if (a.sp <= 0) destroyArmy(a, "飢えと脱走で解散した。");
}
}
});
resolveWar();
yearEndSequence();
return { ok: true};
}

// ---------- 戦争解決 ----------
function moveArmyTo(a, dest) {
a.movedFrom = a.area;
a.area = dest;
a.movedInto = dest;
}
function resolveWar() {
S.battlesThisYear = [];
S.wonBattleThisYear = false;
S.armies.forEach(function (a) { a.movedFrom = null; a.movedInto = null; a.intent = null;});
// 1) 自軍の移動
S.armies.forEach(function (a) {
if (!a.alive || a.side!== "sw") return;
if (a.directive === "advance" && a.target) {
moveArmyTo(a, a.target);
log(armyLabel(a) + "は" + areaData(a.target).name + "へ進んだ。");
} else if (a.directive === "return") {
var path = pathTo(a.area, "sweden");
if (path && path.length > 1) {
var steps = Math.min(2, path.length - 1);
for (var i = 1; i <= steps; i++) {
if (armiesIn(path[i], "imp").length) break;
moveArmyTo(a, path[i]);
}
if (a.area === "sweden") log(armyLabel(a) + "は本国へ帰還し、立て直しを図った。");
else if (a.movedInto) log(armyLabel(a) + "は本国方面へ退いた（現在地：" + areaData(a.area).name + "）。");
}
}
});
// 2) 皇帝側の行動
S.armies.forEach(function (a) {
if (a.alive && a.side === "imp") enemyAct(a);
});
// 3) 会戦
Object.keys(DATA.AREAS).forEach(function (id) {
if (armiesIn(id, "sw").length && armiesIn(id, "imp").length) resolveBattle(id);
});
// 4) 無抵抗の占領
occupationStep();
// 5) 皇帝側の回復（自領で戦わなかった軍は+1）
S.armies.forEach(function (a) {
if (!a.alive || a.side!== "imp") return;
var fought = S.battlesThisYear.some(function (b) { return b.impIds.indexOf(a.id) >= 0;});
if (!fought &&!a.movedInto && control(a.area) === "imperial" && a.sp < a.maxSP) {
a.sp += 1;
}
});
}

function enemyAct(a) {
a.intent = "defend";
if (armiesIn(a.area, "sw").length) { a.intent = "fight"; return;}
if (a.key === "danish") return; // デンマーク軍は本国を守る
var myPower = a.sp + abilityOf(a) + a.supply;
var best = null;
areaData(a.area).links.forEach(function (id) {
if (id === "sweden") return;
if (id === "denmark" &&!S.flags.denmarkWar) return;
var sw = armiesIn(id, "sw");
var swPower = sw.reduce(function (s, x) { return s + x.sp + abilityOf(x) + x.supply;}, 0);
var c = control(id);
var score = 0;
if (sw.length && myPower >= swPower * 0.85) score = 50 + (c === "sweden"? 10: 0);
else if (!sw.length && (c === "sweden" || c === "ally")) score = 28 + areaData(id).value * 3;
else if (!sw.length && c === "contested") score = 18;
if (score > 0 && rng() < (generalOf(a).aggression || 0.5) + 0.25) {
if (!best || score > best.score) best = { area: id, score: score};
}
});
if (best) {
moveArmyTo(a, best.area);
a.intent = "attack";
log(armyLabel(a) + "が" + areaData(best.area).name + "へ攻勢に出た。");
}
}

function sidePower(armies, isDefender, areaId, side) {
var p = 0;
armies.forEach(function (a) {
var v = a.sp + abilityOf(a) + a.supply;
if (isDefender && a.side === "sw" && a.directive === "defend") v += 2;
if (isDefender && a.side === "imp" && a.intent!== "attack") v += 2;
if (a.side === "sw" && a.directive === "forage") v -= 1;
p += v;
});
if (side === "sw" && S.flags.franceAlly && (areaId === "rhine" || areaId === "southgermany")) p += 1;
if (side === "imp" && S.year === 1634 && ["southgermany", "bavaria", "bohemia"].indexOf(areaId) >= 0) p += 1;
return p;
}
function distributeLoss(armies, loss) {
var sorted = armies.slice().sort(function (x, y) { return y.sp - x.sp;});
var rest = loss;
sorted.forEach(function (a) {
if (rest <= 0) return;
var take = Math.min(a.sp, rest);
a.sp -= take;
rest -= take;
});
sorted.forEach(function (a) { if (a.sp <= 0 && a.alive) destroyArmy(a, "会戦で壊滅した。");});
}
function retreatDestination(a, battleArea, enemySide) {
var cands = areaData(battleArea).links.map(function (id) {
var score = 0;
var c = control(id);
if (a.side === "sw") {
if (c === "sweden") score += 10;
else if (c === "ally") score += 7;
else if (c === "contested") score += 2;
} else {
if (c === "imperial") score += 10;
else if (c === "contested") score += 2;
}
if (id === a.movedFrom) score += 3;
if (id === "denmark" && !S.flags.denmarkWar && !S.flags.denmarkDefeated) score = -100;
if (armiesIn(id, enemySide).length) score = -100;
return { id: id, score: score};
}).filter(function (x) { return x.score > -100;});
cands.sort(function (x, y) { return y.score - x.score;});
return cands.length? cands[0].id: null;
}

function resolveBattle(areaId) {
var swArmies = armiesIn(areaId, "sw");
var impArmies = armiesIn(areaId, "imp");
var preControl = control(areaId);
var swMovedIn = swArmies.some(function (a) { return a.movedInto === areaId;});
var impMovedIn = impArmies.some(function (a) { return a.movedInto === areaId;});
var attacker;
if (swMovedIn &&!impMovedIn) attacker = "sw";
else if (impMovedIn &&!swMovedIn) attacker = "imp";
else if (swMovedIn && impMovedIn) attacker = swArmies.some(function (a) { return a.directive === "advance";})? "sw": "imp";
else attacker = rng() < 0.5? "sw": "imp";
var defender = attacker === "sw"? "imp": "sw";
var atkArmies = attacker === "sw"? swArmies: impArmies;
var defArmies = defender === "sw"? swArmies: impArmies;
var atkPow = sidePower(atkArmies, false, areaId, attacker) + d6();
var defPow = sidePower(defArmies, true, areaId, defender) + d6();
var margin = atkPow - defPow;
var rec = { area: areaId, winner: "draw", margin: Math.abs(margin),
swIds: swArmies.map(function (a) { return a.id;}),
impIds: impArmies.map(function (a) { return a.id;})};
var am = Math.abs(margin);
var loseLoss;
if (am === 0) loseLoss = 1;
else if (am <= 2) loseLoss = 2;
else if (am <= 5) loseLoss = 3;
else loseLoss = 4;
if (margin > 0) rec.winner = attacker;
else if (margin < 0) rec.winner = defender;
if (rec.winner === "draw") {
distributeLoss(atkArmies, 1);
distributeLoss(defArmies, 1);
} else if (rec.winner === attacker) {
distributeLoss(atkArmies, 1);
distributeLoss(defArmies, loseLoss);
} else {
distributeLoss(atkArmies, loseLoss);
distributeLoss(defArmies, 1);
}
var areaName = areaData(areaId).name;
if (rec.winner === "draw") {
log("【会戦】" + areaName + "の戦いは決着がつかなかった（両軍とも戦力−1）。");
} else {
var winnerLabel = rec.winner === "sw"? "スウェーデン側": "皇帝側";
log("【会戦】" + areaName + "の戦いは" + winnerLabel + "の勝利（戦力差" + am +
"）。敗北側は戦力−" + loseLoss + "。");
}
if (rec.winner === "sw") {
S.wonBattleThisYear = true;
S.prestige += 1;
S.battleTrust = (S.battleTrust || 0) + 2;
} else if (rec.winner === "imp") {
S.battleTrust = (S.battleTrust || 0) - 3;
}
// 敗北側の退却と支配の移行
if (rec.winner!== "draw") {
var loserSide = rec.winner === "sw"? "imp": "sw";
var loserArmies = loserSide === "sw"? swArmies: impArmies;
var winnerArmies = rec.winner === "sw"? swArmies: impArmies;
loserArmies.forEach(function (a) {
if (!a.alive) return;
var dest = retreatDestination(a, areaId, rec.winner);
if (dest) {
a.area = dest;
a.supply = clamp(a.supply - 1, 0, 3);
log(armyLabel(a) + "は" + areaData(dest).name + "へ退却した。");
} else {
a.sp -= 1;
log(armyLabel(a) + "は退却路を失い、さらに兵を失った（戦力−1）。");
if (a.sp <= 0) destroyArmy(a, "退却不能のまま壊滅した。");
}
});
var winnerPresent = winnerArmies.some(function (a) { return a.alive && a.area === areaId;});
var loserPresent = loserArmies.some(function (a) { return a.alive && a.area === areaId;});
if (winnerPresent &&!loserPresent) {
if (areaId === "denmark" && rec.winner === "sw") {
denmarkDefeated();
} else if (rec.winner === "sw") {
S.areas[areaId].control = preControl === "ally"? "ally": "sweden";
log(areaName + "はスウェーデン側の支配に入った。");
} else {
S.areas[areaId].control = "imperial";
log(areaName + "は皇帝側の支配に入った。");
}
}
// ホルンの捕虜（1634年、大敗時）
if (S.year === 1634 && loserSide === "sw") {
var horn = findArmyByKey("horn");
if (horn && rec.swIds.indexOf(horn.id) >= 0 && horn.sp <= 2) {
destroyArmy(horn, "ネルドリンゲンで捕虜となった。ホルンは長く幽閉されることになる。");
addTrack("trust", -3);
log("ホルンの捕虜は評議会に衝撃を与えた（信任−3）。");
}
}
}
S.battlesThisYear.push(rec);
famousVictoryCheck(rec);
}

function denmarkDefeated() {
if (S.flags.denmarkDefeated) return;
S.flags.denmarkDefeated = true;
S.areas.denmark.control = "sweden";
var dan = findArmyByKey("danish");
if (dan && dan.alive) destroyArmy(dan, "デンマーク軍は解散し、国王は講和に応じた。");
S.treasury += 8;
S.prestige += 2;
log("デンマークを屈服させた（賠償として国庫+8、威信+2）。背後の脅威は消えた。");
}

function famousVictoryCheck(rec) {
if (rec.winner!== "sw") return;
var areas = [rec.area];
function hasGeneral(key) {
var a = findArmyByKey(key);
return a && (rec.swIds.indexOf(a.id) >= 0);
}
if (S.year === 1636 && hasGeneral("baner") &&
["brandenburg", "westfalen", "pommern"].indexOf(rec.area) >= 0 &&!S.flags.wittstock) {
S.flags.wittstock = true;
addTrack("cohesion", 8); addTrack("trust", 6); S.prestige += 2;
log("【ヴィットシュトックの勝利】バネールの勝利にドイツ諸侯は奮い立った（結束+8、信任+6、威信+2）。");
}
if (S.year === 1639 && hasGeneral("baner") &&
["saxony", "bohemia", "brandenburg"].indexOf(rec.area) >= 0 &&!S.flags.chemnitz) {
S.flags.chemnitz = true;
addTrack("trust", 4); S.prestige += 1;
log("【ケムニッツの勝利】バネールの攻勢が実を結んだ（信任+4、威信+1）。");
}
if (S.year === 1642 && hasGeneral("torstensson") &&
["saxony", "bohemia"].indexOf(rec.area) >= 0 &&!S.flags.breitenfeld2) {
S.flags.breitenfeld2 = true;
addTrack("trust", 5); S.prestige += 2;
log("【第二次ブライテンフェルトの勝利】トルステンソンの電撃的な勝利である（信任+5、威信+2）。");
}
void areas;
}

function occupationStep() {
Object.keys(DATA.AREAS).forEach(function (id) {
if (id === "sweden") return;
var sw = armiesIn(id, "sw").length;
var imp = armiesIn(id, "imp").length;
var c = control(id);
if (id === "denmark") {
if (sw &&!imp && S.flags.denmarkWar && c!== "sweden") denmarkDefeated();
return;
}
if (sw &&!imp && (c === "imperial" || c === "contested")) {
S.areas[id].control = "sweden";
log(areaData(id).name + "を占領し、支配に入れた。");
} else if (imp &&!sw && (c === "sweden" || c === "ally" || c === "contested")) {
S.areas[id].control = "imperial";
log(areaData(id).name + "は皇帝側に占領された。");
}
});
}

// ---------- 年末 ----------
function yearEndSequence() {
// 信任への会戦の影響と、年次の漂流
if (S.battleTrust) { addTrack("trust", S.battleTrust); S.battleTrust = 0;}
addTrack("people", -2);
addTrack("cohesion", -3);
addTrack("trust", -1);
if (S.treasury >= 20) addTrack("trust", 1);
// フランスへの約束のチェック
if (S.flags.francePromise) {
S.flags.francePromise = false;
if (!armiesIn("rhine", "sw").length) {
addTrack("trust", -5);
log("フランスへの約束（ライン方面の作戦）が果たされず、評議会の信任が傷ついた（信任−5）。");
}
}
if (S.treasury <= 0) S.bankruptYears += 1;
else S.bankruptYears = 0;
queueScripted("end");
queueRandom();
S.onEventsDone = "yearEnd";
advanceEvent();
}

function postYearEnd() {
if (S.trust <= 0) return finishDefeat("失脚");
if (S.people <= 0) return finishDefeat("国内の崩壊");
if (!S.armies.some(function (a) { return a.alive && a.side === "sw";})) {
return finishDefeat("軍の壊滅");
}
if (S.bankruptYears >= 2) return finishDefeat("財政破綻");
if (S.year >= DATA.END_YEAR) {
evaluate();
return;
}
S.year += 1;
startYear();
}

function finishDefeat(reason) {
S.phase = "over";
S.defeatReason = reason;
S.pendingEvent = null;
S.eventQueue = [];
var texts = {
"失脚": "評議会の信任を失った宰相は、静かに政権の座を降りた。戦争は他人の手に委ねられる。",
"国内の崩壊": "負担に耐えかねた本国が崩れた。戦争どころではなくなった。",
"軍の壊滅": "ドイツにスウェーデンの軍は残っていない。宰相の戦争は終わった。",
"財政破綻": "国庫は干上がり、給与の払えない軍は四散した。戦争の継続は不可能になった。"
};
S.result = {
defeat: true, reason: reason, year: S.year,
text: texts[reason] || "",
score: null, rank: "敗北"
};
log("【敗北】" + reason + "（" + S.year + "年）。" + (texts[reason] || ""));
saveResult();
return { ok: true};
}

// ---------- 最終評価（1644年末） ----------
function evaluate() {
var territory = 0;
Object.keys(DATA.AREAS).forEach(function (id) {
var v = DATA.AREAS[id].value;
var c = control(id);
if (c === "sweden") territory += v * 2;
else if (c === "ally") territory += v;
});
var treasuryScore = Math.min(15, Math.floor(Math.max(0, S.treasury) / 3)) + (S.bankruptYears === 0? 5: 0);
var totalSP = 0, totalMax = 0;
S.armies.forEach(function (a) {
if (a.side === "sw") { totalSP += Math.max(0, a.sp); totalMax += a.maxSP;}
});
var armyScore = totalMax? Math.round(15 * totalSP / totalMax): 0;
var trustScore = Math.floor(S.trust / 10);
var peopleScore = Math.floor(S.people / 10);
var cohesionScore = Math.floor(S.cohesion / 20);
var prestigeScore = Math.min(10, S.prestige);
var denmarkBonus = S.flags.denmarkDefeated? 6: 0;
var total = territory + treasuryScore + armyScore + trustScore + peopleScore +
cohesionScore + prestigeScore + denmarkBonus + S.scoreBonus;
var rank;
if (total >= 85) rank = "大宰相の統治";
else if (total >= 68) rank = "名宰相";
else if (total >= 52) rank = "及第点";
else if (total >= 38) rank = "苦闘の12年";
else rank = "失意の退任";
var lines = [];
if (S.flags.denmarkDefeated) {
lines.push("デンマークを屈服させた。史実でも1643年のトルステンソンの北転は成功し、ブレムセブロー条約（1645年）で大きな譲歩を引き出した。");
} else if (S.flags.denmarkWar) {
lines.push("デンマーク戦は決着を見ないまま終わった。史実ではトルステンソンが電撃的に侵攻し、戦争を早期に終わらせている。");
} else {
lines.push("デンマーク問題は先送りされた。背後の脅威は第2部でも残るだろう。");
}
if (control("saxony") === "sweden") lines.push("ザクセンを保持した。史実では1635年に失った土地であり、大きな成果である。");
else if (control("saxony") === "imperial") lines.push("ザクセンは皇帝側に残った（史実どおり）。");
if (control("pommern") === "sweden") lines.push("ポンメルンは保持された。講和会議で西ポンメルンを確保する地歩である（史実どおり）。");
else lines.push("ポンメルンを失ったのは痛い。本国との連絡線が脅かされる。");
if (S.treasury >= 20) lines.push("財政は健全さを保った。王領地の切り売りに頼りすぎなかったことは、後の王権のためにもなる。");
else if (S.treasury <= 0) lines.push("財政は火の車だった。第2部では立て直しが急務になる。");
if (S.trust >= 60) lines.push("評議会の信任は厚く、女王の親政後も助言者として重きをなすだろう。");
else if (S.trust < 35) lines.push("信任は細り、親政後の立場は危うい。史実でもオクセンシェルナは女王としだいに疎遠になっていく。");
if (armyScore >= 10) lines.push("軍は温存され、講和交渉の裏付けとなる。");
else if (armyScore <= 4) lines.push("軍の消耗が激しい。講和の席で強く出る材料が乏しい。");
S.result = {
defeat: false, year: DATA.END_YEAR, score: total, rank: rank,
breakdown: {
territory: territory, treasury: treasuryScore, army: armyScore,
trust: trustScore, people: peopleScore, cohesion: cohesionScore,
prestige: prestigeScore, denmark: denmarkBonus, bonus: S.scoreBonus
},
lines: lines,
treasury: S.treasury, trust: S.trust, people: S.people, cohesion: S.cohesion,
areas: Object.keys(DATA.AREAS).reduce(function (o, id) { o[id] = control(id); return o;}, {})
};
S.phase = "over";
log("【最終評価】" + total + "点 — " + rank + "。この結果は第2部への引き継ぎ用に保存された。");
saveResult();
}

function saveResult() {
try {
if (typeof localStorage!== "undefined") {
localStorage.setItem("oxenstierna.part1.result.v1", JSON.stringify(S.result));
}
} catch (e) { /* 保存できなくてもゲームは続く */}
}

// ---------- 自動方針（検証用） ----------
function autoDecisions() {
if (!S || S.phase!== "decision") return null;
// 簡単な政策アクション
if (S.people <= 42 && S.treasury >= 6) doAction("relief");
if (S.cohesion <= 40 && S.treasury >= 5) doAction("concede");
if (S.trust <= 45 && S.treasury >= 4) doAction("council");
if (S.treasury <= 8 && S.people > 35) doAction("tax");
if (S.treasury >= 24 && S.landSales < 2 && S.year >= 1639 && rng() < 0.3) doAction("sellLand");
var funding = {}, directives = {};
var budget = Math.max(0, S.treasury);
var sw = S.armies.filter(function (a) { return a.alive && a.side === "sw";})
.sort(function (x, y) { return y.sp - x.sp;});
sw.forEach(function (a) {
var dir = decideDirective(a, budget);
directives[a.id] = dir;
var need = upkeepNeed(a, dir.type);
var alloc = 0;
if (dir.type!== "forage") {
alloc = Math.min(need + (a.sp >= 6? 2: 0), budget);
if (alloc < Math.ceil(need * 0.5) && dir.type!== "return") {
// 半分も払えないなら現地調達に切り替える（ドイツにいる場合）
if (a.area!== "sweden" && control(a.area)!== "ally") {
dir = { type: "forage", target: null};
directives[a.id] = dir;
alloc = 0;
}
}
}
funding[a.id] = alloc;
budget -= alloc;
});
return { funding: funding, directives: directives};
}
function decideDirective(a, budget) {
if (a.area === "sweden") {
var t = validTargets(a);
return t.indexOf("pommern") >= 0? { type: "advance", target: "pommern"}: { type: "defend", target: null};
}
if (a.sp <= 3 && control(a.area)!== "sweden") return { type: "return", target: null};
var myPow = a.sp + abilityOf(a) + a.supply;
var targets = validTargets(a);
var best = null;
targets.forEach(function (id) {
var imp = armiesIn(id, "imp");
if (!imp.length) return;
var impPow = imp.reduce(function (s, x) { return s + x.sp + abilityOf(x) + x.supply;}, 0);
if (myPow >= impPow * 0.95 && (!best || impPow < best.impPow)) best = { id: id, impPow: impPow};
});
if (best) return { type: "advance", target: best.id};
if (armiesIn(a.area, "imp").length) return { type: "defend", target: null};
var c = control(a.area);
if ((c === "imperial" || c === "contested") && a.sp >= 5) {
// 敵地にいるなら保持。隣の空いた敵地があれば占領に出る
var empty = targets.filter(function (id) {
return!armiesIn(id, "imp").length && (control(id) === "imperial" || control(id) === "contested");
});
if (empty.length && rng() < 0.5) return { type: "advance", target: empty[0]};
return { type: "defend", target: null};
}
return { type: "defend", target: null};
}

globalThis.Chancellor = {
newGame: newGame,
state: function () { return S;},
pendingEvent: pendingEvent,
chooseEvent: chooseEvent,
availableActions: availableActions,
doAction: doAction,
submitDecisions: submitDecisions,
autoDecisions: autoDecisions,
validTargets: validTargets,
armyLabel: armyLabel,
abilityOf: abilityOf
};
})();

// ---------- ブラウザ UI ----------
(function () {
  if (typeof document === "undefined") return;
  var C = globalThis.Chancellor;
  var D = globalThis.CHANCELLOR_DATA;
  function $(id) { return document.getElementById(id); }
  var selectedArea = "pommern";
  var pendingFunding = {};
  var pendingDirectives = {};
  var builtYear = null;

  function snd(name) {
    try { if (typeof Snd !== "undefined" && Snd[name]) Snd[name](); } catch (e) {}
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function controlLabel(c) {
    return { sweden: "スウェーデン支配", ally: "同盟諸侯", imperial: "皇帝側支配", contested: "係争地", neutral: "中立" }[c] || c;
  }
  function controlColor(c) {
    return { sweden: "#7ea6d8", ally: "#a9c79b", imperial: "#98917e", contested: "#e3ac5c", neutral: "#cfc8b4" }[c] || "#ccc";
  }
  function supplyDots(n) {
    var s = "";
    for (var i = 0; i < 3; i++) s += i < n ? "●" : "○";
    return s;
  }
  function areaYield(S, id) {
    var a = D.AREAS[id];
    if (!a.contribution) return 0;
    var base = a.contribution + (S["areaContribMod_" + id] || 0);
    var c = S.areas[id].control;
    if (c === "sweden") return base;
    if (c === "ally") return Math.floor(base / 2) + (S.flags.heilbronn ? 1 : 0);
    return 0;
  }
  function swArmies(S) { return S.armies.filter(function (a) { return a.alive && a.side === "sw"; }); }

  // ---------- 描画 ----------
  function render() {
    var S = C.state();
    if (!S) return;
    $("year-info").textContent = S.year + "年";
    $("phase-info").textContent =
      S.phase === "decision" ? "意思決定フェイズ" :
      S.phase === "event" ? "報告・評議フェイズ" : "終了";
    $("treasury-info").textContent = "国庫 " + S.treasury;
    renderResources(S);
    renderMap(S);
    renderAreaInfo(S);
    renderReports(S);
    renderEnemy(S);
    renderDecision(S);
    renderLog(S);
    var ev = C.pendingEvent();
    if (ev) showEvent(ev);
    else $("event-overlay").classList.add("hidden");
    if (S.phase === "over") showEnd(S);
  }

  function trackBar(label, v) {
    var color = v >= 50 ? "#5d8a4a" : v >= 25 ? "#c9962e" : "#b03a2e";
    return '<div class="track"><span class="track-label">' + label + '</span>' +
      '<span class="track-bar"><span class="track-fill" style="width:' + v + '%;background:' + color + '"></span></span>' +
      '<span class="track-val">' + v + "</span></div>";
  }
  function renderResources(S) {
    var inc = S.lastIncome || { home: 0, customs: 0, subsidy: 0, contributions: 0, total: 0 };
    var flags = [];
    if (S.flags.heilbronn) flags.push("ハイルブロン同盟");
    if (S.flags.franceAlly) flags.push("フランスと条約");
    if (S.flags.denmarkDefeated) flags.push("デンマーク屈服");
    else if (S.flags.denmarkWar) flags.push("デンマークと交戦中");
    if (S.flags.saxonyDefected) flags.push("ザクセン離反");
    var html = "";
    html += '<p class="res-line">国庫 <strong>' + S.treasury + "</strong>" +
      ' <span class="note">（今年の歳入 ' + inc.total + "：税収" + inc.home + "／関税" + inc.customs +
      "／補助金" + inc.subsidy + "／分担金" + inc.contributions + "）</span></p>";
    html += '<p class="res-line">フランス補助金 年' + (S.subsidyBase + S.subsidyBonus) +
      "（基本" + S.subsidyBase + "＋加算" + S.subsidyBonus + "）／本国税収 年" +
      Math.max(0, D.HOME_TAX + S.homeTaxMod) + "</p>";
    html += trackBar("評議会の信任", S.trust);
    html += trackBar("民心", S.people);
    html += trackBar("諸侯の結束", S.cohesion);
    html += '<p class="res-line">威信 ' + S.prestige +
      (flags.length ? ' <span class="note">／ ' + flags.join("、") + "</span>" : "") + "</p>";
    $("resources").innerHTML = html;
  }

  function renderMap(S) {
    var parts = [];
    parts.push('<svg id="map-svg" viewBox="0 0 100 96" xmlns="http://www.w3.org/2000/svg">');
    var seen = {};
    Object.keys(D.AREAS).forEach(function (id) {
      var a = D.AREAS[id];
      a.links.forEach(function (lid) {
        var key = [id, lid].sort().join("-");
        if (seen[key]) return;
        seen[key] = true;
        var b = D.AREAS[lid];
        parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" class="map-link"/>');
      });
    });
    Object.keys(D.AREAS).forEach(function (id) {
      var a = D.AREAS[id];
      var c = S.areas[id].control;
      if (id === selectedArea) {
        parts.push('<circle cx="' + a.x + '" cy="' + a.y + '" r="7" class="map-sel"/>');
      }
      parts.push('<circle cx="' + a.x + '" cy="' + a.y + '" r="5.2" class="map-node" data-area="' + id +
        '" fill="' + controlColor(c) + '"/>');
      parts.push('<text x="' + a.x + '" y="' + (a.y + 9.8) + '" class="map-label" data-area="' + id + '">' + esc(a.name) + "</text>");
      var y = areaYield(S, id);
      if (y > 0) {
        parts.push('<text x="' + a.x + '" y="' + (a.y + 13.4) + '" class="map-yield" data-area="' + id + '">分担金' + y + "</text>");
      }
      var sw = S.armies.filter(function (x) { return x.alive && x.area === id && x.side === "sw"; });
      var imp = S.armies.filter(function (x) { return x.alive && x.area === id && x.side === "imp"; });
      sw.forEach(function (arm, i) {
        parts.push(chip(a.x - 16.5, a.y - 3.4 + i * 5.6 - (sw.length - 1) * 2.8, arm, "sw"));
      });
      imp.forEach(function (arm, i) {
        parts.push(chip(a.x + 1.5, a.y - 3.4 + i * 5.6 - (imp.length - 1) * 2.8, arm, "imp"));
      });
    });
    parts.push("</svg>");
    $("map").innerHTML = parts.join("");
  }
  function chip(x, y, arm, side) {
    var g = D.GENERALS[arm.key];
    var label = (arm.generalLabel ? "主力軍" : g.short) + " " + arm.sp;
    return '<g class="chip chip-' + side + '" transform="translate(' + x + "," + y + ')">' +
      '<rect width="15" height="4.8" rx="1.2"/><text x="7.5" y="3.6">' + esc(label) + "</text></g>";
  }

  function renderAreaInfo(S) {
    var a = D.AREAS[selectedArea];
    var c = S.areas[selectedArea].control;
    var html = "<strong>" + esc(a.name) + "</strong>（" + controlLabel(c) + "）<br>" + esc(a.desc);
    html += "<br>分担金：支配時" + a.contribution + "（現在 " + areaYield(S, selectedArea) + "）／戦略的価値 " + a.value;
    var here = S.armies.filter(function (x) { return x.alive && x.area === selectedArea; });
    if (here.length) {
      html += "<br>駐留軍：";
      html += here.map(function (x) {
        return (x.side === "sw" ? "自軍 " : "敵軍 ") + esc(C.armyLabel(x)) + "（戦力" + x.sp + "、給養" + x.supply + "）";
      }).join("、");
    }
    $("area-info").innerHTML = html;
  }

  function renderReports(S) {
    var html = S.reports.map(function (r) { return "<p>" + esc(r) + "</p>"; }).join("");
    $("reports").innerHTML = html || "<p>報告はありません。</p>";
  }
  function renderEnemy(S) {
    var list = S.armies.filter(function (a) { return a.alive && a.side === "imp"; });
    if (!list.length) { $("enemy-info").innerHTML = "<p>敵軍の情報はありません。</p>"; return; }
    $("enemy-info").innerHTML = list.map(function (a) {
      return "<p>" + esc(C.armyLabel(a)) + "：" + esc(D.AREAS[a.area].name) +
        "、戦力" + a.sp + "/" + a.maxSP + "、指揮能力" + C.abilityOf(a) + "</p>";
    }).join("");
  }
  function renderLog(S) {
    var el = $("log");
    el.innerHTML = S.log.map(function (l) { return "<p>" + esc(l) + "</p>"; }).join("");
    el.scrollTop = el.scrollHeight;
  }

  // ---------- 意思決定パネル ----------
  function initPending(S) {
    pendingFunding = {};
    pendingDirectives = {};
    var remaining = Math.max(0, S.treasury);
    swArmies(S).forEach(function (a) {
      var alloc = Math.min(a.sp, remaining);
      pendingFunding[a.id] = alloc;
      remaining -= alloc;
      pendingDirectives[a.id] = { type: "defend", target: null };
    });
  }
  function pendingTotal() {
    return Object.keys(pendingFunding).reduce(function (s, k) { return s + (pendingFunding[k] || 0); }, 0);
  }
  function renderDecision(S) {
    var wrap = $("decision-area");
    if (S.phase !== "decision") {
      wrap.innerHTML = S.phase === "over" ? "" :
        '<p class="note">報告と評議への対応が先です（画面のカードで選択してください）。</p>';
      builtYear = null;
      return;
    }
    if (builtYear !== S.year) {
      initPending(S);
      builtYear = S.year;
      buildDecisionPanel(S);
    }
    updateDecisionNumbers(S);
  }
  function buildDecisionPanel(S) {
    var html = "";
    swArmies(S).forEach(function (a) {
      var g = D.GENERALS[a.key];
      var name = a.generalLabel || (g.name + " の軍");
      html += '<div class="army-card" data-army="' + a.id + '">';
      html += '<h3>' + esc(name) + "</h3>";
      html += '<p class="army-meta">' + esc(D.AREAS[a.area].name) + "駐留／戦力 " + a.sp + "/" + a.maxSP +
        "／給養 " + supplyDots(a.supply) + "／指揮能力 " + C.abilityOf(a) +
        (g.traitName ? "／" + g.traitName : "") + "</p>";
      html += '<p class="army-bio note">' + esc(g.bio || "") + "</p>";
      html += '<div class="fund-row">資金配分 <button type="button" class="mini" data-fund="' + a.id + '" data-delta="-2">−2</button>' +
        '<button type="button" class="mini" data-fund="' + a.id + '" data-delta="-1">−1</button>' +
        '<span class="fund-val" id="fund-' + a.id + '">0</span>' +
        '<button type="button" class="mini" data-fund="' + a.id + '" data-delta="1">+1</button>' +
        '<button type="button" class="mini" data-fund="' + a.id + '" data-delta="2">+2</button>' +
        '<span class="note">維持費 ' + a.sp + "（全額で給養+1、超過2ごとに補充+1）</span></div>";
      html += '<div class="dir-row" data-dirgroup="' + a.id + '">';
      [["advance", "進撃"], ["defend", "防衛"], ["forage", "現地調達"], ["return", "本国帰還"]].forEach(function (dt) {
        html += '<button type="button" class="dir-btn" data-dir="' + a.id + '" data-type="' + dt[0] + '">' + dt[1] + "</button>";
      });
      html += "</div>";
      html += '<div class="target-row" id="target-row-' + a.id + '" style="display:none">進撃先：<select data-target="' + a.id + '"></select></div>';
      html += "</div>";
    });
    html += '<div id="actions-list"></div>';
    html += '<p id="decision-msg" class="note"></p>';
    html += '<div class="submit-row"><span id="remaining-funds"></span>' +
      '<button type="button" id="submit-btn">決定を確定し、戦争を解決する</button></div>';
    $("decision-area").innerHTML = html;
    // イベント配線
    $("decision-area").querySelectorAll("[data-fund]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-fund");
        var d = parseInt(btn.getAttribute("data-delta"), 10);
        pendingFunding[id] = Math.max(0, (pendingFunding[id] || 0) + d);
        snd("tap");
        updateDecisionNumbers(C.state());
      });
    });
    $("decision-area").querySelectorAll("[data-dir]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-dir");
        setDirective(id, btn.getAttribute("data-type"));
        snd("tap");
      });
    });
    $("decision-area").querySelectorAll("[data-target]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var id = sel.getAttribute("data-target");
        pendingDirectives[id].target = sel.value;
      });
    });
    $("submit-btn").addEventListener("click", onSubmit);
    swArmies(S).forEach(function (a) { refreshDirUi(a.id); });
    renderActions(S);
  }
  function setDirective(id, type) {
    pendingDirectives[id] = pendingDirectives[id] || { type: "defend", target: null };
    pendingDirectives[id].type = type;
    refreshDirUi(id);
  }
  function refreshDirUi(id) {
    var S = C.state();
    var arm = S.armies.filter(function (x) { return x.id === id; })[0];
    if (!arm) return;
    var dir = pendingDirectives[id] || { type: "defend", target: null };
    document.querySelectorAll('[data-dir="' + id + '"]').forEach(function (btn) {
      btn.classList.toggle("sel", btn.getAttribute("data-type") === dir.type);
    });
    var row = $("target-row-" + id);
    if (!row) return;
    if (dir.type === "advance") {
      row.style.display = "";
      var sel = row.querySelector("select");
      var targets = C.validTargets(arm);
      if (!targets.length) {
        sel.innerHTML = '<option value="">（進撃先なし）</option>';
        dir.target = null;
      } else {
        sel.innerHTML = targets.map(function (t) {
          return '<option value="' + t + '">' + esc(D.AREAS[t].name) + "</option>";
        }).join("");
        if (!dir.target || targets.indexOf(dir.target) < 0) dir.target = targets[0];
        sel.value = dir.target;
      }
    } else {
      row.style.display = "none";
    }
  }
  function updateDecisionNumbers(S) {
    swArmies(S).forEach(function (a) {
      var el = $("fund-" + a.id);
      if (el) el.textContent = pendingFunding[a.id] || 0;
    });
    var rem = $("remaining-funds");
    if (rem) {
      var left = S.treasury - pendingTotal();
      rem.textContent = "配分合計 " + pendingTotal() + "／国庫 " + S.treasury + "（残り " + left + "）";
      rem.style.color = left < 0 ? "#b03a2e" : "";
    }
    var btn = $("submit-btn");
    if (btn) btn.disabled = pendingTotal() > Math.max(0, S.treasury);
  }
  function renderActions(S) {
    var el = $("actions-list");
    if (!el) return;
    var html = "<h3>外交・国内政策</h3>";
    C.availableActions().forEach(function (act) {
      html += '<div class="action-row"><button type="button" class="action-btn" data-action="' + act.id + '"' +
        (act.usable ? "" : " disabled") + ">" + esc(act.name) + "</button>" +
        '<span class="note">' + esc(act.desc) + (act.usable ? "" : "（" + esc(act.reason) + "）") + "</span></div>";
    });
    el.innerHTML = html;
    el.querySelectorAll("[data-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var r = C.doAction(btn.getAttribute("data-action"));
        if (!r.ok) { $("decision-msg").textContent = r.error; return; }
        snd("tap");
        render();
      });
    });
  }
  function onSubmit() {
    var before = C.state();
    var battlesBefore = before.battlesThisYear ? before.battlesThisYear.length : 0;
    var r = C.submitDecisions({ funding: pendingFunding, directives: pendingDirectives });
    if (!r.ok) {
      $("decision-msg").textContent = r.error;
      return;
    }
    var S = C.state();
    if (S.battlesThisYear && S.battlesThisYear.length > battlesBefore) snd("combat");
    else snd("phase");
    builtYear = null;
    render();
  }

  // ---------- イベントモーダル ----------
  function showEvent(ev) {
    $("event-title").textContent = ev.title;
    $("event-text").textContent = ev.text;
    var box = $("event-choices");
    box.innerHTML = "";
    ev.choices.forEach(function (ch, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "event-choice";
      btn.innerHTML = "<strong>" + esc(ch.label) + "</strong>" +
        (ch.desc ? '<span class="note">' + esc(ch.desc) + "</span>" : "");
      btn.addEventListener("click", function () {
        snd("tap");
        C.chooseEvent(i);
        render();
      });
      box.appendChild(btn);
    });
    $("event-overlay").classList.remove("hidden");
  }

  // ---------- 終了画面 ----------
  function showEnd(S) {
    var r = S.result;
    if (!r) return;
    var ov = $("end-overlay");
    if (!ov.classList.contains("hidden")) return;
    if (r.defeat) {
      $("end-title").textContent = "敗北 — " + r.reason + "（" + r.year + "年）";
      $("end-text").innerHTML = esc(r.text) +
        '<p class="note">結果は引き継ぎ用データとして保存されました（敗北）。</p>';
      snd("lose");
    } else {
      var b = r.breakdown;
      $("end-title").textContent = "第1部 終了 — " + r.rank;
      $("end-text").innerHTML =
        "<p><strong>総合評価 " + r.score + "点</strong></p>" +
        "<p>領土・戦略的位置 " + b.territory + "／財政 " + b.treasury + "／軍の温存 " + b.army +
        "／信任 " + b.trust + "／民心 " + b.people + "／結束 " + b.cohesion +
        "／威信 " + b.prestige + "／デンマーク " + b.denmark + "／加減 " + b.bonus + "</p>" +
        r.lines.map(function (l) { return "<p>" + esc(l) + "</p>"; }).join("") +
        '<p class="note">1644年、クリスティーナ女王の親政が始まった。この結果は第2部（1644–48）への引き継ぎ用に保存されました。</p>';
      snd("win");
    }
    ov.classList.remove("hidden");
  }

  // ---------- 初期化 ----------
  function refreshSoundUi() {
    try {
      var on = typeof Snd !== "undefined" && Snd.isOn();
      $("sound-toggle").textContent = on ? "🔊 音オン" : "🔇 音オフ";
      var chk = $("sound-check");
      if (chk) chk.checked = on;
    } catch (e) {}
  }
  document.addEventListener("DOMContentLoaded", function () {
    refreshSoundUi();
    $("sound-toggle").addEventListener("click", function () {
      try { Snd.unlock(); Snd.toggle(); } catch (e) {}
      refreshSoundUi();
    });
    $("map").addEventListener("click", function (e) {
      var t = e.target;
      var id = t && t.getAttribute ? t.getAttribute("data-area") : null;
      if (id) {
        selectedArea = id;
        snd("tap");
        render();
      }
    });
    $("start-game").addEventListener("click", function () {
      try {
        Snd.unlock();
        var chk = $("sound-check");
        if (chk) Snd.setOn(chk.checked);
      } catch (e) {}
      refreshSoundUi();
      $("start-overlay").classList.add("hidden");
      C.newGame((Date.now() % 90000) + 1);
      snd("phase");
      render();
    });
    $("again").addEventListener("click", function () { location.reload(); });
    $("restart").addEventListener("click", function () { location.reload(); });
  });
})();

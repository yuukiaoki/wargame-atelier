// 三十年戦争シナリオ1「スウェーデン参戦 1630–32」データ
// 座標は (col, row)、row 0 が北。ドイツ全域を様式化したマップであり、
// 地理の正確な再現ではない（河川・都市位置は概略）。
// 地形文字: . 平地 / ~ 海（移動不可）
// 河川は RIVERS のヘックス集合で表す（そのヘックスに入ると移動コスト増、
// そのヘックスで防御するとボーナス）。都市・要塞は CITIES で別定義する。
const SCENARIO = {
  id: "thirty-years-war-1630",
  title: "三十年戦争 1630–32 ― スウェーデン参戦",
  cols: 22,
  rows: 15,
  maxTurns: 10,
  // ターン一覧（四半期ターン。第4四半期が冬季）
  quarters: [
    { y: 1630, q: 3 }, { y: 1630, q: 4 },
    { y: 1631, q: 1 }, { y: 1631, q: 2 }, { y: 1631, q: 3 }, { y: 1631, q: 4 },
    { y: 1632, q: 1 }, { y: 1632, q: 2 }, { y: 1632, q: 3 }, { y: 1632, q: 4 }
  ],
  map: [
    "~~~~~~~~~~~~~~~~~~~~~~",
    "~~~~~~................",
    "~~....................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................",
    "......................"
  ],
  // 地方名ラベル（装飾）
  labels: [
    { col: 16, row: 0, text: "バルト海" },
    { col: 1, row: 0, text: "北海" },
    { col: 14, row: 2, text: "ポメラニア" },
    { col: 16, row: 4, text: "ブランデンブルク" },
    { col: 5, row: 5, text: "ヴェストファーレン" },
    { col: 13, row: 9, text: "ザクセン" },
    { col: 7, row: 10, text: "フランケン" },
    { col: 17, row: 11, text: "ボヘミア方面" },
    { col: 9, row: 13, text: "バイエルン" },
    { col: 3, row: 13, text: "シュヴァーベン" }
  ]
};

// 河川ヘックス（"col,row"）。エルベ川・オーデル川・ヴェーザー川・
// ドナウ川・レヒ川・ライン川・マイン川の概略。
const RIVERS = new Set([
  // エルベ川: ドレスデン → マクデブルク → ハンブルク → 河口
  "17,8", "16,7", "15,6", "14,6", "13,6", "12,6", "11,6", "10,5", "9,4", "8,4", "7,3", "6,2", "5,2",
  // オーデル川: シュテッティン → フランクフルト・アン・デア・オーデル → 南東
  "19,3", "19,4", "19,5", "20,6", "21,7",
  // ヴェーザー川（下流はフルダ川）: ブレーメン → カッセル
  "2,3", "3,4", "3,5", "4,6", "4,7",
  // ドナウ川: レーゲンスブルクを東西に貫く
  "9,12", "10,12", "11,12", "12,12", "13,12", "14,13", "15,13",
  // レヒ川: アウクスブルク → ドナウ
  "8,12", "8,13", "8,14",
  // ライン川: マインツ付近
  "1,9", "1,10", "1,11",
  // マイン川: ヴュルツブルク → フランクフルト・アム・マイン
  "6,11", "5,11", "4,10", "3,10", "2,10"
]);

// 都市・要塞。side は初期支配陣営、garrison は守備隊SP。
// fortress: 要塞（防御ボーナス大）。port: 港湾（スウェーデン側の補給源になり得る）。
const CITIES = [
  { id: "stralsund", name: "シュトラールズント", col: 15, row: 1, vp: 3, fortress: true, port: true, side: "sweden", garrison: 3 },
  { id: "stettin", name: "シュテッティン", col: 19, row: 3, vp: 3, fortress: true, port: true, side: "sweden", garrison: 2 },
  { id: "rostock", name: "ロストック", col: 12, row: 1, vp: 2, fortress: false, port: true, side: "imperial", garrison: 2 },
  { id: "lubeck", name: "リューベック", col: 8, row: 2, vp: 3, fortress: false, port: true, side: "imperial", garrison: 2 },
  { id: "hamburg", name: "ハンブルク", col: 6, row: 2, vp: 3, fortress: false, port: true, side: "imperial", garrison: 2 },
  { id: "bremen", name: "ブレーメン", col: 2, row: 3, vp: 2, fortress: false, port: true, side: "imperial", garrison: 2 },
  { id: "frankfurt-oder", name: "フランクフルト・アン・デア・オーデル", col: 19, row: 5, vp: 3, fortress: false, port: false, side: "imperial", garrison: 3 },
  // マクデブルクは皇帝軍に抵抗するプロテスタント都市としてスウェーデン側に置く。
  // 皇帝側に陥落すると「略奪」イベントが発生し、ザクセン参戦の引き金になる。
  { id: "magdeburg", name: "マクデブルク", col: 11, row: 6, vp: 4, fortress: true, port: false, side: "sweden", garrison: 4 },
  { id: "kassel", name: "カッセル", col: 4, row: 7, vp: 2, fortress: false, port: false, side: "imperial", garrison: 2 },
  { id: "leipzig", name: "ライプツィヒ", col: 13, row: 7, vp: 3, fortress: false, port: false, side: "imperial", garrison: 2 },
  { id: "dresden", name: "ドレスデン", col: 17, row: 8, vp: 4, fortress: true, port: false, side: "imperial", garrison: 3 },
  { id: "erfurt", name: "エアフルト", col: 9, row: 8, vp: 2, fortress: false, port: false, side: "imperial", garrison: 2 },
  { id: "wurzburg", name: "ヴュルツブルク", col: 6, row: 11, vp: 2, fortress: false, port: false, side: "imperial", garrison: 2 },
  { id: "frankfurt-main", name: "フランクフルト・アム・マイン", col: 2, row: 10, vp: 3, fortress: false, port: false, side: "imperial", garrison: 2 },
  { id: "mainz", name: "マインツ", col: 1, row: 10, vp: 4, fortress: true, port: false, side: "imperial", garrison: 3 },
  { id: "heidelberg", name: "ハイデルベルク", col: 2, row: 12, vp: 2, fortress: false, port: false, side: "imperial", garrison: 2 },
  { id: "nurnberg", name: "ニュルンベルク", col: 9, row: 11, vp: 4, fortress: true, port: false, side: "imperial", garrison: 3 },
  { id: "regensburg", name: "レーゲンスブルク", col: 12, row: 12, vp: 4, fortress: true, port: false, side: "imperial", garrison: 3 },
  { id: "augsburg", name: "アウクスブルク", col: 8, row: 14, vp: 3, fortress: false, port: false, side: "imperial", garrison: 3 },
  { id: "munchen", name: "ミュンヘン", col: 10, row: 14, vp: 4, fortress: true, port: false, side: "imperial", garrison: 3 }
];

// 軍（リーダー＋戦力ポイントSPのスタック）。
// side: "sweden" | "imperial"（ゲーム上の二大陣営）
// faction: カウンターの色分け（sweden / imperial / bavaria / saxony）
// rating: 指揮能力（移動力ダイスと戦闘修正に使う）
// arrive: 登場ターン（1始まり）。0 なら初期配置。
// event: "saxon" の軍はザクセン参戦イベントで登場する。
// entry: 増援の登場候補ヘックス（先頭から、敵軍のいない場所を使う）
const ARMIES = [
  // ---- スウェーデン軍（1630年6月、ウーゼドム島に上陸しポメラニアに橋頭堡） ----
  { id: "gustavus", side: "sweden", faction: "sweden", name: "グスタフ・アドルフ", short: "グスタフ王", rating: 3, sp: 15, col: 15, row: 1, arrive: 0, king: true },
  { id: "baner", side: "sweden", faction: "sweden", name: "バネール", short: "バネール", rating: 2, sp: 6, col: 16, row: 2, arrive: 0 },
  { id: "horn", side: "sweden", faction: "sweden", name: "ホルン", short: "ホルン", rating: 1, sp: 7, col: 19, row: 3, arrive: 0 },
  { id: "knyphausen", side: "sweden", faction: "sweden", name: "クニップハウゼン", short: "クニップハウゼン", rating: 1, sp: 4, col: 18, row: 4, arrive: 0 },
  { id: "tott", side: "sweden", faction: "sweden", name: "トット", short: "トット", rating: 1, sp: 6, col: 11, row: 2, arrive: 0 },
  // ---- 皇帝・カトリック同盟軍 ----
  { id: "tilly", side: "imperial", faction: "imperial", name: "ティリー", short: "ティリー", rating: 2, sp: 13, col: 9, row: 8, arrive: 0 },
  { id: "pappenheim", side: "imperial", faction: "imperial", name: "パッペンハイム", short: "パッペンハイム", rating: 2, sp: 7, col: 10, row: 5, arrive: 0 },
  { id: "maximilian", side: "imperial", faction: "bavaria", name: "マクシミリアン（バイエルン軍）", short: "マクシミリアン", rating: 1, sp: 9, col: 10, row: 14, arrive: 0 },
  // ---- 増援・イベント ----
  { id: "bernhard", side: "sweden", faction: "sweden", name: "ザクセン＝ヴァイマル公ベルンハルト", short: "ベルンハルト", rating: 2, sp: 7, col: 12, row: 1, arrive: 5, entry: [[12, 1], [15, 1], [19, 3]] },
  { id: "arnim", side: "sweden", faction: "saxony", name: "アルニム（ザクセン軍）", short: "アルニム", rating: 1, sp: 8, col: 17, row: 8, arrive: 0, event: "saxon", entry: [[17, 8], [13, 7], [15, 1]] },
  { id: "gallas", side: "imperial", faction: "imperial", name: "ガラス", short: "ガラス", rating: 1, sp: 6, col: 12, row: 12, arrive: 5, entry: [[12, 12], [10, 14], [15, 13]] },
  { id: "wallenstein", side: "imperial", faction: "imperial", name: "ヴァレンシュタイン", short: "ヴァレンシュタイン", rating: 3, sp: 14, col: 15, row: 13, arrive: 8, entry: [[15, 13], [14, 13], [12, 12]] }
];

// 地形定義（ベース地形のみ。河川・都市は別レイヤー）
const TERRAIN = {
  ".": { name: "平地", cost: 1, color: "#cfd2a0" },
  "~": { name: "海", cost: Infinity, color: "#7fa8c9" }
};

// 陣営カラー（カウンター描画用）
const FACTIONS = {
  sweden: { name: "スウェーデン軍", body: "#1d4e89", band: "#f2c230", text: "#ffffff" },
  imperial: { name: "皇帝軍", body: "#2e2a26", band: "#c9a227", text: "#ffffff" },
  bavaria: { name: "バイエルン軍", body: "#5b84ae", band: "#eef2f5", text: "#ffffff" },
  saxony: { name: "ザクセン軍", body: "#2e7d4f", band: "#eef2f5", text: "#ffffff" }
};

// 桶狭間シナリオデータ
// 地形文字: . 平地 / r 街道 / h 丘陵 / w 林 / v 狭間（谷） / f 砦 / C 城
// 座標は (col, row)、row 0 が北。様式化したマップであり、実地形の正確な再現ではない。
const SCENARIO = {
  id: "okehazama-1560",
  title: "桶狭間 1560",
  maxTurns: 8,
  cols: 14,
  rows: 11,
  map: [
    "..............",
    ".f.hh.w..r....",
    "...hhh...r..w.",
    "..w.hh..r.....",
    ".....vvr...hC.",
    "....vvvr......",
    ".....v.r.w....",
    "..w...r.......",
    "....r....f....",
    "...r...w...f..",
    ".............."
  ],
  // 地名ラベル {col,row,text}
  labels: [
    { col: 1, row: 1, text: "善照寺砦" },
    { col: 4, row: 2, text: "太子ヶ根" },
    { col: 6, row: 5, text: "田楽狭間" },
    { col: 12, row: 4, text: "大高城" },
    { col: 9, row: 8, text: "丸根砦" },
    { col: 11, row: 9, text: "鷲津砦" }
  ],
  // side: "oda" | "imagawa"
  // guard: 本陣警固（移動しない）。hq: 本陣ユニット（壊滅で即時決着）
  units: [
    // 織田軍（善照寺〜太子ヶ根に結集）
    { id: "nobunaga", side: "oda", name: "織田信長 本隊", short: "信長", str: 6, mp: 10, col: 4, row: 2, hq: true },
    { id: "shibata", side: "oda", name: "柴田勝家隊", short: "柴田", str: 4, mp: 8, col: 3, row: 2 },
    { id: "sassa", side: "oda", name: "佐々成政隊", short: "佐々", str: 3, mp: 8, col: 5, row: 2 },
    { id: "maeda", side: "oda", name: "前田利家隊", short: "前田", str: 3, mp: 8, col: 4, row: 3 },
    { id: "kawajiri", side: "oda", name: "河尻秀隆隊", short: "河尻", str: 3, mp: 8, col: 3, row: 3 },
    { id: "zenshoji", side: "oda", name: "善照寺守備隊", short: "守備", str: 2, mp: 6, col: 1, row: 1 },
    // 今川軍（本陣は田楽狭間、諸隊は分散）
    { id: "yoshimoto", side: "imagawa", name: "今川義元 本陣", short: "義元", str: 5, mp: 6, col: 6, row: 5, hq: true, guard: true },
    { id: "guard-a", side: "imagawa", name: "本陣警固隊（西）", short: "警固", str: 5, mp: 8, col: 5, row: 5, guard: true },
    { id: "guard-b", side: "imagawa", name: "本陣警固隊（北）", short: "警固", str: 4, mp: 8, col: 6, row: 4, guard: true },
    { id: "vanguard", side: "imagawa", name: "今川先鋒隊", short: "先鋒", str: 5, mp: 8, col: 8, row: 2 },
    { id: "asahina", side: "imagawa", name: "朝比奈泰勝隊", short: "朝比奈", str: 4, mp: 8, col: 12, row: 4 },
    { id: "motoyasu", side: "imagawa", name: "松平元康隊", short: "元康", str: 4, mp: 8, col: 11, row: 5 },
    { id: "okabe", side: "imagawa", name: "岡部元信隊（丸根）", short: "岡部", str: 4, mp: 8, col: 9, row: 8 },
    { id: "washizu", side: "imagawa", name: "鷲津占領隊", short: "鷲津", str: 3, mp: 8, col: 11, row: 9 }
  ]
};

// 地形定義: cost は移動コスト（MP制、平地=2を基準に2倍スケール）, def は防御側の戦力ボーナス
const TERRAIN = {
  ".": { name: "平地", cost: 2, def: 0, color: "#dcc98f" },
  "r": { name: "街道", cost: 1, def: 0, color: "#e8d9a8" },
  "h": { name: "丘陵", cost: 3, def: 1, color: "#b08954" },
  "w": { name: "林", cost: 3, def: 1, color: "#6a8f5a" },
  "v": { name: "狭間", cost: 4, def: 1, color: "#96865f" },
  "f": { name: "砦", cost: 2, def: 1, color: "#cbb98d" },
  "C": { name: "城", cost: 2, def: 1, color: "#cbb98d" }
};

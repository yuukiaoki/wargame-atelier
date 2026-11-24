// 『宰相』第1部（1632–44）— シナリオデータ
// エリア・将軍・初期配置・イベントの定義。数値はすべてゲーム用に自前で設定した抽象化。
// 効果（effects）の語彙は game.js の applyEffects が解釈する:
//   treasury / trust（評議会の信任）/ people（民心）/ cohesion（諸侯の結束）/
//   prestige（威信）/ scoreBonus（最終評価への加減）/ homeTaxMod（本国税収の恒常修正）/
//   subsidyBaseSet（補助金の基本額を設定）/ subsidyBonus（補助金の加算、0..4）/
//   copperMod（翌年の関税収入への一回限りの修正）/ flag（フラグを立てる）/
//   areaContributionMod（エリアの分担金の恒常修正）/ custom（game.js 側の個別処理名）
(function () {
  "use strict";

  // ---------- エリア（ポイント・トゥ・ポイント） ----------
  // x, y は SVG ビューボックス（0..100 × 0..96）の座標。
  // contribution: スウェーデン支配時の分担金（同盟エリアは半額＋同盟補正）。
  // value: 最終評価の戦略的価値。
  var AREAS = {
    sweden:       { name: "スウェーデン本国", x: 47, y: 6,  links: ["pommern", "denmark"], contribution: 0, value: 0, control: "sweden", home: true,
                    desc: "本国。税収と新兵の源泉。ここ自体が戦場になることはない。" },
    denmark:      { name: "デンマーク", x: 22, y: 17, links: ["sweden", "pommern", "westfalen"], contribution: 3, value: 2, control: "neutral",
                    desc: "クリスチャン4世のデンマーク。背後の脅威。開戦前は進入できない。" },
    pommern:      { name: "ポンメルン", x: 56, y: 20, links: ["sweden", "denmark", "westfalen", "brandenburg"], contribution: 4, value: 3, control: "sweden",
                    desc: "バルト海南岸の橋頭堡。本国とドイツを結ぶ生命線。" },
    westfalen:    { name: "ヴェストファーレン", x: 18, y: 40, links: ["denmark", "pommern", "brandenburg", "saxony", "southgermany", "rhine"], contribution: 3, value: 2, control: "imperial",
                    desc: "北西ドイツ。デンマーク方面とライン方面への結節点。" },
    brandenburg:  { name: "ブランデンブルク", x: 56, y: 38, links: ["pommern", "westfalen", "saxony", "bohemia"], contribution: 3, value: 2, control: "ally",
                    desc: "選帝侯領。同盟諸侯だが立場は揺れやすい。" },
    saxony:       { name: "ザクセン", x: 61, y: 55, links: ["westfalen", "brandenburg", "bohemia", "southgermany"], contribution: 4, value: 3, control: "ally",
                    desc: "選帝侯領。1635年のプラハ条約で皇帝側へ離反する。" },
    rhine:        { name: "ライン方面", x: 13, y: 61, links: ["westfalen", "southgermany", "bavaria"], contribution: 4, value: 2, control: "imperial",
                    desc: "プファルツとラインラント。フランスとの共同作戦の舞台。" },
    southgermany: { name: "南ドイツ", x: 36, y: 66, links: ["westfalen", "saxony", "bohemia", "bavaria", "rhine"], contribution: 4, value: 2, control: "contested",
                    desc: "フランケン・シュヴァーベン。同盟諸侯の地であり、激戦地。" },
    bohemia:      { name: "ボヘミア", x: 77, y: 60, links: ["brandenburg", "saxony", "southgermany", "bavaria"], contribution: 5, value: 3, control: "imperial",
                    desc: "皇帝の世襲領。富裕で、皇帝軍の根拠地。" },
    bavaria:      { name: "バイエルン", x: 50, y: 85, links: ["bohemia", "southgermany", "rhine"], contribution: 5, value: 3, control: "imperial",
                    desc: "カトリック同盟の盟主バイエルン選帝侯の本拠。" }
  };

  // ---------- 将軍 ----------
  // ability: 指揮能力（会戦の実効戦力に加算）。trait: fast=2エリア進撃可, aggressive=報告で強く要求, steady=特記なし。
  // aggression（皇帝側）: 攻勢に出る性向 0..1。
  var GENERALS = {
    baner:       { name: "ヨハン・バネール", short: "バネール", ability: 3, trait: "aggressive", traitName: "積極的",
                   bio: "王の死後、ドイツにおけるスウェーデン軍の主柱。攻勢に熱心で、支給が滞れば強く抗議する。" },
    horn:        { name: "グスタフ・ホルン", short: "ホルン", ability: 2, trait: "steady", traitName: "堅実",
                   bio: "南ドイツで同盟軍とともに戦う老練な将軍。1634年、ネルドリンゲンで運命の会戦を迎える。" },
    torstensson: { name: "レンナート・トルステンソン", short: "トルステンソン", ability: 3, trait: "fast", traitName: "疾風",
                   bio: "痛風に苦しみながらも電撃的な進軍で知られる砲兵出身の将軍。バネールの後継候補。" },
    wrangel:     { name: "カール・グスタフ・ヴランゲル", short: "ヴランゲル", ability: 2, trait: "steady", traitName: "堅実",
                   bio: "ポンメルン方面を固める将軍。1643年に独立した軍を与えられる。" },
    koenigsmarck:{ name: "ハンス・クリストフ・フォン・ケーニヒスマルク", short: "ケーニヒスマルク", ability: 2, trait: "fast", traitName: "疾風",
                   bio: "騎兵を率いて敵地を疾駆する襲撃の名手。1641年に到着する。" },
    gallas:      { name: "マティアス・ガラス", short: "ガラス", ability: 2, aggression: 0.55,
                   bio: "皇帝軍の主力指揮官。慎重だが、好機と見れば南ドイツから北上する。" },
    hatzfeld:    { name: "メルヒオール・フォン・ハッツフェルト", short: "ハッツフェルト", ability: 2, aggression: 0.7,
                   bio: "ヴェストファーレンを根拠地とする皇帝軍の将軍。攻勢的。" },
    bavarian:    { name: "バイエルン軍", short: "バイエルン軍", ability: 1, aggression: 0.45,
                   bio: "バイエルン選帝侯の軍。本拠の防衛を優先する。1643年から名将メルシーが指揮する。" },
    piccolomini: { name: "オッターヴィオ・ピッコローミニ", short: "ピッコローミニ", ability: 2, aggression: 0.65,
                   bio: "1635年、ライン方面に現れる皇帝・スペイン系の軍の指揮官。" },
    saxon:       { name: "ザクセン軍", short: "ザクセン軍", ability: 1, aggression: 0.5,
                   bio: "プラハ条約で皇帝側に帰ったザクセン選帝侯の軍。" },
    danish:      { name: "デンマーク軍", short: "デンマーク軍", ability: 1, aggression: 0.4,
                   bio: "クリスチャン4世の軍。本国を守る構え。" }
  };

  // ---------- 初期配置 ----------
  var INITIAL_ARMIES = [
    { key: "baner",    side: "sw",  area: "pommern",      sp: 8, maxSP: 10, supply: 2 },
    { key: "horn",     side: "sw",  area: "southgermany", sp: 6, maxSP: 8,  supply: 2 },
    { key: "gallas",   side: "imp", area: "bohemia",      sp: 8, maxSP: 10, supply: 2 },
    { key: "hatzfeld", side: "imp", area: "westfalen",    sp: 6, maxSP: 8,  supply: 2 },
    { key: "bavarian", side: "imp", area: "bavaria",      sp: 7, maxSP: 9,  supply: 2 }
  ];

  // ---------- 増援（年開始時に登場） ----------
  var SPAWNS = [
    { year: 1635, key: "piccolomini", side: "imp", area: "rhine",     sp: 5, maxSP: 7, supply: 2, note: "ピッコローミニの軍がライン方面に現れた。" },
    { year: 1641, key: "koenigsmarck", side: "sw", area: "westfalen", sp: 3, maxSP: 5, supply: 2, note: "ケーニヒスマルクの騎兵軍がヴェストファーレンに到着した。" },
    { year: 1643, key: "wrangel",     side: "sw",  area: "pommern",   sp: 4, maxSP: 7, supply: 2, note: "ヴランゲルに独立した軍が与えられ、ポンメルンに配置された。" }
  ];

  // ---------- 史実イベント（背骨） ----------
  // timing: "start"（年開始・意思決定前）/ "end"（年末）。choices が1つだけのものは「報せ」として表示する。
  var SCRIPTED_EVENTS = [
    {
      id: "heilbronn", year: 1633, timing: "start",
      title: "ハイルブロン同盟",
      text: "南ドイツのプロテスタント諸侯と諸都市が、スウェーデンの保護のもとに同盟を結ぼうとしている。同盟が成れば分担金の徴収は円滑になるが、維持費と諸侯への配慮が宰相の肩にのしかかる。",
      choices: [
        { label: "同盟を結成する", desc: "諸侯の結束+15、同盟エリアの分担金+1。ただし毎年、維持費3がかかる。",
          effects: { cohesion: 15, flag: "heilbronn" } },
        { label: "結成を見送る", desc: "諸侯の結束−10。維持費はかからない。",
          effects: { cohesion: -10 } }
      ]
    },
    {
      id: "nordlingen-warning", year: 1634, timing: "start",
      title: "南ドイツの緊張",
      text: "皇帝軍とバイエルン軍が南ドイツに集結しつつある。ホルンの軍は単独で敵に接しており、大きな圧力を受けそうだ。今年、南ドイツ方面の会戦では皇帝側が勢いづく（皇帝側+1）。ホルンが大敗すれば、捕虜になる恐れがある。",
      choices: [
        { label: "了解した", desc: "ホルン軍への配分と配置に注意すること。", effects: {} }
      ]
    },
    {
      id: "prague", year: 1635, timing: "start",
      title: "プラハ条約 — ザクセンの離反",
      text: "皇帝とザクセン選帝侯がプラハで和約を結んだ。ザクセンは皇帝側に帰り、スウェーデンと戦う構えを見せている。ドイツ諸侯の結束は大きく揺らぐ。",
      choices: [
        { label: "現実を受け入れる", desc: "諸侯の結束−15。ザクセンは皇帝側へ移り、ザクセン軍が現れる。",
          effects: { cohesion: -15, custom: "saxonyDefectNow" } },
        { label: "最後の譲歩で引き留める", desc: "国庫−10、諸侯の結束−5。離反を1年遅らせることができる。",
          effects: { treasury: -10, cohesion: -5, flag: "saxonyDelay" } }
      ]
    },
    {
      id: "saxony-final", year: 1636, timing: "start", requiresFlag: "saxonyDelay", forbidsFlag: "saxonyDefected",
      title: "ザクセンの最終離反",
      text: "譲歩の効力も尽き、ザクセン選帝侯はついに皇帝とのプラハ条約に加わった。ザクセンは皇帝側へ移る。",
      choices: [
        { label: "受け入れる", desc: "ザクセンは皇帝側へ。ザクセン軍が現れる。",
          effects: { custom: "saxonyDefectNow" } }
      ]
    },
    {
      id: "compiegne", year: 1635, timing: "start",
      title: "フランス参戦 — コンピエーニュ条約",
      text: "フランスが対ハプスブルク参戦を決め、スウェーデンとの条約を更新する。補助金は増えるが、ライン方面での共同作戦への期待が重くなる。",
      choices: [
        { label: "条約を締結する", desc: "補助金が年7に増額。ライン方面・南ドイツでの会戦で自軍+1。",
          effects: { subsidyBaseSet: 7, flag: "franceAlly" } },
        { label: "現行の補助金で押し通す", desc: "補助金は年4のまま。評議会の信任+4。",
          effects: { trust: 4 } }
      ]
    },
    {
      id: "pommern-succession", year: 1637, timing: "start",
      title: "ポンメルン公の死",
      text: "ポンメルン公ボギスラフ14世が嗣子なく死去した。ブランデンブルク選帝侯が継承権を主張し、ポンメルンの帰属が争点になっている。",
      choices: [
        { label: "全域の確保を主張する", desc: "諸侯の結束−8、威信+1。分担金は現行どおり。",
          effects: { cohesion: -8, prestige: 1 } },
        { label: "ブランデンブルクと分割する", desc: "諸侯の結束+6。ポンメルンの分担金−2。",
          effects: { cohesion: 6, areaContributionMod: { pommern: -2 } } }
      ]
    },
    {
      id: "riksdag-pressure", year: 1640, timing: "start",
      title: "議会と財政の圧力",
      text: "長引く戦争に、本国の議会と農民身分から負担軽減の声が強まっている。評議会でも財政の持続可能性が問われ始めた。",
      choices: [
        { label: "負担軽減を約束する", desc: "国庫−5、民心+8。",
          effects: { treasury: -5, people: 8 } },
        { label: "軍事優先を通す", desc: "国庫+4（強制公債）、民心−5、評議会の信任−5。",
          effects: { treasury: 4, people: -5, trust: -5 } }
      ]
    },
    {
      id: "baner-death", year: 1641, timing: "start", requiresArmy: "baner",
      title: "バネールの死",
      text: "主力軍の指揮官ヨハン・バネールがハルバーシュタットで病死した。軍は動揺し、後任の人選が急務である。候補は、若く俊足で知られるレンナート・トルステンソン。",
      choices: [
        { label: "トルステンソンを招聘する", desc: "国庫−6（招聘・着任の費用）。主力軍は指揮能力を維持する。",
          effects: { treasury: -6, custom: "successionA" } },
        { label: "副将に暫定指揮を委ねる", desc: "費用はかからないが、主力軍は戦力−1・指揮能力が落ちる。1642年にトルステンソンが到着する。",
          effects: { custom: "successionB" } }
      ]
    },
    {
      id: "torstensson-arrival", year: 1642, timing: "start", requiresFlag: "successionInternal",
      title: "トルステンソンの到着",
      text: "レンナート・トルステンソンが主力軍の指揮に着任した。電撃的な進軍で知られる将軍のもと、軍の能力が回復する。",
      choices: [
        { label: "歓迎する", desc: "主力軍の指揮能力が回復する。",
          effects: { custom: "successionArrive" } }
      ]
    },
    {
      id: "denmark-question", year: 1643, timing: "start",
      title: "デンマーク問題",
      text: "デンマーク王クリスチャン4世が、スウェーデンの背後で動きを強めている。放置すれば本国とドイツを結ぶ補給線が脅かされる。主力軍を北へ振り向け、皇帝軍の追撃をかわしてデンマークを叩く案が、宰相の机上にある。",
      choices: [
        { label: "主力軍を北転させる", desc: "主力軍はヴェストファーレンへ移動し、デンマークと開戦する。デンマークへ進撃できるようになる。",
          effects: { custom: "denmarkAttack" } },
        { label: "対皇帝戦に専念する", desc: "デンマークの脅威は残り、翌年に沿岸防衛の負担が生じる。",
          effects: { custom: "denmarkIgnore" } }
      ]
    },
    {
      id: "denmark-threat", year: 1644, timing: "start", requiresFlag: "denmarkThreat",
      title: "デンマークの圧力",
      text: "デンマーク海軍の示威行動が続き、沿岸防衛と輸送船団の護衛に費用がかさんだ。本国の不安も高まっている。",
      choices: [
        { label: "対応する", desc: "国庫−6、民心−3。",
          effects: { treasury: -6, people: -3 } }
      ]
    },
    {
      id: "christina", year: 1644, timing: "end",
      title: "クリスティーナ女王の親政",
      text: "1644年12月、クリスティーナ女王が成年に達し、親政を開始した。後見政府は終わり、宰相は今後、女王の信任のもとで仕える立場になる。この12年の統治がどう評価されるかは、女王の目にも映っている。",
      choices: [
        { label: "女王を支える助言者となる", desc: "最終評価+2。",
          effects: { scoreBonus: 2 } },
        { label: "宰相の権限の維持を図る", desc: "評議会の信任−10。そのうえで信任が60以上あれば押し切り評価+2、そうでなければ評価−4。",
          effects: { trust: -10, custom: "christinaB" } }
      ]
    }
  ];

  // ---------- ランダムイベント（年末、確率で1件） ----------
  var RANDOM_EVENTS = [
    {
      id: "harvest", title: "凶作の報せ",
      text: "本国で凶作の報せが届いた。備蓄の放出を求める声が上がっている。",
      choices: [
        { label: "備蓄を放出する", desc: "国庫−6、民心+2。", effects: { treasury: -6, people: 2 } },
        { label: "耐えてもらう", desc: "民心−8。", effects: { people: -8 } }
      ]
    },
    {
      id: "copper-up", title: "銅価格の上昇",
      text: "ファールンの銅が国際市場で値上がりし、臨時の収入があった。",
      choices: [
        { label: "受け取る", desc: "国庫+5。", effects: { treasury: 5 } }
      ]
    },
    {
      id: "copper-down", title: "銅価格の下落",
      text: "銅価格が下落した。来年の関税収入が目減りしそうだ。",
      choices: [
        { label: "やむなし", desc: "来年の関税収入−3。", effects: { copperMod: -3 } }
      ]
    },
    {
      id: "triumph", title: "凱旋の報せ", when: "wonBattle",
      text: "前線からの勝利の報せに、ストックホルムは沸いた。宰相の指導への評価が高まっている。",
      choices: [
        { label: "喜ぶ", desc: "威信+1、評議会の信任+3。", effects: { prestige: 1, trust: 3 } }
      ]
    },
    {
      id: "plague", title: "疫病の流行",
      text: "軍営に疫病が広がり、ドイツのある軍が兵を減らした。",
      choices: [
        { label: "対応する", desc: "ドイツ駐留のいずれかの軍が戦力−1。", effects: { custom: "plagueHit" } }
      ]
    },
    {
      id: "france-pressure", title: "フランスの督促",
      text: "フランス大使が、ライン方面での作戦の強化を求めてきた。補助金の出し手の言葉は重い。",
      choices: [
        { label: "ライン方面への作戦を約束する", desc: "評議会の信任+2。ただし翌年末、ライン方面に自軍がいなければ信任−5。",
          effects: { trust: 2, flag: "francePromise" } },
        { label: "婉曲に断る", desc: "補助金の加算が1減る（加算がなければ信任−2）。",
          effects: { custom: "franceRefuse" } }
      ]
    },
    {
      id: "princes-rumour", title: "諸侯離反の噂",
      text: "同盟諸侯のあいだに、皇帝との単独講和を模索する動きがあるという噂が流れている。",
      choices: [
        { label: "譲歩して引き留める", desc: "国庫−5、諸侯の結束+8。", effects: { treasury: -5, cohesion: 8 } },
        { label: "放置する", desc: "諸侯の結束−6。", effects: { cohesion: -6 } }
      ]
    },
    {
      id: "petition", title: "農民の陳情",
      text: "本国の農民身分の代表が、徴兵と課税の負担について陳情に訪れた。",
      choices: [
        { label: "受け入れる", desc: "国庫−3、民心+6。", effects: { treasury: -3, people: 6 } },
        { label: "却下する", desc: "民心−5。", effects: { people: -5 } }
      ]
    },
    {
      id: "enemy-death", title: "敵将の病死",
      text: "皇帝側のある将軍が病没し、その軍が弱体化したという報せが届いた。",
      choices: [
        { label: "好機である", desc: "皇帝側のいずれかの軍が戦力−2。", effects: { custom: "enemyDeathHit" } }
      ]
    }
  ];

  globalThis.CHANCELLOR_DATA = {
    AREAS: AREAS,
    GENERALS: GENERALS,
    INITIAL_ARMIES: INITIAL_ARMIES,
    SPAWNS: SPAWNS,
    SCRIPTED_EVENTS: SCRIPTED_EVENTS,
    RANDOM_EVENTS: RANDOM_EVENTS,
    START_YEAR: 1633,
    END_YEAR: 1644,
    START_TREASURY: 30,
    START_TRUST: 70,
    START_PEOPLE: 60,
    START_COHESION: 55,
    HOME_TAX: 12,
    CUSTOMS: 5,
    START_SUBSIDY_BASE: 4
  };
})();

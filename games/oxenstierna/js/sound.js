// 宰相（オクセンシェルナ） — 効果音エンジン
// Web Audio API で全ての音を手続き的に合成する（音声ファイル等の外部素材は一切なし）。
// 方針:
// - AudioContext は最初のユーザー操作（pointerdown／開始ボタン）で生成・resume する。
// - 音が出なくてもゲームが止まらないよう、全処理を try/catch で防御する。
//   AudioContext が無い環境では全関数が無音で何もしない。
// - ミュート状態は localStorage に保存する（キー: okehazama1560.sound、"1"=オン）。
(function () {
  "use strict";

  var LS_KEY = "okehazama1560.sound";
  var on = true;
  try {
    var saved = localStorage.getItem(LS_KEY);
    if (saved === "0") on = false;
  } catch (e) { /* 保存が読めなくても既定（オン）で続行 */ }

  var ctx = null;      // AudioContext
  var master = null;   // マスターゲイン（ミュートはここを 0 にする）
  var noiseBuf = null; // ノイズバッファ（使い回し）
  var rainGain = null; // 雨音ループのゲイン（ノードは一度だけ作る）
  var rainWanted = false;

  var MASTER_VOL = 0.85; // スマホのスピーカーでも聞き取れる水準に（2026-11-24 引き上げ）

  // ---------- 基盤 ----------
  function ensureCtx() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = on ? MASTER_VOL : 0;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
      master = null;
    }
    return ctx;
  }
  // ユーザー操作のタイミングで呼ぶ。生成と resume、雨ノードの用意まで行う。
  function unlock() {
    try {
      // iOS 17+: オーディオセッションを「再生（playback）」にすると、
      // マナーモード（消音スイッチ）でも Web Audio が鳴るようになる。
      try {
        if (typeof navigator !== "undefined" && navigator.audioSession) {
          navigator.audioSession.type = "playback";
        }
      } catch (e) { /* 非対応環境では何もしない */ }
      var c = ensureCtx();
      if (!c) return;
      if (c.state === "suspended") {
        var p = c.resume();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
      // 古い iOS 向けの確実な解放策：ジェスチャの中で無音バッファを一度再生する。
      try {
        var silent = c.createBuffer(1, 1, c.sampleRate);
        var ss = c.createBufferSource();
        ss.buffer = silent;
        ss.connect(c.destination);
        ss.start(0);
      } catch (e) { /* 失敗しても続行 */ }
      ensureRain();
      applyRain();
    } catch (e) { /* 音響の失敗は無視する */ }
  }
  // 音を鳴らせる状態か（オン、かつ AudioContext が作れるか）
  function ready() {
    if (!on) return false;
    try {
      if (!ensureCtx()) return false;
      if (ctx.state === "suspended") unlock();
      return true;
    } catch (e) {
      return false;
    }
  }
  function getNoise() {
    if (noiseBuf) return noiseBuf;
    var len = Math.floor(ctx.sampleRate * 1.2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // ---------- 合成の部品 ----------
  // フィルタを通したノイズの短い打撃（木片・ダイス・刀の金属音などの素）
  function noiseHit(t, dur, type, freq, q, vol) {
    var src = ctx.createBufferSource();
    src.buffer = getNoise();
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    var g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
  // 減衰する単音（太鼓の胴鳴り、撥弦の胴など）
  function tone(t, type, f0, f1, dur, vol) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  // 太鼓の一打（胴鳴りのピッチダウン＋皮のノイズ）
  function drum(t, vol, base) {
    tone(t, "sine", base || 150, 52, 0.28, vol);
    noiseHit(t, 0.09, "lowpass", 500, 0.7, vol * 0.5);
  }
  // 小鼓（触れ太鼓用。軽く短く）
  function miniDrum(t, vol) {
    tone(t, "sine", 235, 95, 0.13, vol);
    noiseHit(t, 0.05, "lowpass", 900, 0.7, vol * 0.6);
  }
  // 筝ふうの撥弦（三角波＋倍音、短い減衰）
  function pluck(t, freq, vol) {
    tone(t, "triangle", freq, freq, 0.5, vol);
    tone(t, "sine", freq * 2, freq * 2, 0.22, vol * 0.35);
  }

  // ---------- 個別の音 ----------
  // UI操作：木片のような短いタップ
  function tap() {
    try {
      if (!ready()) return;
      var t = ctx.currentTime;
      noiseHit(t, 0.06, "bandpass", 1700, 6, 0.20);
      tone(t, "square", 840, 620, 0.045, 0.05);
    } catch (e) {}
  }
  // 移動（プレイヤー）：行軍の足音3歩＋衣擦れ
  function move() {
    try {
      if (!ready()) return;
      var t = ctx.currentTime;
      for (var i = 0; i < 3; i++) {
        var tt = t + i * 0.13;
        noiseHit(tt, 0.09, "lowpass", 380, 0.6, 0.16);
        tone(tt, "sine", 95, 60, 0.09, 0.10);
      }
      noiseHit(t + 0.05, 0.3, "bandpass", 900, 1.2, 0.05);
    } catch (e) {}
  }
  // 移動（AI）：ごく弱い足音ひとつ
  function step() {
    try {
      if (!ready()) return;
      var t = ctx.currentTime;
      noiseHit(t, 0.08, "lowpass", 340, 0.6, 0.07);
      tone(t, "sine", 90, 58, 0.08, 0.05);
    } catch (e) {}
  }
  // 戦闘：ダイスを振る音 → 刀の打ち合い＋太鼓の一打
  function combat() {
    try {
      if (!ready()) return;
      var t = ctx.currentTime;
      for (var i = 0; i < 5; i++) {
        noiseHit(t + i * 0.055 + Math.random() * 0.02, 0.04, "bandpass",
          2400 + Math.random() * 800, 5, 0.13);
      }
      var tc = t + 0.34;
      noiseHit(tc, 0.10, "highpass", 3800, 0.7, 0.22);
      var partials = [3150, 4630, 5980];
      for (var j = 0; j < partials.length; j++) {
        tone(tc + j * 0.012, "sine", partials[j], partials[j] * 0.94, 0.16 - j * 0.03, 0.10);
      }
      drum(tc + 0.02, 0.5, 170);
      noiseHit(tc + 0.16, 0.07, "highpass", 4200, 0.7, 0.12); // 鍔迫り合いの二打目
    } catch (e) {}
  }
  // フェイズ／ターン開始の合図：太鼓 二打
  function phase() {
    try {
      if (!ready()) return;
      var t = ctx.currentTime;
      drum(t, 0.45, 150);
      drum(t + 0.22, 0.3, 130);
    } catch (e) {}
  }
  // 警戒変化：触れ太鼓（加速する小鼓の連打）
  function alarm() {
    try {
      if (!ready()) return;
      var tt = ctx.currentTime;
      var gap = 0.11;
      for (var i = 0; i < 9; i++) {
        miniDrum(tt, 0.20 + i * 0.02);
        tt += gap;
        gap *= 0.88;
      }
    } catch (e) {}
  }
  // 勝敗ジングル：五音音階（A C D E G）の撥弦シンセ＋太鼓
  var PENTA = {
    A3: 220.00, C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.00,
    A4: 440.00, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.00
  };
  function win() {
    try {
      if (!ready()) return;
      var t = ctx.currentTime;
      drum(t, 0.5, 160);
      var seq = [PENTA.A4, PENTA.C5, PENTA.D5, PENTA.E5, PENTA.G5, PENTA.A5];
      for (var i = 0; i < seq.length; i++) pluck(t + 0.15 + i * 0.13, seq[i], 0.22);
      drum(t + 0.15 + seq.length * 0.13, 0.4, 150);
    } catch (e) {}
  }
  function lose() {
    try {
      if (!ready()) return;
      var t = ctx.currentTime;
      drum(t, 0.4, 120);
      var seq = [PENTA.E4, PENTA.D4, PENTA.C4, PENTA.A3];
      for (var i = 0; i < seq.length; i++) pluck(t + 0.2 + i * 0.24, seq[i], 0.18);
      tone(t + 1.2, "sine", 110, 55, 0.7, 0.12);
    } catch (e) {}
  }

  // ---------- 雨音（環境音ループ） ----------
  // ノイズ → ローパス（＋ハイパスで低音を落とす）→ ゲイン。
  // ノードは一度だけ作って回し、ゲインのランプで出し入れする。
  function ensureRain() {
    if (rainGain || !ctx) return;
    try {
      var src = ctx.createBufferSource();
      src.buffer = getNoise();
      src.loop = true;
      var lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 640;
      lp.Q.value = 0.4;
      var hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 220;
      rainGain = ctx.createGain();
      rainGain.gain.value = 0;
      src.connect(lp);
      lp.connect(hp);
      hp.connect(rainGain);
      rainGain.connect(master);
      src.start();
      // フィルタ周波数にゆっくりした揺らぎを付け、雨脚の変化らしくする
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13;
      var lg = ctx.createGain();
      lg.gain.value = 90;
      lfo.connect(lg);
      lg.connect(lp.frequency);
      lfo.start();
    } catch (e) {
      rainGain = null;
    }
  }
  function applyRain() {
    if (!rainGain || !ctx) return;
    try {
      rainGain.gain.setTargetAtTime(rainWanted ? 0.05 : 0, ctx.currentTime, 0.6);
    } catch (e) {}
  }
  // 雨を鳴らすべき状態かどうかを毎フレーム受け取る（冪等。変化時だけランプする）
  function syncRain(want) {
    want = !!want;
    if (want === rainWanted && rainGain) return;
    rainWanted = want;
    try {
      if (ctx) {
        ensureRain();
        applyRain();
      }
    } catch (e) {}
  }

  // ---------- オン／オフ ----------
  function setOn(v) {
    on = !!v;
    try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch (e) {}
    try {
      if (master && ctx) master.gain.setTargetAtTime(on ? MASTER_VOL : 0, ctx.currentTime, 0.03);
    } catch (e) {}
  }
  function toggle() {
    setOn(!on);
    return on;
  }
  function isOn() { return on; }

  // 最初のユーザー操作で AudioContext を起こす（スマホの自動再生制限対策）
  try {
    document.addEventListener("pointerdown", function () { unlock(); }, { capture: true, passive: true });
  } catch (e) {}

  globalThis.Snd = {
    unlock: unlock,
    isOn: isOn,
    setOn: setOn,
    toggle: toggle,
    tap: tap,
    move: move,
    step: step,
    combat: combat,
    phase: phase,
    alarm: alarm,
    win: win,
    lose: lose,
    syncRain: syncRain
  };
})();

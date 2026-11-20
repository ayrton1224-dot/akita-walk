"use strict";

const NATIVE = typeof Android !== "undefined";
const WEB = window.AKITA_WEB === true;     // iPhone等のWeb版: 歩数はヘルスケアを見て手入力
const KEY = "akita-walk-v1";
const $ = (id) => document.getElementById(id);

// ---------- ルート(tools/build_route.py で作成)と観光地 ----------
// ゲーム内換算: 実距離 1km = 150歩。到着歩数は実際の道のりから決める。
const STEPS_PER_KM = 150;
SPOTS.forEach((sp, i) => { sp.pre = PRE_NAMES[i]; sp.preArea = sp.pre.replace(/[0-9０-９]+$/, ""); });
for (const sp of SPOTS) {
  const r = ROUTE.spots[sp.id];
  Object.assign(sp, { km: r.km, lat: r.lat, lon: r.lon, elev: Math.round(r.elev), cum: Math.round(r.km * STEPS_PER_KM / 100) * 100 });
}
const fmt = (n) => Math.round(n).toLocaleString("ja-JP");

// ---------- 状態 ----------
// total: 旅の累計歩数 / lastCounter: 前回読んだセンサー値 / history: [時刻, 累計] の履歴
// arrivals: { spotId: { t, from, count, found } } / seen: 到着画面を見た観光地
function freshState() {
  return { total: 0, lastCounter: null, startedAt: Date.now(), history: [[Date.now(), 0]],
           arrivals: {}, seen: {}, mockCounter: 0 };
}
let S = load();
if (!S.ev && S.arrivals && S.arrivals.chokai) S.ev = { done: true, hearts: 0, buddy: false };   // イベント追加前に鳥海山へ着いていた人は、イベントなし
function load() {
  try { return Object.assign(freshState(), JSON.parse(localStorage.getItem(KEY))); }
  catch (e) { return freshState(); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 保存できなくても動く */ } }

// ---------- 歩数の取り込み ----------
function readCounter() {
  return NATIVE ? Android.getStepCounter() : S.mockCounter;
}

function sync() {
  if (WEB) return;                         // Web版は手入力(setDaySteps)で進める
  const c = readCounter();
  if (c < 0) return;                       // センサーからまだ値が来ていない
  if (S.lastCounter === null) {
    S.lastCounter = c;                     // 初回は基準だけ決める
  } else {
    const delta = c >= S.lastCounter ? c - S.lastCounter : c;   // 端末再起動でカウンタが戻った場合
    S.lastCounter = c;
    if (delta > 0) {
      S.total += delta;
      S.history.push([Date.now(), S.total]);
      if (S.history.length > 2000) S.history = S.history.slice(-1000);
    }
  }
  save();
  registerArrivals();
  render();
}

// 到着時刻 = 履歴から「累計が cum に達した時刻」を線形補間で推定
function arrivalTime(cum) {
  const h = S.history;
  for (let i = 1; i < h.length; i++) {
    if (h[i][1] >= cum) {
      const [t0, s0] = h[i - 1], [t1, s1] = h[i];
      return s1 === s0 ? t1 : Math.round(t0 + (t1 - t0) * (cum - s0) / (s1 - s0));
    }
  }
  return Date.now();
}

function registerArrivals() {
  for (const sp of visibleSpots()) {
    if (S.total < sp.cum) break;
    if (!S.arrivals[sp.id]) {
      const t = arrivalTime(sp.cum);
      S.arrivals[sp.id] = { t };
    }
  }
  save();
  showNextArrival();
}

// ---------- 写真 ----------
// 観光地ごとのベスト写真はアプリに同梱(photos/<id>.jpg)。到着したら表示する。
function photoUrl(sp) { return PHOTOS[sp.id] ? "photos/" + sp.id + ".jpg" : ""; }

// ---------- 画面: ガイド・次の目的地 ----------
function nextSpot() { return visibleSpots().find((s) => S.total < s.cum); }

function guideSay() {
  const n = nextSpot();
  const hint = n ? placeHint(n) : "";
  if (!n) return ["right-egao", "ついに秋田一周ゴール! ここまで歩き切ったあなたは最高の旅人だよ。"];
  const vs = visibleSpots();
  const prev = vs[vs.indexOf(n) - 1];
  const remain = n.cum - S.total;
  const leg = n.cum - (prev ? prev.cum : 0);
  const ratio = 1 - remain / leg;
  if (S.total === 0) return ["right-wink", "秋田駅からスタート! まずは" + hint + "を目指して歩こう。写真もたくさん撮ってね。"];
  if (ratio > 0.8) return ["right-odoroki", "もうすぐ" + hint + "! あと" + fmt(remain) + "歩だよ。"];
  const climb = n.elev - MapView.elevAt(currentKm());
  if (ratio > 0.2 && climb > 300) return ["right-komari", "ここからは登りだよ。" + hint + "は標高約" + n.elev + "m。ゆっくり行こう。"];
  if (ratio > 0.2 && climb < -250) return ["right-egao", "下り坂! " + hint + "は標高約" + n.elev + "mだから、歩きやすいよ。"];
  if (ratio > 0.4) return ["right-nattoku", "いい調子! " + hint + "を目指して、あと" + fmt(remain) + "歩だよ。"];
  return ["right-egao", "今日も一歩ずつ。" + hint + "を目指して、あと" + fmt(remain) + "歩。"];
}

function render() {
  $("totalSteps").textContent = fmt(S.total);
  const gc = $("goalCard");
  if (gc) gc.hidden = !S.arrivals[SPOTS[SPOTS.length - 1].id];

  const [pose, text] = guideSay();
  $("guideImg").src = "chara/" + pose + ".svg";
  $("guideText").textContent = text + (hasBuddy() ? "\nたびおじも いっしょに あるいているよ。" : "");
  $("guideBuddy").hidden = !hasBuddy();
  const bd = document.querySelector(".walker .buddy");
  if (bd) bd.hidden = !hasBuddy();

  const n = nextSpot();
  if (n) {
    const vs = visibleSpots();
    const prev = vs[vs.indexOf(n) - 1];
    const base = prev ? prev.cum : 0;
    const pct = Math.min(100, ((S.total - base) / (n.cum - base)) * 100);
    $("nextLabel").textContent = "次の目的地";
    $("nextName").textContent = placeHint(n);
    $("barFill").style.width = pct + "%";
    $("nextRemain").textContent = "あと " + fmt(n.cum - S.total) + " 歩";
    $("nextPct").textContent = Math.floor(pct) + "%";
    const nowE = Math.round(MapView.elevAt(currentKm()));
    $("nextElev").textContent = "いまの標高 約" + nowE + "m → " + placeHint(n) + " 標高 約" + n.elev + "m(あと約" + Math.max(0.1, n.km - currentKm()).toFixed(1) + "km)";
  } else {
    $("nextElev").textContent = "";
    $("nextLabel").textContent = "旅のゴール";
    $("nextName").textContent = "秋田一周 完了!";
    $("barFill").style.width = "100%";
    $("nextRemain").textContent = "";
    $("nextPct").textContent = "100%";
  }
  renderMap();
  renderList();
}

// ---------- 画面: 地図 ----------
function currentKm() { return S.total / STEPS_PER_KM; }

function renderMap() {
  const km = currentKm();
  const n = nextSpot();
  MapView.setSpots(visibleSpots()); Profile.setSpots(visibleSpots());
  MapView.setState(Object.keys(S.arrivals), n ? n.id : null);
  MapView.walkTo(km);
  Profile.draw(km, Object.keys(S.arrivals));
}

// ---------- 画面: リスト ----------
function renderList() {
  const ol = $("list");
  ol.replaceChildren();
  visibleSpots().forEach((sp, i) => {
    const a = S.arrivals[sp.id];
    const li = document.createElement("li");
    li.className = a ? "on" : "off";
    const no = document.createElement("span");
    no.className = "no"; no.textContent = i + 1;
    const meta = document.createElement("div");
    meta.className = "meta";
    const b = document.createElement("b"); b.textContent = a ? sp.name : "？？？";
    const small = document.createElement("small");
    small.textContent = a ? sp.area + "・標高" + sp.elev + "m・" + sp.tag : fmt(sp.cum) + "歩で到着";
    meta.append(b, small);
    li.append(no, meta);
    if (a) {
      const url = photoUrl(sp);
      if (url) { const t = document.createElement("img"); t.className = "thumb"; t.src = url; t.alt = ""; li.append(t); }
      li.addEventListener("click", () => openSpot(sp, false));
    }
    ol.append(li);
  });
}

// ---------- 到着ポップアップ ----------
let current = null;

function showNextArrival() {
  if (current || battleOpen) return;
  const sp = SPOTS.find((s) => S.arrivals[s.id] && !S.seen[s.id]);
  if (eventPending() && (!sp || sp.cum > EVENT_AT)) { startBattle(); return; }     // イベント地点より前の到着を先に見せる
  if (sp) openSpot(sp, true);
}

function openSpot(sp, firstTime) {
  current = sp;
  const goal = sp === SPOTS[SPOTS.length - 1];

  $("mArea").textContent = sp.area;
  $("mName").textContent = sp.name;
  $("mTag").textContent = sp.tag;
  $("mFact").textContent = sp.fact;
  $("modal").hidden = false;
  $("mClose").textContent = firstTime ? (goal ? "旅を終える" : "つぎへ") : "とじる";

  const url = photoUrl(sp);
  $("mPhoto").hidden = !url;
  $("mNoPhoto").hidden = !!url || !!sp.special;
  if (sp.special) {
    $("mSay").textContent = sp.say;
  } else if (url) {
    const ph = PHOTOS[sp.id];
    $("mPhotoImg").src = url;
    $("mCaption").textContent = "ベストショット  " + ph.date + " 撮影 / " + ph.place;
    $("mSay").textContent = firstTime ? "「" + sp.name + "」に到着! 思い出のベストショットだよ。" : "思い出のベストショットだよ。";
  } else {
    $("mNoPhoto").textContent = "この観光地の写真はまだありません。";
    $("mSay").textContent = "「" + sp.name + "」に到着!";
  }
}

$("mClose").addEventListener("click", () => {
  const goal = current && current === SPOTS[SPOTS.length - 1] && !S.seen[current.id];
  if (current) S.seen[current.id] = true;
  save();
  $("modal").hidden = true;
  current = null;
  render();
  if (goal && $("finale")) $("finale").hidden = false;     // ゴール到着の締めくくり(Web版には無い)
  else showNextArrival();
});
if ($("finale")) {
  $("fClose").addEventListener("click", () => { $("finale").hidden = true; showNextArrival(); });
  $("goalOpen").addEventListener("click", () => { $("finale").hidden = false; });
}

// ---------- イベント: 鳥海山の手前で、遭難しているたびおじを見つける ----------
// 鳥海山の2000歩手前で発生。ドラクエ風のコマンド戦闘画面。
//  温める: たびおじにハートが1つつく(3つで仲間になり、山女子と一緒に残りの道を歩く)
//  戦う・逃げる・無視: 「本当にそうしますか?」と聞き、はいを選ぶとイベント終了(仲間にはならない)
const EVENT_AT = SPOTS.find((s) => s.id === "chokai").cum - 2000;
const EV_HEARTS = 3;
const EV_LABEL = { fight: "戦う", flee: "逃げる", warm: "温める", ignore: "無視" };
const EV_END = {          // 3つめのメッセージで、たびおじが言いながら消える
  fight: ["山女子は たびおじに たたかいを いどんだ!", "たびおじ「悲しい～」", "たびおじは そう いいながら きえていった…"],
  flee: ["山女子は にげだした!", "たびおじ「さみしい～」", "たびおじは そう いいながら きえていった…"],
  ignore: ["山女子は たびおじを むしした。", "たびおじ「さみしい～」", "たびおじは そう いいながら きえていった…"],
};
function ev() { return (S.ev = S.ev || { done: false, hearts: 0, buddy: false }); }
function eventPending() { return !ev().done && S.total >= EVENT_AT; }
function hasBuddy() { return !!(S.ev && S.ev.buddy); }

// たびおじが仲間のときだけ、千秋公園の南西約3kmの「行きつけ」(buddyOnly)が観光地に加わる
function visibleSpots() { return SPOTS.filter((sp) => !sp.buddyOnly || hasBuddy()); }
function placeHint(n) { return n.buddyOnly ? n.name : n.preArea + "の名所"; }
Object.assign(SPOTS.find((sp) => sp.id === "ikitsuke"), { special: true, say: "「ここが ぼくの いきつけだよ!」" });

// 温める → ハートが1つつく。3つになったら仲間になってイベント終了
function evWarm() {
  const e = ev();
  e.hearts = Math.min(EV_HEARTS, e.hearts + 1);
  const msgs = ["山女子は たびおじを あたためた!", "たびおじに ハートが ひとつ ついた!"];
  if (e.hearts >= EV_HEARTS) {
    e.done = true; e.buddy = true;
    msgs.push("たびおじは げんきを とりもどした!", "たびおじが なかまに なった!", "「いっしょに あるこう!」\nここから ふたりで のこりの みちを あるきます。");
  }
  save();
  return { msgs, end: e.done };
}
// 戦う・逃げる・無視 を「はい」で決めた場合 → イベント終了(仲間にはならない)
function evGiveUp(cmd) {
  const e = ev();
  e.done = true; e.buddy = false;
  save();
  return { msgs: EV_END[cmd], end: true };
}

let battleOpen = false, bQueue = [], bAfter = null, bTimer = null, bTyping = null;
function bHearts() {
  const h = ev().hearts;
  $("bShake").classList.remove("vanish");
  $("bHearts").textContent = "♥".repeat(h) + "♡".repeat(EV_HEARTS - h);
  const img = $("bEnemy");
  img.src = "chara/" + (h >= EV_HEARTS ? "tabioji-egao" : h === 2 ? "tabioji-nattoku" : "tabioji-komari") + ".svg";
  $("bShake").classList.toggle("frozen", h < 2);
  img.classList.toggle("lie", h === 0);                  // 最初は横にたおれている → ハート1つで少し起きる → 2つで立つ
  img.classList.toggle("half", h === 1);
}
function bShow(which) {
  $("bCmd").hidden = which !== "cmd";
  $("bYn").hidden = which !== "yn";
}
function bType(text) {
  clearInterval(bTimer);
  const el = $("bText");
  let i = 0;
  el.textContent = "";
  $("bNext").hidden = true;
  bTyping = text;
  bTimer = setInterval(() => {
    i++;
    el.textContent = text.slice(0, i);
    if (i >= text.length) { clearInterval(bTimer); bTyping = null; $("bNext").hidden = false; }
  }, 32);
}
function bSay(msgs, after) {
  bQueue = msgs.slice(); bAfter = after || null;
  bShow("none");
  bAdvance();
}
function bAdvance() {
  if (bQueue.length) { bType(bQueue.shift()); return; }
  const f = bAfter; bAfter = null;
  $("bNext").hidden = true;
  if (f) f();
}
function bMenu() { $("bText").textContent = "どうする?"; $("bNext").hidden = true; bShow("cmd"); }
function bConfirm(cmd) { $("bText").textContent = "「" + EV_LABEL[cmd] + "」を 本当に そうしますか?"; $("bNext").hidden = true; bShow("yn"); bConfirm.cmd = cmd; }
function bFinish() {
  clearInterval(bTimer);
  battleOpen = false;
  $("battle").hidden = true;
  save();
  render();
  showNextArrival();
}
function startBattle() {
  battleOpen = true;
  $("battle").hidden = false;
  bHearts();
  const first = ev().hearts === 0;
  bSay(first ? ["ふぶきの なか、だれかが たおれている!", "たびおじが あらわれた!", "たびおじは こごえて うごけない…"] : ["たびおじは まだ ふるえている…"], bMenu);
}
$("bMsg").addEventListener("click", () => {
  if (!battleOpen) return;
  if (bTyping !== null) { clearInterval(bTimer); $("bText").textContent = bTyping; bTyping = null; $("bNext").hidden = false; return; }
  if (!$("bNext").hidden) bAdvance();
});
$("bCmd").addEventListener("click", (e) => {
  const cmd = e.target.dataset && e.target.dataset.cmd;
  if (!cmd) return;
  if (cmd === "warm") {
    const r = evWarm();
    bHearts();
    bSay(r.msgs, r.end ? bFinish : bMenu);
  } else {
    bConfirm(cmd);
  }
});
$("bYn").addEventListener("click", (e) => {
  const yn = e.target.dataset && e.target.dataset.yn;
  if (!yn) return;
  if (yn === "no") { bMenu(); return; }
  const r = evGiveUp(bConfirm.cmd);
  // せりふのあと、たびおじが すうっと消える
  bSay(r.msgs.slice(0, 2), () => { $("bShake").classList.add("vanish"); bSay(r.msgs.slice(2), bFinish); });
});

// ---------- ブラウザ用テストボタン ----------
if (!NATIVE && (!WEB || location.search.includes("dev"))) {
  $("dev").hidden = false;
  $("dev").addEventListener("click", (e) => {
    const add = e.target.dataset.add;
    if (add) {
      S.mockCounter = (S.mockCounter || 0) + Number(add);
      if (S.lastCounter === null) S.lastCounter = 0;
      sync();
    } else if (e.target.hasAttribute("data-event")) {
      devJumpEvent();
    } else if (e.target.hasAttribute("data-stop")) {
      devJumpStop();
    } else if (e.target.hasAttribute("data-reset")) {
      S = freshState(); S.lastCounter = 0; save(); render();
    }
  });
}

// テスト用: 鳥海山の2000歩手前まで進めて、イベントをはじめから始める
function devJumpStop() {            // たびおじが仲間の状態で、「行きつけ」に着く直前へ
  S.ev = { done: true, hearts: 3, buddy: true };
  const iki = SPOTS.find((sp) => sp.id === "ikitsuke");
  for (const sp of visibleSpots()) if (sp.cum < iki.cum) { S.arrivals[sp.id] = S.arrivals[sp.id] || { t: Date.now() }; S.seen[sp.id] = true; }
  delete S.arrivals[iki.id]; delete S.seen[iki.id];
  S.total = iki.cum;
  S.history.push([Date.now(), S.total]);
  save();
  registerArrivals();
  render();
}
function devJumpEvent() {
  for (const sp of SPOTS) if (sp.cum <= EVENT_AT) { S.arrivals[sp.id] = S.arrivals[sp.id] || { t: Date.now() }; S.seen[sp.id] = true; }
  S.total = Math.max(S.total, EVENT_AT);
  S.history.push([Date.now(), S.total]);
  S.ev = null;
  save();
  registerArrivals();
  render();
}

// ---------- Web版: 歩数の手入力 ----------
// 日付ごとの歩数を S.days に持ち、入れ直した分(差分)だけ旅が進む。
const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

function setDaySteps(date, value) {
  S.days = S.days || {};
  const old = S.days[date] || 0;
  S.days[date] = value;
  S.total = Math.max(0, S.total + (value - old));
  S.history.push([Date.now(), S.total]);
  save();
  registerArrivals();
  render();
  renderDays();
}

function renderDays() {
  const days = Object.entries(S.days || {}).sort().reverse().slice(0, 7);
  $("mDays").textContent = days.length ? "記録: " + days.map(([d, v]) => d.slice(5).replace("-", "/") + " " + fmt(v) + "歩").join(" ・ ") : "";
}

if (WEB) {
  $("manual").hidden = false;
  $("mDate").value = ymd(new Date());
  $("mSave").addEventListener("click", () => {
    const v = Math.round(Number($("mSteps").value));
    if (!$("mDate").value || !(v >= 0) || v > 200000) { $("mDays").textContent = "歩数は0〜200,000の数字で入れてください。"; return; }
    setDaySteps($("mDate").value, v);
    $("mSteps").value = "";
  });
  $("mDate").addEventListener("change", () => {
    const v = (S.days || {})[$("mDate").value];
    $("mSteps").value = v === undefined ? "" : v;
  });
  renderDays();
}

// ---------- 起動 ----------
MapView.init({ root: $("map"), route: ROUTE, spots: visibleSpots(), onTap: (id) => {
  if (S.arrivals[id]) openSpot(SPOTS.find((s) => s.id === id), false);
} });
Profile.init({ route: ROUTE, spots: visibleSpots(), svg: $("profile") });
$("routeNote").textContent = "ルートは国道を中心にたどり、全長およそ" + Math.round(ROUTE.km[ROUTE.km.length - 1]) +
  "km。ゲーム内では 1km = " + STEPS_PER_KM + "歩 で進みます(全行程 " + fmt(SPOTS[SPOTS.length - 1].cum) + "歩)。";
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
setInterval(sync, 3000);
render();
if (WEB) registerArrivals(); else sync();
if (location.search.includes("dev") && location.hash === "#battle") devJumpEvent();     // 画面確認用

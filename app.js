"use strict";

const NATIVE = typeof Android !== "undefined";
const WEB = window.AKITA_WEB === true;     // iPhone等のWeb版: 歩数はヘルスケアを見て手入力
const KEY = "akita-walk-v1";
const $ = (id) => document.getElementById(id);

// ---------- ルート(tools/build_route.py で作成)と観光地 ----------
// ゲーム内換算: 実距離 1km = 150歩。到着歩数は実際の道のりから決める。
const STEPS_PER_KM = 150;
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
  for (const sp of SPOTS) {
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
function nextSpot() { return SPOTS.find((s) => S.total < s.cum); }

function guideSay() {
  const n = nextSpot();
  if (!n) return ["right-egao", "ついに秋田一周ゴール! ここまで歩き切ったあなたは最高の旅人だよ。"];
  const prev = SPOTS[SPOTS.indexOf(n) - 1];
  const remain = n.cum - S.total;
  const leg = n.cum - (prev ? prev.cum : 0);
  const ratio = 1 - remain / leg;
  if (S.total === 0) return ["right-wink", "秋田駅からスタート! まずは「" + n.name + "」を目指して歩こう。写真もたくさん撮ってね。"];
  if (ratio > 0.8) return ["right-odoroki", "もうすぐ「" + n.name + "」! あと" + fmt(remain) + "歩だよ。"];
  const climb = n.elev - MapView.elevAt(currentKm());
  if (ratio > 0.2 && climb > 300) return ["right-komari", "ここからは登りだよ。「" + n.name + "」は標高約" + n.elev + "m。ゆっくり行こう。"];
  if (ratio > 0.2 && climb < -250) return ["right-egao", "下り坂! 「" + n.name + "」は標高約" + n.elev + "mだから、歩きやすいよ。"];
  if (ratio > 0.4) return ["right-nattoku", "いい調子! 「" + n.name + "」は" + n.tag + "なんだって。"];
  return ["right-egao", "今日も一歩ずつ。「" + n.name + "」まであと" + fmt(remain) + "歩。"];
}

function render() {
  $("totalSteps").textContent = fmt(S.total);
  const gc = $("goalCard");
  if (gc) gc.hidden = !S.arrivals[SPOTS[SPOTS.length - 1].id];

  const [pose, text] = guideSay();
  $("guideImg").src = "chara/" + pose + ".svg";
  $("guideText").textContent = text;

  const n = nextSpot();
  if (n) {
    const prev = SPOTS[SPOTS.indexOf(n) - 1];
    const base = prev ? prev.cum : 0;
    const pct = Math.min(100, ((S.total - base) / (n.cum - base)) * 100);
    $("nextLabel").textContent = "次の目的地";
    $("nextName").textContent = n.name;
    $("barFill").style.width = pct + "%";
    $("nextRemain").textContent = "あと " + fmt(n.cum - S.total) + " 歩";
    $("nextPct").textContent = Math.floor(pct) + "%";
    const nowE = Math.round(MapView.elevAt(currentKm()));
    $("nextElev").textContent = "いまの標高 約" + nowE + "m → 「" + n.name + "」標高 約" + n.elev + "m(あと約" + Math.max(0.1, n.km - currentKm()).toFixed(1) + "km)";
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
  MapView.setState(Object.keys(S.arrivals), n ? n.id : null);
  MapView.walkTo(km);
  Profile.draw(km, Object.keys(S.arrivals));
}

// ---------- 画面: リスト ----------
function renderList() {
  const ol = $("list");
  ol.replaceChildren();
  SPOTS.forEach((sp, i) => {
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
  if (current) return;
  const sp = SPOTS.find((s) => S.arrivals[s.id] && !S.seen[s.id]);
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
  $("mNoPhoto").hidden = !!url;
  if (url) {
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
// ---------- ブラウザ用テストボタン ----------
if (!NATIVE && (!WEB || location.search.includes("dev"))) {
  $("dev").hidden = false;
  $("dev").addEventListener("click", (e) => {
    const add = e.target.dataset.add;
    if (add) {
      S.mockCounter = (S.mockCounter || 0) + Number(add);
      if (S.lastCounter === null) S.lastCounter = 0;
      sync();
    } else if (e.target.hasAttribute("data-reset")) {
      S = freshState(); S.lastCounter = 0; save(); render();
    }
  });
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
MapView.init({ root: $("map"), route: ROUTE, spots: SPOTS, onTap: (id) => {
  if (S.arrivals[id]) openSpot(SPOTS.find((s) => s.id === id), false);
} });
Profile.init({ route: ROUTE, spots: SPOTS, svg: $("profile") });
$("routeNote").textContent = "ルートは国道を中心にたどり、全長およそ" + Math.round(ROUTE.km[ROUTE.km.length - 1]) +
  "km。ゲーム内では 1km = " + STEPS_PER_KM + "歩 で進みます(全行程 " + fmt(SPOTS[SPOTS.length - 1].cum) + "歩)。";
document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
setInterval(sync, 3000);
render();
if (WEB) registerArrivals(); else sync();

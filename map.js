"use strict";
// 国土地理院タイル(淡色地図 + 色別標高図 + 陰影起伏図)の上に、国道沿いのルートと歩く山女子を描く。
// ライブラリは使わず、タイルは <img> を並べて自前で描画する。
const MapView = (() => {
  const TILE = 256, ZMIN = 8, ZMAX = 13, ZFOLLOW = 11;
  const BASE = "https://cyberjapandata.gsi.go.jp/xyz/";
  const LAYERS = [
    { id: "pale", opacity: 1 },
    { id: "relief", opacity: 0.55 },
    { id: "hillshademap", opacity: 0.55, blend: "multiply" },
  ];
  const NS = "http://www.w3.org/2000/svg";

  let root, tilesEl, svgEl, walkerEl, hintEl;
  let route, spots = [], arrived = new Set(), nextId = null, onTap = () => {};
  let w = 360, h = 380;
  let z = ZFOLLOW, clat = 39.9, clon = 140.3, follow = true;
  let walkKm = 0, anim = null, first = true;
  const tiles = new Map();

  // ---- 座標 ----
  const scaleOf = (zz) => TILE * Math.pow(2, zz);
  const wx = (lon, zz = z) => (lon + 180) / 360 * scaleOf(zz);
  const wy = (lat, zz = z) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * scaleOf(zz);
  const unx = (x) => x / scaleOf(z) * 360 - 180;
  const uny = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scaleOf(z)))) * 180 / Math.PI;

  function pointAt(km) {
    const K = route.km, P = route.pts;
    if (km <= 0) return P[0];
    if (km >= K[K.length - 1]) return P[P.length - 1];
    let lo = 0, hi = K.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (K[m] <= km) lo = m; else hi = m; }
    const r = (km - K[lo]) / (K[hi] - K[lo] || 1);
    return [P[lo][0] + (P[hi][0] - P[lo][0]) * r, P[lo][1] + (P[hi][1] - P[lo][1]) * r];
  }
  function elevAt(km) {
    const E = route.elev;
    if (km <= E[0][0]) return E[0][1];
    for (let i = 1; i < E.length; i++) {
      if (E[i][0] >= km) { const r = (km - E[i - 1][0]) / (E[i][0] - E[i - 1][0] || 1); return E[i - 1][1] + (E[i][1] - E[i - 1][1]) * r; }
    }
    return E[E.length - 1][1];
  }

  const el = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ---- 描画 ----
  function drawTiles() {
    const left = wx(clon) - w / 2, top = wy(clat) - h / 2;
    const n = Math.pow(2, z);
    const need = new Set();
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        const x = ((tx % n) + n) % n;
        for (const L of LAYERS) {
          const key = L.id + "/" + z + "/" + tx + "/" + ty;
          need.add(key);
          let img = tiles.get(key);
          if (!img) {
            img = document.createElement("img");
            img.className = "tile";
            img.draggable = false;
            img.alt = "";
            img.style.opacity = L.opacity;
            if (L.blend) img.style.mixBlendMode = L.blend;
            img.onerror = () => { img.style.display = "none"; };   // オフラインなどで取得できなければ無地のまま
            img.src = BASE + L.id + "/" + z + "/" + x + "/" + ty + ".png";
            tilesEl.appendChild(img);
            tiles.set(key, img);
          }
          img.style.transform = "translate(" + Math.round(tx * TILE - left) + "px," + Math.round(ty * TILE - top) + "px)";
        }
      }
    }
    for (const [key, img] of tiles) if (!need.has(key)) { img.remove(); tiles.delete(key); }
  }

  function drawOverlay() {
    const left = wx(clon) - w / 2, top = wy(clat) - h / 2;
    const sx = (p) => (wx(p[1]) - left).toFixed(1) + "," + (wy(p[0]) - top).toFixed(1);
    svgEl.replaceChildren();

    const all = route.pts.map(sx).join(" ");
    svgEl.append(el("polyline", { class: "r-case", points: all }), el("polyline", { class: "r-line", points: all }));

    // 歩いた分
    const K = route.km;
    let i = 0;
    while (i < K.length && K[i] <= walkKm) i++;
    const done = route.pts.slice(0, i).map(sx);
    done.push(sx(pointAt(walkKm)));
    if (done.length > 1) svgEl.append(el("polyline", { class: "r-done", points: done.join(" ") }));

    // 出発点と観光地
    const s0 = route.pts[0];
    const [sx0, sy0] = sx(s0).split(",");
    const g0 = el("g", {});
    g0.append(el("circle", { class: "pin on", cx: sx0, cy: sy0, r: 9 }), el("text", { class: "pin-no", x: sx0, y: sy0 }, "S"));
    svgEl.append(g0);
    spots.forEach((sp, idx) => {
      const [x, y] = sx([sp.lat, sp.lon]).split(",");
      const on = arrived.has(sp.id);
      const g = el("g", { "data-spot": sp.id });
      g.append(
        el("circle", { class: "hit", cx: x, cy: y, r: 16 }),
        el("circle", { class: "pin" + (on ? " on" : "") + (sp.id === nextId ? " next" : ""), cx: x, cy: y, r: 10 }),
        el("text", { class: "pin-no", x, y }, String(idx + 1)));
      if (z >= 9) g.append(el("text", { class: "pin-lbl" + (on ? "" : " off"), x: +x + 13, y: +y + 4 }, on ? sp.name : "？？？"));   // 到着前は名前を隠す
      svgEl.append(g);
    });

    // 山女子
    const p = pointAt(walkKm), q = pointAt(walkKm + 0.25), r = pointAt(Math.max(0, walkKm - 0.25));
    const [px, py] = sx(p).split(",");
    walkerEl.style.transform = "translate(" + px + "px," + py + "px)";
    const west = (q[1] - r[1]) < 0;
    walkerEl.firstElementChild.style.transform = west ? "scaleX(-1)" : "none";
  }

  function draw() {
    if (follow) { const p = pointAt(walkKm); clat = p[0]; clon = p[1]; }
    drawTiles();
    drawOverlay();
    if (hintEl) hintEl.hidden = follow;
  }

  // ---- 操作 ----
  function setZoom(nz) {
    z = Math.max(ZMIN, Math.min(ZMAX, nz));
    draw();
  }

  function bind() {
    let drag = null;
    root.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".map-btn")) return;
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
      root.setPointerCapture(e.pointerId);
    });
    root.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 6) {
        follow = false;
        clon = unx(wx(clon) - dx); clat = uny(wy(clat) - dy);
        draw();
      }
    });
    const end = (e) => {
      if (!drag) return;
      const moved = drag.moved; drag = null;
      if (moved <= 6) {
        const g = document.elementFromPoint(e.clientX, e.clientY);
        const sp = g && g.closest && g.closest("[data-spot]");
        if (sp) onTap(sp.getAttribute("data-spot"));
      }
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", () => { drag = null; });
    root.querySelector("[data-zoom-in]").addEventListener("click", () => setZoom(z + 1));
    root.querySelector("[data-zoom-out]").addEventListener("click", () => setZoom(z - 1));
    root.querySelector("[data-fit]").addEventListener("click", () => {
      follow = false; z = ZMIN; clat = 39.78; clon = 140.3; draw();
    });
    root.querySelector("[data-here]").addEventListener("click", () => {
      follow = true; z = Math.max(z, ZFOLLOW - 1); draw();
    });
  }

  // ---- 外から使う ----
  function init(opts) {
    root = opts.root; route = opts.route; spots = opts.spots; onTap = opts.onTap;
    tilesEl = root.querySelector(".tiles");
    svgEl = root.querySelector("svg.overlay");
    walkerEl = root.querySelector(".walker");
    hintEl = root.querySelector(".map-hint");
    const resize = () => {
      w = root.clientWidth; h = root.clientHeight;
      svgEl.setAttribute("width", w); svgEl.setAttribute("height", h);
      draw();
    };
    new ResizeObserver(resize).observe(root);
    bind();
    resize();
  }

  function setState(arrivedIds, next) {
    arrived = new Set(arrivedIds); nextId = next; draw();
  }

  /** 累計距離(km)まで山女子を歩かせる。初回は即移動、以降はアニメーション。 */
  function walkTo(km, opts) {
    km = Math.max(0, Math.min(km, route.km[route.km.length - 1]));
    if (anim) cancelAnimationFrame(anim);
    if (first || (opts && opts.jump) || Math.abs(km - walkKm) < 0.01) {
      first = false; walkKm = km; walkerEl.classList.remove("walking"); draw(); return;
    }
    const from = walkKm, dist = km - from;
    const dur = Math.min(3500, 700 + Math.abs(dist) * 45), t0 = performance.now();
    walkerEl.classList.add("walking");
    const tick = (t) => {
      const r = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - r, 3);
      walkKm = from + dist * e;
      draw();
      if (r < 1) anim = requestAnimationFrame(tick);
      else { anim = null; walkerEl.classList.remove("walking"); if (opts && opts.done) opts.done(); }
    };
    anim = requestAnimationFrame(tick);
  }

  return { init, setState, walkTo, pointAt, elevAt };
})();

// ---- 標高プロフィール(ルート全体の高低差と、いまの位置) ----
const Profile = (() => {
  const W = 360, H = 120, PAD_L = 30, PAD_R = 8, PAD_T = 14, PAD_B = 18, MAXE = 2400;
  let route, spots, svg;
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const X = (km) => PAD_L + km / route.km[route.km.length - 1] * (W - PAD_L - PAD_R);
  const Y = (m) => H - PAD_B - Math.min(m, MAXE) / MAXE * (H - PAD_T - PAD_B);

  function init(opts) { route = opts.route; spots = opts.spots; svg = opts.svg; }

  function draw(km, arrivedIds) {
    svg.replaceChildren();
    const defs = el("defs", {});
    const grad = el("linearGradient", { id: "elevGrad", x1: 0, y1: Y(0), x2: 0, y2: Y(MAXE), gradientUnits: "userSpaceOnUse" });
    [["0", "#8fbf8f"], ["0.3", "#d9dc86"], ["0.6", "#e9bd6a"], ["1", "#b98c5a"]].forEach(([o, c]) => grad.append(el("stop", { offset: o, "stop-color": c })));
    defs.append(grad); svg.append(defs);

    [0, 1000, 2000].forEach((m) => {
      svg.append(el("line", { class: "pf-grid", x1: PAD_L, x2: W - PAD_R, y1: Y(m), y2: Y(m) }));
      svg.append(el("text", { class: "pf-axis", x: PAD_L - 4, y: Y(m) + 3, "text-anchor": "end" }, m + "m"));
    });
    const E = route.elev;
    const line = E.map((p) => X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join(" ");
    svg.append(el("polygon", { class: "pf-area", points: X(0) + "," + Y(0) + " " + line + " " + X(E[E.length - 1][0]) + "," + Y(0) }));

    // 歩いた分を濃く
    const doneE = E.filter((p) => p[0] <= km);
    if (doneE.length) {
      const pts = doneE.map((p) => X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1));
      pts.push(X(km).toFixed(1) + "," + Y(MapView.elevAt(km)).toFixed(1));
      svg.append(el("polyline", { class: "pf-done", points: pts.join(" ") }));
    }
    spots.forEach((sp, i) => {
      const x = X(sp.km), y = Y(sp.elev);
      const on = km >= sp.km;
      svg.append(el("line", { class: "pf-tick", x1: x, x2: x, y1: y, y2: Y(0) }));
      svg.append(el("circle", { class: "pf-dot" + (on ? " on" : ""), cx: x, cy: y, r: 6 }));
      svg.append(el("text", { class: "pf-no", x, y: y + 0.5 }, String(i + 1)));
    });
    svg.append(el("line", { class: "pf-now", x1: X(km), x2: X(km), y1: PAD_T - 6, y2: Y(0) }));
    svg.append(el("text", { class: "pf-km", x: PAD_L, y: H - 4 }, "0km"));
    svg.append(el("text", { class: "pf-km", x: W - PAD_R, y: H - 4, "text-anchor": "end" }, Math.round(route.km[route.km.length - 1]) + "km"));
  }
  return { init, draw };
})();

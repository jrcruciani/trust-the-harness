/* ============================================================================
   Cocina del agente · sustituto directo de static/plant.js
   Mismas globales (PlantTopology, Plant), mismos métodos y mismos eventos.
   No toca escenarios, servidor ni app.js: solo cambia cómo se dibuja la ejecución.

   Analogía: el cocinero es el modelo; la despensa es el contexto que consulta;
   ollas, fogones y pase son las herramientas (idénticas en ambos harnesses);
   el harness es cómo está organizada la cocina (riel, arcos de control, cierre, pincho).

   Dibujo: 3D simulado sin WebGL. Lo redondo se construye apilando capas
   horizontales (sprite stacking con formas vectoriales, sin píxeles gruesos);
   las cajas son la misma pila resuelta de forma exacta (extrusión con caras sombreadas).
   ============================================================================ */
(function () {
  const W = 960, H = 600, PX = 470, PY = 170;
  const DEPOTS = [
    { id: "crew", cx: 140, y: 310, label: "Cuadrillas", sub: "3 sectores" },
    { id: "material", cx: 340, y: 310, label: "Material", sub: "almacén · 3 sectores" },
    { id: "water", cx: 740, y: 310, label: "Cisternas", sub: "hospital · residencia · colegio" },
    { id: "order", cx: 140, y: 475, label: "GMAO", sub: "una orden por sector" },
    { id: "notice", cx: 340, y: 475, label: "Avisos", sub: "irreversibles" },
    { id: "close", cx: 740, y: 475, label: "Expediente", sub: "estado y recibos" },
  ];
  const DEPOT = Object.fromEntries(DEPOTS.map((d) => [d.id, d]));
  function depotFor(tool, d = {}) {
    const args = d.args || {};
    if (tool === "reserve_resource") return args.resource;
    if (tool === "check_reservation") return String(args.reservation_id || "").split("-")[2];
    return { get_options: "close", list_records: "close", create_work_order: "order", send_notice: "notice", inspect_mission: "close",
      lookup_operation: "close", close_mission: "close" }[tool];
  }
  function routeFor(id) {
    const d = DEPOT[id];
    return d ? `M470 196 V${d.y} H${d.cx} V${d.y + 26}` : null;
  }
  window.PlantTopology = { DEPOTS, DEPOT, depotFor, routeFor, W, H, PX, PY };
})();

(function () {
  "use strict";
  const T = window.PlantTopology, TAU = Math.PI * 2;
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeIO = (t) => (t < .5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2);
  const easeOut = (t) => 1 - (1 - t) ** 3;
  const back = (t) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;
  const nowMs = () => (window.performance ? performance.now() : Date.now());
  const usd = (n) => `${Number(n || 0).toLocaleString("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} $`;
  const freshTurn = () => ({ status: "idle", tin: 0, tout: 0, elapsed: 0, started: 0, done: 0, total: 16, cost: 0, last: 0 });
  const FONT = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';

  const C = {
    floorA: "#F1EADC", floorB: "#E4DAC8", floorSide: "#B7A98F", plank: "#E3BE8C", plankLine: "#C99F6A",
    wallLo: "#6FA9A2", wallHi: "#F6F1E7", wallTop: "#DCD4C4", trim: "#4F8A84",
    wood: "#C9955C", woodDark: "#A06F3F", woodLight: "#E2B680",
    steel: "#AEB9C4", steelTop: "#D7DEE5", hob: "#343A43", pan: "#2B3038",
    marble: "#D9D2C4", marbleTop: "#F7F4EE", passBody: "#5F9A94",
    crew: "#E5484D", material: "#F5B82E", water: "#3E9BE9", cap: "#1F6FB8", leaf: "#3E8E4B",
    dead: "#9AA0A8", food: "#E8833A", flame: "#FF8A1F", flameTip: "#FFD34D",
    ok: "#2FA36B", warn: "#E8A21A", risk: "#E5484D", harness: "#7C5CFF", off: "#C3C8D0",
    ink: "#2B3340", sub: "#6B7584", paper: "#FFFDF7",
    chef: "#FAFAF7", skin: "#F0C4A0", hair: "#5A3B26", trouser: "#3A4460", shoe: "#22262E", navy: "#2F3A56",
    gold: "#F5C542", red: "#D6453D", door: "#B9773F", model: "#2B3340",
  };

  // ---------- color
  const _sh = new Map();
  function shade(hex, f) {
    const q = Math.round(f * 50), key = hex + q;
    let v = _sh.get(key);
    if (v) return v;
    const n = parseInt(hex.slice(1), 16), k = q / 50;
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    if (k <= 1) { r *= k; g *= k; b *= k; } else { const m = Math.min(1, k - 1); r += (255 - r) * m; g += (255 - g) * m; b += (255 - b) * m; }
    v = `rgb(${r | 0},${g | 0},${b | 0})`;
    _sh.set(key, v);
    return v;
  }
  const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

  function toHex(css) {
    const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(css || "");
    if (!m || m[4] === "0") return null;
    return "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join("");
  }
  const luma = (hex) => { const n = parseInt(hex.slice(1), 16); return (.2126 * (n >> 16) + .7152 * ((n >> 8) & 255) + .0722 * (n & 255)) / 255; };

  // ---------- cámara: x este, y sur, z arriba; proyección oblicua con giro (yaw)
  class Cam {
    constructor() { this.S = 1.02; this.cx = 480; this.cy = 340; this.ky = .58; this.kz = .8; this.px = 1; this.set(.45); }
    set(yaw) { this.yaw = yaw; this.c = Math.cos(yaw); this.s = Math.sin(yaw); }
    X(x, y) { return this.cx + this.S * (x * this.c - y * this.s); }
    Y(x, y, z) { return this.cy + this.S * this.ky * (x * this.s + y * this.c) - this.S * this.kz * (z || 0); }
    depth(x, y) { return x * this.s + y * this.c; }
    screen(ctx) { ctx.setTransform(this.px, 0, 0, this.px, 0, 0); }
    ground(ctx, x, y, z, rot) {               // plano horizontal local a la altura z
      const a = this.yaw + (rot || 0), ca = Math.cos(a), sa = Math.sin(a), S = this.S * this.px;
      ctx.setTransform(S * ca, S * this.ky * sa, -S * sa, S * this.ky * ca, this.X(x, y) * this.px, this.Y(x, y, z) * this.px);
    }
  }

  // ---------- primitivas
  const box = (w, d) => [-w / 2, -d / 2, w / 2, -d / 2, w / 2, d / 2, -w / 2, d / 2];
  function rbox(w, d, r) {
    const x = w / 2, y = d / 2, k = r * .3;
    return [-x + r, -y, x - r, -y, x - k, -y + k, x, -y + r, x, y - r, x - k, y - k, x - r, y, -x + r, y, -x + k, y - k, -x, y - r, -x, -y + r, -x + k, -y + k];
  }
  const LX = -0.62, LY = 0.78;                 // de dónde viene la luz (suroeste)
  /* Prisma: una pila de capas idénticas resuelta de forma exacta. Caras visibles con luz por cara. */
  function prism(ctx, cam, pts, x, y, rot, z0, z1, side, top) {
    const n = pts.length / 2, cr = Math.cos(rot || 0), sr = Math.sin(rot || 0);
    const wx = [], wy = [], sx = [], sy = [];
    for (let i = 0; i < n; i++) {
      const lx = pts[2 * i], ly = pts[2 * i + 1];
      wx[i] = x + lx * cr - ly * sr; wy[i] = y + lx * sr + ly * cr;
      sx[i] = cam.X(wx[i], wy[i]); sy[i] = cam.Y(wx[i], wy[i], 0);
    }
    const d0 = cam.S * cam.kz * z0, d1 = cam.S * cam.kz * z1;
    cam.screen(ctx); ctx.lineWidth = .7;
    if (side) for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ex = wx[j] - wx[i], ey = wy[j] - wy[i], L = Math.hypot(ex, ey) || 1, nx = ey / L, ny = -ex / L;
      if (nx * cam.s + ny * cam.c <= .001) continue;
      const col = shade(side, .56 + .40 * ((nx * LX + ny * LY + 1) / 2));
      ctx.beginPath(); ctx.moveTo(sx[i], sy[i] - d0); ctx.lineTo(sx[j], sy[j] - d0); ctx.lineTo(sx[j], sy[j] - d1); ctx.lineTo(sx[i], sy[i] - d1); ctx.closePath();
      ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = col; ctx.stroke();
    }
    if (top) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) i ? ctx.lineTo(sx[i], sy[i] - d1) : ctx.moveTo(sx[i], sy[i] - d1);
      ctx.closePath(); ctx.fillStyle = top; ctx.fill(); ctx.strokeStyle = top; ctx.stroke();
    }
  }
  const pr = (prof, h) => {                    // radio de un perfil a la altura h
    let k = 0; const n = prof.length;
    while (k < n - 2 && prof[k + 1][0] <= h) k++;
    const a = prof[k], b = prof[Math.min(n - 1, k + 1)];
    return b[0] > a[0] ? lerp(a[1], b[1], clamp((h - a[0]) / (b[0] - a[0]), 0, 1)) : b[1];
  };
  const scaleProf = (p, k) => (k === 1 ? p : p.map((q) => [q[0] * k, q[1] * k]));
  function lit(ctx, X, R, col) {               // luz lateral fija en pantalla
    const g = ctx.createLinearGradient(X - R, 0, X + R, 0);
    g.addColorStop(0, shade(col, 1.18)); g.addColorStop(.4, col); g.addColorStop(1, shade(col, .62));
    return g;
  }
  /* Torno: capas circulares apiladas cada ~1,5 px de pantalla. */
  function lathe(ctx, cam, x, y, z0, prof, col, o) {
    o = o || {};
    cam.screen(ctx);
    const S = cam.S, X = cam.X(x, y), Y0 = cam.Y(x, y, z0), kz = S * cam.kz, ky = cam.ky, H = prof[prof.length - 1][0];
    let R = 0; for (const p of prof) if (p[1] > R) R = p[1];
    const step = 1.5 / kz;
    if (o.wire) { ctx.strokeStyle = col; ctx.lineWidth = 1; } else ctx.fillStyle = o.flat ? col : lit(ctx, X, R * S, col);
    for (let h = 0, i = 0; ; h += step, i++) {
      const last = h >= H; if (last) h = H;
      const r = pr(prof, h) * S;
      if (r > .15 && (!o.wire || !(i & 1) || last)) {
        ctx.beginPath(); ctx.ellipse(X, Y0 - kz * h, r, r * ky, 0, 0, TAU);
        if (o.wire) ctx.stroke(); else { if (last && o.top) ctx.fillStyle = o.top; ctx.fill(); }
      }
      if (last) break;
    }
  }
  /* Pila de varias piezas elípticas intercaladas capa a capa (para el cocinero). */
  function stackParts(ctx, cam, x, y, rot, z0, z1, parts) {
    const S = cam.S, step = 1.5 / (S * cam.kz), n = Math.max(1, Math.ceil((z1 - z0) / step)), X = cam.X(x, y), cr = Math.cos(rot), sr = Math.sin(rot);
    cam.screen(ctx);
    for (const p of parts) p.fill = p.flat ? p.col : lit(ctx, X + (p.off || 0) * S, (p.R || 14) * S, p.col);
    for (let i = 0; i <= n; i++) {
      const z = lerp(z0, z1, i / n);
      for (const p of parts) {
        const e = p.at(z); if (!e) continue;
        cam.ground(ctx, x + e[0] * cr - e[1] * sr, y + e[0] * sr + e[1] * cr, z, rot);
        ctx.beginPath(); ctx.ellipse(0, 0, e[2], e[3], 0, 0, TAU);
        cam.screen(ctx); ctx.fillStyle = p.fill; ctx.fill();
      }
    }
  }
  function quad3(ctx, cam, pts, fill, stroke, lw) {
    cam.screen(ctx); ctx.beginPath();
    for (let i = 0; i < pts.length; i++) { const p = pts[i], X = cam.X(p[0], p[1]), Y = cam.Y(p[0], p[1], p[2]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }
  function line3(ctx, cam, a, b, col, lw) {
    cam.screen(ctx); ctx.beginPath();
    ctx.moveTo(cam.X(a[0], a[1]), cam.Y(a[0], a[1], a[2])); ctx.lineTo(cam.X(b[0], b[1]), cam.Y(b[0], b[1], b[2]));
    ctx.strokeStyle = col; ctx.lineWidth = lw || 1; ctx.stroke();
  }

  // ---------- 2D de pantalla
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function text(ctx, s, x, y, size, color, weight, align) {
    ctx.font = `${weight || 500} ${size}px ${FONT}`; ctx.textAlign = align || "left"; ctx.textBaseline = "middle";
    ctx.fillStyle = color; ctx.fillText(s, x, y);
  }
  function pill(ctx, cx, cy, s, o) {
    o = o || {}; const size = o.size || 11;
    ctx.font = `${o.weight || 600} ${size}px ${FONT}`;
    const w = ctx.measureText(s).width + (o.dot ? 27 : 16), h = size + 9, x = clamp(cx - w / 2, 4, 956 - w), y = cy - h / 2;
    rr(ctx, x, y, w, h, h / 2); ctx.fillStyle = o.bg || "rgba(255,255,255,.94)"; ctx.fill();
    if (o.line) { ctx.strokeStyle = o.line; ctx.lineWidth = 1; ctx.stroke(); }
    if (o.dot) { ctx.beginPath(); ctx.arc(x + 11, cy, 4, 0, TAU); ctx.fillStyle = o.dot; ctx.fill(); }
    ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = o.fg || C.ink; ctx.fillText(s, x + (o.dot ? 19 : 8), cy + .5);
  }
  function card(ctx, x, y, w, h, r) {
    rr(ctx, x + 1, y + 3, w, h, r); ctx.fillStyle = "rgba(40,48,66,.10)"; ctx.fill();
    rr(ctx, x, y, w, h, r); ctx.fillStyle = "rgba(255,255,255,.96)"; ctx.fill();
    ctx.strokeStyle = "rgba(43,51,64,.10)"; ctx.lineWidth = 1; ctx.stroke();
  }
  function starPath(ctx, x, y, R, r, rot, sx) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (rot || 0) - Math.PI / 2 + i * Math.PI / 5, q = i & 1 ? r : R, px = x + Math.cos(a) * q * (sx == null ? 1 : sx), py = y + Math.sin(a) * q;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }
  function glyph(ctx, k, x, y, s, col) {
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(1.2, s * .16); ctx.beginPath();
    if (k === "check") { ctx.moveTo(x - s * .42, y + s * .02); ctx.lineTo(x - s * .1, y + s * .34); ctx.lineTo(x + s * .46, y - s * .32); ctx.stroke(); }
    else if (k === "bang") { ctx.moveTo(x, y - s * .46); ctx.lineTo(x, y + s * .08); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y + s * .4, s * .1, 0, TAU); ctx.fill(); }
    else if (k === "cross") { ctx.moveTo(x - s * .34, y - s * .34); ctx.lineTo(x + s * .34, y + s * .34); ctx.moveTo(x + s * .34, y - s * .34); ctx.lineTo(x - s * .34, y + s * .34); ctx.stroke(); }
    else if (k === "pan") { ctx.arc(x - s * .12, y, s * .34, 0, TAU); ctx.fill(); ctx.beginPath(); ctx.moveTo(x + s * .2, y); ctx.lineTo(x + s * .6, y); ctx.stroke(); }
    else if (k === "plate") { ctx.arc(x, y, s * .44, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, s * .18, 0, TAU); ctx.fill(); }
    else if (k === "lock") { ctx.arc(x, y - s * .1, s * .26, Math.PI, TAU); ctx.stroke(); rr(ctx, x - s * .4, y - s * .08, s * .8, s * .56, s * .1); ctx.fill(); }
    else if (k === "mag") { ctx.arc(x - s * .1, y - s * .1, s * .3, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x + s * .14, y + s * .14); ctx.lineTo(x + s * .46, y + s * .46); ctx.stroke(); }
    else if (k === "book") { rr(ctx, x - s * .48, y - s * .34, s * .96, s * .68, s * .08); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y - s * .34); ctx.lineTo(x, y + s * .34); ctx.stroke(); }
    else if (k === "ticket") { rr(ctx, x - s * .32, y - s * .44, s * .64, s * .88, s * .08); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - s * .16, y - s * .14); ctx.lineTo(x + s * .16, y - s * .14); ctx.moveTo(x - s * .16, y + s * .12); ctx.lineTo(x + s * .16, y + s * .12); ctx.stroke(); }
    else if (k === "star") { starPath(ctx, x, y, s * .5, s * .22, 0); ctx.fill(); }
    else { ctx.arc(x, y, s * .34, 0, TAU); ctx.fill(); }
  }
  function cell(ctx, x, y, k, st, age) {       // casilla de una comanda
    const col = k === "order" || k === "notice" ? C.ok : C[k], r = 6.4 * (age < 320 ? 1 + .45 * Math.sin(age / 320 * Math.PI) : 1);
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    if (st === "confirmed") { ctx.fillStyle = col; ctx.fill(); glyph(ctx, "check", x, y, 7.5, k === "material" ? "#5A4300" : "#fff"); return; }
    if (st === "risk") { ctx.fillStyle = C.risk; ctx.fill(); glyph(ctx, "bang", x, y, 8, "#fff"); return; }
    const pend = st === "pending";
    ctx.fillStyle = pend ? "#FFF1CC" : "#F3F5F8"; ctx.fill();
    ctx.strokeStyle = pend ? C.warn : "#C9CFD8"; ctx.lineWidth = pend ? 1.6 : 1; ctx.stroke();
    if (k === "order") glyph(ctx, "pan", x, y, 8, pend ? C.warn : "#AEB5C0");
    else if (k === "notice") glyph(ctx, "plate", x, y, 8, pend ? C.warn : "#AEB5C0");
    else { ctx.beginPath(); ctx.arc(x, y, 2.7, 0, TAU); ctx.fillStyle = pend ? col : alpha(col, .45); ctx.fill(); }
  }
  const TONE = {
    "": { bg: "rgba(255,255,255,.96)", fg: C.ink, line: "rgba(43,51,64,.18)" },
    warn: { bg: "#FFF1CC", fg: "#7A5200", line: C.warn },
    ok: { bg: "#E3F6EC", fg: "#1E6B45", line: C.ok },
    risk: { bg: C.risk, fg: "#fff" },
    dark: { bg: C.ink, fg: "#fff" },
    v: { bg: C.harness, fg: "#fff" },
  };

  // ---------- la maqueta (unidades de mundo)
  const ROOM = { x0: -330, x1: 330, y0: -210, y1: 210, h: 104 };
  const FLOOR = [ROOM.x0, ROOM.y0, ROOM.x1, ROOM.y0, ROOM.x1, ROOM.y1, ROOM.x0, ROOM.y1];
  const WALL_N = [ROOM.x0 - 12, ROOM.y0 - 12, ROOM.x1, ROOM.y0 - 12, ROOM.x1, ROOM.y0, ROOM.x0 - 12, ROOM.y0];
  const WALL_W = [ROOM.x0 - 12, ROOM.y0, ROOM.x0, ROOM.y0, ROOM.x0, ROOM.y1, ROOM.x0 - 12, ROOM.y1];
  const SEC = ["S4", "S7", "S9"], RES = ["crew", "material", "water"], ITEMS = ["crew", "material", "water", "order", "notice"];
  const LAYER_KEYS = ["ledger", "preconditions", "completion", "retry"];
  const SECTOR = {
    S4: { name: "Hospital", letter: "H", cloth: "#E4EEF6", ink: "#D6453D" },
    S7: { name: "Residencia", letter: "R", cloth: "#A9D3B4", ink: "#2E7D4F" },
    S9: { name: "Colegio", letter: "C", cloth: "#F7C58A", ink: "#B5651D" },
  };
  const BAY = { crew: -205, material: -75, water: 55 }, BAY_Y = -178, SLOT = { S4: -36, S7: 0, S9: 36 };
  const STOVE_X = -300, ROW = { S4: -70, S7: 0, S9: 70 };
  const PASS_Y = 100, TABLE_Y = 166, COL = { S4: -110, S7: 0, S9: 110 };
  const DESK = { x: 268, y: -62 }, HOME = { x: -20, y: -24 }, ENTRY = [352, 150, 30];
  const GATES = { stove: { a: [-262, -108], b: [-262, 108] }, pass: { a: [-170, 72], b: [170, 72] } };
  const MECH = { stove: [-262, 0, 44], pass: [0, 72, 44], door: [258, -207, 62], spike: [DESK.x, -36, 64], rail: [-328, 0, 80], esd: [308, -209, 58] };
  const SHAPE = {
    fridge: rbox(58, 56, 5), bay: rbox(112, 48, 5), bayBack: box(112, 6), stove: rbox(54, 68, 4), hob: box(46, 60),
    pass: box(110, 28), passTop: box(112, 32), desk: rbox(40, 84, 4), page: box(24, 21), leaf: [0, 0, 54, 0, 54, 4, 0, 4],
    handle: box(17, 4.2), receipt: box(11, 11),
  };
  const PROF = {
    tomato: [[0, 6], [2.5, 10], [6, 11.5], [10, 11], [13.5, 8.5], [16, 4.5]], stem: [[0, 3.4], [1.4, 1.3], [4, 1]],
    cheese: [[0, 10.5], [1.5, 11.5], [8, 11.5], [9.5, 10.5]],
    jug: [[0, 8], [1, 9], [12, 9], [15, 6.5], [17, 3.6], [20, 3.6]], cap: [[0, 4.3], [3, 4.3]],
    pan: [[0, 11.5], [1.2, 13.5], [5, 14.5]], bell: [[0, 6.5], [1, 7], [4, 5.6], [6, 3.2], [7.5, 1.3]], knob: [[0, 1.5], [2.2, 1.5]],
    pedestal: [[0, 11], [2, 11], [4, 3.6], [22, 3.6], [24, 9]], tabletop: [[0, 30], [3.2, 30]],
    plate: [[0, 7.5], [1.1, 11.5], [2, 12.6]], bite: [[0, 3.7], [1.8, 3.4], [3.5, 1.8]],
    stool: [[0, 7], [1.2, 7], [2.4, 2.2], [12, 2.2], [13, 8], [15.5, 8]],
    post: [[0, 3.6], [2, 2.6], [44, 2.6], [45.5, 3.8], [49, 3.8]], spike: [[0, 6.5], [1.6, 6.5], [3, 2.2]],
    head: [[0, 6], [3, 8.6], [8, 9.6], [13, 9.1], [17, 7.2], [20, 4.2]],
    capHat: [[0, 9.8], [5, 9.6], [7.5, 7.6]], toque: [[0, 9.4], [4, 9.4], [4.01, 8.7], [17, 9.7], [20, 12.4], [25, 12.8], [28, 10.6], [30, 7]],
    orb: [[0, 1.5], [1.5, 4], [4, 5], [6.5, 4], [8, 1.5]],
  };

  // ---------- de la herramienta al puesto de la cocina
  function target(tool, args) {
    args = args || {};
    const id = T.depotFor(tool, { args });
    let sector = args.sector;
    if (!sector && args.reservation_id) sector = String(args.reservation_id).split("-")[1];
    if (!SECTOR[sector]) sector = null;
    if (id in BAY) { const x = BAY[id] + (sector ? SLOT[sector] : 0); return { id, sector, sx: x, sy: -128, face: -Math.PI / 2, ax: x, ay: BAY_Y + 3, az: 64 }; }
    if (id === "order") { const y = sector ? ROW[sector] : 0; return { id, sector, sx: -250, sy: y, face: Math.PI, ax: STOVE_X, ay: y, az: 64 }; }
    if (id === "notice") { const x = sector ? COL[sector] : 0; return { id, sector, sx: x, sy: 60, face: Math.PI / 2, ax: x, ay: PASS_Y, az: 58 }; }
    if (tool === "close_mission") return { id: "close", door: true, sx: 258, sy: -162, face: -Math.PI / 2, ax: 258, ay: -207, az: 104 };
    if (tool === "lookup_operation") return { id: "close", sx: 224, sy: -40, face: 0, ax: DESK.x, ay: -36, az: 74 };
    return { id: "close", sx: 224, sy: -80, face: 0, ax: DESK.x, ay: -80, az: 62 };
  }
  const RES_ES = { crew: "cuadrilla", material: "material", water: "cisterna" };
  function toolEs(tool, a) {
    a = a || {};
    const rid = String(a.reservation_id || "").split("-"), s = SECTOR[a.sector] || SECTOR[rid[1]], w = s ? ` · ${s.name}` : "";
    switch (tool) {
      case "get_options": return "leer la comanda y lo disponible";
      case "reserve_resource": return `pedir ${RES_ES[a.resource] || "ingrediente"}${w}`;
      case "check_reservation": return `mirar si ha llegado ${RES_ES[rid[2]] ? "la " + RES_ES[rid[2]].replace("material", "partida de material") : "el ingrediente"}${w}`;
      case "list_records": return `consultar la pizarra${w}`;
      case "create_work_order": return `poner el plato al fuego${w}`;
      case "send_notice": return `servir el plato${w}`;
      case "lookup_operation": return "buscar el ticket";
      case "close_mission": return "cerrar la cocina";
      default: return String(tool).replace(/_/g, " ");
    }
  }
  const LABELS = { CONFIRMED: "Confirmado", PENDING: "No ha llegado · pendiente", CREATED: "Al fuego · orden creada", SENT: "Servido · aviso enviado",
    CLOSED: "Cocina cerrada · cierre registrado", DELIVERY_UNKNOWN: "¿Oído? · respuesta perdida", FOUND: "Ticket encontrado", OK: "Leído",
    REJECTED: "Rechazado", NOT_FOUND: "Sin ticket", CANCELLED: "Cancelado por el proveedor", REPLACED: "Sustituido", BLOCKED_BY_PLATFORM: "Detenido" };
  const TONE_OF = { CONFIRMED: "ok", CREATED: "ok", SENT: "ok", CLOSED: "ok", FOUND: "ok", PENDING: "warn", DELIVERY_UNKNOWN: "warn",
    REJECTED: "risk", NOT_FOUND: "warn", CANCELLED: "risk", BLOCKED_BY_PLATFORM: "dark" };
  const ICON = { get_options: "book", list_records: "book", reserve_resource: "dot", check_reservation: "mag", create_work_order: "pan",
    send_notice: "plate", lookup_operation: "ticket", close_mission: "lock" };
  const ON_NAME = { ledger: "Registro de progreso", preconditions: "Guarda de escrituras", completion: "Cierre verificado", retry: "Reintento seguro" };
  const CHIP = { ledger: "Registro", preconditions: "Guarda", completion: "Cierre", retry: "Reintento" };
  const blank = () => ({ close: "open", sec: Object.fromEntries(SEC.map((s) => [s, { crew: "open", material: "open", water: "open", order: "open", notice: "open", orders: 0, notices: 0, slot: null }])) });

  // ---------- el componente (misma interfaz que la planta P&ID)
  class Plant {
    constructor(host, hud, ticker, model) {
      this.host = host; this.hud = hud; this.ticker = ticker;
      host.innerHTML = "";
      const cv = this.cv = document.createElement("canvas");
      cv.setAttribute("role", "img");
      cv.setAttribute("aria-label", "Cocina del agente. El cocinero es el modelo, la despensa es el contexto y la organización de la cocina es el harness. El resultado de cada paso se lee en el texto bajo la escena.");
      cv.style.cssText = "position:absolute;display:block;touch-action:pan-y;cursor:grab";
      try { if (getComputedStyle(host).position === "static") host.style.position = "relative"; } catch (e) { /* sin estilos calculados */ }
      this._bg = host.style.background || "";
      host.appendChild(cv);
      this.ctx = cv.getContext("2d"); this.cam = new Cam();
      this.side = "good"; this.lane = "good"; this.layers = {}; this.on = {};
      this.epoch = 0; this.queue = []; this.running = false; this.calls = {};
      this.states = {}; this.turns = {}; this.lastEvents = {}; this.snapshots = {}; this.controls = {};
      this.turn = freshTurn(); this.model = String(model || ""); this.star = Plant.STAR.test(this.model);
      this.clock = 0; this.tweens = []; this.yaw = .45; this.doorK = 0; this.hl = null;
      this.chef = { x: HOME.x, y: HOME.y, a: Math.PI / 2, ta: Math.PI / 2, phase: 0, moving: false, think: false, work: -1e6, icon: null, iconUntil: 0, walkId: 0 };
      this.since = {}; this.world = blank(); this.resetFx();
      const h3 = hud && hud.querySelector("h3"); if (h3) h3.textContent = "Cocina del agente";
      try {                                        // si la página trae la leyenda de la demo, el harness usa ese mismo color
        const el = document.querySelector(".plant-legend .lg.harn"), cs = el && getComputedStyle(el), col = cs && (toHex(cs.backgroundColor) || toHex(cs.borderTopColor));
        if (col && luma(col) < .5) { C.harness = col; TONE.v.bg = col; }
      } catch (e) { /* paleta por defecto */ }
      this.bind(); this.resize(); this.renderHud(); this.loop();
    }
    resetFx() {
      this.callouts = []; this.rings = []; this.orbs = []; this.flying = []; this.coins = []; this.papers = []; this.confetti = [];
      this.gate = { stove: { held: false, t: -1e6, scan: -1e6 }, pass: { held: false, t: -1e6, scan: -1e6 }, door: { held: false, t: -1e6, scan: -1e6 } };
      this.fired = { ledger: -1e6, preconditions: -1e6, completion: -1e6, retry: -1e6, esd: -1e6 }; this.firedN = {};
      this.bell = {}; this.ledgerOpen = null; this.keys = 0; this.esd = false; this.banner = null; this.proposal = null;
    }
    bind() {
      const cv = this.cv; let drag = null;
      const end = () => { drag = null; cv.style.cursor = "grab"; };
      cv.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, yaw: this.yaw }; if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; });
      cv.addEventListener("pointermove", (e) => { if (drag) this.yaw = clamp(drag.yaw - (e.clientX - drag.x) * .005, .16, .86); });
      cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
      cv.addEventListener("dblclick", async () => {
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else if (this.host.requestFullscreen) await this.host.requestFullscreen();
        } catch (e) {
          console.warn("Pantalla completa:", e);
          this.say("No se pudo abrir la pantalla completa. Puedes seguir usando la cocina en este panel.");
        }
      });
      document.addEventListener("fullscreenchange", () => { this.host.style.background = document.fullscreenElement === this.host ? "#F7F5F0" : this._bg; this.resize(); });
      if (typeof ResizeObserver === "function") new ResizeObserver(() => this.resize()).observe(this.host);
      else window.addEventListener("resize", () => this.resize());
      setInterval(() => { if (document.hidden) this.tick(250); }, 250);   // sin pintado, la cola no se queda parada
    }
    resize() {                                   // encaja 960×600 en el hueco que le dé la página, centrado; si no tiene alto, se lo da
      const host = this.host, cv = this.cv, W = host.clientWidth || 0;
      if (!W) return;                              // panel oculto: se recalcula al mostrarse
      let Hh = host.clientHeight || 0;
      if (Hh < W * .22) { host.style.aspectRatio = "960 / 600"; Hh = host.clientHeight || W * .625; }   // el lienzo no ocupa sitio: sin alto propio, el hueco toma la proporción de la escena
      const w = Math.min(W, Hh * 1.6), h = w * .625, dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.style.width = `${w}px`; cv.style.height = `${h}px`; cv.style.left = `${(W - w) / 2}px`; cv.style.top = `${Math.max(0, (Hh - h) / 2)}px`;
      const pw = Math.round(w * dpr), ph = Math.round(pw * .625);
      if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    }
    loop() {
      let last = 0, painted = 0;
      const frame = (ts) => {
        const dt = last ? Math.min(60, ts - last) : 16; last = ts;
        this.tick(dt);
        const interval = !mq.matches && (this.running || this.tweens.length || this.turn.status === "run") ? 1000 / 30 : 500;
        if (!document.hidden && this.host.getClientRects().length && ts - painted >= interval) {
          painted = ts;
          try { this.draw(); } catch (e) {
            if (!this._warned) {
              this._warned = true; console.error("Cocina del agente:", e);
              this.say("No se pudo dibujar la cocina. Consulta la ejecución en Operaciones.");
            }
          }
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }
    speed() { return this.fastForward || mq.matches || document.hidden ? 100000 : Math.min(6, 1 + this.queue.length * .3); }
    tween(ms, fn) {
      const sp = this.speed();
      if (sp > 100 || ms <= 0) { if (fn) fn(1); return Promise.resolve(); }
      return new Promise((resolve) => this.tweens.push({ t0: this.clock, dur: ms / sp, fn, resolve }));
    }
    wait(ms) { return this.tween(ms); }
    tick(dt) {
      this.clock += dt;
      const ch = this.chef, hidden = document.hidden;
      if (ch.moving) ch.phase += dt * .017;
      const da = Math.atan2(Math.sin(ch.ta - ch.a), Math.cos(ch.ta - ch.a)); ch.a += da * Math.min(1, dt * .013);
      const door = this.world.close === "open" ? 0 : 1;
      this.doorK = mq.matches ? door : this.doorK + (door - this.doorK) * Math.min(1, dt * .006);
      if (this.turn.status === "run") {
        this.turn.elapsed = nowMs() - this.turn.started;
        if ((this._hud = (this._hud || 0) + dt) > 100) { this._hud = 0; this.renderHud(); }
      }
      if (this.tweens.length) {
        const list = this.tweens; this.tweens = [];
        for (const tw of list) {
          const p = hidden || this.speed() > 100 ? 1 : (this.clock - tw.t0) / tw.dur;
          if (tw.fn) tw.fn(p >= 1 ? 1 : p);
          if (p >= 1) tw.resolve(); else this.tweens.push(tw);
        }
      }
    }
    cancel() {
      this.epoch++; this.queue = []; this.running = false; this.calls = {};
      const list = this.tweens; this.tweens = []; for (const tw of list) tw.resolve();
      Object.assign(this.chef, { moving: false, think: false, icon: null });
      this.callouts = []; this.orbs = []; this.flying = []; this.coins = []; this.papers = []; this.rings = [];
    }
    configure(side, layers, lane = side, modelLabel = null) {
      this.cancel(); this.side = side; this.lane = lane; this.layers = { ...layers };
      for (const k of LAYER_KEYS) this.on[k] = side === "excellent" && !!this.layers[k];
      this.turn = { ...(this.turns[lane] || freshTurn()) };
      if (modelLabel) { this.model = String(modelLabel); this.star = Plant.STAR.test(this.model); }
      this.resetFx();
      const controls = this.controls[lane];
      if (controls) {
        this.firedN = { ...controls.firedN }; this.keys = controls.keys; this.ledgerOpen = controls.ledgerOpen;
      }
      this.esd = this.turn.status === "stop";
      this.applyState(this.states[lane], true);
      this.banner = ["verified", "risk", "pending", "stop"].includes(this.turn.status) ? { status: this.turn.status, t0: -1e6 } : null;
      Object.assign(this.chef, { x: HOME.x, y: HOME.y, ta: Math.PI / 2 });
      this.renderHud(); this.say("");
    }
    resetAll() { this.cancel(); this.states = {}; this.turns = {}; this.lastEvents = {}; this.snapshots = {}; this.controls = {}; }
    beginTurn() {
      this.snapshots[this.lane] = this.states[this.lane] ? clone(this.states[this.lane]) : null;
      this.lastEvents[this.lane] = [];
    }
    push(e, record = true) {
      if (record) (this.lastEvents[this.lane] = this.lastEvents[this.lane] || []).push(e);
      this.queue.push(e); this.run();
    }
    async run() {
      if (this.running) return;
      this.running = true;
      const epoch = this.epoch;
      try {
        while (this.queue.length && epoch === this.epoch) await this.handle(this.queue.shift(), epoch);
      } catch (e) {
        console.error("Animación de la cocina:", e);
        this.say("Error de visualización. La evidencia completa sigue en Operaciones.");
      } finally {
        if (epoch === this.epoch) { this.running = false; this.renderHud(); }
      }
    }
    async drain() {
      const end = Date.now() + 9000;
      while ((this.queue.length || this.running) && Date.now() < end) await new Promise((r) => setTimeout(r, 60));
      if (this.queue.length || this.running) {
        this.fastForward = true; this.tick(0);
        try {
          while (this.queue.length || this.running) await new Promise((r) => setTimeout(r, 0));
        } finally {
          this.fastForward = false;
        }
      }
    }
    canReplay() { return (this.lastEvents[this.lane] || []).length > 0 && !this.running; }
    replay() {
      if (!this.canReplay()) return;
      const events = this.lastEvents[this.lane].slice();
      this.cancel(); this.resetFx(); this.applyState(this.snapshots[this.lane], true);
      Object.assign(this.chef, { x: HOME.x, y: HOME.y, ta: Math.PI / 2 });
      events.forEach((e) => this.push(e, false));
    }
    renderHud() {
      const t = this.turn, hud = this.hud; if (!hud) return;
      const set = (k, v) => { const el = hud.querySelector(`[data-h=${k}]`); if (el) el.textContent = v; return el; };
      const label = { idle: "En espera", run: "En marcha", stop: "Detenido", verified: "Verificado", pending: "Pendiente", risk: "Incumplimiento" }[t.status];
      const st = set("status", label); if (st) st.className = `hud-status ${t.status === "run" ? "run" : t.status === "stop" ? "stop" : ""}`;
      set("time", t.elapsed ? `T+ ${(t.elapsed / 1000).toFixed(1).replace(".", ",")} s` : "T+ —");
      set("tok", t.tin ? `${t.tin.toLocaleString("es-ES")} → ${t.tout.toLocaleString("es-ES")} tokens` : "Cocinero · —");
      set("plan", `Evidencia ${t.done}/${t.total}`);
      const rp = hud.querySelector("[data-h=replay]"); if (rp) rp.disabled = !this.canReplay() || t.status === "run";
    }
    /* Hechos de los sistemas (el mismo juez de la demo) → lo que hay en despensa, fogones y mesas. */
    applyState(a, quiet) {
      quiet = quiet || mq.matches;
      this.states[this.lane] = a ? clone(a) : null;
      const prev = this.world, w = blank();
      if (a) {
        for (const sec of a.sectors || []) {
          const s = w.sec[sec.id]; if (!s) continue;
          s.slot = sec.slot || null;
          for (const it of sec.items || []) {
            if (!ITEMS.includes(it.id)) continue;
            s[it.id] = it.status;
            if (it.id === "order") s.orders = parseInt(it.detail, 10) || 0;
            if (it.id === "notice") s.notices = parseInt(it.detail, 10) || 0;
          }
        }
        if (!a.sectors) for (const r of a.rows || []) {      // sin detalle por sector: se reparte por recuento
          const n = parseInt(r.detail, 10) || 0;
          if (ITEMS.includes(r.id)) SEC.forEach((s, i) => { w.sec[s][r.id] = i < n ? "confirmed" : r.status === "risk" ? "risk" : r.status === "pending" ? "pending" : "open"; });
        }
        const close = (a.rows || []).find((r) => r.id === "close");
        w.close = close ? (close.ok ? "ok" : close.status === "risk" ? "risk" : "open") : "open";
      }
      for (const s of SEC) for (const k of ITEMS) {
        const was = prev.sec[s], now = w.sec[s];
        if (was[k] === now[k] && was.orders === now.orders && was.notices === now.notices) continue;
        if (was[k] !== now[k] || k === "order" || k === "notice") this.since[s + k] = quiet ? -1e6 : this.clock;
        if (!quiet && RES.includes(k) && now[k] === "risk" && was[k] !== "risk" && was[k] !== "open") {
          this.callout([BAY[k] + SLOT[s], BAY_Y + 3, 66], "El proveedor cancela sin avisar", "risk");
          this.ring(BAY[k] + SLOT[s], BAY_Y + 3, 31, C.risk);
        }
      }
      this.world = w;
      if (quiet) this.doorK = w.close === "open" ? 0 : 1;
      this.turn.done = (a && a.done) || 0; this.turn.total = (a && a.total) || 16;
      this.renderHud();
    }
    highlight(id) { this.hl = id || null; }
    say(t) { if (this.ticker) this.ticker.textContent = t; if (this.onSay) this.onSay(t); }

    // ---------- efectos
    callout(p, text, tone) { if (!mq.matches) this.callouts.push({ p, text: String(text).slice(0, 60), tone: tone || "", t0: this.clock, ttl: 2300 / Math.min(2, this.speed()) }); }
    ring(x, y, z, col) { if (!mq.matches) this.rings.push({ x, y, z: z || .4, col, t0: this.clock }); }
    walkTo(x, y, face) {
      const ch = this.chef, x0 = ch.x, y0 = ch.y, dist = Math.hypot(x - x0, y - y0), id = ++ch.walkId;
      if (dist < 2) { ch.ta = face; ch.work = this.clock; return Promise.resolve(); }
      ch.moving = true; ch.ta = Math.atan2(y - y0, x - x0);
      return this.tween(clamp(dist * 2, 280, 900), (p) => {
        if (id !== ch.walkId) return;
        const e = easeIO(p); ch.x = lerp(x0, x, e); ch.y = lerp(y0, y, e);
        if (p >= 1) { ch.moving = false; ch.ta = face; ch.work = this.clock; }
      });
    }
    /* Comprobación del harness: una luz de la propia cocina va al puesto. No es otro cocinero. */
    scan(st, tool) {
      const key = tool === "lookup_operation" ? "spike" : { create_work_order: "stove", send_notice: "pass", close_mission: "door" }[this.proposal] || "rail";
      if (this.gate[key]) this.gate[key].scan = this.clock;
      const from = MECH[key], o = { x: from[0], y: from[1], z: from[2], pulse: -1e6, a: 1 };
      this.orbs.push(o);
      return this.tween(300, (p) => {
        const e = easeIO(p);
        o.x = lerp(from[0], st.ax, e); o.y = lerp(from[1], st.ay, e); o.z = lerp(from[2], st.az - 18, e) + Math.sin(p * Math.PI) * 24;
      }).then(() => o);
    }
    orbDone(o) { o.pulse = this.clock; this.tween(320, (p) => { o.a = 1 - p; if (p >= 1) this.orbs = this.orbs.filter((x) => x !== o); }); }
    serve(sector) {
      const x = COL[sector], pl = { x, y: PASS_Y, z: 34, sector };
      this.flying.push(pl);
      return this.tween(460, (p) => {
        const e = easeIO(p); pl.y = lerp(PASS_Y, TABLE_Y + 7, e); pl.z = lerp(34, 28, e) + Math.sin(p * Math.PI) * 30;
        if (p >= 1) this.flying = this.flying.filter((q) => q !== pl);
      });
    }
    paper(from, to, col) {
      const o = { p: from.slice(), col, t0: this.clock };
      this.papers.push(o);
      this.tween(560, (p) => {
        const e = easeIO(p);
        o.p = [lerp(from[0], to[0], e), lerp(from[1], to[1], e), lerp(from[2], to[2], e) + Math.sin(p * Math.PI) * 40];
        if (p >= 1) this.papers = this.papers.filter((q) => q !== o);
      });
    }
    spend(c) {
      if (mq.matches) return;
      const n = clamp(Math.round(c / .0007), 1, 6);
      for (let i = 0; i < n; i++) this.coins.push({ t0: this.clock + i * 70, x: this.chef.x, y: this.chef.y });
    }
    party() {
      if (mq.matches) return;
      const cols = [C.crew, C.material, C.water, C.ok, C.harness, C.gold];
      for (let i = 0; i < 90; i++) this.confetti.push({ x: 180 + Math.random() * 600, y: -20 - Math.random() * 160, vx: (Math.random() - .5) * 90, vy: 120 + Math.random() * 160, r: Math.random() * TAU, w: 4 + Math.random() * 4, col: cols[i % cols.length], t0: this.clock });
    }

    // ---------- eventos de la ejecución (los mismos que recibía la planta)
    async handle(e, epoch) {
      const d = e.data || {}, live = () => epoch === this.epoch, ch = this.chef, above = () => [ch.x, ch.y, 118];
      if (e.type === "turn.start") {
        this.turn = freshTurn(); this.turn.status = "run"; this.turn.started = nowMs();
        this.esd = false; this.banner = null; this.confetti = []; this.keys = 0; this.firedN = {};
        for (const g of Object.values(this.gate)) g.held = false;
        this.say("Entra la comanda");
        this.paper(ENTRY, [ch.x, ch.y, 70], C.paper);
        return this.wait(260);
      }
      if (e.type === "mission.state") { this.applyState(d); return; }
      if (e.type === "ledger") { this.ledgerOpen = d.open; return; }
      if (e.type === "inference.start" && d.purpose === "executor") { ch.think = true; this.say("El cocinero decide el siguiente paso"); return; }
      if (e.type === "inference.end" && d.purpose === "executor") {
        ch.think = false;
        this.turn.tin += d.tokens_in; this.turn.tout += d.tokens_out; this.turn.last = d.ms;
        const c = Plant.price(this.model, d.tokens_in, d.tokens_out); this.turn.cost += c; this.spend(c);
        this.renderHud(); return;
      }
      if (e.type === "model.proposal") {
        this.proposal = d.tool;
        ch.icon = { k: ICON[d.tool] || "dot", col: d.tool === "reserve_resource" && C[(d.args || {}).resource] ? C[d.args.resource] : C.ink }; ch.iconUntil = this.clock + 1500;
        this.say(`El cocinero propone: ${toolEs(d.tool, d.args)} (${d.tool})`);
        if (d.tool === "close_mission") this.callout(above(), "Propone cerrar la cocina");
        return this.wait(200);
      }
      if (e.type === "tool.start") {
        const st = target(d.tool, d.args), harness = d.actor === "harness";
        this.calls[e.span_id] = { st, harness, p: harness ? this.scan(st, d.tool) : this.walkTo(st.sx, st.sy, st.face) };
        this.say(`${harness ? "La cocina comprueba" : "Cocinero"} → ${toolEs(d.tool, d.args)} (${d.tool})`);
        return this.wait(harness ? 60 : 150);
      }
      if (e.type === "tool.end") {
        const call = this.calls[d.call_span], orb = call ? await call.p : null;
        if (!live()) return;
        delete this.calls[d.call_span];
        const st = call ? call.st : target(d.tool, d.args), harness = call ? call.harness : d.actor === "harness";
        const at = [st.ax, st.ay, st.az], out = d.outcome, bad = out === "PENDING" || out === "REJECTED" || out === "NOT_FOUND" || out === "CANCELLED";
        if (harness && orb) this.orbDone(orb);
        if (out === "DELIVERY_UNKNOWN") {
          if (st.sector) this.bell[st.sector] = this.clock;
          this.ring(st.sx, st.sy, .4, C.warn); this.callout(at, LABELS[out], "warn");
          this.say("La comanda ha entrado, pero nadie ha contestado «oído»: el resultado es incierto");
          return this.wait(550);
        }
        if (d.tool === "lookup_operation" && out === "FOUND") {
          this.fired.retry = this.clock; this.callout(at, "Ticket encontrado · no se repite", harness ? "v" : "ok");
        } else if (!harness && d.tool === "send_notice" && out === "SENT" && st.sector) {
          this.callout(at, LABELS.SENT, "ok"); this.bell[st.sector] = this.clock;
          await this.serve(st.sector);
          if (!live()) return;
        } else if (!harness || bad) {
          if (!harness) this.ring(st.sx, st.sy, .4, bad ? C.warn : C.ok);
          this.callout(at, LABELS[out] || out, harness && out === "PENDING" ? "v" : TONE_OF[out] || "");
        }
        return this.wait(harness ? 50 : 200);
      }
      if (e.type === "harness.control") {
        const layer = d.layer, out = e.outcome, detail = String(d.detail || "");
        if (layer in ON_NAME) { this.fired[layer] = this.clock; this.firedN[layer] = (this.firedN[layer] || 0) + 1; }
        if (layer === "preconditions") {
          const notice = this.proposal === "send_notice" || /^Aviso/.test(detail), g = this.gate[notice ? "pass" : "stove"];
          g.held = out === "block"; g.t = this.clock; g.out = out;
          if (out === "block") this.callout(MECH[notice ? "pass" : "stove"], notice ? "Aviso retenido · el plato no sale" : "Orden retenida · aún no va al fuego", "v");
        } else if (layer === "completion") {
          const g = this.gate.door; g.held = out === "block"; g.t = this.clock; g.out = out;
          if (out === "block") this.callout(MECH.door, "Falta evidencia · la cocina no cierra", "v");
          if (out === "flag") { this.callout(above(), "Trabajo devuelto al cocinero", "v"); this.paper(MECH.door, [ch.x, ch.y, 70], C.harness); }
        } else if (layer === "ledger") {
          if (out === "block") this.callout(MECH.rail, "Bucle detectado", "v");
        } else if (layer === "retry") {
          if (out === "info") this.keys++;
          if (out === "flag") this.callout(MECH.spike, "Respuesta perdida · se mira el ticket", "v");
        } else { this.fired.esd = this.clock; if (out === "block") this.callout(MECH.esd, d.label || "Plataforma", "dark"); }
        this.say(`${d.label}: ${detail}`);
        return this.wait(out === "block" ? 600 : 140);
      }
      if (e.type === "governance.decision") {
        this.esd = true; this.turn.status = "stop"; this.say(`Plataforma: ${d.code}`);
        this.callout(MECH.esd, d.code, "dark"); return this.wait(500);
      }
      if (e.type === "budget.exhausted") { this.callout(above(), "Límite alcanzado", "dark"); if (d.message) this.say(d.message); return; }
      if (e.type === "turn.end") {
        ch.think = false;
        const t = this.turn;
        t.status = e.outcome === "blocked" ? "stop" : d.outcome === "verificado" ? "verified" : d.outcome === "incumplimiento" ? "risk" : "pending";
        t.elapsed = (d.usage && d.usage.latency_ms) || nowMs() - t.started;
        if (d.usage && d.usage.cost_usd != null) t.cost = d.usage.cost_usd;
        this.turns[this.lane] = { ...t };
        this.controls[this.lane] = { firedN: { ...this.firedN }, keys: this.keys, ledgerOpen: this.ledgerOpen };
        this.say(t.status === "verified" ? "Servicio verificado: la misión consta cumplida en los sistemas" : t.status === "risk"
          ? "Los sistemas registran un incumplimiento" : t.status === "stop" ? "Detenido por la plataforma" : "Servicio pendiente; consulta la evidencia");
        this.banner = { status: t.status, t0: mq.matches ? this.clock - 5000 : this.clock };
        if (t.status === "verified") this.party();
        this.paper([ch.x, ch.y, 70], ENTRY, C.paper);
        await this.walkTo(HOME.x, HOME.y, Math.PI / 2);
        if (live()) this.renderHud();
      }
    }

    // ---------- pintado
    draw() {
      const ctx = this.ctx, cam = this.cam, t = mq.matches ? 0 : this.clock / 1000;
      cam.px = this.cv.width / 960;
      cam.set(this.yaw + (mq.matches ? 0 : Math.sin(t * .22) * .09));
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.cv.width, this.cv.height);
      ctx.globalAlpha = 1; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
      this.drawRoom(ctx, cam, t);
      const N = [], add = (x, y, f) => N.push({ d: cam.depth(x, y), f });
      add(-297, -180, () => this.drawFridge(ctx, cam));
      for (const r of RES) add(BAY[r], BAY_Y, () => this.drawBay(ctx, cam, r, t));
      for (const s of SEC) {
        add(STOVE_X, ROW[s], () => this.drawStove(ctx, cam, s, t));
        add(COL[s], PASS_Y, () => this.drawPass(ctx, cam, s, t));
        add(COL[s], TABLE_Y, () => this.drawTable(ctx, cam, s, t));
        for (const q of [[-24, 30], [26, 27]]) add(COL[s] + q[0], TABLE_Y + q[1], () => lathe(ctx, cam, COL[s] + q[0], TABLE_Y + q[1], 0, PROF.stool, C.wood, { top: C.woodLight }));
      }
      add(DESK.x, DESK.y, () => this.drawDesk(ctx, cam, t));
      const pc = this.on.preconditions ? C.harness : C.off;
      for (const G of Object.values(GATES)) for (const p of [G.a, G.b]) add(p[0], p[1], () => lathe(ctx, cam, p[0], p[1], 0, PROF.post, pc, { top: shade(pc, 1.3) }));
      add(this.chef.x, this.chef.y, () => this.drawChef(ctx, cam, t));
      N.sort((a, b) => a.d - b.d);
      for (const n of N) n.f();
      this.drawFx(ctx, cam, t); this.drawLabels(ctx, cam, t); this.drawChefUi(ctx, cam, t); this.drawCallouts(ctx, cam); this.drawHud(ctx, cam, t);
    }
    drawRoom(ctx, cam, t) {
      const R = ROOM, wy = R.y0 + .3, wx = R.x0 + .3;
      cam.ground(ctx, 8, 10, -44, 0);
      for (let i = 1; i <= 3; i++) { rr(ctx, R.x0 - i * 10, R.y0 - i * 10, 660 + i * 20, 420 + i * 20, 16 + i * 8); ctx.fillStyle = "rgba(56,62,84,.05)"; ctx.fill(); }
      prism(ctx, cam, FLOOR, 0, 0, 0, -13, 0, C.floorSide, C.floorA);
      cam.ground(ctx, 0, 0, 0, 0);
      ctx.beginPath();
      for (let r = 0; r < 8; r++) for (let c = 0; c < 15; c++) if ((r + c) & 1) ctx.rect(R.x0 + c * 44, R.y0 + r * 42, 44, 42);
      ctx.fillStyle = C.floorB; ctx.fill();
      ctx.beginPath(); ctx.rect(R.x0, 126, 660, 84); ctx.fillStyle = C.plank; ctx.fill();
      ctx.beginPath();
      for (let i = 1; i < 4; i++) { ctx.moveTo(R.x0, 126 + i * 21); ctx.lineTo(R.x1, 126 + i * 21); }
      for (let i = 0; i < 16; i++) { const x = R.x0 + 20 + i * 42, y = 126 + (i % 4) * 21; ctx.moveTo(x, y); ctx.lineTo(x, y + 21); }
      ctx.strokeStyle = C.plankLine; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = `800 15px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(43,51,64,.24)";
      ctx.fillText("DESPENSA · EL CONTEXTO", -75, -110); ctx.fillText("EL PASE · LOS AVISOS", 0, 22);
      ctx.fillStyle = "rgba(120,78,34,.42)"; ctx.fillText("SALA", 262, 172);
      cam.ground(ctx, -232, 0, 0, -Math.PI / 2);
      ctx.fillStyle = "rgba(43,51,64,.24)"; ctx.fillText("FOGONES · LAS ÓRDENES", 0, 0);
      // paredes del fondo
      for (const Wl of [WALL_W, WALL_N]) {
        prism(ctx, cam, Wl, 0, 0, 0, 0, 36, C.wallLo, null); prism(ctx, cam, Wl, 0, 0, 0, 36, 40, C.trim, null); prism(ctx, cam, Wl, 0, 0, 0, 40, R.h, C.wallHi, C.wallTop);
      }
      // ventana
      quad3(ctx, cam, [[124, wy, 42], [200, wy, 42], [200, wy, 94], [124, wy, 94]], C.woodDark);
      cam.screen(ctx);
      const g = ctx.createLinearGradient(0, cam.Y(162, wy, 90), 0, cam.Y(162, wy, 46)); g.addColorStop(0, "#9FD3F2"); g.addColorStop(1, "#E6F5FC");
      quad3(ctx, cam, [[129, wy, 47], [195, wy, 47], [195, wy, 89], [129, wy, 89]], g);
      line3(ctx, cam, [162, wy, 47], [162, wy, 89], C.woodDark, 2); line3(ctx, cam, [129, wy, 68], [195, wy, 68], C.woodDark, 2);
      // puerta: se cierra cuando el expediente se cierra
      const close = this.world.close, lamp = close === "ok" ? C.ok : close === "risk" ? C.risk : "#8A93A0";
      quad3(ctx, cam, [[228, wy, 0], [288, wy, 0], [288, wy, 90], [228, wy, 90]], C.woodDark);
      quad3(ctx, cam, [[231, wy, 0], [285, wy, 0], [285, wy, 87], [231, wy, 87]], "#353B48");
      quad3(ctx, cam, [[240, wy, 93], [276, wy, 93], [276, wy, 102], [240, wy, 102]], lamp);
      const ang = lerp(1.2, 0, easeIO(clamp(this.doorK, 0, 1)));
      prism(ctx, cam, SHAPE.leaf, 231, R.y0 + .6, ang, 1, 86, C.door, shade(C.door, 1.12));
      cam.screen(ctx); ctx.beginPath(); ctx.arc(cam.X(231 + Math.cos(ang) * 46 - Math.sin(ang) * 5, R.y0 + .6 + Math.sin(ang) * 46 + Math.cos(ang) * 5), cam.Y(231 + Math.cos(ang) * 46 - Math.sin(ang) * 5, R.y0 + .6 + Math.sin(ang) * 46 + Math.cos(ang) * 5, 42), 2.4, 0, TAU); ctx.fillStyle = C.gold; ctx.fill();
      if (close === "risk" && this.doorK > .9) { line3(ctx, cam, [233, R.y0 + 5.2, 12], [283, R.y0 + 5.2, 76], C.risk, 3.4); line3(ctx, cam, [233, R.y0 + 5.2, 76], [283, R.y0 + 5.2, 12], C.risk, 3.4); }
      if (close === "ok" && this.doorK > .9) { const X = cam.X(258, R.y0 + 5.2), Y = cam.Y(258, R.y0 + 5.2, 46); cam.screen(ctx); ctx.beginPath(); ctx.arc(X, Y, 11, 0, TAU); ctx.fillStyle = C.ok; ctx.fill(); glyph(ctx, "check", X, Y, 13, "#fff"); }
      // interruptor general (plataforma)
      quad3(ctx, cam, [[300, wy, 46], [316, wy, 46], [316, wy, 68], [300, wy, 68]], "#4A5260");
      cam.screen(ctx); ctx.beginPath(); ctx.arc(cam.X(308, wy), cam.Y(308, wy, 59), 3, 0, TAU); ctx.fillStyle = this.esd ? (Math.sin(t * 9) > 0 ? C.risk : "#7A1F1F") : C.ok; ctx.fill();
      // riel de comandas (registro de progreso)
      const on = this.on.ledger, hot = this.clock - this.fired.ledger < 700;
      line3(ctx, cam, [wx, -98, 80], [wx, 98, 80], on ? C.steel : C.off, 3);
      for (const y of [-98, 98]) line3(ctx, cam, [wx, y, 80], [wx, y, 87], on ? C.steel : C.off, 2);
      if (on) {
        const n = clamp(this.ledgerOpen == null ? 0 : this.ledgerOpen, 0, 14);
        for (let i = 0; i < n; i++) {
          const y = -90 + i * (180 / 13), sw = Math.sin(t * 2.2 + i) * 1.3;
          quad3(ctx, cam, [[wx, y - 4.5, 79.5], [wx, y + 4.5, 79.5], [wx, y + 4.5 + sw, 62], [wx, y - 4.5 + sw, 62]], C.paper, "rgba(0,0,0,.14)", .7);
          quad3(ctx, cam, [[wx, y - 4.5, 79.5], [wx, y + 4.5, 79.5], [wx, y + 4.5, 75], [wx, y - 4.5, 75]], hot ? shade(C.harness, 1.3) : C.harness);
        }
      }
      // sombras de contacto
      const sh = (x, y, w, d) => { cam.ground(ctx, x + 6, y - 7, .2, 0); rr(ctx, -w / 2, -d / 2, w, d, Math.min(w, d) * .3); ctx.fillStyle = "rgba(70,56,40,.13)"; ctx.fill(); };
      for (const r of RES) sh(BAY[r], BAY_Y, 112, 48);
      for (const s of SEC) { sh(STOVE_X, ROW[s], 54, 68); sh(COL[s], PASS_Y, 110, 28); sh(COL[s], TABLE_Y, 48, 48); sh(COL[s] - 24, TABLE_Y + 30, 16, 16); sh(COL[s] + 26, TABLE_Y + 27, 16, 16); }
      sh(DESK.x, DESK.y, 40, 84); sh(this.chef.x - 2, this.chef.y + 2, 28, 28);
      // puesto resaltado desde la traza
      const HL = { crew: [BAY.crew, -150, 66, 34], material: [BAY.material, -150, 66, 34], water: [BAY.water, -150, 66, 34], order: [-268, 0, 52, 116],
        notice: [0, 84, 176, 40], close: [250, -70, 50, 60], pump: [this.chef.x, this.chef.y, 26, 26], gate: [0, 72, 180, 16] }[this.hl];
      if (HL) { cam.ground(ctx, HL[0], HL[1], .5, 0); ctx.beginPath(); ctx.ellipse(0, 0, HL[2], HL[3], 0, 0, TAU); ctx.strokeStyle = this.hl === "gate" ? C.harness : C.ink; ctx.lineWidth = 2.4; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]); }
    }
    badge(ctx, cam, x, y, z, s) {                // letra de la mesa en el frente del puesto
      const X = cam.X(x, y), Y = cam.Y(x, y, z);
      cam.screen(ctx); rr(ctx, X - 6.5, Y - 6.5, 13, 13, 3.5); ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.fill();
      text(ctx, SECTOR[s].letter, X, Y + .5, 9, SECTOR[s].ink, 800, "center");
    }
    drawFridge(ctx, cam) {
      prism(ctx, cam, SHAPE.fridge, -297, -180, 0, 0, 92, C.steel, C.steelTop);
      line3(ctx, cam, [-267.7, -206, 58], [-267.7, -154, 58], shade(C.steel, .5), 1.4);
      line3(ctx, cam, [-267, -160, 64], [-267, -160, 82], C.steelTop, 2.6);
      line3(ctx, cam, [-267, -160, 28], [-267, -160, 52], C.steelTop, 2.6);
    }
    /* Ingrediente = dato del contexto. Fantasma (aros sin relleno) mientras el proveedor no confirma. */
    ingredient(ctx, cam, res, x, y, z, k, st, t) {
      const wire = st === "pending", col = st === "risk" ? C.dead : C[res];
      if (wire) ctx.globalAlpha = .55 + .3 * Math.sin(t * 5.2 + x);
      if (res === "crew") {
        lathe(ctx, cam, x, y, z, scaleProf(PROF.tomato, k), col, { wire });
        if (!wire) lathe(ctx, cam, x, y, z + 15.4 * k, scaleProf(PROF.stem, k), st === "risk" ? "#7C828A" : C.leaf, { flat: 1 });
      } else if (res === "material") {
        lathe(ctx, cam, x, y, z, scaleProf(PROF.cheese, k), col, { wire, top: shade(col, 1.3) });
        if (!wire) { cam.ground(ctx, x, y, z + 9.6 * k, 0); ctx.fillStyle = shade(col, .82); for (const h of [[-4, -2, 2.2], [3.5, 2.5, 1.7], [1, -5, 1.3]]) { ctx.beginPath(); ctx.ellipse(h[0] * k, h[1] * k, h[2] * k, h[2] * k, 0, 0, TAU); ctx.fill(); } }
      } else {
        lathe(ctx, cam, x, y, z, scaleProf(PROF.jug, k), col, { wire });
        if (!wire) lathe(ctx, cam, x, y, z + 20 * k, scaleProf(PROF.cap, k), st === "risk" ? "#7C828A" : C.cap, { top: shade(st === "risk" ? "#7C828A" : C.cap, 1.25) });
      }
      ctx.globalAlpha = 1;
    }
    drawBay(ctx, cam, res, t) {
      const bx = BAY[res], sec = this.world.sec;
      prism(ctx, cam, SHAPE.bay, bx, BAY_Y, 0, 0, 30, C.wood, C.woodLight);
      prism(ctx, cam, SHAPE.bayBack, bx, BAY_Y - 21, 0, 30, 66, C.woodDark, C.wood);
      for (const s of cam.s >= 0 ? SEC : SEC.slice().reverse()) {
        const x = bx + SLOT[s], y = BAY_Y + 3, st = sec[s][res], age = this.clock - (this.since[s + res] || -1e6);
        cam.ground(ctx, x, y, 30.2, 0); ctx.beginPath(); ctx.ellipse(0, 0, 13.5, 13.5, 0, 0, TAU); ctx.fillStyle = "rgba(60,40,20,.10)"; ctx.fill();
        if (st !== "open") this.ingredient(ctx, cam, res, x, y, 30.4, age < 320 ? Math.max(.1, back(age / 320)) : 1, st, t);
        if (st === "pending" || st === "risk") {
          const X = cam.X(x, y), Y = cam.Y(x, y, 62);
          cam.screen(ctx); ctx.beginPath(); ctx.arc(X, Y, 7, 0, TAU); ctx.fillStyle = st === "risk" ? C.risk : C.warn; ctx.fill();
          if (st === "risk") glyph(ctx, "cross", X, Y, 9, "#fff"); else text(ctx, "…", X, Y - 2.5, 11, "#fff", 800, "center");
        }
      }
      for (const s of SEC) this.badge(ctx, cam, bx + SLOT[s], BAY_Y + 24.3, 15, s);
    }
    pan(ctx, cam, x, y, z, k, rot, sec) {
      lathe(ctx, cam, x, y, z, scaleProf(PROF.pan, k), C.pan, {});
      cam.ground(ctx, x, y, z + 5 * k, 0);
      ctx.beginPath(); ctx.ellipse(0, 0, 12.6 * k, 12.6 * k, 0, 0, TAU); ctx.fillStyle = C.food; ctx.fill();
      RES.forEach((r, i) => { const a = i * 2.1 + .4; ctx.beginPath(); ctx.ellipse(Math.cos(a) * 5.5 * k, Math.sin(a) * 5.5 * k, 3 * k, 3 * k, 0, 0, TAU); ctx.fillStyle = sec[r] === "confirmed" ? C[r] : shade(C.food, .8); ctx.fill(); });
      prism(ctx, cam, SHAPE.handle, x + Math.cos(rot) * 21 * k, y + Math.sin(rot) * 21 * k, rot, z + 3 * k, z + 5.6 * k, C.pan, shade(C.pan, 1.4));
    }
    drawStove(ctx, cam, s, t) {
      const y = ROW[s], sec = this.world.sec[s], st = sec.order, fx = STOVE_X + 27.3;
      prism(ctx, cam, SHAPE.stove, STOVE_X, y, 0, 0, 34, C.steel, C.steelTop);
      prism(ctx, cam, SHAPE.hob, STOVE_X, y, 0, 34, 35.4, C.hob, C.hob);
      quad3(ctx, cam, [[fx, y - 25, 6], [fx, y + 25, 6], [fx, y + 25, 25], [fx, y - 25, 25]], shade(C.steel, .48));
      line3(ctx, cam, [fx + .6, y - 20, 28.6], [fx + .6, y + 20, 28.6], C.steelTop, 2.2);
      this.badge(ctx, cam, fx, y, 15.5, s);
      cam.ground(ctx, STOVE_X, y, 35.6, 0);
      ctx.strokeStyle = "#14171B"; ctx.lineWidth = 3;
      for (const r of [15, 7]) { ctx.beginPath(); ctx.ellipse(0, 0, r, r, 0, 0, TAU); ctx.stroke(); }
      if (st === "open") return;
      const age = this.clock - (this.since[s + "order"] || -1e6), k = age < 320 ? Math.max(.1, back(age / 320)) : 1, n = Math.max(1, sec.orders);
      for (let i = 0; i < 6; i++) {                // llama
        const a = i * TAU / 6 + t * .8, h = (st === "pending" ? 3.4 : 6) + 2.2 * Math.sin(t * 15 + i * 1.7);
        lathe(ctx, cam, STOVE_X + Math.cos(a) * 15, y + Math.sin(a) * 15, 35.6, [[0, 2.3], [h * .4, 2.8], [h, .4]], C.flame, { flat: 1, top: C.flameTip });
      }
      this.pan(ctx, cam, STOVE_X, y, 36.4, k, .25, sec);
      if (n > 1) this.pan(ctx, cam, STOVE_X - 3, y + 5, 44, k, 1.1, sec);
      cam.screen(ctx);
      const X = cam.X(STOVE_X, y), Y = cam.Y(STOVE_X, y, 46);
      for (let i = 0; i < 3; i++) { const u = (t * .55 + i / 3) % 1; ctx.beginPath(); ctx.arc(X + Math.sin(u * 5 + i) * 4, Y - u * 26, 3 + u * 4, 0, TAU); ctx.fillStyle = `rgba(255,255,255,${(.5 * (1 - u)).toFixed(3)})`; ctx.fill(); }
      if (st !== "confirmed") {
        const bx = X, by = Y - 24; ctx.beginPath(); ctx.arc(bx, by, 8, 0, TAU); ctx.fillStyle = st === "risk" ? C.risk : C.warn; ctx.fill();
        text(ctx, st === "risk" ? `×${n}` : "…", bx, by + (st === "risk" ? .5 : -2.5), st === "risk" ? 9 : 11, "#fff", 800, "center");
      }
    }
    drawPass(ctx, cam, s, t) {
      const x = COL[s], age = this.clock - (this.bell[s] || -1e6), sh = age < 600 ? Math.sin(age * .05) * 2.4 * (1 - age / 600) : 0;
      prism(ctx, cam, SHAPE.pass, x, PASS_Y, 0, 0, 30, C.passBody, null);
      prism(ctx, cam, SHAPE.passTop, x, PASS_Y, 0, 30, 33, C.marble, C.marbleTop);
      this.badge(ctx, cam, x + 36, PASS_Y + 14.3, 16, s);
      lathe(ctx, cam, x + 36 + sh, PASS_Y + 2, 33, PROF.bell, C.gold, {});
      lathe(ctx, cam, x + 36 + sh, PASS_Y + 2, 40.5, PROF.knob, shade(C.gold, .8), { flat: 1 });
    }
    plate(ctx, cam, x, y, z, k, sec) {
      lathe(ctx, cam, x, y, z, scaleProf(PROF.plate, k), "#C9D1DB", { top: "#FFFFFF" });
      const bits = [[-4.3, -1.9, "crew"], [4.3, -1.9, "material"], [0, 4.1, "water"]].sort((a, b) => cam.depth(a[0], a[1]) - cam.depth(b[0], b[1]));
      for (const b of bits) {
        const st = sec[b[2]];
        if (st === "confirmed") lathe(ctx, cam, x + b[0] * k, y + b[1] * k, z + 2 * k, scaleProf(PROF.bite, k), C[b[2]], {});
        else { cam.ground(ctx, x + b[0] * k, y + b[1] * k, z + 2 * k, 0); ctx.beginPath(); ctx.ellipse(0, 0, 3.5, 3.5, 0, 0, TAU); ctx.strokeStyle = st === "risk" ? C.risk : C.warn; ctx.lineWidth = 1.3; ctx.setLineDash([2, 1.6]); ctx.stroke(); ctx.setLineDash([]); }
      }
    }
    drawTable(ctx, cam, s, t) {
      const x = COL[s], y = TABLE_Y, sec = this.world.sec[s], S = SECTOR[s];
      lathe(ctx, cam, x, y, 0, PROF.pedestal, C.woodDark, {});
      lathe(ctx, cam, x, y, 24, PROF.tabletop, shade(S.cloth, .84), { top: S.cloth });
      cam.ground(ctx, x, y, 27.3, 0); ctx.fillStyle = S.ink; ctx.beginPath();
      if (s === "S4") { ctx.rect(-2.4, -26, 4.8, 13); ctx.rect(-6.5, -21.9, 13, 4.8); }
      else if (s === "S7") { ctx.moveTo(-7, -18.5); ctx.lineTo(0, -26); ctx.lineTo(7, -18.5); ctx.lineTo(5, -18.5); ctx.lineTo(5, -13); ctx.lineTo(-5, -13); ctx.lineTo(-5, -18.5); ctx.closePath(); }
      else { ctx.moveTo(-9, -20); ctx.lineTo(0, -25); ctx.lineTo(9, -20); ctx.lineTo(0, -15); ctx.closePath(); ctx.rect(-4.5, -16.5, 9, 3.6); }
      ctx.fill();
      if (sec.notice === "open") return;
      const n = Math.max(1, sec.notices), age = this.clock - (this.since[s + "notice"] || -1e6), k = age < 260 ? Math.max(.3, back(age / 260)) : 1;
      const pos = (n === 1 ? [[0, 7]] : n === 2 ? [[-13, 3], [13, 10]] : [[0, -5], [-14, 10], [14, 11]]).sort((a, b) => cam.depth(a[0], a[1]) - cam.depth(b[0], b[1]));
      pos.forEach((p, i) => this.plate(ctx, cam, x + p[0], y + p[1], 27.4, i === pos.length - 1 ? k : 1, sec));
      cam.screen(ctx);
      const X = cam.X(x, y) + 28, Y = cam.Y(x, y, 27) - 24, ok = sec.notice === "confirmed";
      ctx.beginPath(); ctx.arc(X, Y, 9, 0, TAU); ctx.fillStyle = ok ? C.ok : C.risk; ctx.fill();
      if (ok) glyph(ctx, "check", X, Y, 10, "#fff"); else if (n > 1) text(ctx, `×${n}`, X, Y + .5, 9.5, "#fff", 800, "center"); else glyph(ctx, "bang", X, Y, 10, "#fff");
    }
    drawDesk(ctx, cam, t) {
      const x = DESK.x, y = DESK.y, on = this.on.retry, hot = this.clock - this.fired.retry < 700;
      prism(ctx, cam, SHAPE.desk, x, y, 0, 0, 36, C.woodDark, C.wood);
      for (const dy of [-29.5, -6.5]) prism(ctx, cam, SHAPE.page, x, y + dy, 0, 36, 38.4, "#D8D2C2", C.paper);
      cam.ground(ctx, x, y - 18, 38.6, 0); ctx.beginPath();
      for (const dy of [-18, -13, -8, 5, 10, 15]) { ctx.moveTo(-8, dy); ctx.lineTo(8, dy); }
      ctx.strokeStyle = "rgba(43,51,64,.35)"; ctx.lineWidth = 1; ctx.stroke();
      // pincho de tickets (reintento seguro): una clave por cada escritura
      const sx = x, sy = y + 26;
      lathe(ctx, cam, sx, sy, 36, PROF.spike, on ? C.steel : C.off, {});
      const n = on ? Math.min(this.keys, 9) : 0;
      for (let i = 0; i < n; i++) prism(ctx, cam, SHAPE.receipt, sx, sy, i * .55, 39 + i * 1.7, 40.2 + i * 1.7, "#CFC8B8", i === n - 1 && hot ? shade(C.harness, 1.5) : C.paper);
      line3(ctx, cam, [sx, sy, 38], [sx, sy, 66], on ? shade(C.steel, .7) : C.off, 1.5);
    }
    /* El cocinero = el modelo. Mismo cuerpo siempre; el gorro alto y la estrella son del modelo grande. */
    drawChef(ctx, cam, t) {
      const ch = this.chef, star = this.star, a = ch.a;
      const walk = ch.moving ? Math.sin(ch.phase) : 0, wt = this.clock - ch.work, working = !mq.matches && !ch.moving && wt < 520;
      const b = ch.moving ? Math.abs(Math.cos(ch.phase)) * 2.2 : working ? Math.sin(wt / 520 * Math.PI) * 4 : ch.think ? Math.sin(t * 3.2) * .7 : 0;
      const near = cam.depth(-Math.sin(a), Math.cos(a)) > 0 ? 1 : -1, hat = star ? PROF.toque : PROF.capHat, top = 72 + b + hat[hat.length - 1][0];
      const leg = (side) => ({ col: C.trouser, R: 6, off: 0, at: (z) => (z <= 4 ? null : z <= 23 + b ? [walk * side * 3, side * 5.4, 4.8, 4.8] : null) });
      const shoe = (side) => ({ col: C.shoe, flat: 1, at: (z) => (z <= 4 ? [walk * side * 5 + 1.5, side * 5.6, 7, 4.6] : null) });
      const arm = (side) => {
        const sw = ch.moving ? -walk * side * 6 : working ? 8 : ch.think && side === near ? 4 : 1.5;
        return [{ col: C.skin, R: 5, at: (z) => (z >= 24 + b && z < 29 + b ? [sw, side * 14.6, 3.6, 3.6] : null) },
          { col: C.chef, R: 5, at: (z) => (z >= 29 + b && z <= 49 + b ? [sw * (1 - (z - 29 - b) / 24), side * 14.6, 4.3, 4.3] : null) }];
      };
      const parts = [shoe(-1), shoe(1), leg(-1), leg(1), ...arm(-near),
        { col: C.chef, R: 15, at: (z) => { const u = (z - 22 - b) / 28; return u >= 0 && u <= 1 ? [0, 0, lerp(9.4, 10.2, u), lerp(13, 14.6, u)] : null; } }];
      if (star) {
        for (const h of [30, 37, 44]) parts.push({ col: C.gold, flat: 1, at: (z) => (z >= h + b && z <= h + 2.2 + b ? [9.4, 3, 1.3, 1.3] : null) });
        parts.push({ col: C.red, R: 8, at: (z) => (z >= 48.5 + b && z <= 52 + b ? [.5, 0, 7.2, 7.8] : null) });
      } else parts.push({ col: C.navy, R: 10, at: (z) => (z >= 22 + b && z <= 45 + b ? [2.4, 0, 8.4, 9.8] : null) });
      parts.push(...arm(near),
        { col: C.skin, R: 5, at: (z) => (z >= 50 + b && z < 52.5 + b ? [.5, 0, 4.2, 4.2] : null) },
        { col: C.hair, R: 10, at: (z) => { const h = z - 52 - b; return h >= 6 && h <= 20 ? [-1.7, 0, pr(PROF.head, h), pr(PROF.head, h)] : null; } },
        { col: C.skin, R: 10, at: (z) => { const h = z - 52 - b; return h >= 0 && h <= 20 ? [.8, 0, pr(PROF.head, h), pr(PROF.head, h)] : null; } },
        { col: "#2A2420", flat: 1, at: (z) => { const h = z - 52 - b; return h >= 8.2 && h <= 12.4 ? [.8 + pr(PROF.head, h) - 1, -3.5, 1.3, 1.5] : null; } },
        { col: "#2A2420", flat: 1, at: (z) => { const h = z - 52 - b; return h >= 8.2 && h <= 12.4 ? [.8 + pr(PROF.head, h) - 1, 3.5, 1.3, 1.5] : null; } },
        { col: star ? C.chef : C.navy, R: 10, at: (z) => { const h = z - 69 - b; return h >= 0 && h < 3 ? [.8, 0, 9.9, 9.9] : null; } },
        { col: C.chef, R: 13, at: (z) => { const h = z - 72 - b; return h >= 0 && h <= hat[hat.length - 1][0] ? [.8, 0, pr(hat, h), pr(hat, h)] : null; } });
      const big = Object.create(cam); big.S = cam.S * 1.22;
      big.cx = cam.X(ch.x, ch.y) - big.S * (ch.x * cam.c - ch.y * cam.s); big.cy = cam.Y(ch.x, ch.y, 0) - big.S * cam.ky * (ch.x * cam.s + ch.y * cam.c);
      stackParts(ctx, big, ch.x, ch.y, a, 0, top, parts);
      this.chefTop = [big.X(ch.x, ch.y), big.Y(ch.x, ch.y, top)];
    }
    drawChefUi(ctx, cam, t) {                    // nombre, estrella y bocadillo: siempre por encima de los rótulos
      if (!this.chefTop) return;
      const ch = this.chef, star = this.star, X = this.chefTop[0], Y = this.chefTop[1];
      cam.screen(ctx);
      if (star) { starPath(ctx, X, Y - 9 - Math.sin(t * 2.4) * 1.5, 7, 3.1, 0, Math.cos(t * 1.8)); ctx.fillStyle = C.gold; ctx.fill(); ctx.strokeStyle = "#C99A12"; ctx.lineWidth = .8; ctx.stroke(); }
      const ny = Y - (star ? 27 : 12);
      pill(ctx, X, ny, this.model || "modelo", { bg: alpha(C.model, .93), fg: "#fff", size: 9.5 });
      const icon = ch.icon && this.clock < ch.iconUntil ? ch.icon : null;
      if (ch.think || icon) {
        const bx = X + 26, by = ny - 26;
        ctx.beginPath(); ctx.moveTo(bx - 12, by + 9); ctx.lineTo(X + 6, ny - 8); ctx.lineTo(bx - 2, by + 12); ctx.closePath(); ctx.fillStyle = "#fff"; ctx.fill();
        rr(ctx, bx - 19, by - 13, 38, 26, 11); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = star ? C.gold : "rgba(43,51,64,.25)"; ctx.lineWidth = star ? 1.8 : 1; ctx.stroke();
        if (ch.think) for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(bx - 9 + i * 9, by - Math.max(0, Math.sin(t * 7 - i * .9)) * 4, 2.6, 0, TAU); ctx.fillStyle = C.ink; ctx.fill(); }
        else glyph(ctx, icon.k, bx, by, 15, icon.col);
      }
    }
    drawFx(ctx, cam, t) {
      const now = this.clock, P = (p) => [cam.X(p[0], p[1]), cam.Y(p[0], p[1], p[2])];
      // arcos de control (guarda de escrituras) y marco de la puerta (cierre verificado)
      const beam = (A, B, g, quad) => {
        const age = now - g.t, scanning = now - g.scan < 700;
        const col = g.held ? C.risk : g.out === "pass" && age < 1300 ? C.ok : C.harness, hot = g.held || scanning || (g.out === "pass" && age < 1300);
        if (g.held || (g.out === "pass" && age < 420)) quad3(ctx, cam, quad, alpha(col, g.held ? .2 + .06 * Math.sin(t * 9) : .16), alpha(col, .7), 1.2);
        cam.screen(ctx);
        for (const [lw, al] of [[hot ? 7 : 5, .2], [hot ? 2.6 : 1.5, hot ? 1 : .6 + .2 * Math.sin(t * 3)]]) {
          ctx.beginPath(); A.forEach((p, i) => { const q = P(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
          ctx.strokeStyle = alpha(col, al); ctx.lineWidth = lw; ctx.stroke();
        }
      };
      if (this.on.preconditions) for (const id of ["stove", "pass"]) {
        const G = GATES[id], a = G.a, b = G.b;
        beam([[a[0], a[1], 44], [b[0], b[1], 44]], null, this.gate[id], [[a[0], a[1], 4], [b[0], b[1], 4], [b[0], b[1], 66], [a[0], a[1], 66]]);
      }
      if (this.on.completion) { const y = ROOM.y0 + 1; beam([[226, y, 0], [226, y, 91], [290, y, 91], [290, y, 0]], null, this.gate.door, [[229, y + 3, 0], [287, y + 3, 0], [287, y + 3, 88], [229, y + 3, 88]]); }
      // ondas en el suelo
      this.rings = this.rings.filter((r) => now - r.t0 < 900);
      for (const r of this.rings) { const u = (now - r.t0) / 900; cam.ground(ctx, r.x, r.y, r.z, 0); ctx.beginPath(); ctx.ellipse(0, 0, 14 + u * 30, 14 + u * 30, 0, 0, TAU); ctx.strokeStyle = alpha(r.col, 1 - u); ctx.lineWidth = 3 * (1 - u) + .6; ctx.stroke(); }
      // plato en vuelo del pase a la mesa
      for (const pl of this.flying) this.plate(ctx, cam, pl.x, pl.y, pl.z, 1, this.world.sec[pl.sector]);
      // luz de comprobación del harness
      for (const o of this.orbs) {
        const [X, Y] = P([o.x, o.y, o.z]); cam.screen(ctx); ctx.globalAlpha = o.a;
        const g = ctx.createRadialGradient(X, Y, 1, X, Y, 15); g.addColorStop(0, alpha(C.harness, .55)); g.addColorStop(1, alpha(C.harness, 0));
        ctx.beginPath(); ctx.arc(X, Y, 15, 0, TAU); ctx.fillStyle = g; ctx.fill();
        lathe(ctx, cam, o.x, o.y, o.z - 4, PROF.orb, C.harness, {});
        if (now - o.pulse < 320) { const u = (now - o.pulse) / 320; cam.screen(ctx); ctx.beginPath(); ctx.arc(X, Y, 6 + u * 20, 0, TAU); ctx.strokeStyle = alpha(C.harness, 1 - u); ctx.lineWidth = 2; ctx.stroke(); }
        ctx.globalAlpha = 1;
      }
      // comandas de papel
      cam.screen(ctx);
      for (const o of this.papers) { const [X, Y] = P(o.p); rr(ctx, X - 7, Y - 9, 14, 18, 2.5); ctx.fillStyle = o.col === C.paper ? "#fff" : o.col; ctx.fill(); ctx.strokeStyle = "rgba(43,51,64,.3)"; ctx.lineWidth = 1; ctx.stroke(); ctx.beginPath(); for (const dy of [-4, 0, 4]) { ctx.moveTo(X - 4, Y + dy); ctx.lineTo(X + 4, Y + dy); } ctx.strokeStyle = o.col === C.paper ? "rgba(43,51,64,.45)" : "rgba(255,255,255,.8)"; ctx.stroke(); }
      // monedas: lo que cuesta cada decisión del cocinero
      this.coins = this.coins.filter((c) => now - c.t0 < 620);
      for (const c of this.coins) {
        const u = (now - c.t0) / 620; if (u < 0) continue;
        const e = easeIO(u), x0 = cam.X(c.x, c.y), y0 = cam.Y(c.x, c.y, 120), X = lerp(x0, this.coinX || 180, e), Y = lerp(y0, 57, e) - Math.sin(u * Math.PI) * 40;
        ctx.beginPath(); ctx.arc(X, Y, 4.6, 0, TAU); ctx.fillStyle = C.gold; ctx.fill(); ctx.strokeStyle = "#C99A12"; ctx.lineWidth = 1; ctx.stroke();
      }
    }
    drawCallouts(ctx, cam) {
      const now = this.clock, P = (p) => [cam.X(p[0], p[1]), cam.Y(p[0], p[1], p[2])];
      cam.screen(ctx);
      this.callouts = this.callouts.filter((c) => now - c.t0 < c.ttl);
      for (const c of this.callouts) {
        const k = (now - c.t0) / c.ttl, [X, Y] = P(c.p);
        ctx.globalAlpha = k < .08 ? k / .08 : k > .8 ? (1 - k) / .2 : 1;
        pill(ctx, X, Y - 8 - 12 * easeOut(Math.min(1, (now - c.t0) / 380)), c.text, TONE[c.tone] || TONE[""]);
      }
      ctx.globalAlpha = 1;
    }
    drawLabels(ctx, cam, t) {
      cam.screen(ctx);
      const P = (x, y, z) => [cam.X(x, y), cam.Y(x, y, z)], w = this.world;
      const sys = { crew: "Cuadrillas", material: "Material", water: "Cisternas" };
      for (const r of RES) { const p = P(BAY[r], BAY_Y - 21, 79); pill(ctx, p[0], p[1], sys[r], { dot: C[r], size: 10.5 }); }
      for (const s of SEC) {
        const p = P(COL[s] - 4, TABLE_Y + 42, 0), st = w.sec[s].notice;
        pill(ctx, p[0], p[1], SECTOR[s].name, { dot: st === "confirmed" ? C.ok : st === "risk" ? C.risk : "#C3C8D0", size: 10.5 });
      }
      let p = P(DESK.x + 6, DESK.y + 66, 0); pill(ctx, p[0], p[1], "Libro · expediente", { size: 10 });
      const hp = (k, x, y, z, extra) => {
        const on = this.on[k], q = P(x, y, z), hot = this.clock - this.fired[k] < 700;
        pill(ctx, q[0], q[1], on ? ON_NAME[k] + (extra || "") : "Sin " + ON_NAME[k].toLowerCase(), on ? { bg: hot ? shade(C.harness, 1.25) : C.harness, fg: "#fff", size: 10 } : { bg: "rgba(255,255,255,.9)", fg: "#8A93A0", line: "#C9CFD8", size: 10 });
      };
      hp("ledger", ROOM.x0, 0, ROOM.h + 28, this.ledgerOpen != null ? ` · ${this.ledgerOpen} abiertas` : "");
      hp("preconditions", 170, 72, 66);
      hp("completion", 258, ROOM.y0, 117);
      hp("retry", DESK.x, DESK.y + 26, 88, this.keys ? ` · ${this.keys} claves` : "");
    }
    drawHud(ctx, cam, t) {
      cam.screen(ctx);
      const w = this.world, turn = this.turn, star = this.star, now = this.clock;
      // el cocinero
      card(ctx, 14, 12, 226, 62, 12);
      ctx.beginPath(); ctx.arc(44, 43, 21, 0, TAU); ctx.fillStyle = star ? "#FFF3CC" : "#EAF0F6"; ctx.fill();
      ctx.beginPath(); ctx.arc(44, 49, 9, 0, TAU); ctx.fillStyle = C.skin; ctx.fill();
      rr(ctx, 35, star ? 27 : 34, 18, star ? 15 : 8, 3); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#C3C8D0"; ctx.lineWidth = 1; ctx.stroke();
      if (star) { ctx.beginPath(); ctx.ellipse(44, 27, 12, 6, 0, 0, TAU); ctx.fillStyle = "#fff"; ctx.fill(); ctx.stroke(); starPath(ctx, 59, 29, 6, 2.7, 0); ctx.fillStyle = C.gold; ctx.fill(); }
      text(ctx, "MODELO · EL COCINERO", 74, 25, 8.5, C.sub, 700);
      text(ctx, this.model || "—", 74, 40, 13, C.ink, 700);
      text(ctx, star ? "Chef con estrella" : "Cocinero de línea", 74, 57, 10.5, C.sub, 500);
      text(ctx, usd(turn.cost), 233, 57, 10.5, C.ink, 700, "right");
      const coinX = this.coinX = 233 - ctx.measureText(usd(turn.cost)).width - 9;
      ctx.beginPath(); ctx.arc(coinX, 57, 5, 0, TAU); ctx.fillStyle = C.gold; ctx.fill(); ctx.strokeStyle = "#C99A12"; ctx.lineWidth = 1; ctx.stroke();
      // comandas: los 16 requisitos tal como constan en los sistemas
      const TX = 584, TY = 20;
      text(ctx, "COMANDAS · HECHOS EN LOS SISTEMAS", TX + 2, 11, 8.5, C.sub, 700);
      SEC.forEach((s, i) => {
        const x = TX + i * 98, sec = w.sec[s];
        card(ctx, x, TY, 92, 54, 9);
        text(ctx, SECTOR[s].name, x + 9, TY + 14, 10.5, C.ink, 700);
        ITEMS.forEach((k, j) => cell(ctx, x + 13 + j * 16.5, TY + 37, k, sec[k], now - (this.since[s + k] || -1e6)));
      });
      const cx = TX + 294, lc = w.close === "ok" ? C.ok : w.close === "risk" ? C.risk : "#AEB5C0";
      card(ctx, cx, TY, 74, 54, 9);
      text(ctx, "CIERRE", cx + 9, TY + 13, 8.5, C.sub, 700);
      text(ctx, `${turn.done}/${turn.total}`, cx + 9, TY + 36, 17, C.ink, 800);
      glyph(ctx, "lock", cx + 62, TY + 13, 11, lc);
      // el harness: cómo está organizada la cocina
      const ex = this.side === "excellent", n = LAYER_KEYS.filter((k) => this.on[k]).length;
      card(ctx, 14, 522, 318, 64, 12);
      text(ctx, "HARNESS · CÓMO ESTÁ ORGANIZADA LA COCINA", 26, 535, 8.5, C.sub, 700);
      text(ctx, ex ? (n ? `vNext · ${n} de 4 controles` : "vNext · sin controles") : "vCurrent · sin controles", 26, 551, 12.5, C.ink, 700);
      let x = 26;
      for (const k of LAYER_KEYS) {
        const label = CHIP[k] + (this.firedN[k] ? ` ${this.firedN[k]}` : ""), on = this.on[k], hot = now - this.fired[k] < 700;
        ctx.font = `600 9.5px ${FONT}`; const cw = ctx.measureText(label).width + 14;
        rr(ctx, x, 562, cw, 17, 8.5); ctx.fillStyle = on ? (hot ? shade(C.harness, 1.25) : C.harness) : "#F3F5F8"; ctx.fill();
        if (!on) { ctx.strokeStyle = "#C9CFD8"; ctx.lineWidth = 1; ctx.stroke(); }
        text(ctx, label, x + 7, 571, 9.5, on ? "#fff" : "#8A93A0", 600); x += cw + 6;
      }
      // resultado del servicio
      if (this.banner) {
        const b = this.banner, age = now - b.t0, k = age < 420 ? back(Math.max(.01, age / 420)) : 1, bx = 722, by = 512;
        const M = { verified: ["Servicio verificado", C.ok], risk: ["La evidencia no acredita el éxito", C.risk], pending: ["Servicio pendiente", C.warn], stop: ["Detenido por la plataforma", C.ink] }[b.status];
        ctx.globalAlpha = Math.min(1, age / 200);
        card(ctx, bx, by + (1 - k) * 20, 226, 74, 12);
        rr(ctx, bx, by + (1 - k) * 20, 6, 74, 3); ctx.fillStyle = M[1]; ctx.fill();
        ctx.font = `800 12.5px ${FONT}`;
        text(ctx, M[0], bx + 18, by + 20, Math.min(12.5, 12.5 * 196 / ctx.measureText(M[0]).width), M[1], 800);
        text(ctx, `${turn.done}/${turn.total} requisitos · ≈ ${usd(turn.cost)} · ${(turn.elapsed / 1000).toFixed(0)} s`, bx + 18, by + 38, 10, C.sub, 600);
        for (let i = 0; i < 3; i++) {
          const on = b.status === "verified", sa = clamp((age - 250 - i * 160) / 260, 0, 1), sc = on ? (sa < 1 ? back(Math.max(.01, sa)) : 1) : 1;
          starPath(ctx, bx + 27 + i * 21, by + 57, 8.5 * sc, 3.8 * sc, 0); ctx.fillStyle = on ? C.gold : "#E3E7EC"; ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      this.confetti = this.confetti.filter((c) => now - c.t0 < 3400);
      for (const c of this.confetti) {
        const u = (now - c.t0) / 1000, X = c.x + c.vx * u, Y = c.y + c.vy * u + 60 * u * u, a = c.r + u * 5;
        ctx.globalAlpha = clamp(3.4 - u, 0, 1);
        ctx.beginPath(); ctx.moveTo(X + Math.cos(a) * c.w, Y + Math.sin(a) * c.w * .5); ctx.lineTo(X - Math.sin(a) * 2.5, Y + Math.cos(a) * 2.5); ctx.lineTo(X - Math.cos(a) * c.w, Y - Math.sin(a) * c.w * .5); ctx.lineTo(X + Math.sin(a) * 2.5, Y - Math.cos(a) * 2.5); ctx.closePath();
        ctx.fillStyle = c.col; ctx.fill();
      }
      ctx.globalAlpha = 1;
      text(ctx, "Arrastra para girar · doble clic: pantalla completa", 508, 591, 8.5, "rgba(107,117,132,.75)", 500, "center");
    }
  }
  /* Precio de lista por millón de tokens (entrada, salida), copiado de app/agent.py para ir sumando en vivo.
     Al terminar el turno se sustituye por el coste que calcula el servidor (usage.cost_usd). */
  Plant.PRICES = [[/sol/i, 2, 10], [/mini/i, .4, 1.6]];
  Plant.STAR = /sol/i;                           // qué modelo lleva gorro alto y estrella
  Plant.price = (model, tin, tout) => { const p = Plant.PRICES.find((q) => q[0].test(model)); return p ? (tin * p[1] + tout * p[2]) / 1e6 : 0; };
  Plant.target = target;
  window.Plant = Plant;
})();

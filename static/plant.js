/* P&ID: las mismas seis conexiones. Solo cambian la válvula de cierre
   y la reconciliación del recibo; los estados vienen de la ejecución. */
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
  const T = window.PlantTopology, NS = "http://www.w3.org/2000/svg";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const freshTurn = () => ({ status: "idle", tin: 0, tout: 0, elapsed: 0, started: 0, done: 0, total: 6 });
  const REPLY = "M470 144 V28 H56 V146";
  const INLET = "M80 170 H444";
  const LABELS = { CONFIRMED: "Confirmado", PENDING: "Pendiente", CREATED: "Orden creada", SENT: "Aviso enviado",
    CLOSED: "Cierre registrado", DELIVERY_UNKNOWN: "Acuse perdido", FOUND: "Recibo encontrado", OK: "Datos leídos",
    REJECTED: "Rechazado", NOT_FOUND: "Sin recibo", BLOCKED_BY_PLATFORM: "Detenido" };

  function depot(d) {
    return `<g class="eq depot" data-eq="${d.id}"><title>${esc(d.label)} · ${esc(d.sub)} · conexión idéntica en ambos harnesses</title>
      <path class="pipe drop" d="M${d.cx} ${d.y} V${d.y + 28}"/>
      <g class="valve"><polygon class="shape" points="${d.cx - 7},${d.y + 8} ${d.cx + 7},${d.y + 8} ${d.cx},${d.y + 15}"/>
        <polygon class="shape" points="${d.cx - 7},${d.y + 22} ${d.cx + 7},${d.y + 22} ${d.cx},${d.y + 15}"/></g>
      <rect class="shape tank" x="${d.cx - 72}" y="${d.y + 28}" width="144" height="56" rx="3"/>
      <rect class="lvl" x="${d.cx - 70}" y="${d.y + 30}" width="140" height="52" rx="2"/>
      <text class="lbl" x="${d.cx}" y="${d.y + 51}" text-anchor="middle">${esc(d.label)}</text>
      <text class="t sub" x="${d.cx}" y="${d.y + 70}" text-anchor="middle">${esc(d.sub)}</text>
      <text class="t stag" x="${d.cx}" y="${d.y + 101}" text-anchor="middle">PENDIENTE</text>
      <g class="badge on" transform="translate(${d.cx + 68} ${d.y + 28})"><circle r="10"/><text text-anchor="middle" y="3.5">–</text></g>
    </g>`;
  }

  function markup(model) {
    return `<svg viewBox="0 0 960 600" role="img" aria-labelledby="plant-title plant-desc">
      <title id="plant-title">Planta del agente</title>
      <desc id="plant-desc">Las mismas conexiones para ambos harnesses. El modelo propone; el cierre verificado y la recuperación de recibos intervienen fuera del modelo. Los depósitos muestran hechos de los sistemas simulados.</desc>
      <defs><pattern id="pl-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".9" class="grid"/></pattern>
        <pattern id="pl-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" class="hatch"/></pattern></defs>
      <rect width="960" height="600" fill="url(#pl-grid)"/>
      <g class="pipes"><path class="pipe main" d="${INLET}"/><path class="pipe" d="${REPLY}"/>
        <path class="pipe main" d="M470 196 V475"/>
        <path class="pipe main" d="M60 310 H885"/><path class="pipe main" d="M60 475 H885"/>
        <text class="t row" x="390" y="19">RESPUESTA</text>
        <text class="t row" x="60" y="296">RECURSOS · MISMA FRANJA CONFIRMADA</text>
        <text class="t row" x="60" y="461">EJECUCIÓN · HECHOS EN LOS SISTEMAS</text></g>
      <g class="eq persona" data-eq="inlet"><title>Petición del operador</title>
        <circle class="shape" cx="56" cy="170" r="24"/><circle class="glyph" cx="56" cy="164" r="6"/>
        <path class="glyph" d="M44 183 q12 -15 24 0"/><text class="t tag" x="56" y="214" text-anchor="middle">PERSONA</text></g>
      <g class="eq esd" data-eq="esd"><title>Control de plataforma común</title>
        <polygon class="shape" points="104,163 104,177 112,170"/><polygon class="shape" points="120,163 120,177 112,170"/>
        <line class="stem" x1="112" y1="163" x2="112" y2="152"/><rect class="shape" x="104" y="140" width="16" height="12"/>
        <text class="t tag" x="112" y="131" text-anchor="middle">ESD</text><text class="t sub" x="112" y="226" text-anchor="middle">plataforma</text></g>
      <g class="eq" data-eq="cf01"><title>Filtro de contenido común de Azure</title>
        <rect class="shape screen" x="174" y="150" width="14" height="40" rx="2"/>
        <text class="t tag" x="181" y="214" text-anchor="middle">CF-01</text><text class="t sub" x="181" y="226" text-anchor="middle">Azure</text></g>
      <g class="eq pln filled" data-eq="mission"><title>Contrato de la misión: idéntico para ambos, no es un planificador adicional</title>
        <path class="shape tank" d="M262 128 H372 V196 L340 212 H294 L262 196 Z"/>
        <text class="t tag" x="317" y="151" text-anchor="middle">MISIÓN</text>
        <text class="t" x="317" y="181" text-anchor="middle">16 REQUISITOS</text>
        <text class="t sub" x="317" y="237" text-anchor="middle">contrato común</text></g>
      <g class="eq pump" data-eq="pump"><title>Mismo modelo y configuración</title>
        <circle class="shape" cx="470" cy="170" r="26"/>
        <g class="imp"><path d="M470 170 q10 -14 0 -20"/><path d="M470 170 q12 12 18 2"/><path d="M470 170 q-16 4 -12 16"/><circle cx="470" cy="170" r="3"/></g>
        <text class="t tag" x="510" y="140">P-01 · MODELO</text><rect class="shape ro" x="510" y="148" width="116" height="46" rx="3"/>
        <text class="t ro-t" data-readout="model" x="517" y="163">${esc(model.toUpperCase())}</text>
        <text class="t ro-v" data-readout="tokens" x="517" y="177">— TOKENS</text>
        <text class="t ro-v" data-readout="latency" x="517" y="189">—</text></g>
      <g class="eq inline close-gate" data-eq="gate"><title>Cierre verificado: solo se activa en el harness, nunca añade una herramienta</title>
        <rect class="shape screen" x="233" y="14" width="14" height="28" rx="2"/>
        <text class="t tag" x="240" y="63" text-anchor="middle">CV-01 · CIERRE VERIFICADO</text></g>
      <g class="eq retry-block" data-eq="retry"><title>Clave de operación persistente y reconciliación del recibo</title>
        <path class="pipe dline" d="M670 205 H650 V475 H740"/>
        <rect class="shape tank" x="670" y="144" width="240" height="78" rx="3"/>
        <text class="t tag" x="686" y="165">RI-01 · REINTENTO SEGURO</text>
        <text class="t sub" data-readout="operation" x="686" y="185">Sin operaciones</text>
        <text class="t sub" data-readout="receipt" x="686" y="205">Sin recibos</text></g>
      <g class="eq rack rk-exc" data-eq="rk-ledger"><title>Registro de progreso</title>
        <circle class="shape" cx="650" cy="60" r="19"/><line class="isa" x1="631" y1="60" x2="669" y2="60"/>
        <text class="t rt" x="650" y="55" text-anchor="middle">RP</text><text class="t rn" x="650" y="73" text-anchor="middle">01</text></g>
      <g class="eq rack rk-exc" data-eq="rk-preconditions"><title>Guarda de escrituras</title>
        <circle class="shape" cx="730" cy="60" r="19"/><line class="isa" x1="711" y1="60" x2="749" y2="60"/>
        <text class="t rt" x="730" y="55" text-anchor="middle">GA</text><text class="t rn" x="730" y="73" text-anchor="middle">01</text></g>
      <g class="eq rack rk-exc" data-eq="rk-completion"><title>Cierre verificado</title>
        <circle class="shape" cx="810" cy="60" r="19"/><line class="isa" x1="791" y1="60" x2="829" y2="60"/>
        <text class="t rt" x="810" y="55" text-anchor="middle">CV</text><text class="t rn" x="810" y="73" text-anchor="middle">01</text></g>
      <g class="eq rack rk-exc" data-eq="rk-retry"><title>Reintento seguro</title>
        <circle class="shape" cx="890" cy="60" r="19"/><line class="isa" x1="871" y1="60" x2="909" y2="60"/>
        <text class="t rt" x="890" y="55" text-anchor="middle">RI</text><text class="t rn" x="890" y="73" text-anchor="middle">01</text></g>
      <g class="eq ledger-box" data-eq="ledger"><title>Registro de progreso: obligaciones observadas, recordadas al modelo en cada paso; detecta bucles</title>
        <rect class="shape tank" x="510" y="208" width="132" height="44" rx="3"/>
        <text class="t tag" x="518" y="225">RP-01 · REGISTRO</text>
        <text class="t sub" data-readout="ledger" x="518" y="242">sin observaciones</text></g>
      <g class="eq inline write-guard" data-eq="guard"><title>Guarda de escrituras: no crea órdenes ni envía avisos sin los recursos confirmados</title>
        <rect class="shape screen" x="395" y="461" width="14" height="28" rx="2"/>
        <text class="t tag" x="402" y="454" text-anchor="middle">GA-01</text></g>
      <text class="t row" x="672" y="105">CONTROLES DEL HARNESS</text>
      ${T.DEPOTS.map(depot).join("")}
      <g class="fx-p"></g><g class="fx-call"></g><g class="fx-hl"></g><g class="routes" visibility="hidden"></g>
    </svg>`;
  }

  class Plant {
    constructor(host, hud, ticker, model) {
      host.innerHTML = markup(model);
      this.svg = host.querySelector("svg"); this.hud = hud; this.ticker = ticker;
      this.side = "good"; this.layers = {}; this.epoch = 0; this.queue = []; this.running = false; this.paths = {};
      this.lane = "good"; this.states = {}; this.turns = {}; this.lastEvents = {}; this.snapshots = {};
      this.calls = {}; this.timer = null; this.turn = freshTurn();
      this.fx = { p: this.q(".fx-p"), call: this.q(".fx-call"), hl: this.q(".fx-hl"), routes: this.q(".routes") };
      this.renderHud();
    }
    q(s) { return this.svg.querySelector(s); }
    eq(id) { return this.q(`[data-eq="${id}"]`); }
    speed() { return reduced.matches || document.hidden ? 100000 : Math.min(6, 1 + this.queue.length * .3); }
    wait(ms) { return new Promise((r) => setTimeout(r, ms / this.speed())); }
    cancel() {
      this.epoch++; this.queue = []; this.running = false; this.calls = {};
      clearInterval(this.timer); this.timer = null;
      this.eq("pump").classList.remove("spin");
      this.svg.querySelectorAll(".pipe.live").forEach((p) => p.remove());
      this.fx.p.replaceChildren(); this.fx.call.replaceChildren(); this.fx.hl.replaceChildren();
    }
    configure(side, layers, lane = side, modelLabel = null) {
      this.cancel(); this.side = side; this.lane = lane; this.layers = { ...layers };
      this.turn = { ...(this.turns[lane] || freshTurn()) };
      if (modelLabel) this.q('[data-readout="model"]').textContent = modelLabel.toUpperCase();
      this.q('[data-readout="latency"]').textContent = "—";
      for (const [id, k] of [["gate", "completion"], ["rk-completion", "completion"], ["retry", "retry"], ["rk-retry", "retry"],
        ["guard", "preconditions"], ["rk-preconditions", "preconditions"], ["ledger", "ledger"], ["rk-ledger", "ledger"]]) {
        this.eq(id).classList.toggle("is-off", !(side === "excellent" && layers[k]));
      }
      this.eq("gate").classList.remove("gate-held"); this.eq("guard").classList.remove("gate-held");
      this.q('[data-readout="ledger"]').textContent = "sin observaciones";
      this.eq("esd").classList.toggle("closed", this.turn.status === "stop");
      this.q('[data-readout="operation"]').textContent = "Clave antes de escribir";
      this.q('[data-readout="receipt"]').textContent = "Consulta antes de repetir";
      this.applyState(this.states[lane]);
      this.renderHud(); this.say("");
    }
    resetAll() {
      this.cancel(); this.states = {}; this.turns = {}; this.lastEvents = {}; this.snapshots = {};
    }
    beginTurn() {
      this.snapshots[this.lane] = this.states[this.lane] ? clone(this.states[this.lane]) : null;
      this.lastEvents[this.lane] = [];
    }
    push(e, record = true) {
      if (record) (this.lastEvents[this.lane] ||= []).push(e);
      this.queue.push(e); this.run();
    }
    async run() {
      if (this.running) return;
      this.running = true;
      const epoch = this.epoch;
      try {
        while (this.queue.length && epoch === this.epoch) await this.handle(this.queue.shift(), epoch);
      } catch (e) {
        console.error("Animación de la planta:", e);
        this.say("Error de visualización. La evidencia completa sigue en Operaciones.");
      } finally {
        if (epoch === this.epoch) { this.running = false; this.renderHud(); }
      }
    }
    async drain() {
      const end = Date.now() + 9000;
      while ((this.queue.length || this.running) && Date.now() < end) await new Promise((r) => setTimeout(r, 60));
    }
    canReplay() { return (this.lastEvents[this.lane] || []).length > 0 && !this.running; }
    replay() {
      if (!this.canReplay()) return;
      const events = this.lastEvents[this.lane].slice();
      this.cancel(); this.applyState(this.snapshots[this.lane]);
      events.forEach((e) => this.push(e, false));
    }
    renderHud() {
      const t = this.turn;
      const label = { idle: "En espera", run: "En marcha", stop: "Detenido", verified: "Verificado", pending: "Pendiente", risk: "Incumplimiento" }[t.status];
      const status = this.hud.querySelector("[data-h=status]");
      status.textContent = label; status.className = `hud-status ${t.status === "run" ? "run" : t.status === "stop" ? "stop" : ""}`;
      this.hud.querySelector("[data-h=time]").textContent = t.elapsed ? `T+ ${(t.elapsed / 1000).toFixed(1).replace(".", ",")} s` : "T+ —";
      this.hud.querySelector("[data-h=tok]").textContent = t.tin ? `${t.tin.toLocaleString("es-ES")} → ${t.tout.toLocaleString("es-ES")} tokens` : "P-01 · —";
      this.hud.querySelector("[data-h=plan]").textContent = `Evidencia ${t.done}/${t.total}`;
      this.hud.querySelector("[data-h=replay]").disabled = !this.canReplay() || t.status === "run";
      this.q('[data-readout="tokens"]').textContent = t.tin ? `${t.tin.toLocaleString("es-ES")} → ${t.tout}` : "— TOKENS";
    }
    applyState(a) {
      this.states[this.lane] = a ? clone(a) : null;
      for (const d of T.DEPOTS) {
        const g = this.eq(d.id), r = a?.rows.find((r) => r.id === d.id);
        g.classList.remove("s-ok", "s-warn", "s-risk");
        if (r?.ok) g.classList.add("s-ok");
        else if (r?.status === "risk") g.classList.add("s-risk");
        else if (r?.status === "pending") g.classList.add("s-warn");
        g.querySelector(".stag").textContent = d.id === "close" ? (r?.ok ? "VERIFICADO" : r?.status === "risk" ? "CERRADO SIN CUMPLIR" : "ABIERTO")
          : `${(r?.detail || "0/3 ok").toUpperCase()}${r?.status === "risk" ? " · INCUMPLE" : ""}`;
        g.querySelector(".badge").classList.toggle("done", !!r?.ok);
        g.querySelector(".badge text").textContent = r?.ok ? "✓" : "–";
      }
      this.turn.done = a?.done || 0; this.turn.total = a?.total || 16;
      this.renderHud();
    }
    anchor(id) {
      const d = T.DEPOT[id];
      if (d) return { x: d.cx, y: d.y + 28 };
      const xy = { inlet: [56, 170], pump: [470, 170], mission: [317, 128], gate: [240, 28], esd: [112, 170],
        retry: [790, 144], guard: [402, 470], ledger: [576, 208], "rk-ledger": [650, 60], "rk-preconditions": [730, 60],
        "rk-completion": [810, 60], "rk-retry": [890, 60] }[id] || [470, 170];
      return { x: xy[0], y: xy[1] };
    }
    path(d) {
      if (this.paths[d]) return this.paths[d];
      const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); this.fx.routes.appendChild(p);
      this.paths[d] = p; return p;
    }
    flow(d, { cls = "p", reverse = false, n = 4 } = {}) {
      if (!d || this.speed() > 100) return Promise.resolve();
      const path = this.path(d), length = path.getTotalLength(), epoch = this.epoch;
      const duration = Math.min(1200, Math.max(450, length * 1.5)) / this.speed();
      const dots = Array.from({ length: n }, () => {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", "3.2"); c.setAttribute("class", cls); c.setAttribute("opacity", "0");
        this.fx.p.appendChild(c); return c;
      });
      const start = performance.now(), gap = 65 / this.speed();
      return new Promise((resolve) => {
        const frame = (now) => {
          if (epoch !== this.epoch) { dots.forEach((c) => c.remove()); resolve(); return; }
          let pending = false;
          dots.forEach((c, i) => {
            const progress = (now - start - i * gap) / duration;
            if (progress >= 1) { c.remove(); return; }
            pending = true;
            if (progress < 0) return;
            const eased = 1 - (1 - progress) ** 3, point = path.getPointAtLength((reverse ? 1 - eased : eased) * length);
            c.setAttribute("cx", point.x); c.setAttribute("cy", point.y); c.setAttribute("opacity", "1");
          });
          if (pending) requestAnimationFrame(frame); else resolve();
        };
        requestAnimationFrame(frame);
      });
    }
    flash(id, type = "info") {
      const g = this.eq(id); if (!g) return;
      const cls = type === "warn" ? "f-warn" : type === "pass" ? "f-pass" : "f-act", epoch = this.epoch;
      g.classList.add(cls);
      setTimeout(() => { if (epoch === this.epoch) g.classList.remove(cls); }, 1300);
    }
    callout(id, text, tone = "") {
      const a = this.anchor(id), g = document.createElementNS(NS, "g"), t = document.createElementNS(NS, "text");
      g.setAttribute("class", `call ${tone}`); t.textContent = String(text).toUpperCase().slice(0, 56);
      g.appendChild(t); this.fx.call.appendChild(g);
      const width = t.getComputedTextLength() + 16, x = Math.max(5, Math.min(950 - width, a.x - width / 2)), y = Math.max(5, a.y - 32);
      const r = document.createElementNS(NS, "rect");
      for (const [key, value] of Object.entries({ x, y, width, height: 19, rx: 9 })) r.setAttribute(key, value);
      g.insertBefore(r, t); t.setAttribute("x", x + 8); t.setAttribute("y", y + 13);
      setTimeout(() => g.remove(), 2200 / Math.min(2, this.speed()));
    }
    highlight(id) {
      this.fx.hl.replaceChildren();
      const g = id && this.eq(id); if (!g) return;
      const b = g.getBBox(), r = document.createElementNS(NS, "rect");
      for (const [k, v] of Object.entries({ x: b.x - 5, y: b.y - 5, width: b.width + 10, height: b.height + 10, rx: 6 })) r.setAttribute(k, v);
      r.setAttribute("class", "hl"); this.fx.hl.appendChild(r);
    }
    say(t) { this.ticker.textContent = t; this.onSay?.(t); }
    async handle(e, epoch) {
      const d = e.data || {}, live = () => epoch === this.epoch;
      if (e.type === "turn.start") {
        this.turn = freshTurn(); this.turn.status = "run"; this.turn.started = performance.now();
        this.timer = setInterval(() => { this.turn.elapsed = performance.now() - this.turn.started; this.renderHud(); }, 100);
        this.eq("esd").classList.remove("closed"); this.eq("gate").classList.remove("gate-held");
        this.say("Entra la misión"); this.flow(INLET); return this.wait(220);
      }
      if (e.type === "mission.state") { this.applyState(d); return; }
      if (e.type === "inference.start" && d.purpose === "executor") {
        this.eq("pump").classList.add("spin"); this.say("El modelo decide el siguiente paso"); return;
      }
      if (e.type === "inference.end" && d.purpose === "executor") {
        this.eq("pump").classList.remove("spin");
        this.turn.tin += d.tokens_in; this.turn.tout += d.tokens_out;
        this.q('[data-readout="latency"]').textContent = `${(d.ms / 1000).toFixed(1)} S ÚLTIMA`;
        this.renderHud(); return;
      }
      if (e.type === "model.proposal") {
        this.say(`El modelo propone: ${d.tool.replaceAll("_", " ")}`);
        if (d.tool === "close_mission") this.callout("pump", "Propone cerrar");
        return this.wait(200);
      }
      if (e.type === "tool.start") {
        const id = T.depotFor(d.tool, d);
        const route = T.routeFor(id), p = this.flow(route, { cls: d.actor === "harness" ? "pv" : "p" });
        this.calls[e.span_id] = { id, p, route };
        this.say(`${d.actor === "harness" ? "Harness" : "Modelo"} → ${d.tool.replaceAll("_", " ")}`);
        return this.wait(150);
      }
      if (e.type === "tool.end") {
        const call = this.calls[d.call_span]; if (call) await call.p;
        if (!live()) return;
        const id = call?.id || T.depotFor(d.tool, d);
        if (d.outcome === "DELIVERY_UNKNOWN") {
          this.flash(id, "warn"); this.callout(id, "Respuesta perdida", "warn");
          this.q('[data-readout="receipt"]').textContent = "Acuse perdido · resultado incierto";
          this.say("La orden existe en el sistema, pero su respuesta se ha perdido");
          return this.wait(550);
        }
        if (d.tool === "lookup_operation" && d.outcome === "FOUND") {
          this.q('[data-readout="receipt"]').textContent = "Recibo original recuperado";
          this.flash("retry"); this.callout("retry", "Sin repetir la escritura", "v");
        } else if (id) {
          this.flash(id, ["PENDING", "REJECTED", "NOT_FOUND"].includes(d.outcome) ? "warn" : "pass");
          this.callout(id, LABELS[d.outcome] || d.outcome, d.outcome === "PENDING" ? "warn" : "");
        }
        this.flow(call?.route || T.routeFor(id), { reverse: true, cls: d.actor === "harness" ? "pv" : "pr" });
        delete this.calls[d.call_span];
        return this.wait(200);
      }
      if (e.type === "ledger") { this.q('[data-readout="ledger"]').textContent = `${d.open} obligaciones abiertas`; return; }
      if (e.type === "harness.control") {
        const id = { completion: "gate", retry: "retry", preconditions: "guard", ledger: "ledger" }[d.layer] || "esd";
        this.flash(id, e.outcome === "pass" ? "pass" : "info");
        if (d.layer === "completion") {
          this.eq("gate").classList.toggle("gate-held", e.outcome === "block");
          if (e.outcome === "block") { this.callout("gate", "Falta evidencia", "v"); this.flow("M240 28 H470 V144", { cls: "pv" }); }
        }
        if (d.layer === "preconditions") {
          this.eq("guard").classList.toggle("gate-held", e.outcome === "block");
          if (e.outcome === "block") this.callout("guard", "Escritura retenida", "v");
        }
        if (d.layer === "ledger" && e.outcome === "block") this.callout("ledger", "Bucle detectado", "v");
        if (d.layer === "completion" && e.outcome === "flag") this.callout("gate", "Trabajo devuelto al modelo", "v");
        if (d.layer === "retry" && e.outcome === "info") this.q('[data-readout="operation"]').textContent = "Clave persistida antes de escribir";
        this.say(`${d.label}: ${d.detail}`); return this.wait(e.outcome === "block" ? 600 : 140);
      }
      if (e.type === "governance.decision") {
        this.eq("esd").classList.add("closed"); this.turn.status = "stop"; this.say(`Plataforma: ${d.code}`);
        this.callout("esd", d.code, "dark"); return this.wait(500);
      }
      if (e.type === "turn.end") {
        clearInterval(this.timer); this.timer = null;
        this.eq("pump").classList.remove("spin");
        this.turn.status = e.outcome === "blocked" ? "stop" : d.outcome === "verificado" ? "verified"
          : d.outcome === "incumplimiento" ? "risk" : "pending";
        this.turn.elapsed = d.usage?.latency_ms || performance.now() - this.turn.started;
        this.turns[this.lane] = { ...this.turn };
        this.say(this.turn.status === "verified" ? "Misión verificada en los sistemas" : this.turn.status === "risk"
          ? "Los sistemas registran un incumplimiento" : "Misión pendiente; consulta la evidencia");
        await this.flow(REPLY, { n: 5 });
        if (live()) this.renderHud();
      }
    }
  }
  window.Plant = Plant;
})();

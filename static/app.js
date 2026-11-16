const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "$1");
const SIDE_ES = { good: "vCurrent", excellent: "vNext" };
const MKEY = { "gpt-4.1-mini": "mini", "gpt-6.1-sol": "sol" };
// Orden del guion: falla el básico, se prueba un modelo mayor, se mejora el harness, y por último ambos.
const LANES = [["good", "gpt-4.1-mini"], ["good", "gpt-6.1-sol"], ["excellent", "gpt-4.1-mini"], ["excellent", "gpt-6.1-sol"]]
  .map(([side, model]) => ({ id: `${side}-${MKEY[model]}`, side, model }));
const LANE = Object.fromEntries(LANES.map((l) => [l.id, l]));
const fmtN = (n) => Number(n || 0).toLocaleString("es-ES");
const usd = (n) => `${Number(n || 0).toLocaleString("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} $`;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let SID = newId("mission"), META, PLANT, ACTIVE = "good", MODEL = "gpt-4.1-mini", BUSY = false, STARTED = false, firstRequest = "";
const ALL_ON = { ledger: true, preconditions: true, completion: true, retry: true };
let layerState = { ...ALL_ON }, faults = {}, BENCH = null;
const fresh = (v) => Object.fromEntries(LANES.map((l) => [l.id, typeof v === "function" ? v() : v]));
const last = fresh(null), checkpoints = fresh(() => []), fired = fresh(() => ({})), attempted = fresh(false), pressured = fresh(false);
const laneId = (side = ACTIVE, model = MODEL) => `${side}-${MKEY[model]}`;
const cur = () => LANE[laneId()];
const modelLabel = (m) => META.models[m]?.label || m;
const laneLabel = (l) => `${SIDE_ES[l.side]} · ${modelLabel(l.model)}`;
const EXPLAIN = {
  prompt: "Mismas instrucciones de negocio y de verificación. vCurrent también sabe que debe comprobar los resultados.",
  azure: "El mismo endpoint y filtro de contenido de Azure para ambos. No se desactiva para provocar un fallo.",
  history: "Ambos conservan los mensajes y resultados de sus herramientas durante la conversación.",
  ledger: "Lleva el registro de obligaciones a partir de lo que devuelven las herramientas y se lo recuerda al modelo en cada paso. Detecta bucles: si el modelo repite un intento fallido sin que nada cambie, devuelve el motivo sin ejecutarlo y, a la sexta vez, para y lo deja para revisión humana.",
  preconditions: "Antes de crear una orden o avisar a los vecinos, pregunta a los proveedores (con las mismas herramientas) si los tres recursos están confirmados en esa franja y si ya se emitió. Si no, retiene la escritura y explica qué falta.",
  completion: "Antes de cerrar, verifica en vivo los tres sectores. Si el modelo intenta terminar con trabajo abierto, se lo devuelve (hasta 4 veces). Nunca convierte en éxito algo no acreditado.",
  retry: "Guarda una clave estable antes de escribir. Si se pierde la respuesta, consulta el recibo con una herramienta disponible para ambos. No repite a ciegas ni inventa éxito si falta el recibo.",
};

async function api(path, body, timeoutMs = 150000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { signal: ctl.signal, ...(body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : {}) });
    const j = await r.json();
    if (!r.ok && !j.error) j.error = `HTTP ${r.status}: ${JSON.stringify(j.detail || j)}`;
    return j;
  } catch (e) {
    return { error: e.name === "AbortError" ? "La solicitud agotó el tiempo de espera. Revisa Operaciones antes de repetir."
      : `No se pudo leer la respuesta del servidor: ${e.message}` };
  } finally { clearTimeout(timer); }
}

let modalFocus;
function openModal(html, wide = false) {
  modalFocus = document.activeElement;
  $("#modal-body").innerHTML = html;
  $(".modal-box").classList.toggle("wide", wide);
  $("#modal").classList.remove("hidden");
  $("#modal-close").focus();
}
function closeModal() { $("#modal").classList.add("hidden"); modalFocus?.focus(); }
function errorHTML(error) { return `<p class="msg err" role="alert">${esc(error)}</p>`; }

function buildPanes() {
  $("#panes").innerHTML = LANES.map((l) => `<div class="pane" data-pane="${l.id}">
      <div class="statusline"><div class="banner" id="banner-${l.id}"></div></div>
      <div class="impact" id="impact-${l.id}"></div>
      <div class="chat" id="chat-${l.id}"></div>
      <footer class="stats" id="stats-${l.id}"></footer></div>`).join("");
  $("#trace-panes").innerHTML = LANES.map((l) => `<div class="tracepane" id="trace-${l.id}" data-pane="${l.id}"></div>`).join("");
}

function renderControls() {
  const L = cur().id, labels = { ...META.good_layers, ...META.layers };
  $("#chips").innerHTML = Object.entries(labels).map(([k, label], i) => {
    const common = k in META.good_layers, on = common || ACTIVE === "excellent" && layerState[k];
    return `<button class="chip ${on ? "on" : "absent"}${!common && on ? " exc" : ""}${fired[L][k] ? " fired" : ""}"
      data-k="${k}" title="${esc(label)}" style="--i:${i}"><span class="cl">${esc(label)}</span><span class="n">${fired[L][k] || ""}</span></button>`;
  }).join("");
  $("#chips").querySelectorAll("[data-k]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); showExplain(b.dataset.k, b); });
  $("#systems").innerHTML = PlantTopology.DEPOTS.map((d) => `<span class="sys-t on" title="${esc(d.sub)}">${esc(d.label)}</span>`).join("");
  $("#caps-count").textContent = `${META.tools.length} herramientas · mismo catálogo y presupuesto`;
  $("#presets").classList.toggle("hidden", ACTIVE !== "excellent");
  const locked = LANES.some((l) => l.side === "excellent" && attempted[l.id]);
  document.querySelectorAll("[data-preset]").forEach((b) => {
    b.disabled = BUSY || locked;
    const on = Object.values(layerState).filter(Boolean).length;
    b.classList.toggle("active", b.dataset.preset === "all" ? on === 4 : on === 0);
  });
}

function showExplain(k, anchor) {
  const locked = LANES.some((l) => l.side === "excellent" && attempted[l.id]);
  const canToggle = k in META.layers && ACTIVE === "excellent" && !BUSY && !locked;
  $("#pop").innerHTML = `<div class="eyebrow">${esc(META.layers[k] || META.good_layers[k])}</div><p>${esc(EXPLAIN[k])}</p>
    ${canToggle ? `<button class="pill sm" id="pop-toggle">${layerState[k] ? "Apagar" : "Encender"}</button>`
      : `<span class="sub">${k in META.layers ? "Configura antes de ejecutar vNext; reinicia para cambiarlo después." : "Común a ambos harnesses."}</span>`}`;
  $("#pop").classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  $("#pop").style.left = `${Math.max(8, Math.min(r.left, innerWidth - 336))}px`;
  $("#pop").style.top = `${Math.min(r.bottom + 8, innerHeight - $("#pop").offsetHeight - 8)}px`;
  if (canToggle) $("#pop-toggle").onclick = () => {
    layerState[k] = !layerState[k]; $("#pop").classList.add("hidden"); applyLayers();
  };
}
function applyLayers() {
  renderControls();
  PLANT.configure(ACTIVE, ACTIVE === "excellent" ? layerState : {}, cur().id, modelLabel(MODEL));
}
function select(side = ACTIVE, model = MODEL) {
  if (BUSY) return;
  ACTIVE = side; MODEL = model;
  const L = cur();
  if (META) $("#model").textContent = `${model} · Microsoft Foundry`;
  document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("on", p.dataset.pane === L.id));
  document.querySelectorAll(".sw[data-side]").forEach((b) => {
    const on = b.dataset.side === side; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".sw[data-model]").forEach((b) => {
    const on = b.dataset.model === model; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1;
  });
  $(".harness-switch").dataset.side = side;
  $(".model-switch").dataset.side = model === "gpt-6.1-sol" ? "excellent" : "good";
  $("#bs-meta").textContent = laneLabel(L);
  $("#send").textContent = `Enviar a ${laneLabel(L)}`;
  $(`#trace-${L.id}`).innerHTML ||= `<p class="sub empty">Aún no hay turnos con ${esc(laneLabel(L))}.</p>`;
  applyLayers(); renderActions();
}

function nextLane() { return LANES.find((l) => !last[l.id] && l.id !== cur().id); }
function renderActions() {
  const L = cur().id;
  $("#mission-run").disabled = BUSY;
  $("#mission-run").textContent = last[L] ? "Continuar misión" : "Ejecutar misión";
  for (const id of ["#send", "#reset", "#msg"]) $(id).disabled = BUSY;
  document.querySelectorAll(".sw").forEach((b) => b.disabled = BUSY);
  document.querySelectorAll("[data-fault]").forEach((b) => {
    b.disabled = BUSY || STARTED;
    b.setAttribute("aria-pressed", String(!!faults[b.dataset.fault]));
    b.title = STARTED ? "Reinicia para cambiar los fallos en todas las copias." : "El mismo fallo para todas las ejecuciones.";
  });
  $("#compare-step").disabled = BUSY || !LANES.some((l) => checkpoints[l.id].length);
  const done = LANES.filter((l) => last[l.id]).length, next = nextLane();
  $("#nextbar").classList.toggle("hidden", BUSY || !last[L]);
  if (!BUSY && last[L]) {
    $("#nextbar").innerHTML = `<div class="row">
      ${next ? `<button class="pill primary" id="run-next">Misma misión · ${esc(laneLabel(next))}</button>` : ""}
      ${done > 1 ? `<button class="pill ${next ? "" : "primary"}" id="compare-runs">Comparar ejecuciones</button>` : ""}
      ${!pressured[L] ? `<button class="pill" id="pressure" title="${esc(META.pressure)}">Presión del jefe de turno</button>` : ""}
      </div>`;
    if ($("#pressure")) $("#pressure").onclick = () => { pressured[L] = true; sendActive(META.pressure); };
    if ($("#run-next")) $("#run-next").onclick = () => { select(next.side, next.model); sendActive(firstRequest || META.mission); };
    if ($("#compare-runs")) $("#compare-runs").onclick = showRuns;
  }
  renderControls();
}

const CELL = { confirmed: ["✓", "done", "Confirmado"], pending: ["…", "handed", "Pendiente"], open: ["–", "open", "Sin hacer"], risk: ["!", "risk", "Incumple"] };
function renderAssessment(L, a) {
  const risk = a.violations.length;
  const close = a.rows.find((r) => r.id === "close");
  $(`#impact-${L}`).className = `impact mission-impact${risk ? " risk" : ""}`;
  $(`#impact-${L}`).innerHTML = `<div class="assessment-head"><span class="lbl">Hechos en los sistemas</span><span class="lbl">${a.done}/${a.total}</span></div>
    <table class="mx"><thead><tr><th></th>${Object.values(META.items).map((l) => `<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>
    ${a.sectors.map((sec) => `<tr><th title="${esc(sec.label)}">${esc(sec.label.split(" · ")[1] || sec.id)}<span class="sub"> ${sec.slot || ""}</span></th>
      ${sec.items.map((it) => `<td><span class="tag ${CELL[it.status][1]}" title="${esc(`${it.label} · ${it.detail}`)}" aria-label="${esc(`${it.label}: ${CELL[it.status][2]}, ${it.detail}`)}">${CELL[it.status][0]}</span></td>`).join("")}</tr>`).join("")}
    </tbody></table>
    <div class="it close-row"><span class="tag ${CELL[close.status][1]}">${close.ok ? "Verificado" : CELL[close.status][2]}</span><span>Cierre del expediente<span class="sub"> · ${esc(close.detail)}</span></span></div>
    ${risk ? `<p class="assessment-warning">${esc(a.violations.join(" "))}</p>` : ""}`;
}

function addMsg(L, cls, text) {
  const el = document.createElement("div"); el.className = cls; el.innerHTML = md(text);
  $(`#chat-${L}`).appendChild(el);
  $(`#chat-${L}`).scrollTop = $(`#chat-${L}`).scrollHeight;
  return el;
}
function renderResult(L, r) {
  renderAssessment(L, r.assessment);
  const violated = r.assessment.violations.length || r.assessment.duplicates || r.status === "completed" && !r.assessment.complete;
  const b = $(`#banner-${L}`);
  b.className = `banner ${r.stopped_by_platform ? "neutral" : violated ? "risk" : r.assessment.complete ? "held" : "neutral"}`;
  b.textContent = r.stopped_by_platform ? `Detenido · ${r.stopped_by_platform.code}` : r.assessment.complete ? "Misión verificada"
    : violated ? "La evidencia no acredita el éxito" : "Misión pendiente";
  $(`#stats-${L}`).innerHTML = `<span title="${esc(r.usage.cost_note)}">${esc(modelLabel(r.model))} · ${fmtN(r.usage.charged_tokens)} tokens · ${(r.usage.latency_ms / 1000).toFixed(0)} s · ≈ ${usd(r.usage.cost_usd)}</span>
    <button class="pill sm" data-diagnose="${L}">Diagnosticar</button>`;
  $(`#stats-${L} [data-diagnose]`).onclick = () => diagnose(L);
}
const SYM = { pass: "✓", block: "✕", flag: "!", info: "•", warn: "!" };
function checkHTML(c) {
  return `<div class="ck s-${c.status} ${c.layer in META.layers ? "harness" : "platform"}"><span class="sym">${SYM[c.status] || "•"}</span>
    <span class="lb">${esc(c.label)}</span><span class="dt">${esc(c.detail)}</span></div>`;
}
function traceHTML(steps) {
  return steps.map((s) => {
    const eq = s.k === "tool" || s.k === "proposal" ? PlantTopology.depotFor(s.name, { args: s.args }) : s.k === "model" ? "pump" : "gate";
    let body, kind;
    if (s.k === "model") {
      kind = "Modelo"; body = `<div class="model-line">${(s.ms / 1000).toFixed(1)} s · ${s.tin} → ${s.tout} tokens · ${esc(s.decision)} <span class="origin real">Azure OpenAI · real</span></div>`;
    } else if (s.k === "proposal") {
      kind = "Propone"; body = `<span class="fn">${esc(s.name)}</span><div class="args">${esc(JSON.stringify(s.args))}</div>`;
    } else if (s.k === "tool") {
      kind = s.actor === "harness" ? "Harness" : "Sistema";
      const cls = ["DELIVERY_UNKNOWN", "PENDING", "REJECTED"].includes(s.outcome) ? "o-warn" : "o-soft";
      body = `<div class="head"><span class="fn">${esc(s.name)}</span><span class="outcome ${cls}">${esc(s.outcome || "En curso")}</span>
        <span class="sys">${esc(s.system)}</span><span class="origin">Simulado</span></div>
        <div class="args">${esc(JSON.stringify(s.args || {}))}</div>
        ${s.note ? `<p class="toolnote">${esc(s.note)}</p>` : ""}
        ${s.result ? `<details class="raw"><summary>Recibo del sistema</summary><pre>${esc(JSON.stringify(s.result, null, 2))}</pre></details>` : ""}`;
    } else if (s.k === "checkpoint") {
      kind = "Prueba"; body = `<button class="pill sm" data-checkpoint="${esc(s.id)}">${esc(s.label)}</button>`;
    } else if (s.k === "assessment") {
      kind = "Evidencia"; body = `<span class="fn">${s.assessment.done}/${s.assessment.total} requisitos · ${s.assessment.duplicates} duplicados</span>
        <div class="sub">${esc(s.assessment.violations.join(" "))}</div>`;
    } else if (s.checks) {
      kind = s.k === "platform" ? "Plataf." : "Control"; body = `<div class="checks">${s.checks.map(checkHTML).join("")}</div>`;
    } else return "";
    return `<div class="step" data-eq="${eq || ""}"><div class="k">${kind}</div><div>${body}</div></div>`;
  }).join("");
}
function bindTrace(el) {
  el.querySelectorAll("[data-checkpoint]").forEach((b) => b.onclick = () => showComparison(b.dataset.checkpoint));
  el.querySelectorAll("[data-eq]").forEach((row) => {
    row.onmouseenter = () => PLANT.highlight(row.dataset.eq);
    row.onmouseleave = () => PLANT.highlight(null);
  });
}
function makeTrace(L, turn) {
  const pane = $(`#trace-${L}`);
  pane.querySelector(".empty")?.remove();
  pane.querySelectorAll("details").forEach((d) => d.open = false);
  const el = document.createElement("details"); el.className = "trace"; el.open = true; pane.appendChild(el);
  return { el, L, turn, steps: [], calls: {} };
}
function liveTrace(trace, e) {
  const d = e.data || {};
  if (e.type === "inference.end" && d.purpose === "executor") trace.steps.push({ k: "model", ms: d.ms, tin: d.tokens_in, tout: d.tokens_out,
    decision: d.calls.length ? `llama a ${d.calls.join(", ")}` : "propone respuesta final" });
  else if (e.type === "model.proposal") trace.steps.push({ k: "proposal", name: d.tool, args: d.args });
  else if (e.type === "harness.control") trace.steps.push({ k: "nudge", checks: [{ ...d, status: e.outcome }] });
  else if (e.type === "tool.start") {
    const s = { k: "tool", name: d.tool, args: d.args, actor: d.actor, system: d.system };
    trace.steps.push(s); trace.calls[e.span_id] = s;
  } else if (e.type === "tool.end" && trace.calls[d.call_span]) {
    Object.assign(trace.calls[d.call_span], { outcome: d.outcome, note: d.note, result: d.result });
  } else if (e.type === "checkpoint.created") trace.steps.push({ k: "checkpoint", ...d });
  else return;
  trace.el.innerHTML = `<summary><span class="eyebrow">Turno ${trace.turn}</span><span class="eyebrow live-dot">En curso</span></summary>${traceHTML(trace.steps)}`;
  bindTrace(trace.el);
  const body = trace.el.closest(".bs-body"); body.scrollTop = body.scrollHeight;
}

function openStream(runId, onEvent) {
  let es, cursor = 0, done = false, closed = false, timer, activePoll = false;
  const accept = (e) => {
    if (closed || e.seq <= cursor) return;
    cursor = e.seq; onEvent(e);
    if (e.type === "turn.end") done = true;
  };
  const poll = async () => {
    if (closed || activePoll) return;
    activePoll = true;
    const r = await api(`/api/events?run_id=${runId}&after=${cursor}`, null, 5000);
    activePoll = false;
    (r.events || []).forEach(accept);
    if (r.error) console.warn("Canal de eventos:", r.error);
    if (!closed && !done) timer = setTimeout(poll, 500);
  };
  try {
    es = new EventSource(`/api/events/stream?run_id=${runId}`);
    es.addEventListener("ev", (e) => accept(JSON.parse(e.data)));
    es.addEventListener("done", () => { done = true; es.close(); });
    es.onerror = () => { es.close(); poll(); };
  } catch (e) { console.warn("SSE no disponible; se consultan eventos:", e); poll(); }
  return {
    async settle() {
      const deadline = Date.now() + 4000;
      while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (!done) await poll();
    },
    close() { closed = true; clearTimeout(timer); es?.close(); },
  };
}

async function sendActive(text) {
  if (!text.trim() || BUSY) return;
  const lane = cur(), L = lane.id;
  BUSY = true; STARTED = true; attempted[L] = true; firstRequest ||= text; fired[L] = {};
  renderActions(); $("#agent").classList.add("busy");
  addMsg(L, "msg user", text);
  const thinking = addMsg(L, "thinking", "En curso");
  const trace = makeTrace(L, (last[L]?.turn || 0) + 1), runId = newId(`${SIDE_ES[lane.side]}-${MKEY[lane.model]}`.toLowerCase());
  PLANT.beginTurn();
  PLANT.onSay = (t) => { thinking.textContent = t || "En curso"; };
  const stream = openStream(runId, (e) => {
    liveTrace(trace, e); PLANT.push(e);
    if (e.type === "mission.state") renderAssessment(L, e.data);
    if (e.type === "checkpoint.created") checkpoints[L].push(e.data);
    if (e.type === "harness.control") { fired[L][e.data.layer] = (fired[L][e.data.layer] || 0) + 1; renderControls(); }
  });
  try {
    const r = await api("/api/chat", { sid: SID, side: lane.side, model: lane.model, message: text,
      layers: lane.side === "excellent" ? layerState : null, faults, run_id: runId }, 900000);
    await stream.settle();
    await PLANT.drain();
    if (r.error) {
      addMsg(L, "msg bot err", r.error);
      trace.el.insertAdjacentHTML("beforeend", errorHTML(r.error));
    } else {
      last[L] = r; checkpoints[L] = r.checkpoints;
      trace.el.innerHTML = `<summary><span class="eyebrow">Turno ${r.turn} · ${esc(laneLabel(lane))} · ${r.trace.length} pasos</span>
        <span class="eyebrow">${(r.usage.latency_ms / 1000).toFixed(1)} s · <a class="evlink" href="/api/evidence/${r.run_id}" download>Evidencia JSON</a></span></summary>${traceHTML(r.trace)}`;
      bindTrace(trace.el);
      addMsg(L, "msg bot", r.reply); renderResult(L, r);
    }
  } catch (e) {
    addMsg(L, "msg bot err", `No se pudo completar la presentación del turno: ${e.message}`);
    console.error(e);
  } finally {
    stream.close(); PLANT.onSay = null; thinking.remove(); BUSY = false;
    $("#agent").classList.remove("busy"); renderActions();
  }
}

async function resetAll() {
  if (BUSY) return;
  const r = await api("/api/reset", { sid: SID });
  if (r.error) { openModal(errorHTML(r.error)); return; }
  SID = newId("mission"); STARTED = false; firstRequest = "";
  PLANT.resetAll();
  for (const l of LANES) {
    last[l.id] = null; checkpoints[l.id] = []; fired[l.id] = {}; attempted[l.id] = false; pressured[l.id] = false;
    $(`#chat-${l.id}`).replaceChildren(); $(`#stats-${l.id}`).replaceChildren(); $(`#banner-${l.id}`).textContent = "";
    $(`#trace-${l.id}`).innerHTML = "";
    renderAssessment(l.id, META.initial_assessment);
  }
  $("#msg").value = "";
  select(ACTIVE, MODEL);
}

async function showConditions() {
  BENCH = await api("/api/bench", null, 5000);
  const params = (m) => Object.entries(META.models[m].params).map(([k, v]) => k === "reasoning" ? `razonamiento ${v.effort}` : `temperatura ${v}`).join(", ");
  openModal(`<h3>Condiciones del experimento</h3>
    <p class="sub">Todas las ejecuciones reciben la misma misión, prompt, catálogo, permisos de herramientas, fallos y límites. Solo cambian el harness y, si lo eliges, el modelo.</p>
    <div class="condition-grid">
      <div><span class="eyebrow">Modelos</span>${Object.keys(META.models).map((m) => `<p>${esc(modelLabel(m))} · ${esc(params(m))} · ${META.models[m].price[0]} / ${META.models[m].price[1]} $ por millón (entrada / salida)</p>`).join("")}</div>
      <div><span class="eyebrow">Límite por turno</span><p>${fmtN(META.limits.tokens)} tokens · ${META.limits.model_calls} llamadas al modelo · ${META.limits.tool_calls} a herramientas</p></div>
      <div><span class="eyebrow">Herramientas</span><p>${META.tools.length} · mismo esquema</p><code>${META.tool_hash.slice(0, 20)}</code></div>
      <div><span class="eyebrow">Prompt común</span><code>${META.prompt_hash.slice(0, 20)}</code></div>
    </div>
    <p class="sub">GPT-6.1 Sol no acepta temperatura; usa razonamiento de esfuerzo medio. Es la única diferencia de configuración entre modelos. Precios de lista Global Standard; el coste es una estimación, no facturación. Los sistemas y fallos son simulados; la inferencia es real.</p>
    ${benchHTML()}
    <details class="raw"><summary>Contrato de herramientas compartido</summary><pre>${esc(JSON.stringify(META.tools, null, 2))}</pre></details>`, true);
}

function benchHTML() {
  if (!BENCH?.available) return `<p class="sub">Aún no hay medición previa. Ejecuta <code>scripts/bench.py</code> para obtenerla.</p>`;
  const d = new Date(BENCH.generated).toLocaleDateString("es-ES");
  const rows = LANES.map((l) => ({ l, v: BENCH.summary[`${l.side}|${l.model}`] })).filter((x) => x.v);
  const fails = (f) => f.failures.map(([k, n]) => `${esc(k)} ×${n}`).join(" · ") || "ninguno";
  return `<div class="bench"><div class="eyebrow">Medición previa · ${BENCH.runs_per_profile} misiones por combinación · ${d}</div>
    <table class="results-table bench-table"><thead><tr><th>Harness</th><th>Modelo</th><th>Completas</th><th>Coste mediano</th><th>Tiempo</th><th>Fallos</th></tr></thead><tbody>
    ${rows.map(({ l, v }) => `<tr class="${l.side}"><td>${SIDE_ES[l.side]}</td><td>${esc(modelLabel(l.model))}</td>
      <td><b class="${v.complete === v.runs ? "ok" : v.complete === 0 ? "ko" : ""}">${v.complete}/${v.runs}</b></td>
      <td>${usd(v.median_cost_usd)}</td><td>${v.median_seconds} s</td><td class="sub">${fails(v)}</td></tr>`).join("")}
    </tbody></table><p class="sub">${esc(BENCH.note)}</p></div>`;
}

function showCheckpoints() {
  const list = LANES.flatMap((l) => checkpoints[l.id].map((cp) => ({ ...cp, lane: l }))).sort((a, b) => (b.harmful - a.harmful) || (b.premature - a.premature));
  openModal(`<h3>Comparar el mismo paso</h3><p class="sub">Decisiones reales del modelo. Mismo estado y misma propuesta; solo cambia el control que la vigila. Sin nuevas llamadas al modelo.</p>
    <div class="checkpoint-list">${list.map((cp) => `<button class="checkpoint-choice" data-checkpoint="${cp.id}">
      <span>${cp.harmful ? `<span class="tag risk">Causaría daño</span> ` : cp.premature ? `<span class="tag handed">Prematura</span> ` : ""}${esc(cp.label.replace(" · causaría daño", ""))}</span><span class="sub">${esc(laneLabel(cp.lane))} · ${cp.state_hash.slice(0, 12)}</span></button>`).join("")}</div>`, true);
  bindTrace($("#modal-body"));
}

async function showComparison(id) {
  openModal('<h3>Comparar el mismo paso</h3><p class="thinking">Reproduciendo en dos copias aisladas</p>', true);
  const r = await api("/api/compare", { sid: SID, checkpoint_id: id }, 15000);
  if (r.error) { $("#modal-body").innerHTML = errorHTML(r.error); return; }
  const source = `Decisión real del modelo · ${SIDE_ES[r.profile]} · ${esc(modelLabel(r.model))} · control aislado: ${esc(r.control_label)}`;
  $("#modal-body").innerHTML = `<h3>Una propuesta. Dos resultados.</h3><p class="proof-source">${source}</p>
    <pre class="proposal-code">${esc(`${r.proposal.tool}(${JSON.stringify(r.proposal.args)})`)}</pre>
    <div class="proof-arms">${r.arms.map((a) => `<section class="proof-arm ${a.control_enabled ? "protected" : ""}">
      <div class="eyebrow">${esc(r.control_label)} · ${a.control_enabled ? "activado" : "desactivado"}</div>
      <h3>${a.result.status === "BLOCKED_BY_HARNESS" ? "Retenido por el harness" : { SENT: "Aviso enviado", CREATED: "Orden creada", CLOSED: "Cierre admitido" }[a.result.status] || esc(a.result.status)}</h3>
      <p>${a.assessment.done}/${a.assessment.total} requisitos acreditados</p>
      <p class="sub">${esc(a.result.message || "")}</p>
      ${a.assessment.violations.length ? `<p class="proof-warning">${esc(a.assessment.violations.join(" "))}</p>` : ""}
      ${a.result.missing ? `<p class="sub">Motivo: ${esc(a.result.missing.join("; "))}</p>` : ""}
    </section>`).join("")}</div>
    <div class="proof-foot"><span class="eyebrow">Estado idéntico · ${r.arms[0].initial_state_hash.slice(0, 12)}</span>
      <span class="eyebrow">Propuesta idéntica · ${r.arms[0].proposal_hash.slice(0, 12)}</span>
      <span class="eyebrow">${r.model_calls} llamadas al modelo · misión original intacta</span></div>
    <p class="sub">${esc(r.scope)}</p>
    <a class="pill sm evidence-download" href="/api/evidence/${r.run_id}" download>Exportar esta comparación</a>`;
}

async function showRuns() {
  BENCH = await api("/api/bench", null, 5000);
  const runs = LANES.filter((l) => last[l.id]).map((l) => ({ l, r: last[l.id] }));
  const keys = ["limits", "tool_hash", "prompt_hash", "code_hash", "request_hash", "state_hash", "history_hash", "faults", "platform_mode", "platform_agent"];
  const base = runs[0].r.conditions;
  const mismatches = keys.filter((k) => runs.some(({ r }) => JSON.stringify(r.conditions[k]) !== JSON.stringify(base[k])));
  const cell = (f) => runs.map(({ r }) => `<td>${f(r)}</td>`).join("");
  const verdict = (r) => r.assessment.complete ? `<span class="tag done">Verificada</span>` : r.status === "completed"
    ? `<span class="tag risk">Dijo «hecho»</span>` : `<span class="tag handed">Pendiente</span>`;
  openModal(`<h3>Resultados de estas ejecuciones</h3><p class="${mismatches.length ? "proof-warning" : "sub"}">${mismatches.length
    ? `Condiciones distintas: ${esc(mismatches.join(", "))}. No es una comparación controlada.`
    : "Misma misión, prompt, herramientas, fallos y límites. Solo cambian el harness y el modelo indicados."}</p>
    <table class="results-table"><thead><tr><th></th>${runs.map(({ l }) => `<th class="${l.side}">${SIDE_ES[l.side]}<br><span class="sub">${esc(modelLabel(l.model))}</span></th>`).join("")}</tr></thead><tbody>
      <tr><td>Resultado</td>${cell(verdict)}</tr>
      <tr><td>Requisitos cumplidos</td>${cell((r) => `${r.assessment.done}/${r.assessment.total}`)}</tr>
      <tr><td>Incumplimientos</td>${cell((r) => r.assessment.violations.length)}</tr>
      <tr><td>Coste estimado</td>${cell((r) => usd(r.usage.cost_usd))}</tr>
      <tr><td>Tiempo</td>${cell((r) => `${(r.usage.latency_ms / 1000).toFixed(0)} s`)}</tr>
      <tr><td>Tokens</td>${cell((r) => fmtN(r.usage.charged_tokens))}</tr>
    </tbody></table>
    ${runs.filter(({ r }) => r.assessment.violations.length).map(({ l, r }) => `<p class="proof-warning">${esc(laneLabel(l))}: ${esc(r.assessment.violations.join(" "))}</p>`).join("")}
    ${benchHTML()}<p class="sub">Unas pocas ejecuciones no establecen una tasa de fiabilidad; por eso se muestra también la medición previa.</p>`, true);
}

async function diagnose(L) {
  const lane = LANE[L];
  openModal(`<h3>Qué pasó · ${esc(laneLabel(lane))}</h3><p class="thinking">Revisando la ejecución</p>`, true);
  const r = await api("/api/diagnose", { sid: SID, side: lane.side, model: lane.model }, 60000);
  if (r.error) { $("#modal-body").innerHTML = errorHTML(r.error); return; }
  const p = r.plain, ok = p.done === p.total;
  $("#modal-body").innerHTML = `<div class="diag">
    <div class="eyebrow">${esc(laneLabel(lane))}</div>
    <h3>${esc(p.title)}</h3>
    <div class="dx-claim"><div><span class="eyebrow">El agente dijo</span><p>«${esc(p.said)}»</p></div>
      <div><span class="eyebrow">En los sistemas</span><p class="dx-score ${ok ? "ok" : "bad"}"><b>${p.done} de ${p.total}</b> tareas hechas</p></div></div>
    ${p.lead ? `<p class="summary">${esc(p.lead)}</p>` : ""}
    ${p.story.length ? `<div class="eyebrow dx-sec">Qué pasó</div><ol class="dx-story">${p.story.map((x) => `<li class="${x.kind}"><p>${esc(x.text)}</p>
      ${x.fix ? `<p class="sub">${esc(x.fix)}${x.checkpoint ? ` <button class="link-btn" data-checkpoint="${x.checkpoint}">Ver la diferencia</button>` : ""}</p>` : ""}</li>`).join("")}</ol>` : ""}
    ${p.why ? `<div class="dx-why"><b>Por qué creyó que había terminado.</b> ${esc(p.why)}
      ${p.gaps.length ? `<ul>${p.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}</div>` : ""}
    <a class="pill sm evidence-download" href="/api/evidence/${r.run_id}" download>Exportar evidencia</a></div>`;
  bindTrace($("#modal-body"));
}

// Operaciones conserva el plano de control compartido.
const OPS = { timer: null, after: 0, events: [], gov: null, polling: false };
const EV_ES = {
  "turn.start": (d) => `Turno ${d.turn} · ${d.harness}`,
  "turn.end": (d) => `Fin del turno · ${d.outcome}`,
  "inference.start": (d) => `Modelo · reserva ${d.reserved_tokens} tokens`,
  "inference.end": (d) => `Modelo respondió · ${d.tokens_in}→${d.tokens_out} tokens · ${d.ms} ms`,
  "inference.error": (d) => `Error del modelo · ${d.error}`,
  "inference.in_flight": (d) => d.note,
  "model.proposal": (d) => `Propone ${d.tool}`,
  "tool.start": (d) => `${d.actor === "harness" ? "Harness" : "Modelo"} → ${d.tool}`,
  "tool.end": (d) => `${d.tool}: ${d.outcome}`,
  "harness.control": (d) => `${d.label}: ${d.detail}`,
  "mission.state": (d) => `Evidencia: ${d.done}/${d.total} · ${d.duplicates} duplicados`,
  "fault.triggered": (d) => d.fault === "pending_reservation" ? "Fallo simulado · reserva pendiente" : "Fallo simulado · respuesta perdida",
  "checkpoint.created": (d) => d.label,
  "comparison.tool": (d) => `Comparación aislada · ${d.tool}`,
  "comparison.end": () => "Comparación terminada · sin inferencia",
  "budget.exhausted": (d) => d.message,
  "governance.decision": (d) => `Plataforma deniega ${d.code} · ${d.reason}`,
  "agent.state_changed": (d) => `${d.agent} → ${d.state} (v${d.version})`,
  "agent.budget_changed": (d) => `Presupuesto → ${d.budget_tokens} tokens`,
  "lab.mode_changed": (d) => `Modo → ${d.mode}`,
  "probe.start": (d) => `Sonda · ${d.label}`,
  "probe.end": (d) => `Sonda ${d.decision}: handler ${d.handler_executed ? "ejecutado" : "NO ejecutado"} · contador ${d.handler_count}`,
  "diagnosis.start": (d) => `Diagnóstico del turno ${d.target_turn}`,
  "diagnosis.end": (d) => `Diagnóstico: ${d.summary || d.note || d.decision || ""}`,
};
function renderTimeline() {
  $("#ops-timeline").innerHTML = OPS.events.slice(-120).reverse().map((e) => {
    const cls = e.type === "harness.control" ? "harness" : e.type.startsWith("inference") ? "mdl"
      : ["warn", "uncertain", "error"].includes(e.outcome) ? "incident" : e.outcome;
    return `<div class="ev ${esc(cls)}"><span class="t">${esc(e.ts.slice(11, 19))}</span>
      <span class="who" title="${esc(e.run_id)}">${esc(e.agent_id || "laboratorio")}${e.profile ? ` · ${e.profile === "good" ? "vCurrent" : "vNext"}` : ""}</span>
      <span class="what">${esc(EV_ES[e.type] ? EV_ES[e.type](e.data) : e.type)}</span></div>`;
  }).join("");
}
async function pollEvents() {
  if (OPS.polling) return;
  OPS.polling = true;
  const r = await api(`/api/events?after=${OPS.after}&limit=200&tail=${OPS.after === 0}`, null, 8000);
  OPS.polling = false;
  if (r.error) { $("#ops-live").textContent = r.error; return; }
  if (r.events.length) {
    OPS.after = r.events.at(-1).id;
    OPS.events.push(...r.events); OPS.events = OPS.events.slice(-400);
    renderTimeline();
    if (r.events.some((e) => e.type.startsWith("agent.") || ["turn.end", "probe.end", "lab.mode_changed"].includes(e.type))) loadGov();
  }
  $("#ops-live").textContent = `En directo · ${new Date().toLocaleTimeString("es-ES")}`;
}
function startOps() { if (!OPS.timer) { loadGov(); pollEvents(); OPS.timer = setInterval(pollEvents, 1000); } }
function stopOps() { clearInterval(OPS.timer); OPS.timer = null; }

function budgetHTML(a) {
  if (!a.budget) return "";
  return Object.entries(a.budget).filter(([p, b]) => b.used || b.reserved || p !== "-").map(([p, b]) => {
    const pct = (v) => Math.min(100, 100 * v / Math.max(1, b.limit));
    return `<div class="bud"><span>${SIDE_ES[p] || p} · sesión</span><span>${fmtN(b.used)} / ${fmtN(b.limit)}</span></div>
      <div class="bar"><span class="res" style="width:${pct(b.used + b.reserved)}%"></span><span style="width:${pct(b.used)}%"></span></div>`;
  }).join("");
}
async function loadGov() {
  const g = await api(`/api/governance?sid=${SID}`, null, 8000);
  if (g.error) { $("#ops-agents").innerHTML = errorHTML(g.error); return; }
  OPS.gov = g;
  $("#ops-registry").textContent = `Registro ${g.registry === "local" ? "local de laboratorio" : g.registry} · ${g.policy_version}`;
  document.querySelectorAll("#ops-mode [data-mode]").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === g.mode); b.classList.toggle("base", b.dataset.mode === "baseline");
  });
  $("#ops-agents").innerHTML = g.agents.map((a) => `<div class="agent ${a.state}">
    <div class="top"><div><h3>${esc(a.name)}</h3><div class="id">${esc(a.id)} · v${a.version}</div></div>
      <span class="state ${a.state}">${a.state === "blocked" ? "Bloqueado" : "Activo"}</span></div>
    <div class="meta">${esc(a.provider)}</div><div class="meta">${esc(a.role)}</div>
    <div class="meta">Ámbito: ${esc(a.scopes.join(", "))} · ${esc(a.identity)}</div>
    ${a.state === "blocked" ? `<div class="meta">${esc(a.reason)}</div>` : ""}${budgetHTML(a)}
    <div class="row"><button class="pill sm" data-act="${a.state === "blocked" ? "restore" : "block"}" data-id="${a.id}">${a.state === "blocked" ? "Restaurar" : "Bloquear"}</button>
      ${a.probes.map((p) => `<button class="pill sm" data-probe="${p.operation}">${esc(p.label)}</button>`).join("")}
      <span class="counter">handlers · ${a.handler_count}</span></div></div>`).join("");
  $("#ops-agents").querySelectorAll("[data-act]").forEach((b) => b.onclick = () => askState(b.dataset.id, b.dataset.act === "block" ? "blocked" : "active"));
  $("#ops-agents").querySelectorAll("[data-probe]").forEach((b) => b.onclick = async () => {
    const r = await api("/api/governance/probe", { operation: b.dataset.probe }, 10000);
    if (r.error) openModal(errorHTML(r.error));
    loadGov(); pollEvents();
  });
}
function askState(id, st) {
  const a = OPS.gov.agents.find((x) => x.id === id), verb = st === "blocked" ? "Bloquear" : "Restaurar";
  openModal(`<h3>${verb} · ${esc(a.name)}</h3><p class="sub">Se comprueba en cada inferencia y herramienta. No deshace trabajo ya realizado.</p>
    <textarea class="reason" id="st-reason" aria-label="Motivo">${st === "blocked" ? "Revisión del responsable del COI" : "Revisado por el responsable del COI"}</textarea>
    <button class="pill primary" id="st-ok">${verb}</button><span id="st-err" role="alert"></span>`);
  $("#st-ok").onclick = async () => {
    const r = await api(`/api/governance/agents/${id}/state`, { state: st, reason: $("#st-reason").value.trim(), expected_version: a.version }, 10000);
    if (r.error) { $("#st-err").textContent = r.error; loadGov(); return; }
    closeModal(); loadGov(); pollEvents();
  };
}

async function init() {
  META = await api("/api/meta");
  if (META.error || !META.mission) { $("#agent").innerHTML = errorHTML(META.error || "El servidor aún no tiene la versión de misión. Reinícialo."); return; }
  $("#model").textContent = `${META.model} · Microsoft Foundry`;
  $("#brand-mark").textContent = "TH";
  faults = { ...META.faults };
  api("/api/bench", null, 5000).then((b) => { BENCH = b; });
  PLANT = new Plant($("#plant-svg"), $("#plant-hud"), $("#plant-ticker"), modelLabel(MODEL));
  buildPanes();
  LANES.forEach((l) => renderAssessment(l.id, META.initial_assessment));
  select("good", "gpt-4.1-mini");
  document.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === t));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === t.dataset.tab));
    if (t.dataset.tab === "ops") startOps(); else stopOps();
  });
  document.querySelectorAll(".sw[data-side]").forEach((b) => b.onclick = () => select(b.dataset.side, MODEL));
  document.querySelectorAll(".sw[data-model]").forEach((b) => b.onclick = () => select(ACTIVE, b.dataset.model));
  $(".harness-switch").onkeydown = (e) => {
    if (BUSY || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault(); select(ACTIVE === "good" ? "excellent" : "good", MODEL); $(`.sw[data-side="${ACTIVE}"]`).focus();
  };
  $(".model-switch").onkeydown = (e) => {
    if (BUSY || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault(); select(ACTIVE, MODEL === "gpt-4.1-mini" ? "gpt-6.1-sol" : "gpt-4.1-mini"); $(`.sw[data-model="${MODEL}"]`).focus();
  };
  $("#mission-run").onclick = () => sendActive(last[cur().id] ? "Revisa lo pendiente y continúa la misión sin duplicar lo ya realizado." : META.mission);
  const send = () => { const t = $("#msg").value.trim(); if (t && !BUSY) { $("#msg").value = ""; sendActive(t); } };
  $("#send").onclick = send;
  $("#msg").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  $("#reset").onclick = resetAll;
  document.querySelectorAll("[data-fault]").forEach((b) => b.onclick = () => { faults[b.dataset.fault] = !faults[b.dataset.fault]; renderActions(); });
  document.querySelectorAll("[data-preset]").forEach((b) => b.onclick = () => {
    layerState = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, b.dataset.preset === "all"])); applyLayers();
  });
  $("#fairness").onclick = showConditions;
  $("#compare-step").onclick = showCheckpoints;
  $("#plant-replay").onclick = () => { if (!BUSY) PLANT.replay(); };
  $("#modal-close").onclick = closeModal;
  $("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
  document.addEventListener("click", (e) => { if (!e.target.closest("#pop")) $("#pop").classList.add("hidden"); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); $("#pop").classList.add("hidden"); }
    if (e.key === "Tab" && !$("#modal").classList.contains("hidden")) {
      const items = [...$("#modal").querySelectorAll("button:not(:disabled), a, textarea, summary")].filter((el) => el.getClientRects().length);
      if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1).focus(); }
      if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
    }
  });
  document.querySelectorAll("#ops-mode [data-mode]").forEach((b) => b.onclick = async () => {
    if (b.dataset.mode === "baseline" && !confirm("Se desactiva el control de plataforma para ambos harnesses. ¿Continuar?")) return;
    const r = await api("/api/governance/mode", { mode: b.dataset.mode }, 10000);
    if (r.error) openModal(errorHTML(r.error)); else { loadGov(); pollEvents(); }
  });
  $("#ops-reset").onclick = async () => {
    if (BUSY || !confirm("Reiniciar laboratorio: agentes, conversaciones, presupuestos y evidencia a cero. ¿Continuar?")) return;
    const r = await api("/api/governance/lab/reset", { confirm: "REINICIAR" }, 10000);
    if (r.error) { openModal(errorHTML(r.error)); return; }
    OPS.events = []; OPS.after = 0; $("#ops-timeline").replaceChildren();
    await resetAll(); loadGov();
  };
  if (location.hash === "#ops") $('.tab[data-tab="ops"]').click();
}
init();

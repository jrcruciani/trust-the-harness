const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(resolve(__dirname, "../static/kitchen.js"), "utf8");

function kitchen(reduced = true) {
  const frames = [], hud = {}, drawing = [], media = { matches: reduced };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (s) => ({ width: s.length * 6 });
      if (key.startsWith("create")) return () => ({ addColorStop() {} });
      return (...args) => {
        assert.ok(args.every((a) => typeof a !== "number" || Number.isFinite(a)), `${key}: non-finite argument`);
        if (key === "arc" || key === "ellipse") assert.ok(args[2] >= 0);
        drawing.push([key, ...args]);
      };
    },
  });
  const canvas = {
    style: {}, width: 0, height: 0, clientWidth: 960, handlers: {},
    setAttribute() {}, getContext: () => ctx,
    addEventListener(type, fn) { this.handlers[type] = fn; },
  };
  const host = {
    style: {}, clientWidth: 960, clientHeight: 600, visible: true,
    appendChild() {}, getClientRects() { return this.visible ? [{}] : []; },
  };
  const document = { hidden: false, createElement: () => canvas, querySelector: () => null, addEventListener() {} };
  const window = { matchMedia: () => media, performance, devicePixelRatio: 1, addEventListener() {} };
  const sandbox = vm.createContext({
    window, document, console, performance, setTimeout, setInterval() {},
    getComputedStyle: () => ({ position: "relative" }),
    requestAnimationFrame: (fn) => frames.push(fn),
  });
  vm.runInContext(source, sandbox);
  const plant = new window.Plant(host, {
    querySelector(s) { return s === "h3" ? null : (hud[s] ||= {}); },
  }, { textContent: "" }, "GPT-4.1 mini");
  return { plant, host, canvas, document, frames, drawing, media, Plant: window.Plant };
}

const layers = { ledger: true, preconditions: true, completion: true, retry: true };
function assessment(complete) {
  return {
    sectors: ["S4", "S7", "S9"].map((id) => ({
      id, slot: complete ? "M3" : null,
      items: ["crew", "material", "water", "order", "notice"].map((id) => ({
        id, status: complete ? "confirmed" : "open",
        detail: `${complete ? 1 : 0} ${id}`,
      })),
    })),
    rows: [{ id: "close", ok: complete, status: complete ? "confirmed" : "open" }],
    done: complete ? 16 : 0, total: 16,
  };
}
const event = (type, data = {}, outcome = "") => ({ type, data, outcome });
async function run(plant, events) {
  events.forEach((e) => plant.push(e));
  await plant.drain();
}

test("switching lanes restores facts, counters, tickets and the progress rail", async () => {
  const { plant } = kitchen();
  plant.configure("excellent", layers, "excellent-mini", "GPT-4.1 mini");
  plant.beginTurn();
  await run(plant, [
    event("turn.start"),
    event("harness.control", { layer: "ledger" }, "info"),
    event("harness.control", { layer: "retry" }, "info"),
    event("harness.control", { layer: "retry" }, "flag"),
    event("ledger", { open: 0 }),
    event("mission.state", assessment(true)),
    event("turn.end", { outcome: "verificado", usage: { cost_usd: .02, latency_ms: 24000 } }),
  ]);
  plant.configure("good", {}, "good-sol", "GPT-6.1 Sol");
  assert.equal(plant.world.sec.S4.notice, "open");
  assert.equal(plant.star, true);
  assert.equal(Object.keys(plant.firedN).length, 0);
  plant.configure("excellent", layers, "excellent-mini", "GPT-4.1 mini");
  assert.equal(plant.star, false);
  assert.equal(plant.turn.done, 16);
  assert.equal(plant.turn.cost, .02);
  assert.equal(plant.world.close, "ok");
  assert.equal(plant.world.sec.S4.notices, 1);
  assert.deepEqual({ ...plant.firedN }, { ledger: 1, retry: 2 });
  assert.equal(plant.keys, 1);
  assert.equal(plant.ledgerOpen, 0);
});

test("replay does not double counters and reset clears every lane", async () => {
  const { plant } = kitchen();
  plant.configure("excellent", layers, "excellent-mini");
  plant.beginTurn();
  await run(plant, [
    event("turn.start"),
    event("harness.control", { layer: "retry" }, "info"),
    event("mission.state", assessment(true)),
    event("turn.end", { outcome: "verificado" }),
  ]);
  plant.replay();
  await plant.drain();
  assert.equal(plant.turn.done, 16);
  assert.equal(plant.keys, 1);
  assert.equal(plant.firedN.retry, 1);
  plant.resetAll();
  plant.configure("excellent", layers, "excellent-mini");
  assert.equal(plant.turn.done, 0);
  assert.equal(plant.keys, 0);
  assert.equal(Object.keys(plant.firedN).length, 0);
  assert.equal(plant.canReplay(), false);
});

test("the notice guard lights up the pass, not the stove", async () => {
  const { plant } = kitchen();
  await run(plant, [
    event("model.proposal", { tool: "send_notice", args: { sector: "S4" } }),
    event("harness.control", { layer: "preconditions", detail: "Faltan recursos confirmados" }, "block"),
  ]);
  assert.equal(plant.gate.pass.held, true);
  assert.equal(plant.gate.stove.held, false);
});

test("all four model/harness combinations render facts and disabled controls", async () => {
  const { plant } = kitchen();
  for (const side of ["good", "excellent"]) {
    for (const model of ["GPT-4.1 mini", "GPT-6.1 Sol"]) {
      plant.configure(side, layers, `${side}-${model}`, model);
      assert.equal(plant.on.ledger, side === "excellent");
      await run(plant, [
        event("turn.start"),
        event("mission.state", assessment(true)),
        event("turn.end", { outcome: "verificado" }),
      ]);
      plant.draw();
      assert.equal(plant.turn.done, 16);
    }
  }
  plant.configure("excellent", { ...layers, preconditions: false }, "custom");
  assert.equal(plant.on.preconditions, false);
  assert.equal(plant.on.completion, true);
});

test("platform denial remains visible after changing lanes", async () => {
  const { plant } = kitchen();
  plant.configure("good", {}, "blocked");
  await run(plant, [
    event("turn.start"),
    event("governance.decision", { code: "AG-02" }, "deny"),
    event("turn.end", { outcome: "detenido" }, "blocked"),
  ]);
  assert.equal(plant.ticker.textContent, "Detenido por la plataforma");
  plant.configure("excellent", layers, "other");
  plant.configure("good", {}, "blocked");
  assert.equal(plant.esd, true);
  assert.equal(plant.banner.status, "stop");
});

test("reduced motion is static and resize never exceeds the available panel", async () => {
  const { plant, host, canvas, drawing } = kitchen();
  await run(plant, [
    event("turn.start"),
    event("mission.state", assessment(true)),
    event("turn.end", { outcome: "verificado" }),
  ]);
  assert.equal(plant.confetti.length, 0);
  assert.equal(plant.tweens.length, 0);
  plant.draw();
  const hash = (ops) => createHash("sha256").update(JSON.stringify(ops)).digest("hex");
  const before = hash(drawing.splice(0));
  plant.tick(1000);
  plant.draw();
  assert.equal(hash(drawing), before);
  host.clientWidth = 160; host.clientHeight = 100;
  plant.resize();
  assert.equal(canvas.style.width, "160px");
});

test("idle painting is throttled and hidden panels do not paint", () => {
  const { plant, host, frames, document } = kitchen(false);
  let paints = 0;
  plant.draw = () => paints++;
  for (let t = 0; t <= 1000; t += 10) frames.shift()(t);
  assert.equal(paints, 2);
  host.visible = false;
  for (let t = 1010; t <= 2000; t += 10) frames.shift()(t);
  assert.equal(paints, 2);
  host.visible = true; document.hidden = true;
  for (let t = 2010; t <= 3000; t += 10) frames.shift()(t);
  assert.equal(paints, 2);
});

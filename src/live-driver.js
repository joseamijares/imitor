// The live preview's driver. `imitor app` serves the built preview on its own origin and adds this script to every
// page of it, so the review interface (another origin, in the parent window) can drive the app inside its <iframe>
// with postMessage: perform flow steps (tap, fill, wait, waitFor, scroll) the way src/shoot.mjs does with Playwright,
// clear the app's stored state, and hear about the route and the stand-ins on screen. It only obeys the parent
// origins written into window.__imitorLive by the app server. Plain browser script, no modules.
(function () {
  "use strict";
  var config = window.__imitorLive || {};
  var parents = config.parents || [];
  if (window.parent === window || !parents.length) return;

  function post(message) {
    message.imitor = message.imitor || "event";
    for (var i = 0; i < parents.length; i++) {
      try { window.parent.postMessage(message, parents[i]); } catch (e) { /* wrong origin: dropped */ }
    }
  }
  var sleep = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
  var norm = function (s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    var style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function disabled(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (n.disabled === true || n.getAttribute("aria-disabled") === "true") return true;
    }
    return false;
  }

  /** Like Playwright's getByText: the smallest elements whose whole text matches. */
  function byText(text, exact) {
    var want = norm(text), lower = want.toLowerCase(), all = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (var el = walker.currentNode; el; el = walker.nextNode()) {
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      var t = norm(el.textContent);
      if (exact ? t === want : t.toLowerCase().indexOf(lower) >= 0) all.push(el);
    }
    return all.filter(function (el) { return !all.some(function (o) { return o !== el && el.contains(o); }); });
  }
  function byLabel(label) {
    var want = norm(label), out = [];
    document.querySelectorAll("[aria-label]").forEach(function (el) { if (norm(el.getAttribute("aria-label")) === want) out.push(el); });
    document.querySelectorAll("[aria-labelledby]").forEach(function (el) {
      var text = el.getAttribute("aria-labelledby").split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ");
      if (norm(text) === want) out.push(el);
    });
    document.querySelectorAll("label").forEach(function (l) {
      if (norm(l.textContent) !== want) return;
      var c = l.control || l.querySelector("input, textarea, select");
      if (c) out.push(c);
    });
    return out;
  }
  function candidates(target) {
    if (typeof target === "string") return byText(target, true);
    if (!target || typeof target !== "object") return [];
    if (target.testId) return [].slice.call(document.querySelectorAll('[data-testid="' + CSS.escape(target.testId) + '"]'));
    if (target.label) return byLabel(target.label);
    if (target.placeholder) {
      var p = String(target.placeholder).toLowerCase();
      return [].slice.call(document.querySelectorAll("[placeholder]")).filter(function (el) { return el.getAttribute("placeholder").toLowerCase().indexOf(p) >= 0; });
    }
    if (target.text) return byText(target.text, target.exact !== false);
    if (target.css) return [].slice.call(document.querySelectorAll(target.css));
    throw new Error("cannot locate " + JSON.stringify(target));
  }
  function describeTarget(target) {
    if (typeof target === "string") return '"' + target + '"';
    var k = target && Object.keys(target)[0];
    return k ? k + ' "' + target[k] + '"' : JSON.stringify(target);
  }

  /** Wait until the target is on the page and visible (and enabled, for taps and fills). */
  async function find(target, timeout, needEnabled) {
    var until = Date.now() + timeout, seen = false;
    for (;;) {
      var list = candidates(target).filter(visible);
      if (list.length) {
        seen = true;
        if (!needEnabled || !disabled(list[0])) return list[0];
      }
      if (Date.now() > until) {
        throw new Error((seen ? "found " + describeTarget(target) + " but it stayed disabled" : "could not find " + describeTarget(target) + " on the screen") + " within " + timeout / 1000 + " s");
      }
      await sleep(100);
    }
  }

  var pointer = { x: 0, y: 0 };
  function fire(el, type, x, y, Ctor) {
    var init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: /down/.test(type) ? 1 : 0, detail: 1 };
    if (Ctor === window.PointerEvent) { init.pointerId = 1; init.pointerType = "mouse"; init.isPrimary = true; init.width = 1; init.height = 1; init.pressure = /down/.test(type) ? 0.5 : 0; }
    el.dispatchEvent(new Ctor(type, init));
  }
  async function tap(el) {
    var r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "center" });
      await sleep(50);
      r = el.getBoundingClientRect();
    }
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var hit = document.elementFromPoint(x, y);
    var t = hit && (el.contains(hit) || hit.contains(el)) ? hit : el;
    var P = window.PointerEvent || MouseEvent;
    pointer = { x: x, y: y };
    fire(t, "pointerover", x, y, P); fire(t, "mouseover", x, y, MouseEvent);
    fire(t, "pointerdown", x, y, P); fire(t, "mousedown", x, y, MouseEvent);
    var focusable = t.closest && t.closest("a, button, input, textarea, select, [tabindex]");
    if (focusable && focusable.focus) focusable.focus();
    await sleep(30);
    fire(t, "pointerup", x, y, P); fire(t, "mouseup", x, y, MouseEvent);
    fire(t, "click", x, y, MouseEvent);
  }
  function fill(el, value) {
    var input = /^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable ? el : el.querySelector("input, textarea, [contenteditable=true]");
    if (!input) throw new Error("the element found is not a text field");
    input.focus();
    if (input.isContentEditable) input.textContent = value;
    else {
      var proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function scroll(dy) {
    var x = pointer.x || innerWidth / 2, y = pointer.y || innerHeight / 2;
    for (var n = document.elementFromPoint(x, y); n && n !== document.documentElement; n = n.parentElement) {
      var s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) { n.scrollBy(0, dy); return; }
    }
    window.scrollBy(0, dy);
  }

  async function doStep(step) {
    if (step.tap !== undefined) await tap(await find(step.tap, 10000, true));
    else if (step.fill) fill(await find(step.fill, 10000, true), String(step.fill.value));
    else if (step.wait) await sleep(Number(step.wait));
    else if (step.waitFor) await find(step.waitFor, 15000, false);
    else if (step.scroll) scroll(Number(step.scroll));
    else if (step.shot) { /* nothing to do: the screen is the shot */ }
    else throw new Error("this step cannot be performed here: " + JSON.stringify(step));
  }

  // Remove what the app stored, keeping the imitor-* settings (scheme, motion).
  async function reset() {
    [window.localStorage, window.sessionStorage].forEach(function (store) {
      try {
        for (var i = store.length - 1; i >= 0; i--) { var k = store.key(i); if (!/^imitor-/.test(k)) store.removeItem(k); }
      } catch (e) { /* storage blocked */ }
    });
    try {
      if (indexedDB.databases) {
        var dbs = await indexedDB.databases();
        await Promise.all(dbs.map(function (d) { return new Promise(function (ok) { var r = indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = ok; }); }));
      }
    } catch (e) { /* not supported */ }
    try {
      if (window.caches) { var keys = await caches.keys(); await Promise.all(keys.map(function (k) { return caches.delete(k); })); }
    } catch (e) { /* not supported */ }
  }

  function standIns() {
    var counts = {};
    document.querySelectorAll("[data-imitor-stub]").forEach(function (el) {
      if (!visible(el)) return;
      var k = el.getAttribute("data-imitor-stub");
      counts[k] = (counts[k] || 0) + 1;
    });
    return Object.keys(counts).sort().map(function (k) { return { kind: k, count: counts[k] }; });
  }
  var route = function () { return location.pathname + location.search; };
  // The flow state the page started with (src/state.mjs puts it on globalThis.__imitor), and seed statements that failed.
  function setup() {
    var g = window.__imitor;
    if (!g || !("flow" in g)) return null;
    var errors = [];
    try { errors = JSON.parse(sessionStorage.getItem("imitor:seed-errors") || "[]"); } catch (e) { /* none */ }
    return { flow: g.flow || null, state: g.state == null ? null : g.state, seedErrors: errors };
  }
  var state = function () { return { route: route(), media: window.__imitorMedia || null, standIns: standIns(), title: document.title, setup: setup() }; };

  window.addEventListener("message", async function (e) {
    if (e.source !== window.parent || parents.indexOf(e.origin) < 0) return;
    var m = e.data || {};
    if (m.imitor === "hello") { var s = state(); s.imitor = "ready"; post(s); return; }
    if (m.imitor === "reset") { await reset(); post({ imitor: "reset-done", id: m.id }); return; }
    if (m.imitor === "step") {
      try {
        await doStep(m.step || {});
        await sleep(m.step && m.step.wait ? 0 : 150);
        post({ imitor: "step-done", id: m.id, ok: true, route: route(), standIns: standIns() });
      } catch (error) {
        post({ imitor: "step-done", id: m.id, ok: false, error: String(error && error.message || error), route: route() });
      }
    }
  });

  var lastRoute = null, lastStandIns = "";
  function watch() {
    var r = route();
    if (r !== lastRoute) { lastRoute = r; post({ imitor: "route", route: r }); }
    var s = standIns(), key = JSON.stringify(s);
    if (key !== lastStandIns) { lastStandIns = key; post({ imitor: "stand-ins", standIns: s }); }
  }
  function start() {
    var s = state(); s.imitor = "ready"; post(s);
    lastRoute = s.route; lastStandIns = JSON.stringify(s.standIns);
    setInterval(watch, 400);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();

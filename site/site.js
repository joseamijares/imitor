// Imitor site: theme switch, copy buttons, the ledger's leader lines, and the waitlist form. No dependencies.
(() => {
  const root = document.documentElement;

  // Theme: follows the system until the visitor picks one; the choice is kept in this browser only.
  const toggle = document.querySelector("[data-theme-toggle]");
  const current = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const label = () => toggle && toggle.setAttribute("aria-label", `Switch to ${current() === "dark" ? "light" : "dark"} theme`);
  label();
  toggle?.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("imitor-theme", next); } catch {}
    label();
    requestAnimationFrame(drawLeaders);
  });

  // Copy buttons: copy the command or code block next to them.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy");
    if (!btn) return;
    const holder = btn.closest(".cmd, .code");
    const text = holder?.querySelector("code")?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add("done");
      btn.setAttribute("aria-label", "Copied");
      setTimeout(() => { btn.classList.remove("done"); btn.setAttribute("aria-label", "Copy"); }, 1600);
    } catch {
      const r = document.createRange(); r.selectNodeContents(holder.querySelector("code"));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  });

  // Leader lines: from the edge of the device, level with each numbered pin, to its ledger row.
  const svg = document.getElementById("leaders");
  function drawLeaders() {
    if (!svg || getComputedStyle(svg).display === "none") return;
    const box = svg.getBoundingClientRect();
    const dev = document.getElementById("device").getBoundingClientRect();
    let out = "";
    document.querySelectorAll(".rows li[data-pin]").forEach((li, i) => {
      const pin = document.querySelectorAll(".device .pin")[Number(li.dataset.pin) - 1];
      const p = pin.getBoundingClientRect();
      const n = li.querySelector(".n").getBoundingClientRect();
      const warn = pin.classList.contains("w");
      const col = warn ? "var(--color-warn)" : "var(--color-t-3)";
      const y1 = p.top + p.height / 2 - box.top, x1 = dev.right - box.left + 14;
      const y2 = n.top + n.height / 2 - box.top, x2 = n.left - box.left - 8;
      const xm = x1 + 28 + i * 12;
      out += `<path d="M${x1} ${y1} H${xm} V${y2} H${x2}" fill="none" stroke="${col}" stroke-width="1" ${warn ? 'stroke-dasharray="4 3"' : ""}/>`;
      out += `<circle cx="${x1}" cy="${y1}" r="3" fill="${col}"/>`;
    });
    svg.innerHTML = out;
  }
  if (svg) {
    addEventListener("load", drawLeaders);
    addEventListener("resize", drawLeaders);
    document.fonts?.ready.then(drawLeaders);
  }

  // The waitlist form on the pricing page: posted here, so the answer shows in place. Without this script the form
  // posts itself and the function sends the browser back to #joined or #not-joined, which the stylesheet shows.
  const waitlist = document.querySelector("[data-waitlist]");
  const form = waitlist?.querySelector("form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const failed = waitlist.querySelector(".waitlist-failed");
    const usual = (failed.dataset.usual ||= failed.innerHTML);
    const show = (state, message) => {
      if (location.hash === "#joined" || location.hash === "#not-joined") history.replaceState(null, "", location.pathname + location.search);
      if (message) failed.textContent = message; else failed.innerHTML = usual;
      waitlist.dataset.state = state;
    };
    button.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.email.value, website: form.website.value }),
      });
      if (res.ok) {
        show("joined");
        waitlist.querySelector(".waitlist-done").focus();
      } else if (res.status === 400) show("failed", "That does not look like an email address. Check it and try again.");
      else if (res.status === 429) show("failed", "Too many tries from this connection. Try again in a few minutes.");
      else show("failed");
    } catch {
      show("failed");
    } finally {
      button.disabled = false;
    }
  });
})();

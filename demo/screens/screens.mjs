// Placeholder screens of "fernwood", an invented plant-care app, for the public demo's shots and videos.
// Plain HTML at 393 x 852. render.mjs turns them into the PNGs and .webm files in demo/assets/ (run it once, with
// Playwright, when these change; the demo build itself only copies the results).

const PALETTE = {
  light: { bg: "#f4f1e8", card: "#fffdf7", line: "#e2ddcf", ink: "#1f2a22", mute: "#6f776d", acc: "#2f6b4f", accInk: "#ffffff", tint: "#dfeadf", water: "#3c7fa8", waterTint: "#dcebf3" },
  dark: { bg: "#121813", card: "#1b231d", line: "#2a352c", ink: "#e9eee6", mute: "#93a094", acc: "#7cc39b", accInk: "#0f1a13", tint: "#20352a", water: "#7db7d9", waterTint: "#1b2c36" },
};

const css = (c) => `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:393px;height:852px;overflow:hidden}
body{background:${c.bg};color:${c.ink};font:15px/1.4 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column}
.top{padding:28px 22px 8px}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${c.mute};font-weight:600}
h1{font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-.01em;margin-top:6px}
h2{font-size:17px;font-weight:650}
p.lede{color:${c.mute};margin-top:10px;font-size:16px}
.body{flex:1;padding:12px 22px;display:flex;flex-direction:column;gap:12px;overflow:hidden}
.card{background:${c.card};border:1px solid ${c.line};border-radius:18px;padding:16px}
.row{display:flex;align-items:center;gap:12px}
.leaf{width:42px;height:42px;border-radius:12px;background:${c.tint};display:grid;place-items:center;flex:none}
.leaf i{width:18px;height:26px;background:${c.acc};border-radius:18px 2px 18px 2px;transform:rotate(25deg);display:block}
.grow{flex:1;min-width:0}.sub{color:${c.mute};font-size:13px}
.chip{display:inline-block;padding:6px 12px;border-radius:999px;border:1px solid ${c.line};font-size:13px;color:${c.mute}}
.chip.on{background:${c.acc};color:${c.accInk};border-color:${c.acc}}
.drop{display:inline-block;padding:3px 9px;border-radius:999px;background:${c.waterTint};color:${c.water};font-size:12px;font-weight:600}
.foot{padding:12px 22px 34px;display:flex;flex-direction:column;gap:10px}
.btn{height:52px;border-radius:16px;background:${c.acc};color:${c.accInk};font-weight:650;font-size:16px;display:grid;place-items:center}
.btn.ghost{background:transparent;color:${c.ink};border:1px solid ${c.line}}
.opt{display:flex;align-items:center;gap:12px}.opt .dot{width:22px;height:22px;border-radius:50%;border:2px solid ${c.line};flex:none}
.opt.on{border-color:${c.acc}}.opt.on .dot{border:7px solid ${c.acc}}
.field{border:1px solid ${c.line};background:${c.card};border-radius:14px;padding:10px 14px}.field label{font-size:12px;color:${c.mute};display:block}.field div{font-size:16px;margin-top:2px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tile{background:${c.card};border:1px solid ${c.line};border-radius:18px;padding:12px}.tile .pic{height:92px;border-radius:12px;background:linear-gradient(160deg,${c.tint},${c.bg});display:grid;place-items:center;margin-bottom:10px}
.tile.on{border-color:${c.acc};box-shadow:0 0 0 1px ${c.acc} inset}
.pic i{width:34px;height:52px;background:${c.acc};border-radius:34px 3px 34px 3px;transform:rotate(25deg);display:block;opacity:.85}
.tabs{display:flex;justify-content:space-around;padding:10px 0 30px;border-top:1px solid ${c.line};background:${c.card}}
.tabs span{font-size:11px;color:${c.mute};display:flex;flex-direction:column;align-items:center;gap:4px}.tabs span b{width:22px;height:22px;border-radius:7px;background:${c.line};display:block}
.tabs span.on{color:${c.acc}}.tabs span.on b{background:${c.acc}}
.ring{display:flex;align-items:center;gap:18px}
.stub{width:112px;height:112px;border-radius:14px;flex:none;border:1.5px dashed ${c.mute};background:repeating-linear-gradient(135deg,transparent 0 8px,${c.line} 8px 9px);display:grid;place-items:center;color:${c.mute};font:600 11px/1.2 ui-monospace,Menlo,monospace;text-align:center}
.check{width:24px;height:24px;border-radius:50%;border:2px solid ${c.line};flex:none}.check.done{background:${c.acc};border-color:${c.acc};position:relative}
.check.done:after{content:"";position:absolute;left:6px;top:2px;width:6px;height:11px;border:solid ${c.accInk};border-width:0 2.5px 2.5px 0;transform:rotate(45deg)}
.hero{height:230px;background:linear-gradient(170deg,${c.tint},${c.bg});display:grid;place-items:center}.hero i{width:70px;height:110px;background:${c.acc};border-radius:70px 5px 70px 5px;transform:rotate(25deg);display:block}
.stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.stats .card{padding:12px}.stats b{display:block;font-size:17px}
.scrim{position:absolute;inset:0;background:rgba(0,0,0,.38)}
.sheet{position:absolute;left:0;right:0;bottom:0;background:${c.card};border-radius:26px 26px 0 0;padding:12px 22px 34px;display:flex;flex-direction:column;gap:16px}
.grab{width:40px;height:5px;border-radius:3px;background:${c.line};margin:0 auto}
.amounts{display:flex;gap:10px}.amounts span{flex:1;height:62px;border-radius:14px;border:1px solid ${c.line};display:grid;place-items:center;font-weight:650}
.amounts span.on{border-color:${c.water};background:${c.waterTint};color:${c.water}}
.notif{background:${c.card};border:1px solid ${c.line};border-radius:20px;padding:14px;display:flex;gap:12px;box-shadow:0 8px 24px rgba(0,0,0,.08)}
.big-check{width:96px;height:96px;border-radius:50%;background:${c.tint};display:grid;place-items:center;margin:40px auto 8px}
.big-check i{width:26px;height:46px;border:solid ${c.acc};border-width:0 7px 7px 0;transform:rotate(45deg) translate(-4px,-6px);display:block}
.center{text-align:center}
`;

const leaf = `<span class="leaf"><i></i></span>`;
const tabs = (on) => `<nav class="tabs">${["Today", "Plants", "Journal", "Settings"].map((t) => `<span class="${t === on ? "on" : ""}"><b></b>${t}</span>`).join("")}</nav>`;
const ring = (done, total, c) => {
  const r = 46, len = 2 * Math.PI * r, frac = done / total;
  return `<svg width="112" height="112" viewBox="0 0 112 112" aria-hidden="true"><circle cx="56" cy="56" r="${r}" fill="none" stroke="${c.line}" stroke-width="12"/><circle cx="56" cy="56" r="${r}" fill="none" stroke="${c.water}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${len * frac} ${len}" transform="rotate(-90 56 56)"/><text x="56" y="62" text-anchor="middle" font-size="22" font-weight="700" fill="${c.ink}" font-family="-apple-system,Segoe UI,Roboto,Arial">${done}/${total}</text></svg>`;
};
const due = [
  ["Fern", "Boston fern · Living room", "250 ml"],
  ["Monty", "Monstera · Bedroom", "400 ml"],
  ["Sid", "Snake plant · Hallway", "150 ml"],
  ["Pip", "Pothos · Kitchen", "200 ml"],
  ["Fig", "Fiddle leaf fig · Study", "500 ml"],
];
const plantRow = ([name, sub, ml], done) => `<div class="card row"><span class="check${done ? " done" : ""}"></span>${leaf}<div class="grow"><h2>${name}</h2><div class="sub">${sub}</div></div><span class="drop">${ml}</span></div>`;

function today(c, { standIn, done }) {
  const visual = standIn ? `<div class="stub" data-imitor-stub="skia">skia<br>stand-in</div>` : ring(done, 5, c);
  return `<div class="top"><div class="eyebrow">Thursday</div><h1>Today</h1></div>
  <div class="body"><div class="card ring">${visual}<div><h2>${done} of 5 watered</h2><div class="sub" style="margin-top:4px">${5 - done} plants still need water today</div></div></div>
  ${due.slice(0, 4).map((p, i) => plantRow(p, i < done - 1 || (done >= 2 && i === 0))).join("")}</div>${tabs("Today")}`;
}

function detail(c, { button = "Log watering" } = {}) {
  return `<div class="hero"><i></i></div>
  <div class="top" style="padding-top:18px"><div class="eyebrow">Boston fern · Living room</div><h1>Fern</h1></div>
  <div class="body"><div class="stats"><div class="card"><span class="sub">Last watered</span><b>6 days</b></div><div class="card"><span class="sub">Every</span><b>7 days</b></div><div class="card"><span class="sub">Amount</span><b>250 ml</b></div></div>
  <div class="card"><h2>History</h2><div class="sub" style="margin-top:8px">Nov 6 · 250 ml<br>Oct 30 · 250 ml<br>Oct 23 · 200 ml</div></div></div>
  <div class="foot"><div class="btn">${button}</div></div>`;
}

export const SCREENS = {
  welcome: (c) => `<div class="body" style="justify-content:center;align-items:center;text-align:center;gap:18px"><div class="big-check" style="background:${c.tint}"><i style="border:0;width:40px;height:64px;background:${c.acc};border-radius:40px 4px 40px 4px;transform:rotate(25deg)"></i></div>
    <h1>Fernwood</h1><p class="lede">Keep every plant watered, fed and happy. Two minutes to set up.</p></div>
    <div class="foot"><div class="btn">Get started</div><div class="btn ghost">I already have an account</div></div>`,
  "your-space": (c) => `<div class="top"><div class="eyebrow">Step 1 of 5</div><h1>How bright is your space?</h1><p class="lede">We use it to tune watering.</p></div>
    <div class="body">${[["Low light", "North-facing, or far from windows"], ["Bright indirect", "Near a window, out of direct sun"], ["Direct sun", "South-facing sill or balcony"]].map(([t, s], i) => `<div class="card opt${i === 1 ? " on" : ""}"><span class="dot"></span><div><h2>${t}</h2><div class="sub">${s}</div></div></div>`).join("")}</div>
    <div class="foot"><div class="btn">Continue</div></div>`,
  "add-plant": () => `<div class="top"><div class="eyebrow">Step 2 of 5</div><h1>Add your first plant</h1></div>
    <div class="body"><div class="field"><div style="color:inherit;opacity:.5;margin:0">Search species</div></div>
    <div class="grid">${["Boston fern", "Monstera", "Snake plant", "Pothos"].map((n, i) => `<div class="tile${i === 0 ? " on" : ""}"><div class="pic"><i></i></div><h2>${n}</h2></div>`).join("")}</div></div>`,
  "plant-details": () => `<div class="top"><div class="eyebrow">Step 3 of 5</div><h1>Tell us about it</h1></div>
    <div class="body"><div class="field"><label>Name</label><div>Fern</div></div><div class="field"><label>Species</label><div>Boston fern</div></div><div class="field"><label>Room</label><div>Living room</div></div>
    <div><span class="chip">Small pot</span> <span class="chip on">Medium pot</span> <span class="chip">Large pot</span></div></div>
    <div class="foot"><div class="btn">Continue</div></div>`,
  schedule: (c) => `<div class="top"><div class="eyebrow">Step 4 of 5</div><h1>How often to water?</h1><p class="lede">Suggested for a Boston fern in bright, indirect light.</p></div>
    <div class="body"><div class="card row"><div class="grow"><span class="sub">Every</span><h1 style="margin:0">7 days</h1></div><span class="chip">−</span><span class="chip">+</span></div>
    <div class="card"><span class="sub">Amount</span><div class="amounts" style="margin-top:10px"><span>150 ml</span><span class="on">250 ml</span><span>400 ml</span></div></div></div>
    <div class="foot"><div class="btn">Continue</div></div>`,
  reminders: () => `<div class="top"><div class="eyebrow">Step 5 of 5</div><h1>Get a nudge when it’s time</h1><p class="lede">One quiet reminder in the morning, only on watering days.</p></div>
    <div class="body" style="justify-content:center"><div class="notif">${leaf}<div><h2>Fern is thirsty</h2><div class="sub">Give it 250 ml today · 8:00</div></div></div></div>
    <div class="foot"><div class="btn">Allow reminders</div><div class="btn ghost">Not now</div></div>`,
  "all-set": () => `<div class="body" style="justify-content:center;text-align:center"><div class="big-check"><i></i></div><h1>You’re all set</h1><p class="lede">Fern is in. Its first watering is today.</p></div>
    <div class="foot"><div class="btn">Go to Today</div></div>`,
  today: (c) => today(c, { standIn: false, done: 1 }),
  "today-standin": (c) => today(c, { standIn: true, done: 1 }),
  logged: (c) => today(c, { standIn: false, done: 2 }),
  "logged-standin": (c) => today(c, { standIn: true, done: 2 }),
  "plant-detail": (c) => detail(c),
  "plant-detail-renamed": (c) => detail(c, { button: "Water now" }),
  "log-sheet": (c) => `<div style="position:relative;flex:1;display:flex;flex-direction:column">${detail(c)}<div class="scrim"></div>
    <div class="sheet"><div class="grab"></div><h1 style="font-size:24px">Log watering</h1><div class="sub">Fern · Boston fern</div>
    <div class="amounts"><span>150 ml</span><span class="on">250 ml</span><span>400 ml</span></div><div class="btn">Add 250 ml</div></div></div>`,
  plants: () => `<div class="top"><h1>Plants</h1><div style="margin-top:12px"><span class="chip on">All</span> <span class="chip">Living room</span> <span class="chip">Bedroom</span> <span class="chip">Kitchen</span></div></div>
    <div class="body">${due.map(([n, s]) => `<div class="card row">${leaf}<div class="grow"><h2>${n}</h2><div class="sub">${s}</div></div><span class="sub">in ${n.length} d</span></div>`).join("")}</div>${tabs("Plants")}`,
};

/** The full HTML page of one screen in one scheme. */
export function page(name, scheme) {
  const c = PALETTE[scheme];
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css(c)}</style></head><body>${SCREENS[name](c)}</body></html>`;
}

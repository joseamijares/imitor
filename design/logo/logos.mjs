// Round 2. Y = chrome yellow, L = light ink, K = black.
export const Y = "#FFD60A", L = "#F5F5F2", K = "#0B0B0C";
let uid = 0;
// App-icon tile: dark squircle with a soft top light and a hairline rim.
export const tile = (inner, size = 120, variant = "dark") => { const id = "g" + uid++; const [a, b, rim] = variant === "dark" ? ["#222225", "#0B0B0C", "#34343A"] : variant === "yellow" ? ["#FFE352", "#F5C400", "#FFF0A0"] : ["#FFFFFF", "#ECECE8", "#FFFFFF"];
  return `<svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${id}" x1="60" y1="0" x2="60" y2="120" gradientUnits="userSpaceOnUse"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect x="1" y="1" width="118" height="118" rx="28" fill="url(#${id})"/><rect x="1.75" y="1.75" width="116.5" height="116.5" rx="27.25" stroke="${rim}" stroke-opacity="0.9" stroke-width="1.5"/>${inner}</svg>`; };
export const bare = (inner, size = 120) => `<svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

// 1. Twin i: the name has two i's. The first is real, the second is its dashed imitation.
export const twin = (ink = L, acc = Y) => `<circle cx="43" cy="33" r="10" fill="${ink}"/><rect x="34" y="50" width="18" height="46" rx="9" fill="${ink}"/><circle cx="77" cy="33" r="8" stroke="${acc}" stroke-width="4" stroke-dasharray="5.4 4.65" /><rect x="70" y="52" width="14" height="42" rx="7" stroke="${acc}" stroke-width="4" stroke-dasharray="6.5 5.1" stroke-linecap="round"/>`;

// 2. Echo: a solid slab in isometric view with its dashed copy floating above.
const iso = (dy, body) => `<g transform="translate(60 ${dy}) matrix(0.866 0.5 -0.866 0.5 0 0)">${body}</g>`;
export const echo = (ink = L, acc = Y, shade = "#8E8E88") => iso(84, `<rect x="-30" y="-30" width="60" height="60" rx="13" fill="${shade}"/>`) + iso(75, `<rect x="-30" y="-30" width="60" height="60" rx="13" fill="${ink}"/>`) + iso(75, `<rect x="-11" y="19" width="22" height="4.5" rx="2.25" fill="${shade}"/>`) + iso(44, `<rect x="-30" y="-30" width="60" height="60" rx="13" stroke="${acc}" stroke-width="3.6" stroke-dasharray="7.5 6.2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`);

// 3. Matrix: a phone screen of dots; the lit ones spell i.
export const matrix = (ink = L, acc = Y, dim = "#3D3D42") => { let s = `<rect x="23.5" y="9.5" width="73" height="101" rx="19" stroke="${ink}" stroke-width="5"/>`; for (let r = 0; r < 7; r++) for (let c2 = 0; c2 < 5; c2++) { const on = c2 === 2 && r !== 1; s += `<circle cx="${36 + c2 * 12}" cy="${24 + r * 12}" r="${on ? 4.6 : 3}" fill="${on ? acc : dim}"/>`; } return s; };

// Custom wordmark, drawn as strokes: "imitor". First i-dot solid, second a dashed ring.
export const wordmark = (h = 40, ink = L, acc = Y) => { const sw = 11; const P = `M6 20V60 M28 20V60 M28 31A11 11 0 0 1 50 31V60 M50 31A11 11 0 0 1 72 31V60 M94 20V60 M122 6V49A11 11 0 0 0 133 60H136 M111 20H135 M206 20V60 M206 35A15 15 0 0 1 221 20H223`;
  return `<svg height="${h}" viewBox="-2 -10 232 78" fill="none" xmlns="http://www.w3.org/2000/svg" style="height:${h}px;width:${(h * 232) / 78}px"><path d="${P}" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/><circle cx="171" cy="40" r="20" stroke="${ink}" stroke-width="${sw}"/><circle cx="6" cy="0" r="7.5" fill="${acc}"/><circle cx="94" cy="0" r="6" stroke="${acc}" stroke-width="3.2" stroke-dasharray="4 3.54"/></svg>`; };

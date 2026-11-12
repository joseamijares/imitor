// Pages that later rounds will fill in: the shell, a header, and one line.
import { html } from "../components.js";
import { pageHeader } from "./common.js";

export function mount(ctx) {
  const { title, line } = ctx.route;
  document.title = `${title} · Imitor`;
  ctx.main.innerHTML = String(html`${pageHeader(html`<h1>${title}</h1>`)}<div class="content"><p class="placeholder-page">${line}</p></div>`);
}

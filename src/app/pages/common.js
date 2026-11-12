// Pieces shared by pages: the 48px page header and the empty "no runs yet" state.
import { html, codeBlock } from "../components.js";

/** title: html for the left side (an <h1>, crumbs, chips). actions: html for the right side. */
export const pageHeader = (title, actions = "") =>
  html`<header class="page-header"><div class="page-title">${title}</div><div class="page-actions">${actions}</div></header>`;

export const noRuns = (project) => html`<div class="state">
  <h2>No runs yet</h2>
  <p>Run Imitor in ${project} to build the preview and take the first shots.</p>
  ${codeBlock(["npx imitor"])}
</div>`;

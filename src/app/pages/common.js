// Pieces shared by pages: the 48px page header and the empty "no runs yet" states (local, and Imitor Cloud).
import { html, codeBlock, button } from "../components.js";

/** title: html for the left side (an <h1>, crumbs, chips). actions: html for the right side. */
export const pageHeader = (title, actions = "") =>
  html`<header class="page-header"><div class="page-title">${title}</div><div class="page-actions">${actions}</div></header>`;

export const noRuns = (project) => html`<div class="state">
  <h2>No runs yet</h2>
  <p>Run Imitor in ${project} to build the preview and take the first shots.</p>
  ${codeBlock(["npx imitor"])}
</div>`;

export const noCloudRuns = (project) => html`<div class="state">
  <h2>No runs yet</h2>
  <p>Push a finished run of ${project} from the machine or CI job that made it, with an upload key of this project.</p>
  ${codeBlock([`IMITOR_CLOUD_URL=${location.origin} IMITOR_TOKEN=imk_… npx imitor push`])}
  ${button("Make an upload key", "secondary", { href: "/settings#access-keys", icon: "chevron" })}
</div>`;

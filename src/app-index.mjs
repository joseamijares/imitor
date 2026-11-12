// The interface's index.html, marked for where it is served: a static export (`imitor export`), the demo, or Imitor
// Cloud. A leaf module with no imports, so the cloud can use it without loading the CLI (export.mjs re-exports it).
export const MODE_META = "imitor-mode";
export const BASE_META = "imitor-base";

/** index.html with the mode marker (and the base marker, with root paths prefixed, when `base` is set) after <meta charset>. */
export function markIndex(html, mode, base = "") {
  let tag = `<meta name="${MODE_META}" content="${mode}">`;
  if (base) {
    tag += `\n  <meta name="${BASE_META}" content="${base}">`;
    html = html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${base}/`);
  }
  return /<meta charset[^>]*>/i.test(html) ? html.replace(/<meta charset[^>]*>/i, (m) => `${m}\n  ${tag}`) : html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`);
}

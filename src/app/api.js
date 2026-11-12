// Fetch wrapper for the app server's JSON API. Errors carry a readable message.

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(`The Imitor app server did not answer (${method} ${path}). Is \`imitor app\` still running?`, 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(`${method} ${path} returned ${res.status}${data?.error ? `: ${data.error}` : ""}`, res.status);
  if (data == null) throw new ApiError(`${method} ${path} did not return JSON`, res.status);
  return data;
}

export const api = {
  project: () => request("GET", "/api/project"),
  runs: () => request("GET", "/api/runs"),
  run: (id) => request("GET", `/api/runs/${encodeURIComponent(id)}`),
  problems: () => request("GET", "/api/problems"),
  setSeen: (id, seen) => request("POST", `/api/problems/${encodeURIComponent(id)}/seen`, { seen }),
  captures: () => request("GET", "/api/captures"),
  agents: () => request("GET", "/api/agents"),
};

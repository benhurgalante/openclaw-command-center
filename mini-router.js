// mini-router.js — Minimal router for raw Node.js HTTP server
// Matches routes with :param support, handles async handlers + JSON body parsing

class MiniRouter {
  constructor() {
    this.routes = [];
  }

  _add(method, pattern, handler) {
    // Convert /api/crm/companies/:id to regex
    const paramNames = [];
    const regexStr = pattern.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    const regex = new RegExp(`^${regexStr}$`);
    this.routes.push({ method, pattern, regex, paramNames, handler });
  }

  get(pattern, handler) { this._add("GET", pattern, handler); }
  post(pattern, handler) { this._add("POST", pattern, handler); }
  patch(pattern, handler) { this._add("PATCH", pattern, handler); }
  delete(pattern, handler) { this._add("DELETE", pattern, handler); }

  // Match a request, returns { handler, params } or null
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.regex);
      if (m) {
        const params = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = decodeURIComponent(m[i + 1]);
        }
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}

// Parse query string from URL
function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const qs = url.slice(idx + 1);
  const params = {};
  for (const pair of qs.split("&")) {
    const [k, v] = pair.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return params;
}

// Read JSON body from request
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") return resolve(null);
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 50 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

module.exports = { MiniRouter, parseQuery, readJsonBody };

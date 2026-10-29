/*!
 * harbor.js — Harbor Extensions SDK (runs inside the sandboxed iframe)
 *
 * Extension pages have no network access (CSP connect-src 'none') and cannot read the portal's cookies.
 * Every call is handed to the outer portal via postMessage, and the portal sends it as the current user;
 * the gateway decides on "credential ∩ AD group ∩ extension grant" and then passes the request through to the upstream system.
 *
 *   const me = await harbor.me();
 *   const snow = harbor.connector("snow");
 *   const res = await snow.get("/api/now/table/change_request", { query: { sysparm_limit: 10 } });
 *   res.status; res.ok; res.data;           // returned by the upstream as-is
 *   await harbor.can("snow", "change.write"); // whether the current user can use a capability
 *   const ctx = await harbor.context();       // { workspace, embedded }: the Harbor workspace the user is in, if any
 *
 * The platform stores no business data. State an extension needs lives in the team's own service or the source system,
 * and once registered as a connector is read and written through harbor.connector(...) as well.
 *
 * Gateway-level denials (unauthorized, rate limited, invalid path, etc.) throw HarborError
 * with code / reason / need, which can be shown to the user directly. Errors from the upstream system itself are not thrown;
 * the caller handles them via res.status.
 */
(function () {
  "use strict";

  var TIMEOUT_MS = 30000;
  var pending = new Map();
  var seq = 0;

  function HarborError(code, reason, need, status) {
    var e = new Error(reason || code);
    e.name = "HarborError";
    e.code = code;
    e.reason = reason || code;
    e.need = need || [];
    e.status = status || 0;
    return e;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.harbor !== 1 || !pending.has(msg.id)) return;
    var p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(HarborError(msg.error.code, msg.error.reason, msg.error.need, msg.error.status));
    else p.resolve(msg.result);
  });

  function call(op, payload) {
    if (window.parent === window) {
      return Promise.reject(HarborError("no_host", "The extension must be opened inside the Harbor portal"));
    }
    return new Promise(function (resolve, reject) {
      var id = "m" + ++seq + "-" + Math.random().toString(36).slice(2, 8);
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(HarborError("timeout", "The portal did not respond"));
      }, TIMEOUT_MS);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      // The portal and the extension are cross-origin (the extension has an opaque origin), so "*" is the only option; frame-ancestors guarantees the parent page is the portal
      // Envelope fields go last so payload fields cannot override them
      window.parent.postMessage(Object.assign({}, payload || {}, { harbor: 1, id: id, op: op }), "*");
    });
  }

  // Gateway denial -> throw HarborError; upstream response -> return as-is
  function unwrap(result) {
    if (result.gatewayError) {
      var d = result.data || {};
      throw HarborError(result.gatewayError, d.reason, d.need, result.status);
    }
    return result;
  }

  function withQuery(path, query) {
    if (!query) return path;
    var qs = new URLSearchParams();
    Object.keys(query).forEach(function (k) {
      var v = query[k];
      if (v === undefined || v === null) return;
      (Array.isArray(v) ? v : [v]).forEach(function (item) { qs.append(k, String(item)); });
    });
    var s = qs.toString().replace(/\+/g, "%20");
    if (!s) return path;
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + s;
  }

  function connector(name) {
    function request(method, path, options) {
      options = options || {};
      return call("gw", {
        connector: name,
        method: method,
        path: withQuery(path, options.query),
        body: options.body,
        contentType: options.contentType,
      }).then(unwrap);
    }
    return {
      request: request,
      get: function (path, options) { return request("GET", path, options); },
      post: function (path, body, options) { return request("POST", path, Object.assign({}, options, { body: body })); },
      put: function (path, body, options) { return request("PUT", path, Object.assign({}, options, { body: body })); },
      patch: function (path, body, options) { return request("PATCH", path, Object.assign({}, options, { body: body })); },
      delete: function (path, options) { return request("DELETE", path, options); },
    };
  }

  window.harbor = Object.freeze({
    version: "0.3.0",
    HarborError: HarborError,
    me: function () { return call("me").then(unwrap).then(function (r) { return r.data; }); },
    can: function (connectorName, capability) {
      return call("can", { connector: connectorName, capability: capability })
        .then(unwrap)
        .then(function (r) { return !!(r.data && r.data.allowed); });
    },
    connector: connector,
    // Where the extension is running: { workspace: string|null, embedded: boolean }.
    // When Harbor switches workspace it reloads the extension, so read this once at start-up.
    context: function () { return call("context").then(unwrap).then(function (r) { return r.data; }); },
  });
})();

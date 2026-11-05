"use strict";

// Build the UI with DOM APIs; do not concatenate data with innerHTML
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function main() {
  const app = document.getElementById("app");
  try {
    const me = await harbor.me();
    const card = h("div", { class: "hx-card hx-card-body" }, h("p", null, `Hello, ${me.display_name}`));
    const demo = h("p", { class: "hx-muted" }, "Connector demo: loading...");
    card.append(demo);
    app.replaceChildren(card);
    try {
      // Start the local backend at the address in env/local.yaml.
      const r = await harbor.connector("my-extension-api").get("/health");
      demo.textContent = `Connector demo: ${r.status || "ok"} - ${r.message || JSON.stringify(r)}`;
    } catch (e) {
      demo.textContent = `Connector demo: not configured yet (${e.reason || e.message})`;
    }
  } catch (e) {
    app.replaceChildren(h("div", { class: "hx-banner hx-banner-bad" }, e.reason || e.message));
  }
}

main();

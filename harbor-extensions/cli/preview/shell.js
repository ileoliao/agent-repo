"use strict";

const frame = document.getElementById("extension");
const requestState = document.getElementById("request-state");
const responseDetail = document.getElementById("response-detail");

function showRequest(message, bad = false, detail = null) {
  requestState.className = `request-state${bad ? " bad" : ""}`;
  const dot = document.createElement("span");
  dot.className = `request-dot${bad ? " bad" : ""}`;
  const label = document.createElement("span");
  label.textContent = message;
  requestState.replaceChildren(dot, label);
  responseDetail.hidden = detail == null;
  responseDetail.textContent = detail == null ? "" : typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
}

async function requestBridge(message) {
  try {
    const response = await fetch("/api/bridge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message) });
    return await response.json();
  } catch (error) {
    return { ok: false, status: 502, gatewayError: "bridge_error", data: { reason: String(error) } };
  }
}

async function probe(button, connector, path) {
  button.disabled = true;
  showRequest(`GET ${path} · checking…`);
  const result = await requestBridge({ op: "gw", connector, method: "GET", path });
  showRequest(`GET ${path} · ${result.status}`, !!result.gatewayError || !result.ok, result.data ?? result.text ?? null);
  button.disabled = false;
}

async function loadConnectors() {
  const root = document.getElementById("connectors");
  try {
    const response = await fetch("/api/preview-config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { connectors } = await response.json();
    root.replaceChildren();
    for (const connector of connectors) {
      const row = document.createElement("div"); row.className = "connector-row";
      const name = document.createElement("div"); name.className = "connector-name";
      const dot = document.createElement("span"); dot.className = "request-dot idle";
      const label = document.createElement("span"); label.textContent = connector.id;
      name.append(dot, label);
      const address = document.createElement("span"); address.className = "connector-address"; address.textContent = connector.upstream;
      row.append(name, address);
      for (const path of connector.probes) {
        const button = document.createElement("button");
        button.className = "probe-button"; button.type = "button";
        button.textContent = `↗  Test GET ${path}`;
        button.addEventListener("click", () => probe(button, connector.id, path));
        row.append(button);
      }
      root.append(row);
    }
  } catch (error) { root.textContent = `Configuration unavailable: ${error.message}`; }
}

window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const msg = event.data;
  if (!msg || msg.harbor !== 1 || typeof msg.id !== "string") return;
  const result = await requestBridge(msg);
  if (msg.op === "gw") showRequest(`${msg.method} ${msg.path} · ${result.status}`, !!result.gatewayError || !result.ok, result.data ?? result.text ?? null);
  frame.contentWindow.postMessage({ harbor: 1, id: msg.id, result }, "*");
});

document.getElementById("reload").addEventListener("click", () => { showRequest("Waiting for extension"); frame.src = frame.src; });
const debugPanel = document.getElementById("debug-panel");
const debugToggle = document.getElementById("debug-toggle");
function setDebugOpen(open) {
  debugPanel.hidden = !open;
  debugToggle.setAttribute("aria-expanded", String(open));
}
debugToggle.addEventListener("click", () => setDebugOpen(debugPanel.hidden));
document.getElementById("debug-close").addEventListener("click", () => setDebugOpen(false));
window.addEventListener("keydown", (event) => { if (event.key === "Escape") setDebugOpen(false); });
loadConnectors();

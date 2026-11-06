"use strict";

const frame = document.getElementById("extension");
const requestState = document.getElementById("request-state");

function showRequest(message, bad = false) {
  requestState.className = `request-state${bad ? " bad" : ""}`;
  const dot = document.createElement("span");
  dot.className = `request-dot${bad ? " bad" : ""}`;
  const label = document.createElement("span");
  label.textContent = message;
  requestState.replaceChildren(dot, label);
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
      row.append(name, address); root.append(row);
    }
  } catch (error) { root.textContent = `Configuration unavailable: ${error.message}`; }
}

window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const msg = event.data;
  if (!msg || msg.harbor !== 1 || typeof msg.id !== "string") return;
  let result;
  try {
    const response = await fetch("/api/bridge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) });
    result = await response.json();
  } catch (error) { result = { ok: false, status: 502, gatewayError: "bridge_error", data: { reason: String(error) } }; }
  if (msg.op === "gw") showRequest(`${msg.method} ${msg.path} · ${result.status}${result.gatewayError ? " · unavailable" : ""}`, !!result.gatewayError || !result.ok);
  frame.contentWindow.postMessage({ harbor: 1, id: msg.id, result }, "*");
});

document.getElementById("reload").addEventListener("click", () => { showRequest("Waiting for extension"); frame.src = frame.src; });
loadConnectors();

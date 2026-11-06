"use strict";

const frame = document.getElementById("extension");
const requestState = document.getElementById("request-state");
const responseDetail = document.getElementById("response-detail");
const identityToggle = document.getElementById("identity-toggle");
const identityForm = document.getElementById("identity-form");
const staffInput = document.getElementById("staff-id");
const STAFF_ID = /^[A-Za-z0-9._-]{1,64}$/;
let staffId = sessionStorage.getItem("harbor-preview-staff-id") || "local";
if (!STAFF_ID.test(staffId)) staffId = "local";

function updateIdentity() {
  document.getElementById("identity-label").textContent = staffId === "local" ? "Local Developer" : staffId;
  document.getElementById("identity-avatar").textContent = staffId === "local" ? "LD" : staffId.slice(0, 2).toUpperCase();
  staffInput.value = staffId === "local" ? "" : staffId;
}

function showIdentityForm(open) {
  identityForm.hidden = !open;
  identityToggle.setAttribute("aria-expanded", String(open));
  if (open) staffInput.focus();
}

function selectIdentity(next) {
  staffId = next;
  sessionStorage.setItem("harbor-preview-staff-id", staffId);
  updateIdentity();
  showIdentityForm(false);
  showRequest("Waiting for extension");
  frame.src = frame.src;
}

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
    const response = await fetch("/api/bridge", { method: "POST", headers: { "Content-Type": "application/json", "X-Harbor-Preview-Staff-Id": staffId }, body: JSON.stringify(message) });
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
    const { connectors, gateway } = await response.json();
    if (gateway) {
      document.getElementById("preview-mode").textContent = "DEV GATEWAY";
      identityToggle.disabled = true;
      identityToggle.title = "Dev gateway uses the identity of HARBOR_DEV_PAT";
      const me = await requestBridge({ op: "me" });
      const label = me.ok ? me.data.display_name || me.data.user : "Dev PAT required";
      document.getElementById("identity-label").textContent = label;
      document.getElementById("identity-avatar").textContent = me.ok ? me.data.user.slice(0, 2).toUpperCase() : "DEV";
    }
    root.replaceChildren();
    for (const connector of connectors) {
      const row = document.createElement("div"); row.className = "connector-row";
      const name = document.createElement("div"); name.className = "connector-name";
      const dot = document.createElement("span"); dot.className = "request-dot idle";
      const label = document.createElement("span"); label.textContent = connector.id;
      const mode = document.createElement("span"); mode.className = "connector-mode"; mode.textContent = connector.via === "gateway" ? "DEV GATEWAY" : "DIRECT";
      name.append(dot, label, mode);
      const address = document.createElement("span"); address.className = "connector-address"; address.textContent = connector.upstream;
      row.append(name, address);
      for (const path of connector.probes) {
        const button = document.createElement("button");
        button.className = "probe-button"; button.type = "button";
        button.textContent = `↗  Test GET ${path}`;
        button.addEventListener("click", () => probe(button, connector.id, path));
        row.append(button);
      }
      if (connector.via === "gateway") {
        const form = document.createElement("form"); form.className = "gateway-probe";
        const input = document.createElement("input"); input.type = "text"; input.placeholder = "/path/to/read"; input.setAttribute("aria-label", `GET path for ${connector.id}`); input.required = true;
        const button = document.createElement("button"); button.type = "submit"; button.textContent = "GET";
        form.addEventListener("submit", (event) => { event.preventDefault(); probe(button, connector.id, input.value.trim()); });
        form.append(input, button); row.append(form);
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
identityToggle.addEventListener("click", () => showIdentityForm(identityForm.hidden));
identityForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const next = staffInput.value.trim();
  if (!STAFF_ID.test(next)) { staffInput.setCustomValidity("Use 1–64 letters, numbers, dots, underscores or hyphens"); staffInput.reportValidity(); return; }
  staffInput.setCustomValidity("");
  selectIdentity(next);
});
staffInput.addEventListener("input", () => staffInput.setCustomValidity(""));
document.getElementById("identity-reset").addEventListener("click", () => selectIdentity("local"));
document.addEventListener("click", (event) => { if (!event.target.closest(".identity-control")) showIdentityForm(false); });
const debugPanel = document.getElementById("debug-panel");
const debugToggle = document.getElementById("debug-toggle");
function setDebugOpen(open) {
  debugPanel.hidden = !open;
  debugToggle.setAttribute("aria-expanded", String(open));
}
debugToggle.addEventListener("click", () => setDebugOpen(debugPanel.hidden));
document.getElementById("debug-close").addEventListener("click", () => setDebugOpen(false));
window.addEventListener("keydown", (event) => { if (event.key === "Escape") { setDebugOpen(false); showIdentityForm(false); } });
updateIdentity();
loadConnectors();

"use strict";

// Keep all content in DOM nodes so connector responses are never interpreted as HTML.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function add(parent, ...children) {
  parent.append(...children);
  return parent;
}

function showStatus(label, detail, kind) {
  document.getElementById("service-state").textContent = label;
  document.getElementById("service-detail").textContent = detail;
  document.getElementById("service-indicator").className = `status-dot ${kind}`;
}

async function checkService() {
  const button = document.getElementById("check-service");
  button.disabled = true;
  showStatus("Checking…", "Calling GET /health through Harbor", "pending");
  try {
    const response = await harbor.connector("my-extension-api").get("/health");
    const data = response.data || {};
    if (!response.ok) {
      showStatus("Service responded with an error", data.message || `HTTP ${response.status}`, "bad");
    } else {
      showStatus(data.status === "healthy" ? "Service is healthy" : "Service responded", data.message || `HTTP ${response.status} from your local backend`, "good");
    }
  } catch (error) {
    showStatus("Service unavailable", error.reason || error.message, "bad");
  } finally {
    button.disabled = false;
  }
}

async function main() {
  const root = document.getElementById("app");
  const me = await harbor.me();
  const initials = (me.display_name || "Local Developer").split(/\s+/).map((word) => word[0]).slice(0, 2).join("").toUpperCase();

  const eyebrow = element("div", "eyebrow", "HARBOR / EXTENSION STARTER");
  const title = element("h1", "hero-title", "A clear view of your service.");
  const intro = element("p", "hero-copy", "A small, working example of a Harbor extension. Your page lives here; connector calls travel through the Harbor SDK.");
  const hero = add(element("section", "hero"),
    add(element("div", "hero-content"), eyebrow, title, intro,
      add(element("div", "hero-meta"), element("span", "hero-meta-mark", "✦"), element("span", null, "Built for My Extension"))),
    add(element("div", "hero-art"),
      add(element("div", "art-orbit orbit-one"), element("div", "art-orbit orbit-two")),
      add(element("div", "art-center"), element("span", null, "H")),
      element("div", "art-label", "YOUR SPACE TO BUILD")));

  const avatar = element("div", "avatar", initials);
  const identity = add(element("section", "identity-card"),
    add(element("div", "identity-left"), avatar, add(element("div", null), element("div", "micro-label", "PREVIEW IDENTITY"), element("div", "identity-name", me.display_name || "Local Developer"))),
    element("span", "local-pill", "LOCAL SESSION"));

  const serviceHeader = add(element("div", "card-header"),
    add(element("div", null), element("div", "micro-label", "01 / LIVE CONNECTION"), element("h2", null, "Your connector")),
    element("span", "connector-tag", "my-extension-api"));
  const indicator = element("span", "status-dot pending"); indicator.id = "service-indicator";
  const state = element("strong", "service-state", "Waiting to check"); state.id = "service-state";
  const detail = element("p", "service-detail", "The request has not started yet."); detail.id = "service-detail";
  const button = element("button", "check-button", "↻  Check connection"); button.id = "check-service"; button.type = "button"; button.addEventListener("click", checkService);
  const service = add(element("section", "panel service-panel"), serviceHeader,
    add(element("div", "service-result"), indicator, add(element("div", null), state, detail)),
    add(element("div", "panel-footer"), element("code", null, "GET /health"), button));

  const steps = [
    ["01", "Build the interface", "Edit web/ to shape this page for your team."],
    ["02", "Connect your service", "Declare routes in connectors/ and point env/local.yaml at your backend."],
    ["03", "Ship through Git", "Push dev to test, then promote your chosen code to prod."],
  ];
  const list = element("div", "steps");
  for (const [number, heading, body] of steps) add(list, add(element("div", "step"), element("span", "step-number", number), add(element("div", null), element("h3", null, heading), element("p", null, body))));
  const guide = add(element("section", "panel guide-panel"),
    add(element("div", "card-header"), add(element("div", null), element("div", "micro-label", "02 / GET STARTED"), element("h2", null, "Make it yours"))), list);

  root.replaceChildren(hero, identity, add(element("div", "content-grid"), service, guide),
    add(element("footer", "demo-footer"), element("span", null, "HARBOR EXTENSIONS"), element("span", null, "A focused starting point for your own idea.")));
  await checkService();
}

main().catch((error) => {
  document.getElementById("app").replaceChildren(add(element("div", "error-card"), element("strong", null, "Unable to open this extension"), element("p", null, error.reason || error.message)));
});

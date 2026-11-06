"use strict";

// Example content only. Replace this sample list with your own connector-backed data.
const requests = [
  { id: "REQ-1042", title: "Review access for the analytics workspace", team: "Data platform", stage: "Open", date: "Today" },
  { id: "REQ-1038", title: "Update the service ownership record", team: "Core services", stage: "Open", date: "Yesterday" },
  { id: "REQ-1029", title: "Confirm the quarterly control evidence", team: "Operations", stage: "Reviewed", date: "2 days ago" },
];

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text != null) item.textContent = text;
  return item;
}

const list = document.getElementById("request-list");
const count = document.getElementById("request-count");
const tabs = [...document.querySelectorAll("[data-filter]")];

function render(filter) {
  const visible = requests.filter((request) => filter === "All" || request.stage === filter);
  count.textContent = `${visible.length} ${visible.length === 1 ? "item" : "items"}`;
  list.replaceChildren();
  for (const request of visible) {
    const row = node("article", "request-row");
    const monogram = node("span", "request-mark", request.team.slice(0, 1));
    const body = node("div", "request-body");
    body.append(node("div", "request-id", request.id), node("h3", null, request.title), node("p", null, `${request.team} · ${request.date}`));
    row.append(monogram, body, node("span", `stage ${request.stage.toLowerCase()}`, request.stage));
    list.append(row);
  }
  for (const tab of tabs) {
    const active = tab.dataset.filter === filter;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
}

for (const tab of tabs) tab.addEventListener("click", () => render(tab.dataset.filter));
render("All");

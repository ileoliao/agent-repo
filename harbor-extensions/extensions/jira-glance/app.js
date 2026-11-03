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

function issueCard(issue) {
  const fields = issue.fields || {};
  const status = (fields.status && (fields.status.name || fields.status)) || "Unknown";
  return h(
    "article",
    { class: "hx-card hx-card-body issue-card" },
    h(
      "div",
      { class: "hx-row" },
      h("strong", null, issue.key || "?"),
      h("span", { class: "hx-badge hx-badge-info" }, String(status)),
    ),
    h("p", { class: "issue-summary" }, fields.summary || "(no summary)"),
    fields.assignee
      ? h("p", { class: "hx-small hx-muted" }, `Assignee: ${fields.assignee}`)
      : null,
  );
}

async function main() {
  const app = document.getElementById("app");
  try {
    const me = await harbor.me();
    const jira = harbor.connector("jira");
    const res = await jira.get("/rest/api/2/search?jql=project = PAY");
    if (!res.ok) {
      const detail = res.data && res.data.detail;
      const msg =
        (detail && detail.error && detail.error.message) ||
        `Jira search returned ${res.status}`;
      throw new Error(msg);
    }
    const issues = (res.data && res.data.issues) || [];
    app.replaceChildren(
      h(
        "div",
        { class: "hx-card hx-card-body" },
        `Signed in as ${me.display_name || me.username || "user"} · ${issues.length} PAY issue(s)`,
      ),
      issues.length
        ? h("div", { class: "hx-stack issue-list" }, ...issues.map(issueCard))
        : h("div", { class: "hx-muted" }, "No issues matched this JQL."),
    );
  } catch (e) {
    const text =
      e && e.name === "HarborError"
        ? e.reason || e.message
        : (e && (e.reason || e.message)) || String(e);
    app.replaceChildren(h("div", { class: "hx-banner hx-banner-bad" }, text));
  }
}

main();

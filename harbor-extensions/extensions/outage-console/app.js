// Outage Console: reference implementation of a team-built service + the platform gateway.
// State and business rules live in the outage service; the extension only renders the UI and calls the service API as-is through the connector.
"use strict";

const outage = harbor.connector("outage");
const snow = harbor.connector("snow");

const STATUS = {
  investigating: ["Investigating", "hx-badge-warn"],
  identified: ["Identified", "hx-badge-info"],
  monitoring: ["Monitoring", "hx-badge-info"],
  resolved: ["Resolved", "hx-badge-good"],
};

let me = null;
let canManage = false;
let selectedId = null;
let declaring = false;

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

function badge([label, cls]) {
  return h("span", { class: `hx-badge ${cls}` }, label);
}

function sevBadge(sev) {
  return h("span", { class: `hx-badge sev-${sev}` }, sev);
}

function parseLocal(text) {
  // "YYYY-MM-DD HH:MM" (the service returns local time)
  const [d, t] = text.split(" ");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return new Date(y, m - 1, day, hh, mm);
}

function duration(from, to) {
  const minutes = Math.max(0, Math.round(((to ? parseLocal(to) : new Date()) - parseLocal(from)) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function localToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Team-service errors (business rules) are shown as-is; gateway denials (HarborError) show the reason
function errorText(e, res) {
  if (e) return e.reason || e.message;
  const detail = res && res.data && res.data.detail;
  return (detail && detail.error && detail.error.message) || `Service returned ${res.status}`;
}

function messages(list) {
  document.getElementById("messages").replaceChildren(
    ...list.map(([kind, text]) => h("div", { class: `hx-banner hx-banner-${kind}`, role: "status" }, text)),
  );
}

// ------------------------------------------------------------------ List

function card(o) {
  return h(
    "button",
    {
      class: `outage${o.id === selectedId ? " is-selected" : ""}`,
      "data-outage-id": o.id,
      onclick: () => select(o.id),
    },
    h("div", { class: "hx-row" }, sevBadge(o.severity), badge(STATUS[o.status] || [o.status, ""]), h("span", { class: "hx-small hx-muted" }, o.id)),
    h("div", { class: "outage-title" }, o.title),
    h(
      "div",
      { class: "outage-meta" },
      o.status === "resolved" ? `Lasted ${duration(o.started_at, o.resolved_at)}` : `Ongoing for ${duration(o.started_at)}`,
      ` · Commander ${o.commander_name}`,
    ),
    h("div", { class: "outage-last" }, o.last_update.message),
  );
}

async function loadList() {
  const [active, resolved] = await Promise.all([
    outage.get("/api/outages", { query: { status: "active" } }),
    outage.get("/api/outages", { query: { status: "resolved" } }),
  ]);
  if (!active.ok || !resolved.ok) throw new Error(errorText(null, active.ok ? resolved : active));
  const act = active.data.items;
  const res = resolved.data.items.slice(0, 10);
  if (!selectedId && (act[0] || res[0])) selectedId = (act[0] || res[0]).id;
  document.getElementById("active").replaceChildren(...(act.length ? act.map(card) : [h("div", { class: "empty" }, "No ongoing outages")]));
  document.getElementById("resolved").replaceChildren(...(res.length ? res.map(card) : [h("div", { class: "empty" }, "None")]));
}

// ------------------------------------------------------------------ Details

function timeline(updates) {
  return h(
    "ol",
    { class: "timeline", "aria-label": "Handling timeline" },
    [...updates].reverse().map((u) =>
      h(
        "li",
        { class: "tl-item" },
        h("div", { class: "tl-time" }, u.at.slice(5)),
        h("div", { class: "tl-rail" }, h("span", { class: `tl-dot st-${u.status}` })),
        h("div", {}, h("div", { class: "tl-who" }, `${u.by_name} · ${(STATUS[u.status] || [u.status])[0]}`), h("div", {}, u.message)),
      ),
    ),
  );
}

function updateForm(o) {
  const text = h("textarea", { "aria-label": "Update", placeholder: "What happened, and what happens next", maxlength: "500" });
  const status = h(
    "select",
    { class: "hx-input", "aria-label": "Status" },
    Object.entries(STATUS).map(([value, [label]]) => h("option", { value, selected: value === o.status }, label)),
  );
  const error = h("div", { class: "form-error", role: "alert" });
  const submit = h("button", { class: "hx-btn hx-btn-primary", type: "submit" }, "Post update");
  return h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!text.value.trim()) return (error.textContent = "Please enter an update");
        submit.disabled = true;
        try {
          const res = await outage.post(`/api/outages/${encodeURIComponent(o.id)}/updates`, { message: text.value, status: status.value });
          if (!res.ok) {
            error.textContent = errorText(null, res);
            submit.disabled = false;
            return;
          }
          await refresh();
        } catch (err) {
          error.textContent = errorText(err);
          submit.disabled = false;
        }
      },
    },
    h("h3", {}, "Post update"),
    text,
    h("div", { class: "hx-row" }, status, submit, h("span", { class: "subtle" }, `Only commander ${o.commander_name} can declare recovery`)),
    error,
  );
}

async function relatedChanges(o) {
  const today = localToday();
  const box = h("div", { class: "changes" }, h("div", { class: "subtle" }, "Loading..."));
  Promise.all(
    o.systems.map((sys) =>
      snow.get("/api/now/table/change_request", {
        query: { sysparm_query: `cmdb_ci=${sys}^start_date>=${today} 00:00:00^start_date<=${today} 23:59:59` },
      }),
    ),
  )
    .then((results) => {
      const rows = results.flatMap((r) => (r.ok ? r.data.result : []));
      box.replaceChildren(
        ...(rows.length
          ? rows.map((c) => h("div", { class: "change", "data-change": c.number }, `${c.number} · ${c.short_description} · ${c.start_date.slice(11, 16)} · ${c.state}`))
          : [h("div", { class: "subtle" }, "No change requests today for the affected systems")]),
      );
    })
    .catch((e) => box.replaceChildren(h("div", { class: "subtle" }, e.code === "missing_group" ? `Cannot view change requests: ${e.reason}` : errorText(e))));
  return box;
}

async function renderDetail() {
  const panel = document.getElementById("detail");
  if (!selectedId) return panel.replaceChildren(h("div", { class: "empty" }, "Select an outage to view details"));
  const res = await outage.get(`/api/outages/${encodeURIComponent(selectedId)}`);
  if (!res.ok) return panel.replaceChildren(h("div", { class: "hx-banner hx-banner-bad" }, errorText(null, res)));
  const o = res.data;
  const parts = [
    h(
      "div",
      { class: "detail-head" },
      h("div", { class: "hx-row" }, sevBadge(o.severity), badge(STATUS[o.status] || [o.status, ""]), h("span", { class: "hx-small hx-muted" }, o.id)),
      h("h2", { "data-detail-title": o.id }, o.title),
    ),
    h(
      "div",
      { class: "facts" },
      fact("Commander", o.commander_name + (me && o.commander === me.user ? " (me)" : "")),
      fact("Started", o.started_at.slice(5)),
      fact(o.resolved_at ? "Lasted" : "Ongoing for", duration(o.started_at, o.resolved_at)),
      fact("Affected systems", o.systems.join(", ")),
    ),
    canManage && o.status !== "resolved" ? updateForm(o) : null,
    h("div", {}, h("h3", { style: "margin-bottom:10px" }, "Timeline"), timeline(o.updates)),
    h("div", {}, h("h3", { style: "margin-bottom:8px" }, "Today's changes on affected systems"), await relatedChanges(o)),
  ];
  panel.replaceChildren(...parts.filter(Boolean)); // replaceChildren renders null as text
}

function fact(label, value) {
  return h("div", { class: "fact" }, h("div", { class: "fact-label" }, label), h("div", { class: "fact-value" }, value));
}

// ------------------------------------------------------------------ Declare outage

function renderDeclare() {
  const box = document.getElementById("declare");
  box.hidden = !declaring;
  if (!declaring) return box.replaceChildren();
  const title = h("input", { class: "hx-input", placeholder: "Symptom, e.g. mobile banking login failing", maxlength: "80", "aria-label": "Title" });
  const sev = h("select", { class: "hx-input", "aria-label": "Severity" }, ["P1", "P2", "P3"].map((s) => h("option", { value: s, selected: s === "P2" }, s)));
  const systems = h("input", { class: "hx-input", placeholder: "Affected systems, comma-separated", "aria-label": "Affected systems" });
  const summary = h("textarea", { placeholder: "What is known so far (optional)", "aria-label": "Known details" });
  const error = h("div", { class: "form-error", role: "alert" });
  box.replaceChildren(
    h(
      "form",
      {
        class: "form",
        onsubmit: async (e) => {
          e.preventDefault();
          const list = systems.value.split(/[,，\s]+/).filter(Boolean);
          try {
            const res = await outage.post("/api/outages", { title: title.value, severity: sev.value, systems: list, summary: summary.value });
            if (!res.ok) return (error.textContent = errorText(null, res));
            declaring = false;
            selectedId = res.data.id;
            await refresh();
          } catch (err) {
            error.textContent = errorText(err);
          }
        },
      },
      h("h3", {}, "Declare outage"),
      h("div", { class: "grid" }, title, sev, systems),
      summary,
      h(
        "div",
        { class: "hx-row" },
        h("button", { class: "hx-btn hx-btn-primary", type: "submit" }, "Declare"),
        h("button", { class: "hx-btn hx-btn-ghost", type: "button", onclick: () => { declaring = false; renderDeclare(); } }, "Cancel"),
        h("span", { class: "subtle" }, "You will become the commander once declared"),
      ),
      error,
    ),
  );
  title.focus();
}

function renderActions() {
  document.getElementById("actions").replaceChildren(
    ...(canManage
      ? [h("button", { class: "hx-btn hx-btn-primary", onclick: () => { declaring = true; renderDeclare(); } }, "Declare outage")]
      : [h("span", { class: "hx-badge" }, "Read-only: posting updates requires joining APP-INCIDENT-RESPONDER")]),
  );
}

// ------------------------------------------------------------------ Startup

async function select(id) {
  if (id === selectedId) return; // do not redraw the current details, to avoid wiping an update being typed
  selectedId = id;
  await refresh();
}

async function refresh() {
  try {
    await loadList();
    await renderDetail();
    messages([]);
  } catch (e) {
    messages([["bad", `Failed to load: ${errorText(e)}`]]);
  }
}

async function main() {
  [me, canManage] = await Promise.all([harbor.me(), harbor.can("outage", "manage")]);
  renderActions();
  await refresh();
}

main().catch((e) => messages([["bad", errorText(e)]]));

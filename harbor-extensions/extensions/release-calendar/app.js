// My Release Calendar: combines the Harbor Release and ServiceNow connectors.
// Gateway passthrough: the path and query string are each system's native API; the SDK does no translation.
"use strict";

const releases = harbor.connector("harbor-release");
const snow = harbor.connector("snow");

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const RELEASE_STATUS = {
  draft: ["Draft", ""],
  "pending-approval": ["Awaiting approval", "hx-badge-warn"],
  scheduled: ["Scheduled", "hx-badge-good"],
};
const CHANGE_STATE = {
  assess: ["Assessing", ""],
  authorize: ["Awaiting approval", "hx-badge-warn"],
  scheduled: ["Scheduled", "hx-badge-good"],
  implement: ["Implementing", "hx-badge-info"],
};

let weekOffset = 0;
let me = null;
let canApprove = false;

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

function localDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function weekDays(offset) {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
}

function toMinutes(text) {
  // "2026-10-27 20:00" / "2026-10-27 20:00:00" -> minutes of that day
  const [hh, mm] = text.slice(11, 16).split(":").map(Number);
  return hh * 60 + mm;
}

function overlaps(a, b) {
  return a.day === b.day && a.start < b.end && b.start < a.end;
}

function badge([label, cls]) {
  return h("span", { class: `hx-badge ${cls}` }, label);
}

function messages(list) {
  document.getElementById("messages").replaceChildren(
    ...list.map(([kind, text]) => h("div", { class: `hx-banner hx-banner-${kind}`, role: "status" }, text)),
  );
}

function explain(source, error) {
  if (error && error.code === "missing_group") {
    return `${source} not visible: ${error.reason}. Request access in the AD self-service portal, then refresh.`;
  }
  return `${source} failed to load: ${(error && (error.reason || error.message)) || "unknown error"}`;
}

async function approve(change, button) {
  button.disabled = true;
  try {
    const res = await snow.patch(`/api/now/table/change_request/${encodeURIComponent(change.sys_id)}`, { state: "scheduled" });
    if (!res.ok) throw new Error(`ServiceNow returned ${res.status}`);
    await load();
  } catch (e) {
    button.disabled = false;
    messages([["bad", `Failed to approve ${change.number}: ${e.reason || e.message}`]]);
  }
}

function releaseItem(r) {
  return h(
    "div",
    { class: `item${r.conflict ? " is-conflict" : ""}`, "data-id": r.id },
    h("div", { class: "kind kind-release" }, "Release"),
    h(
      "div",
      {},
      h("div", { class: "item-title" }, r.title),
      h("div", { class: "item-meta" }, h("code", {}, r.system), ` · ${r.version} · ${r.window_start.slice(11, 16)}–${r.window_end.slice(11, 16)} · ${r.id}`),
    ),
    h(
      "div",
      { class: "item-side" },
      r.conflict && h("span", { class: "hx-badge hx-badge-bad" }, "Window conflict"),
      me && r.approvers.includes(me.user) && h("span", { class: "hx-badge hx-badge-accent" }, "I'm an approver"),
      badge(RELEASE_STATUS[r.status] || [r.status, ""]),
    ),
  );
}

function changeItem(c) {
  const side = [
    c.conflict && h("span", { class: "hx-badge hx-badge-bad" }, "Window conflict"),
    badge(CHANGE_STATE[c.state] || [c.state, ""]),
  ];
  if (c.state === "authorize" && canApprove) {
    const btn = h("button", { class: "hx-btn hx-btn-primary hx-btn-sm", onclick: () => approve(c, btn) }, "Approve");
    side.push(btn);
  }
  if (c.approved_by && c.state === "scheduled") {
    side.unshift(h("span", { class: "hx-small hx-muted" }, `Approved by ${c.approved_by}`));
  }
  return h(
    "div",
    { class: `item${c.conflict ? " is-conflict" : ""}`, "data-id": c.number },
    h("div", { class: "kind kind-change" }, "Change"),
    h(
      "div",
      {},
      h("div", { class: "item-title" }, c.short_description),
      h("div", { class: "item-meta" }, h("code", {}, c.cmdb_ci), ` · ${c.start_date.slice(11, 16)}–${c.end_date.slice(11, 16)} · ${c.number}`),
    ),
    h("div", { class: "item-side" }, side),
  );
}

async function load() {
  const days = weekDays(weekOffset);
  const from = localDate(days[0]);
  const to = localDate(days[6]);
  document.getElementById("week-label").textContent = `${from.slice(5).replace("-", "/")} – ${to.slice(5).replace("-", "/")}`;

  const [meRes, relRes, chgRes, canRes] = await Promise.allSettled([
    me ? Promise.resolve(me) : harbor.me(),
    releases.get("/api/releases", { query: { from, to } }),
    snow.get("/api/now/table/change_request", {
      query: { sysparm_query: `start_date>=${from} 00:00:00^start_date<=${to} 23:59:59`, sysparm_limit: 200 },
    }),
    harbor.can("snow", "change.write"),
  ]);
  if (meRes.status === "fulfilled") me = meRes.value;
  canApprove = canRes.status === "fulfilled" && canRes.value;

  const notes = [];
  let rels = [];
  let chgs = [];
  if (relRes.status === "fulfilled" && relRes.value.ok) rels = relRes.value.data.items;
  else notes.push(["warn", explain("Release plans", relRes.reason || { message: `Harbor Release returned ${relRes.value.status}` })]);
  if (chgRes.status === "fulfilled" && chgRes.value.ok) chgs = chgRes.value.data.result;
  else notes.push(["warn", explain("Change requests", chgRes.reason || { message: `ServiceNow returned ${chgRes.value.status}` })]);
  messages(notes);

  // Conflict: same system, same day, overlapping time ranges
  const relSlots = rels.map((r) => ({ r, day: r.window_start.slice(0, 10), start: toMinutes(r.window_start), end: toMinutes(r.window_end), sys: r.system }));
  const chgSlots = chgs.map((c) => ({ c, day: c.start_date.slice(0, 10), start: toMinutes(c.start_date), end: toMinutes(c.end_date), sys: c.cmdb_ci }));
  for (const rs of relSlots) {
    for (const cs of chgSlots) {
      if (rs.sys === cs.sys && overlaps(rs, cs)) {
        rs.r.conflict = true;
        cs.c.conflict = true;
      }
    }
  }

  const conflicts = rels.filter((r) => r.conflict).length + chgs.filter((c) => c.conflict).length;
  const mine = me ? rels.filter((r) => r.approvers.includes(me.user)).length : 0;
  const stats = [
    h("span", { class: "hx-badge hx-badge-accent" }, `Releases ${rels.length}`),
    h("span", { class: "hx-badge hx-badge-info" }, `Changes ${chgs.length}`),
    conflicts ? h("span", { class: "hx-badge hx-badge-bad" }, `Conflicts ${conflicts}`) : h("span", { class: "hx-badge hx-badge-good" }, "No conflicts"),
    mine && h("span", { class: "hx-badge" }, `Releases awaiting my approval ${mine}`),
    canApprove && h("span", { class: "hx-badge" }, "You can approve change requests"),
  ];
  document.getElementById("stats").replaceChildren(...stats.filter(Boolean));

  const todayIso = localDate(new Date());
  document.getElementById("days").replaceChildren(
    ...days.map((d, i) => {
      const iso = localDate(d);
      const items = [
        ...rels.filter((r) => r.window_start.startsWith(iso)).map((r) => [r.window_start.slice(11, 16), releaseItem(r)]),
        ...chgs.filter((c) => c.start_date.startsWith(iso)).map((c) => [c.start_date.slice(11, 16), changeItem(c)]),
      ].sort((a, b) => a[0].localeCompare(b[0]));
      return h(
        "section",
        { class: `hx-card day${iso === todayIso ? " is-today" : ""}`, "data-date": iso },
        h("div", { class: "day-date" }, h("div", { class: "dow" }, iso === todayIso ? `${DOW[i]} · Today` : DOW[i]), h("div", { class: "md" }, `${d.getMonth() + 1}/${d.getDate()}`)),
        items.length ? h("div", { class: "items" }, items.map(([, el]) => el)) : h("div", { class: "day-empty" }, "No releases or changes"),
      );
    }),
  );
}

document.getElementById("prev").addEventListener("click", () => { weekOffset -= 1; load(); });
document.getElementById("next").addEventListener("click", () => { weekOffset += 1; load(); });
document.getElementById("this-week").addEventListener("click", () => { weekOffset = 0; load(); });
load();

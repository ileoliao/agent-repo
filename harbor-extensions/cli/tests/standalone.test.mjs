import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import YAML from "yaml";
import { allowedCapability, bundleStandalone, inspectStandalone, validateStandalone } from "../standalone.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-node-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "team-demo");
  fs.cpSync(path.join(ROOT, "templates", "extension"), repo, { recursive: true });
  for (const file of ["extension.yaml", "web/index.html"]) {
    const p = path.join(repo, file);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll("my-extension", "team-demo").replaceAll("My Extension", "Team Demo").replaceAll("team-xxx", "team-demo").replaceAll("you@example.com", "team@corp.test").replaceAll("One sentence on what problem it solves", "A real team extension"));
  }
  for (const file of ["web/app.js", "env/local.yaml", "env/dev.yaml", "env/prod.yaml"]) {
    const p = path.join(repo, file);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll("my-extension-api", "team-demo-api"));
  }
  const connector = path.join(repo, "connectors", "my-extension-api.yaml");
  fs.renameSync(connector, path.join(repo, "connectors", "team-demo-api.yaml"));
  const renamed = path.join(repo, "connectors", "team-demo-api.yaml");
  fs.writeFileSync(renamed, fs.readFileSync(renamed, "utf8").replaceAll("my-extension-api", "team-demo-api"));
  const manifest = path.join(repo, "extension.yaml");
  fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replaceAll("my-extension-api", "team-demo-api"));
  return { temp, repo };
}

test("local connector policy and environment bundles stay separate", (t) => {
  const { temp, repo } = fixture(t);
  validateStandalone(repo);
  const local = inspectStandalone(repo);
  assert.equal(local.connectors.get("team-demo-api").upstream, "http://127.0.0.1:3000");
  assert.equal(allowedCapability(local, "team-demo-api", "GET", "/health").id, "team-demo-api.health.read");
  assert.equal(allowedCapability(local, "team-demo-api", "DELETE", "/health"), null);
  for (const env of ["dev", "prod"]) {
    const output = path.join(temp, env);
    bundleStandalone(repo, env, output);
    const connector = YAML.parse(fs.readFileSync(path.join(output, "connectors", "team-demo-api.yaml"), "utf8"));
    assert.equal(connector.upstream, `https://team-demo-api.${env}.internal`);
    assert.ok(fs.existsSync(path.join(output, "extensions", "team-demo", "index.html")));
    assert.equal(fs.existsSync(path.join(output, "extensions", "team-demo", "env")), false);
  }
});

test("local addresses must stay on loopback", (t) => {
  const { repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "env", "local.yaml"), "upstreams:\n  team-demo-api: https://team-demo-api.prod.internal\n");
  assert.throws(() => validateStandalone(repo), /must point to localhost/);
});

test("manifest YAML and navigation rules match platform validation", (t) => {
  const { repo } = fixture(t);
  const file = path.join(repo, "extension.yaml");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original + "\nname: duplicate\n");
  assert.throws(() => validateStandalone(repo), /duplicate key|Map keys must be unique/i);
  fs.writeFileSync(file, original + "\nnav:\n  featured: true\n");
  assert.throws(() => validateStandalone(repo), /nav promotion requires official tier/);
});

test("extension ID comes from the manifest when checkout directory differs", (t) => {
  const { temp, repo } = fixture(t);
  const checkout = path.join(temp, "dev-checkout");
  fs.renameSync(repo, checkout);
  validateStandalone(checkout);
  bundleStandalone(checkout, "dev", path.join(temp, "bundle"));
  assert.ok(fs.existsSync(path.join(temp, "bundle", "extensions", "team-demo", "index.html")));
  const cli = path.join(ROOT, "cli", "harbor.mjs");
  const checked = spawnSync(process.execPath, [cli, "extension", "validate"], { cwd: checkout, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("bundles publish web only, reject key files, and stay outside the repo", (t) => {
  const { temp, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "credentials.json"), '{"token":"secret"}');
  bundleStandalone(repo, "dev", path.join(temp, "safe"));
  assert.equal(fs.existsSync(path.join(temp, "safe/extensions/team-demo/credentials.json")), false);
  fs.writeFileSync(path.join(repo, "web", "credentials.key"), "secret");
  assert.throws(() => bundleStandalone(repo, "dev", path.join(temp, "bundle")), /key file cannot be published/);
  fs.rmSync(path.join(repo, "web", "credentials.key"));
  assert.throws(() => bundleStandalone(repo, "dev", path.join(repo, "bundle")), /outside the extension repo/);
});

test("extension scaffold validates from its own repository and has no upload command", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-scaffold-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cli = path.join(ROOT, "cli", "harbor.mjs");
  const created = spawnSync(process.execPath, [cli, "extension", "new", "team-sample", "--owner", "team-sample", "--contact", "sample@corp.test", "--description", "Sample extension"], { cwd: temp, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const repo = path.join(temp, "team-sample");
  assert.ok(fs.existsSync(path.join(repo, "connectors", "team-sample-api.yaml")));
  const checked = spawnSync(process.execPath, [cli, "extension", "validate"], { cwd: repo, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const published = spawnSync(process.execPath, [cli, "extension", "publish", ".", "--dry-run"], { cwd: repo, encoding: "utf8" });
  assert.equal(published.status, 2);
  assert.match(published.stderr, /Unknown: harbor extension publish/);
});

test("scaffold refuses to create an extension inside the platform checkout", () => {
  const cli = path.join(ROOT, "cli", "harbor.mjs");
  const created = spawnSync(process.execPath, [cli, "extension", "new", "inside-platform"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(created.status, 2);
  assert.match(created.stderr, /outside the platform checkout/);
  assert.equal(fs.existsSync(path.join(ROOT, "inside-platform")), false);
});

test("Jenkins push bundle accepts detached checkout only for matching branch and commit", (t) => {
  const { temp, repo } = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "dev");
  git("add", ".");
  git("-c", "user.name=Harbor", "-c", "user.email=harbor@local.test", "commit", "-m", "initial");
  const sha = git("rev-parse", "HEAD");
  git("checkout", "--detach");
  const script = path.join(ROOT, "scripts", "gitops-bundle.mjs");
  const env = { ...process.env, HARBOR_CI: "jenkins", HARBOR_SOURCE_EVENT: "push", HARBOR_SOURCE_REF: "refs/heads/dev", HARBOR_SOURCE_SHA: sha };
  const good = spawnSync(process.execPath, [script, repo, "dev", path.join(temp, "good")], { encoding: "utf8", env });
  assert.equal(good.status, 0, good.stderr);
  const wrong = spawnSync(process.execPath, [script, repo, "prod", path.join(temp, "wrong")], { encoding: "utf8", env });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /must match prod/);
});

test("release composition replaces only the owning extension and writes its marker", (t) => {
  const { temp, repo } = fixture(t);
  const bundle = path.join(temp, "bundle");
  bundleStandalone(repo, "dev", bundle);
  const base = path.join(temp, "base");
  fs.mkdirSync(path.join(base, "extensions", "other"), { recursive: true });
  fs.mkdirSync(path.join(base, "connectors"), { recursive: true });
  fs.mkdirSync(path.join(base, "config"), { recursive: true });
  fs.writeFileSync(path.join(base, "extensions", "other", "index.html"), "other");
  fs.writeFileSync(path.join(base, "connectors", "team-demo-api.yaml"), "old connector");
  fs.writeFileSync(path.join(base, "config", "grants.yaml"), "{}\n");
  const policy = path.join(temp, "policy");
  fs.mkdirSync(policy);
  fs.writeFileSync(path.join(policy, "grants.yaml"), "team-demo: []\n");
  fs.writeFileSync(path.join(policy, "nav.yaml"), "sections: {}\n");
  const out = path.join(temp, "release");
  const sha = "a".repeat(40);
  const composed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "compose-release.mjs"), base, bundle, out, sha, policy], { encoding: "utf8" });
  assert.equal(composed.status, 0, composed.stderr);
  assert.equal(fs.readFileSync(path.join(out, "extensions", "other", "index.html"), "utf8"), "other");
  assert.match(fs.readFileSync(path.join(out, "connectors", "team-demo-api.yaml"), "utf8"), /team-demo-api.dev.internal/);
  assert.equal(fs.readFileSync(path.join(out, "config", "grants.yaml"), "utf8"), "team-demo: []\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "config", "release.json"), "utf8")).id, sha);
  const policyOut = path.join(temp, "policy-release");
  const policyComposed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "compose-release.mjs"), out, "-", policyOut, "b".repeat(40), policy], { encoding: "utf8" });
  assert.equal(policyComposed.status, 0, policyComposed.stderr);
  assert.ok(fs.existsSync(path.join(policyOut, "extensions", "team-demo", "index.html")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(policyOut, "config", "release.json"), "utf8")).extension, "platform-policy");
  const empty = path.join(temp, "empty");
  fs.mkdirSync(empty);
  const boot = path.join(temp, "bootstrap");
  const bootstrapped = spawnSync(process.execPath, [path.join(ROOT, "scripts", "compose-release.mjs"), empty, "-", boot, "c".repeat(40), path.join(ROOT, "deploy", "policy", "dev")], { encoding: "utf8" });
  assert.equal(bootstrapped.status, 0, bootstrapped.stderr);
  assert.ok(fs.existsSync(path.join(boot, "extensions", ".keep")));
  assert.ok(fs.existsSync(path.join(boot, "connectors", ".keep")));
  assert.equal(fs.readFileSync(path.join(boot, "config", "grants.yaml"), "utf8"), "{}\n");
});

test("Node preview serves web and forwards connector calls to a local backend", async (t) => {
  const { repo } = fixture(t);
  const backend = http.createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"message":"local backend reached"}'));
  try {
    await new Promise((resolve, reject) => backend.once("error", reject).listen(0, "127.0.0.1", resolve));
  } catch (error) {
    if (error.code === "EPERM") { t.skip("sandbox blocks loopback sockets"); return; }
    throw error;
  }
  t.after(() => backend.close());
  const backendPort = backend.address().port;
  fs.writeFileSync(path.join(repo, "env", "local.yaml"), `upstreams:\n  team-demo-api: http://127.0.0.1:${backendPort}\n`);
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(ROOT, "cli", "harbor.mjs"), "extension", "dev", "--port", String(port)], { cwd: repo, stdio: "ignore" });
  t.after(() => child.kill());
  const origin = `http://127.0.0.1:${port}`;
  let page;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { page = await fetch(`${origin}/ext/team-demo/index.html`); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.equal(page?.status, 200);
  assert.match(await page.text(), /Team Demo/);
  const preview = await fetch(`${origin}/api/preview-config`);
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).connectors, [{ id: "team-demo-api", upstream: `http://127.0.0.1:${backendPort}`, probes: ["/health"] }]);
  assert.equal((await fetch(`${origin}/preview/shell.js`)).status, 200);
  assert.equal((await fetch(`${origin}/ext/team-demo/env/prod.yaml`)).status, 404);
  const response = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ op: "gw", connector: "team-demo-api", method: "GET", path: "/health" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.message, "local backend reached");
});

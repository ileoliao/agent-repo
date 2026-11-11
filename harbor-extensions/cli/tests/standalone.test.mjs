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

test("local remote addresses require HTTPS; gateway mode is explicit", (t) => {
  const { repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "env", "local.yaml"), "upstreams:\n  team-demo-api: http://team-demo-api.dev.internal\n");
  assert.throws(() => validateStandalone(repo), /must use HTTPS/);
  fs.writeFileSync(path.join(repo, "env", "local.yaml"), "upstreams:\n  team-demo-api: https://team-demo-api.dev.internal\n");
  assert.equal(inspectStandalone(repo).connectors.get("team-demo-api").upstream, "https://team-demo-api.dev.internal");
  fs.writeFileSync(path.join(repo, "env", "local.yaml"), "gateway: dev\n");
  assert.equal(inspectStandalone(repo).gateway, "dev");
  fs.writeFileSync(path.join(repo, "env", "local.yaml"), "gateway: https://untrusted.example/extensions\n");
  assert.throws(() => validateStandalone(repo), /gateway: dev/);
});

test("an extension may reuse a platform connector through the Dev gateway", (t) => {
  const { temp, repo } = fixture(t);
  fs.rmSync(path.join(repo, "connectors"), { recursive: true });
  const manifest = path.join(repo, "extension.yaml");
  fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace("team-demo-api.health.read", "snow.change.read"));
  fs.writeFileSync(path.join(repo, "env", "local.yaml"), "gateway: dev\n");
  for (const env of ["dev", "prod"]) fs.writeFileSync(path.join(repo, "env", `${env}.yaml`), "upstreams: {}\n");
  validateStandalone(repo);
  assert.equal(inspectStandalone(repo).connectors.size, 0);
  const output = path.join(temp, "bundle");
  bundleStandalone(repo, "dev", output);
  assert.equal(fs.existsSync(path.join(output, "connectors")), false);
  const base = path.join(temp, "base");
  fs.mkdirSync(base);
  const candidate = path.join(temp, "candidate");
  const composed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "compose-candidate.mjs"), base, output, candidate], { encoding: "utf8" });
  assert.equal(composed.status, 0, composed.stderr);
  assert.ok(fs.existsSync(path.join(candidate, "extensions", "team-demo", "index.html")));
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

test("validation candidate replaces only the owning extension and its connectors", (t) => {
  const { temp, repo } = fixture(t);
  const bundle = path.join(temp, "bundle");
  bundleStandalone(repo, "dev", bundle);
  const base = path.join(temp, "base");
  for (const dir of ["extensions/other", "extensions/team-demo-extra", "extensions/team-demo", "connectors", "config"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
  fs.writeFileSync(path.join(base, "extensions", "other", "index.html"), "other");
  fs.writeFileSync(path.join(base, "extensions", "team-demo", "stale.js"), "old");
  fs.writeFileSync(path.join(base, "connectors", "team-demo-old.yaml"), "old connector");
  fs.writeFileSync(path.join(base, "connectors", "team-demo-legacy.yaml"), "seeded before publish markers existed");
  fs.writeFileSync(path.join(base, "extensions", "team-demo", ".harbor-publish.json"), JSON.stringify({ commit: "e".repeat(40), connectors: ["team-demo-old.yaml"] }));
  fs.writeFileSync(path.join(base, "connectors", "team-demo-extra-api.yaml"), "belongs to team-demo-extra");
  fs.writeFileSync(path.join(base, "config", "grants.yaml"), "{}\n");
  const compose = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "compose-candidate.mjs"), ...args], { encoding: "utf8" });
  const out = path.join(temp, "candidate");
  const composed = compose(base, bundle, out);
  assert.equal(composed.status, 0, composed.stderr);
  assert.equal(fs.readFileSync(path.join(out, "extensions", "other", "index.html"), "utf8"), "other");
  assert.equal(fs.existsSync(path.join(out, "extensions", "team-demo", "stale.js")), false);
  assert.equal(fs.existsSync(path.join(out, "connectors", "team-demo-old.yaml")), false, "connector recorded by the previous publish is retired");
  assert.ok(fs.existsSync(path.join(out, "connectors", "team-demo-legacy.yaml")), "unrecorded connectors are never claimed by prefix");
  assert.ok(fs.existsSync(path.join(out, "connectors", "team-demo-extra-api.yaml")));
  assert.match(fs.readFileSync(path.join(out, "connectors", "team-demo-api.yaml"), "utf8"), /team-demo-api.dev.internal/);
  assert.equal(fs.readFileSync(path.join(out, "config", "grants.yaml"), "utf8"), "{}\n");
  assert.equal(fs.existsSync(path.join(out, "config", "release.json")), false);
  const policy = path.join(temp, "policy");
  fs.mkdirSync(policy);
  fs.writeFileSync(path.join(policy, "grants.yaml"), "team-demo: []\n");
  fs.writeFileSync(path.join(policy, "nav.yaml"), "sections: {}\n");
  assert.equal(compose(base, bundle, path.join(temp, "mixed"), policy).status, 1);
  const policyOut = path.join(temp, "policy-candidate");
  const policyComposed = compose(out, "-", policyOut, policy);
  assert.equal(policyComposed.status, 0, policyComposed.stderr);
  assert.ok(fs.existsSync(path.join(policyOut, "extensions", "team-demo", "index.html")));
  assert.equal(fs.readFileSync(path.join(policyOut, "config", "grants.yaml"), "utf8"), "team-demo: []\n");
  fs.writeFileSync(path.join(bundle, "extensions", "team-demo", ".harbor-publish.json"), "{}");
  const reserved = compose(base, bundle, path.join(temp, "reserved"));
  assert.equal(reserved.status, 1);
  assert.match(reserved.stderr, /reserved for the platform/);
});

function platformPython() {
  const candidates = [process.env.HARBOR_PYTHON, path.join(ROOT, ".venv", "bin", "python"), "python3", "python"].filter(Boolean);
  return candidates.find((python) => spawnSync(python, ["-c", "import harbor_platform.validate"], { cwd: path.join(ROOT, "backend") }).status === 0);
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("bucket-only publish writes just the pushed extension, in a safe order, and never a Deployment", async (t) => {
  if (process.platform === "win32") { t.skip("platform publish job runs on Linux Jenkins agents"); return; }
  const python = platformPython();
  if (!python) { t.skip("backend requirements are not installed for any python"); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-publish-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const bucket = path.join(temp, "bucket");
  const log = path.join(temp, "writes.log");
  fs.mkdirSync(bucket);
  const cli = path.join(ROOT, "cli", "harbor.mjs");
  const git = (repo, ...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (repo, message) => {
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=Harbor", "-c", "user.email=harbor@local.test", "commit", "-qm", message);
    return git(repo, "rev-parse", "HEAD");
  };
  const scaffold = (name) => {
    const created = spawnSync(process.execPath, [cli, "extension", "new", name, "--owner", name, "--contact", `${name}@corp.test`, "--description", `${name} publish test`], { cwd: temp, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const repo = path.join(temp, name);
    git(repo, "init", "-q", "-b", "dev");
    return { repo, sha: commit(repo, "initial") };
  };
  const writes = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const publish = (env) => {
    fs.rmSync(log, { force: true });
    return run("bash", [path.join(ROOT, "scripts", "publish-content.sh")], {
      env: {
        ...process.env, HARBOR_CI: "jenkins", HARBOR_SOURCE_EVENT: "push", HARBOR_BUCKET: "harbor-test-content",
        HARBOR_STORAGE_ADAPTER: path.join(ROOT, "cli", "tests", "fixtures", "fs-storage.sh"),
        HARBOR_TEST_BUCKET_DIR: bucket, HARBOR_TEST_STORAGE_LOG: log, HARBOR_PYTHON: python, ...env,
      },
    });
  };
  const extensionPush = (repo, sha, extra = {}) => ({ HARBOR_SOURCE_REF: "refs/heads/dev", HARBOR_SOURCE_SHA: sha, HARBOR_EXTENSION_CHECKOUT: repo, HARBOR_PLATFORM_REVIEW_ENFORCED: "true", ...extra });
  const object = (rel) => path.join(bucket, rel);

  const demo = scaffold("team-demo");
  const extra = scaffold("team-demo-extra");

  const early = await publish(extensionPush(demo.repo, demo.sha));
  assert.equal(early.status, 1);
  assert.match(early.stderr, /not bootstrapped/);
  assert.deepEqual(writes(), []);

  const boot = await publish({ HARBOR_POLICY_ONLY: "true", HARBOR_POLICY_DIR: path.join(ROOT, "deploy", "policy", "dev"), HARBOR_SOURCE_REF: "refs/heads/main", HARBOR_ENVIRONMENT: "dev", HARBOR_SOURCE_SHA: "c".repeat(40), HARBOR_PLATFORM_REVIEW_ENFORCED: "true" });
  assert.equal(boot.status, 0, boot.stderr);
  assert.deepEqual(writes().sort(), ["put config/grants.yaml", "put config/nav.yaml", "put connectors/.keep", "put extensions/.keep"]);

  const unreviewed = await publish(extensionPush(demo.repo, demo.sha, { HARBOR_PLATFORM_REVIEW_ENFORCED: "" }));
  assert.equal(unreviewed.status, 1, "a new connector needs the platform review gate");
  assert.deepEqual(writes(), []);

  const [first, second] = await Promise.all([publish(extensionPush(demo.repo, demo.sha)), publish(extensionPush(extra.repo, extra.sha))]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  for (const name of ["team-demo", "team-demo-extra"]) {
    assert.ok(fs.existsSync(object(`extensions/${name}/index.html`)), name);
    assert.ok(fs.existsSync(object(`connectors/${name}-api.yaml`)), name);
  }
  const marker = JSON.parse(fs.readFileSync(object("extensions/team-demo/.harbor-publish.json"), "utf8"));
  assert.equal(marker.commit, demo.sha);
  assert.deepEqual(marker.connectors, ["team-demo-api.yaml"]);
  assert.match(first.stdout, /no Deployment change/);

  fs.appendFileSync(path.join(demo.repo, "web", "index.html"), "\n<!-- v2-marker -->\n");
  fs.writeFileSync(path.join(demo.repo, "web", "extra.css"), "body { margin: 0; }\n");
  const v2 = commit(demo.repo, "v2");
  const second2 = await publish(extensionPush(demo.repo, v2));
  assert.equal(second2.status, 0, second2.stderr);
  const order = writes();
  const at = (line) => { const i = order.indexOf(line); assert.notEqual(i, -1, `${line} in ${order.join(", ")}`); return i; };
  assert.ok(at("put extensions/team-demo/extra.css") < at("put extensions/team-demo/index.html"));
  assert.ok(at("put extensions/team-demo/index.html") < at("put extensions/team-demo/extension.yaml"));
  assert.equal(order.at(-1), "put extensions/team-demo/.harbor-publish.json");
  assert.ok(order.every((line) => /^put (extensions\/team-demo\/|connectors\/team-demo-api\.yaml$)/.test(line)), order.join(", "));
  assert.equal(order.some((line) => line.includes("app.js")), false, "unchanged files are not rewritten");

  fs.rmSync(path.join(demo.repo, "web", "extra.css"));
  const v3 = commit(demo.repo, "v3");
  const third = await publish(extensionPush(demo.repo, v3));
  assert.equal(third.status, 0, third.stderr);
  const removal = writes();
  assert.ok(removal.indexOf("del extensions/team-demo/extra.css") > removal.indexOf("put extensions/team-demo/extension.yaml"));
  assert.ok(fs.existsSync(object("connectors/team-demo-extra-api.yaml")), "a longer-named extension keeps its connector");
  assert.ok(fs.existsSync(object("extensions/team-demo-extra/index.html")));

  const again = await publish(extensionPush(demo.repo, v3));
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Already published/);
  assert.deepEqual(writes(), []);

  const manifest = path.join(demo.repo, "extension.yaml");
  fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace("team-demo-api.health.read", "nope.read"));
  const broken = commit(demo.repo, "broken");
  const before = fs.readFileSync(object("extensions/team-demo/extension.yaml"), "utf8");
  const rejected = await publish(extensionPush(demo.repo, broken));
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /nothing was changed in the bucket/);
  assert.deepEqual(writes(), []);
  assert.equal(fs.readFileSync(object("extensions/team-demo/extension.yaml"), "utf8"), before);

  // Renaming the connector retires the old object through the marker, never by prefix.
  git(demo.repo, "checkout", "-q", v3);
  git(demo.repo, "checkout", "-q", "-B", "dev");
  for (const rel of ["extension.yaml", "env/dev.yaml", "env/local.yaml", "env/prod.yaml", "connectors/team-demo-api.yaml"]) {
    const file = path.join(demo.repo, rel);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("team-demo-api", "team-demo-svc"));
  }
  fs.renameSync(path.join(demo.repo, "connectors", "team-demo-api.yaml"), path.join(demo.repo, "connectors", "team-demo-svc.yaml"));
  const renamed = commit(demo.repo, "rename connector");
  const rename = await publish(extensionPush(demo.repo, renamed));
  assert.equal(rename.status, 0, rename.stderr);
  assert.ok(writes().indexOf("del connectors/team-demo-api.yaml") > writes().indexOf("put extensions/team-demo/extension.yaml"));
  assert.equal(fs.existsSync(object("connectors/team-demo-api.yaml")), false);
  assert.ok(fs.existsSync(object("connectors/team-demo-svc.yaml")));
  assert.ok(fs.existsSync(object("connectors/team-demo-extra-api.yaml")));
  assert.deepEqual(JSON.parse(fs.readFileSync(object("extensions/team-demo/.harbor-publish.json"), "utf8")).connectors, ["team-demo-svc.yaml"]);
});

test("GKE manifest check requires the bucket root and a bounded FUSE metadata TTL", (t) => {
  if (spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status !== 0) { t.skip("kubectl not installed"); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-manifest-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, "deploy", "k8s"), path.join(temp, "deploy", "k8s"), { recursive: true });
  const overlay = path.join(temp, "deploy", "k8s", "overlays", "dev", "kustomization.yaml");
  const values = {
    IMAGE_REPOSITORY: "registry.test/harbor/harbor-extensions", IMAGE_DIGEST: "a".repeat(64), DEV_BUCKET: "harbor-dev-content",
    DEV_INGRESS_PROXY_CIDRS: "10.0.0.0/8", DEV_PAT_URL: "https://pat.test/pat", DEV_HARBOR_ORIGIN: "https://harbor.test", DEV_LOGIN_URL: "https://harbor.test/login",
  };
  const filled = fs.readFileSync(overlay, "utf8").replace(/REPLACE_WITH_([A-Z_]+)/g, (match, key) => values[key] ?? match);
  assert.doesNotMatch(filled, /REPLACE_WITH_/);
  const check = () => spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-gke-manifest.mjs"), "dev"], { cwd: temp, encoding: "utf8", env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") } });
  fs.writeFileSync(overlay, filled);
  const ok = check();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /metadata TTL 30s/);
  const pinRoot = "\n      - op: replace\n        path: /spec/template/spec/containers/0/env/0/value\n        value: /content/releases/" + "b".repeat(40);
  fs.writeFileSync(overlay, filled.replace("value: harbor-dev-content", "value: harbor-dev-content" + pinRoot));
  assert.match(check().stderr, /bucket root/);
  const base = path.join(temp, "deploy", "k8s", "base", "deployment.yaml");
  fs.writeFileSync(overlay, filled);
  fs.writeFileSync(base, fs.readFileSync(base, "utf8").replace(",metadata-cache:ttl-secs:30", ""));
  assert.match(check().stderr, /metadata-cache:ttl-secs/);
});
test("Node preview serves web and forwards connector calls to a local backend", async (t) => {
  const { repo } = fixture(t);
  const backend = http.createServer((req, res) => {
    if (req.url.startsWith("/extensions/api/can?")) return res.writeHead(200, { "Content-Type": "application/json" }).end('{"allowed":true}');
    if (req.url.endsWith("/forbidden")) return res.writeHead(403, { "Content-Type": "application/json", "X-Harbor-Gateway-Error": "missing_group" }).end('{"reason":"Join the required AD group"}');
    const data = req.url === "/extensions/api/me"
      ? { user: "dev-user", display_name: "Dev User", groups: ["APP-DEV-ALL"], credential: "pat" }
      : { message: "local backend reached", user: req.headers["x-harbor-local-user"] || null, authorization: req.headers.authorization || null, extension: req.headers["x-harbor-extension"] || null, path: req.url };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  });
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
  const child = spawn(process.execPath, [path.join(ROOT, "cli", "harbor.mjs"), "extension", "dev", "--port", String(port)], { cwd: repo, stdio: "ignore", env: { ...process.env, HARBOR_SECRET_TEAM_DEMO_TOKEN: "local-secret", HARBOR_DEV_GATEWAY_URL: `http://127.0.0.1:${backendPort}/extensions`, HARBOR_DEV_PAT: "dev-pat" } });
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
  assert.deepEqual(await preview.json(), { gateway: false, connectors: [{ id: "team-demo-api", upstream: `http://127.0.0.1:${backendPort}`, via: "direct", probes: ["/health"] }] });
  assert.equal((await fetch(`${origin}/preview/shell.js`)).status, 200);
  assert.equal((await fetch(`${origin}/ext/team-demo/env/prod.yaml`)).status, 404);
  const response = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ op: "gw", connector: "team-demo-api", method: "GET", path: "/health" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.user, "local");
  const selected = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Harbor-Preview-Staff-Id": "A12345" },
    body: JSON.stringify({ op: "gw", connector: "team-demo-api", method: "GET", path: "/health" }),
  });
  assert.equal((await selected.json()).data.user, "A12345");
  const connectorFile = path.join(repo, "connectors", "team-demo-api.yaml");
  fs.writeFileSync(connectorFile, fs.readFileSync(connectorFile, "utf8").replace("type: identity-only", "type: service-account\n  secret: TEAM_DEMO_TOKEN"));
  const serviceCall = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Harbor-Preview-Staff-Id": "A12345" },
    body: JSON.stringify({ op: "gw", connector: "team-demo-api", method: "GET", path: "/health" }),
  });
  assert.equal((await serviceCall.json()).data.authorization, "Bearer local-secret");
  fs.writeFileSync(connectorFile, fs.readFileSync(connectorFile, "utf8").replace("type: service-account\n  secret: TEAM_DEMO_TOKEN", "type: identity-only"));
  fs.writeFileSync(path.join(repo, "env", "local.yaml"), "gateway: dev\n");
  const gatewayCall = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Harbor-Preview-Staff-Id": "A12345" },
    body: JSON.stringify({ op: "gw", connector: "team-demo-api", method: "GET", path: "/health" }),
  });
  assert.deepEqual((await gatewayCall.json()).data, { message: "local backend reached", user: null, authorization: "Bearer dev-pat", extension: "team-demo", path: "/extensions/gw/team-demo-api/health" });
  const manifest = path.join(repo, "extension.yaml");
  fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace("team-demo-api.health.read]", "team-demo-api.health.read, snow.change.read]"));
  const external = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ op: "gw", connector: "snow", method: "GET", path: "/api/now/table/change_request" }),
  });
  assert.equal((await external.json()).data.path, "/extensions/gw/snow/api/now/table/change_request");
  const can = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ op: "can", connector: "snow", capability: "change.read" }),
  });
  assert.equal((await can.json()).data.allowed, true);
  const denied = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ op: "gw", connector: "snow", method: "GET", path: "/forbidden" }),
  });
  assert.equal((await denied.json()).gatewayError, "missing_group");
  const gatewayPreview = await fetch(`${origin}/api/preview-config`);
  assert.deepEqual((await gatewayPreview.json()).connectors.map((connector) => connector.id), ["team-demo-api", "snow"]);
  const me = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Harbor-Preview-Staff-Id": "A12345" },
    body: JSON.stringify({ op: "me" }),
  });
  assert.deepEqual((await me.json()).data, { user: "dev-user", display_name: "Dev User", groups: ["APP-DEV-ALL"], credential: "pat" });
  const invalid = await fetch(`${origin}/api/bridge`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Harbor-Preview-Staff-Id": "bad id" },
    body: JSON.stringify({ op: "me" }),
  });
  assert.equal(invalid.status, 400);
});

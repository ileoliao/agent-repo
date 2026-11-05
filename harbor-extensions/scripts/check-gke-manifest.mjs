#!/usr/bin/env node
// Fail closed before applying a GKE overlay with placeholders or a mutable content/image reference.
import { execFileSync } from "node:child_process";
import YAML from "yaml";

const environment = process.argv[2];
if (!["dev", "prod"].includes(environment)) {
  console.error("usage: node scripts/check-gke-manifest.mjs <dev|prod>");
  process.exit(2);
}
try {
  const rendered = execFileSync("kubectl", ["kustomize", `deploy/k8s/overlays/${environment}`], { encoding: "utf8" });
  if (/REPLACE_WITH_|REPLACE_ME|:latest\b/.test(rendered)) throw new Error(`${environment} overlay contains unresolved deployment parameters`);
  const objects = YAML.parseAllDocuments(rendered).map((doc) => doc.toJS());
  const deployment = objects.find((item) => item.kind === "Deployment" && item.metadata.name === "harbor-extensions");
  const container = deployment?.spec?.template?.spec?.containers?.find((item) => item.name === "app");
  const env = Object.fromEntries((container?.env || []).map((item) => [item.name, item.value]));
  const bucket = deployment?.spec?.template?.spec?.volumes?.find((item) => item.name === "content")?.csi?.volumeAttributes?.bucketName;
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(container?.image || "")) throw new Error("app image must be pinned by SHA-256 digest");
  if (!/^[a-f0-9]{40}$/.test(env.HARBOR_RELEASE_ID || "") || env.HARBOR_ROOT !== `/content/releases/${env.HARBOR_RELEASE_ID}`) {
    throw new Error("content must be pinned to a 40-character immutable release ID");
  }
  if (!bucket || bucket.includes("REPLACE") || !deployment.metadata.namespace) throw new Error("bucket and namespace must be configured");
  if (!env.FORWARDED_ALLOW_IPS || env.FORWARDED_ALLOW_IPS === "*") throw new Error("trusted ingress proxy IPs must be explicit");
  console.log(`${environment} overlay ready: ${deployment.metadata.namespace}, ${bucket}, ${env.HARBOR_RELEASE_ID}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

#!/usr/bin/env node
// Fail closed before applying a GKE overlay with placeholders, a mutable image, or a mount that hides bucket updates.
import { execFileSync } from "node:child_process";
import YAML from "yaml";

// Publishing only updates the bucket, so pods must re-read object metadata within this window.
const MAX_METADATA_TTL_SECONDS = 60;

const environment = process.argv[2];
if (!["dev", "prod"].includes(environment)) {
  console.error("usage: node scripts/check-gke-manifest.mjs <dev|prod>");
  process.exit(2);
}

// GCS FUSE CSI options are "flag", "flag=value" or "section:key:value" (config-file keys).
function mountOptionMap(value) {
  return Object.fromEntries(String(value || "").split(",").filter(Boolean).map((item) => {
    const at = item.includes("=") ? item.indexOf("=") : item.lastIndexOf(":");
    return at < 0 ? [item, true] : [item.slice(0, at), item.slice(at + 1)];
  }));
}

try {
  const rendered = execFileSync("kubectl", ["kustomize", `deploy/k8s/overlays/${environment}`], { encoding: "utf8" });
  if (/REPLACE_WITH_|REPLACE_ME|:latest\b/.test(rendered)) throw new Error(`${environment} overlay contains unresolved deployment parameters`);
  const objects = YAML.parseAllDocuments(rendered).map((doc) => doc.toJS());
  const deployment = objects.find((item) => item.kind === "Deployment" && item.metadata.name === "harbor-extensions");
  const container = deployment?.spec?.template?.spec?.containers?.find((item) => item.name === "app");
  const env = Object.fromEntries((container?.env || []).map((item) => [item.name, item.value]));
  const attributes = deployment?.spec?.template?.spec?.volumes?.find((item) => item.name === "content")?.csi?.volumeAttributes || {};
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(container?.image || "")) throw new Error("app image must be pinned by SHA-256 digest");
  if (env.HARBOR_ROOT !== "/content" || "HARBOR_RELEASE_ID" in env) throw new Error("content must be served from the bucket root (/content), not a pinned release");
  const options = mountOptionMap(attributes.mountOptions);
  const ttl = Number(options["metadata-cache:ttl-secs"]);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_METADATA_TTL_SECONDS) {
    throw new Error(`content mount needs metadata-cache:ttl-secs between 0 and ${MAX_METADATA_TTL_SECONDS} so bucket publishes become visible`);
  }
  if (Number(options["file-system:kernel-list-cache-ttl-secs"] ?? 0) !== 0) throw new Error("content mount must not cache directory listings in the kernel");
  if (!attributes.bucketName || attributes.bucketName.includes("REPLACE") || !deployment.metadata.namespace) throw new Error("bucket and namespace must be configured");
  if (!env.FORWARDED_ALLOW_IPS || env.FORWARDED_ALLOW_IPS === "*") throw new Error("trusted ingress proxy IPs must be explicit");
  console.log(`${environment} overlay ready: ${deployment.metadata.namespace}, ${attributes.bucketName}, metadata TTL ${ttl}s`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

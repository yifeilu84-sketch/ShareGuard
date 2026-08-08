"use strict";

const PACKAGE_SCHEMAS = new Set(["shareguard.sgd.v2", "shareguard.sgd.v3"]);
const SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256";
const ZERO_HASH = "0".repeat(64);

const verifier = {
  currentPackage: null,
  currentPackageName: "",
  pendingFile: null,
  verifiedObjectUrl: null
};

function initVerifier() {
  [
    "verifierInput", "verifierDrop", "verificationResult", "verificationState",
    "verificationEmpty", "verificationDetail", "verificationCode", "verificationTitle",
    "verificationNarrative", "verifiedMedia", "verifiedImage", "verifiedFile",
    "verifiedDigest", "verifiedSignature", "verifiedAt", "verifiedScope",
    "detachedMediaPrompt", "detachedMediaInput", "packagePassphrasePrompt",
    "packagePassphrase", "unlockPackageButton"
  ].forEach((id) => { verifier[id] = document.getElementById(id); });

  verifier.verifierInput.addEventListener("change", () => {
    const [file] = verifier.verifierInput.files || [];
    if (file) verifyEvidenceFile(file);
  });
  verifier.detachedMediaInput.addEventListener("change", () => {
    const [file] = verifier.detachedMediaInput.files || [];
    if (file) verifyDetachedMedia(file);
  });
  verifier.unlockPackageButton.addEventListener("click", () => {
    if (verifier.pendingFile) verifyEvidenceFile(
      verifier.pendingFile,
      verifier.packagePassphrase.value
    );
  });
  ["dragenter", "dragover"].forEach((eventName) => {
    verifier.verifierDrop.addEventListener(eventName, (event) => {
      event.preventDefault();
      verifier.verifierDrop.classList.add("active");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    verifier.verifierDrop.addEventListener(eventName, (event) => {
      event.preventDefault();
      verifier.verifierDrop.classList.remove("active");
    });
  });
  verifier.verifierDrop.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer?.files || [];
    if (file) verifyEvidenceFile(file);
  });
}

async function verifyEvidenceFile(file, passphrase = "") {
  setVerificationState("VERIFYING", "working");
  verifier.verificationEmpty.hidden = false;
  verifier.verificationEmpty.querySelector("span").textContent = "RECOMPUTING EVENT CHAIN, DIGEST AND SIGNATURE";
  verifier.verificationDetail.hidden = true;
  verifier.packagePassphrasePrompt.hidden = true;

  try {
    if (!window.crypto?.subtle) throw new Error("WEB CRYPTO API UNAVAILABLE");
    if (file.size > 20 * 1024 * 1024) throw new Error("PACKAGE EXCEEDS 20 MB LIMIT");
    if (!window.ShareGuardSgd) throw new Error("SGD CONTAINER CODEC UNAVAILABLE");
    const unpacked = await window.ShareGuardSgd.unpack(await file.arrayBuffer(), { passphrase });
    const evidencePackage = unpacked.package;
    validatePackageShape(evidencePackage);
    const trustRoot = trustedRootFor(evidencePackage);
    if (!trustRoot) throw new Error("UNTRUSTED ISSUER OR SIGNING KEY");
    if (!await verifyEventChain(evidencePackage.case.events)) {
      throw new Error("EVENT CHAIN INVALID");
    }
    if (evidencePackage.case.chain_head !== evidencePackage.case.events.at(-1)?.event_hash) {
      throw new Error("EVENT CHAIN HEAD MISMATCH");
    }
    await verifyMediaManifest(evidencePackage);

    const canonical = stableStringify(signedPayload(evidencePackage));
    const encoded = new TextEncoder().encode(canonical);
    const digest = bufferToHex(await crypto.subtle.digest("SHA-256", encoded));
    if (digest !== String(evidencePackage.payload_sha256).toLowerCase()) {
      throw new Error("SIGNED PAYLOAD SHA-256 MISMATCH");
    }
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      trustRoot.public_jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const validSignature = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64UrlToArrayBuffer(evidencePackage.signature),
      encoded
    );
    if (!validSignature) throw new Error("ECDSA SIGNATURE INVALID");

    verifier.currentPackage = evidencePackage;
    verifier.currentPackageName = file.name;
    verifier.pendingFile = null;
    verifier.packagePassphrase.value = "";
    renderVerifiedPackage(evidencePackage, file.name);
    const embeddedCount = evidencePackage.media_manifest?.filter(
      (entry) => entry.inclusion === "embedded"
    ).length || 0;
    setVerificationState(
      embeddedCount ? "PACKAGE AND EMBEDDED MEDIA VERIFIED" : "PACKAGE VERIFIED / MEDIA FILE OPTIONAL",
      "valid_trusted"
    );
  } catch (error) {
    if (/passphrase|decrypt/i.test(String(error?.message || ""))) {
      verifier.pendingFile = file;
      verifier.packagePassphrasePrompt.hidden = false;
      verifier.verificationEmpty.hidden = false;
      verifier.verificationEmpty.querySelector("span").textContent = "ENCRYPTED PACKAGE / PASSPHRASE REQUIRED";
      setVerificationState("PASSPHRASE REQUIRED", "working");
      return;
    }
    renderVerificationFailure(error);
  }
}

function validatePackageShape(evidencePackage) {
  if (!evidencePackage || !PACKAGE_SCHEMAS.has(evidencePackage.schema)) {
    throw new Error("UNSUPPORTED SHAREGUARD PACKAGE FORMAT");
  }
  if (
    evidencePackage.signature_algorithm !== SIGNATURE_ALGORITHM ||
    !evidencePackage.case ||
    !new Set(["shareguard.case.v2", "shareguard.case.v3"]).has(evidencePackage.case.schema) ||
    !Array.isArray(evidencePackage.case.events) ||
    !evidencePackage.case.events.length ||
    !/^[a-f0-9]{64}$/i.test(String(evidencePackage.payload_sha256 || "")) ||
    !/^[A-Za-z0-9_-]+$/.test(String(evidencePackage.signature || ""))
  ) {
    throw new Error("CRYPTOGRAPHIC MATERIAL INCOMPLETE");
  }
}

function trustedRootFor(evidencePackage) {
  const trustRoots = window.ShareGuardRuntime.trustRoots || [];
  return trustRoots.find((root) => (
    root.issuer === evidencePackage.issuer &&
    root.key_id === evidencePackage.key_id &&
    root.algorithm === SIGNATURE_ALGORITHM
  ));
}

function signedPayload(evidencePackage) {
  const payload = {
    schema: evidencePackage.schema,
    issuer: evidencePackage.issuer,
    key_id: evidencePackage.key_id,
    signed_at: evidencePackage.signed_at,
    signature_algorithm: evidencePackage.signature_algorithm,
    case: evidencePackage.case
  };
  if (evidencePackage.schema === "shareguard.sgd.v3") {
    payload.media_manifest = evidencePackage.media_manifest;
  }
  return payload;
}

async function verifyMediaManifest(evidencePackage) {
  if (evidencePackage.schema === "shareguard.sgd.v2") return;
  if (!Array.isArray(evidencePackage.media_manifest)) {
    throw new Error("SIGNED MEDIA MANIFEST MISSING");
  }
  const versions = new Map(
    evidencePackage.case.versions.map((version) => [version.version_id, version])
  );
  if (evidencePackage.media_manifest.length !== versions.size) {
    throw new Error("SIGNED MEDIA MANIFEST INCOMPLETE");
  }
  const seen = new Set();
  for (const entry of evidencePackage.media_manifest) {
    const version = versions.get(entry?.version_id);
    if (
      !version || seen.has(entry.version_id) ||
      entry.media_sha256 !== version.media_sha256 ||
      !new Set(["embedded", "detached_digest_only"]).has(entry.inclusion)
    ) {
      throw new Error("SIGNED MEDIA MANIFEST INVALID");
    }
    seen.add(entry.version_id);
    if (entry.inclusion === "embedded") {
      const bytes = base64UrlToBytes(entry.content_base64url);
      if (bytes.length !== entry.byte_size || bytes.length > 8 * 1024 * 1024) {
        throw new Error("EMBEDDED MEDIA SIZE MISMATCH");
      }
      const digest = bufferToHex(await crypto.subtle.digest("SHA-256", bytes));
      if (digest !== entry.media_sha256) throw new Error("EMBEDDED MEDIA SHA-256 MISMATCH");
    }
  }
}

async function verifyEventChain(events) {
  let previousHash = ZERO_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const core = {
      sequence: event.sequence,
      created_at: event.created_at,
      actor_id: event.actor_id,
      event_type: event.event_type,
      payload: event.payload,
      previous_hash: event.previous_hash
    };
    const eventHash = bufferToHex(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stableStringify(core))
      )
    );
    if (
      event.sequence !== index + 1 ||
      event.previous_hash !== previousHash ||
      event.event_hash !== eventHash
    ) return false;
    previousHash = event.event_hash;
  }
  return true;
}

function renderVerifiedPackage(evidencePackage, filename) {
  const record = evidencePackage.case;
  const original = record.versions.find((version) => version.role === "original") || record.versions[0];
  const decision = record.human_decision;
  verifier.verificationEmpty.hidden = true;
  verifier.verificationDetail.hidden = false;
  verifier.verificationCode.textContent = `CASE #${record.case_id || "UNKNOWN"}`;
  verifier.verificationTitle.textContent = String(decision?.action || "SEALED DOSSIER").toUpperCase();
  verifier.verificationNarrative.textContent = decision
    ? `HUMAN DECISION / ${decision.reason_code}${decision.note ? ` / ${decision.note}` : ""}`
    : "NO HUMAN DECISION RECORDED";
  verifier.verifiedDigest.textContent = evidencePackage.payload_sha256.toUpperCase();
  verifier.verifiedSignature.textContent = `ECDSA P-256 / TRUSTED / ${evidencePackage.key_id}`;
  verifier.verifiedAt.textContent = String(evidencePackage.signed_at || "UNKNOWN");
  verifier.verifiedScope.textContent = `${record.events.length} EVENTS / ${record.versions.length} MEDIA DIGESTS`;
  revokeVerifiedObjectUrl();
  const manifest = evidencePackage.media_manifest?.find(
    (entry) => entry.version_id === original?.version_id
  );
  if (manifest?.inclusion === "embedded") {
    const bytes = base64UrlToBytes(manifest.content_base64url);
    const media = new Blob([bytes], { type: manifest.content_type || "application/octet-stream" });
    verifier.verifiedObjectUrl = URL.createObjectURL(media);
    verifier.verifiedImage.src = verifier.verifiedObjectUrl;
    verifier.verifiedMedia.hidden = false;
    verifier.verifiedFile.textContent = `${manifest.file_name || original.file_name} / EMBEDDED MEDIA VERIFIED`;
    verifier.detachedMediaPrompt.hidden = true;
  } else {
    verifier.verifiedFile.textContent = `${original?.file_name || filename} / DETACHED MEDIA`;
    verifier.detachedMediaPrompt.hidden = !original?.media_sha256;
    verifier.verifiedMedia.hidden = true;
    verifier.verifiedImage.removeAttribute("src");
  }
}

async function verifyDetachedMedia(file) {
  const evidencePackage = verifier.currentPackage;
  const original = evidencePackage?.case?.versions?.find((version) => version.role === "original") || evidencePackage?.case?.versions?.[0];
  const expectedDigest = String(original?.media_sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
    renderVerificationFailure(new Error("SIGNED MEDIA DIGEST MISSING"));
    return;
  }

  setVerificationState("VERIFYING DETACHED MEDIA", "working");
  try {
    const digest = await digestMediaInWorker(await file.arrayBuffer());
    if (digest !== expectedDigest) throw new Error("DETACHED MEDIA SHA-256 MISMATCH");
    verifier.detachedMediaPrompt.hidden = true;
    verifier.verifiedFile.textContent = `${file.name} / DETACHED MEDIA VERIFIED`;
    if (/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      revokeVerifiedObjectUrl();
      verifier.verifiedObjectUrl = URL.createObjectURL(file);
      verifier.verifiedImage.src = verifier.verifiedObjectUrl;
      verifier.verifiedMedia.hidden = false;
    }
    setVerificationState("INTEGRITY AND MEDIA VERIFIED", "valid_trusted");
  } catch (error) {
    renderVerificationFailure(error);
  }
}

function digestMediaInWorker(mediaBuffer) {
  if (!("Worker" in window)) {
    return crypto.subtle.digest("SHA-256", mediaBuffer).then(bufferToHex);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker("crypto-worker.js");
    const requestId = `digest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("MEDIA DIGEST WORKER TIMEOUT"));
    }, 30_000);
    const finish = (callback, value) => {
      window.clearTimeout(timeout);
      worker.terminate();
      callback(value);
    };
    worker.addEventListener("message", (event) => {
      if (event.data?.requestId !== requestId) return;
      if (event.data.success) finish(resolve, String(event.data.digest).toLowerCase());
      else finish(reject, new Error(event.data?.error || "MEDIA DIGEST FAILED"));
    });
    worker.addEventListener("error", () => finish(reject, new Error("MEDIA DIGEST WORKER FAILED")));
    worker.postMessage({ type: "digest", requestId, mediaBuffer }, [mediaBuffer]);
  });
}

function revokeVerifiedObjectUrl() {
  if (!verifier.verifiedObjectUrl) return;
  URL.revokeObjectURL(verifier.verifiedObjectUrl);
  verifier.verifiedObjectUrl = null;
}

function renderVerificationFailure(error) {
  verifier.verificationEmpty.hidden = true;
  verifier.verificationDetail.hidden = false;
  verifier.verificationCode.textContent = "PACKAGE REJECTED";
  verifier.verificationTitle.textContent = "INTEGRITY FAILURE";
  verifier.verificationNarrative.textContent = String(error?.message || "UNKNOWN VERIFICATION ERROR");
  verifier.verifiedDigest.textContent = "NOT TRUSTED";
  verifier.verifiedSignature.textContent = "INVALID OR UNTRUSTED";
  verifier.verifiedAt.textContent = "NOT AVAILABLE";
  verifier.verifiedScope.textContent = "NOT AVAILABLE";
  verifier.verifiedMedia.hidden = true;
  verifier.detachedMediaPrompt.hidden = true;
  revokeVerifiedObjectUrl();
  setVerificationState("VERIFICATION FAILED", "invalid");
}

function setVerificationState(label, state) {
  verifier.verificationState.textContent = label;
  verifier.verificationResult.dataset.state = state;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlToArrayBuffer(value) {
  return base64UrlToBytes(value).buffer;
}

function base64UrlToBytes(value) {
  const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

document.addEventListener("DOMContentLoaded", initVerifier);

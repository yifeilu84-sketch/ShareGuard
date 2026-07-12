"use strict";

const verifier = {
  currentPackage: null,
  currentPackageName: "",
  verifiedObjectUrl: null
};

function initVerifier() {
  [
    "verifierInput", "verifierDrop", "verificationResult", "verificationState",
    "verificationEmpty", "verificationDetail", "verificationCode", "verificationTitle",
    "verificationNarrative", "verifiedMedia", "verifiedImage", "verifiedFile",
    "verifiedDigest", "verifiedSignature", "verifiedAt", "verifiedScope",
    "detachedMediaPrompt", "detachedMediaInput"
  ].forEach((id) => { verifier[id] = document.getElementById(id); });

  verifier.verifierInput.addEventListener("change", () => {
    const [file] = verifier.verifierInput.files || [];
    if (file) verifyEvidenceFile(file);
  });
  verifier.detachedMediaInput.addEventListener("change", () => {
    const [file] = verifier.detachedMediaInput.files || [];
    if (file) verifyDetachedMedia(file);
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

async function verifyEvidenceFile(file) {
  setVerificationState("VERIFYING", "working");
  verifier.verificationEmpty.hidden = false;
  verifier.verificationEmpty.querySelector("span").textContent = "RECOMPUTING SHA-256 AND SIGNATURE";
  verifier.verificationDetail.hidden = true;

  try {
    if (!window.crypto?.subtle) throw new Error("WEB CRYPTO API UNAVAILABLE");
    if (file.size > 40 * 1024 * 1024) throw new Error("PACKAGE EXCEEDS 40 MB LIMIT");
    const evidencePackage = JSON.parse(await file.text());
    validatePackageShape(evidencePackage);

    const canonical = stableStringify(evidencePackage.manifest);
    const encoded = new TextEncoder().encode(canonical);
    const digestBuffer = await crypto.subtle.digest("SHA-256", encoded);
    const digest = bufferToHex(digestBuffer);
    if (digest !== String(evidencePackage.digest).toLowerCase()) {
      throw new Error("SHA-256 DIGEST MISMATCH");
    }

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      evidencePackage.public_key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const validSignature = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64ToArrayBuffer(evidencePackage.signature),
      encoded
    );
    if (!validSignature) throw new Error("ECDSA SIGNATURE INVALID");

    verifier.currentPackage = evidencePackage;
    verifier.currentPackageName = file.name;
    const mediaState = renderVerifiedPackage(evidencePackage, file.name);
    if (mediaState === "detached") {
      setVerificationState("PACKAGE VERIFIED / MEDIA FILE REQUIRED", "working");
    } else {
      setVerificationState("INTEGRITY VERIFIED", "valid");
    }
  } catch (error) {
    renderVerificationFailure(error);
  }
}

function validatePackageShape(evidencePackage) {
  if (!evidencePackage || evidencePackage.format !== "ShareGuard-Evidence-Package-1") {
    throw new Error("UNSUPPORTED SHAREGUARD PACKAGE FORMAT");
  }
  if (!evidencePackage.manifest || evidencePackage.manifest.format !== "ShareGuard-Dossier-1") {
    throw new Error("DOSSIER MANIFEST MISSING");
  }
  if (!evidencePackage.digest || !evidencePackage.signature || !evidencePackage.public_key) {
    throw new Error("CRYPTOGRAPHIC MATERIAL INCOMPLETE");
  }
}

function renderVerifiedPackage(evidencePackage, filename) {
  const manifest = evidencePackage.manifest;
  verifier.verificationEmpty.hidden = true;
  verifier.verificationDetail.hidden = false;
  verifier.verificationCode.textContent = `CASE #${manifest.case?.id || "UNKNOWN"}`;
  verifier.verificationTitle.textContent = String(manifest.decision?.label || "VERIFIED DOSSIER");
  verifier.verificationNarrative.textContent = String(manifest.decision?.narrative || "No narrative recorded.");
  verifier.verifiedDigest.textContent = evidencePackage.digest.toUpperCase();
  verifier.verifiedSignature.textContent = "ECDSA P-256 / VALID";
  verifier.verifiedAt.textContent = String(manifest.sealed_at || "UNKNOWN");
  verifier.verifiedScope.textContent = String(manifest.signing_scope || "UNKNOWN").toUpperCase();
  verifier.verifiedFile.textContent = `${manifest.media?.file_name || filename} / SEALED COPY`;
  verifier.detachedMediaPrompt.hidden = true;
  revokeVerifiedObjectUrl();

  const dataUrl = manifest.media?.data_url;
  if (typeof dataUrl === "string" && /^data:image\/(png|jpeg|webp);base64,/i.test(dataUrl)) {
    verifier.verifiedImage.src = dataUrl;
    verifier.verifiedMedia.hidden = false;
    return "embedded";
  }
  if (manifest.media?.embedded === false && /^[a-f0-9]{64}$/i.test(String(manifest.media?.sha256 || ""))) {
    verifier.detachedMediaPrompt.hidden = false;
    verifier.verificationNarrative.textContent = `${verifier.verificationNarrative.textContent} MEDIA FILE REQUIRED FOR DETACHED-EVIDENCE VERIFICATION.`;
    verifier.verifiedMedia.hidden = true;
    verifier.verifiedImage.removeAttribute("src");
    return "detached";
  } else {
    verifier.verifiedMedia.hidden = true;
    verifier.verifiedImage.removeAttribute("src");
    return "legacy-no-media";
  }
}

async function verifyDetachedMedia(file) {
  const evidencePackage = verifier.currentPackage;
  const expectedDigest = String(evidencePackage?.manifest?.media?.sha256 || "").toLowerCase();
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
    verifier.verificationNarrative.textContent = String(
      evidencePackage.manifest.decision?.narrative || "Signed dossier and detached media are verified."
    );
    setVerificationState("INTEGRITY VERIFIED", "valid");
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
  verifier.verifiedSignature.textContent = "INVALID";
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
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToArrayBuffer(value) {
  const binary = atob(String(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

document.addEventListener("DOMContentLoaded", initVerifier);

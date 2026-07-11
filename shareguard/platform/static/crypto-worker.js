"use strict";

self.addEventListener("message", async (event) => {
  const request = event.data || {};
  if (!['seal', 'digest'].includes(request.type)) return;

  try {
    if (!self.crypto?.subtle) throw new Error("WEB CRYPTO API UNAVAILABLE");
    if (request.type === "digest") {
      if (!request.mediaBuffer) throw new Error("DIGEST INPUT INCOMPLETE");
      const digestBuffer = await crypto.subtle.digest("SHA-256", request.mediaBuffer);
      self.postMessage({
        success: true,
        requestId: request.requestId,
        digest: bufferToHex(digestBuffer)
      });
      return;
    }
    if (!request.manifest || !request.mediaBuffer) throw new Error("SEAL INPUT INCOMPLETE");

    const mediaBytes = new Uint8Array(request.mediaBuffer);
    const mediaDigestBuffer = await crypto.subtle.digest("SHA-256", mediaBytes);
    const manifest = cloneJson(request.manifest);
    manifest.media.sha256 = bufferToHex(mediaDigestBuffer);
    manifest.media.embedded = Boolean(request.embedMedia);
    manifest.media.data_url = request.embedMedia
      ? bytesToDataUrl(mediaBytes, request.mimeType || "application/octet-stream")
      : null;

    const canonical = stableStringify(manifest);
    const encoded = new TextEncoder().encode(canonical);
    const digestBuffer = await crypto.subtle.digest("SHA-256", encoded);
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const signatureBuffer = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      encoded
    );
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.publicKey,
      signatureBuffer,
      encoded
    );
    if (!verified) throw new Error("LOCAL SIGNATURE SELF-CHECK FAILED");

    self.postMessage({
      success: true,
      requestId: request.requestId,
      manifest,
      digest: bufferToHex(digestBuffer),
      signature: arrayBufferToBase64(signatureBuffer),
      public_key: await crypto.subtle.exportKey("jwk", keyPair.publicKey)
    });
  } catch (error) {
    self.postMessage({
      success: false,
      requestId: request.requestId,
      error: String(error?.message || "WORKER CRYPTO FAILED")
    });
  }
});

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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

function arrayBufferToBase64(buffer) {
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToDataUrl(bytes, mimeType) {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = "";
    for (let index = 0; index < chunk.length; index += 1) binary += String.fromCharCode(chunk[index]);
    chunks.push(binary);
  }
  return btoa(chunks.join(""));
}

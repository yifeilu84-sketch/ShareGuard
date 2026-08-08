"use strict";

self.addEventListener("message", async (event) => {
  const request = event.data || {};
  if (request.type !== "digest") return;

  try {
    if (!self.crypto?.subtle) throw new Error("WEB CRYPTO API UNAVAILABLE");
    if (!request.mediaBuffer) throw new Error("DIGEST INPUT INCOMPLETE");
    const digestBuffer = await crypto.subtle.digest("SHA-256", request.mediaBuffer);
    self.postMessage({
      success: true,
      requestId: request.requestId,
      digest: bufferToHex(digestBuffer)
    });
  } catch (error) {
    self.postMessage({
      success: false,
      requestId: request.requestId,
      error: String(error?.message || "WORKER DIGEST FAILED")
    });
  }
});

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

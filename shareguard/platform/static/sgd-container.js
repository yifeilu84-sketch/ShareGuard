"use strict";

(function exposeSgdContainer(global) {
  const MAGIC = new TextEncoder().encode("SGD3\n");
  const CONTAINER_SCHEMA = "shareguard.sgd.container.v1";
  const MAX_CONTAINER_BYTES = 24 * 1024 * 1024;
  const MAX_HEADER_BYTES = 4096;
  const PBKDF2_ITERATIONS = 310000;

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError("SGD container bytes are invalid.");
  }

  function base64UrlEncode(value) {
    const bytes = asBytes(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return global.btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function base64UrlDecode(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
      const binary = global.atob(padded);
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch {
      throw new Error("SGD encryption metadata is invalid.");
    }
  }

  async function transform(bytes, mode) {
    const stream = new Blob([asBytes(bytes)]).stream().pipeThrough(
      mode === "compress"
        ? new CompressionStream("gzip")
        : new DecompressionStream("gzip")
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function passphraseBytes(passphrase) {
    const text = String(passphrase || "");
    if (text.length < 12 || text.length > 1024) {
      throw new Error("An encryption passphrase of at least 12 characters is required.");
    }
    return new TextEncoder().encode(text);
  }

  async function deriveKey(passphrase, salt, iterations) {
    const material = await crypto.subtle.importKey(
      "raw",
      passphraseBytes(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey({
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  function frame(headerBytes, bodyBytes) {
    if (headerBytes.length > MAX_HEADER_BYTES) throw new Error("SGD header is too large.");
    const output = new Uint8Array(MAGIC.length + 4 + headerBytes.length + bodyBytes.length);
    output.set(MAGIC, 0);
    new DataView(output.buffer).setUint32(MAGIC.length, headerBytes.length, false);
    output.set(headerBytes, MAGIC.length + 4);
    output.set(bodyBytes, MAGIC.length + 4 + headerBytes.length);
    if (output.length > MAX_CONTAINER_BYTES) throw new Error("SGD container is too large.");
    return output;
  }

  async function pack(evidencePackage, options = {}) {
    if (!evidencePackage || evidencePackage.schema !== "shareguard.sgd.v3") {
      throw new Error("A signed ShareGuard SGD v3 package is required.");
    }
    const jsonBytes = new TextEncoder().encode(JSON.stringify(evidencePackage));
    const compressed = await transform(jsonBytes, "compress");
    const passphrase = String(options.passphrase || "");
    if (!passphrase) {
      const header = {
        schema: CONTAINER_SCHEMA,
        payload_schema: evidencePackage.schema,
        compression: "gzip",
        encryption: { algorithm: "none" }
      };
      return frame(new TextEncoder().encode(JSON.stringify(header)), compressed);
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = {
      schema: CONTAINER_SCHEMA,
      payload_schema: evidencePackage.schema,
      compression: "gzip",
      encryption: {
        algorithm: "AES-256-GCM",
        kdf: "PBKDF2-SHA256",
        iterations: PBKDF2_ITERATIONS,
        salt: base64UrlEncode(salt),
        iv: base64UrlEncode(iv)
      }
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv,
      additionalData: headerBytes,
      tagLength: 128
    }, key, compressed));
    return frame(headerBytes, encrypted);
  }

  function startsWith(bytes, prefix) {
    return prefix.every((value, index) => bytes[index] === value);
  }

  async function unpack(value, options = {}) {
    const bytes = value instanceof Blob
      ? new Uint8Array(await value.arrayBuffer())
      : asBytes(value);
    if (!bytes.length || bytes.length > MAX_CONTAINER_BYTES) {
      throw new Error("SGD container size is invalid.");
    }
    if (!startsWith(bytes, MAGIC)) {
      try {
        const legacy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (legacy?.schema !== "shareguard.sgd.v2") throw new Error("not legacy");
        return { package: legacy, header: null, encrypted: false, legacy: true };
      } catch {
        throw new Error("Unsupported or invalid SGD evidence file.");
      }
    }
    if (bytes.length < MAGIC.length + 4) throw new Error("SGD header is truncated.");
    const headerLength = new DataView(
      bytes.buffer,
      bytes.byteOffset + MAGIC.length,
      4
    ).getUint32(0, false);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      throw new Error("SGD header length is invalid.");
    }
    const headerStart = MAGIC.length + 4;
    const bodyStart = headerStart + headerLength;
    if (bodyStart >= bytes.length) throw new Error("SGD payload is missing.");
    const headerBytes = bytes.slice(headerStart, bodyStart);
    let header;
    try {
      header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
    } catch {
      throw new Error("SGD header is invalid.");
    }
    if (
      header?.schema !== CONTAINER_SCHEMA ||
      header.payload_schema !== "shareguard.sgd.v3" ||
      header.compression !== "gzip"
    ) {
      throw new Error("Unsupported SGD container profile.");
    }
    let compressed = bytes.slice(bodyStart);
    let encrypted = false;
    if (header.encryption?.algorithm === "AES-256-GCM") {
      if (
        header.encryption.kdf !== "PBKDF2-SHA256" ||
        header.encryption.iterations !== PBKDF2_ITERATIONS
      ) {
        throw new Error("Unsupported SGD encryption profile.");
      }
      encrypted = true;
      try {
        const salt = base64UrlDecode(header.encryption.salt);
        const iv = base64UrlDecode(header.encryption.iv);
        if (salt.length !== 16 || iv.length !== 12) throw new Error("invalid metadata");
        const key = await deriveKey(options.passphrase, salt, PBKDF2_ITERATIONS);
        compressed = new Uint8Array(await crypto.subtle.decrypt({
          name: "AES-GCM",
          iv,
          additionalData: headerBytes,
          tagLength: 128
        }, key, compressed));
      } catch {
        throw new Error("SGD decryption failed: wrong passphrase or damaged container integrity.");
      }
    } else if (header.encryption?.algorithm !== "none") {
      throw new Error("Unsupported SGD encryption profile.");
    }
    let evidencePackage;
    try {
      const json = await transform(compressed, "decompress");
      evidencePackage = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
    } catch {
      throw new Error("SGD compressed payload is invalid.");
    }
    if (evidencePackage?.schema !== "shareguard.sgd.v3") {
      throw new Error("SGD signed payload schema is invalid.");
    }
    return { package: evidencePackage, header, encrypted, legacy: false };
  }

  global.ShareGuardSgd = Object.freeze({ pack, unpack });
})(window);

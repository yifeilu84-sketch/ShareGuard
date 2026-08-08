import { webcrypto } from "node:crypto";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";


function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}


async function assertNewFile(path) {
  try {
    const handle = await open(path, "wx");
    await handle.close();
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing file: ${path}`);
    }
    throw error;
  }
}


const privatePath = resolve(argument("--private-out"));
const publicPath = resolve(argument("--public-out"));
if (!argument("--private-out") || !argument("--public-out")) {
  throw new Error("Usage: node generate-signing-key.mjs --private-out PATH --public-out PATH");
}
if (privatePath === publicPath) {
  throw new Error("Private and public output paths must differ.");
}

await mkdir(dirname(privatePath), { recursive: true });
await mkdir(dirname(publicPath), { recursive: true });
await assertNewFile(privatePath);
await assertNewFile(publicPath);

try {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  await writeFile(privatePath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  await writeFile(publicPath, `${JSON.stringify(publicJwk)}\n`, { mode: 0o644 });
  process.stdout.write(`Private JWK written to ${privatePath}\nPublic JWK written to ${publicPath}\n`);
} catch (error) {
  await Promise.allSettled([
    unlink(privatePath),
    unlink(publicPath),
  ]);
  throw error;
}

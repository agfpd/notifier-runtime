// @bun
// node_modules/@agfpd/iapeer/src/identity/patchPeerProfile.ts
import { mkdirSync as mkdirSync2, readFileSync, rmdirSync } from "fs";
import { join as join2 } from "path";

// node_modules/@agfpd/iapeer/src/core/errors.ts
class IapError extends Error {
  constructor(message) {
    super(message);
    this.name = "IapError";
  }
}

// node_modules/@agfpd/iapeer/src/storage/atomicWrite.ts
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "fs";
import { basename, dirname, join } from "path";
import { randomUUID } from "crypto";
var DIR_MODE = 448;
function writeFileAtomicRaw(target, data, mode, tmpDir = dirname(target)) {
  mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE });
  if (tmpDir !== dirname(target))
    mkdirSync(tmpDir, { recursive: true, mode: DIR_MODE });
  const tmp = join(tmpDir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(tmp, "w", mode);
    try {
      const buf = Buffer.from(data, "utf8");
      let written = 0;
      while (written < buf.length) {
        const n = writeSync(fd, buf, written, buf.length - written);
        if (n <= 0)
          throw new Error(`writeSync made no progress writing ${target} (${written}/${buf.length} bytes)`);
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    try {
      if (existsSync(tmp))
        unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

// node_modules/@agfpd/iapeer/src/identity/patchPeerProfile.ts
var PROFILE_LOCK_WAIT_MS = 2000;
var PEER_PROFILE_PATCH_PROTOCOL = 1;
function withProfileLockSync(cwd, fn) {
  const lockDir = join2(cwd, ".iapeer", ".peer-profile.lock");
  const deadline = Date.now() + PROFILE_LOCK_WAIT_MS;
  let held = false;
  for (;; ) {
    try {
      mkdirSync2(lockDir);
      held = true;
      break;
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      if (Date.now() >= deadline)
        throw new IapError(`peer-profile lock timeout: ${lockDir}; no write performed`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    if (held)
      try {
        rmdirSync(lockDir);
      } catch {}
  }
}
function patchPeerProfile(cwd, mutate) {
  mkdirSync2(join2(cwd, ".iapeer"), { recursive: true, mode: 448 });
  withProfileLockSync(cwd, () => {
    const protocolPath = join2(cwd, ".iapeer", ".peer-profile.protocol");
    let protocol;
    try {
      protocol = readFileSync(protocolPath, "utf8").trim();
    } catch (e) {
      if (e.code !== "ENOENT")
        throw e;
    }
    if (protocol !== undefined && protocol !== String(PEER_PROFILE_PATCH_PROTOCOL)) {
      throw new IapError(`peer-profile protocol mismatch: expected ${PEER_PROFILE_PATCH_PROTOCOL}, found ${protocol}`);
    }
    if (protocol === undefined)
      writeFileAtomicRaw(protocolPath, `${PEER_PROFILE_PATCH_PROTOCOL}
`, 384);
    const path = join2(cwd, ".iapeer", "peer-profile.json");
    let raw = {};
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new IapError(`invalid peer-profile object: ${path}`);
      raw = value;
    } catch (e) {
      if (e.code !== "ENOENT")
        throw e;
    }
    const before = JSON.stringify(raw);
    const result = mutate(raw);
    if (result !== undefined)
      throw new IapError("patchPeerProfile callback must be synchronous and return void");
    if (JSON.stringify(raw) !== before)
      writeFileAtomicRaw(path, `${JSON.stringify(raw, null, 2)}
`, 384);
  });
}
export {
  patchPeerProfile,
  PEER_PROFILE_PATCH_PROTOCOL
};

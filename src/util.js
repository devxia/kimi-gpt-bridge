// Small shared helpers: atomic file writes and liveness probes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Writes via a same-directory temp file plus rename, so a crash never leaves a
// half-written target. Permissions are fixed on the temp file before the
// rename — after it the target could already be read by another process.
// `validate` runs on the temp file; throwing there aborts the write.
export function atomicWriteFile(file, content, { mode, validate } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existingMode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined;
  const targetMode = mode ?? existingMode ?? 0o600;
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(tmp, content, { mode: targetMode });
    fs.chmodSync(tmp, targetMode);
    validate?.(tmp);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp); } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') err.cleanupError = cleanupErr;
    }
    throw err;
  }
}

// EPERM means the process exists but is owned by someone else — still alive.
export function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

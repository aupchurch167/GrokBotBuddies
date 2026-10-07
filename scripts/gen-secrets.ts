import { randomBytes } from "node:crypto";

// Prints fresh secrets to stdout only. Nothing is written to disk.
for (const name of ["SESSION_SECRET", "KEY_PEPPER", "ENCRYPTION_KEY"]) {
  process.stdout.write(`${name}=${randomBytes(32).toString("base64")}\n`);
}

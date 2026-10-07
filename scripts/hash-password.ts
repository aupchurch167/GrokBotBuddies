import { Writable } from "node:stream";
import readline from "node:readline";
import argon2 from "argon2";

/** Reads a line without echoing what is typed. */
function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<void> {
  const pw = await askHidden("Admin password: ");
  const confirm = await askHidden("Confirm: ");
  if (pw.length < 12) {
    process.stderr.write("Password must be at least 12 characters.\n");
    process.exit(1);
  }
  if (pw !== confirm) {
    process.stderr.write("Passwords don't match.\n");
    process.exit(1);
  }
  const hash = await argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
  process.stdout.write(`${hash}\n`);
}

void main();

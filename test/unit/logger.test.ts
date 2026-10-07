import { describe, expect, it } from "vitest";
import { log, safeErr } from "../../src/lib/logger.js";
import { captureLogs } from "../helpers/logCapture.js";

describe("error serialization", () => {
  it("keeps only the first line of an error message", () => {
    const e = Object.assign(new Error("Invalid `prisma.message.create()` invocation:\n{ data: { body: 'SECRET-BODY' } }"), {
      code: "P2000",
    });
    const s = safeErr(e);
    expect(s).toMatchObject({ type: "Error", code: "P2000", message: "Invalid `prisma.message.create()` invocation:" });
    expect(JSON.stringify(s)).not.toContain("SECRET-BODY");
  });

  it("is applied to logged err fields", () => {
    const logs = captureLogs();
    try {
      log.error({ err: new Error("boom\nSECRET-BODY") }, "x");
    } finally {
      logs.stop();
    }
    expect(logs.text()).toContain("boom");
    expect(logs.text()).not.toContain("SECRET-BODY");
  });
});

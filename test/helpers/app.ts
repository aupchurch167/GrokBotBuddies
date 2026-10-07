import { buildApp, type AppDeps } from "../../src/app.js";

export function testApp(deps: AppDeps = {}) {
  return buildApp(deps);
}

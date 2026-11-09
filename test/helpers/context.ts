import { join } from "node:path";
import { fixedClock } from "../../src/domain/clock.js";
import type { RunProbe, ServiceState } from "../../src/kernel/catalog/probe.js";
import type { ServiceId } from "../../src/kernel/catalog/services.js";
import type { OpContext } from "../../src/ops/types.js";

const missingRun: RunProbe = async () => ({ code: null, stdout: "", stderr: "ENOENT", failedToStart: true });

function absent(id: ServiceId): ServiceState {
  return {
    id,
    displayName: id,
    required: false,
    status: "red",
    binary: null,
    source: "none",
    version: null,
    detail: "not installed",
  };
}

/** A context with everything an operation may touch stubbed, so a unit test exercises the rule, not the machine. */
export function testContext(
  root: string,
  options: {
    run?: RunProbe;
    actor?: string;
    tool?: (id: ServiceId) => Promise<ServiceState>;
    home?: string;
    privileged?: boolean;
  } = {},
): OpContext {
  return {
    root,
    home: options.home ?? join(root, "..", ".slate-test-home"),
    privileged: options.privileged ?? true,
    actor: options.actor ?? "director",
    clock: fixedClock("2026-11-09T10:00:00.000Z"),
    run: options.run ?? missingRun,
    vendorDir: join("C:", "slate", "vendor"),
    tool: options.tool ?? (async (id: ServiceId) => absent(id)),
  };
}

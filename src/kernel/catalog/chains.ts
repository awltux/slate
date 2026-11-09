import type { ServiceState } from "./probe.js";
import type { ServiceId } from "./services.js";

export const CHAIN_STAGES = ["assembly", "previz", "playback", "mix"] as const;
export type ChainStage = (typeof CHAIN_STAGES)[number];

export interface ChainDefinition {
  stage: ChainStage;
  /** Ordered rungs, best first. The first green rung wins. */
  services: ServiceId[];
  /** What is lost when the first rung is not the one that runs. */
  fallbackNote: string;
}

export const CHAIN_DEFINITIONS: ChainDefinition[] = [
  {
    stage: "assembly",
    services: ["openshot-cli", "melt", "ffmpeg"],
    fallbackNote: "hard cuts only; no transitions or titles",
  },
  {
    stage: "previz",
    services: ["blender"],
    fallbackNote: "boards only; no 3D set, blockout or camera match",
  },
  {
    stage: "playback",
    services: ["mpv"],
    fallbackNote: "browser playback of proxies only",
  },
  {
    stage: "mix",
    services: ["ffmpeg"],
    fallbackNote: "no automated mix; manual pass required",
  },
];

export interface ChainResolution {
  stage: ChainStage;
  chain: ServiceId[];
  available: ServiceId[];
  chosen: ServiceId | null;
  /** Green when verified by its own version command, amber when it is installed but could not be verified. */
  chosenStatus: "green" | "amber" | null;
  /** True when the chosen rung is not the preferred one, is unverified, or nothing is available. */
  degraded: boolean;
  reason: string;
}

/**
 * Resolve each stage to the rung that will actually run. Amber counts: a tool that is installed but does not report a
 * version is still the tool that will do the work — it is reported as unverified rather than silently skipped in
 * favour of a worse fallback. The reason is user-facing: the GUIDE requires the agent to say which path it will take
 * before work starts.
 */
export function resolveChains(states: ServiceState[]): ChainResolution[] {
  const byId = new Map(states.map((state) => [state.id, state]));

  return CHAIN_DEFINITIONS.map((definition) => {
    const usable = (id: ServiceId) => {
      const status = byId.get(id)?.status;
      return status === "green" || status === "amber";
    };
    const available = definition.services.filter(usable);
    const chosen = available[0] ?? null;
    const preferred = definition.services[0] ?? null;
    const chosenStatus = chosen ? (byId.get(chosen)?.status as "green" | "amber") : null;
    const unverified = chosenStatus === "amber";
    const degraded = chosen !== preferred || unverified;

    const label = (id: ServiceId) => {
      const state = byId.get(id);
      return state ? `${state.displayName}${state.version ? ` ${state.version}` : ""}` : id;
    };

    let reason: string;
    if (chosen === null) {
      reason = `no ${definition.stage} tool available — ${definition.fallbackNote}`;
    } else if (chosen === preferred) {
      reason = unverified
        ? `${label(chosen)} detected but did not report a version; using it unverified`
        : `${label(chosen)} detected`;
    } else {
      const missing = definition.services
        .slice(0, definition.services.indexOf(chosen))
        .map((id) => byId.get(id)?.displayName ?? id)
        .join(", ");
      reason = `${missing} unavailable; ${definition.stage} will use ${label(chosen)} — ${definition.fallbackNote}`;
    }

    return {
      stage: definition.stage,
      chain: definition.services,
      available,
      chosen,
      chosenStatus,
      degraded,
      reason,
    };
  });
}

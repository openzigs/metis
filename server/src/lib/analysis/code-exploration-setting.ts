/**
 * #2565 / #2566 — the platform key that picks the code pass's mode, and its
 * reader. Kept apart from `code-pass-variant.ts` so a caller that only needs
 * the setting (the project service, #2566) does not import the explore tools.
 */
import { CODE_PASS_MODES, type CodePassMode } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";

/** The platform key that picks the mode (`explore | fast`). */
export const CODE_EXPLORATION_KEY = "ANALYSIS_CODE_EXPLORATION";
/**
 * The platform default: `explore` since #2587, once #2568's pre-registered rule
 * held on all five conditions (eval-data/README.md, "Production explore (A21)").
 * `fast` stays the kill switch: set the key, or a project's own setting (#2566).
 */
export const DEFAULT_CODE_PASS_MODE: CodePassMode = "explore";

/** The platform key's mode; an unset or unknown value is the default. */
export function readCodeExplorationSetting(): CodePassMode {
  const raw = getConfigService().get(CODE_EXPLORATION_KEY)?.trim().toLowerCase();
  return (CODE_PASS_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as CodePassMode)
    : DEFAULT_CODE_PASS_MODE;
}

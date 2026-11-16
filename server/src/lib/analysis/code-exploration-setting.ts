/**
 * #2565 / #2566 — the platform key that picks the code pass's mode, and its
 * reader. Kept apart from `code-pass-variant.ts` so a caller that only needs
 * the setting (the project service, #2566) does not import the explore tools.
 */
import { CODE_PASS_MODES, type CodePassMode } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("code-exploration-setting");

/** The platform key that picks the mode (`explore | fast`). */
export const CODE_EXPLORATION_KEY = "ANALYSIS_CODE_EXPLORATION";
/**
 * The platform default: `explore` since #2587, once #2568's pre-registered rule
 * held on all five conditions (eval-data/README.md, "Production explore (A21)").
 * `fast` stays the kill switch: set the key, or a project's own setting (#2566).
 */
export const DEFAULT_CODE_PASS_MODE: CodePassMode = "explore";

/** The last unrecognised value warned about, so a bad value logs once, not per pass. */
let warnedValue: string | undefined;

/**
 * The platform key's mode. Unset or empty is the default (`explore`); a value
 * that is set but not a mode (a typo, `off`, `false`, `0`) is `fast`, the
 * cheaper mode, with one warning: since `explore` became the default (#2587),
 * an operator reaching for the kill switch must not get the dearer mode.
 */
export function readCodeExplorationSetting(): CodePassMode {
  const raw = getConfigService().get(CODE_EXPLORATION_KEY)?.trim().toLowerCase() ?? "";
  if (raw === "") return DEFAULT_CODE_PASS_MODE;
  if ((CODE_PASS_MODES as readonly string[]).includes(raw)) return raw as CodePassMode;
  if (warnedValue !== raw) {
    warnedValue = raw;
    // The key name only, never the value (ConfigService's logging contract).
    log.warn(`${CODE_EXPLORATION_KEY} is set but is not explore or fast; the code pass runs fast`, {
      key: CODE_EXPLORATION_KEY,
    });
  }
  return "fast";
}

/**
 * #1626 — an axe-core pass over a rendered component, in jsdom.
 *
 * `color-contrast` is off: jsdom does no layout or CSS, so axe cannot compute
 * it (the semantic tokens' contrast is asserted by `contrast-tokens.test.ts`).
 * `region` is off because a component is rendered without the app's landmarks.
 */
import axe from "axe-core";

export async function axeViolations(container: Element): Promise<string[]> {
  const result = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

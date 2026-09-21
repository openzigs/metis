import { chromium } from "@playwright/test";
const PROJECT_ID = "cmoojsgfw0001whnavmxth03w";
const BASE = "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();

await page.goto(BASE + "/login");
await page.fill('input[name="username"]', "admin");
await page.fill('input[name="password"]', "password");
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
await page.goto(BASE + "/projects/" + PROJECT_ID + "/documentation", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.getByText("Business Requirements", { exact: false }).first().click();
await page.waitForSelector('[data-testid="markdown-content"]', { timeout: 15000 });
await page.waitForTimeout(5000);

// Verify TOC links match heading IDs
const tocResult = await page.evaluate(() => {
  const toc = document.querySelector('[data-testid="markdown-toc"]');
  const content = document.querySelector('[data-testid="markdown-content"]');
  if (!toc || !content) return { error: "missing elements" };

  const links = Array.from(toc.querySelectorAll("a[href^='#']"));
  const results = [];
  let pass = 0;
  let fail = 0;
  for (const link of links) {
    const href = link.getAttribute("href");
    const id = href?.replace("#", "");
    const target = id ? content.querySelector(`#${CSS.escape(id)}`) : null;
    const label = link.textContent?.trim().substring(0, 40) || "";
    if (target) {
      pass++;
    } else {
      fail++;
      results.push({ label, href, found: false });
    }
  }
  return { totalLinks: links.length, pass, fail, failures: results.slice(0, 5) };
});

console.log("=== TOC VERIFICATION ===");
console.log(JSON.stringify(tocResult, null, 2));
await browser.close();

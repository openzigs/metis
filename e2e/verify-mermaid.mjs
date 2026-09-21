import { chromium } from "@playwright/test";
const PROJECT_ID = "cmoojsgfw0001whnavmxth03w";
const BASE = "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(BASE + "/login");
await page.fill('input[name="username"]', "admin");
await page.fill('input[name="password"]', "password");
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
await page.goto(BASE + "/projects/" + PROJECT_ID + "/documentation", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.getByText("Architecture", { exact: false }).first().click();
await page.waitForSelector('[data-testid="markdown-content"]', { timeout: 15000 });
await page.waitForTimeout(4000);

const diag = await page.evaluate(() => ({
  langMermaid: document.querySelectorAll("code.language-mermaid").length,
  rendered: document.querySelectorAll(".mermaid-rendered").length,
  errors: document.querySelectorAll(".mermaid-error").length,
  svgs: document.querySelectorAll(".mermaid-rendered svg").length,
}));
console.log("MERMAID:", JSON.stringify(diag));
if (errors.length) console.log("PAGE ERRORS:", errors.join("\n"));

const el = await page.$(".mermaid-rendered svg");
if (el) {
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
}
await page.screenshot({ path: "/tmp/mermaid-final.png", fullPage: false });
console.log("Screenshot: /tmp/mermaid-final.png");
await browser.close();

import { chromium } from "@playwright/test";
const PROJECT_ID = "cmoojsgfw0001whnavmxth03w";
const BASE = "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warn") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(err.message));
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

// Check for mermaid code blocks in DOM
const mermaidBlocks = await page.evaluate(() => {
  const content = document.querySelector('[data-testid="markdown-content"]');
  const codeEls = content?.querySelectorAll("code.language-mermaid") ?? [];
  const renderedEls = content?.querySelectorAll(".mermaid-rendered") ?? [];
  const svgs = content?.querySelectorAll("svg") ?? [];
  return { codeBlocks: codeEls.length, rendered: renderedEls.length, svgs: svgs.length };
});

console.log("Mermaid status:", JSON.stringify(mermaidBlocks));
const mermaidErrors = errors.filter((e) => e.includes("mermaid") || e.includes("Mermaid"));
if (mermaidErrors.length > 0) console.log("Mermaid errors:", mermaidErrors.join("\n"));
else console.log("No mermaid-specific errors");

// Check light mode text
const textColors = await page.evaluate(() => {
  const content = document.querySelector('[data-testid="markdown-content"]');
  const p = content?.querySelector("p");
  const h2 = content?.querySelector("h2");
  return {
    pColor: p ? getComputedStyle(p).color : "n/a",
    h2Color: h2 ? getComputedStyle(h2).color : "n/a",
    isDark: document.documentElement.classList.contains("dark"),
  };
});
console.log("Text colors:", JSON.stringify(textColors));
await browser.close();

import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "public/index.html",
  "public/app.js",
  "public/styles.css",
  "functions/api/metrics.js",
  "wrangler.toml"
];

await Promise.all(requiredFiles.map((file) => access(file)));

const html = await readFile("public/index.html", "utf8");
const app = await readFile("public/app.js", "utf8");
const api = await readFile("functions/api/metrics.js", "utf8");

const checks = [
  [html.includes("/app.js"), "index.html must load the browser app"],
  [app.includes("/api/metrics"), "app.js must load metrics from /api/metrics"],
  [app.includes("refreshMetrics"), "app.js must define the refresh loop"],
  [api.includes("BALANCE_OF_SELECTOR"), "metrics API must query ERC-20 balanceOf"]
];

const failed = checks.filter(([ok]) => !ok).map(([, message]) => message);

if (failed.length) {
  console.error(failed.join("\n"));
  process.exit(1);
}

console.log("Build check passed.");

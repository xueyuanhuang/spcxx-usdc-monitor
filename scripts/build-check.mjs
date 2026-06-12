import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "public/index.html",
  "public/app.js",
  "public/styles.css",
  "public/assets/wechat-group-qr.jpg",
  "functions/api/metrics.js",
  "functions/api/token.js",
  "wrangler.toml"
];

await Promise.all(requiredFiles.map((file) => access(file)));

const html = await readFile("public/index.html", "utf8");
const app = await readFile("public/app.js", "utf8");
const api = await readFile("functions/api/metrics.js", "utf8");
const tokenApi = await readFile("functions/api/token.js", "utf8");

const checks = [
  [html.includes("/app.js"), "index.html must load the browser app"],
  [html.includes("twitter.com/intent/follow"), "index.html must include the X follow intent"],
  [html.includes("/assets/wechat-group-qr.jpg"), "index.html must include the WeChat group QR asset"],
  [app.includes("/api/metrics"), "app.js must load metrics from /api/metrics"],
  [app.includes("/api/token"), "app.js must load token metrics from /api/token"],
  [app.includes("refreshMetrics"), "app.js must define the refresh loop"],
  [api.includes("BALANCE_OF_SELECTOR"), "metrics API must query ERC-20 balanceOf"],
  [api.includes("storeSupabaseMetric"), "metrics API must support Supabase persistence"],
  [tokenApi.includes("DEFAULT_TOKEN_CONTRACT"), "token API must define the SPCXx token contract"],
  [tokenApi.includes("storeSupabaseTokenMetric"), "token API must support Supabase persistence"]
];

const failed = checks.filter(([ok]) => !ok).map(([, message]) => message);

if (failed.length) {
  console.error(failed.join("\n"));
  process.exit(1);
}

console.log("Build check passed.");

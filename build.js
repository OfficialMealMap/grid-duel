// Bundles the game into dist/ for the server to serve.
import { build } from "esbuild";
import fs from "node:fs";
import crypto from "node:crypto";

fs.mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["client/main.jsx"],
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["es2019"],
  outfile: "dist/app.js",
  loader: { ".jsx": "jsx", ".js": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
});
// Stamp the script address with a fingerprint of this build, so browsers
// fetch the new game as soon as it is deployed instead of reusing an old copy.
const stamp = crypto.createHash("sha256").update(fs.readFileSync("dist/app.js")).digest("hex").slice(0, 10);
const html = fs.readFileSync("client/index.html", "utf8").replace('src="/app.js"', `src="/app.js?v=${stamp}"`);
fs.writeFileSync("dist/index.html", html);
console.log("Built dist/");

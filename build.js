// Bundles the game into dist/ for the server to serve.
import { build } from "esbuild";
import fs from "node:fs";

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
fs.copyFileSync("client/index.html", "dist/index.html");
console.log("Built dist/");

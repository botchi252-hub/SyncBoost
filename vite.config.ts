import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [preact(), cloudflare()],
  build: { target: "es2022", cssMinify: true },
});

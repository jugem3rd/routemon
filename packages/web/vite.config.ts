import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// devではRoutemon本体(既定8080)へproxyする。本番はbuild成果物を本体が配信する(#12)。
const target = process.env.ROUTEMON_API ?? "http://127.0.0.1:8080";

export default defineConfig({
	plugins: [react()],
	server: { proxy: { "/api": { target, changeOrigin: true } } },
	build: { outDir: "dist" },
});

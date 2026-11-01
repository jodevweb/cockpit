import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri sert le front en dev via ce serveur ; le port est figé pour que
// `tauri.conf.json` puisse le cibler sans négociation.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	clearScreen: false,
	server: {
		port: 5273,
		strictPort: true,
		watch: { ignored: ["**/src-tauri/**"] },
	},
	build: {
		target: "safari15",
		minify: "esbuild",
		sourcemap: false,
	},
	resolve: {
		alias: { "@": new URL("./src", import.meta.url).pathname },
	},
});

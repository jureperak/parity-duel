import { defineConfig } from "vite";

// Relative asset paths so the build works at any sub-path (e.g. GitHub Pages /teams-even-odd/).
export default defineConfig({
  base: "./",
});

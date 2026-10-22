// Plain Vite config: TanStack Start SSR, built as a Node server by Nitro (`node .output/server/index.mjs`).
// src/server.ts is the server entry (SSR error wrapper around TanStack's server-entry).
import path from "node:path";
import { nitro } from "nitro/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

const entitiesRoot = path.resolve(import.meta.dirname, "node_modules/entities");

export default defineConfig({
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      importProtection: {
        behavior: "error",
        client: {
          files: ["**/server/**"],
          specifiers: ["server-only"],
        },
      },
      server: { entry: "server" },
    }),
    viteReact(),
    tailwindcss(),
    nitro({ preset: "node-server" }),
  ],
  resolve: {
    alias: {
      "entities/lib/decode.js": path.join(entitiesRoot, "lib/decode.js"),
      "entities/lib/encode.js": path.join(entitiesRoot, "lib/encode.js"),
      entities: entitiesRoot,
    },
    dedupe: ["react", "react-dom"],
  },
});

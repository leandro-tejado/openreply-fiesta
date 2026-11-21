import { defineConfig } from "vitest/config";
import path from "path";

// En la notebook la suite se topa en 2 workers para no comerse la RAM; en la nube
// (CLAUDE_CODE_REMOTE) la VM tiene 16 GB y corre sin tope.
const enLaNube = process.env.CLAUDE_CODE_REMOTE === "true";

export default defineConfig({
  test: {
    ...(enLaNube ? {} : { maxWorkers: 2 }),
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});

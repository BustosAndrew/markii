import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    /**
     * Integration tests assert against **JSON that has crossed the wire**, where
     * the response is genuinely untyped until something checks it — that is the
     * point of the test. Mirroring every response shape into a type would make
     * the tests agree with the code by construction, which is exactly the
     * property that stops them catching a wrong shape.
     *
     * Application code keeps the rule; this narrow relaxation is what lets the
     * tests inspect a payload the way a client actually receives one.
     */
    files: ["tests/**/*.ts", "lib/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;

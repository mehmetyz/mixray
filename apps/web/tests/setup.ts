// Lets `node --test` run the app's own modules as they are: Next resolves `@/` paths and extensionless
// imports at build time, and Node's type stripping does neither.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_ROOT = path.join(WEB_ROOT, "..", "..", "schema");

function sourceUrl(base: string): string | null {
  const found = [base, `${base}.ts`, `${base}.tsx`].find((file) => path.extname(file) !== "" && existsSync(file));
  return found === undefined ? null : pathToFileURL(found).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@schema/")) {
      return {
        url: pathToFileURL(path.join(SCHEMA_ROOT, specifier.slice("@schema/".length))).href,
        importAttributes: { type: "json" },
        shortCircuit: true,
      };
    }
    if (specifier === "ajv/dist/2020") return nextResolve("ajv/dist/2020.js", context);

    const fromApp = specifier.startsWith("@/") ? path.join(WEB_ROOT, specifier.slice(2)) : null;
    const fromFile =
      specifier.startsWith(".") && context.parentURL?.startsWith("file:") === true
        ? path.join(path.dirname(fileURLToPath(context.parentURL)), specifier)
        : null;
    const url = sourceUrl(fromApp ?? fromFile ?? "");
    return url === null ? nextResolve(specifier, context) : { url, shortCircuit: true };
  },
});

#!/usr/bin/env node
/**
 * Post-build patch: Enable custom model picker for third-party providers
 *
 * The Codex Desktop model picker is blocked by three mechanisms:
 * 1. Auth gate: Model picker UI only renders when authMethod === "chatgpt"
 *    API-key / custom-provider users never see the picker dropdown.
 * 2. Feature gate: gate `770526561` (remote_models) controls whether
 *    custom/remote model providers are recognized as valid.
 * 3. Allowlist filter: The frontend filters the model list to only include
 *    models from the OpenAI allowlist, removing custom provider models.
 *
 * This patch:
 * Rule 1 — Remove authMethod gate for model picker rendering
 *   AST match: BinaryExpression `X.authMethod !== "chatgpt"` inside
 *   functions that also reference model-related strings (modelId, model_picker, etc.)
 *   Replace with !1 (always false = auth gate removed, picker always visible)
 *
 * Rule 2 — Bypass remote_models gate (770526561)
 *   AST match: CallExpression `identifier("770526561")` anywhere
 *   Replace with !0 (always true = remote/custom models enabled)
 *
 * Rule 3 — Remove model allowlist filter
 *   AST match: .filter() calls on model arrays that contain an
 *   .includes() check (allowlist pattern) inside model picker functions
 *   Replace filter callback with ()=>!0 (all models pass)
 *
 * Note: Dynamic Config gate `107580212` (model_catalog) is NOT bypassed
 * because it returns a JSON object, not a boolean. Replacing it with !0
 * would break the model catalog data structure. Instead, the allowlist
 * filter removal (Rule 3) ensures custom models appear alongside
 * OpenAI models from the catalog.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked;
  return null;
}

// ── Rule 1: Remove authMethod gate for model picker ──
// Same pattern as patch-fast-mode.js, but targeting model picker functions.

const MODEL_STRINGS = [
  "model_picker", "modelPicker", "ModelPicker",
  "modelId", "model_id", "selectedModel",
  "modelSelect", "modelDropdown", "model_catalog",
  "availableModels", "available_models",
];

function findModelAuthPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match function bodies containing both authMethod and model references
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!fnSrc.includes("authMethod")) return;

    // Must contain at least one model-related string
    let hasModelContext = false;
    for (const ms of MODEL_STRINGS) {
      if (fnSrc.includes(ms)) {
        hasModelContext = true;
        break;
      }
    }
    if (!hasModelContext) return;

    // Inside this function, find: X.authMethod !== "chatgpt"
    walk(node, (child) => {
      if (child.type !== "BinaryExpression" || child.operator !== "!==") return;

      const childSrc = source.slice(child.start, child.end);
      if (!childSrc.includes("authMethod") || !childSrc.includes("chatgpt"))
        return;

      if (childSrc === "!1") return;

      // Avoid duplicate patches at same offset
      if (patches.some((p) => p.start === child.start)) return;

      patches.push({
        id: "model_picker_auth_gate",
        start: child.start,
        end: child.end,
        replacement: "!1",
        original: childSrc,
      });
    });
  });

  return patches;
}

// ── Rule 2: Bypass remote_models gate ──
// gate 770526561 → remote_models (Feature Gate, returns boolean)
// Replace the call with !0 (always enabled)

const REMOTE_MODELS_GATE_ID = "770526561";

function findRemoteModelsGatePatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "Identifier") return;
    if (node.arguments?.length !== 1) return;

    const argVal = getLiteralValue(node.arguments[0]);
    if (argVal !== REMOTE_MODELS_GATE_ID) return;

    const expr = source.slice(node.start, node.end);
    if (expr === "!0") return;

    patches.push({
      id: "remote_models_gate",
      start: node.start,
      end: node.end,
      replacement: "!0",
      original: expr,
    });
  });

  return patches;
}

// ── Rule 3: Remove model allowlist filter ──
// Find .filter() calls in model picker context where the callback
// contains an .includes() check (the allowlist pattern), and replace
// the entire filter callback with ()=>!0.

function findModelFilterPatches(ast, source) {
  const patches = [];

  // Step 1: Find functions that contain model-related context
  const modelFunctions = [];
  walk(ast, (node) => {
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    let hasModelContext = false;
    for (const ms of MODEL_STRINGS) {
      if (fnSrc.includes(ms)) {
        hasModelContext = true;
        break;
      }
    }
    // Also match if function contains "model_catalog" or model list patterns
    if (
      fnSrc.includes("model_catalog") ||
      fnSrc.includes("modelCatalog") ||
      fnSrc.includes("models") && fnSrc.includes("filter")
    ) {
      hasModelContext = true;
    }

    if (hasModelContext) modelFunctions.push(node);
  });

  // Step 2: In model functions, find .filter() calls with .includes() callback
  for (const fn of modelFunctions) {
    walk(fn, (node) => {
      if (node.type !== "CallExpression") return;
      if (node.callee?.type !== "MemberExpression") return;
      if (node.callee.property?.name !== "filter" && node.callee.property?.value !== "filter")
        return;
      if (node.arguments?.length !== 1) return;

      const cb = node.arguments[0];
      const cbSrc = source.slice(cb.start, cb.end);

      // Must contain .includes() — this is the allowlist pattern
      // In minified code: X.includes(Y) or similar
      if (!cbSrc.includes("includes")) return;

      // Skip already-patched callbacks
      if (cbSrc === "()=>!0") return;

      // The filter is on a model array, and the callback checks if
      // a model ID is in an allowlist via .includes().
      // Replace with ()=>!0 to pass all models through.

      patches.push({
        id: "model_allowlist_filter_bypass",
        start: cb.start,
        end: cb.end,
        replacement: "()=>!0",
        original: cbSrc.slice(0, 60) + (cbSrc.length > 60 ? "..." : ""),
      });
    });
  }

  // Step 3: Also look for standalone filter patterns in model-related chunks
  // Pattern: array.filter(callback) where the callback checks model validity
  // and the array variable name contains "model" or "Model"
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "MemberExpression") return;
    if (node.callee.property?.name !== "filter") return;
    if (node.arguments?.length !== 1) return;

    // Check the object being filtered — does its source contain model references?
    const objSrc = source.slice(node.callee.object.start, node.callee.object.end);
    if (!objSrc.includes("model") && !objSrc.includes("Model")) return;

    const cb = node.arguments[0];
    const cbSrc = source.slice(cb.start, cb.end);
    if (!cbSrc.includes("includes")) return;
    if (cbSrc === "()=>!0") return;

    // Avoid duplicate patches at same offset
    if (patches.some((p) => p.start === cb.start)) return;

    patches.push({
      id: "model_allowlist_filter_bypass",
      start: cb.start,
      end: cb.end,
      replacement: "()=>!0",
      original: cbSrc.slice(0, 60) + (cbSrc.length > 60 ? "..." : ""),
    });
  });

  return patches;
}

// ── Target location ──

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];

  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;

    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");

      const rules = [];

      // Rule 1: authMethod + model context
      if (src.includes("authMethod") && (src.includes("modelId") || src.includes("model_picker") || src.includes("ModelPicker") || src.includes("model_catalog"))) {
        rules.push("auth");
      }

      // Rule 2: remote_models gate
      if (src.includes("770526561")) {
        rules.push("gate");
      }

      // Rule 3: model filter with includes
      if (src.includes("model") && src.includes("filter") && src.includes("includes")) {
        rules.push("filter");
      }

      if (rules.length > 0) {
        targets.push({ platform: plat, path: fp, rules });
      }
    }

    // Also check main process build dir for gate calls
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (fs.existsSync(buildDir)) {
      for (const f of fs.readdirSync(buildDir)) {
        if (!f.endsWith(".js")) continue;
        const fp = path.join(buildDir, f);
        const src = fs.readFileSync(fp, "utf-8");
        if (src.includes("770526561")) {
          targets.push({ platform: plat, path: fp, rules: ["gate"] });
        }
      }
    }
  }

  return targets;
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[skip] No model-picker targets found (bundles not yet built)");
    return;
  }

  // Deduplicate targets by path, merging rules
  const seen = new Map();
  for (const t of targets) {
    if (seen.has(t.path)) {
      const existing = seen.get(t.path);
      for (const r of t.rules) {
        if (!existing.rules.includes(r)) existing.rules.push(r);
      }
    } else {
      seen.set(t.path, t);
    }
  }
  const unique = [...seen.values()];

  let totalPatched = 0;

  for (const bundle of unique) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024).toFixed(1)} KB`);

    const t0 = Date.now();
    let ast;
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch (e) {
      console.log(`   [skip] Parse error: ${e.message}`);
      continue;
    }
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = [];
    if (bundle.rules.includes("auth"))
      patches.push(...findModelAuthPatches(ast, source));
    if (bundle.rules.includes("gate"))
      patches.push(...findRemoteModelsGatePatches(ast, source));
    if (bundle.rules.includes("filter"))
      patches.push(...findModelFilterPatches(ast, source));

    if (patches.length === 0) {
      console.log("   [ok] Already patched or no match");
      continue;
    }

    if (isCheck) {
      for (const p of patches)
        console.log(`   [?] [${p.id}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      continue;
    }

    patches.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of patches) {
      console.log(`   * [${p.id}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    totalPatched += patches.length;
    console.log(`   [ok] ${patches.length} patches applied`);
  }

  if (totalPatched > 0) {
    console.log(`\n[ok] ${totalPatched} model-picker patches applied total`);
  } else if (!isCheck) {
    console.log("\n[ok] Model picker already patched or no targets matched");
  }
}

main();
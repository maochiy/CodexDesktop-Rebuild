#!/usr/bin/env node
/**
 * Post-build patch: Enable custom model picker for third-party providers
 *
 * The Codex Desktop model picker is blocked by three mechanisms:
 * 1. Auth gate: Model picker UI only renders when authMethod === "chatgpt"
 *    In the minified code, authMethod is destructured from Gc() then
 *    checked as `r!==`chatgpt`` — if not chatgpt, returns null (no picker).
 * 2. Allowlist filter: `shouldUseAvailabilityAllowlist` forces only OpenAI
 *    catalog models to appear; custom models from config.toml are excluded.
 * 3. Hidden filter: `!e.hidden` excludes "hidden" models from the list.
 *
 * This patch:
 * Rule 1 — Remove authMethod gate for model picker rendering
 *   Match: BinaryExpression `X !== "chatgpt"` (Literal or TemplateLiteral)
 *   inside functions that reference `authMethod` (destructured or dotted).
 *   Replace with !1 (always false = auth gate never triggers)
 *   Effect: `if(r!==`chatgpt`)return null` → `if(!1)return null` → never null
 *
 * Rule 2 — Force shouldUseAvailabilityAllowlist to false
 *   Match: LogicalExpression `X.useHiddenModels && Y !== `amazonBedrock``
 *   inside model-queries chunks.
 *   Replace with !1 (always false = allowlist never applied)
 *   Effect: filter `d?a.has(e.model):!e.hidden` always uses `!e.hidden` branch
 *
 * Rule 3 — Force !e.hidden to !0 inside model forEach callbacks
 *   Match: UnaryExpression `!X.hidden` in chunks with `availableModels`
 *   Replace with !0 (always true = show ALL models including "hidden" ones)
 *
 * Note: Statsig gate `770526561` (remote_models) is NOT explicitly checked
 * via ec() in the webview code — it only appears in a config mapping.
 * The allowlist bypass (Rule 2) + hidden bypass (Rule 3) ensure custom
 * models appear regardless of this gate's server-side value.
 *
 * Note: Dynamic Config `107580212` (model_catalog) is NOT bypassed because
 * it returns a JSON object. Rules 2+3 ensure custom models from config.toml
 * appear alongside OpenAI models from the catalog.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor, node);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
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

// ── Rule 1: Remove authMethod !== "chatgpt" component gating ──
// Target pattern: if(authMethod!==`chatgpt`)return null
// This is a React component gate — renders nothing when auth isn't chatgpt.
// Only patch when the !== check is the test of an if-return-null pattern,
// not other authMethod !== chatgpt checks (cloud access, fast mode, etc.)

function isIfReturnNull(exprNode, parentNode, source) {
  // Check: exprNode is the test of an IfStatement whose consequent
  // is a ReturnStatement returning null
  if (!parentNode || parentNode.type !== "IfStatement") return false;
  if (parentNode.test !== exprNode) return false;
  const cons = parentNode.consequent;
  if (cons.type === "ReturnStatement") {
    const arg = cons.argument;
    if (arg?.type === "Literal" && arg.value === null) return true;
    if (arg === null) return true; // bare `return;`
  }
  // Also handle: if(X!==`chatgpt`)return null — consequent might be
  // a BlockStatement containing a ReturnStatement
  if (cons.type === "BlockStatement" && cons.body.length === 1) {
    const stmt = cons.body[0];
    if (stmt.type === "ReturnStatement") {
      const arg = stmt.argument;
      if (arg?.type === "Literal" && arg.value === null) return true;
      if (arg === null) return true;
    }
  }
  return false;
}

function findModelAuthPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!fnSrc.includes("authMethod")) return;

    walk(node, (child, parent) => {
      if (child.type !== "BinaryExpression" || child.operator !== "!==") return;

      const rightVal = getLiteralValue(child.right);
      if (rightVal !== "chatgpt") return;

      if (!isIfReturnNull(child, parent, source)) return;

      const childSrc = source.slice(child.start, child.end);
      if (childSrc === "!1") return;
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

// ── Rule 2: Force shouldUseAvailabilityAllowlist to false ──
// Match: X.useHiddenModels && Y !== `amazonBedrock`
// This controls whether the model allowlist is applied.
// Replace with !1 so allowlist is never used.

function findAllowlistTogglePatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "LogicalExpression" || node.operator !== "&&") return;

    const exprSrc = source.slice(node.start, node.end);

    // Must contain useHiddenModels on the left side
    if (!exprSrc.includes("useHiddenModels")) return;
    // Must contain amazonBedrock on the right side
    if (!exprSrc.includes("amazonBedrock")) return;

    // Already patched
    if (exprSrc === "!1") return;

    // Avoid duplicate
    if (patches.some((p) => p.start === node.start)) return;

    patches.push({
      id: "allowlist_toggle_off",
      start: node.start,
      end: node.end,
      replacement: "!1",
      original: exprSrc,
    });
  });

  return patches;
}

// ── Rule 3: Force !e.hidden to !0 in model forEach ──
// In the model listing forEach callback: `if(d?a.has(e.model):!e.hidden)`
// When Rule 2 makes d=!1, the condition becomes `if(!1?a.has(e.model):!e.hidden)`
// which simplifies to `if(!e.hidden)`. We force !e.hidden → !0 to show ALL models.

function findHiddenModelPatches(ast, source) {
  const patches = [];

  // Only target chunks that contain the model catalog pattern
  if (!source.includes("availableModels") && !source.includes("useHiddenModels")) return [];

  walk(ast, (node) => {
    // Match: !X.hidden or !X[Y].hidden
    if (node.type !== "UnaryExpression" || node.operator !== "!") return;

    const exprSrc = source.slice(node.start, node.end);

    // Must be !X.hidden pattern
    if (!exprSrc.includes(".hidden")) return;

    // Already patched
    if (exprSrc === "!0") return;

    // Avoid duplicate
    if (patches.some((p) => p.start === node.start)) return;

    patches.push({
      id: "hidden_model_show",
      start: node.start,
      end: node.end,
      replacement: "!0",
      original: exprSrc,
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

      // Rule 1: authMethod + !== "chatgpt" pattern
      // Match files where authMethod is used with a !== "chatgpt" check
      if (src.includes("authMethod") && src.includes("chatgpt")) {
        // Verify there's a !== pattern (not just ===)
        // Check for !==`chatgpt` or !=="chatgpt" or !== 'chatgpt'
        if (src.includes("!==`chatgpt`") || src.includes('!=="chatgpt"') || src.includes("!== 'chatgpt'")) {
          rules.push("auth");
        }
      }

      // Rule 2: allowlist toggle (useHiddenModels pattern)
      if (src.includes("useHiddenModels") && src.includes("amazonBedrock")) {
        rules.push("allowlist");
      }

      // Rule 3: hidden model bypass
      if (src.includes("availableModels") && src.includes(".hidden")) {
        rules.push("hidden");
      }

      if (rules.length > 0) {
        targets.push({ platform: plat, path: fp, rules });
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
    if (bundle.rules.includes("allowlist"))
      patches.push(...findAllowlistTogglePatches(ast, source));
    if (bundle.rules.includes("hidden"))
      patches.push(...findHiddenModelPatches(ast, source));

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
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = __dirname;
const artifacts = ["main.js", "manifest.json", "styles.css", "defaults.json"];
const styleSources = [
  "shared-ui.css",
  "home.css",
  "dataview-tables.css",
  "gamification.css",
  "activities.css",
  "reminders.css",
  "task-view.css",
  "three-column-grid-list.css",
  "wide-page.css",
  "outline.css",
];

function fail(message) {
  console.error(`Verification failed: ${message}`);
  process.exit(1);
}

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  } catch (error) {
    fail(`${name} is missing or invalid JSON: ${error.message}`);
  }
}

function runNpm(script) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail("npm_execpath is unavailable; run verification through npm run verify");
  const result = spawnSync(process.execPath, [npmCli, "run", script], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) fail(`could not run npm run ${script}: ${result.error.message}`);
  if (result.status !== 0) fail(`npm run ${script} exited with code ${result.status}`);
}

const packageJson = readJson("package.json");
const requiredScripts = ["build", "typecheck", "test", "install-plugin", "verify"];
for (const script of requiredScripts) {
  if (typeof packageJson.scripts?.[script] !== "string" || !packageJson.scripts[script].trim()) {
    fail(`package.json script '${script}' is required`);
  }
}
for (const scriptFile of ["build-bundle.js", "copy-plugin.js", "verify-plugin.js"]) {
  if (!fs.existsSync(path.join(root, scriptFile))) fail(`required script file is missing: ${scriptFile}`);
}

runNpm("typecheck");
runNpm("test");
runNpm("build");

const manifest = readJson("manifest.json");
const defaults = readJson("defaults.json");
const lock = readJson("package-lock.json");
if (!manifest.id || !manifest.name || !manifest.version || !manifest.minAppVersion) {
  fail("manifest.json is missing required id/name/version/minAppVersion fields");
}
if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) fail("defaults.json must contain an object");
if (packageJson.version !== manifest.version || packageJson.version !== lock.version || packageJson.version !== lock.packages?.[""]?.version) {
  fail("versions in package.json, package-lock.json, and manifest.json must match");
}
for (const name of artifacts) {
  const file = path.join(root, name);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) fail(`release artifact is missing or empty: ${name}`);
}
for (const name of styleSources) {
  if (!fs.existsSync(path.join(root, "styles", name))) fail(`required style source is missing: styles/${name}`);
}
const expectedStyles = styleSources
  .map((name) => fs.readFileSync(path.join(root, "styles", name), "utf8"))
  .join("\n") + "\n";
if (fs.readFileSync(path.join(root, "styles.css"), "utf8") !== expectedStyles) {
  fail("styles.css does not match the required style sources");
}
const bundle = fs.readFileSync(path.join(root, "main.js"), "utf8");
if (!bundle.includes("ObsidianProjectAutomationPlugin") || !bundle.includes("main_default") || !bundle.includes('require("obsidian")')) {
  fail("main.js does not appear to contain a complete Obsidian plugin bundle");
}

console.log(`Verification passed for ${manifest.id} ${manifest.version}: ${artifacts.join(", ")}`);

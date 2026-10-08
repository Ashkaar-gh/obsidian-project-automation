const fs = require("fs");
const path = require("path");

const root = __dirname;
const artifacts = ["main.js", "manifest.json", "styles.css", "defaults.json"];
const vaultPath = process.argv[2] || process.env.OBSIDIAN_VAULT_PATH;

if (!vaultPath) {
  console.error("Usage: npm run install-plugin -- <vault-path> (or set OBSIDIAN_VAULT_PATH)");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const destination = path.join(path.resolve(vaultPath), ".obsidian", "plugins", manifest.id);
const missing = artifacts.filter((name) => !fs.existsSync(path.join(root, name)));
if (missing.length > 0) {
  console.error(`Missing release artifacts: ${missing.join(", ")}. Run npm run build first.`);
  process.exit(1);
}

fs.mkdirSync(destination, { recursive: true });
for (const name of artifacts) {
  fs.copyFileSync(path.join(root, name), path.join(destination, name));
}
console.log(`Copied ${artifacts.join(", ")} to ${destination}`);

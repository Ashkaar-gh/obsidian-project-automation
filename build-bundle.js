/**
 * Сборка плагина в один main.js (без require к core/modules/ui).
 * Требует: npm install (чтобы был esbuild).
 * После сборки удаляются неиспользуемые папки core/, modules/, ui/ в корне проекта.
 */

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const root = __dirname;
const stylesOrder = [
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

function rmDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) rmDir(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

esbuild
  .build({
    entryPoints: [path.join(root, "src", "main.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["obsidian"],
    outfile: path.join(root, "main.js"),
    sourcemap: false,
    minify: false,
    target: "node18",
  })
  .then(() => {
    for (const d of ["core", "modules", "ui"]) {
      const full = path.join(root, d);
      if (fs.existsSync(full)) {
        rmDir(full);
        console.log("  Удалена неиспользуемая папка", d + "/");
      }
    }
    const stylesDir = path.join(root, "styles");
    const missingStyles = stylesOrder.filter((name) => !fs.existsSync(path.join(stylesDir, name)));
    if (missingStyles.length > 0) {
      throw new Error(`Missing required style sources: ${missingStyles.join(", ")}`);
    }
    const styles = stylesOrder
      .map((name) => fs.readFileSync(path.join(stylesDir, name), "utf8"))
      .join("\n") + "\n";
    fs.writeFileSync(path.join(root, "styles.css"), styles);
    console.log("  Собран styles.css");
    console.log("Сборка завершена. Артефакты плагина: main.js, manifest.json, styles.css, defaults.json.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

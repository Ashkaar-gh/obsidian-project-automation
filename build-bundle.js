/**
 * Сборка плагина в один main.js (без require к core/modules/ui).
 * Требует: npm install (чтобы был esbuild).
 * После сборки удаляются неиспользуемые папки core/, modules/, ui/ в корне проекта.
 */

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const root = __dirname;

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
    const stylesOrder = [
      "shared-ui.css",
      "home.css",
      "dataview-tables.css",
      "gamification.css",
      "activities.css",
      "task-view.css",
      "three-column-grid-list.css",
      "wide-page.css",
    ];
    if (fs.existsSync(stylesDir)) {
      let out = "";
      for (const name of stylesOrder) {
        const f = path.join(stylesDir, name);
        if (fs.existsSync(f)) out += fs.readFileSync(f, "utf8") + "\n";
      }
      if (out) {
        fs.writeFileSync(path.join(root, "styles.css"), out);
        console.log("  Собран styles.css");
      }
    }
    console.log("Сборка завершена. В плагин копируйте main.js, manifest.json и styles.css.");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

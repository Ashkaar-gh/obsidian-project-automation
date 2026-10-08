const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "opa-tests-"));

/**
 * Тесты копирования и блока задачи используют DOM (jsdom). jsdom тянет ~60 пакетов,
 * поэтому в devDependencies его нет: `npm install` остаётся лёгким, а DOM-тесты запускаются
 * через `npm run test:dom` (jsdom ставится без записи в package.json). Без jsdom они пропускаются.
 */
function resolveJsdom() {
  if (process.env.OPA_SKIP_DOM_TESTS) return null;
  try {
    return require.resolve("jsdom");
  } catch {
    return null;
  }
}

const jsdomPath = resolveJsdom();
const allTestFiles = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => path.join(__dirname, name));
const needsDom = (file) => /from\s+["']jsdom["']/.test(fs.readFileSync(file, "utf8"));
const testFiles = jsdomPath ? allTestFiles : allTestFiles.filter((file) => !needsDom(file));
const skipped = allTestFiles.filter((file) => !testFiles.includes(file)).map((file) => path.basename(file));

async function run() {
  try {
    await esbuild.build({
      entryPoints: testFiles,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      outdir: outputDir,
      entryNames: "[name]",
      logLevel: "silent",
      plugins: [{
        name: "mock-obsidian",
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({
            path: path.join(__dirname, "mocks", "obsidian.ts"),
          }));
          // jsdom не бандлим: подключаем по абсолютному пути, чтобы require работал из временного каталога сборки.
          if (jsdomPath) {
            build.onResolve({ filter: /^jsdom$/ }, () => ({ path: jsdomPath, external: true }));
          }
        },
      }],
    });

    const outputFiles = fs.readdirSync(outputDir)
      .filter((name) => name.endsWith(".test.js"))
      .map((name) => path.join(outputDir, name));
    const result = spawnSync(process.execPath, ["--test", ...outputFiles], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (skipped.length > 0) {
      console.log(
        `\nDOM-тесты пропущены (jsdom не установлен): ${skipped.join(", ")}.\n` +
          "Запустить их: npm run test:dom"
      );
    }
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

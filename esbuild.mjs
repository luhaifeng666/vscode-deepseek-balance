import esbuild from "esbuild";

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const minify = args.includes("--minify");
const tests = args.includes("--tests");

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  // 扩展宿主在运行期提供 vscode 模块，绝不能打进产物。
  external: ["vscode"],
  logLevel: "info",
};

if (tests) {
  await esbuild.build({
    ...common,
    entryPoints: [
      "src/test/balance.test.ts",
      "src/test/client.test.ts",
      "src/test/render.test.ts",
      "src/test/integration.test.ts",
    ],
    outdir: "out-test",
    sourcemap: false,
  });
} else {
  const ctx = await esbuild.context({
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    minify,
    sourcemap: !minify,
    plugins: watch
      ? [
          {
            name: "watch-notifier",
            setup(build) {
              build.onStart(() => console.log("[watch] build started"));
              build.onEnd((result) => {
                if (result.errors.length > 0) {
                  console.error("[watch] build failed");
                } else {
                  console.log("[watch] build finished");
                }
              });
            },
          },
        ]
      : [],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

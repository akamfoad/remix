// Local fork of https://github.com/indooorsman/esbuild-css-modules-plugin
import path from "path";
import { readFile } from "fs-extra";
import lightningcss from "lightningcss";
import type { Plugin, PluginBuild, OnLoadResult } from "esbuild";

import type { CompileOptions } from "../options";

interface PluginOptions {
  pattern: string;
  appDirectory: string;
}

interface BuildContext {
  buildRoot: string;
  appDirectory: string;
  relative: (to: string) => string;
  cache: BuildCache;
}

interface Build extends PluginBuild {
  context: BuildContext;
}

export const pluginName = "css-modules-plugin";

const pluginNamespace = `${pluginName}-namespace`;
const buildingCssSuffix = `?${pluginName}-building`;
const builtCssSuffix = `?${pluginName}-built`;
const modulesCssRegExp = /\.module\.css$/;
const builtModulesCssRegExp = new RegExp(
  `.module.css${builtCssSuffix.replace("?", "\\?").replace(/-/g, "\\-")}$`,
  "i"
);

class BuildCache {
  cache: Map<string, { result: OnLoadResult; input: string }>;

  constructor() {
    this.cache = new Map();
  }

  async get(absPath: string): Promise<OnLoadResult | void> {
    let cachedData = this.cache.get(absPath);

    if (cachedData) {
      let input = await readFile(absPath, { encoding: "utf8" });

      if (input === cachedData.input) {
        return cachedData.result;
      }

      return;
    }
  }

  async set(
    absPath: string,
    result: OnLoadResult,
    originContent: string
  ): Promise<void> {
    let m = process.memoryUsage().rss;
    if (m / 1024 / 1024 > 250) {
      this.clear();
    }
    let input =
      originContent || (await readFile(absPath, { encoding: "utf8" }));
    this.cache.set(absPath, { input, result });
  }
  clear() {
    this.cache.clear();
  }
}

function getRootDir(build: Build): string {
  let { absWorkingDir } = build.initialOptions;
  let abs = absWorkingDir ? absWorkingDir : process.cwd();
  let rootDir = path.isAbsolute(abs) ? abs : path.resolve(process.cwd(), abs);
  return rootDir;
}

function getRelativePath(build: Build, to: string): string {
  if (!path.isAbsolute(to)) {
    return to.startsWith(".") ? to : `.${path.sep}${to}`;
  }
  let root = build.context?.buildRoot ?? getRootDir(build);
  return `.${path.sep}${path.relative(root, to)}`;
}

async function buildCssModulesJs({
  fullPath,
  options,
  build,
}: {
  fullPath: string;
  options: PluginOptions;
  build: Build;
}) {
  let cssFileName = path.basename(fullPath); // e.g. xxx.module.css?css-modules-plugin-building
  let { relative, appDirectory } = build.context;
  let resolveDir = path.dirname(fullPath);
  let originCss = await readFile(fullPath);

  let {
    code,
    exports = {},
    map,
  } = await lightningcss.bundleAsync({
    filename: relative(fullPath), // use relative path to keep hash stable in different machines
    minify: false,
    sourceMap: true,
    analyzeDependencies: false,
    cssModules: {
      pattern: options.pattern,
      dashedIdents: false,
    },
    resolver: {
      resolve(specifier, from) {
        return specifier.startsWith("~/")
          ? path.resolve(appDirectory, specifier.replace("~/", ""))
          : path.resolve(path.dirname(from), specifier);
      },
    },
  });

  let cssModulesExport: Record<string, string> = {};

  Object.keys(exports)
    .sort() // to keep order consistent in different builds
    .forEach((originClass) => {
      let { name, composes } = exports[originClass];

      cssModulesExport[originClass] =
        name +
        (composes.length
          ? " " + composes.map((composedClass) => composedClass.name).join(" ")
          : "");
    });

  let cssWithSourceMap = code.toString("utf-8");

  if (map) {
    cssWithSourceMap += `\n/*# sourceMappingURL=data:application/json;base64,${map.toString(
      "base64"
    )} */`;
  }

  // fix path issue on Windows: https://github.com/indooorsman/css-modules-plugin/issues/12
  let cssImportPath =
    "./" +
    cssFileName
      .split(path.sep)
      .join(path.posix.sep)
      .trim()
      .replace(buildingCssSuffix, "") +
    builtCssSuffix;

  // => ./xxx.module.css?css-modules-plugin-built
  let js = [
    `import "${cssImportPath}";`,
    `export default ${JSON.stringify(cssModulesExport)};`,
  ].join("\n");

  return {
    js,
    css: cssWithSourceMap,
    originCss: originCss.toString("utf8"),
    exports,
    resolveDir,
  };
}

async function setup(build: Build, options: PluginOptions): Promise<void> {
  build.context = {
    buildRoot: getRootDir(build),
    appDirectory: options.appDirectory,
    relative: (to) => getRelativePath(build, to),
    cache: new BuildCache(),
  };

  // resolve xxx.module.css to xxx.module.css?css-modules-plugin-building
  build.onResolve(
    { filter: modulesCssRegExp, namespace: "file" },
    async (args) => {
      let { resolve, context } = build;
      let { resolveDir, path: p, pluginData = {} } = args;
      let { relative } = context;
      let { path: absPath } = await resolve(p, { resolveDir });
      let relativePath = relative(absPath);

      return {
        namespace: pluginNamespace,
        suffix: buildingCssSuffix,
        path: relativePath,
        external: false,
        pluginData: {
          ...pluginData,
          relativePathToBuildRoot: relativePath,
        },
        sideEffects: true,
        pluginName,
      };
    }
  );

  // load xxx.module.css?css-modules-plugin-building
  build.onLoad(
    { filter: modulesCssRegExp, namespace: pluginNamespace },
    async (args) => {
      let { path: maybeFullPath, pluginData = {} } = args;
      let { buildRoot, cache } = build.context;
      let absPath = path.isAbsolute(maybeFullPath)
        ? maybeFullPath
        : path.resolve(buildRoot, maybeFullPath);

      let useCache = build.initialOptions.watch;

      let cached = useCache && (await cache.get(absPath));
      if (cached) {
        return cached;
      }

      let { js, resolveDir, css, exports, originCss } = await buildCssModulesJs(
        {
          fullPath: absPath,
          options,
          build,
        }
      );

      let result = {
        pluginName,
        resolveDir,
        loader: "js" as const,
        contents: js,
        pluginData: {
          ...pluginData,
          css,
          exports,
        },
      };

      if (useCache) {
        await cache.set(absPath, result, originCss);
      }

      return result;
    }
  );

  // resolve virtual path xxx.module.css?css-modules-plugin-built
  build.onResolve(
    { filter: builtModulesCssRegExp, namespace: pluginNamespace },
    async (args) => {
      let { pluginData = {} } = args;
      let { relativePathToBuildRoot } = pluginData;

      return {
        pluginName,
        namespace: pluginNamespace,
        path: relativePathToBuildRoot + builtCssSuffix,
        external: false,
        sideEffects: true,
        pluginData,
      };
    }
  );

  // load virtual path xxx.module.css?css-modules-plugin-built
  build.onLoad(
    { filter: builtModulesCssRegExp, namespace: pluginNamespace },
    async (args) => {
      let { pluginData } = args;
      let { buildRoot } = build.context;
      let { css, relativePathToBuildRoot } = pluginData;
      let absPath = path.resolve(buildRoot, relativePathToBuildRoot);
      let resolveDir = path.dirname(absPath);

      return {
        pluginName,
        pluginData,
        resolveDir,
        loader: "css" as const,
        contents: css,
      };
    }
  );
}

interface CssModulesPluginOptions {
  mode: CompileOptions["mode"];
  appDirectory: string;
}

export const cssModulesPlugin = ({
  mode,
  appDirectory,
}: CssModulesPluginOptions): Plugin => {
  return {
    name: pluginName,
    setup: async (build) => {
      await setup(build as Build, {
        pattern: mode === "production" ? "[hash]" : "[name]_[local]_[hash]",
        appDirectory,
      });
    },
  };
};
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname, resolve, sep, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Enhanced TypeScript resolver that handles both tsconfig paths and directory imports
// Based on pi's source-resolver but with additional support for index resolution

interface TsConfig {
	readonly compilerOptions?: {
		readonly paths?: Readonly<Record<string, readonly string[]>>;
	};
}

interface SourceAlias {
	readonly pattern: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly replacements: readonly string[];
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const piRoot = resolve(repositoryRoot, "pi");
const tsconfigPath = resolve(piRoot, "tsconfig.json");
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as TsConfig;
const paths = tsconfig.compilerOptions?.paths;
if (!paths) throw new Error(`Source runtime requires compilerOptions.paths in ${tsconfigPath}`);

const aliases: SourceAlias[] = Object.entries(paths)
	.filter(([pattern]) => pattern.startsWith("@earendil-works/"))
	.map(([pattern, replacements]) => {
		const wildcard = pattern.indexOf("*");
		if (wildcard !== -1 && pattern.indexOf("*", wildcard + 1) !== -1) {
			throw new Error(`Source runtime does not support multiple wildcards in ${pattern}`);
		}
		return {
			pattern,
			prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
			suffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
			replacements,
		};
	})
	.sort((left, right) => right.pattern.length - left.pattern.length);

registerHooks({
	resolve(specifier, context, nextResolve) {
		// Handle tsconfig path aliases (for pi packages)
		let matchedPattern: string | undefined;
		for (const alias of aliases) {
			const wildcard = matchAlias(alias, specifier);
			if (wildcard === undefined) continue;
			matchedPattern ??= alias.pattern;
			for (const replacement of alias.replacements) {
				const resolved = resolveSourcePath(replacement.replace("*", wildcard), piRoot);
				if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
			}
		}
		if (matchedPattern) {
			throw new Error(`Source runtime could not resolve ${specifier} through tsconfig path ${matchedPattern}`);
		}

		// Handle relative imports with directory resolution
		if (specifier.startsWith(".") && context.parentURL) {
			const parentPath = fileURLToPath(context.parentURL);
			const parentDir = dirname(parentPath);
			const resolved = resolveRelativeImport(specifier, parentDir);
			if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
		}

		return nextResolve(specifier, context);
	},
});

function matchAlias(alias: SourceAlias, specifier: string): string | undefined {
	if (!alias.pattern.includes("*")) return specifier === alias.pattern ? "" : undefined;
	if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return undefined;
	return specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
}

function resolveSourcePath(replacement: string, baseRoot: string): string | undefined {
	const basePath = resolve(baseRoot, replacement);
	const rootPrefix = baseRoot.endsWith(sep) ? baseRoot : `${baseRoot}${sep}`;
	if (!basePath.startsWith(rootPrefix)) return undefined;
	const extension = extname(basePath);
	const sourceExtension =
		extension === ".js" ? ".ts" : extension === ".mjs" ? ".mts" : extension === ".cjs" ? ".cts" : undefined;
	const candidates = sourceExtension
		? [basePath, `${basePath.slice(0, -extension.length)}${sourceExtension}`]
		: extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".json"
			? [basePath]
			: [basePath, `${basePath}.ts`, resolve(basePath, "index.ts")];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

function resolveRelativeImport(specifier: string, parentDir: string): string | undefined {
	const basePath = resolve(parentDir, specifier);
	
	// Try direct file extensions
	const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
	for (const ext of extensions) {
		const candidate = basePath + ext;
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return candidate;
		}
	}
	
	// Try directory with index
	if (existsSync(basePath) && statSync(basePath).isDirectory()) {
		for (const ext of extensions) {
			const candidate = resolve(basePath, `index${ext}`);
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				return candidate;
			}
		}
	}
	
	return undefined;
}

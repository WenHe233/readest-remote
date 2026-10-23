#!/usr/bin/env node
import { createRequire } from "node:module";
import {
	readFile,
	writeFile,
	mkdir,
	readdir,
	lstat,
	access,
} from "node:fs/promises";
import { resolve, join, dirname, relative, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
} from "node:crypto";
import { createServer } from "node:http";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const option = (args, name, fallback) => {
	const index = args.indexOf(name);
	if (index < 0) return fallback;
	if (!args[index + 1] || args[index + 1].startsWith("--"))
		throw new Error(`Missing value for ${name}`);
	return args[index + 1];
};

export async function initializePlugin(directory, template, sdkArchive) {
	if (!["text", "comic"].includes(template))
		throw new Error("Choose the text or comic template.");
	try {
		await lstat(directory);
		throw new Error("The destination already exists. Choose a new directory.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const version = (await json(join(sdkRoot, "package.json"))).version;
	if (sdkArchive) await access(sdkArchive);
	await mkdir(directory, { recursive: true });
	for (const name of ["worker.ts", "manifest.json"])
		await writeFile(
			join(directory, name),
			await readFile(join(sdkRoot, "templates", template, name)),
			{ flag: "wx" },
		);
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify(
			{
				name: basename(directory)
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, "-"),
				version: "0.1.0",
				private: true,
				type: "module",
				scripts: {
					check: "tsc --noEmit && readest-plugin check",
					build: "readest-plugin build --dev",
					serve: "readest-plugin serve",
				},
				dependencies: {
					"@readest/plugin-sdk": sdkArchive
						? `file:${resolve(sdkArchive).replaceAll("\\", "/")}`
						: version,
				},
				devDependencies: {
					esbuild: "0.28.1",
					"@zip.js/zip.js": "2.8.26",
					typescript: "5.9.3",
				},
			},
			null,
			2,
		) + "\n",
	);
	await writeFile(
		join(directory, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "Bundler",
					resolveJsonModule: true,
					allowImportingTsExtensions: true,
					strict: true,
					noEmit: true,
					skipLibCheck: true,
					lib: ["ES2022", "WebWorker"],
				},
				include: ["worker.ts"],
			},
			null,
			2,
		) + "\n",
	);
	await writeFile(
		join(directory, ".gitignore"),
		"node_modules/\ndist/\n.local/\n",
	);
	return directory;
}

export function validateExternalManifest(manifest) {
	if (!manifest.name || manifest.entry !== "worker.js" || !manifest.pluginApi)
		throw new Error("External packages require name, entry and pluginApi.");
	const number = "(?:0|[1-9][0-9]*)";
	const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
	const version = new RegExp(
		`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
	);
	if (
		typeof manifest.pluginVersion !== "string" ||
		manifest.pluginVersion.length > 64 ||
		!version.test(manifest.pluginVersion) ||
		!manifest.pluginVersion
			.split(/[+-]/)[0]
			.split(".")
			.every((part) => Number.isSafeInteger(Number(part)))
	)
		throw new Error("Plugin version must be a canonical semantic version.");
	if (manifest.id.startsWith("readest."))
		throw new Error("Bundled plugin identity is reserved.");
	if (
		!["dictionaryFormats", "librarySources", "contentSources"].some(
			(key) => manifest.contributions[key]?.length,
		)
	)
		throw new Error("Plugin has no supported contributions.");
}

async function compilePlugin(directory) {
	const require = createRequire(join(directory, "package.json"));
	const { build } = require("esbuild");
	const raw = await json(join(directory, "manifest.json"));
	// Validate against the SDK actually installed in this independent project.
	const contract = await build({
		stdin: {
			contents:
				'export { pluginManifestSchema } from "@readest/plugin-sdk/contract";',
			resolveDir: directory,
		},
		bundle: true,
		format: "esm",
		platform: "node",
		write: false,
	});
	const { pluginManifestSchema } = await import(
		`data:text/javascript;base64,${Buffer.from(contract.outputFiles[0].contents).toString("base64")}`
	);
	const manifest = pluginManifestSchema.parse(raw);
	validateExternalManifest(manifest);
	const result = await build({
		entryPoints: [join(directory, "worker.ts")],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "es2022",
		write: false,
		metafile: true,
	});
	if (
		Object.keys(result.metafile.inputs).some((input) =>
			/(?:^|[\\/])apps[\\/]readest-app[\\/]/.test(input),
		)
	)
		throw new Error(
			"Plugins may depend on the SDK, not application internals.",
		);
	return { manifest, source: result.outputFiles[0].contents, require };
}

export async function buildPlugin(
	directory,
	{ development = false, keyPath, output = join(directory, "dist") } = {},
) {
	const { manifest, source, require } = await compilePlugin(directory);
	if (!keyPath && !development)
		throw new Error(
			"Use --dev for local testing or --key <private-key.pem> for publication.",
		);
	const keyFile = resolve(
		keyPath || join(directory, ".local", "development-key.pem"),
	);
	try {
		await access(keyFile);
	} catch (error) {
		if (error.code !== "ENOENT" || !development || keyPath) throw error;
		await mkdir(dirname(keyFile), { recursive: true });
		const { privateKey } = generateKeyPairSync("ed25519");
		await writeFile(
			keyFile,
			privateKey.export({ type: "pkcs8", format: "pem" }),
			{ flag: "wx", mode: 0o600 },
		);
	}
	const key = createPrivateKey(await readFile(keyFile));
	if (key.asymmetricKeyType !== "ed25519")
		throw new Error("Plugin signing requires an Ed25519 key.");
	const publicKey = createPublicKey(key)
		.export({ type: "spki", format: "der" })
		.subarray(-32);
	const files = new Map([
		["manifest.json", Buffer.from(JSON.stringify(manifest))],
		["worker.js", source],
	]);
	async function resources(folder) {
		let entries;
		try {
			if ((await lstat(folder)).isSymbolicLink())
				throw new Error("Signed resources cannot be symlinks.");
			entries = await readdir(folder, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(folder, entry.name);
			if (entry.isSymbolicLink())
				throw new Error("Signed resources cannot be symlinks.");
			if (entry.isDirectory()) await resources(path);
			else {
				const name = relative(directory, path).replaceAll("\\", "/");
				if (
					!/^[a-zA-Z0-9_.\-/]+$/.test(name) ||
					name
						.split("/")
						.some((part) => /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))
				)
					throw new Error("Invalid resource filename.");
				files.set(name, await readFile(path));
			}
		}
	}
	await resources(join(directory, "resources"));
	if (
		files.size > 256 ||
		[...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) >
			32 * 1024 * 1024
	)
		throw new Error("Plugin archive exceeds resource limits.");
	const inventory = [...files]
		.map(([path, bytes]) => ({
			path,
			size: bytes.length,
			sha256: digest(bytes),
		}))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	files.set(
		"signature.json",
		Buffer.from(
			JSON.stringify({
				algorithm: "Ed25519",
				publicKey: publicKey.toString("base64"),
				files: inventory,
				signature: sign(
					null,
					Buffer.from(JSON.stringify({ format: 1, files: inventory })),
					key,
				).toString("base64"),
			}),
		),
	);
	const {
		ZipWriter,
		Uint8ArrayWriter,
		Uint8ArrayReader,
	} = require("@zip.js/zip.js");
	const writer = new ZipWriter(new Uint8ArrayWriter(), {
		useWebWorkers: false,
	});
	for (const [name, bytes] of files)
		await writer.add(name, new Uint8ArrayReader(bytes));
	const archive = await writer.close();
	if (archive.length > 16 * 1024 * 1024)
		throw new Error("Compressed plugin archive exceeds 16 MiB.");
	await mkdir(output, { recursive: true });
	const filename = `${manifest.id}-${manifest.pluginVersion}.readest-plugin`;
	const archivePath = resolve(output, filename);
	if (dirname(archivePath) !== resolve(output))
		throw new Error("Plugin archive path escapes its output directory.");
	await writeFile(archivePath, archive);
	await writeFile(
		join(output, "repo.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: manifest.id + ".development",
			name: manifest.name,
			index: "index.json",
		}),
	);
	await writeFile(
		join(output, "index.json"),
		JSON.stringify({
			schemaVersion: 1,
			plugins: [
				{
					id: manifest.id,
					name: manifest.name,
					version: manifest.pluginVersion,
					description: manifest.description ?? "",
					channel: "beta",
					fingerprint: digest(publicKey),
					downloadUrl: filename,
					size: archive.length,
					sha256: digest(archive),
					pluginApi: manifest.pluginApi,
					contributions: Object.entries(manifest.contributions)
						.filter(([name, values]) => ['dictionaryFormats','librarySources','contentSources','sourceFormats'].includes(name) && values?.length)
						.map(([name]) => name),
				},
			],
		}),
	);
	return { path: join(output, filename), fingerprint: digest(publicKey) };
}

async function main(args) {
	const [command, target] = args;
	const directory = resolve(option(args, "--project", process.cwd()));
	if (command === "init") {
		if (!target || target.startsWith("--"))
			throw new Error(
				"Usage: readest-plugin init <new-directory> --template text|comic [--sdk <sdk.tgz>]",
			);
		console.log(
			await initializePlugin(
				resolve(target),
				option(args, "--template", "text"),
				option(args, "--sdk"),
			),
		);
	} else if (command === "check") {
		const result = await compilePlugin(directory);
		console.log(`Validated ${result.manifest.id} using only the public SDK.`);
	} else if (command === "build") {
		console.log(
			JSON.stringify(
				await buildPlugin(directory, {
					development: args.includes("--dev"),
					keyPath: option(args, "--key"),
					output: resolve(option(args, "--out", join(directory, "dist"))),
				}),
				null,
				2,
			),
		);
	} else if (command === "serve") {
		const output = resolve(option(args, "--out", join(directory, "dist")));
		const allowed = new Set(
			(await readdir(output)).filter(
				(file) => file.endsWith(".json") || file.endsWith(".readest-plugin"),
			),
		);
		const port = Number(option(args, "--port", "4781"));
		if (!Number.isInteger(port) || port < 1024 || port > 65535)
			throw new Error("Choose a port from 1024 to 65535.");
		createServer(async (request, response) => {
			try {
				const name = decodeURIComponent(
					new URL(request.url || "/", "http://localhost").pathname.slice(1),
				);
				if (request.method !== "GET" || !allowed.has(name)) {
					response.writeHead(404).end();
					return;
				}
				response.setHeader("Access-Control-Allow-Origin", "*");
				response.setHeader(
					"Content-Type",
					name.endsWith(".json")
						? "application/json"
						: "application/octet-stream",
				);
				response.end(await readFile(join(output, name)));
			} catch {
				response.writeHead(400).end();
			}
		}).listen(port, "127.0.0.1", () =>
			console.log(
				`Local plugin repository: http://127.0.0.1:${port}/repo.json`,
			),
		);
	} else throw new Error("Commands: init, check, build, serve.");
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});

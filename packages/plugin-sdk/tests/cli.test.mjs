import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initializePlugin, validateExternalManifest } from "../bin/plugin.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("rejects external versions and identities that cannot produce an installable archive", async () => {
	const manifest = JSON.parse(
		await readFile(
			join(root, "packages/plugin-sdk/templates/text/manifest.json"),
			"utf8",
		),
	);
	for (const pluginVersion of [
		"../../outside",
		"invalid",
		"1.0.0-01",
		"1.00.0",
		"999999999999999999999.0.0",
	]) {
		assert.throws(
			() => validateExternalManifest({ ...manifest, pluginVersion }),
			/version/i,
		);
	}
	for (const pluginVersion of [
		"1.0.0",
		"0.2.0-x1",
		"1.2.3-alpha.2+build.123",
	]) {
		assert.doesNotThrow(() =>
			validateExternalManifest({ ...manifest, pluginVersion }),
		);
	}
	assert.throws(
		() => validateExternalManifest({ ...manifest, id: "readest.reserved" }),
		/reserved/i,
	);
	assert.throws(
		() => validateExternalManifest({ ...manifest, contributions: {} }),
		/contribution/i,
	);
});
for (const template of ["text", "comic"]) {
	test(`initializes a strictly typed independent ${template} plugin`, async () => {
		const temporary = await mkdtemp(join(tmpdir(), "readest-sdk-test-"));
    if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('readest-sdk-test-'))
      throw new Error('Refusing cleanup outside the temporary SDK test directory.');
		try {
			const project = join(temporary, "example");
			await initializePlugin(project, template);
			const packageJson = JSON.parse(
				await readFile(join(project, "package.json"), "utf8"),
			);
			const sdk = JSON.parse(
				await readFile(join(root, "packages/plugin-sdk/package.json"), "utf8"),
			);
			assert.equal(
				packageJson.dependencies["@readest/plugin-sdk"],
				sdk.version,
			);
			assert.deepEqual(Object.keys(packageJson.dependencies), [
				"@readest/plugin-sdk",
			]);
			assert.equal(
				packageJson.scripts.check,
				"tsc --noEmit && readest-plugin check",
			);
			const tsconfig = JSON.parse(
				await readFile(join(project, "tsconfig.json"), "utf8"),
			);
			// Resolve the package's public entry locally; no app aliases or compatibility engines.
			tsconfig.compilerOptions.paths = {
				"@readest/plugin-sdk": [
					resolve(root, "packages/plugin-sdk/src/index.ts"),
				],
			};
			await writeFile(join(project, "tsconfig.json"), JSON.stringify(tsconfig));
			execFileSync(
				process.execPath,
				[
					resolve(root, "node_modules/typescript/bin/tsc"),
					"--project",
					project,
				],
				{ stdio: "pipe" },
			);
			await assert.rejects(
				initializePlugin(project, template),
				/already exists/,
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
}

test("rejects unsupported templates before creating a project", async () => {
	await assert.rejects(initializePlugin("unused", "invalid"), /text or comic/);
});

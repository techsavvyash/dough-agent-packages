#!/usr/bin/env bun
// App agent packages CLI (see bin/app-package.ts).
//
//   bun bin/publish-app.ts validate apps/*      offline validation + digest
//   bun bin/publish-app.ts publish apps/<name>... validate, then PUT to the app
//
// `publish` reads DOUGH_GATEWAY_URL and DOUGH_DEPLOY_TOKENS ({"<app>": "dpt_…"}).

import {
  AppPackageError,
  AppPublishError,
  appPackageDigest,
  deployTokenFor,
  loadAppPackage,
  publishAppPackage,
} from './app-package.ts';

function report(dir: string, err: unknown): void {
  if (err instanceof AppPackageError) {
    console.error(`FAIL ${dir}`);
    for (const issue of err.issues) console.error(`  - ${issue}`);
  } else if (err instanceof AppPublishError || err instanceof Error) {
    console.error(`FAIL ${dir}: ${err.message}`);
  } else {
    console.error(`FAIL ${dir}: ${String(err)}`);
  }
}

async function validate(dirs: string[]): Promise<number> {
  let failures = 0;
  for (const dir of dirs) {
    try {
      const { appName, body } = loadAppPackage(dir);
      console.log(`OK   ${appName}  ${appPackageDigest(body)}`);
    } catch (err) {
      failures++;
      report(dir, err);
    }
  }
  return failures === 0 ? 0 : 1;
}

async function publish(dirs: string[]): Promise<number> {
  const gatewayUrl = process.env.DOUGH_GATEWAY_URL;
  if (!gatewayUrl) {
    console.error('DOUGH_GATEWAY_URL is not set');
    return 2;
  }
  let failures = 0;
  for (const dir of dirs) {
    try {
      const { appName, body } = loadAppPackage(dir);
      const token = deployTokenFor(appName, process.env.DOUGH_DEPLOY_TOKENS);
      const outcome = await publishAppPackage({ gatewayUrl, token, appName, body });
      console.log(
        outcome.status === 'published'
          ? `PUBLISHED ${appName} v${outcome.version} (${outcome.digest}) — live within seconds`
          : `UNCHANGED ${appName} v${outcome.version} is already active (${outcome.digest})`,
      );
    } catch (err) {
      failures++;
      report(dir, err);
    }
  }
  return failures === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...dirs] = argv;
  if (dirs.length === 0 || (command !== 'validate' && command !== 'publish')) {
    console.error('usage: bun bin/publish-app.ts <validate|publish> <apps/name>...');
    return 2;
  }
  return command === 'validate' ? validate(dirs) : publish(dirs);
}

process.exit(await main(process.argv.slice(2)));

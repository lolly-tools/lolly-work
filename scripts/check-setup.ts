// SPDX-License-Identifier: MPL-2.0
import { loadConfig, loadSecrets } from '../server/src/config/instance.ts';
import { assessSetup } from '../server/src/setup/checks.ts';

// Read local configuration and pack files only. No provider or database requests.
const config = loadConfig();
const secrets = loadSecrets(process.env, config);
const report = await assessSetup(config, secrets, !!process.env.DATABASE_URL?.trim());
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.ready ? 0 : 1;

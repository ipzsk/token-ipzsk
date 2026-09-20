// Run only in the existing gateway container against the isolated test database.
// Credential material stays inside the process environment and is never logged.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const password=(await readFile('/run/secrets/db-password','utf8')).trim();
const child=spawn(process.execPath,['--test','test/desktop-releases.test.mjs','test/captcha.test.mjs','test/core.test.mjs','test/agent-protocols.test.mjs','test/audio.test.mjs','test/text-pricing.test.mjs','test/integration.test.mjs','test/wallet.test.mjs','test/customer-auth.test.mjs','test/accounts-billing.test.mjs','test/plugins.test.mjs','test/developers.test.mjs','test/model-catalog.test.mjs','test/image-results.test.mjs'],{
  cwd:new URL('..',import.meta.url),
  env:{...process.env,TEST_DB_HOST:'db',TEST_DB_PORT:'5432',TEST_DB_USER:'gateway',TEST_DB_PASSWORD:password},
  stdio:'inherit',
});
child.on('exit',code=>{process.exitCode=code??1;});

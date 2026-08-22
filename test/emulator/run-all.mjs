import { runRulesSuite } from './rules.test.mjs';
import { runFunctionsSuite } from './functions.test.mjs';
import { PROJECT_ID } from './fixtures.mjs';

const required = Object.freeze({ FIREBASE_AUTH_EMULATOR_HOST: '9099', FIRESTORE_EMULATOR_HOST: '8080', FIREBASE_EMULATOR_HUB: '4400' });
function fail(message) { throw new Error(`Emulator release gate refused to run: ${message}`); }
function checkEnvironment() {
  const project = process.env.GCLOUD_PROJECT;
  if (project !== PROJECT_ID || !project.startsWith('demo-')) fail(`GCLOUD_PROJECT must be ${PROJECT_ID}.`);
  for (const [name, port] of Object.entries(required)) {
    const value = process.env[name];
    if (!value || !value.endsWith(`:${port}`)) fail(`${name} must point to emulator port ${port}.`);
    const host = value.slice(0, -(port.length + 1));
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) fail(`${name} must use a loopback host.`);
  }
  process.env.FUNCTIONS_EMULATOR_HOST = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
}

checkEnvironment();
await runRulesSuite();
await runFunctionsSuite();
console.log('demo-bounce-volleyball emulator release gate passed');

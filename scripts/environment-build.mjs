// Native acceptance profiles are chosen by the harness, not a product/user
// environment switch. Large offline ML validates optimized production code;
// the ordinary small functional fixture retains the quicker debug build.
import { spawnSync } from 'node:child_process';
const args = ['scripts/cargo.mjs', 'build', '--manifest-path', 'backend/Cargo.toml', '--no-default-features', '--bin', 'grapher'];
if (process.env.GRAPHER_ENV_TEST_ML_MANIFEST) args.push('--release');
const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

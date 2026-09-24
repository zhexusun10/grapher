// Install Grapher's process-local policy before upstream constructs a session.
import { configureExecutionRetries } from './retry-policy.ts';
import { runPiCli } from './pi-compat.ts';

configureExecutionRetries();
await runPiCli();

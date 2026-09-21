// Install Grapher's process-local policy before upstream constructs a session.
import { configureExecutionRetries } from './retry-policy.ts';

configureExecutionRetries();
await import('../pi/packages/coding-agent/src/cli.ts');

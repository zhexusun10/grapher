// Gold routing labels and rubrics stay outside the repository shown to the model.
export const corpusVersion = 'routing-graph-quality-v1';
export const repositoryFiles = {
  'README.md': `# Atlas workspace\nSmall TypeScript service with a browser client and Python SDK.\nSource locations: server/users.ts, web/users.ts, src/normalize.ts, src/importer.ts, src/settings.ts.\nClient SDKs live in clients/typescript/client.ts and clients/python/client.py.\nContracts live in contracts/. Integration tests live in tests/. Audits are written under reports/.\nNo generated files are committed. Keep existing public behavior unless the user requests a change.\n`,
  'package.json': '{"name":"atlas-fixture","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
  'src/normalize.ts': 'export const normalizeEmail = (value: string) => value.toLowerCase();\n',
  'tests/normalize.test.ts': '// Existing normalization tests cover lowercasing but not surrounding whitespace.\n',
  'src/importer.ts': 'export function importRows(text: string) { return text.split("\\n").map(line => line.split(",")); }\n',
  'src/settings.ts': 'export interface Settings { retryCount: number; }\nexport const defaults: Settings = { retryCount: 3 };\n',
  'server/config.ts': 'import { defaults } from "../src/settings";\nexport const retries = defaults.retryCount;\n',
  'web/config.ts': 'import { defaults } from "../src/settings";\nexport const retries = defaults.retryCount;\n',
  'docs/configuration.md': 'retryCount is the maximum number of retries; default 3.\n',
  'contracts/users.json': '{"endpoint":"GET /users","query":{"q":"string","cursor":"optional string"},"response":{"items":[{"id":"string","name":"string"}],"nextCursor":"string or null"},"errors":{"400":"invalid cursor","500":"server error"}}\n',
  'server/users.ts': '// TODO: users search endpoint. Return data using the contracts/users.json schema.\nexport const users = [];\n',
  'web/users.ts': '// TODO: browser users search UI. No UI framework required.\nexport function mountUsers(element: HTMLElement) { element.textContent = "Users"; }\n',
  'tests/users-flow.test.ts': '// Integration tests for GET /users and the browser search flow will go here.\n',
  'clients/typescript/client.ts': 'export class Client { constructor(public baseUrl: string) {} }\n',
  'clients/python/client.py': 'class Client:\n    def __init__(self, base_url):\n        self.base_url = base_url\n',
  'tests/sdk-conformance.md': '# SDK conformance\nNo retry contract is defined yet.\n',
  'server/auth.ts': 'export const sessions = new Map<string, {userId: string, expiresAt: number}>();\nexport function authenticate(token: string) { return sessions.get(token)?.userId; }\n',
  'server/storage.ts': 'import { writeFileSync } from "node:fs";\nexport function save(path: string, data: string) { writeFileSync(path, data); }\n',
};

const dimensionRubric = {
  coverage: 'All requested behavior and verification obligations have explicit owners; merely repeating file names does not cover their behavior.',
  standalone: 'Each task tells a fresh worker what to change, where to work, relevant inputs/contract, constraints and what constitutes completion. It must not rely on another node\'s conversation.',
  boundaries: 'Substantial responsibilities have coherent ownership. Avoid duplicate implementation, gratuitous tiny steps and pure Git merge/scheduling nodes.',
  mergeability: 'Independent workers have separate output files; shared contracts precede their consumers. Review reads are not writes. Identify overlapping writes and unjustified serialization.',
  verification: 'Verification checks concrete acceptance behavior using the outputs of all required implementation branches. Requested revision feedback is assigned to the correct reviewer and targets. Extra reruns and quality gates do not improve this score.',
  fidelity: 'Tasks preserve the user goal and authoritative repository contracts. They do not pre-solve domain findings, mandate unsupported repository relationships, or turn unspecified behavior and speculative implementation choices into requirements.',
  economy: 'Every node produces a requested deliverable or owns a distinct acceptance responsibility needed by the goal. Reject redundant review/report nodes, repeated evidence generation and stricter process obligations the user did not request.',
};
export { dimensionRubric };

export const cases = [
  {
    id: 'P001', title: 'Local normalization fix', expectedRoute: 'serial',
    rationale: 'One small function fix with its directly coupled regression tests; no substantial independent workstream.',
    goal: 'Fix normalizeEmail in src/normalize.ts so surrounding whitespace is removed before lowercasing. Add regression tests in tests/normalize.test.ts for spaces, tabs, mixed case and the empty string. Preserve the exported signature.',
  },
  {
    id: 'P002', title: 'Ordered changes in one importer', expectedRoute: 'serial',
    rationale: 'Parsing, validation and error handling refine the same small function and depend on each other; enumerated steps do not imply parallel work.',
    goal: 'Improve the small CSV importRows function in src/importer.ts. First parse quoted fields and escaped quotes correctly, then validate every parsed row has the header column count, then return one consistent error containing the offending row number. Keep these changes in the existing function and add focused regression tests. Preserve the existing array-of-rows result for valid input.',
  },
  {
    id: 'P003', title: 'Mechanical multi-file rename', expectedRoute: 'serial',
    rationale: 'Touching backend, frontend and documentation does not turn a single mechanical rename into substantial independent workstreams.',
    goal: 'Rename Settings.retryCount to maxRetries in src/settings.ts and update its direct references in server/config.ts, web/config.ts and docs/configuration.md. The default stays 3 and behavior must remain identical. Check that no stale retryCount references remain. Do not redesign the configuration system.',
  },
  {
    id: 'P004', title: 'Users endpoint and browser search', expectedRoute: 'graph',
    rationale: 'The API contract already exists, so backend and browser implementation can progress separately before integration verification.',
    goal: 'Deliver users search using the existing immutable contracts/users.json contract. Implement server/users.ts with q filtering, cursor pagination and the specified 400/500 errors, and server unit tests. Implement web/users.ts with debounced search, pagination, loading/empty/error states and protection against stale responses, with browser unit tests. Add integrated acceptance coverage in tests/users-flow.test.ts exercising the browser against the endpoint, including invalid cursors and out-of-order responses. Keep the published contract and package manifest unchanged.',
    units: {
      backend: { paths: ['server/users.ts'], requirement: 'Implement filtering, cursor pagination, specified error responses and server unit tests.' },
      frontend: { paths: ['web/users.ts'], requirement: 'Implement debouncing, pagination, loading/empty/error states, stale response protection and browser unit tests.' },
      integration: { paths: ['tests/users-flow.test.ts'], requirement: 'Test the combined endpoint/browser flow including invalid cursors and out-of-order responses.' },
    },
    dependencies: [['backend', 'integration'], ['frontend', 'integration']],
    independent: [['backend', 'frontend']], feedback: [], maxNodes: 7,
  },
  {
    id: 'P005', title: 'Contract and two SDK implementations', expectedRoute: 'graph',
    rationale: 'Define one shared contract, implement two SDKs in disjoint trees, then compare conformance; verification can request bounded revisions.',
    goal: 'Add a consistent retry policy to the TypeScript and Python SDKs. Specify retryable HTTP statuses (429 and 503), Retry-After handling, exponential backoff, maximum attempts and non-idempotent request protection in a new contracts/retry-policy.md before implementation. Implement and unit-test that contract in clients/typescript/client.ts and clients/python/client.py. Review both clients together and write reproducible conformance scenarios and results in tests/sdk-conformance.md, checking both use identical policy semantics. If that review finds nonconformance, request corrections to both client implementations and repeat the conformance review. Do not put retry behavior in the server or browser app.',
    units: {
      contract: { paths: ['contracts/retry-policy.md'], requirement: 'Specify retryable statuses, Retry-After, backoff, maximum attempts and non-idempotent protection.' },
      typescript: { paths: ['clients/typescript/client.ts'], requirement: 'Implement and unit-test the agreed retry policy in the TypeScript SDK.' },
      python: { paths: ['clients/python/client.py'], requirement: 'Implement and unit-test the agreed retry policy in the Python SDK.' },
      conformance: { paths: ['tests/sdk-conformance.md'], requirement: 'Compare both implementations against the shared contract with reproducible checks and request corrections on failure.' },
    },
    dependencies: [['contract', 'typescript'], ['contract', 'python'], ['typescript', 'conformance'], ['python', 'conformance']],
    independent: [['typescript', 'python']], feedback: [['conformance', 'typescript'], ['conformance', 'python']], maxNodes: 8,
    forbiddenTaskReferences: ['src/settings.ts', 'server/config.ts', 'web/config.ts', 'docs/configuration.md'],
  },
  {
    id: 'P006', title: 'Independent audits and release decision', expectedRoute: 'graph',
    rationale: 'Authentication and storage audits can independently produce reports; release assessment needs both outputs.',
    goal: 'Assess whether this service is ready for release without changing application source. Audit server/auth.ts for authentication/session expiry vulnerabilities and write reports/auth.md with evidence, reproduction cases, severity and recommended fixes. Separately audit server/storage.ts for crash consistency and data-loss risks and write reports/storage.md with failure scenarios, severity and recommended fixes. Produce reports/release.md using both reports to prioritize blockers, explain tradeoffs and recommend a release decision. Do not implement the fixes in this assessment.',
    units: {
      auth: { paths: ['reports/auth.md'], requirement: 'Audit session/authentication risks with evidence, reproduction, severity and recommendations; do not modify source.' },
      storage: { paths: ['reports/storage.md'], requirement: 'Audit crash consistency/data-loss risks with failure scenarios, severity and recommendations; do not modify source.' },
      release: { paths: ['reports/release.md'], requirement: 'Synthesize both reports, prioritize blockers and make a justified release decision.' },
    },
    dependencies: [['auth', 'release'], ['storage', 'release']],
    independent: [['auth', 'storage']], feedback: [], maxNodes: 6,
  },
];

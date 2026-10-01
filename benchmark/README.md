# Harbor adapter

`benchmark.harbor_agent:GrapherAgent` integrates Grapher as a Harbor custom installed agent. Harbor and benchmark datasets are separate dependencies.

See the canonical [Harbor evaluation guide](../docs/benchmarks/harbor.md) for task-image setup, Linux namespace requirements, credentials, options, evidence, and comparability.

```sh
python3 -m unittest discover -s benchmark -p 'test_*.py'
```

The real import-path interface test needs a separate Harbor installation. Unit tests and protocol mocks are not benchmark scores. `tb4.py` is a specialized local launcher, not a portable setup recipe; read the guide before using it.

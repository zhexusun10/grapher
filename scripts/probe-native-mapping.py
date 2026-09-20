#!/usr/bin/env python3
"""Darwin arm64 feasibility evidence, NOT a production launcher or sandbox.
No sudo, mounts, software installation, SIP changes or real project writes.
An exit code of zero means the expected counterexamples were reproduced;
report.contractSatisfied stays false. Unsupported hosts fail explicitly.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if platform.system() != 'Darwin' or platform.machine() != 'arm64':
    raise SystemExit('This experiment requires macOS arm64; other platforms are unverified.')
fixtures = Path(__file__).resolve().parent / 'native-mapping'
report = {'contractSatisfied': False, 'productionLauncherTested': False,
          'environment': {'system': platform.platform(), 'node': shutil.which('node'),
                          'python': platform.python_version(), 'docker': shutil.which('docker')},
          'cases': []}


def run(argv, **kwargs):
    result = subprocess.run([str(x) for x in argv], capture_output=True, text=True,
                            timeout=15, **kwargs)
    return {'code': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}


def record(name, result, expected_output=None, denied=False):
    matched = result['code'] != 0 if denied else result['code'] == 0 and result['stdout'] == expected_output
    report['cases'].append({'name': name, 'expectedObserved': matched, **result})


report['environment']['macOS'] = run(['/usr/bin/sw_vers'])
report['environment']['sip'] = run(['/usr/bin/csrutil', 'status'])
report['environment']['clang'] = run(['/usr/bin/clang', '--version'])
report['environment']['filesystems'] = sorted(p.name for p in Path('/Library/Filesystems').iterdir())
with tempfile.TemporaryDirectory(prefix='grapher-native-mapping-') as temporary:
    root = Path(temporary).resolve()
    source, a, b = [root / name for name in ('source', 'a', 'b')]
    for directory, content in ((source, 'SOURCE'), (a, 'A'), (b, 'B')):
        directory.mkdir()
        (directory / 'value').write_text(content)
    external = root / 'external'
    external.write_text('EXTERNAL')
    (a / 'external-link').symlink_to(external)
    (a / 'source-link').symlink_to(source / 'value')
    helper, library = root / 'probe', root / 'mapping.dylib'
    for command in (["/usr/bin/clang", '-Wall', '-Wextra', fixtures / 'probe.c', '-o', helper],
                    ["/usr/bin/clang", '-Wall', '-Wextra', '-dynamiclib', fixtures / 'interpose.c', '-o', library]):
        compiled = run(command)
        if compiled['code']:
            raise RuntimeError(compiled)
    env = {**os.environ, 'DYLD_INSERT_LIBRARIES': str(library), 'PROBE_SOURCE': str(source), 'PROBE_TARGET': str(a)}
    record('cwd_relative_reads_workspace', run([helper, 'read', 'value'], cwd=a), 'A')
    record('cwd_absolute_still_reads_source', run([helper, 'read', source / 'value'], cwd=a), 'SOURCE')
    record('hook_libc_open_redirects', run([helper, 'read', source / 'value'], env=env), 'A')
    record('hook_custom_exec_inherits', run([helper, 'exec', source / 'value'], env=env), 'A')
    record('hook_direct_arm64_syscall_bypasses', run([helper, 'raw', source / 'value'], env=env), 'SOURCE')
    record('hook_protected_cat_bypasses', run([helper, 'cat', source / 'value'], env=env), 'SOURCE')
    record('hook_nested_system_shell_bypasses', run([helper, 'nested', source / 'value'], env=env), 'SOURCE')
    record('hook_external_symlink_available', run([helper, 'read', a / 'external-link'], env=env), 'EXTERNAL')
    record('hook_source_symlink_bypasses', run([helper, 'read', a / 'source-link'], env=env), 'SOURCE')
    # Concurrent processes, same absolute string, private writes for hooked open only.
    workers = [subprocess.Popen([str(helper), 'write', str(source / 'value'), label],
               env={**env, 'PROBE_TARGET': str(target)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
               for target, label in ((a, 'A-WRITE'), (b, 'B-WRITE'))]
    try:
        for index, worker in enumerate(workers):
            stdout, stderr = worker.communicate(timeout=15)
            record(f'hook_parallel_worker_{index}', {'code': worker.returncode, 'stdout': stdout, 'stderr': stderr},
                   ['A-WRITE', 'B-WRITE'][index])
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.kill()
            worker.wait()
    # Seatbelt supplies access control, no redirect. Combine with the hook too.
    profile = root / 'probe.sb'
    profile.write_text(f'(version 1)\n(allow default)\n(deny file-read* file-write* (subpath {json.dumps(str(source))}))\n')
    sandbox = ['/usr/bin/sandbox-exec', '-f', profile]
    record('seatbelt_relative_workspace_allowed', run([*sandbox, helper, 'read', 'value'], cwd=a), 'A-WRITE')
    record('seatbelt_absolute_source_denied_not_redirected', run([*sandbox, helper, 'read', source / 'value'], cwd=a), denied=True)
    record('seatbelt_source_symlink_denied', run([*sandbox, helper, 'read', a / 'source-link']), denied=True)
    record('seatbelt_external_link_allowed', run([*sandbox, helper, 'read', a / 'external-link']), 'EXTERNAL')
    record('seatbelt_protected_child_denied_not_redirected', run([*sandbox, helper, 'cat', source / 'value']), denied=True)
    # Set DYLD after sandbox-exec (a system executable) has started.
    env_command = ['/usr/bin/env', f'DYLD_INSERT_LIBRARIES={library}', f'PROBE_SOURCE={source}', f'PROBE_TARGET={a}']
    record('hook_plus_seatbelt_libc_redirects', run([*sandbox, *env_command, helper, 'read', source / 'value']), 'A-WRITE')
    record('hook_plus_seatbelt_raw_denied_not_redirected', run([*sandbox, *env_command, helper, 'raw', source / 'value']), denied=True)
    record('hook_plus_seatbelt_protected_child_denied_not_redirected', run([*sandbox, *env_command, helper, 'cat', source / 'value']), denied=True)
    # Dedicated disposable source markers demonstrate write escapes as well.
    # Never aim these operations at the real project or the main source sentinel.
    for operation, marker in [('raw-write', 'RAW-WROTE-SOURCE'), ('nested-write', 'CHILD-WROTE-SOURCE')]:
        victim = source / operation
        victim.write_text('SOURCE')
        result = run([helper, operation, victim], env=env)
        record(f'hook_{operation}_escapes', result, '')
        record(f'hook_{operation}_source_changed', run(['/bin/cat', victim]), marker)
        victim.write_text('SOURCE')
        record(f'seatbelt_{operation}_denied_not_redirected', run([*sandbox, *env_command, helper, operation, victim]), denied=True)
        record(f'seatbelt_{operation}_source_unchanged', run(['/bin/cat', victim]), 'SOURCE')
        victim.unlink()
    # Kernel clients (Python/Node) build paths internally without any shell rewriting.
    import sys
    record('python_constructed_absolute_reads_source', run([sys.executable, '-c',
           'import pathlib,sys; print((pathlib.Path(sys.argv[1])/"value").read_text())', source], cwd=a), 'SOURCE')
    if shutil.which('node'):
        child_code = 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))'
        parent_code = ('const p=require("node:path").join(process.argv[1],"value"); '
                       'process.stdout.write(require("node:child_process").execFileSync(process.execPath,'
                       f'["-e",{json.dumps(child_code)},p]));')
        record('node_nested_absolute_reads_source', run(['node', '-e', parent_code, source], cwd=a), 'SOURCE')
    # A global symlink has one target even while two readers run concurrently.
    alias = root / 'global-alias'
    alias.symlink_to(a, target_is_directory=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: run([helper, 'read', alias / 'value']), range(2)))
    for index, result in enumerate(results):
        record(f'global_alias_reader_{index}_same_target', result, 'A-WRITE')
    report['mainSourceSentinelUnchanged'] = (source / 'value').read_text() == 'SOURCE' and sorted(p.name for p in source.iterdir()) == ['value']
    report['writeEscapeDemonstratedOnDisposableMarkers'] = True
    report['privateWritesVerified'] = (a / 'value').read_text() == 'A-WRITE' and (b / 'value').read_text() == 'B-WRITE'
    # Preserve evidence without retaining random fixture paths after cleanup.
    report = json.loads(json.dumps(report).replace(str(root), '<fixture>'))
report['expectedCounterexamplesReproduced'] = all(case['expectedObserved'] for case in report['cases'])
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'report': str(args.output), 'cases': len(report['cases']),
                  'expectedCounterexamplesReproduced': report['expectedCounterexamplesReproduced'],
                  'mainSourceSentinelUnchanged': report['mainSourceSentinelUnchanged'], 'contractSatisfied': False}, indent=2))
raise SystemExit(0 if report['expectedCounterexamplesReproduced'] and report['mainSourceSentinelUnchanged'] and report['privateWritesVerified'] else 1)

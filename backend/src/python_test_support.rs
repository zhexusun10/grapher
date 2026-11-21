//! File-backed extension relocation needs an actual shared extension, even
//! when the default interpreter builds its standard extensions into Python.
use std::{path::PathBuf, process::Command, sync::OnceLock};

pub(crate) fn file_backed_python() -> PathBuf {
    static PYTHON: OnceLock<PathBuf> = OnceLock::new();
    PYTHON.get_or_init(|| {
        let path = std::env::var_os("PATH").unwrap_or_default();
        for directory in std::env::split_paths(&path) {
            for name in if cfg!(windows) {
                ["python.exe", "python3.exe"]
            } else {
                ["python3", "python"]
            } {
                let program = directory.join(name);
                if !program.is_file() { continue; }
                let Ok(output) = Command::new(program).args(["-I", "-B", "-c",
                    "import _hashlib,json,os,sys; f=getattr(_hashlib,'__file__',None); print(json.dumps(sys.executable if sys.version_info>=(3,11) and f and os.path.isfile(f) else None))"
                ]).output() else { continue; };
                if output.status.success() {
                    if let Ok(Some(selected)) = serde_json::from_slice::<Option<PathBuf>>(&output.stdout) {
                        return selected;
                    }
                }
            }
        }
        panic!("Native extension relocation tests require Python 3.11+ on PATH with a file-backed _hashlib module");
    }).clone()
}

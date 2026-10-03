use super::static_asset_path;
use std::fs;

#[test]
fn static_files_accept_real_assets_and_reject_cross_platform_path_escapes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("web 中文 space");
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("index.html"), "index").unwrap();
    fs::write(root.join("assets/app.js"), "app").unwrap();
    assert_eq!(
        static_asset_path(&root, "/"),
        Some(root.join("index.html").canonicalize().unwrap())
    );
    assert_eq!(
        static_asset_path(&root, "/assets/app.js"),
        Some(root.join("assets/app.js").canonicalize().unwrap())
    );
    for path in [
        "/../secret",
        "/assets/../../secret",
        r"/..\secret",
        r"/C:\secret",
        "/C:/secret",
        r"/\\server\share\secret",
        r"/\\?\C:\secret",
        r"/\\.\NUL",
        "/index.html:secret",
        "/missing",
        "/assets",
        "/\0",
    ] {
        assert!(
            static_asset_path(&root, path).is_none(),
            "unexpected accepted path: {path:?}"
        );
    }
}

#[test]
fn static_files_refuse_symlinks_and_windows_junctions_below_the_web_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("web");
    let outside = temp.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), "private").unwrap();
    crate::path_safety::directory_link(&outside, &root.join("linked"));
    assert!(static_asset_path(&root, "/linked/secret").is_none());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("secret"), root.join("file-link")).unwrap();
        assert!(static_asset_path(&root, "/file-link").is_none());
    }
    let root_link = temp.path().join("web-link");
    crate::path_safety::directory_link(&root, &root_link);
    assert!(static_asset_path(&root_link, "/index.html").is_none());
    assert_eq!(
        fs::read_to_string(outside.join("secret")).unwrap(),
        "private"
    );
}

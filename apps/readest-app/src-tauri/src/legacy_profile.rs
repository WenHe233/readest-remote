//! One-time, recoverable reset when upgrading the V1 application identity.
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MARKER: &str = ".readest-remote-generation";
const PENDING: &str = ".readest-remote-backup.pending.json";
const BACKUPS: &str = "ReadestRemoteBackups";
pub struct ProfileMode {
    pub portable: bool,
}

#[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
struct Entry {
    path: PathBuf,
    bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    link: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
struct Move {
    from: PathBuf,
    to: PathBuf,
    inventory: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    backup: PathBuf,
    moves: Vec<Move>,
}

fn inventory(path: &Path) -> io::Result<Vec<Entry>> {
    fn visit(path: &Path, relative: &Path, entries: &mut Vec<Entry>) -> io::Result<()> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            entries.push(Entry {
                path: relative.to_owned(),
                bytes: None,
                link: Some(fs::read_link(path)?),
            });
            return Ok(());
        }
        entries.push(Entry {
            path: relative.to_owned(),
            bytes: metadata.is_file().then_some(metadata.len()),
            link: None,
        });
        if metadata.is_dir() {
            let mut children = fs::read_dir(path)?.collect::<io::Result<Vec<_>>>()?;
            children.sort_by_key(|entry| entry.file_name());
            for entry in children {
                visit(&entry.path(), &relative.join(entry.file_name()), entries)?;
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(path, Path::new(""), &mut entries)?;
    Ok(entries)
}

fn owned(name: &std::ffi::OsStr, portable: bool) -> bool {
    let name = name.to_string_lossy();
    if [MARKER, PENDING, BACKUPS, "logs", "Logs"].contains(&name.as_ref()) {
        return false;
    }
    !portable
        || [
            "settings.json",
            "Readest",
            ".window-state.json",
            ".readest-webview",
        ]
        .contains(&name.as_ref())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)
}

/// Renames only application-owned entries on the same filesystem. A successful
/// rename preserves every byte without a delete/copy window or spare disk space.
/// The journal is durable before any move; interrupted runs resume before a
/// database or WebView can open. No initialization marker is written on failure.
pub fn prepare(requested: &[PathBuf], portable: bool) -> io::Result<Option<PathBuf>> {
    let mut roots = Vec::new();
    for root in requested {
        if !root.is_absolute() || root.parent().is_none() {
            return Err(io::Error::other("Invalid profile root"));
        }
        fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    let all = roots.clone();
    roots.retain(|root| {
        !all.iter()
            .any(|parent| parent != root && root.starts_with(parent))
    });
    let primary = roots
        .first()
        .ok_or_else(|| io::Error::other("Missing profile root"))?;
    let marker = primary.join(MARKER);
    if marker.exists() {
        if fs::read_to_string(marker)? != "2\n" {
            return Err(io::Error::other("Unknown profile generation"));
        }
        return Ok(None);
    }
    let pending = primary.join(PENDING);
    let journal: Journal = if pending.exists() {
        serde_json::from_slice(&fs::read(&pending)?).map_err(io::Error::other)?
    } else {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let backup = primary.join(BACKUPS).join(format!("v1-{stamp}"));
        let mut moves = Vec::new();
        for (index, root) in roots.iter().enumerate() {
            for entry in fs::read_dir(root)? {
                let entry = entry?;
                if owned(&entry.file_name(), portable) {
                    moves.push(Move {
                        from: entry.path(),
                        to: backup.join(format!("root-{index}")).join(entry.file_name()),
                        inventory: inventory(&entry.path())?,
                    });
                }
            }
        }
        if moves.is_empty() {
            atomic_write(&marker, b"2\n")?;
            return Ok(None);
        }
        for entry in &moves {
            fs::create_dir_all(entry.to.parent().unwrap())?;
        }
        let journal = Journal { backup, moves };
        let bytes = serde_json::to_vec_pretty(&journal).map_err(io::Error::other)?;
        atomic_write(&pending, &bytes)?;
        journal
    };
    let backup_parent = primary.join(BACKUPS).canonicalize()?;
    if backup_parent.parent() != Some(primary.as_path())
        || journal.backup.parent() != Some(primary.join(BACKUPS).as_path())
        || journal.backup.canonicalize()?.parent() != Some(backup_parent.as_path())
    {
        return Err(io::Error::other("Invalid backup location"));
    }
    for entry in &journal.moves {
        let index = roots
            .iter()
            .position(|root| entry.from.parent() == Some(root.as_path()))
            .ok_or_else(|| io::Error::other("Backup journal points outside the profile"))?;
        let name = entry
            .from
            .file_name()
            .ok_or_else(|| io::Error::other("Invalid backup entry"))?;
        if !owned(name, portable)
            || entry.to != journal.backup.join(format!("root-{index}")).join(name)
            || entry.to.parent().unwrap().canonicalize()?.parent()
                != Some(journal.backup.canonicalize()?.as_path())
        {
            return Err(io::Error::other("Invalid backup destination"));
        }
        if fs::symlink_metadata(&entry.from).is_ok() {
            if fs::symlink_metadata(&entry.to).is_ok() || inventory(&entry.from)? != entry.inventory
            {
                return Err(io::Error::other(
                    "Profile changed during backup; close the old application and retry",
                ));
            }
            fs::rename(&entry.from, &entry.to)?;
        }
        if inventory(&entry.to)? != entry.inventory {
            return Err(io::Error::other("Backup verification failed"));
        }
    }
    fs::write(
        journal.backup.join("manifest.json"),
        serde_json::to_vec_pretty(&journal).map_err(io::Error::other)?,
    )?;
    fs::write(journal.backup.join("RESTORE.txt"), "Readest Remote V1 backup\nClose Readest Remote before restoring. Each manifest.json entry maps a backup path (to) to its original path (from). Preserve new data separately before restoring. Remove the profile generation marker only when returning to V1. Custom external book directories were not moved. Never run two application versions against the same profile.\n")?;
    atomic_write(&marker, b"2\n")?;
    fs::remove_file(pending)?;
    Ok(Some(journal.backup))
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("legacy-profile")
        .setup(|app, _| {
            use tauri::Manager;
            // The executable directory is used only when portable mode is explicit
            // or the V1 portable settings file already exists.
            let executable = PathBuf::from(crate::get_executable_dir());
            let portable = option_env!("READEST_PORTABLE_BUILD") == Some("true")
                || executable.join("settings.json").exists()
                || executable.join(MARKER).exists();
            let roots = if portable {
                vec![executable]
            } else {
                vec![
                    app.path().app_config_dir()?,
                    app.path().app_data_dir()?,
                    app.path().app_local_data_dir()?,
                    app.path().app_cache_dir()?,
                ]
            };
            if let Some(backup) = prepare(&roots, portable)? {
                log::info!(
                    "Previous Readest Remote data backed up at {}",
                    backup.display()
                );
            }
            app.manage(ProfileMode { portable });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let resolved = self.0.canonicalize().unwrap();
            assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("readest-legacy-test-"));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn tempdir() -> io::Result<Temp> {
        let root = std::env::temp_dir().join(format!(
            "readest-legacy-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root)?;
        Ok(Temp(root))
    }

    #[test]
    fn backs_up_old_profile_and_does_not_reset_it_twice() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("profile");
        fs::create_dir_all(root.join("Readest/Books/book")).unwrap();
        fs::write(root.join("settings.json"), r#"{"kavita":{"enabled":true}}"#).unwrap();
        fs::write(root.join("Readest/Books/book/config.json"), "annotations").unwrap();
        fs::write(root.join("Readest/Books/book/book.epub"), "original").unwrap();
        let backup = prepare(std::slice::from_ref(&root), false)
            .unwrap()
            .unwrap();
        assert!(!root.join("settings.json").exists());
        assert_eq!(
            fs::read_to_string(backup.join("root-0/Readest/Books/book/config.json")).unwrap(),
            "annotations"
        );
        assert_eq!(fs::read_to_string(root.join(MARKER)).unwrap(), "2\n");
        fs::write(root.join("settings.json"), "new settings").unwrap();
        assert!(prepare(std::slice::from_ref(&root), false)
            .unwrap()
            .is_none());
        assert_eq!(
            fs::read_to_string(root.join("settings.json")).unwrap(),
            "new settings"
        );
    }

    #[test]
    fn portable_reset_leaves_the_executable_and_unrelated_books_alone() {
        let temp = tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::create_dir(root.join("Readest")).unwrap();
        fs::write(root.join("settings.json"), "{}").unwrap();
        fs::write(root.join("readest-remote.exe"), "executable").unwrap();
        fs::write(root.join("unrelated.epub"), "external book").unwrap();
        prepare(std::slice::from_ref(&root), true).unwrap();
        assert!(!root.join("settings.json").exists());
        assert!(root.join("readest-remote.exe").exists());
        assert!(root.join("unrelated.epub").exists());
    }

    #[test]
    fn backup_failure_leaves_original_settings_and_no_marker() {
        let temp = tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::write(root.join("settings.json"), "original settings").unwrap();
        fs::write(root.join(BACKUPS), "cannot create a directory here").unwrap();
        assert!(prepare(std::slice::from_ref(&root), false).is_err());
        assert_eq!(
            fs::read_to_string(root.join("settings.json")).unwrap(),
            "original settings"
        );
        assert!(!root.join(MARKER).exists());
    }

    #[test]
    fn fresh_install_and_aliased_roots_are_supported() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("fresh");
        assert!(prepare(&[root.clone(), root.clone()], false)
            .unwrap()
            .is_none());
        assert_eq!(fs::read_to_string(root.join(MARKER)).unwrap(), "2\n");
    }

    #[test]
    fn interrupted_backup_resumes_and_can_be_restored() {
        let temp = tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let backup = root.join(BACKUPS).join("v1-interrupted");
        fs::create_dir_all(backup.join("root-0")).unwrap();
        fs::write(root.join("settings.json"), "legacy settings").unwrap();
        fs::write(root.join("library.db"), "legacy annotations").unwrap();
        let moves = ["settings.json", "library.db"]
            .map(|name| Move {
                from: root.join(name),
                to: backup.join("root-0").join(name),
                inventory: inventory(&root.join(name)).unwrap(),
            })
            .into_iter()
            .collect::<Vec<_>>();
        let journal = Journal {
            backup: backup.clone(),
            moves,
        };
        fs::write(root.join(PENDING), serde_json::to_vec(&journal).unwrap()).unwrap();
        fs::rename(&journal.moves[0].from, &journal.moves[0].to).unwrap();
        assert_eq!(
            prepare(std::slice::from_ref(&root), false).unwrap(),
            Some(backup)
        );
        for entry in journal.moves {
            fs::rename(entry.to, entry.from).unwrap();
        }
        assert_eq!(
            fs::read_to_string(root.join("library.db")).unwrap(),
            "legacy annotations"
        );
        assert_eq!(
            fs::read_to_string(root.join("settings.json")).unwrap(),
            "legacy settings"
        );
    }

    #[test]
    fn a_custom_book_directory_is_not_moved_or_modified() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("profile");
        let books = temp.path().join("my-books");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&books).unwrap();
        fs::write(books.join("book.epub"), "external original").unwrap();
        fs::write(
            root.join("settings.json"),
            serde_json::to_vec(&serde_json::json!({"customRootDir": books})).unwrap(),
        )
        .unwrap();
        prepare(std::slice::from_ref(&root), false).unwrap();
        assert_eq!(
            fs::read_to_string(books.join("book.epub")).unwrap(),
            "external original"
        );
    }

    #[test]
    fn a_forged_pending_journal_cannot_move_an_external_file() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("profile");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let backup = root.join(BACKUPS).join("v1-forged");
        fs::create_dir_all(backup.join("root-0")).unwrap();
        let external = temp.path().join("private.txt");
        fs::write(&external, "do not move").unwrap();
        let journal = Journal {
            backup: backup.clone(),
            moves: vec![Move {
                from: external.clone(),
                to: backup.join("root-0/private.txt"),
                inventory: inventory(&external).unwrap(),
            }],
        };
        fs::write(root.join(PENDING), serde_json::to_vec(&journal).unwrap()).unwrap();
        assert!(prepare(std::slice::from_ref(&root), false).is_err());
        assert_eq!(fs::read_to_string(external).unwrap(), "do not move");
        assert!(!root.join(MARKER).exists());
    }
}

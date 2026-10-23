use std::path::{Path, PathBuf};

pub struct ProfileMode {
    pub portable: bool,
}

pub fn portable_root(executable: &Path) -> PathBuf {
    executable.join("Readest-Remote-Experimental")
}

fn is_portable(executable: &Path, explicit: bool) -> bool {
    explicit || portable_root(executable).join("settings.json").exists()
}

pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("experimental-profile")
        .setup(|app, _| {
            use tauri::Manager;
            let executable = PathBuf::from(crate::get_executable_dir());
            let portable = is_portable(
                &executable,
                option_env!("READEST_PORTABLE_BUILD") == Some("true"),
            );
            if portable {
                let root = portable_root(&executable);
                std::fs::create_dir_all(&root)?;
            }
            // This channel never searches, backs up or migrates stable profiles.
            app.manage(ProfileMode { portable });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_profile_is_a_dedicated_child_of_the_executable_directory() {
        let parent = std::env::temp_dir().join(format!("readest-profile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::write(parent.join("settings.json"), "stable").unwrap();
        assert!(!is_portable(&parent, false));
        assert!(is_portable(&parent, true));
        let root = portable_root(&parent);
        assert_eq!(root.parent(), Some(parent.as_path()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("settings.json"), "experiment").unwrap();
        assert!(is_portable(&parent, false));
        assert_eq!(
            std::fs::read_to_string(parent.join("settings.json")).unwrap(),
            "stable"
        );
        std::fs::remove_file(root.join("settings.json")).unwrap();
        std::fs::remove_file(parent.join("settings.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
        std::fs::remove_dir(parent).unwrap();
    }
}

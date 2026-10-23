//! System-owned routing decisions. Proxy endpoints never cross the guest boundary.

use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;

const MAX_PROXY_LOOKUPS: usize = 8;
static PROXY_LOOKUPS: OnceLock<Arc<Semaphore>> = OnceLock::new();

async fn run_proxy_lookup<T, F>(slots: Arc<Semaphore>, lookup: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    // Dropping a request cannot stop an already-running platform query. Keep
    // its slot inside the blocking task so repeated cancellation cannot grow
    // the number of background queries. A cancelled waiter starts no task.
    let permit = slots
        .acquire_owned()
        .await
        .map_err(|_| "SOURCE_HTTP_PROXY_FAILED".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        lookup()
    })
    .await
    .map_err(|_| "SOURCE_HTTP_PROXY_FAILED".to_string())?
}

pub enum SystemProxyRoute {
    SystemDefault,
    Direct,
    Proxy(String),
}

pub async fn resolve_system_proxy<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: &str,
) -> Result<SystemProxyRoute, String> {
    let mut destination = tauri::Url::parse(url).map_err(|_| "SOURCE_HTTP_PROXY_FAILED")?;
    destination.set_fragment(None);
    let url = destination.to_string();
    let slots = PROXY_LOOKUPS
        .get_or_init(|| Arc::new(Semaphore::new(MAX_PROXY_LOOKUPS)))
        .clone();
    #[cfg(mobile)]
    {
        use tauri_plugin_native_bridge::{NativeBridgeExt, SystemProxyRequest};

        let app = app.clone();
        let response = run_proxy_lookup(slots, move || {
            app.native_bridge()
                .resolve_system_proxy(SystemProxyRequest { url })
                .map_err(|_| "SOURCE_HTTP_PROXY_FAILED".to_string())
        })
        .await?;
        parse_response(response)
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        run_proxy_lookup(slots, move || {
            crate::source_http_desktop_proxy::resolve_desktop_proxy(&url)
        })
        .await
    }
}

#[cfg(any(mobile, test))]
fn parse_response(
    response: tauri_plugin_native_bridge::SystemProxyResponse,
) -> Result<SystemProxyRoute, String> {
    use tauri_plugin_native_bridge::SystemProxyResponse;
    match response {
        SystemProxyResponse::Direct {} => Ok(SystemProxyRoute::Direct),
        SystemProxyResponse::Proxy { url } => {
            let endpoint = tauri::Url::parse(&url).map_err(|_| "SOURCE_HTTP_PROXY_FAILED")?;
            if !matches!(endpoint.scheme(), "http" | "https" | "socks5h") {
                return Err("SOURCE_HTTP_PROXY_UNSUPPORTED".into());
            }
            if url.len() > 16_384
                || endpoint.host_str().is_none()
                || endpoint.port_or_known_default().is_none()
                || endpoint.port() == Some(0)
                || !matches!(endpoint.path(), "" | "/")
                || endpoint.query().is_some()
                || endpoint.fragment().is_some()
            {
                return Err("SOURCE_HTTP_PROXY_FAILED".into());
            }
            Ok(SystemProxyRoute::Proxy(url))
        }
        SystemProxyResponse::Unsupported {} => Err("SOURCE_HTTP_PROXY_UNSUPPORTED".into()),
        SystemProxyResponse::Failed {} => Err("SOURCE_HTTP_PROXY_FAILED".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tauri_plugin_native_bridge::SystemProxyResponse;

    #[tokio::test]
    async fn cancelled_lookup_retains_slot_until_native_work_finishes() {
        let slots = Arc::new(Semaphore::new(1));
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let task = tokio::spawn(run_proxy_lookup(slots.clone(), move || {
            let _ = started.send(());
            let _ = finish.recv();
            Ok(())
        }));
        ready.await.unwrap();
        task.abort();
        let _ = task.await;
        assert_eq!(slots.available_permits(), 0);

        let invoked = Arc::new(AtomicBool::new(false));
        let marker = invoked.clone();
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            run_proxy_lookup(slots.clone(), move || {
                marker.store(true, Ordering::SeqCst);
                Ok(())
            })
        )
        .await
        .is_err());
        assert!(!invoked.load(Ordering::SeqCst));
        release.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(1),
                run_proxy_lookup(slots.clone(), || Ok(42))
            )
            .await
            .unwrap()
            .unwrap(),
            42
        );
        assert_eq!(slots.available_permits(), 1);
        assert!(!invoked.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn timed_out_lookup_cannot_start_another_background_query() {
        let slots = Arc::new(Semaphore::new(1));
        let worker_slots = slots.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let task = tokio::spawn(async move {
            tokio::time::timeout(
                Duration::from_secs(1),
                run_proxy_lookup(worker_slots, move || {
                    let _ = started.send(());
                    let _ = finish.recv();
                    Ok(())
                }),
            )
            .await
        });
        ready.await.unwrap();
        assert!(task.await.unwrap().is_err());
        assert_eq!(slots.available_permits(), 0);
        release.send(()).unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            run_proxy_lookup(slots.clone(), || Ok(())),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(slots.available_permits(), 1);
    }

    #[test]
    fn keeps_system_proxy_credentials_internal_and_accepts_remote_socks_dns() {
        for url in [
            "http://127.0.0.1:7890",
            "https://user:password@proxy.example:443",
            "socks5h://[::1]:1080",
        ] {
            assert!(matches!(
                parse_response(SystemProxyResponse::Proxy { url: url.into() }),
                Ok(SystemProxyRoute::Proxy(actual)) if actual == url
            ));
        }
    }

    #[test]
    fn unsupported_or_broken_routes_never_become_direct() {
        for (response, expected) in [
            (
                SystemProxyResponse::Unsupported {},
                "SOURCE_HTTP_PROXY_UNSUPPORTED",
            ),
            (SystemProxyResponse::Failed {}, "SOURCE_HTTP_PROXY_FAILED"),
            (
                SystemProxyResponse::Proxy {
                    url: "file:///secret".into(),
                },
                "SOURCE_HTTP_PROXY_UNSUPPORTED",
            ),
            (
                SystemProxyResponse::Proxy {
                    url: "http://secret:password@proxy.example:7890/path".into(),
                },
                "SOURCE_HTTP_PROXY_FAILED",
            ),
        ] {
            assert!(matches!(parse_response(response), Err(error) if error == expected));
        }
        assert!(matches!(
            parse_response(SystemProxyResponse::Direct {}),
            Ok(SystemProxyRoute::Direct)
        ));
    }
}

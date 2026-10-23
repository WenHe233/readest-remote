//! Transport for the local content-source host. The host owns source grants,
//! cookies and redirect decisions; this layer validates and pins each network hop.
use crate::source_http_policy::is_public_address;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, SET_COOKIE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Url;
use tokio_util::sync::CancellationToken;

const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
type RequestKey = (String, String);
const CANCELLATION_TTL: Duration = Duration::from_secs(120);
const MAX_EARLY_CANCELLATIONS: usize = 1024;
#[derive(Default)]
struct Requests {
    active: HashMap<RequestKey, CancellationToken>,
    cancelled: HashMap<RequestKey, Instant>,
    // At capacity, reject new requests until every potentially unrecorded
    // cancellation has outlived the maximum request duration. Never evict an
    // unexpired tombstone and accidentally allow its queued request to start.
    blocked_until: Option<Instant>,
}
impl Requests {
    fn prune(&mut self, now: Instant) {
        self.cancelled
            .retain(|_, at| now.duration_since(*at) < CANCELLATION_TTL);
        if self.blocked_until.is_some_and(|until| until <= now) {
            self.blocked_until = None;
        }
    }
    fn cancel(&mut self, key: RequestKey, now: Instant) {
        self.prune(now);
        if let Some(token) = self.active.get(&key) {
            token.cancel();
        } else if self.cancelled.len() < MAX_EARLY_CANCELLATIONS {
            self.cancelled.insert(key, now);
        } else {
            self.blocked_until = Some(now + CANCELLATION_TTL);
        }
    }
}
static REQUESTS: OnceLock<Mutex<Requests>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceHttpRequest {
    request_id: String,
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<Vec<u8>>,
    allow_private_network: bool,
    timeout_ms: u64,
    max_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHttpResponse {
    status: u16,
    url: String,
    headers: HashMap<String, String>,
    bytes: Vec<u8>,
    set_cookies: Vec<String>,
}

struct RequestLease(RequestKey);
impl Drop for RequestLease {
    fn drop(&mut self) {
        if let Ok(mut state) = requests().lock() {
            state.active.remove(&self.0);
        }
    }
}

fn requests() -> &'static Mutex<Requests> {
    REQUESTS.get_or_init(|| Mutex::new(Requests::default()))
}

fn validate(request: &SourceHttpRequest) -> Result<(Url, reqwest::Method, HeaderMap), String> {
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || request.timeout_ms == 0
        || request.timeout_ms > 120_000
        || request.max_bytes == 0
        || request.max_bytes > MAX_RESPONSE_BYTES
        || request
            .body
            .as_ref()
            .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
        || request.url.len() > 16_384
    {
        return Err("SOURCE_HTTP_INVALID_LIMITS".into());
    }
    let mut url = Url::parse(&request.url).map_err(|_| "SOURCE_HTTP_INVALID_URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("SOURCE_HTTP_INVALID_URL".into());
    }
    url.set_fragment(None);
    let method = request.method.to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err("SOURCE_HTTP_INVALID_METHOD".into());
    }
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "SOURCE_HTTP_INVALID_METHOD")?;
    if request.headers.len() > 100
        || request
            .headers
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>()
            > 32768
    {
        return Err("SOURCE_HTTP_INVALID_HEADERS".into());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "SOURCE_HTTP_INVALID_HEADERS")?;
        if matches!(
            name.as_str(),
            "host"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "upgrade"
                | "trailer"
                | "te"
                | "expect"
        ) || name.as_str().starts_with("proxy-")
            || name.as_str().starts_with("sec-")
        {
            return Err("SOURCE_HTTP_FORBIDDEN_HEADER".into());
        }
        let value = HeaderValue::from_str(value).map_err(|_| "SOURCE_HTTP_INVALID_HEADERS")?;
        if headers.insert(name, value).is_some() {
            return Err("SOURCE_HTTP_DUPLICATE_HEADER".into());
        }
    }
    Ok((url, method, headers))
}

async fn execute(request: &SourceHttpRequest) -> Result<SourceHttpResponse, String> {
    let (url, method, headers) = validate(request)?;
    let host = url
        .host_str()
        .ok_or("SOURCE_HTTP_INVALID_URL")?
        .trim_matches(['[', ']']);
    let port = url
        .port_or_known_default()
        .ok_or("SOURCE_HTTP_INVALID_URL")?;
    let addresses: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "SOURCE_HTTP_DNS_FAILED")?
            .collect()
    };
    if addresses.is_empty()
        || (!request.allow_private_network
            && addresses
                .iter()
                .any(|address| !is_public_address(address.ip())))
    {
        return Err("SOURCE_HTTP_PRIVATE_NETWORK_DENIED".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .resolve_to_addrs(host, &addresses)
        .timeout(Duration::from_millis(request.timeout_ms))
        .build()
        .map_err(|_| "SOURCE_HTTP_CLIENT_FAILED")?;
    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }
    let response = builder
        .send()
        .await
        .map_err(|_| "SOURCE_HTTP_NETWORK_FAILED")?;
    if response
        .content_length()
        .is_some_and(|size| size > request.max_bytes as u64)
    {
        return Err("SOURCE_HTTP_RESPONSE_TOO_LARGE".into());
    }
    let status = response.status().as_u16();
    let url = response.url().to_string();
    let set_cookies = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();
    let mut headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers() {
        if name == SET_COOKIE {
            continue;
        }
        let value = String::from_utf8_lossy(value.as_bytes());
        headers
            .entry(name.to_string())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value.into_owned());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "SOURCE_HTTP_NETWORK_FAILED")?;
        if chunk.len() > request.max_bytes - bytes.len() {
            return Err("SOURCE_HTTP_RESPONSE_TOO_LARGE".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(SourceHttpResponse {
        status,
        url,
        headers,
        bytes,
        set_cookies,
    })
}

async fn run_request(
    owner: &str,
    request: SourceHttpRequest,
) -> Result<SourceHttpResponse, String> {
    validate(&request)?;
    let key = (owner.to_owned(), request.request_id.clone());
    let token = CancellationToken::new();
    {
        let mut state = requests().lock().map_err(|_| "SOURCE_HTTP_STATE_FAILED")?;
        state.prune(Instant::now());
        // The cancel IPC can be dispatched before the async request IPC gets
        // its first poll. Record that event under this same lock, before DNS.
        if state.blocked_until.is_some() || state.cancelled.contains_key(&key) {
            return Err("SOURCE_HTTP_CANCELLED".into());
        }
        if state.active.len() >= 64 || state.active.contains_key(&key) {
            return Err("SOURCE_HTTP_REQUEST_CONFLICT".into());
        }
        state.active.insert(key.clone(), token.clone());
    }
    let _lease = RequestLease(key);
    tokio::select! {
        biased;
        _ = token.cancelled() => Err("SOURCE_HTTP_CANCELLED".into()),
        result = tokio::time::timeout(Duration::from_millis(request.timeout_ms), execute(&request)) => {
            result.map_err(|_| "SOURCE_HTTP_TIMEOUT".to_string())?
        }
    }
}

fn cancel(owner: &str, request_id: &str) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("SOURCE_HTTP_INVALID_LIMITS".into());
    }
    requests()
        .lock()
        .map_err(|_| "SOURCE_HTTP_STATE_FAILED")?
        .cancel((owner.to_owned(), request_id.to_owned()), Instant::now());
    Ok(())
}

#[tauri::command]
pub async fn source_http_request<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    request: SourceHttpRequest,
) -> Result<SourceHttpResponse, String> {
    run_request(window.label(), request).await
}

#[tauri::command]
pub fn source_http_cancel<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    request_id: String,
) -> Result<(), String> {
    cancel(window.label(), &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn request(url: &str) -> SourceHttpRequest {
        SourceHttpRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            url: url.into(),
            method: "GET".into(),
            headers: HashMap::new(),
            body: None,
            allow_private_network: false,
            timeout_ms: 1000,
            max_bytes: 1024,
        }
    }

    #[test]
    fn rejects_unsafe_urls_headers_and_limits() {
        for url in [
            "file:///secret",
            "https://user:password@example.org",
            "ftp://example.org",
        ] {
            assert!(validate(&request(url)).is_err());
        }
        for header in [
            "Host",
            "Content-Length",
            "Proxy-Authorization",
            "Transfer-Encoding",
            "Connection",
            "Sec-Fetch-Site",
        ] {
            let mut input = request("https://example.org");
            input.headers.insert(header.into(), "value".into());
            assert!(validate(&input).is_err(), "{header}");
        }
        let mut input = request("https://example.org");
        input.max_bytes = MAX_RESPONSE_BYTES + 1;
        assert!(validate(&input).is_err());
    }

    async fn server(response: &'static [u8]) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request).await;
            stream.write_all(response).await.unwrap();
        });
        (url, task)
    }

    #[tokio::test]
    async fn blocks_private_targets_and_returns_redirects_to_host() {
        assert_eq!(
            run_request("test", request("http://127.0.0.1:9"))
                .await
                .unwrap_err(),
            "SOURCE_HTTP_PRIVATE_NETWORK_DENIED"
        );
        let (url, task) = server(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\n\r\n").await;
        let mut input = request(&url);
        input.allow_private_network = true;
        let output = run_request("test", input).await.unwrap();
        assert_eq!(output.status, 302);
        assert_eq!(output.set_cookies, ["a=1", "b=2"]);
        assert!(!output.headers.contains_key("set-cookie"));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn bounds_streamed_response_and_releases_request_ids() {
        let (url, task) =
            server(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n")
                .await;
        let mut input = request(&url);
        input.allow_private_network = true;
        input.max_bytes = 4;
        let id = input.request_id.clone();
        assert_eq!(
            run_request("size-test", input).await.unwrap_err(),
            "SOURCE_HTTP_RESPONSE_TOO_LARGE"
        );
        assert!(!requests()
            .lock()
            .unwrap()
            .active
            .contains_key(&("size-test".into(), id)));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_registration_never_starts_the_request() {
        let input = request("http://127.0.0.1:9");
        cancel("early-cancel-test", &input.request_id).unwrap();
        assert_eq!(
            run_request("early-cancel-test", input).await.unwrap_err(),
            "SOURCE_HTTP_CANCELLED"
        );
    }

    #[tokio::test]
    async fn early_cancellation_does_not_cancel_another_windows_request() {
        let input = request("http://127.0.0.1:9");
        cancel("other-window", &input.request_id).unwrap();
        assert_eq!(
            run_request("original-window", input).await.unwrap_err(),
            "SOURCE_HTTP_PRIVATE_NETWORK_DENIED"
        );
    }

    #[test]
    fn early_cancellation_memory_is_bounded_without_evicting_live_tombstones() {
        let mut state = Requests::default();
        let now = Instant::now();
        for index in 0..=MAX_EARLY_CANCELLATIONS {
            state.cancel(("window".into(), index.to_string()), now);
        }
        assert_eq!(state.cancelled.len(), MAX_EARLY_CANCELLATIONS);
        assert_eq!(state.blocked_until, Some(now + CANCELLATION_TTL));
        assert!(state.cancelled.contains_key(&("window".into(), "0".into())));
        state.prune(now + CANCELLATION_TTL);
        assert!(state.cancelled.is_empty());
        assert!(state.blocked_until.is_none());
    }

    #[tokio::test]
    async fn cancellation_is_scoped_to_owner_and_releases_lease() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut input = request(&format!("http://{}", listener.local_addr().unwrap()));
        input.allow_private_network = true;
        let id = input.request_id.clone();
        let task = tokio::spawn(run_request("cancel-test", input));
        let (_stream, _) = listener.accept().await.unwrap();
        cancel("different-owner", &id).unwrap();
        assert!(!task.is_finished());
        cancel("cancel-test", &id).unwrap();
        assert_eq!(task.await.unwrap().unwrap_err(), "SOURCE_HTTP_CANCELLED");
        assert!(!requests()
            .lock()
            .unwrap()
            .active
            .contains_key(&("cancel-test".into(), id)));
    }
}

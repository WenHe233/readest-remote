use tauri_plugin_native_bridge::SystemProxyResponse;

#[test]
fn distinguishes_direct_proxy_and_unsupported_without_falling_back() {
    assert!(matches!(
        serde_json::from_str::<SystemProxyResponse>(r#"{"kind":"direct"}"#).unwrap(),
        SystemProxyResponse::Direct {}
    ));
    assert!(matches!(
        serde_json::from_str::<SystemProxyResponse>(
            r#"{"kind":"proxy","url":"socks5h://127.0.0.1:7890"}"#
        ).unwrap(),
        SystemProxyResponse::Proxy { url } if url == "socks5h://127.0.0.1:7890"
    ));
    assert!(matches!(
        serde_json::from_str::<SystemProxyResponse>(r#"{"kind":"unsupported"}"#).unwrap(),
        SystemProxyResponse::Unsupported {}
    ));
    assert!(matches!(
        serde_json::from_str::<SystemProxyResponse>(r#"{"kind":"failed"}"#).unwrap(),
        SystemProxyResponse::Failed {}
    ));
}

#[test]
fn rejects_incomplete_or_unrecognized_proxy_responses() {
    for value in [
        r#"{}"#,
        r#"{"kind":"proxy"}"#,
        r#"{"kind":"other"}"#,
        r#"{"kind":"direct","url":"http://127.0.0.1:7890"}"#,
    ] {
        assert!(serde_json::from_str::<SystemProxyResponse>(value).is_err());
    }
}

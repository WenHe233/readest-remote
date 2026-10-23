//! URL-specific desktop proxy selection; system endpoints never reach the guest.
use crate::source_http_proxy::SystemProxyRoute;

const FAILED: &str = "SOURCE_HTTP_PROXY_FAILED";
#[cfg(any(windows, target_os = "macos", test))]
const UNSUPPORTED: &str = "SOURCE_HTTP_PROXY_UNSUPPORTED";

pub fn resolve_desktop_proxy(url: &str) -> Result<SystemProxyRoute, String> {
    let url = tauri::Url::parse(url).map_err(|_| FAILED)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(FAILED.into());
    }
    // Preserve explicit command-line/environment proxy configuration and NO_PROXY.
    // reqwest applies those before consulting desktop static system settings.
    let scheme_keys = if url.scheme() == "https" {
        ["HTTPS_PROXY", "https_proxy"]
    } else {
        ["HTTP_PROXY", "http_proxy"]
    };
    if scheme_keys
        .into_iter()
        .chain(["ALL_PROXY", "all_proxy"])
        .any(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()))
    {
        return Ok(SystemProxyRoute::SystemDefault);
    }
    #[cfg(windows)]
    return windows::resolve(&url);
    #[cfg(target_os = "macos")]
    return macos::resolve(&url);
    #[cfg(not(any(windows, target_os = "macos")))]
    Ok(SystemProxyRoute::SystemDefault)
}

#[cfg(any(windows, test))]
fn windows_static_proxy(
    url: &tauri::Url,
    server: &str,
    bypass: &str,
) -> Result<SystemProxyRoute, String> {
    let host = url.host_str().ok_or(FAILED)?.to_ascii_lowercase();
    let host_port = format!("{}:{}", host, url.port_or_known_default().ok_or(FAILED)?);
    if bypass
        .split([';', ' ', '\t'])
        .filter(|part| !part.is_empty())
        .any(|part| {
            let pattern = part.to_ascii_lowercase();
            (pattern == "<local>" && !host.contains('.'))
                || wildcard_match(&pattern, &host)
                || wildcard_match(&pattern, &host_port)
        })
    {
        return Ok(SystemProxyRoute::Direct);
    }
    let server = server.trim();
    if server.is_empty() {
        return Ok(SystemProxyRoute::Direct);
    }
    let mut selected = None;
    let mut default = None;
    let mut socks = None;
    for entry in server
        .split(|character: char| character == ';' || character.is_ascii_whitespace())
        .filter(|entry| !entry.is_empty())
    {
        if let Some((scheme, address)) = entry.split_once('=') {
            if scheme.eq_ignore_ascii_case(url.scheme()) {
                selected.get_or_insert(address);
            } else if scheme.eq_ignore_ascii_case("socks") {
                socks.get_or_insert(address);
            }
        } else {
            default.get_or_insert(entry);
        }
    }
    let (address, default_scheme) = match (selected.or(default), socks) {
        (Some(address), _) => (address, "http"),
        // WinINet's legacy SOCKS setting uses SOCKS4; the 'a' suffix keeps DNS at the proxy.
        (None, Some(address)) => (address, "socks4a"),
        (None, None) => return Ok(SystemProxyRoute::Direct),
    };
    if address.is_empty() || address.contains([';', ' ', '\t']) {
        return Err(FAILED.into());
    }
    proxy_endpoint(address, default_scheme)
}

#[cfg(any(windows, test))]
fn wildcard_match(pattern: &str, value: &str) -> bool {
    let (pattern, value) = (pattern.as_bytes(), value.as_bytes());
    let (mut p, mut v, mut star, mut restart) = (0, 0, None, 0);
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            restart = v;
        } else if let Some(position) = star {
            p = position + 1;
            restart += 1;
            v = restart;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(any(windows, test))]
fn proxy_endpoint(address: &str, default_scheme: &str) -> Result<SystemProxyRoute, String> {
    let address = if address.contains("://") {
        address.to_owned()
    } else {
        format!("{default_scheme}://{address}")
    };
    let endpoint = tauri::Url::parse(&address).map_err(|_| FAILED)?;
    if !matches!(
        endpoint.scheme(),
        "http" | "https" | "socks4a" | "socks5h" | "socks5"
    ) {
        return Err(UNSUPPORTED.into());
    }
    if endpoint.host_str().is_none()
        || endpoint.port() == Some(0)
        || !matches!(endpoint.path(), "" | "/")
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(FAILED.into());
    }
    Ok(SystemProxyRoute::Proxy(endpoint.to_string()))
}

#[cfg(any(windows, test))]
fn auto_configuration_allows_static_fallback(explicit_url: bool, error: i32) -> bool {
    // No discovered configuration, an unavailable WPAD script or non-PAC content
    // permits the user's static configuration. Other failures remain visible.
    !explicit_url && matches!(error, 12180 | 12167 | 12166)
}

#[cfg(any(target_os = "macos", test))]
fn set_system_proxy_host(endpoint: &mut tauri::Url, host: &str) -> Result<(), String> {
    let address = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = address.parse::<std::net::IpAddr>() {
        return endpoint.set_ip_host(address).map_err(|_| FAILED.into());
    }
    // URL::set_host treats an unbracketed colon as a port separator and can
    // silently truncate an IPv6 address. Invalid IP syntax must remain an error.
    if host.contains(':') {
        return Err(FAILED.into());
    }
    endpoint.set_host(Some(host)).map_err(|_| FAILED.into())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    #[derive(Default)]
    struct IeProxyConfig {
        auto_detect: i32,
        auto_config_url: *mut u16,
        proxy: *mut u16,
        bypass: *mut u16,
    }

    #[repr(C)]
    struct AutoProxyOptions {
        flags: u32,
        detect_flags: u32,
        config_url: *const u16,
        reserved: *mut c_void,
        reserved_flags: u32,
        auto_logon: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ProxyInfo {
        access_type: u32,
        proxy: *mut u16,
        bypass: *mut u16,
    }

    #[link(name = "winhttp")]
    extern "system" {
        fn WinHttpGetIEProxyConfigForCurrentUser(config: *mut IeProxyConfig) -> i32;
        fn WinHttpOpen(
            agent: *const u16,
            access_type: u32,
            proxy: *const u16,
            bypass: *const u16,
            flags: u32,
        ) -> *mut c_void;
        fn WinHttpSetTimeouts(
            session: *mut c_void,
            resolve: i32,
            connect: i32,
            send: i32,
            receive: i32,
        ) -> i32;
        fn WinHttpGetProxyForUrl(
            session: *mut c_void,
            url: *const u16,
            options: *const AutoProxyOptions,
            info: *mut ProxyInfo,
        ) -> i32;
        fn WinHttpCloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalFree(memory: *mut c_void) -> *mut c_void;
    }

    impl Drop for IeProxyConfig {
        fn drop(&mut self) {
            for pointer in [self.auto_config_url, self.proxy, self.bypass] {
                if !pointer.is_null() {
                    unsafe {
                        GlobalFree(pointer.cast());
                    }
                }
            }
        }
    }

    impl Drop for ProxyInfo {
        fn drop(&mut self) {
            for pointer in [self.proxy, self.bypass] {
                if !pointer.is_null() {
                    unsafe {
                        GlobalFree(pointer.cast());
                    }
                }
            }
        }
    }

    struct Session(*mut c_void);
    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                WinHttpCloseHandle(self.0);
            }
        }
    }

    unsafe fn string(pointer: *const u16) -> Result<String, String> {
        if pointer.is_null() {
            return Ok(String::new());
        }
        let mut length = 0;
        while length < 16_384 && *pointer.add(length) != 0 {
            length += 1;
        }
        if length == 16_384 {
            return Err(FAILED.into());
        }
        String::from_utf16(std::slice::from_raw_parts(pointer, length)).map_err(|_| FAILED.into())
    }

    // WPAD is often enabled by default. Ask WinHTTP to load/evaluate the script
    // for this URL, rather than treating a Fake-IP answer for "wpad" as a PAC.
    fn automatic_route(
        url: &tauri::Url,
        configured_url: Option<&str>,
    ) -> Result<Option<SystemProxyRoute>, String> {
        let agent: Vec<u16> = "Readest Remote X\0".encode_utf16().collect();
        let session =
            Session(unsafe { WinHttpOpen(agent.as_ptr(), 1, ptr::null(), ptr::null(), 0) });
        if session.0.is_null() {
            return Err(FAILED.into());
        }
        if unsafe { WinHttpSetTimeouts(session.0, 2000, 2000, 2000, 2000) } == 0 {
            return Err(FAILED.into());
        }
        let destination: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
        let config_url: Vec<u16> = configured_url
            .unwrap_or_default()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let options = AutoProxyOptions {
            flags: if configured_url.is_some() { 2 } else { 1 },
            detect_flags: if configured_url.is_some() { 0 } else { 3 },
            config_url: if configured_url.is_some() {
                config_url.as_ptr()
            } else {
                ptr::null()
            },
            reserved: ptr::null_mut(),
            reserved_flags: 0,
            auto_logon: 0,
        };
        let mut info = ProxyInfo::default();
        if unsafe { WinHttpGetProxyForUrl(session.0, destination.as_ptr(), &options, &mut info) }
            == 0
        {
            let error = std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default();
            return if auto_configuration_allows_static_fallback(configured_url.is_some(), error) {
                Ok(None)
            } else {
                Err(FAILED.into())
            };
        }
        match info.access_type {
            1 => Ok(Some(SystemProxyRoute::Direct)),
            3 => {
                let server = unsafe { string(info.proxy)? };
                if server.trim().is_empty() {
                    return Err(FAILED.into());
                }
                windows_static_proxy(url, &server, &unsafe { string(info.bypass)? }).map(Some)
            }
            _ => Err(FAILED.into()),
        }
    }

    pub(super) fn resolve(url: &tauri::Url) -> Result<SystemProxyRoute, String> {
        let mut config = IeProxyConfig::default();
        if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } == 0 {
            return if std::io::Error::last_os_error().raw_os_error() == Some(2) {
                Ok(SystemProxyRoute::Direct)
            } else {
                Err(FAILED.into())
            };
        }
        let pac_url = unsafe { string(config.auto_config_url)? };
        if !pac_url.trim().is_empty() {
            return automatic_route(url, Some(&pac_url))?.ok_or_else(|| FAILED.into());
        }
        if config.auto_detect != 0 {
            if let Some(route) = automatic_route(url, None)? {
                return Ok(route);
            }
        }
        windows_static_proxy(url, &unsafe { string(config.proxy)? }, &unsafe {
            string(config.bypass)?
        })
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{c_char, c_void};
    use std::ptr;

    type CfRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CFNetwork", kind = "framework")]
    extern "C" {
        fn CFNetworkCopySystemProxySettings() -> CfRef;
        fn CFNetworkCopyProxiesForURL(url: CfRef, settings: CfRef) -> CfRef;
        static kCFProxyTypeKey: CfRef;
        static kCFProxyTypeNone: CfRef;
        static kCFProxyTypeHTTP: CfRef;
        static kCFProxyTypeHTTPS: CfRef;
        static kCFProxyTypeSOCKS: CfRef;
        static kCFProxyHostNameKey: CfRef;
        static kCFProxyPortNumberKey: CfRef;
        static kCFProxyUsernameKey: CfRef;
        static kCFProxyPasswordKey: CfRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: CfRef);
        fn CFEqual(left: CfRef, right: CfRef) -> u8;
        fn CFGetTypeID(value: CfRef) -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFDictionaryGetTypeID() -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFArrayGetCount(array: CfRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CfRef, index: isize) -> CfRef;
        fn CFDictionaryGetValue(dictionary: CfRef, key: CfRef) -> CfRef;
        fn CFStringGetLength(string: CfRef) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(string: CfRef, buffer: *mut c_char, size: isize, encoding: u32)
            -> u8;
        fn CFNumberGetValue(number: CfRef, number_type: isize, value: *mut c_void) -> u8;
        fn CFURLCreateWithBytes(
            allocator: CfRef,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            base: CfRef,
        ) -> CfRef;
    }

    struct Owned(CfRef);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CFRelease(self.0);
                }
            }
        }
    }

    unsafe fn string(value: CfRef) -> Result<Option<String>, String> {
        if value.is_null() {
            return Ok(None);
        }
        if CFGetTypeID(value) != CFStringGetTypeID() {
            return Err(FAILED.into());
        }
        let length = CFStringGetLength(value);
        if !(0..=16_384).contains(&length) {
            return Err(FAILED.into());
        }
        let size = CFStringGetMaximumSizeForEncoding(length, UTF8) + 1;
        if !(1..=65_537).contains(&size) {
            return Err(FAILED.into());
        }
        let mut buffer = vec![0u8; size as usize];
        if CFStringGetCString(value, buffer.as_mut_ptr().cast(), size, UTF8) == 0 {
            return Err(FAILED.into());
        }
        let end = buffer.iter().position(|byte| *byte == 0).ok_or(FAILED)?;
        String::from_utf8(buffer[..end].to_vec())
            .map(Some)
            .map_err(|_| FAILED.into())
    }

    pub(super) fn resolve(url: &tauri::Url) -> Result<SystemProxyRoute, String> {
        // CopyProxiesForURL applies the OS bypass list and SOCKS/HTTP selection.
        // PAC entries remain unsupported instead of silently becoming DIRECT.
        unsafe {
            let settings = Owned(CFNetworkCopySystemProxySettings());
            if settings.0.is_null() {
                return Ok(SystemProxyRoute::Direct);
            }
            if CFGetTypeID(settings.0) != CFDictionaryGetTypeID() {
                return Err(FAILED.into());
            }
            let text = url.as_str().as_bytes();
            let native_url = Owned(CFURLCreateWithBytes(
                ptr::null(),
                text.as_ptr(),
                text.len() as isize,
                UTF8,
                ptr::null(),
            ));
            if native_url.0.is_null() {
                return Err(FAILED.into());
            }
            let entries = Owned(CFNetworkCopyProxiesForURL(native_url.0, settings.0));
            if entries.0.is_null()
                || CFGetTypeID(entries.0) != CFArrayGetTypeID()
                || CFArrayGetCount(entries.0) == 0
            {
                return Err(FAILED.into());
            }
            let first = CFArrayGetValueAtIndex(entries.0, 0);
            if first.is_null() || CFGetTypeID(first) != CFDictionaryGetTypeID() {
                return Err(FAILED.into());
            }
            let kind = CFDictionaryGetValue(first, kCFProxyTypeKey);
            if kind.is_null() {
                return Err(FAILED.into());
            }
            if CFEqual(kind, kCFProxyTypeNone) != 0 {
                return Ok(SystemProxyRoute::Direct);
            }
            let scheme =
                if CFEqual(kind, kCFProxyTypeHTTP) != 0 || CFEqual(kind, kCFProxyTypeHTTPS) != 0 {
                    "http" // HTTPS destination via HTTP CONNECT, not a TLS proxy endpoint.
                } else if CFEqual(kind, kCFProxyTypeSOCKS) != 0 {
                    "socks5h"
                } else {
                    return Err(UNSUPPORTED.into());
                };
            let host = string(CFDictionaryGetValue(first, kCFProxyHostNameKey))?.ok_or(FAILED)?;
            let number = CFDictionaryGetValue(first, kCFProxyPortNumberKey);
            if number.is_null() || CFGetTypeID(number) != CFNumberGetTypeID() {
                return Err(FAILED.into());
            }
            let mut port: i64 = 0;
            if CFNumberGetValue(number, 4, (&mut port as *mut i64).cast()) == 0
                || !(1..=65535).contains(&port)
            {
                return Err(FAILED.into());
            }
            let mut endpoint =
                tauri::Url::parse(&format!("{scheme}://localhost")).map_err(|_| FAILED)?;
            set_system_proxy_host(&mut endpoint, &host)?;
            endpoint.set_port(Some(port as u16)).map_err(|_| FAILED)?;
            if let Some(user) = string(CFDictionaryGetValue(first, kCFProxyUsernameKey))? {
                endpoint.set_username(&user).map_err(|_| FAILED)?;
            }
            if let Some(password) = string(CFDictionaryGetValue(first, kCFProxyPasswordKey))? {
                endpoint.set_password(Some(&password)).map_err(|_| FAILED)?;
            }
            Ok(SystemProxyRoute::Proxy(endpoint.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_proxy_hosts_preserve_ipv6_with_or_without_brackets() {
        for (host, expected) in [
            ("::1", "[::1]"),
            ("[::1]", "[::1]"),
            ("2001:db8::1", "[2001:db8::1]"),
            ("[2001:db8::1]", "[2001:db8::1]"),
            ("127.0.0.1", "127.0.0.1"),
            ("proxy.example", "proxy.example"),
        ] {
            for scheme in ["http", "socks5h"] {
                let mut endpoint = tauri::Url::parse(&format!("{scheme}://localhost")).unwrap();
                set_system_proxy_host(&mut endpoint, host).unwrap();
                endpoint.set_port(Some(7890)).unwrap();
                assert_eq!(endpoint.host_str(), Some(expected), "{scheme} {host}");
            }
        }
    }

    fn route(url: &str, server: &str, bypass: &str) -> Result<SystemProxyRoute, String> {
        windows_static_proxy(&tauri::Url::parse(url).unwrap(), server, bypass)
    }

    #[test]
    fn selects_proxy_for_destination_protocol_without_dns_lookup() {
        assert!(
            matches!(route("https://source.invalid/", "http=proxy.example:80;https=secure.example:8080", ""), Ok(SystemProxyRoute::Proxy(url)) if url == "http://secure.example:8080/")
        );
        assert!(
            matches!(route("http://source.invalid/", "proxy.example:7890", ""), Ok(SystemProxyRoute::Proxy(url)) if url == "http://proxy.example:7890/")
        );
        assert!(matches!(
            route("https://source.invalid/", "http=proxy.example:80", ""),
            Ok(SystemProxyRoute::Direct)
        ));
    }

    #[test]
    fn uses_socks_remote_dns_when_only_socks_is_configured() {
        assert!(
            matches!(route("https://source.invalid/", "socks=socks.example:1080", ""), Ok(SystemProxyRoute::Proxy(url)) if url == "socks4a://socks.example:1080")
        );
    }

    #[test]
    fn honors_windows_bypass_wildcards_local_names_and_ports() {
        for (url, bypass) in [
            ("https://books.example/", "BOOKS.EXAMPLE"),
            ("https://a.books.example/", "*.books.example"),
            ("http://intranet/", "<local>"),
            ("https://books.example:8443/", "books.example:8443"),
            ("https://anything.example/", "*"),
        ] {
            assert!(
                matches!(
                    route(url, "proxy.example:7890", bypass),
                    Ok(SystemProxyRoute::Direct)
                ),
                "{url}"
            );
        }
        assert!(matches!(
            route(
                "https://books.example/",
                "proxy.example:7890",
                "*.books.example; books.example:8443"
            ),
            Ok(SystemProxyRoute::Proxy(_))
        ));
    }

    #[test]
    fn malformed_proxy_configuration_never_falls_back_or_discloses_values() {
        for server in [
            "http=;http=two.example:80",
            "http://proxy.example/path",
            "http://proxy.example:0",
            "file:///private/config",
        ] {
            assert!(
                matches!(route("http://source.invalid/", server, ""), Err(error) if error == FAILED || error == UNSUPPORTED)
            );
        }
    }

    #[test]
    fn keeps_the_first_system_candidate_for_each_protocol() {
        for server in [
            "first.example:8080;second.example:8080",
            "first.example:8080 second.example:8080",
            "https=first.example:8080;https=second.example:8080",
            "http=other.example:80\thttps=first.example:8080 https=second.example:8080",
            "https=first.example:8080;DIRECT",
        ] {
            assert!(
                matches!(route("https://source.invalid/", server, ""), Ok(SystemProxyRoute::Proxy(url)) if url == "http://first.example:8080/"),
                "{server}"
            );
        }
    }

    #[test]
    fn optional_automatic_discovery_falls_back_only_when_no_usable_script_exists() {
        for error in [12180, 12167, 12166] {
            assert!(auto_configuration_allows_static_fallback(false, error));
            assert!(!auto_configuration_allows_static_fallback(true, error));
        }
        for error in [0, 5, 12002, 12015, 12175, 12178] {
            assert!(!auto_configuration_allows_static_fallback(false, error));
            assert!(!auto_configuration_allows_static_fallback(true, error));
        }
    }
}

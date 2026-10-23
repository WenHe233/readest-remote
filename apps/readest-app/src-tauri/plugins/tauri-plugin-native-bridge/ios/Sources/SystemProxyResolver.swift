import CFNetwork
import Foundation

enum SystemProxyResolver {
  static func resolve(_ value: String) -> [String: Any] {
    guard let url = URL(string: value),
      let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
      url.host != nil
    else { return ["kind": "failed"] }

    guard let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() else {
      // CFNetwork documents nil when no proxy configuration is defined.
      return ["kind": "direct"]
    }
    return select(url, settings: settings)
  }

  static func select(_ url: URL, settings: CFDictionary) -> [String: Any] {
    let proxies = CFNetworkCopyProxiesForURL(url as CFURL, settings).takeRetainedValue()
    guard let entries = proxies as? [[String: Any]] else { return ["kind": "failed"] }
    return interpret(entries)
  }

  static func interpret(_ entries: [[String: Any]]) -> [String: Any] {
    guard let first = entries.first,
      let type = first[kCFProxyTypeKey as String] as? String
    else { return ["kind": "failed"] }

    if type == kCFProxyTypeNone as String { return ["kind": "direct"] }
    // Never ignore a PAC decision and silently switch to a direct connection.
    // CFNetwork's PAC entries require a separate asynchronous run-loop evaluator.
    if type == kCFProxyTypeAutoConfigurationURL as String
      || type == kCFProxyTypeAutoConfigurationJavaScript as String
    {
      return ["kind": "unsupported"]
    }
    let proxyScheme: String
    switch type {
    // CFNetwork's HTTPS type means HTTP CONNECT for an HTTPS destination,
    // not a TLS connection to the proxy itself.
    case kCFProxyTypeHTTP as String, kCFProxyTypeHTTPS as String: proxyScheme = "http"
    case kCFProxyTypeSOCKS as String: proxyScheme = "socks5h"
    default: return ["kind": "unsupported"]
    }
    guard let host = first[kCFProxyHostNameKey as String] as? String, !host.isEmpty,
      let port = first[kCFProxyPortNumberKey as String] as? NSNumber,
      (1...65535).contains(port.intValue)
    else { return ["kind": "failed"] }
    var endpoint = URLComponents()
    endpoint.scheme = proxyScheme
    // URLComponents expects the RFC 3986 brackets around an IPv6 host.
    endpoint.host = host.contains(":") && !(host.hasPrefix("[") && host.hasSuffix("]"))
      ? "[\(host)]" : host
    endpoint.port = port.intValue
    endpoint.user = first[kCFProxyUsernameKey as String] as? String
    endpoint.password = first[kCFProxyPasswordKey as String] as? String
    guard let proxyURL = endpoint.url?.absoluteString else { return ["kind": "failed"] }
    // This response stays in native/Rust code. Do not log the endpoint: the
    // system dictionary may contain proxy authentication information.
    return ["kind": "proxy", "url": proxyURL]
  }
}

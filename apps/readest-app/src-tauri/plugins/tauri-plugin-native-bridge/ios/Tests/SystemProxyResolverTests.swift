import CFNetwork
import Foundation

// Run on macOS with swiftc Sources/SystemProxyResolver.swift
// Tests/SystemProxyResolverTests.swift -o <test-binary>, then run the binary.
@main
struct SystemProxyResolverTests {
  static func main() {
    func proxy(_ type: CFString, _ host: String = "127.0.0.1", _ port: Int = 7890)
      -> [String: Any]
    {
      [kCFProxyTypeKey as String: type, kCFProxyHostNameKey as String: host,
       kCFProxyPortNumberKey as String: port]
    }
    func kind(_ entries: [[String: Any]]) -> String? {
      SystemProxyResolver.interpret(entries)["kind"] as? String
    }
    let direct: [String: Any] = [kCFProxyTypeKey as String: kCFProxyTypeNone]
    precondition(kind([direct, proxy(kCFProxyTypeHTTP)]) == "direct")
    precondition(kind([]) == "failed")
    for type in [kCFProxyTypeHTTP, kCFProxyTypeHTTPS] {
      let result = SystemProxyResolver.interpret([proxy(type)])
      precondition(result["kind"] as? String == "proxy")
      precondition(result["url"] as? String == "http://127.0.0.1:7890")
    }
    let socks = SystemProxyResolver.interpret([proxy(kCFProxyTypeSOCKS, "proxy.example", 1080)])
    precondition(socks["url"] as? String == "socks5h://proxy.example:1080")
    for (host, expected) in [
      ("::1", "[::1]"), ("[::1]", "[::1]"),
      ("2001:db8::1", "[2001:db8::1]"), ("[2001:db8::1]", "[2001:db8::1]")
    ] {
      for (type, scheme) in [(kCFProxyTypeHTTPS, "http"), (kCFProxyTypeSOCKS, "socks5h")] {
        let result = SystemProxyResolver.interpret([proxy(type, host, 7890)])
        precondition(result["url"] as? String == "\(scheme)://\(expected):7890")
      }
    }
    for type in [kCFProxyTypeAutoConfigurationURL, kCFProxyTypeAutoConfigurationJavaScript] {
      precondition(kind([[kCFProxyTypeKey as String: type], direct]) == "unsupported")
    }
    precondition(kind([proxy(kCFProxyTypeHTTP, "127.0.0.1", 0), direct]) == "failed")
    precondition(kind([proxy(kCFProxyTypeFTP), direct]) == "unsupported")
    let settings: CFDictionary = [
      "HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": 7890,
      "HTTPSEnable": 1, "HTTPSProxy": "127.0.0.1", "HTTPSPort": 7890,
      "ExceptionsList": ["bypass.example"]
    ] as CFDictionary
    for scheme in ["http", "https"] {
      let proxied = SystemProxyResolver.select(URL(string: "\(scheme)://public.example/")!, settings: settings)
      precondition(proxied["url"] as? String == "http://127.0.0.1:7890")
      let bypassed = SystemProxyResolver.select(URL(string: "\(scheme)://bypass.example/")!, settings: settings)
      precondition(bypassed["kind"] as? String == "direct")
    }
    print("System proxy resolver tests passed")
  }
}

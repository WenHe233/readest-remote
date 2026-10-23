use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// RFC 6052 prefix learned from the system resolver, never from a source script.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Nat64Prefix {
    bytes: [u8; 16],
    length: usize,
}

impl Nat64Prefix {
    fn matches(&self, address: Ipv6Addr) -> bool {
        address.octets()[..self.length / 8] == self.bytes[..self.length / 8]
    }

    fn extract(&self, address: Ipv6Addr) -> Option<Ipv4Addr> {
        if !self.matches(address) {
            return None;
        }
        let bytes = address.octets();
        let mut result = [0; 4];
        let mut offset = self.length / 8;
        for byte in &mut result {
            if offset == 8 {
                offset += 1; // Reserved u octet in every prefix shorter than /96.
            }
            *byte = bytes[offset];
            offset += 1;
        }
        if self.length != 96 && (bytes[8] != 0 || bytes[offset..].iter().any(|b| *b != 0)) {
            return None;
        }
        Some(Ipv4Addr::from(result))
    }
}

// A well-known IPv4 value may also occur inside the network prefix. RFC 7050
// requires trying the other well-known address when that makes an answer
// ambiguous. Account for the reserved u octet when the value crosses bit 64.
fn well_known_occurrences(address: Ipv6Addr, value: Ipv4Addr) -> usize {
    let bytes = address.octets();
    let expected = value.octets();
    let mut starts = [false; 16];
    for (found, window) in starts.iter_mut().zip(bytes.windows(4)) {
        *found = window == expected;
    }
    for (start, matches) in starts.iter_mut().enumerate().take(8).skip(5) {
        let found: [u8; 4] = std::array::from_fn(|i| {
            let offset = start + i;
            bytes[if offset >= 8 { offset + 1 } else { offset }]
        });
        *matches |= found == expected;
    }
    starts.into_iter().filter(|found| *found).count()
}

/// RFC 7050 permits one or more answers. A single unambiguous synthesized
/// well-known address identifies a prefix; malformed or ambiguous answers do not.
pub fn discover_nat64_prefixes(addresses: &[IpAddr]) -> Vec<Nat64Prefix> {
    let mut prefixes = Vec::new();
    for address in addresses {
        let IpAddr::V6(address) = address else {
            continue;
        };
        for length in [32, 40, 48, 56, 64, 96] {
            let mut bytes = address.octets();
            bytes[length / 8..].fill(0);
            let prefix = Nat64Prefix { bytes, length };
            let unambiguous = prefix.extract(*address).is_some_and(|ip| {
                matches!(ip.octets(), [192, 0, 0, 170] | [192, 0, 0, 171])
                    && well_known_occurrences(*address, ip) == 1
            });
            if unambiguous && !prefixes.contains(&prefix) {
                prefixes.push(prefix);
            }
        }
    }
    prefixes
}

pub fn nat64_discovery_is_complete(addresses: &[IpAddr], prefixes: &[Nat64Prefix]) -> bool {
    !addresses.is_empty()
        && addresses.iter().all(|address| match address {
            IpAddr::V4(ip) => matches!(ip.octets(), [192, 0, 0, 170] | [192, 0, 0, 171]),
            IpAddr::V6(address) => prefixes.iter().any(|prefix| {
                prefix
                    .extract(*address)
                    .is_some_and(|ip| matches!(ip.octets(), [192, 0, 0, 170] | [192, 0, 0, 171]))
            }),
        })
}

pub fn is_public_address_with_nat64(ip: IpAddr, prefixes: &[Nat64Prefix]) -> bool {
    if let IpAddr::V6(address) = ip {
        // Check discovered prefixes before the native global range: a network
        // may use a global unicast prefix to translate a private IPv4 target.
        if let Some(prefix) = prefixes.iter().find(|prefix| prefix.matches(address)) {
            return prefix
                .extract(address)
                .is_some_and(|ip| is_public_address(IpAddr::V4(ip)));
        }
    }
    is_public_address(ip)
}

pub fn is_public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                let bytes = ip.octets();
                return is_public_address(IpAddr::V4(Ipv4Addr::new(
                    bytes[12], bytes[13], bytes[14], bytes[15],
                )));
            }
            // Permit native global unicast: excludes mapped IPv4,
            // link/local, multicast and transition ranges with embedded IPv4.
            (segments[0] & 0xe000) == 0x2000
                && segments[0] != 0x2002
                && !(segments[0] == 0x2001 && (segments[1] < 0x200 || segments[1] == 0xdb8))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic(length: usize, ipv4: [u8; 4]) -> IpAddr {
        let mut bytes = "2001:4860:1234:5678::"
            .parse::<Ipv6Addr>()
            .unwrap()
            .octets();
        bytes[length / 8..].fill(0);
        let mut offset = length / 8;
        for byte in ipv4 {
            if offset == 8 {
                offset += 1;
            }
            bytes[offset] = byte;
            offset += 1;
        }
        IpAddr::V6(Ipv6Addr::from(bytes))
    }

    #[test]
    fn accepts_a_single_unambiguous_dns64_answer() {
        for length in [32, 40, 48, 56, 64, 96] {
            for last in [170, 171] {
                let answers = [synthetic(length, [192, 0, 0, last])];
                let prefixes = discover_nat64_prefixes(&answers);
                assert_eq!(prefixes.len(), 1, "prefix /{length}, answer {last}");
                assert!(nat64_discovery_is_complete(&answers, &prefixes));
                assert!(is_public_address_with_nat64(
                    synthetic(length, [8, 8, 8, 8]),
                    &prefixes
                ));
                assert!(!is_public_address_with_nat64(
                    synthetic(length, [127, 0, 0, 1]),
                    &prefixes
                ));
            }
        }
    }

    #[test]
    fn uses_the_other_well_known_address_to_resolve_an_ambiguous_answer() {
        let ambiguous = "2001:4860:c000:aa::c000:aa".parse().unwrap();
        assert!(discover_nat64_prefixes(&[ambiguous]).is_empty());
        let answers = [ambiguous, "2001:4860:c000:aa::c000:ab".parse().unwrap()];
        let prefixes = discover_nat64_prefixes(&answers);
        assert_eq!(prefixes.len(), 1);
        assert!(nat64_discovery_is_complete(&answers, &prefixes));
        assert!(!is_public_address_with_nat64(
            "2001:4860:c000:aa::7f00:1".parse().unwrap(),
            &prefixes
        ));
    }

    #[test]
    fn system_nat64_prefixes_validate_the_translated_target() {
        assert!(!nat64_discovery_is_complete(&[], &[]));
        assert!(!nat64_discovery_is_complete(
            &["8.8.8.8".parse().unwrap()],
            &[]
        ));
        assert!(nat64_discovery_is_complete(
            &[
                "192.0.0.170".parse().unwrap(),
                "192.0.0.171".parse().unwrap()
            ],
            &[]
        ));
        for length in [32, 40, 48, 56, 64, 96] {
            let answers = [
                synthetic(length, [192, 0, 0, 170]),
                synthetic(length, [192, 0, 0, 171]),
            ];
            assert_eq!(discover_nat64_prefixes(&answers[..1]).len(), 1);
            assert!(!nat64_discovery_is_complete(&answers[..1], &[]));
            let prefixes = discover_nat64_prefixes(&answers);
            assert_eq!(prefixes.len(), 1);
            assert!(nat64_discovery_is_complete(&answers, &prefixes));
            assert!(is_public_address_with_nat64(
                synthetic(length, [8, 8, 8, 8]),
                &prefixes
            ));
            for ip in [
                [127, 0, 0, 1],
                [10, 1, 1, 1],
                [169, 254, 169, 254],
                [192, 168, 1, 1],
            ] {
                assert!(!is_public_address_with_nat64(
                    synthetic(length, ip),
                    &prefixes
                ));
            }
            if length != 96 {
                let IpAddr::V6(ip) = synthetic(length, [8, 8, 8, 8]) else {
                    unreachable!()
                };
                let mut malformed = ip.octets();
                malformed[8] = 1;
                assert!(!is_public_address_with_nat64(
                    IpAddr::V6(malformed.into()),
                    &prefixes
                ));
                malformed[8] = 0;
                malformed[15] = 1;
                assert!(!is_public_address_with_nat64(
                    IpAddr::V6(malformed.into()),
                    &prefixes
                ));
            }
        }
    }

    #[test]
    fn rejects_local_reserved_and_embedded_private_addresses() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.31.1.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.1.1",
            "198.18.1.1",
            "192.0.2.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "64:ff9b::a00:1",
            "2002:7f00:1::",
            "2001:db8::1",
        ] {
            assert!(!is_public_address(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn allows_public_addresses() {
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "64:ff9b::808:808",
        ] {
            assert!(is_public_address(address.parse().unwrap()), "{address}");
        }
    }
}

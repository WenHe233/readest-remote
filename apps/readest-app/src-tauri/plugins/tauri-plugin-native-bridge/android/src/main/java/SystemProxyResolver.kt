package com.readest.native_bridge

import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.URI
import java.util.Locale

internal sealed class SystemProxyRoute {
    object Direct : SystemProxyRoute()
    object Failed : SystemProxyRoute()
    object Unsupported : SystemProxyRoute()
    data class Forward(val url: String) : SystemProxyRoute() {
        override fun toString() = "SystemProxyRoute.Forward([redacted])"
    }
}

internal object SystemProxyResolver {
    fun resolve(url: String, selector: ProxySelector? = ProxySelector.getDefault()): SystemProxyRoute {
        return try {
            val destination = URI(url)
            if (destination.scheme?.lowercase(Locale.ROOT) !in listOf("http", "https") || destination.host.isNullOrEmpty()) {
                return SystemProxyRoute.Failed
            }
            if (selector == null) return SystemProxyRoute.Direct
            // Android's selector applies the system bypass rules and PAC service.
            // Do not resolve the destination or skip a failed first proxy to DIRECT.
            val proxy = selector.select(destination)?.firstOrNull() ?: return SystemProxyRoute.Failed
            if (proxy.type() == Proxy.Type.DIRECT) return SystemProxyRoute.Direct
            val scheme = when (proxy.type()) {
                Proxy.Type.HTTP -> "http"
                Proxy.Type.SOCKS -> "socks5h"
                else -> return SystemProxyRoute.Unsupported
            }
            val endpoint = proxy.address() as? InetSocketAddress ?: return SystemProxyRoute.Failed
            if (endpoint.port !in 1..65535 || endpoint.hostString.isEmpty()) return SystemProxyRoute.Failed
            val proxyUrl = URI(scheme, null, endpoint.hostString, endpoint.port, null, null, null).toASCIIString()
            SystemProxyRoute.Forward(proxyUrl)
        } catch (_: Exception) {
            // Exception messages may contain URLs or system proxy credentials.
            SystemProxyRoute.Failed
        }
    }
}

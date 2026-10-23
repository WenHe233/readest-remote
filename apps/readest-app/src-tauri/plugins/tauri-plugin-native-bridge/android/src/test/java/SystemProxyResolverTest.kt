package com.readest.native_bridge

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Test

class SystemProxyResolverTest {
    private fun selector(vararg proxies: Proxy) = object : ProxySelector() {
        override fun select(uri: URI): List<Proxy> = proxies.toList()
        override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) = Unit
    }

    @Test fun followsPerUrlSelectionAndBypass() {
        val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("127.0.0.1", 7890))
        val selector = object : ProxySelector() {
            override fun select(uri: URI) = if (uri.host == "bypass.example") listOf(Proxy.NO_PROXY) else listOf(proxy)
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) = Unit
        }
        assertEquals(SystemProxyRoute.Direct, SystemProxyResolver.resolve("https://bypass.example/", selector))
        assertEquals(SystemProxyRoute.Forward("http://127.0.0.1:7890"), SystemProxyResolver.resolve("https://public.example/", selector))
    }

    @Test fun retainsProxyHostnameAndRemoteSocksDns() {
        val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress.createUnresolved("proxy.example", 1080))
        assertEquals(SystemProxyRoute.Forward("socks5h://proxy.example:1080"), SystemProxyResolver.resolve("https://unresolved.example/", selector(proxy)))
    }

    @Test fun doesNotSkipFirstChoiceOrConvertFailureToDirect() {
        val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("127.0.0.1", 7890))
        assertEquals(SystemProxyRoute.Direct, SystemProxyResolver.resolve("https://public.example/", selector(Proxy.NO_PROXY, proxy)))
        assertEquals(SystemProxyRoute.Failed, SystemProxyResolver.resolve("https://public.example/", selector()))
        assertEquals(SystemProxyRoute.Failed, SystemProxyResolver.resolve("file:///private/file", selector(Proxy.NO_PROXY)))
        assertEquals(SystemProxyRoute.Direct, SystemProxyResolver.resolve("https://public.example/", null))
        assertEquals(SystemProxyRoute.Direct, SystemProxyResolver.resolve("HTTPS://public.example/", null))
    }

    @Test fun redactsProxyAddressInDebugOutput() {
        assertEquals("SystemProxyRoute.Forward([redacted])", SystemProxyRoute.Forward("http://secret:password@localhost:7890").toString())
    }

    @Test fun selectorExceptionDoesNotLeakOrBecomeDirect() {
        val selector = object : ProxySelector() {
            override fun select(uri: URI): List<Proxy> = throw IllegalStateException("secret proxy credentials")
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) = Unit
        }
        assertEquals(SystemProxyRoute.Failed, SystemProxyResolver.resolve("https://public.example/", selector))
    }
}

package expo.modules.torproxy

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import org.torproject.jni.TorService
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class TorProxyModule : Module() {
    private var torService: TorService? = null
    private var socksPort: Int = 0
    private var status: String = "stopped"
    private var bootstrapProgress: Int = 0

    // OkHttpClient with SOCKS proxy — handles HTTP + WebSocket + .onion DNS via proxy
    private var httpClient: OkHttpClient? = null

    // WebSocket connections
    private val webSockets = ConcurrentHashMap<String, WebSocket>()

    private val context get() = appContext.reactContext!!

    /** Debug-only log — checks FLAG_DEBUGGABLE since library BuildConfig.DEBUG is unreliable. */
    private fun debugLog(tag: String, msg: String) {
        if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            Log.i(tag, msg)
        }
    }

    override fun definition() = ModuleDefinition {
        Name("TorProxy")

        Events(
            "onBootstrapProgress",
            "onWebSocketMessage",
            "onWebSocketOpen",
            "onWebSocketClose",
            "onWebSocketError"
        )

        // ============================================================
        // LIFECYCLE — CTor via TorService (Android Service)
        // ============================================================

        AsyncFunction("start") {
            if (status == "connected") {
                return@AsyncFunction mapOf("socksPort" to socksPort)
            }

            status = "connecting"
            bootstrapProgress = 0

            debugLog("TorProxy", "Starting TorService...")

            // Bind to TorService — it starts tor and manages the SOCKS proxy
            val latch = CountDownLatch(1)

            val serviceConnection = object : ServiceConnection {
                override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                    val binder = service as TorService.LocalBinder
                    torService = binder.service

                    debugLog("TorProxy", "TorService bound, waiting for control connection...")

                    // Wait for Tor to be ready (control connection available)
                    Thread {
                        val svc = torService ?: return@Thread
                        val maxWaitMs = 90_000L
                        val startTime = System.currentTimeMillis()

                        // Wait for control connection
                        while (svc.torControlConnection == null &&
                               System.currentTimeMillis() - startTime < maxWaitMs) {
                            Thread.sleep(200)
                        }

                        if (svc.torControlConnection != null) {
                            socksPort = svc.socksPort
                            status = "connected"
                            bootstrapProgress = 100
                            sendEvent("onBootstrapProgress", mapOf("progress" to 100))
                            debugLog("TorProxy", "Tor ready! SOCKS port: $socksPort")
                        } else {
                            status = "stopped"
                            debugLog("TorProxy", "Tor failed to establish control connection within ${maxWaitMs / 1000}s")
                        }

                        latch.countDown()
                    }.start()
                }

                override fun onServiceDisconnected(name: ComponentName?) {
                    torService = null
                    status = "stopped"
                    debugLog("TorProxy", "TorService disconnected")
                }
            }

            // Start and bind the service
            val intent = Intent(context, TorService::class.java)
            context.startService(intent)
            context.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)

            // Wait for Tor to be ready
            val ready = latch.await(90, TimeUnit.SECONDS)
            if (!ready || status != "connected") {
                throw Exception("Tor failed to start within 90s")
            }

            // Create OkHttpClient with SOCKS proxy
            // OkHttp sends .onion domain names through SOCKS5 (no local DNS resolution)
            httpClient = OkHttpClient.Builder()
                .proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)))
                .connectTimeout(120, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()

            debugLog("TorProxy", "Ready! SOCKS port: $socksPort")
            return@AsyncFunction mapOf("socksPort" to socksPort)
        }

        AsyncFunction("stop") {
            // Keep Tor running — same approach as iOS
            debugLog("TorProxy", "Stop requested — keeping Tor running")
        }

        Function("getStatus") {
            return@Function status
        }

        Function("getBootstrapProgress") {
            return@Function bootstrapProgress
        }

        // ============================================================
        // HTTP VIA TOR
        // ============================================================

        AsyncFunction("httpRequest") { url: String, method: String, headers: Map<String, String>?, body: String?, timeout: Double? ->
            val client = httpClient
                ?: throw Exception("Tor is not running")

            val requestBuilder = Request.Builder().url(url)

            headers?.forEach { (key, value) ->
                requestBuilder.addHeader(key, value)
            }

            val requestBody = body?.toRequestBody("application/json".toMediaTypeOrNull())

            when (method.uppercase()) {
                "GET" -> requestBuilder.get()
                "POST" -> requestBuilder.post(requestBody ?: "".toRequestBody(null))
                "PUT" -> requestBuilder.put(requestBody ?: "".toRequestBody(null))
                "DELETE" -> {
                    if (requestBody != null) requestBuilder.delete(requestBody)
                    else requestBuilder.delete()
                }
            }

            val request = requestBuilder.build()

            val timeoutMs = (timeout ?: 120000.0).toLong()
            val clientWithTimeout = if (timeoutMs != 120000L) {
                client.newBuilder()
                    .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build()
            } else {
                client
            }

            val response: Response = clientWithTimeout.newCall(request).execute()

            val responseHeaders = mutableMapOf<String, String>()
            for (name in response.headers.names()) {
                responseHeaders[name] = response.header(name) ?: ""
            }

            return@AsyncFunction mapOf(
                "status" to response.code,
                "data" to (response.body?.string() ?: ""),
                "headers" to responseHeaders,
            )
        }

        // ============================================================
        // WEBSOCKET VIA TOR
        // ============================================================

        AsyncFunction("openWebSocket") { url: String, protocols: List<String>? ->
            val client = httpClient
                ?: throw Exception("Tor is not running")

            val wsId = UUID.randomUUID().toString()

            val requestBuilder = Request.Builder().url(url)
            if (!protocols.isNullOrEmpty()) {
                requestBuilder.addHeader("Sec-WebSocket-Protocol", protocols.joinToString(", "))
            }

            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    sendEvent("onWebSocketOpen", mapOf("wsId" to wsId))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    sendEvent("onWebSocketMessage", mapOf("wsId" to wsId, "data" to text))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    webSockets.remove(wsId)
                    sendEvent("onWebSocketClose", mapOf("wsId" to wsId, "code" to code, "reason" to reason))
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    webSockets.remove(wsId)
                    sendEvent("onWebSocketError", mapOf("wsId" to wsId, "error" to (t.message ?: "Unknown error")))
                    sendEvent("onWebSocketClose", mapOf("wsId" to wsId, "code" to 1006, "reason" to (t.message ?: "")))
                }
            }

            val ws = client.newWebSocket(requestBuilder.build(), listener)
            webSockets[wsId] = ws

            return@AsyncFunction wsId
        }

        AsyncFunction("sendWebSocket") { wsId: String, data: String ->
            val ws = webSockets[wsId]
                ?: throw Exception("WebSocket not found: $wsId")
            ws.send(data)
        }

        AsyncFunction("closeWebSocket") { wsId: String, code: Int? ->
            val ws = webSockets.remove(wsId)
            ws?.close(code ?: 1000, null)
        }

        OnDestroy {
            cleanup()
        }
    }

    private fun cleanup() {
        for ((_, ws) in webSockets) {
            try { ws.close(1001, "Tor stopping") } catch (_: Exception) {}
        }
        webSockets.clear()

        httpClient?.dispatcher?.executorService?.shutdown()
        httpClient?.connectionPool?.evictAll()
        httpClient = null

        // Don't stop TorService — keep running for the app lifetime
        socksPort = 0
        bootstrapProgress = 0
        status = "stopped"
    }
}
import ExpoModulesCore

public class TorProxyModule: Module {
    private var socksPort: UInt16 = 0
    private var status: String = "stopped"
    private var bootstrapProgress: Int = 0

    // HTTP: direct SOCKS5 client
    private var httpClient: Socks5HttpClient?

    // WebSocket: keyed by ID (fileprivate for WebSocketBridge access)
    fileprivate var webSockets: [String: Socks5WebSocketClient] = [:]
    fileprivate let wsLock = NSLock()

    public func definition() -> ModuleDefinition {
        Name("TorProxy")

        Events(
            "onBootstrapProgress",
            "onWebSocketMessage",
            "onWebSocketOpen",
            "onWebSocketClose",
            "onWebSocketError"
        )

        // ============================================================
        // LIFECYCLE
        // ============================================================

        AsyncFunction("start") { () -> [String: Any] in
            if self.status == "connected" {
                return ["socksPort": Int(self.socksPort)]
            }

            self.status = "connecting"
            self.bootstrapProgress = 0

            let port: UInt16 = 19150

            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            let stateDir = appSupport.appendingPathComponent("org.torproject.Arti", isDirectory: true)
            try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)

            let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                .appendingPathComponent("org.torproject.Arti", isDirectory: true)
            try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)

            #if DEBUG
            NSLog("[TorProxy] Starting Arti with SOCKS port \(port)")
            #endif
            self.status = "bootstrapping"

            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                var resumed = false

                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    ArtiWrapper.start(
                        withStateDir: stateDir.path,
                        cacheDir: cacheDir.path,
                        socksPort: Int32(port),
                        logBlock: { msg in
                            #if DEBUG
                            if msg.contains("INFO") || msg.contains("WARN") || msg.contains("ERROR") {
                                NSLog("[Arti] %@", msg.trimmingCharacters(in: .whitespacesAndNewlines))
                            }
                            #endif
                        },
                        completed: {
                            guard !resumed else { return }
                            resumed = true
                            #if DEBUG
                            NSLog("[TorProxy] Arti circuit established!")
                            #endif
                            continuation.resume()
                        }
                    )
                    #if DEBUG
                    NSLog("[TorProxy] start_arti exited")
                    #endif
                }

                DispatchQueue.global().asyncAfter(deadline: .now() + 90) {
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(throwing: NSError(domain: "TorProxy", code: 15,
                        userInfo: [NSLocalizedDescriptionKey: "Tor circuit not established within 90s"]))
                }
            }

            self.socksPort = port
            self.bootstrapProgress = 100
            self.status = "connected"
            self.sendEvent("onBootstrapProgress", ["progress": 100])

            self.httpClient = Socks5HttpClient(socksPort: port)

            #if DEBUG
            NSLog("[TorProxy] Ready! SOCKS port: \(port)")
            #endif
            return ["socksPort": Int(port)]
        }

        AsyncFunction("stop") { () in
            self.cleanup()
        }

        Function("getStatus") { () -> String in
            return self.status
        }

        Function("getBootstrapProgress") { () -> Int in
            return self.bootstrapProgress
        }

        // ============================================================
        // HTTP VIA TOR (SOCKS5 direct)
        // ============================================================

        AsyncFunction("httpRequest") { (url: String, method: String, headers: [String: String]?, body: String?, timeout: Double?) -> [String: Any] in
            guard self.status == "connected", let client = self.httpClient else {
                throw NSError(domain: "TorProxy", code: 1,
                             userInfo: [NSLocalizedDescriptionKey: "Tor is not running"])
            }

            let response = try await client.request(
                url: url, method: method, headers: headers, body: body,
                timeout: (timeout ?? 120000) / 1000
            )

            return [
                "status": response.statusCode,
                "data": response.body,
                "headers": response.headers,
            ]
        }

        // ============================================================
        // WEBSOCKET VIA TOR (SOCKS5 + RFC 6455)
        // ============================================================

        AsyncFunction("openWebSocket") { (url: String, protocols: [String]?) -> String in
            guard self.status == "connected" else {
                throw NSError(domain: "TorProxy", code: 1,
                             userInfo: [NSLocalizedDescriptionKey: "Tor is not running"])
            }

            let wsId = UUID().uuidString
            let client = Socks5WebSocketClient(socksPort: self.socksPort)

            // Bridge delegate events to JS
            let bridge = WebSocketBridge(wsId: wsId, module: self)
            client.delegate = bridge

            self.wsLock.lock()
            self.webSockets[wsId] = client
            self.wsLock.unlock()

            // Store bridge reference so it doesn't get deallocated
            objc_setAssociatedObject(client, "bridge", bridge, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

            // Connect asynchronously — openWebSocket returns the ID immediately,
            // the onOpen event fires when the connection is established
            Task {
                do {
                    try await client.connect(url: url, protocols: protocols)
                } catch {
                    #if DEBUG
                    NSLog("[TorProxy] WebSocket connect error: %@", error.localizedDescription)
                    #endif
                    self.sendEvent("onWebSocketError", ["wsId": wsId, "error": error.localizedDescription])
                    self.sendEvent("onWebSocketClose", ["wsId": wsId, "code": 1006, "reason": error.localizedDescription])
                    self.wsLock.lock()
                    self.webSockets.removeValue(forKey: wsId)
                    self.wsLock.unlock()
                }
            }

            return wsId
        }

        AsyncFunction("sendWebSocket") { (wsId: String, data: String) in
            self.wsLock.lock()
            let client = self.webSockets[wsId]
            self.wsLock.unlock()

            guard let client = client else {
                throw NSError(domain: "TorProxy", code: 4,
                             userInfo: [NSLocalizedDescriptionKey: "WebSocket not found: \(wsId)"])
            }

            client.send(text: data)
        }

        AsyncFunction("closeWebSocket") { (wsId: String, code: Int?) in
            self.wsLock.lock()
            let client = self.webSockets.removeValue(forKey: wsId)
            self.wsLock.unlock()

            client?.disconnect(code: code ?? 1000)
        }

        OnDestroy {
            self.cleanup()
        }
    }

    // MARK: - Cleanup

    private func cleanup() {
        wsLock.lock()
        for (_, client) in webSockets {
            client.disconnect(code: 1001)
        }
        webSockets.removeAll()
        wsLock.unlock()

        httpClient = nil
        // Don't call ArtiWrapper.stop() — Arti doesn't support clean restart.
        // Keep it running for the app lifetime (minimal resource cost when idle).
        socksPort = 0
        bootstrapProgress = 0
        status = "stopped"
    }
}

// MARK: - WebSocket Bridge (delegate → JS events)

/// Bridges Socks5WebSocketClient delegate callbacks to Expo module events.
private class WebSocketBridge: NSObject, Socks5WebSocketDelegate {
    let wsId: String
    weak var module: TorProxyModule?

    init(wsId: String, module: TorProxyModule) {
        self.wsId = wsId
        self.module = module
    }

    func webSocketDidOpen(_ client: Socks5WebSocketClient) {
        module?.sendEvent("onWebSocketOpen", ["wsId": wsId])
    }

    func webSocket(_ client: Socks5WebSocketClient, didReceiveText text: String) {
        module?.sendEvent("onWebSocketMessage", ["wsId": wsId, "data": text])
    }

    func webSocket(_ client: Socks5WebSocketClient, didCloseWithCode code: Int, reason: String) {
        module?.sendEvent("onWebSocketClose", ["wsId": wsId, "code": code, "reason": reason])
        module?.wsLock.lock()
        module?.webSockets.removeValue(forKey: wsId)
        module?.wsLock.unlock()
    }

    func webSocket(_ client: Socks5WebSocketClient, didFailWithError error: Error) {
        module?.sendEvent("onWebSocketError", ["wsId": wsId, "error": error.localizedDescription])
        module?.sendEvent("onWebSocketClose", ["wsId": wsId, "code": 1006, "reason": error.localizedDescription])
        module?.wsLock.lock()
        module?.webSockets.removeValue(forKey: wsId)
        module?.wsLock.unlock()
    }
}
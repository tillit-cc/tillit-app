import Foundation
import Network
import CryptoKit

// MARK: - Delegate

protocol Socks5WebSocketDelegate: AnyObject {
    func webSocketDidOpen(_ client: Socks5WebSocketClient)
    func webSocket(_ client: Socks5WebSocketClient, didReceiveText text: String)
    func webSocket(_ client: Socks5WebSocketClient, didCloseWithCode code: Int, reason: String)
    func webSocket(_ client: Socks5WebSocketClient, didFailWithError error: Error)
}

// MARK: - Client

/// Production WebSocket client that connects through a local SOCKS5 proxy.
///
/// This is a real WebSocket (RFC 6455), not polling. The flow:
///
/// ```
/// NWConnection(TCP → 127.0.0.1:socksPort)
///   → SOCKS5 handshake (domain sent to proxy, no local DNS)
///   → HTTP Upgrade 101
///   → Persistent bidirectional WebSocket frames
/// ```
///
/// NWConnection targets localhost (IP literal) — no DNS resolution occurs.
/// The .onion hostname is sent inside the SOCKS5 CONNECT command and resolved by Tor.
final class Socks5WebSocketClient {

    // MARK: Properties

    private let socksHost: String
    private let socksPort: UInt16
    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "app.tillit.tor.ws", qos: .userInitiated)
    private var readBuffer = Data()
    private(set) var isOpen = false

    weak var delegate: Socks5WebSocketDelegate?

    // MARK: Init

    init(socksHost: String = "127.0.0.1", socksPort: UInt16) {
        self.socksHost = socksHost
        self.socksPort = socksPort
    }

    deinit {
        disconnect(code: 1001)
    }

    // MARK: Connect

    func connect(url: String, protocols: [String]? = nil) async throws {
        guard let parsed = URL(string: url), let host = parsed.host else {
            throw WsError.invalidURL(url)
        }

        let port = UInt16(parsed.port ?? (parsed.scheme == "wss" ? 443 : 80))
        // URL(string:) strips trailing slash from path. Preserve it by checking the original URL.
        var rawPath = parsed.path.isEmpty ? "/" : parsed.path
        if url.contains("\(rawPath)/") && !rawPath.hasSuffix("/") {
            rawPath += "/"
        }
        let path = rawPath + (parsed.query.map { "?\($0)" } ?? "")

        // --- Step 1: TCP to SOCKS proxy (localhost, no DNS) ---

        let conn = NWConnection(
            host: NWEndpoint.Host(socksHost),
            port: NWEndpoint.Port(integerLiteral: socksPort),
            using: .tcp
        )
        self.connection = conn

        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    conn.stateUpdateHandler = nil
                    c.resume()
                case .failed(let err):
                    conn.stateUpdateHandler = nil
                    c.resume(throwing: WsError.tcpFailed(err.localizedDescription))
                case .cancelled:
                    conn.stateUpdateHandler = nil
                    c.resume(throwing: WsError.tcpFailed("Cancelled"))
                default:
                    break
                }
            }
            conn.start(queue: queue)
        }

        // --- Step 2: SOCKS5 handshake (sends .onion domain to proxy) ---

        try await socks5Handshake(conn: conn, targetHost: host, targetPort: port)

        // --- Step 3: WebSocket upgrade (HTTP 101) ---

        try await webSocketUpgrade(conn: conn, host: host, path: path, protocols: protocols)

        // --- Step 4: Connected — start read loop ---

        isOpen = true
        delegate?.webSocketDidOpen(self)

        Task { [weak self] in
            await self?.frameReadLoop()
        }
    }

    // MARK: Send

    func send(text: String) {
        guard isOpen, let conn = connection else { return }
        let payload = Data(text.utf8)
        let frame = WsFrame.encode(opcode: .text, payload: payload, mask: true)
        conn.send(content: frame, completion: .contentProcessed { [weak self] err in
            if let err = err, let self = self {
                self.fail(WsError.sendFailed(err.localizedDescription))
            }
        })
    }

    // MARK: Close

    func disconnect(code: Int = 1000) {
        guard isOpen else { return }
        isOpen = false

        if let conn = connection {
            // Send close frame
            var payload = Data()
            payload.append(UInt8((code >> 8) & 0xFF))
            payload.append(UInt8(code & 0xFF))
            let frame = WsFrame.encode(opcode: .close, payload: payload, mask: true)
            conn.send(content: frame, completion: .contentProcessed { _ in
                conn.cancel()
            })
        }

        delegate?.webSocket(self, didCloseWithCode: code, reason: "")
        connection = nil
    }

    // MARK: - SOCKS5 Handshake

    private func socks5Handshake(conn: NWConnection, targetHost: String, targetPort: UInt16) async throws {
        // Greeting: SOCKS5, 1 auth method, no-auth
        try await rawSend(conn, data: Data([0x05, 0x01, 0x00]))
        let greet = try await rawRecv(conn, count: 2)
        guard greet[0] == 0x05, greet[1] == 0x00 else {
            throw WsError.socks5Failed("Greeting rejected: \(greet.hexString)")
        }

        // Connect: SOCKS5, CMD connect, RSV, DOMAINNAME
        let hostBytes = Data(targetHost.utf8)
        var req = Data([0x05, 0x01, 0x00, 0x03, UInt8(hostBytes.count)])
        req.append(hostBytes)
        req.append(UInt8((targetPort >> 8) & 0xFF))
        req.append(UInt8(targetPort & 0xFF))
        try await rawSend(conn, data: req)

        // Response
        let resp = try await rawRecv(conn, count: 4)
        guard resp[0] == 0x05, resp[1] == 0x00 else {
            throw WsError.socks5Failed("CONNECT failed, code=\(resp[1])")
        }

        // Drain bind address based on address type
        switch resp[3] {
        case 0x01: // IPv4 (4) + port (2)
            _ = try await rawRecv(conn, count: 6)
        case 0x03: // Domain: len (1) + domain (len) + port (2)
            let len = try await rawRecv(conn, count: 1)
            _ = try await rawRecv(conn, count: Int(len[0]) + 2)
        case 0x04: // IPv6 (16) + port (2)
            _ = try await rawRecv(conn, count: 18)
        default:
            break
        }
    }

    // MARK: - WebSocket Upgrade

    private func webSocketUpgrade(
        conn: NWConnection,
        host: String,
        path: String,
        protocols: [String]?
    ) async throws {
        let key = WsFrame.generateKey()

        var request = "GET \(path) HTTP/1.1\r\n"
        request += "Host: \(host)\r\n"
        request += "Upgrade: websocket\r\n"
        request += "Connection: Upgrade\r\n"
        request += "Sec-WebSocket-Key: \(key)\r\n"
        request += "Sec-WebSocket-Version: 13\r\n"
        if let protos = protocols, !protos.isEmpty {
            request += "Sec-WebSocket-Protocol: \(protos.joined(separator: ", "))\r\n"
        }
        request += "\r\n"

        try await rawSend(conn, data: Data(request.utf8))

        // Read response headers until \r\n\r\n
        let headers = try await readUntilDoubleCRLF(conn)
        let headerStr = String(data: headers, encoding: .utf8) ?? ""

        guard headerStr.contains("101") else {
            let firstLine = headerStr.components(separatedBy: "\r\n").first ?? "?"
            throw WsError.upgradeFailed("Expected 101, got: \(firstLine)")
        }

        // Validate Sec-WebSocket-Accept (RFC 6455 §4.2.2)
        let expectedAccept = WsFrame.computeAcceptKey(from: key)
        let acceptValue = headerStr.components(separatedBy: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("sec-websocket-accept:") })
            .map { String($0.dropFirst("sec-websocket-accept:".count)).trimmingCharacters(in: .whitespaces) }
        guard acceptValue == expectedAccept else {
            throw WsError.upgradeFailed("Invalid Sec-WebSocket-Accept")
        }
    }

    // MARK: - Frame Read Loop

    private func frameReadLoop() async {
        guard let conn = connection else { return }

        // Continuation frame reassembly (RFC 6455 §5.4)
        var fragmentBuffer = Data()
        var fragmentOpcode: WsFrame.Opcode? = nil

        while isOpen {
            do {
                let frame = try await readFrame(conn)

                switch frame.opcode {
                case .continuation:
                    fragmentBuffer.append(frame.payload)
                    if frame.fin, let opcode = fragmentOpcode {
                        deliverPayload(opcode: opcode, payload: fragmentBuffer)
                        fragmentBuffer = Data()
                        fragmentOpcode = nil
                    }

                case .text, .binary:
                    if fragmentOpcode != nil {
                        // RFC 6455 §5.4: new data frame while previous fragment incomplete
                        throw WsError.protocolError("New message before previous fragment completed")
                    }
                    if frame.fin {
                        deliverPayload(opcode: frame.opcode, payload: frame.payload)
                    } else {
                        // First fragment of a multi-frame message
                        fragmentOpcode = frame.opcode
                        fragmentBuffer = frame.payload
                    }

                case .ping:
                    // Control frames can interleave between fragments (RFC 6455 §5.5)
                    let pong = WsFrame.encode(opcode: .pong, payload: frame.payload, mask: true)
                    conn.send(content: pong, completion: .contentProcessed { _ in })

                case .pong:
                    break

                case .close:
                    let code = frame.payload.count >= 2
                        ? Int(frame.payload[0]) << 8 | Int(frame.payload[1])
                        : 1000
                    let reason = frame.payload.count > 2
                        ? String(data: frame.payload[2...], encoding: .utf8) ?? ""
                        : ""
                    isOpen = false
                    // Echo close frame back (RFC 6455 §5.5.1)
                    let echo = WsFrame.encode(opcode: .close, payload: frame.payload, mask: true)
                    conn.send(content: echo, completion: .contentProcessed { _ in conn.cancel() })
                    connection = nil
                    delegate?.webSocket(self, didCloseWithCode: code, reason: reason)
                    return

                default:
                    break
                }
            } catch {
                if isOpen {
                    fail(error)
                }
                return
            }
        }
    }

    /// Deliver a complete (possibly reassembled) payload to the delegate.
    private func deliverPayload(opcode: WsFrame.Opcode, payload: Data) {
        if let text = String(data: payload, encoding: .utf8) {
            delegate?.webSocket(self, didReceiveText: text)
        }
    }

    // MARK: - RFC 6455 Frame Read

    private func readFrame(_ conn: NWConnection) async throws -> WsFrame {
        // Byte 0: FIN + opcode
        // Byte 1: MASK + payload length
        let header = try await rawRecv(conn, count: 2)

        let fin = (header[0] & 0x80) != 0
        let opcode = WsFrame.Opcode(rawValue: header[0] & 0x0F) ?? .text
        let masked = (header[1] & 0x80) != 0
        var payloadLength = UInt64(header[1] & 0x7F)

        // Extended payload length
        if payloadLength == 126 {
            let ext = try await rawRecv(conn, count: 2)
            payloadLength = UInt64(ext[0]) << 8 | UInt64(ext[1])
        } else if payloadLength == 127 {
            let ext = try await rawRecv(conn, count: 8)
            payloadLength = 0
            for byte in ext { payloadLength = (payloadLength << 8) | UInt64(byte) }
        }

        // Mask key (servers should NOT mask per RFC 6455 §5.1, but handle gracefully)
        var maskKey = Data()
        if masked {
            maskKey = try await rawRecv(conn, count: 4)
        }

        // Payload
        var payload = payloadLength > 0
            ? try await rawRecv(conn, count: Int(payloadLength))
            : Data()

        // Unmask
        if masked {
            for i in 0..<payload.count {
                payload[i] ^= maskKey[i % 4]
            }
        }

        return WsFrame(fin: fin, opcode: opcode, payload: payload)
    }

    // MARK: - Raw I/O (with internal read buffer)

    private func rawSend(_ conn: NWConnection, data: Data) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            conn.send(content: data, completion: .contentProcessed { err in
                if let err = err { c.resume(throwing: err) }
                else { c.resume() }
            })
        }
    }

    /// Read exactly `count` bytes, using internal buffer to handle partial reads.
    private func rawRecv(_ conn: NWConnection, count: Int) async throws -> Data {
        while readBuffer.count < count {
            let chunk: Data = try await withCheckedThrowingContinuation { c in
                conn.receive(
                    minimumIncompleteLength: 1,
                    maximumLength: max(count - readBuffer.count, 8192)
                ) { data, _, isComplete, error in
                    if let error = error {
                        c.resume(throwing: error)
                    } else if let data = data, !data.isEmpty {
                        c.resume(returning: data)
                    } else if isComplete {
                        c.resume(throwing: WsError.connectionClosed)
                    } else {
                        c.resume(throwing: WsError.connectionClosed)
                    }
                }
            }
            readBuffer.append(chunk)
        }

        let result = Data(readBuffer.prefix(count))
        readBuffer = Data(readBuffer.dropFirst(count))
        return result
    }

    /// Read until \r\n\r\n is found. Returns everything before the separator.
    /// Bytes after the separator are kept in the internal buffer.
    private func readUntilDoubleCRLF(_ conn: NWConnection) async throws -> Data {
        let sep = Data([0x0D, 0x0A, 0x0D, 0x0A])

        while true {
            if let range = readBuffer.range(of: sep) {
                let header = Data(readBuffer[..<range.lowerBound])
                readBuffer = Data(readBuffer[range.upperBound...])
                return header
            }

            let chunk: Data = try await withCheckedThrowingContinuation { c in
                conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, isComplete, error in
                    if let error = error { c.resume(throwing: error) }
                    else if let data = data, !data.isEmpty { c.resume(returning: data) }
                    else { c.resume(throwing: WsError.connectionClosed) }
                }
            }
            readBuffer.append(chunk)
        }
    }

    // MARK: - Error Handling

    private func fail(_ error: Error) {
        isOpen = false
        connection?.cancel()
        connection = nil
        delegate?.webSocket(self, didFailWithError: error)
    }
}

// MARK: - WebSocket Frame

struct WsFrame {
    enum Opcode: UInt8 {
        case continuation = 0x00
        case text         = 0x01
        case binary       = 0x02
        // 0x03-0x07 reserved
        case close        = 0x08
        case ping         = 0x09
        case pong         = 0x0A
    }

    let fin: Bool
    let opcode: Opcode
    let payload: Data

    /// Encode a complete WebSocket frame. Client MUST mask (RFC 6455 §5.3).
    static func encode(opcode: Opcode, payload: Data, mask: Bool) -> Data {
        var frame = Data()

        // Byte 0: FIN + opcode
        frame.append(0x80 | opcode.rawValue)

        // Byte 1+: mask bit + payload length
        let maskBit: UInt8 = mask ? 0x80 : 0x00
        let len = payload.count
        if len < 126 {
            frame.append(maskBit | UInt8(len))
        } else if len <= 0xFFFF {
            frame.append(maskBit | 126)
            frame.append(UInt8((len >> 8) & 0xFF))
            frame.append(UInt8(len & 0xFF))
        } else {
            frame.append(maskBit | 127)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((len >> shift) & 0xFF))
            }
        }

        // Mask key + payload
        if mask {
            var key = Data(count: 4)
            _ = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 4, $0.baseAddress!) }
            frame.append(key)
            for i in 0..<payload.count {
                frame.append(payload[i] ^ key[i % 4])
            }
        } else {
            frame.append(payload)
        }

        return frame
    }

    /// Random 16-byte base64 key for Sec-WebSocket-Key header.
    static func generateKey() -> String {
        var bytes = Data(count: 16)
        _ = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        return bytes.base64EncodedString()
    }

    /// Compute the expected Sec-WebSocket-Accept value (RFC 6455 §4.2.2).
    static func computeAcceptKey(from key: String) -> String {
        let magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let hash = Insecure.SHA1.hash(data: Data((key + magic).utf8))
        return Data(hash).base64EncodedString()
    }
}

// MARK: - Errors

enum WsError: LocalizedError {
    case invalidURL(String)
    case tcpFailed(String)
    case socks5Failed(String)
    case upgradeFailed(String)
    case sendFailed(String)
    case connectionClosed
    case protocolError(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let u):  return "Invalid URL: \(u)"
        case .tcpFailed(let m):   return "TCP failed: \(m)"
        case .socks5Failed(let m): return "SOCKS5: \(m)"
        case .upgradeFailed(let m): return "WS upgrade: \(m)"
        case .sendFailed(let m):  return "WS send: \(m)"
        case .connectionClosed:   return "Connection closed"
        case .protocolError(let m): return "WS protocol error: \(m)"
        }
    }
}

// MARK: - Helpers

private extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined(separator: " ") }
}

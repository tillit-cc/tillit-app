import Foundation
import Network

/**
 * Minimal SOCKS5 HTTP client that routes requests through a local SOCKS5 proxy.
 *
 * Bypasses URLSession entirely — the .onion hostname is sent inside the SOCKS5
 * CONNECT command and resolved by Tor, never by the system DNS.
 *
 * Protocol flow:
 * 1. TCP connect to localhost:<socksPort>
 * 2. SOCKS5 greeting: client sends [0x05, 0x01, 0x00] (version 5, 1 method, no auth)
 * 3. Server responds [0x05, 0x00] (version 5, no auth)
 * 4. SOCKS5 CONNECT: client sends [0x05, 0x01, 0x00, 0x03, <len>, <domain>, <port_hi>, <port_lo>]
 * 5. Server responds [0x05, 0x00, ...] (success)
 * 6. TCP tunnel established — send/receive raw HTTP over it
 */
struct Socks5HttpResponse {
    let statusCode: Int
    let headers: [String: String]
    let body: String
}

class Socks5HttpClient {
    private let socksHost: String
    private let socksPort: UInt16

    init(socksHost: String = "127.0.0.1", socksPort: UInt16) {
        self.socksHost = socksHost
        self.socksPort = socksPort
    }

    func request(
        url: String,
        method: String,
        headers: [String: String]?,
        body: String?,
        timeout: TimeInterval = 30
    ) async throws -> Socks5HttpResponse {
        guard let parsed = URL(string: url),
              let host = parsed.host else {
            throw Socks5Error.invalidURL(url)
        }

        let port: UInt16 = UInt16(parsed.port ?? (parsed.scheme == "https" ? 443 : 80))
        let path = parsed.path.isEmpty ? "/" : parsed.path
        let query = parsed.query.map { "?\($0)" } ?? ""

        // 1. TCP connect to SOCKS proxy
        let connection = NWConnection(
            host: NWEndpoint.Host(socksHost),
            port: NWEndpoint.Port(integerLiteral: socksPort),
            using: .tcp
        )

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.stateUpdateHandler = nil
                    cont.resume()
                case .failed(let error):
                    connection.stateUpdateHandler = nil
                    cont.resume(throwing: Socks5Error.connectionFailed("TCP to SOCKS proxy failed: \(error)"))
                case .cancelled:
                    connection.stateUpdateHandler = nil
                    cont.resume(throwing: Socks5Error.connectionFailed("Connection cancelled"))
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
        }

        defer { connection.cancel() }

        // 2. SOCKS5 greeting: version 5, 1 auth method (0x00 = no auth)
        try await send(connection: connection, data: Data([0x05, 0x01, 0x00]))

        let greeting = try await receive(connection: connection, length: 2, timeout: timeout)
        guard greeting.count == 2, greeting[0] == 0x05, greeting[1] == 0x00 else {
            throw Socks5Error.handshakeFailed("Bad greeting response: \(greeting.map { String(format: "%02x", $0) }.joined())")
        }

        // 3. SOCKS5 CONNECT with domain name (type 0x03)
        let hostData = host.data(using: .utf8)!
        var connectReq = Data([0x05, 0x01, 0x00, 0x03, UInt8(hostData.count)])
        connectReq.append(hostData)
        connectReq.append(UInt8(port >> 8))  // port high byte
        connectReq.append(UInt8(port & 0xFF)) // port low byte

        try await send(connection: connection, data: connectReq)

        // Read SOCKS5 connect response (minimum 4 bytes header)
        let connectResp = try await receive(connection: connection, length: 4, timeout: timeout)
        guard connectResp.count >= 4, connectResp[0] == 0x05, connectResp[1] == 0x00 else {
            let code = connectResp.count >= 2 ? connectResp[1] : 0xFF
            throw Socks5Error.connectFailed("SOCKS5 connect failed with code \(code)")
        }

        // Read remaining bytes of the SOCKS5 response based on address type
        let addrType = connectResp[3]
        switch addrType {
        case 0x01: // IPv4: 4 bytes addr + 2 bytes port
            _ = try await receive(connection: connection, length: 6, timeout: timeout)
        case 0x03: // Domain: 1 byte len + domain + 2 bytes port
            let lenBuf = try await receive(connection: connection, length: 1, timeout: timeout)
            _ = try await receive(connection: connection, length: Int(lenBuf[0]) + 2, timeout: timeout)
        case 0x04: // IPv6: 16 bytes addr + 2 bytes port
            _ = try await receive(connection: connection, length: 18, timeout: timeout)
        default:
            break
        }

        // 4. Tunnel established — send HTTP request
        var httpReq = "\(method) \(path)\(query) HTTP/1.1\r\n"
        httpReq += "Host: \(host)\r\n"

        headers?.forEach { key, value in
            httpReq += "\(key): \(value)\r\n"
        }

        if let body = body {
            let bodyData = body.data(using: .utf8) ?? Data()
            httpReq += "Content-Length: \(bodyData.count)\r\n"
        }

        // Ensure Content-Type is set for requests with body
        if body != nil && headers?["Content-Type"] == nil {
            httpReq += "Content-Type: application/json\r\n"
        }

        httpReq += "Connection: close\r\n"
        httpReq += "\r\n"

        if let body = body {
            httpReq += body
        }

        try await send(connection: connection, data: httpReq.data(using: .utf8)!)

        // 5. Read HTTP response headers (read until \r\n\r\n)
        let (headerData, overflow) = try await receiveUntilHeaderEnd(connection: connection, timeout: timeout)
        let headerStr = String(data: headerData, encoding: .utf8) ?? ""

        // Parse Content-Length from headers (nil = header absent)
        var contentLength: Int? = nil
        let headerLines = headerStr.components(separatedBy: "\r\n")
        for line in headerLines {
            if line.lowercased().hasPrefix("content-length:") {
                let val = line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)
                contentLength = Int(val)
            }
        }

        // 6. Read body
        var bodyData = overflow // bytes read past the header boundary
        if let cl = contentLength {
            // Content-Length present — read exactly that many bytes
            let remaining = cl - bodyData.count
            if remaining > 0 {
                let rest = try await receive(connection: connection, length: remaining, timeout: timeout)
                bodyData.append(rest)
            }
        } else {
            // No Content-Length — read until connection close (Connection: close is set)
            let rest = try await receiveAll(connection: connection, timeout: timeout)
            bodyData.append(rest)
        }

        let bodyStr = String(data: bodyData, encoding: .utf8) ?? ""

        return parseHttpResponse(headerStr + "\r\n\r\n" + bodyStr)
    }

    // MARK: - Private

    private func send(connection: NWConnection, data: Data) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error = error {
                    cont.resume(throwing: Socks5Error.sendFailed(error.localizedDescription))
                } else {
                    cont.resume()
                }
            })
        }
    }

    private func receive(connection: NWConnection, length: Int, timeout: TimeInterval) async throws -> Data {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: length, maximumLength: length) { data, _, _, error in
                if let error = error {
                    cont.resume(throwing: Socks5Error.receiveFailed(error.localizedDescription))
                } else if let data = data {
                    cont.resume(returning: data)
                } else {
                    cont.resume(throwing: Socks5Error.receiveFailed("No data received"))
                }
            }
        }
    }

    /// Read from connection until we find \r\n\r\n (end of HTTP headers).
    /// Returns the header data (without the trailing \r\n\r\n) and any overflow bytes (start of body).
    private func receiveUntilHeaderEnd(connection: NWConnection, timeout: TimeInterval) async throws -> (Data, Data) {
        var buffer = Data()
        let separator = Data([0x0d, 0x0a, 0x0d, 0x0a]) // \r\n\r\n

        while true {
            let chunk = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
                connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, isComplete, error in
                    if let error = error {
                        cont.resume(throwing: Socks5Error.receiveFailed(error.localizedDescription))
                    } else if let data = data, !data.isEmpty {
                        cont.resume(returning: data)
                    } else if isComplete {
                        cont.resume(throwing: Socks5Error.receiveFailed("Connection closed before headers complete"))
                    } else {
                        cont.resume(throwing: Socks5Error.receiveFailed("No data received"))
                    }
                }
            }

            buffer.append(chunk)

            if let range = buffer.range(of: separator) {
                let headerData = buffer[buffer.startIndex..<range.lowerBound]
                let overflow = buffer[range.upperBound..<buffer.endIndex]
                return (Data(headerData), Data(overflow))
            }
        }
    }

    private func receiveAll(connection: NWConnection, timeout: TimeInterval) async throws -> Data {
        var result = Data()

        while true {
            do {
                let chunk = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data?, Error>) in
                    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                        if let error = error {
                            // Connection reset / closed by peer is normal for "Connection: close"
                            if error == .posix(.ECONNRESET) || isComplete {
                                cont.resume(returning: nil)
                            } else {
                                cont.resume(throwing: error)
                            }
                        } else if let data = data, !data.isEmpty {
                            cont.resume(returning: data)
                        } else {
                            // EOF or empty data
                            cont.resume(returning: nil)
                        }
                    }
                }

                guard let chunk = chunk else { break }
                result.append(chunk)
            } catch {
                // If we already have data, return what we have
                if !result.isEmpty { break }
                throw error
            }
        }

        return result
    }

    private func parseHttpResponse(_ raw: String) -> Socks5HttpResponse {
        // Split headers and body at the first \r\n\r\n
        let parts = raw.components(separatedBy: "\r\n\r\n")
        let headerSection = parts.first ?? ""
        let body = parts.count > 1 ? parts.dropFirst().joined(separator: "\r\n\r\n") : ""

        let headerLines = headerSection.components(separatedBy: "\r\n")

        // Parse status code from "HTTP/1.1 200 OK"
        var statusCode = 0
        if let statusLine = headerLines.first {
            let statusParts = statusLine.split(separator: " ", maxSplits: 2)
            if statusParts.count >= 2, let code = Int(statusParts[1]) {
                statusCode = code
            }
        }

        // Parse headers
        var headers: [String: String] = [:]
        for line in headerLines.dropFirst() {
            if let colonIndex = line.firstIndex(of: ":") {
                let key = String(line[line.startIndex..<colonIndex]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: colonIndex)...]).trimmingCharacters(in: .whitespaces)
                headers[key] = value
            }
        }

        return Socks5HttpResponse(statusCode: statusCode, headers: headers, body: body)
    }
}

enum Socks5Error: LocalizedError {
    case invalidURL(String)
    case connectionFailed(String)
    case handshakeFailed(String)
    case connectFailed(String)
    case sendFailed(String)
    case receiveFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let u): return "Invalid URL: \(u)"
        case .connectionFailed(let m): return "SOCKS5 connection failed: \(m)"
        case .handshakeFailed(let m): return "SOCKS5 handshake failed: \(m)"
        case .connectFailed(let m): return "SOCKS5 connect failed: \(m)"
        case .sendFailed(let m): return "SOCKS5 send failed: \(m)"
        case .receiveFailed(let m): return "SOCKS5 receive failed: \(m)"
        }
    }
}

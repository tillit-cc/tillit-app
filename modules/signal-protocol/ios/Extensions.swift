import Foundation

extension Data {
    // Example extension method
    func base64EncodedString() -> String {
        return self.base64EncodedString(options: [])
    }
}

import Foundation
import LibSignalClient

@objc public class SignalProtocol: NSObject {
    public func generateIdentityKeyPair(_ serialize: Bool) -> IdentityKeyPair  {
        return IdentityKeyPair.generate()
    }
}

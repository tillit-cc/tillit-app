package expo.modules.signalprotocol

import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord

class LocalUser(
    val identityKey: IdentityKeyPair,
    val registrationId: UInt,
    val preKeys: List<PreKeyRecord>,
    val signedPreKey: SignedPreKeyRecord,
    val kyberPreKeys: List<KyberPreKeyRecord>,
    val deviceId: UInt,
    val name: String
)

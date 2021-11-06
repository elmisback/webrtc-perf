import { webcrypto as crypto } from 'crypto'
import { WebSocket } from "ws"
import pkg from 'wrtc'
const {RTCPeerConnection} = pkg;


const ECDSA_HASH = "SHA-256"
const ECDSA_CURVE = "P-384"
const ECDH_CURVE = "P-384"

let generateECDSAKeyPair = () => crypto.subtle.generateKey(
    {
        name: "ECDSA",
        namedCurve: ECDSA_CURVE
    },
    true,
    ["sign", "verify"]
)

let generateECDHKeyPair = () => crypto.subtle.generateKey(
    {
        name: "ECDH",
        namedCurve: ECDH_CURVE
    },
    true,
    ["deriveKey"]
)

let deriveSecretKey = (privateKey, publicKey) => crypto.subtle.deriveKey(
    {
        name: "ECDH",
        public: publicKey
    },
    privateKey,
    {
        name: "AES-GCM",
        length: 256
    },
    false,
    ["encrypt", "decrypt"]
)

let default_sign = key_pair => async text => arrayBufferToBase64(await crypto.subtle.sign(
    {name: 'ECDSA', hash: ECDSA_HASH},
    key_pair.privateKey,
    new TextEncoder().encode(text)))

let default_verify = (key, signature /* (base64-encoded) */, text) => crypto.subtle.verify(
    {name: 'ECDSA', hash: ECDSA_HASH},
    key,
    base64ToArrayBuffer(signature),
    new TextEncoder().encode(text))

let default_encrypt = my_key_pair => async (their_key, text) => {
    const key = await deriveSecretKey(my_key_pair.privateKey, their_key)

    // iv will be needed for decryption, so we just pass it as plaintext
    // Stackoverflow says this is fine: https://crypto.stackexchange.com/questions/58329/can-aes-gcm-be-broken-if-initialisation-vector-is-known
    // Note iv must *never* be reused.
    const iv = await crypto.getRandomValues(new Uint8Array(12));
    return {
        iv: Array.from(iv),
        ciphertext: arrayBufferToBase64(await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: iv
            },
            key,
            new TextEncoder().encode(text)
        ))
    }
}

let default_decrypt = my_key_pair => async (their_key, {iv, ciphertext}) => {
    const key = await deriveSecretKey(my_key_pair.privateKey, their_key)
    return new TextDecoder().decode(await crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: new Uint8Array(iv)
        },
        key,
        base64ToArrayBuffer(ciphertext)
    ))
}

let default_auth_key_import = (base64) => crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64),
    {
        name: 'ECDSA',
        namedCurve: ECDSA_CURVE
    },
    true,
    ['verify']
)

let default_encryption_key_import = base64 => crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64),
    {
        name: 'ECDH',
        namedCurve: ECDH_CURVE
    },
    false,
    []
)
let default_key_export = async k => arrayBufferToBase64(await crypto.subtle.exportKey('spki', k.publicKey))

// from https://stackoverflow.com/questions/9267899/arraybuffer-to-base64-encoded-string
function arrayBufferToBase64( buffer ) {
    var binary = '';
    var bytes = new Uint8Array( buffer );
    var len = bytes.byteLength;
    for (var i = 0; i < len; i++) {
        binary += String.fromCharCode( bytes[ i ] );
    }
    return btoa( binary );
}

// from https://stackoverflow.com/questions/21797299/convert-base64-string-to-arraybuffer
function base64ToArrayBuffer(base64) {
    var binary_string = atob(base64);
    var len = binary_string.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

let connectToHost = async ({
                           host,
                           auth_key_pair,  // Optional (unless you want to be recognized).
                           // (Optional below.) See Note 1 in Notes for details on the below parameters.
                           encrypt_key_pair,
                           sign,
                           verify,
                           encrypt,
                           decrypt,
                           encryption_key_import,
                           auth_key_import,
                           auth_key_export,
                           encryption_key_export
                       }) => {
    auth_key_pair = await generateECDSAKeyPair()
    // See Note 1 in Notes for details on the below parameters.
    encrypt_key_pair = await generateECDHKeyPair()
    sign = default_sign(auth_key_pair)
    verify = default_verify//(auth_key_pair)
    encrypt = default_encrypt(encrypt_key_pair)
    decrypt = default_decrypt(encrypt_key_pair)
    encryption_key_import = default_encryption_key_import
    auth_key_import = default_auth_key_import
    auth_key_export = default_key_export
    encryption_key_export = default_key_export

    // (All external dependencies are above here.)

    const candidate_gather_pause = 500  // ms to wait for ICE candidates
    const peer_connection = new RTCPeerConnection({
        iceServers:
            [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.stunprotocol.org'] }]
        /*
        [
          { urls: 'stun:stun.stunprotocol.org:3478' },
          { urls: 'stun:stun.l.google.com:19302' },
          // using more than 2 STUN/TURN servers slows discovery: https://stackoverflow.com/questions/58223805/why-does-using-more-than-two-stun-turn-servers-slow-down-discovery
          //{urls: 'stun:stun1.l.google.com:19302'}
          // 'stun:stun2.l.google.com:19302',
          // 'stun:stun3.l.google.com:19302',
          // 'stun:stun4.l.google.com:19302'  // Firefox complains about more than 5 STUN servers
          // https://numb.viagenie.ca/ hosts a free TURN server apparently?
        ]*/
    })
    peer_connection.onicecandidate = ({ candidate }) => {
        console.log(candidate)
    }

    const ws = new WebSocket('wss://auth-rtc.strcat.xyz/transient')

    // (HACK) since we can't await in the default params above)
    auth_key_pair = await auth_key_pair
    encrypt_key_pair = await encrypt_key_pair
    const candidates = []
    let their_encryption_key = undefined


    const send = object => ws.send(JSON.stringify(object))
    let resolve
    let result = new Promise(r => resolve = r)
    peer_connection.ondatachannel = event => {
        console.log('got datachannel (transient)')
        resolve(event.channel)
    }
    const chan = peer_connection.createDataChannel('channel-name')
    peer_connection.onicecandidate = async ({ candidate }) => {
        console.log(candidate)
        candidates.push(candidate)
        if (candidate == null && peer_connection.connectionState != 'connected') {
            // NOTE This condition may not be exactly correct
            // Example: if connectionState is 'failed'
            send({
                message: {candidates: await encrypt(their_encryption_key, JSON.stringify(candidates))}
            })
        }
    }

    const signed_encryption_key = await sign(await encryption_key_export(encrypt_key_pair))
    ws.onclose = event => console.log('Websocket connection closed. Event:', {reason: event.reason, code: event.code, wasClean: event.wasClean})
    ws.onmessage = async ({ data }) => {
        if (data == 'ping') return send('pong')
        console.debug('transient.ws.onmessage.data:', data)
        const { challenge, message } = JSON.parse(data)
        console.debug('transient.ws.onmessage.data parsed:', JSON.parse(data))
        if (challenge) {
            return send({
                public_key: await auth_key_export(auth_key_pair),
                signature: await sign(challenge),
                host,
                message: {
                    encryption_key: await encryption_key_export(encrypt_key_pair),
                    signature: signed_encryption_key
                }
            })
        }

        const { encryption_key, signature, offer, candidates } = message

        if (encryption_key) {
            if (!(await verify(await auth_key_import(host), signature, encryption_key))) throw Error('Message signature failed verification.')
            their_encryption_key = await encryption_key_import(encryption_key)
        }  // fall through

        if (offer) {
            if (!their_encryption_key) throw Error(`Host didn't send an encryption key.`)
            const decrypted_offer = await decrypt(their_encryption_key, offer)
            console.log('Transient got an offer:', JSON.parse(decrypted_offer))
            await peer_connection.setRemoteDescription(JSON.parse(decrypted_offer))
            await peer_connection.setLocalDescription(await peer_connection.createAnswer())

            setTimeout(async () => {
                const local_description = peer_connection.localDescription
                send({
                    message: {
                        answer: await encrypt(their_encryption_key, JSON.stringify(local_description))
                    }
                })
            }, candidate_gather_pause)
            return
        }

        if (candidates) {
            const decrypted_candidates = JSON.parse(await decrypt(their_encryption_key, candidates))
            decrypted_candidates.map(async c => await (peer_connection.addIceCandidate(c)))
        }
    }

    return await result
}


const host = "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEGZDICs222YwVaM6F6goKRq5yihNPRetotApDnfhsie4b7Lj/rqK95pymiJRL7gelk0xgS+6o8KQaHABi6SSBz3bvikuLi2KSX8HfSGkNnHKpkHhijivZeJlQDHuQFive"

let channel = await connectToHost({host: host.trim()})

channel.send(JSON.stringify({action: 'join', channel: 'test'}))
channel.send(JSON.stringify({action: 'list', channel: 'test'}))
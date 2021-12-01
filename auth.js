import {webcrypto as crypto} from "crypto";

const ECDSA_HASH = "SHA-256"
const ECDSA_CURVE = "P-384"
const ECDH_CURVE = "P-384"
export let generateECDSAKeyPair = () => crypto.subtle.generateKey(
    {
        name: "ECDSA",
        namedCurve: ECDSA_CURVE
    },
    true,
    ["sign", "verify"]
)
export let generateECDHKeyPair = () => crypto.subtle.generateKey(
    {
        name: "ECDH",
        namedCurve: ECDH_CURVE
    },
    true,
    ["deriveKey"]
)
export let default_sign = key_pair => async text => arrayBufferToBase64(await crypto.subtle.sign(
    {name: 'ECDSA', hash: ECDSA_HASH},
    key_pair.privateKey,
    new TextEncoder().encode(text)))
export let default_verify = (key, signature /* (base64-encoded) */, text) => crypto.subtle.verify(
    {name: 'ECDSA', hash: ECDSA_HASH},
    key,
    base64ToArrayBuffer(signature),
    new TextEncoder().encode(text))
export let default_encrypt = my_key_pair => async (their_key, text) => {
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
export let default_decrypt = my_key_pair => async (their_key, {iv, ciphertext}) => {
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
export let default_auth_key_import = (base64) => crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64),
    {
        name: 'ECDSA',
        namedCurve: ECDSA_CURVE
    },
    true,
    ['verify']
)
export let default_encryption_key_import = base64 => crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64),
    {
        name: 'ECDH',
        namedCurve: ECDH_CURVE
    },
    false,
    []
)

export let import_private_key = base64 => crypto.subtle.importKey(
    'pkcs8',
    base64ToArrayBuffer(base64),
    {
        name: 'ECDSA',
        namedCurve: ECDSA_CURVE
    },
    true,
    ["sign"]
)

export let import_public_key = base64 => crypto.subtle.importKey(
    'spki',
    base64ToArrayBuffer(base64),
    {
        name: 'ECDH',
        namedCurve: ECDH_CURVE
    },
    true,
    []
)

export let default_key_export = async k => arrayBufferToBase64(await crypto.subtle.exportKey('spki', k.publicKey))

export let export_private_key = async k => arrayBufferToBase64(await crypto.subtle.exportKey('pkcs8', k.privateKey))

// from https://stackoverflow.com/questions/9267899/arraybuffer-to-base64-encoded-string
function arrayBufferToBase64(buffer) {
    var binary = '';
    var bytes = new Uint8Array(buffer);
    var len = bytes.byteLength;
    for (var i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
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

export let shorten_key = (key_string) => {
    return key_string.substr(32,8)
}
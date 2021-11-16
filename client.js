import {WebSocket} from "ws"
import pkg from 'wrtc'
const {RTCPeerConnection} = pkg;
import {
    default_auth_key_import,
    default_decrypt,
    default_encrypt,
    default_encryption_key_import,
    default_key_export,
    default_sign,
    default_verify,
    generateECDHKeyPair,
    generateECDSAKeyPair
} from "./auth.js";
import parseArgs from "minimist";
import * as fs from "fs";

const args = parseArgs(process.argv.slice(2))



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
                           encryption_key_export,
                               signalling_hostname="localhost:443"
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

    const ws = new WebSocket(`wss://${signalling_hostname}/transient`)

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
        if (candidate !== null) {
            // null signals that gathering is complete. We won't send the null along
            candidates.push(candidate)
        }
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


let host_public_key = fs.readFileSync(args["public-key"]).toString()


const signalling_hostname = process.env.SIGNALLING_HOSTNAME || "localhost:8443"
let channel = await connectToHost({host: host_public_key, signalling_hostname: signalling_hostname})

channel.send(JSON.stringify({action: 'join', channel: 'test'}))
channel.send(JSON.stringify({action: 'list', channel: 'test'}))
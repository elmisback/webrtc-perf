import {WebSocket} from "ws"
import pkg from 'wrtc'
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

let basic_signaling_server_config = (peer_key, send_chan, receive_chan)=> {
    const client = get_client({id: peer_key, send: rec => o => send_chan.readyState == 'open' && send_chan.send(JSON.stringify(o))})
    receive_chan.onmessage = ({data}) => client(JSON.parse(data))
    set_heartbeat_timeout()
}

let host = async ({
                  auth_key_pair,
                  // Defaults to acting like a regular signaling server.
                  ondatachannel=basic_signaling_server_config,
                  validate_peer_public_key=base64_peer_key => true,   // Optional filter for who can join.
                  // (Optional below.) See Note 1 in Notes for details on the below parameters.
                  sign,
                  verify,
                  auth_key_import,
                  auth_key_export,
                  encryption_key_import,
                  encryption_key_export,

                  generate_encryption_key_pair=generateECDHKeyPair,  // Called per-connection.
                  encrypt=default_encrypt,  // Will be called with generated key.
                  decrypt=default_decrypt,  // Will be called with generated key.
                  signalling_hostname="localhost:443"

              }) => {
    //auth_key_pair = await generateECDSAKeyPair()
    // See Note 1 in Notes for details on the below parameters.

    sign = sign || default_sign(auth_key_pair)
    verify = verify || default_verify//(auth_key_pair)
    encryption_key_import = encryption_key_import || default_encryption_key_import
    auth_key_import = auth_key_import || default_auth_key_import
    auth_key_export = auth_key_export || default_key_export
    encryption_key_export = encryption_key_export || default_key_export

    // (All external dependencies are above here.)

    const candidate_gather_pause = 500  // ms to wait for ICE candidates

    const ws = new WebSocket(`wss://${signalling_hostname}/host`)
    const send = object => {
        console.log('host.ws.send', object)
        ws.send(JSON.stringify(object))
    }
    const connections = {}
    ws.onerror = async event => console.log('Host:', await auth_key_export(auth_key_pair), 'error. Event:', event)
    ws.onclose = async event => console.log('Host:', await auth_key_export(auth_key_pair), 'websocket connection closed. Event:', {reason: event.reason, code: event.code, wasClean: event.wasClean})
    ws.onmessage = async ({ data }) => {
        if (data == 'ping') return ws.send('pong')
        console.debug('host.ws.onmessage.data:', data)
        const { challenge, message, from } = JSON.parse(data)
        console.debug('host.ws.onmessage.data parsed:', JSON.parse(data))
        if (challenge) {
            return send({
                public_key: await auth_key_export(auth_key_pair),
                signature: await sign(challenge)
            })
        }

        if (!(validate_peer_public_key(from))) return console.log('Rejected join attempt from', from)

        const {encryption_key, signature, answer, candidates} = message
        if (encryption_key) {
            //debugger
            if (!(await verify(await auth_key_import(from), signature, encryption_key))) throw Error('Message signature failed verification.')
            const host_encryption_key_pair = await generate_encryption_key_pair()
            const signed_encryption_key = await sign(await encryption_key_export(host_encryption_key_pair))
            const peer_connection = new RTCPeerConnection({
                iceServers: /*[
          { urls: 'stun:stun.stunprotocol.org:3478' },
          { urls: 'stun:stun.l.google.com:19302' },
          // using more than 2 STUN/TURN servers slows discovery: https://stackoverflow.com/questions/58223805/why-does-using-more-than-two-stun-turn-servers-slow-down-discovery
          //{urls: 'stun:stun1.l.google.com:19302'}
          // 'stun:stun2.l.google.com:19302',
          // 'stun:stun3.l.google.com:19302',
          // 'stun:stun4.l.google.com:19302'  // Firefox complains about more than 5 STUN servers
          // https://numb.viagenie.ca/ hosts a free TURN server apparently?
        ]*/
                    [{
                        urls: ['stun:stun.l.google.com:19302', 'stun:stun.stunprotocol.org']
                    }]

            })
            // peer_connection.onicecandidate = ({ candidate }) => {
            //   console.log(candidate)
            // }
            const channel = peer_connection.createDataChannel('channel-name')  // (offerer creates)
            channel.onopen = () => {
                console.debug('Host datachannel open')
                ondatachannel(from, channel, channel)
            }
            g_connections.push(channel)
            const candidates = []
            const their_encryption_key = await encryption_key_import(encryption_key)
            connections[from] = ({
                peer_connection,
                their_encryption_key,
                host_encryption_key_pair,
                in_candidate_gather_pause: true,
                deferred_candidates: []
                //candidates   // (we already have the necessary access via closure)
            })
            // peer_connection.ondatachannel = event => {
            //   console.log('got datachannel (host)')
            //   event.channel.onopen = () => ondatachannel(from, event.channel, event.channel)
            // }
            peer_connection.onicecandidate = async ({ candidate }) => {
                console.debug('host.onicecandidate', candidate)
                candidates.push(candidate)
                if (candidate == null && peer_connection.connectionState != 'connected' && !connections[from].in_candidate_gather_pause) {
                    // NOTE This condition may not be exactly correct
                    // Example: if connectionState is 'failed'
                    send({
                        to: from,
                        message: {
                            candidates: await encrypt(host_encryption_key_pair)(their_encryption_key, JSON.stringify(candidates))
                        }
                    })
                }
            }

            // create an offer and set the local description to the offer
            await peer_connection.setLocalDescription(await peer_connection.createOffer())

            // schedule send for later to allow candidate gathering
            setTimeout(async () => {
                const local_description = peer_connection.localDescription
                send({
                    to: from,
                    message: {
                        encryption_key: await encryption_key_export(host_encryption_key_pair),
                        signature: signed_encryption_key,
                        offer: await encrypt(host_encryption_key_pair)(their_encryption_key, JSON.stringify(local_description))
                    }
                })
                connections[from].in_candidate_gather_pause = false
            }, candidate_gather_pause)
            return
        } else if (answer) {
            const { their_encryption_key, peer_connection, host_encryption_key_pair, deferred_candidates } = connections[from]
            const decrypted_answer = await decrypt(host_encryption_key_pair)(their_encryption_key, answer)
            console.log('Host got an answer:', JSON.parse(decrypted_answer))
            await peer_connection.setRemoteDescription(JSON.parse(decrypted_answer))
            // NOTE we don't need to set the candidates since they're included in the description now.
            console.log(deferred_candidates)
            if (deferred_candidates.length > 0) deferred_candidates.reverse().map(async c => await (peer_connection.addIceCandidate(c)))
            console.log('Remote description set successfully, connection should start once candidate exchange finishes...')
        } else if (candidates) {
            const { their_encryption_key, peer_connection, host_encryption_key_pair, deferred_candidates } = connections[from]
            const decrypted_candidates = JSON.parse(await decrypt(host_encryption_key_pair)(their_encryption_key, candidates))
            console.log('Host got more candidates:', decrypted_candidates)
            decrypted_candidates.map(async c => peer_connection.remoteDescription ? await (peer_connection.addIceCandidate(c)) : deferred_candidates.push(c))
        } else {
            console.log('illegal message, ignoring.')
        }
    }
}
let auth_key_pair = await generateECDSAKeyPair()
const signalling_hostname = process.env.SIGNALLING_HOSTNAME || "localhost:8443"
host({auth_key_pair, signalling_hostname: signalling_hostname})
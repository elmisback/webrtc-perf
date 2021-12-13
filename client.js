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
    default_verify, export_private_key,
    generateECDHKeyPair,
    generateECDSAKeyPair, import_private_key, import_public_key,
    shorten_key
} from "./auth.js";
import parseArgs from "minimist";
import * as fs from "fs";
import { fileURLToPath } from "url";

const MAIN = process.argv[1] === fileURLToPath(import.meta.url)

const args = parseArgs(process.argv.slice(2))

let message_handlers = ({})
let peers = []
let pcs = ({})
let dcs = ({})
let client_id
let overlay_id = args['id']
if (MAIN && !overlay_id) throw new Error('Please supply an overlay --id for this process')

export let connectToHost = async ({
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
    auth_key_pair = auth_key_pair || await generateECDSAKeyPair()
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
    })
    peer_connection.onicecandidate = ({ candidate }) => {
        console.log(candidate)
    }

    const ws = new WebSocket(`wss://${signalling_hostname}/transient`, {rejectUnauthorized:false})

    // (HACK) since we can't await in the default params above)
    auth_key_pair = await auth_key_pair
    encrypt_key_pair = await encrypt_key_pair
    console.log(`Using key ${shorten_key(await default_key_export(auth_key_pair))}`)

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

export let get_peer_connection = ({
                                      send_signaling_message,
                                      install_signaling_message_handler,
                                      polite,  // only one peer can be polite (easy enough to resolve with ids)
                                      configuration={'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]},
                                  }) => {
    const pc = new RTCPeerConnection(configuration)
    // state (locks)
    let makingOffer = false
    let ignoreOffer = false
    let isSettingRemoteAnswerPending = false

    let candidateQueue = []  // see https://stackoverflow.com/questions/38198751/domexception-error-processing-ice-candidate
    const given_send_signaling_message = send_signaling_message
    send_signaling_message = obj => {
        //console.debug('send_signaling_message', obj)
        given_send_signaling_message(obj)
    }
    // send any ice candidates to the other peer
    pc.onicecandidate = ({candidate}) => candidate !== null && send_signaling_message({candidate})

    // let the "negotiationneeded" event trigger offer generation
    pc.onnegotiationneeded = async () => {
        console.log('negotiation needed')
        if (polite) return;  // HACK hangs without this due to below bug :(
        try {
            makingOffer = true;
            // HACK Note there's a bug in node-webrtc that requires providing an offer/answer explicitly.
            // See https://github.com/node-webrtc/node-webrtc/issues/677
            await pc.setLocalDescription(await pc.createOffer());
            send_signaling_message({description: pc.localDescription});
        } catch (err) {
            console.error(err);
        } finally {
            makingOffer = false;
        }
    };

    install_signaling_message_handler(async ({candidate, description}) => {
        //console.debug('new message', candidate, description)
        try {
            if (description) {
                // An offer may come in while we are busy processing SRD(answer).
                // In this case, we will be in "stable" by the time the offer is processed
                // so it is safe to chain it on our Operations Chain now.
                const readyForOffer =
                    !makingOffer &&
                    (pc.signalingState == "stable" || isSettingRemoteAnswerPending);
                const offerCollision = description.type == "offer" && !readyForOffer;

                ignoreOffer = !polite && offerCollision;
                if (ignoreOffer) {
                    return;
                }
                isSettingRemoteAnswerPending = description.type == "answer";
                console.debug('setting remote desc')
                await pc.setRemoteDescription(description); // SRD rolls back as needed
                if (candidateQueue.length > 0) {  // see candidateQueue definition above
                    await Promise.all(candidateQueue.reverse().map(async (c) => await pc.addIceCandidate(c)))
                    candidateQueue = []
                }
                isSettingRemoteAnswerPending = false;
                if (description.type == "offer") {
                    await pc.setLocalDescription(await pc.createAnswer());
                    send_signaling_message({description: pc.localDescription});
                }
            } else if (candidate) {
                try {
                    if (!pc.remoteDescription) {  // see candidateQueue definition above
                        candidateQueue.push(candidate)
                    }
                    else {
                        await pc.addIceCandidate(candidate);
                    }
                } catch (err) {
                    if (!ignoreOffer) throw err; // Suppress ignored offer's candidates
                }
            }
        } catch (err) {
            //debugger
            console.error(err);
        }
    })

    return pc
}

let host_public_key = fs.readFileSync(args["host-key"]).toString()

//const name = false //args["client-id"] || process.env.NAME || null
let auth_key_pair
// if (name) {
//     try {
//         let private_key = fs.readFileSync(name)
//         private_key = await import_private_key(private_key)
//         let public_key = fs.readFileSync(name + ".pub")
//         public_key = await import_public_key(public_key)

//         auth_key_pair = {publicKey: public_key, privateKey: private_key}
//     } catch {
//         // No keypair on disk for this name yet. Make one and store it
//         console.log("Saving keypair for " + name)
//         auth_key_pair = await generateECDSAKeyPair()
//         fs.writeFileSync(name, await export_private_key(auth_key_pair))
//         fs.writeFileSync(name + ".pub", await default_key_export(auth_key_pair))
//     }
// }


const handle_signaling_message = (({ data }) => {
    // handle signalling messages here
    data = JSON.parse(data)
    if (data == 'ping') {
        channel.send(JSON.stringify('pong'))
        return
    }
    //console.debug(data);
    if (data.action == 'list') {
        // data = {client_id: "my_id", response: ["peer_id1", "peer_id2"]}
        // update the peer mesh with these peers
        //debug.log('Got list command', data)
        client_id = data.client_id
        peers = data.response.filter(p => p != data.client_id)
        const old_pcs = pcs
        pcs = {}
        peers.map(p => pcs[p] = old_pcs[p] || get_peer_connection({
                    polite: client_id < p,
                    send_signaling_message: obj => {
                channel.send(JSON.stringify({action: 'message', body: JSON.stringify(obj), recipient: p}))
                //console.debug('sending signaling message', obj, 'to', p)
            },
                install_signaling_message_handler: onmessage => message_handlers[p] = onmessage
            })
        )
        // Make a simple mesh to check that connections are established.
        const old_dcs = dcs
        dcs = {}
        Object.entries(pcs).map(([peer_id, pc]) => {
            dcs[peer_id] = old_dcs[peer_id]
            if (dcs[peer_id]) return;
            pc.ondatachannel = ({ channel }) => channel.onmessage = ({ data }) => {
                //console.log("Got data from peer", peer_id, data)
                const { command } = JSON.parse(data)
                if (command) handle_command(command, peer_id)
            }
            const dc = pc.createDataChannel("mesh")
            dcs[peer_id] = dc
            dc.onopen = () => dc.send(JSON.stringify({client_id, time: Date.now()}))
        })
    } else if (data.action == 'message' && (data.sender in message_handlers)) {
        message_handlers[data.sender](JSON.parse(data.body))
    }
})

const output_log = []

let outputs = []
let my_call_id

function handle_command({ test, report, call_id, from, to, type = "data" }, controller_id) {
    if (test) {
        outputs.map(dc => send(dc, { from: overlay_id, id: Math.random(), hops: 0, test: true, call_id: my_call_id}))
        return
    }
    if (report) {
        dcs[controller_id].send(JSON.stringify({ report: { overlay_id } }))
        return;
    }
    const receive = to.includes("self")
    to = to.filter(s => s != "self")
    const output_channels = to.map(to_peer_id => pcs[to_peer_id].createDataChannel(`${call_id}-${to_peer_id}`))
    output_channels.map(dc => dc.onopen = () => send(dc, {why_no_send: true}))
    //console.log(call_id, "output_channels", to)
    if (!from) {
        outputs = output_channels
        my_call_id = call_id
    } else {
        const old_ondatachannel = pcs[from].ondatachannel
        pcs[from].ondatachannel = ({ channel }) => {
            old_ondatachannel({ channel });
            if (channel.label == `${call_id}-${client_id}`) {
                channel.onmessage = ({ data }) => {
                    console.log("here", data)
                    const temp = JSON.parse(data)
                    output_channels.map(dc => send(dc, {...temp, last: overlay_id, hops: temp.hops+1, call_id}))
                    if (receive) { // NOTE this will try parsing all the data received...
                        const out = JSON.parse(data)
                        if (out.test) send(dcs[controller_id], ({ report: { ...out, receiver: overlay_id } }))
                        //output_log.push({received: data, time: Date.now()})
                    }
                }
            }
        }
        pcs[from].createDataChannel(`${call_id}`)
    }
}
const send = (dc, o) => dc.send(JSON.stringify(o))


let channel

if (MAIN) {
    const signalling_hostname = process.env.SIGNALLING_HOSTNAME || "localhost:8443"
    console.log(`Connecting to host with key ${shorten_key(host_public_key)}`)
    channel = await connectToHost({ host: host_public_key, auth_key_pair: auth_key_pair, signalling_hostname: signalling_hostname })
    channel.onmessage = handle_signaling_message

    await channel.send(JSON.stringify({ action: 'join', channel: 'test' }))
    await channel.send(JSON.stringify({ action: 'list', channel: 'test' }))
}



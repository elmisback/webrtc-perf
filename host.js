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
    generateECDSAKeyPair, import_private_key, import_public_key
} from "./auth.js";
import parseArgs from "minimist";
import * as fs from "fs";

const args = parseArgs(process.argv.slice(2))

let g_connections = []

let server_connections = []

let sessions = []

let no_ping = {}
let serverPing

let get_client = ({id, send}) => {
    if (server_connections[id]) throw Error('That id exists.')
    const result = request => {
        request == 'pong' ? delete no_ping[id] : handle_request({...request, client_id: id})
    }
    server_connections[id] = send(result)
    return result
}

let update_clients = (session) => {
    Object.keys(session).map(id => server_connections[id] && server_connections[id]({ client_id: id, action: 'list', response: Object.keys(session)}))
}

let handle_request = (args) => {  // handle client message
    let {action, client_id, channel, name=channel, recipient, body, sender} = args
    const err = msg => (console.log(msg), server_connections[client_id]({error: msg}))
    console.log('Server: request:', args)
    const K = Object.keys
    const V = Object.values
    const s = K(sessions).find(name1 => name1 == name)
        || (!name && V(sessions).find(s => s[client_id])) || undefined;

    const R = args => {
        console.log('responding', args)
        server_connections[client_id]({action, response: args, client_id})
        console.log('responded')
    }
    const session = sessions[s] || s
    const ops = {
        list: () =>
            s ? R(K(session))
                : R({sessions: K(sessions)
                        .map(s => ({name: s.name}))}),
        join: () => {
            if (!name) return err(`can't join with session name ${name}`)
            if (!session) return sessions[name] = {[client_id] : true}
            session[client_id] = true
            update_clients(session)
        },
        leave: () => {
            const session = sessions[s]
            if (!s || !session || !session[client_id]) return err(`You're not in that session.`)
            delete session[client_id] && update_clients(session)
            if (Object.keys(session).length == 0) delete sessions[s]
            return true
        },
        message: () =>
            !s ? err("You need to be in a session to send a message.")
                : !(session[client_id] && session[recipient]) ? err("Couldn't find that recipient in your session.")
                    : server_connections[recipient]({action, sender: client_id, name, body, recipient})
    }
    if (!Object.keys(ops).includes(action)) {console.log('Invalid action'); return}

    ops[action]()
}

let set_heartbeat_timeout = (ms=3000) => {
    if (serverPing) clearInterval(serverPing)
    serverPing = setInterval(() => {
        let updated_sessions = ({})
        // remove clients that have died
        Object.keys(no_ping).map(client_id => {
            console.log('Dropping', client_id)
            delete server_connections[client_id]
            Object.keys(sessions).map(s => {
                updated_sessions[s] = true
                delete sessions[s][client_id]
                if (Object.keys(s).length == 0) delete sessions[s]
            })
            delete no_ping[client_id]
        })
        // notify living clients about dead clients
        Object.keys(updated_sessions).map(s => sessions[s] && update_clients(sessions[s]))

        // handle next iteration
        Object.keys(server_connections).map(u => no_ping[u] = true)
        Object.values(server_connections).map(c => setTimeout(() => c('ping')))
    }, ms)
}


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
                if (candidate !== null) {
                    // null signals that gathering is complete. We won't send the null along
                    candidates.push(candidate)
                }
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

let auth_key_pair
if ("private-key" in args) {
    let private_key = fs.readFileSync(args["private-key"])
    private_key = await import_private_key(private_key)
    let public_key = fs.readFileSync(args["public-key"])
    public_key = await import_public_key(public_key)

    auth_key_pair = {publicKey: public_key, privateKey: private_key}
} else {
    auth_key_pair = await generateECDSAKeyPair()
    fs.writeFileSync("private.key", await export_private_key(auth_key_pair))
    fs.writeFileSync("public.key", await default_key_export(auth_key_pair))
}
const signalling_hostname = process.env.SIGNALLING_HOSTNAME || "localhost:8443"
console.log(`Starting host with key ${await default_key_export(auth_key_pair)}`)
host({auth_key_pair, signalling_hostname: signalling_hostname})
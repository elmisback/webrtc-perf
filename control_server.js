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
    generateECDSAKeyPair,
    shorten_key
} from "./auth.js";
import { connectToHost, get_peer_connection } from './client.js';

import parseArgs from "minimist";
import * as fs from "fs";

const args = parseArgs(process.argv.slice(2))

let message_handlers = ({})
let peers = []
let pcs = ({})
let dcs = ({})
let client_id

// let connectToHost = async ({
//                            host,
//                            auth_key_pair,  // Optional (unless you want to be recognized).
//                            // (Optional below.) See Note 1 in Notes for details on the below parameters.
//                            encrypt_key_pair,
//                            sign,
//                            verify,
//                            encrypt,
//                            decrypt,
//                            encryption_key_import,
//                            auth_key_import,
//                            auth_key_export,
//                            encryption_key_export,
//                                signalling_hostname="localhost:443"
//                        }) => {
//     auth_key_pair = auth_key_pair || await generateECDSAKeyPair()
//     // See Note 1 in Notes for details on the below parameters.
//     encrypt_key_pair = await generateECDHKeyPair()
//     sign = default_sign(auth_key_pair)
//     verify = default_verify//(auth_key_pair)
//     encrypt = default_encrypt(encrypt_key_pair)
//     decrypt = default_decrypt(encrypt_key_pair)
//     encryption_key_import = default_encryption_key_import
//     auth_key_import = default_auth_key_import
//     auth_key_export = default_key_export
//     encryption_key_export = default_key_export

//     // (All external dependencies are above here.)

//     const candidate_gather_pause = 500  // ms to wait for ICE candidates
//     const peer_connection = new RTCPeerConnection({
//         iceServers:
//             [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.stunprotocol.org'] }]
//     })
//     peer_connection.onicecandidate = ({ candidate }) => {
//         console.log(candidate)
//     }

//     const ws = new WebSocket(`wss://${signalling_hostname}/transient`, {rejectUnauthorized:false})

//     // (HACK) since we can't await in the default params above)
//     auth_key_pair = await auth_key_pair
//     encrypt_key_pair = await encrypt_key_pair
//     console.log(`Using key ${shorten_key(await default_key_export(auth_key_pair))}`)

//     const candidates = []
//     let their_encryption_key = undefined


//     const send = object => ws.send(JSON.stringify(object))
//     let resolve
//     let result = new Promise(r => resolve = r)
//     peer_connection.ondatachannel = event => {
//         console.log('got datachannel (transient)')
//         resolve(event.channel)
//     }
//     const chan = peer_connection.createDataChannel('channel-name')
//     peer_connection.onicecandidate = async ({ candidate }) => {
//         console.log(candidate)
//         if (candidate !== null) {
//             // null signals that gathering is complete. We won't send the null along
//             candidates.push(candidate)
//         }
//         if (candidate == null && peer_connection.connectionState != 'connected') {
//             // NOTE This condition may not be exactly correct
//             // Example: if connectionState is 'failed'
//             send({
//                 message: {candidates: await encrypt(their_encryption_key, JSON.stringify(candidates))}
//             })
//         }
//     }

//     const signed_encryption_key = await sign(await encryption_key_export(encrypt_key_pair))
//     ws.onclose = event => console.log('Websocket connection closed. Event:', {reason: event.reason, code: event.code, wasClean: event.wasClean})
//     ws.onmessage = async ({ data }) => {
//         if (data == 'ping') return send('pong')
//         console.debug('transient.ws.onmessage.data:', data)
//         const { challenge, message } = JSON.parse(data)
//         console.debug('transient.ws.onmessage.data parsed:', JSON.parse(data))
//         if (challenge) {
//             return send({
//                 public_key: await auth_key_export(auth_key_pair),
//                 signature: await sign(challenge),
//                 host,
//                 message: {
//                     encryption_key: await encryption_key_export(encrypt_key_pair),
//                     signature: signed_encryption_key
//                 }
//             })
//         }

//         const { encryption_key, signature, offer, candidates } = message

//         if (encryption_key) {
//             if (!(await verify(await auth_key_import(host), signature, encryption_key))) throw Error('Message signature failed verification.')
//             their_encryption_key = await encryption_key_import(encryption_key)
//         }  // fall through

//         if (offer) {
//             if (!their_encryption_key) throw Error(`Host didn't send an encryption key.`)
//             const decrypted_offer = await decrypt(their_encryption_key, offer)
//             console.log('Transient got an offer:', JSON.parse(decrypted_offer))
//             await peer_connection.setRemoteDescription(JSON.parse(decrypted_offer))
//             await peer_connection.setLocalDescription(await peer_connection.createAnswer())

//             setTimeout(async () => {
//                 const local_description = peer_connection.localDescription
//                 send({
//                     message: {
//                         answer: await encrypt(their_encryption_key, JSON.stringify(local_description))
//                     }
//                 })
//             }, candidate_gather_pause)
//             return
//         }

//         if (candidates) {
//             const decrypted_candidates = JSON.parse(await decrypt(their_encryption_key, candidates))
//             decrypted_candidates.map(async c => await (peer_connection.addIceCandidate(c)))
//         }
//     }

//     return await result
// }

// export let get_peer_connection = ({
//                                       send_signaling_message,
//                                       install_signaling_message_handler,
//                                       polite,  // only one peer can be polite (easy enough to resolve with ids)
//                                       configuration={'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]},
//                                   }) => {
//     const pc = new RTCPeerConnection(configuration)
//     // state (locks)
//     let makingOffer = false
//     let ignoreOffer = false
//     let isSettingRemoteAnswerPending = false

//     let candidateQueue = []  // see https://stackoverflow.com/questions/38198751/domexception-error-processing-ice-candidate
//     const given_send_signaling_message = send_signaling_message
//     send_signaling_message = obj => {
//         console.debug('send_signaling_message', obj)
//         given_send_signaling_message(obj)
//     }
//     // send any ice candidates to the other peer
//     pc.onicecandidate = ({candidate}) => candidate !== null && send_signaling_message({candidate})

//     // let the "negotiationneeded" event trigger offer generation
//     pc.onnegotiationneeded = async () => {
//         console.log('negotiation needed')
//         try {
//             makingOffer = true;
//             await pc.setLocalDescription();
//             send_signaling_message({description: pc.localDescription});
//         } catch (err) {
//             console.error(err);
//         } finally {
//             makingOffer = false;
//         }
//     };

//     install_signaling_message_handler(async ({candidate, description}) => {
//         console.debug('new message', candidate, description)
//         try {
//             if (description) {
//                 // An offer may come in while we are busy processing SRD(answer).
//                 // In this case, we will be in "stable" by the time the offer is processed
//                 // so it is safe to chain it on our Operations Chain now.
//                 const readyForOffer =
//                     !makingOffer &&
//                     (pc.signalingState == "stable" || isSettingRemoteAnswerPending);
//                 const offerCollision = description.type == "offer" && !readyForOffer;

//                 ignoreOffer = !polite && offerCollision;
//                 if (ignoreOffer) {
//                     return;
//                 }
//                 isSettingRemoteAnswerPending = description.type == "answer";
//                 console.debug('setting remote desc')
//                 await pc.setRemoteDescription(description); // SRD rolls back as needed
//                 if (candidateQueue.length > 0) {  // see candidateQueue definition above
//                     await Promise.all(candidateQueue.reverse().map(async (c) => await pc.addIceCandidate(c)))
//                     candidateQueue = []
//                 }
//                 isSettingRemoteAnswerPending = false;
//                 if (description.type == "offer") {
//                     await pc.setLocalDescription();
//                     send_signaling_message({description: pc.localDescription});
//                 }
//             } else if (candidate) {
//                 try {
//                     if (!pc.remoteDescription) {  // see candidateQueue definition above
//                         candidateQueue.push(candidate)
//                     }
//                     else {
//                         await pc.addIceCandidate(candidate);
//                     }
//                 } catch (err) {
//                     if (!ignoreOffer) throw err; // Suppress ignored offer's candidates
//                 }
//             }
//         } catch (err) {
//             //debugger
//             console.error(err);
//         }
//     })

//     return pc
// }

let host_public_key = fs.readFileSync(args["host-key"]).toString()


const signalling_hostname = process.env.SIGNALLING_HOSTNAME || "localhost:8443"
console.log(`Connecting to host with key ${shorten_key(host_public_key)}`)
let channel = await connectToHost({host: host_public_key, signalling_hostname: signalling_hostname})

channel.onmessage = (({ data }) => {
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
      console.log('Got list command', data)
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
              console.log("Got data from peer", peer_id, data)
              const {report} = JSON.parse(data)
            if (report) handle_report({ ...report, client_id: peer_id })
          }
          const dc = pc.createDataChannel("mesh")
          dcs[peer_id] = dc
          dc.onopen = () => dc.send(JSON.stringify({
            command: {report: true}}))
      })
  } else if (data.action == 'message' && (data.sender in message_handlers)) {
      message_handlers[data.sender](JSON.parse(data.body))
  }
})

const N_PEERS = 5
let INITED = false
let confirmed = {}
const translation_table = ({})

// makes a simple chain call on a list of peers of length n
// starts from peer i, broadcasts to all other peers along the chain
// 1-indexed
// >>> simple_chain_from_index(3, 5)
// {"3":{"4":{"5":{"1":{"2":{"self":true},"self":true},"self":true},"self":true}}}
//
const simple_chain_from_index = (i, n) => ([...new Array(n)].map((_, j) => (((j + i) - 1) % n) + 1).reverse().reduce((acc, e, i) => ({ ...i >= n - 2 ? {} : {self: true}, [e]: acc}), {self: true}))

const handle_report = async ({ client_id, overlay_id, from }) => {
  console.log('handling report', client_id, overlay_id, from)
  if (from) {
    confirmed[from] = (confirmed[from] || 0) + 1
    console.log(confirmed)
    if (Object.values(confirmed).filter(v => v == N_PEERS - 1).length == N_PEERS) {
      console.log('Overlay network established!')
    }
    return
  }
  translation_table[overlay_id] = client_id
  const overlay_ids = Object.keys(translation_table)
  if (overlay_ids.length < N_PEERS || INITED) return;
  // all peers have arrived, we can now start managing the overlay network

  // set of each-to-all chains:
  const chains = [...new Array(N_PEERS)].map((_, i) => ({ call_id: i, call: simple_chain_from_index(i + 1, N_PEERS) }))

  const messages = chains.flatMap(({ call_id, call }) => get_messages(call).map(m => ({ call_id, ...m })))
  /*
    for a connection like A -> B -> C and D
    the message to B looks like 
    { from: "overlay_id_of_A", 
      through: "overlay_id_of_B", 
      to: ["overlay_id_of_C", "overlay_id_of_D"] }
  */
  const T = { ...translation_table, self: "self" }
  console.log('translation_table', T)
  console.log("messages", messages)
  const translated = messages.map(({ from, through, to, call_id}) => ({ call_id, through: T[through], from: T[from], to: to.map(s => T[s]) }))
  //console.log(translated)
  translated.map(m => send(dcs[m.through], { command: m }))
  
  await new Promise(resolve => setTimeout(() => resolve(), 5000))

  const peer_ids = Object.values(translation_table)
  peer_ids.map(peer_id => send(dcs[peer_id], { command: { test: true } }))
  INITED = true
}

const send = (dc, o) => dc.send(JSON.stringify(o))

await channel.send(JSON.stringify({action: 'join', channel: 'test'}))
await channel.send(JSON.stringify({action: 'list', channel: 'test'}))


function traverse (t, f, parent=undefined) {  /* f : tree * 'a -> list of 'b */
  return [...f(t, parent), ...Object.entries(t).map(([k,v]) => traverse(v, f, k)).flat()]
}

//const get_links = tree => traverse(tree, (t, _) => Object.keys(t).map(k => k != 'self' && Object.keys(t[k]).map(k1 => k1 != 'self' && [k, k1]))).flat().filter(e => e)

const get_messages = tree => traverse(tree, (t, parent) => [[t, parent]]).map(([t, parent]) => Object.entries(t).map(([k, v]) => k == "self" ? false : ({from: parent, through:k, to: Object.keys(v)}))).flat().filter(e => e)

// messages.map(({from, through, to}, i) => dcs[translation[through]].send(JSON.stringify({call_id: i, from: translation[from], to: to.map(s => translation[s])})))
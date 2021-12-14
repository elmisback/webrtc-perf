import {

    shorten_key
} from "./auth.js";

import parseArgs from "minimist";
import * as fs from "fs";
import {connectToHost, get_peer_connection} from "./communication.js";

const args = parseArgs(process.argv.slice(2))

let message_handlers = ({})
let peers = []
let pcs = ({})
let dcs = ({})
let client_id

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

  const messages = chains.flatMap(({ call_id, call }) => get_messages(call).map(m => ({ call_id, ...m }))).reverse()  // HACK reverse to make sure datachannel handlers get init'd before datachannels? 
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
  
  //await new Promise(resolve => setTimeout(() => resolve(), 5000))

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
import {
    get_persisted_keypair,
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
let key_name = args['key']
let auth_key_pair
// Provide a key name if you want client IDs to be fixed for debugging purposes
if (key_name) {
    auth_key_pair = await get_persisted_keypair(key_name)
}
let channel = await connectToHost({host: host_public_key, auth_key_pair: auth_key_pair, signalling_hostname: signalling_hostname})

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
      //console.log('Got list command', data)
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
              console.log("Got data from peer", shorten_key(peer_id), data)
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

// makes a simple chain call on a list of peers of length n
// starts from peer i, broadcasts to all other peers along the chain
// 1-indexed
// >>> N_chain_from_index(5, 3)
// {"3":{"4":{"5":{"1":{"2":{"self":true},"self":true},"self":true},"self":true}}}
//
const N_chain_from_index = (n, i) => ([...new Array(n)].map((_, j) => (((j + i) - 1) % n) + 1).reverse().reduce((acc, e, i) => ({ ...i >= n - 2 ? {} : {self: true}, [e]: acc}), {self: true}))

// Function for building a tree based on node names and an accumulated value (parent_prop). post postprocesses the values (but not the root).
function build_tree (root, get_children, get_parent_prop=e => null, parent_prop, post) { return {[root]: post(get_children(root, parent_prop).map(k => build_tree(k, get_children, get_parent_prop, get_parent_prop(root, k, parent_prop), post)).reduce((acc, t) => ({...acc, ...t}), {})) } }

const powers_of_2_up_to_n = n => {
  let helper = (k, A) => 2 ** k >= n ? A : helper(k + 1, [...A, 2 ** k])
  return helper(0, [])
}

function kmap (f, o) { return typeof o == 'object' ? Object.entries(o).reduce((acc, [k, v]) => ({...acc, [f(k)]: kmap(f, v)}), {}) : o}

const build_broadcast_tree = (root, get_children, get_parent_prop = e => null, parent_prop) => {
  const o = build_tree(root, get_children, get_parent_prop = e => null, parent_prop, e => ({ ...e, self: true }))
  delete o.self
  delete o[root].self
  return o
}

const N_chord_from_index = (N, idx) => {
  const o = build_tree(0, (n, p) => powers_of_2_up_to_n(N).filter(v => v < p).map(v => v + n).filter(v => v < N), (root, k, p) => k - root < 0 ? (k + N) - root : k - root, N, e => ({ ...e, self: true }))
  delete o.self
  delete o[0].self
  return kmap(i => i == 'self' ? 'self' : (parseInt(i) + idx - 1) % N + 1, o)
}

// Configuration ////////////////////////////
const EXAMPLE_N = 5  // USAGE modify to set number of peers in most examples

// Network configurations below here
const ALL_TO_ALL_CHAINS = [...new Array(EXAMPLE_N)].map((_, i) => ({ call_id: i, call: N_chain_from_index(i + EXAMPLE_N, 1) }))
const ONE_TO_ALL_CHAIN = [{ call_id: 0, call: N_chain_from_index(EXAMPLE_N, 1) }]
const ONE_TO_ALL_TREE = [{ call_id: 0, call: N_chord_from_index(EXAMPLE_N, 1) }]
const ONE_TO_ALL_MESH = [{ call_id: 0, call: { 1: [...new Array(EXAMPLE_N - 1)].reduce((acc, _, i) => ({ ...acc, [i + 2]: { self: true } }), {}) } }]
const NONTRIV1 = [
  build_broadcast_tree(1, root => ({ 1: [4], 4: [2, 3, 5, 7], 5: [6], 7: [8] })[root] || []),
  build_broadcast_tree(2, root => ({ 2: [4], 4: [1, 3, 5, 7], 5: [6], 7: [8] })[root] || []),
  build_broadcast_tree(3, root => ({ 3: [4], 4: [1, 2, 5, 7], 5: [6], 7: [8] })[root] || [])
].map((t, i) => ({ call_id: i, call: t }))
const NONTRIV2 = [
  build_broadcast_tree(1, root => ({ 1: [2, 3, 4], 4: [5, 7], 5: [6], 7: [8] })[root] || []),
  build_broadcast_tree(2, root => ({ 2: [1, 3, 4], 4: [5, 7], 5: [6], 7: [8] })[root] || []),
  build_broadcast_tree(3, root => ({ 3: [1, 2, 4], 4: [5, 7], 5: [6], 7: [8] })[root] || [])
].map((t, i) => ({ call_id: i, call: t }))


const CALLS = ONE_TO_ALL_MESH   // USAGE set the example to run here

// End Configuration ////////////////////////////

// Globals
let INITED = false
const uniq = A => [...new Set(A)]
const N_PEERS = uniq(traverse(CALLS[0], t => Object.keys(t)).flat()).filter(e => !['self', 'call_id', 'call'].includes(e)).length
let confirmed = {}
const translation_table = ({})

// HAX: Needed to give non-number overlay names to play nice with key files etc
const prefix_names = (old_name) => {
    if (old_name === "self"){
        return old_name;
    }
    else return "c" + old_name
}

const handle_report = async ({ client_id, overlay_id, from }) => {
  console.log('handling report', shorten_key(client_id), overlay_id, from)
  if (from) {
    // A connection establishment test went through,
    // so we check if the overlay network is done being set up.
    confirmed[from] = (confirmed[from] || 0) + 1
    console.log(confirmed)
    const num_connected_to_all = Object.values(confirmed).filter(v => v == N_PEERS - 1).length
    const all_connected_to_all = Object.values(confirmed).filter(v => v == N_PEERS - 1).length == N_PEERS
    //const one_connected_to_all = Object.values(confirmed).filter(v => v == N_PEERS - 1).length == 1
    if (CALLS.length == num_connected_to_all) {
      console.log(`${num_connected_to_all}-to-all overlay network established!`)
      const caller_ids = Object.entries(confirmed).filter(([k, v]) => v == N_PEERS - 1)
        .map(([k, v]) => k)
        .map(overlay_id => translation_table[prefix_names(overlay_id)])

      // for (let peer_id in dcs) {
      //     send(dcs[peer_id], {command: {broadcast: true}})
      // }
      caller_ids.map(caller_id => send(dcs[caller_id], { command: { broadcast: true } }))

      setTimeout(() => {
          console.log("Ending broadcast")
          for (let peer_id in dcs) {
              send(dcs[peer_id], {command: {end_broadcast: true}})
          }
      }, 5 * 1000)
    }
    return
  }
  translation_table[prefix_names(overlay_id)] = client_id
  const overlay_ids = Object.keys(translation_table)
  console.log(overlay_ids.length, 'have arrived out of', N_PEERS)
  if (overlay_ids.length < N_PEERS || INITED) return;
  // all peers have arrived, we can now start managing the overlay network

  // set of each-to-all chains:
  

  const messages = CALLS.flatMap(({ call_id, call }) => get_messages(call).map(m => ({ call_id, ...m }))).reverse()  // HACK reverse to make sure datachannel handlers get init'd before datachannels? 
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
  const translated = messages.map(({ from, through, to, call_id}) => ({ call_id, through: T[prefix_names(through)], from: T[prefix_names(from)], to: to.map(s => T[prefix_names(s)]) }))
  console.log(translated)
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

const get_messages = tree => traverse(tree, (t, parent) => [[t, parent]]).map(([t, parent]) => Object.entries(t).map(([k, v]) => k == "self" ? false : ({from: parent, through:k, to: Object.keys(v)}))).flat().filter(e => e)

import {
    get_persisted_keypair,
    shorten_key
} from "./auth.js";
import parseArgs from "minimist";
import * as fs from "fs";
import {fileURLToPath} from "url";
import {connectToHost, get_peer_connection} from "./communication.js";


const MAIN = process.argv[1] === fileURLToPath(import.meta.url)

const args = parseArgs(process.argv.slice(2))

let message_handlers = ({})
let peers = []
let pcs = ({})
let dcs = ({})
let client_id
let overlay_id = args['id']
let key_name = args['key']
if (MAIN && !overlay_id) throw new Error('Please supply an overlay --id for this process')

let host_public_key = fs.readFileSync(args["host-key"]).toString()



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
        outputs.map(dc => send(dc, { from: overlay_id, last: overlay_id, id: Math.random(), hops: 0, test: true, call_id: my_call_id}))
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
                        output_log.push({received: data, time: Date.now()})
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
    let auth_key_pair
    // Provide a key name if you want client IDs to be fixed for debugging purposes
    if (key_name) {
        auth_key_pair = await get_persisted_keypair(key_name)
    }

    channel = await connectToHost({ host: host_public_key, auth_key_pair: auth_key_pair, signalling_hostname: signalling_hostname })
    channel.onmessage = handle_signaling_message

    await channel.send(JSON.stringify({ action: 'join', channel: 'test' }))
    await channel.send(JSON.stringify({ action: 'list', channel: 'test' }))
}



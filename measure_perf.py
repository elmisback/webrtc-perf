#!/usr/bin/python

import os
from argparse import ArgumentParser
from subprocess import Popen
from time import sleep

from mininet.link import TCLink, TCIntf
from mininet.net import Mininet
from mininet.node import CPULimitedHost
from mininet.node import OVSController
from mininet.topo import Topo
from mininet.util import dumpNodeConnections

parser = ArgumentParser(description="tests")

parser.add_argument('--delay',
                    type=float,
                    help="Link propagation delay (ms)",
                    default=10)

parser.add_argument('--dir', '-d',
                    help="Directory to store outputs",
                    required=True)


parser.add_argument('--maxq',
                    type=int,
                    help="Max buffer size of network interface in packets",
                    default=100)

# Use the linux default congestion control
parser.add_argument('--cong',
                    help="Congestion control algorithm to use",
                    default="cubic")

# Expt parameters
args = parser.parse_args()
if args.dir:
    args.dir = os.path.realpath(args.dir)

homogenous_links = {
    "s1": {
        "peers": {
            "h0": {"up": 200, "down": 200},
            "h1": {"up": 10, "down": 100},
            "h2": {"up": 8, "down": 24},
            "c1": {"up": 8, "down": 24},
            "c2": {"up": 8, "down": 24},
            "c3": {"up": 8, "down": 24},
            "c4": {"up": 8, "down": 24},
            "c5": {"up": 8, "down": 24},

        },
        "attributes":  {"up": 10, "down": 20}
       }
}

bottleneck_link = {
    "s1": {
        "peers": {
            "h0": {"up": 200, "down": 200},
            "h1": {"up": 10, "down": 100},
            "h2": {"up": 8, "down": 24},
            "c1": {"up": 3, "down": 24},
            "c2": {"up": 8, "down": 24},
            "c3": {"up": 8, "down": 24},
            "c4": {"up": 8, "down": 24},
            "c5": {"up": 8, "down": 24},

        },
        "attributes":  {"up": 8, "down": 24}
       }
}

homogenous_links_big = {
    "s1": {
        "peers": {
            "h0": {"up": 200, "down": 200},
            "h1": {"up": 10, "down": 100},
            "h2": {"up": 8, "down": 24},
            "c1": {"up": 8, "down": 24},
            "c2": {"up": 8, "down": 24},
            "c3": {"up": 8, "down": 24},
            "c4": {"up": 8, "down": 24},
            "c5": {"up": 8, "down": 24},
            "c6": {"up": 8, "down": 24},
            "c7": {"up": 8, "down": 24},
            "c8": {"up": 8, "down": 24},
            "c9": {"up": 8, "down": 24},
            "c10": {"up": 8, "down": 24},
            "c11": {"up": 8, "down": 24},
            "c12": {"up": 8, "down": 24},
            "c13": {"up": 8, "down": 24},
            "c14": {"up": 8, "down": 24},
            "c15": {"up": 8, "down": 24},
            "c16": {"up": 8, "down": 24},
            "c17": {"up": 8, "down": 24},
            "c18": {"up": 8, "down": 24},
            "c19": {"up": 8, "down": 24},
            "c20": {"up": 8, "down": 24},
            "c21": {"up": 8, "down": 24},
            "c22": {"up": 8, "down": 24},
            "c23": {"up": 8, "down": 24},
            "c24": {"up": 8, "down": 24},
            "c25": {"up": 8, "down": 24},
            "c26": {"up": 8, "down": 24},

        },
        "attributes":  {"up": 8, "down": 24}
       }
}

mixed_lan_links = {
    "s1": {
        "peers" : {
            "h0": {"up": 200, "down": 200},
            "h1": {"up": 10, "down": 100},
            "h2": {"up": 8, "down": 24},
            "s2": {
                "peers": {
                    "c1": {"up": 100, "down": 100, "delay": 1},
                    "c2": {"up": 100, "down": 100, "delay": 1},
                    "c3": {"up": 100, "down": 100, "delay": 1},
                },
                "attributes":  {"up": 20, "down": 20}
            },
            "c4": {"up": 40, "down": 40},
            "c5": {"up": 8, "down": 24},
            "c6": {"up": 8, "down": 24},
            "c7": {"up": 8, "down": 24},
            "c8": {"up": 8, "down": 24},
            },
        "attributes":  {"up": 8, "down": 24}
    }
}

roles = {"lookup": "h0", "host": "h1", "control": "h2"}


class AsymTCLink(TCLink):
    "Link with potential asymmetric TC interfaces configured via opts"

    def __init__(self, node1, node2, port1=None, port2=None,
                 intfName1=None, intfName2=None,
                 addr1=None, addr2=None, **params):
        p1 = {}
        p2 = {}
        if 'params1' in params:
            p1 = params['params1']
            del params['params1']
        if 'params2' in params:
            p2 = params['params2']
            del params['params2']

        par1 = params.copy()
        par1.update(p1)

        par2 = params.copy()
        par2.update(p2)

        TCLink.__init__(self, node1, node2, port1=port1, port2=port2,
                        intfName1=intfName1, intfName2=intfName2,
                        cls1=TCIntf,
                        cls2=TCIntf,
                        addr1=addr1, addr2=addr2,
                        params1=par1,
                        params2=par2)


class PerfTopo(Topo):
    def build(self, layout):
        def setup_layer(switch_name, layer, parent_switch):
            switch = self.addSwitch(switch_name)
            if parent_switch:
                attributes = layer["attributes"]
                delay = attributes.get("delay", args.delay)
                self.addLink(switch,
                             parent_switch, cls=AsymTCLink,
                             params1={"bw": attributes["down"], "delay": f'{delay}ms', "max_queue_size": args.maxq},
                             params2={"bw": attributes["up"], "delay": f'{delay}ms', "max_queue_size": args.maxq})
            for key, value in layer["peers"].items():
                if "up" not in value.keys():
                    # This entry represents another switch
                    setup_layer(key, value, switch)
                    continue
                host = self.addHost(key)
                delay = value.get("delay", args.delay)
                self.addLink(switch,
                             host, cls=AsymTCLink,
                             params1={"bw": value["down"], "delay": f'{delay}ms', "max_queue_size": args.maxq},
                             params2={"bw": value["up"], "delay": f'{delay}ms', "max_queue_size": args.maxq})
        setup_layer("s1", layout["s1"], None)

def start_lookup_server(net, name):
    host = net.get(name)
    proc = host.popen(f"cd ../auth-rtc && node server.js > {args.dir}/{name}_log.txt", shell=True)
    sleep(1)
    return [proc]

def env_hostname(net ,lookup_hostname):
    return f"SIGNALLING_HOSTNAME={net.get(lookup_hostname).IP()}:8443"

def logging_args(dir, name):
    return f"> {dir}/{name}_log.txt 2> {dir}/{name}_err_log.txt"

def start_host(net, name, lookup):
    host = net.get(name)
    proc = host.popen(
        f"{env_hostname(net, lookup)} node host.js --key keys/{name} {logging_args(args.dir, name)} t",
        shell=True)
    sleep(1)
    return [proc]

def start_control_server(net, name, lookup, party_host):
    host = net.get(name)
    proc = host.popen(
        f"{env_hostname(net, lookup)} node control_server.js --key keys/{name} --host-key keys/{party_host}.pub {logging_args(args.dir, name)}",
        shell=True)
    sleep(1)
    return [proc]

def start_client(net, name, lookup, party_host):
    host = net.get(name)
    proc = host.popen(
        f"{env_hostname(net, lookup)} node client.js --key keys/{name} --id {name} --host-key keys/{party_host}.pub {logging_args(args.dir, name)} ",
        shell=True)
    sleep(1)
    return [proc]


def measure_perf():
    if not os.path.exists(args.dir):
        os.makedirs(args.dir)
    topo = PerfTopo(mixed_lan_links)
    net = Mininet(topo=topo, host=CPULimitedHost, link=AsymTCLink, controller=OVSController)
    net.start()
    # This dumps the topology and how nodes are interconnected through
    # links.
    dumpNodeConnections(net.hosts)
    # This performs a basic all pairs ping test.
    #net.pingAll()

    # We expect one of each of these roles
    lookup_host = roles["lookup"]
    start_lookup_server(net, lookup_host)
    party_host = roles["host"]
    start_host(net, party_host, lookup_host)
    start_control_server(net, roles["control"], lookup_host, party_host)

    for key in net.keys():
        if key == "c0":
            # Not sure how this gets in the network...
            continue
        if topo.isSwitch(key):
            print("Skipping " + key)
            continue
        role = roles.get(key, "client")
        if role == "client":
            start_client(net, key, lookup_host, party_host)
        else:
            raise RuntimeError("No role for " + key)
    print("Processes started. Letting things run...")
    sleep(30)
    print("Done. Shutting down.")
    net.stop()
    # Ensure that all processes you create within Mininet are killed.
    # Sometimes they require manual killing.
    Popen("pgrep -f node | xargs kill -9", shell=True).wait()


if __name__ == "__main__":
    measure_perf()

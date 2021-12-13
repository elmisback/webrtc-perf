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
parser.add_argument('--bw-host', '-B',
                    type=float,
                    help="Bandwidth of host links (Mb/s)",
                    default=1000)

parser.add_argument('--bw-net', '-b',
                    type=float,
                    help="Bandwidth of bottleneck (network) link (Mb/s)",
                    required=True)

parser.add_argument('--delay',
                    type=float,
                    help="Link propagation delay (ms)",
                    required=True)

parser.add_argument('--dir', '-d',
                    help="Directory to store outputs",
                    required=True)

parser.add_argument('--time', '-t',
                    help="Duration (sec) to run the experiment",
                    type=int,
                    default=10)

parser.add_argument('--maxq',
                    type=int,
                    help="Max buffer size of network interface in packets",
                    default=100)

# Linux uses CUBIC-TCP by default that doesn't have the usual sawtooth
# behaviour.  For those who are curious, invoke this script with
# --cong cubic and see what happens...
# sysctl -a | grep cong should list some interesting parameters.
parser.add_argument('--cong',
                    help="Congestion control algorithm to use",
                    default="reno")

# Expt parameters
args = parser.parse_args()
if args.dir:
    args.dir = os.path.realpath(args.dir)

physical_links = {
    "lookup": {"up": 200, "down": 200},
    "h1": {"up": 10, "down": 100},
    "h2": {"up": 3, "down": 10},
    "h3": {"up": 8, "down": 20},
    "h4": {"up": 8, "down": 20},
    "h5": {"up": 8, "down": 20},
}


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
        switch = self.addSwitch('s0')
        for key, attributes in layout.items():
            host = self.addHost(key)

            self.addLink(switch,
                         host, cls=AsymTCLink,
                         params1={"bw": attributes["down"], "delay": '5ms', "max_queue_size": args.maxq},
                         params2={"bw": attributes["up"], "delay": '5ms', "max_queue_size": args.maxq})


def start_lookup_server(net, name):
    host = net.get(name)
    proc = host.popen(f"cd ../auth-rtc && node server.js > {args.dir}/{name}_log.txt", shell=True)
    sleep(1)
    return [proc]


def start_host(net, name):
    host = net.get(name)
    proc = host.popen(
        f"SIGNALLING_HOSTNAME={net.get('lookup').IP()}:8443 NAME={name} node host.js > {args.dir}/{name}_log.txt",
        shell=True)
    sleep(1)
    return [proc]


def start_client(net, name):
    host = net.get(name)
    proc = host.popen(
        f"SIGNALLING_HOSTNAME={net.get('lookup').IP()}:8443 NAME={name} node client.js  --host-key h1.pub > {args.dir}/{name}_log.txt",
        shell=True)
    sleep(1)
    return [proc]


def measure_perf():
    if not os.path.exists(args.dir):
        os.makedirs(args.dir)
    topo = PerfTopo(physical_links)
    net = Mininet(topo=topo, host=CPULimitedHost, link=AsymTCLink, controller=OVSController)
    net.start()
    # This dumps the topology and how nodes are interconnected through
    # links.
    dumpNodeConnections(net.hosts)
    # This performs a basic all pairs ping test.
    net.pingAll()

    start_lookup_server(net, "lookup")

    start_host(net, "h1")

    for key in physical_links.keys():
        if key in ["lookup", "h1"]:
            continue
        start_client(net, key)
    sleep(10)

    net.stop()
    # Ensure that all processes you create within Mininet are killed.
    # Sometimes they require manual killing.
    Popen("pgrep -f node | xargs kill -9", shell=True).wait()


if __name__ == "__main__":
    measure_perf()

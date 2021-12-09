#!/usr/bin/python
"Problem Set 2: Bufferbloat"

from mininet.topo import Topo
from mininet.node import CPULimitedHost
from mininet.link import TCLink
from mininet.net import Mininet
from mininet.log import lg, info
from mininet.util import dumpNodeConnections
from mininet.cli import CLI

from subprocess import Popen, PIPE
from time import sleep, time
from multiprocessing import Process
from argparse import ArgumentParser

import sys
import os
import math

parser = ArgumentParser(description="Bufferbloat tests")
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

class BBTopo(Topo):
    "Simple topology for bufferbloat experiment."

    def build(self, n=2):
        h1 = self.addHost('h1')
        h2 = self.addHost('h2')
        h3 = self.addHost('h3')

        # Here I have created a switch.  If you change its name, its
        # interface names will change from s0-eth1 to newname-eth1.
        switch = self.addSwitch('s0')

        self.addLink(switch,
                     h1, cls=TCLink, bw=1000, delay='5ms',  max_queue_size=args.maxq)

        self.addLink(switch,
                     h2, bw=1.5, delay='5ms', max_queue_size=args.maxq)

        self.addLink(switch,
                             h3, bw=1.5, delay='5ms', max_queue_size=args.maxq)


def start_lookup_server(net):
    h1 = net.get('h1')
    proc = h1.popen("cd ../auth-rtc && node server.js > ../webrtc-perf/lookup_log.txt", shell=True)
    sleep(1)
    return [proc]

def start_host(net):
    h2 = net.get('h2')
    proc = h2.popen(f"SIGNALLING_HOSTNAME={net.get('h1').IP()}:8443 node host.js --public-key public.key --private-key private.key > host_log.txt", shell=True)
    sleep(1)
    return [proc]

def start_client(net):
    h3 = net.get('h3')
    proc = h3.popen(f"SIGNALLING_HOSTNAME={net.get('h1').IP()}:8443 node client.js --public-key public.key > client_log.txt", shell=True)
    sleep(1)
    return [proc]

def bufferbloat():
    if not os.path.exists(args.dir):
        os.makedirs(args.dir)
    topo = BBTopo()
    net = Mininet(topo=topo, host=CPULimitedHost, link=TCLink)
    net.start()
    # This dumps the topology and how nodes are interconnected through
    # links.
    dumpNodeConnections(net.hosts)
    # This performs a basic all pairs ping test.
    net.pingAll()

    start_lookup_server(net)

    start_host(net)

    start_client(net)
    sleep(10)

    net.stop()
    # Ensure that all processes you create within Mininet are killed.
    # Sometimes they require manual killing.
    Popen("pgrep -f node | xargs kill -9", shell=True).wait()

if __name__ == "__main__":
    bufferbloat()
#!/usr/bin/env python

import os
from argparse import ArgumentParser
from matplotlib import pyplot as plt
import json
import pandas as pd

parser = ArgumentParser(description="tests")
parser.add_argument('--files', '-f',
                    type=str,
                    nargs="+",
                    help="Log directory")

args = parser.parse_args()


def make_plots():
    columns = ["Sent", "Received", "Hops", "Seq", "From", "To"]
    as_rows = []
    for file_path in args.files:
        to = os.path.basename(file_path)[:2]
        with open(file_path) as log_file:
            lines = log_file.readlines()
        received = json.loads(lines[-1])
        for entry in received:
            packet = json.loads(entry["received"])
            if not isinstance(packet["id"], list):
                continue
            as_rows.append((packet["id"][0], entry["time"], packet["hops"], packet["id"][1], packet["from"], to))

    data = pd.DataFrame(as_rows, columns=columns)
    data["TripTime"] = data["Received"] - data["Sent"]
    # TODO: plot delay, loss over time



if __name__ == "__main__":
    make_plots()

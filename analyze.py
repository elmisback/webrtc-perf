#!/usr/bin/env python

import os
from argparse import ArgumentParser
from matplotlib import pyplot as plt
import json
import pandas as pd
import seaborn as sns
sns.set_theme(style="whitegrid")

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
    data["TripTime"] = (data["Received"] - data["Sent"]) / 1000.
    earliest_stamp = data["Sent"].min()
    data["Sent"] -= earliest_stamp
    data["Received"] -= earliest_stamp
    data["SentTime"] = data["Sent"].astype(float) / 1000.
    last_received_by_pair = data.groupby(["From", "To"])["Seq"].max()
    print(last_received_by_pair)

    g = sns.FacetGrid(data, col="From", col_order=sorted(data["From"].unique()))
    g.map_dataframe(sns.lineplot, x="SentTime", y="TripTime", hue="To")
    g.add_legend(label_order=sorted(data["To"].unique()))
    plt.savefig("latencies.pdf", format="pdf", bbox_inches="tight")

    # Consistency check: Are we sending data on time, or is the process getting bogged down and missing sends?
    g = sns.FacetGrid(data, col="From", col_order=sorted(data["From"].unique()))
    g.map_dataframe(sns.lineplot, x="Seq", y="SentTime", hue="To")
    g.add_legend(label_order=sorted(data["To"].unique()))
    plt.savefig("seq-v-time.pdf", format="pdf", bbox_inches="tight")
    plt.show()


if __name__ == "__main__":
    make_plots()

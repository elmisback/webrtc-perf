#!/usr/bin/env python

import os
from argparse import ArgumentParser
from matplotlib import pyplot as plt
import json
import pandas as pd
import seaborn as sns
sns.set_theme(style="whitegrid")
sns.set_palette("tab10")
colors = sns.color_palette()
parser = ArgumentParser(description="tests")
parser.add_argument('--files', '-f',
                    type=str,
                    nargs="+",
                    help="Log directory")

args = parser.parse_args()


def make_plots():
    outputs = {}
    columns = ["Sent", "Received", "Hops", "Seq", "From", "To", "Size"]
    as_rows = []
    forwarding_cols = ["Host", "Size", "Sent"]
    forwarding_rows = []
    for file_path in args.files:
        if "err" in file_path:
            continue
        host = os.path.basename(file_path)[:2]
        with open(file_path) as log_file:
            lines = log_file.readlines()
        try:
            received = json.loads(lines[-1])
        except:
            print("Skipping " + file_path)
            continue
        for entry in received:
            if "num_output_channels" in entry:
                outputs[host] = entry["num_output_channels"]
                continue
            if "forwarded" in entry:
                forwarding_rows.append((host, entry["forwarded"], entry["time"]))
            else:
                packet = json.loads(entry["received"])
                if not isinstance(packet["id"], list):
                    continue
                as_rows.append((packet["id"][0], entry["time"], packet["hops"], packet["id"][1], packet["from"], host, len(entry["received"])))

    data = pd.DataFrame(as_rows, columns=columns)
    data["Latency"] = (data["Received"] - data["Sent"]) / 1000.
    earliest_stamp = data["Sent"].min()
    data["Sent"] -= earliest_stamp
    data["Received"] -= earliest_stamp

    bandwidth_data = pd.DataFrame(forwarding_rows, columns=forwarding_cols)


    data["Time"] = data["Sent"].astype(float) / 1000.
    bandwidth_data["Time"] = (bandwidth_data["Sent"] - earliest_stamp).astype(float) / 1000.
    data_up_rates = bandwidth_data.groupby("Host")["Size"].sum() / (bandwidth_data["Time"].max() - bandwidth_data["Time"].min())

    last_received_by_pair = data.groupby(["From", "To"])["Seq"].max()
    print(data_up_rates)
    print(last_received_by_pair)
    with open(os.path.dirname(args.files[0])+"results.txt", "w") as f:
        f.writelines(str(data_up_rates))
        f.writelines(str(last_received_by_pair))

    color_mappings = {"c" + str(i): colors[i - 1] for i in range(1,9)}
    g = sns.FacetGrid(data, col="From", col_order=sorted(data["From"].unique()))
    g.map_dataframe(sns.lineplot, x="Time", y="Latency", hue="To", palette=color_mappings)
    g.add_legend(label_order=sorted(data["To"].unique()))
    plt.ylim(0, max(0.15, data["Latency"].max() + 0.01))
    plt.savefig(os.path.dirname(args.files[0])+"-latencies.pdf", format="pdf", bbox_inches="tight")


    # Consistency check: Are we sending data on time, or is the process getting bogged down and missing sends?
    g = sns.FacetGrid(data, col="From", col_order=sorted(data["From"].unique()))
    g.map_dataframe(sns.lineplot, x="Seq", y="Time", hue="To")
    g.add_legend(label_order=sorted(data["To"].unique()))
    plt.savefig(os.path.dirname(args.files[0])+"seq-v-time.pdf", format="pdf", bbox_inches="tight")


if __name__ == "__main__":
    make_plots()

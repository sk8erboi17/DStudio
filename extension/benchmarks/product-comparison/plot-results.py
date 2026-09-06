#!/usr/bin/env python3
"""Matplotlib plot of reviewed, actual runtime outcomes; failed runs stay visible."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent


def make_figure(data):
    fig, axes = plt.subplots(1, 3, figsize=(14, 5.5), constrained_layout=True)
    cases = [('agent-utc-summary', 'Repair code'), ('cowork-current-plan', 'Write an accurate plan'),
             ('design-workshop-journey', 'Build a working website')]
    for ax, (case, title) in zip(axes, cases):
        rows = [r for r in data['runs'] if r['id'] == case]
        assert len(rows) == 2
        seconds = [r['elapsedSeconds'] if r['elapsedSeconds'] is not None else r['deadlineSeconds'] for r in rows]
        assert all(s is not None and s > 0 for s in seconds)
        bars = ax.bar(np.arange(2), seconds, width=.55,
                      color=['#3b65d9' if r['pass'] else '#b96549' for r in rows])
        for bar, row, value in zip(bars, rows, seconds):
            if not row['pass']:
                bar.set_hatch('//')
            label = (f"{value:.0f} s\nControls passed\nVisual defects remain" if case == 'design-workshop-journey'
                     else f"{value:.0f} s\nPassed") if row['pass'] else f"{value:.0f} s limit\nUnfinished; controls failed"
            ax.text(bar.get_x() + bar.get_width()/2, value + max(seconds)*.035, label,
                    ha='center', va='bottom', fontsize=10)
        names = {'dstudio': 'DStudio', 'openwork': 'OpenWork', 'opendesign': 'OpenDesign'}
        ax.set_xticks(np.arange(2), [names[r['product']] for r in rows])
        ax.set_ylim(0, max(seconds)*1.35)
        ax.set_title(title, fontweight='bold', pad=14)
        ax.set_ylabel('Time from prompt to finish (seconds)')
        ax.spines[['top', 'right']].set_visible(False)
        ax.set_axisbelow(True)
        ax.grid(axis='y', alpha=.2)
    fig.suptitle('Actual product runs — independently checked files and controls', fontsize=16, fontweight='bold')
    fig.supxlabel('One paired task per panel · M2 Max / 96 GiB · same local DeepSeek model, 32k context, SSD streaming off\n'
                  'Development replay; shared-host timings. DStudio radio alignment/label wrapping failed visual review.\n'
                  'Functional checks only, not an aesthetic score or general product ranking. Original outputs are unchanged.', fontsize=10)
    return fig


if __name__ == '__main__':
    data = json.loads((ROOT / 'results/2026-09-06-m2-max.json').read_text())
    fig = make_figure(data)
    fig.savefig(ROOT / 'product-comparison.png', dpi=170)
    plt.close(fig)

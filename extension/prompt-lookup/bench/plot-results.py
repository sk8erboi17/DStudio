"""Plot measured real-engine results only. No fabricated or extrapolated rates."""
import argparse
import json
import math
import statistics
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument('results')
parser.add_argument('output')
parser.add_argument('--shared-host', action='store_true')
args = parser.parse_args()
data = json.loads(Path(args.results).read_text())
if not data.get('finishedAt') or data.get('fatalError') or data.get('interrupted') or not data.get('summary', {}).get('complete'):
    raise SystemExit('Refusing to plot an incomplete run as finished results')
shared_host = data.get('method', {}).get('hostMode') == 'shared'
if (data.get('hostContention') or shared_host) and not (shared_host and args.shared_host):
    raise SystemExit('Shared-host charts require explicit --shared-host and recorded methodology')
surfaces = ['chat', 'agent', 'cowork']
modes = ['off', 'strict', 'batch']
labels = ['PLD disabled', 'Current default', 'Experimental PLD']
colors = ['#91a4b7', '#3678b5', '#da8a35']
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10})
fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), layout='constrained')
width = .24
for k, (mode, label, color) in enumerate(zip(modes, labels, colors)):
    positions = [i + (k - 1) * width for i in range(3)]
    counts, totals, speedups, pair_counts = [], [], [], []
    for surface in surfaces:
        rows = [r for r in data['runs'] if r['surface'] == surface and r['mode'] == mode]
        counts.append(sum(r['correct'] for r in rows))
        totals.append(len(rows))
        ratios = []
        for r in rows:
            base = next((b for b in data['runs'] if b['caseId'] == r['caseId'] and
                         b['repeat'] == r['repeat'] and b['mode'] == 'off'), None)
            if base and base['correct'] and r['correct'] and base['outputSha'] == r['outputSha']:
                ratios.append(base['wallMs'] / r['wallMs'])
        speedups.append(statistics.median(ratios) if ratios else float('nan'))
        pair_counts.append(len(ratios))
    bars = axes[0].bar(positions, [100*c/n if n else 0 for c,n in zip(counts,totals)], width,
                       label=label, color=color)
    axes[0].bar_label(bars, labels=[f'{c}/{n}' for c,n in zip(counts,totals)], padding=3, fontsize=9)
    bars = axes[1].bar(positions, speedups, width, label=label, color=color)
    axes[1].bar_label(bars, labels=[f'{x:.2f}×\nn={n}' if math.isfinite(x) else 'n/a' for x,n in zip(speedups,pair_counts)], padding=3, fontsize=8)
axes[0].set_title('Correct results come first')
axes[0].set_ylabel('Checks passed (%)')
axes[0].set_ylim(0, 119)
axes[1].set_title('Observed speed for the same correct result')
axes[1].set_ylabel('Speed relative to PLD off (higher is faster)')
axes[1].axhline(1, color='#444', linewidth=1, linestyle='--')
axes[1].set_ylim(0, axes[1].get_ylim()[1] * 1.15)
for ax in axes:
    ax.set_xticks(range(3), ['Chat', 'Agent', 'Cowork'])
    ax.spines[['top', 'right']].set_visible(False)
    ax.set_axisbelow(True)
    ax.grid(axis='y', alpha=.18)
axes[0].legend(loc='lower left', frameon=True, facecolor='white', framealpha=.95, edgecolor='#dfe5ec', fontsize=8)
subtitle = '\n' + data['method']['hostLabel'] + ' — shared-host timings, not an isolated speed guarantee' if shared_host else ''
model_name = data['model']['file'].removesuffix('.gguf')
if model_name.startswith('DeepSeek-V4-Flash-'):
    model_name = 'DeepSeek V4 Flash'
chip = data['hardware']['chip'].removeprefix('Apple ')
memory_gib = data['hardware']['memoryBytes'] / 1024**3
ssd = 'on' if data['model']['ssdStreaming'] else 'off'
fig.suptitle(f'Real {model_name} · {chip} {memory_gib:g} GiB · SSD streaming {ssd}' + subtitle, fontsize=12, weight='bold')
fig.supxlabel(f"{data['method']['repeats']} repetitions per case. End-to-end time, excluding model startup.\nn = matched correct outputs. Failed or different outputs excluded from speed, retained in checks. No general reliability guarantee.", fontsize=9)
Path(args.output).parent.mkdir(parents=True, exist_ok=True)
fig.savefig(args.output, dpi=180, facecolor='white')

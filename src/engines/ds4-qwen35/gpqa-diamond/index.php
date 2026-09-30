<?php
// GPQA-Diamond per-question browser: pick any question, compare the runs
// side by side (reasoning, answer, timings, tokens). Light liquid design.
// At startup it scans this dir's subdirectories: each subdir = one model run,
// each xx|ww|tt-<domain>-<qid>.json = one exported question.
declare(strict_types=1);

$ROOT = __DIR__;

// ---------- discovery ----------
function discover_runs(string $root): array {
    // returns [runDirName => label]; label comes from the first JSON's "model"
    // field when available, else the directory name.
    $runs = [];
    foreach (glob("$root/*", GLOB_ONLYDIR) as $dir) {
        $run = basename($dir);
        $label = $run;
        foreach (glob("$dir/*.json") as $f) {
            $j = json_decode((string)file_get_contents($f), true);
            if (is_array($j) && !empty($j['model'])) { $label = (string)$j['model']; break; }
        }
        $runs[$run] = $label;
    }
    ksort($runs);
    return $runs;
}

function list_questions(string $root, array $runs): array {
    // map: domain-qid -> [run => filename-without-ext]
    $map = [];
    foreach (array_keys($runs) as $run) {
        foreach (glob("$root/$run/*.json") as $f) {
            $base = basename($f, '.json');
            if (!preg_match('/^(xx|ww|tt)-([a-z]+)-(\d+)$/', $base, $m)) continue;
            $key = $m[2] . '-' . $m[3];
            $map[$key][$run] = $base;
        }
    }
    ksort($map, SORT_NATURAL | SORT_FLAG_CASE);
    return $map;
}

function load_detail(string $root, string $run, string $file): ?array {
    if (!preg_match('/^(xx|ww|tt)-[a-z]+-\d+$/', $file)) return null;
    $p = "$root/$run/$file.json";
    if (!is_file($p)) return null;
    $j = json_decode((string)file_get_contents($p), true);
    return is_array($j) ? $j : null;
}

$RUNS = discover_runs($ROOT);
$map = list_questions($ROOT, $RUNS);

// current selection: paired question key
$selKey = $_GET['q'] ?? null;
if ($selKey === null || !isset($map[$selKey])) {
    // default: first question answered by every discovered run
    foreach ($map as $k => $v) {
        if (count($v) === count($RUNS)) { $selKey = $k; break; }
    }
    if ($selKey === null && $map) $selKey = array_key_first($map);
}
$sel = $map[$selKey] ?? [];

$files = [];
foreach (array_keys($RUNS) as $run) {
    $files[$run] = isset($sel[$run]) ? load_detail($ROOT, $run, $sel[$run]) : null;
}

function h(?string $s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function fmt(int|float|null $n, int $d = 0): string {
    return $n === null ? '–' : number_format((float)$n, $d, ',', ' ');
}
// chiavi di generation_config mostrate una volta sola nel pannello domanda;
// le restanti (specifiche del run) compaiono come pill nel pannello del run
$SHARED_GC = ['temperature','top_p','seed','few_shot','max_tokens_requested',
              'server_ctx','eval_batch_size','decoding','note'];
$resBadge = ['correct' => 'ok', 'wrong' => 'ko', 'trunc' => 'tr'];
$resWord  = ['correct' => 'corretta', 'wrong' => 'errata', 'trunc' => 'troncata'];
?>
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>GPQA Diamond — confronto per domanda</title>
<style>
:root{
  --bg:#f6f8fc; --card:#ffffffcc; --brd:#e3e8f2; --tx:#1c2333; --tx2:#5d6a86;
  --acc:#2563eb; --ok:#059669; --bad:#dc2626; --tr:#d97706;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:
    radial-gradient(60vmax 60vmax at 110% -10%, #dbeafe 0%, transparent 60%),
    radial-gradient(50vmax 50vmax at -10% 110%, #ede9fe 0%, transparent 55%),
    var(--bg);
  min-height:100vh; color:var(--tx);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
}
.blob{position:fixed;border-radius:50%;filter:blur(70px);opacity:.35;z-index:0;pointer-events:none;
      animation:drift 30s ease-in-out infinite alternate}
#b1{width:40vmax;height:40vmax;background:#bfdbfe;top:-12vmax;left:-10vmax}
#b2{width:34vmax;height:34vmax;background:#ddd6fe;bottom:-12vmax;right:-8vmax;animation-delay:-12s}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(4vmax,3vmax)}}
.wrap{position:relative;z-index:1;max-width:1240px;margin:0 auto;padding:22px 16px 60px}
header h1{font-size:clamp(20px,3.4vw,28px);margin:0 0 4px;font-weight:800;
  background:linear-gradient(90deg,#2563eb,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--tx2);font-size:13.5px}
.panel{background:var(--card);border:1px solid var(--brd);border-radius:18px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  box-shadow:0 6px 24px rgba(28,35,51,.07);padding:16px}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0}
select{background:#fff;color:var(--tx);border:1px solid var(--brd);border-radius:12px;
  padding:9px 12px;font-size:14px;max-width:100%;box-shadow:0 2px 8px rgba(28,35,51,.05)}
label{font-size:12.5px;color:var(--tx2);font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:900px){.grid2{grid-template-columns:1fr}}
.runhead{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-bottom:10px}
.runname{font-weight:700;font-size:15.5px}
.badge{display:inline-block;border-radius:999px;padding:2px 11px;font-size:12px;font-weight:700;color:#fff}
.badge.ok{background:var(--ok)} .badge.ko{background:var(--bad)} .badge.tr{background:var(--tr)}
.kpis{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
.kpi{background:#f4f7fe;border:1px solid var(--brd);border-radius:12px;padding:7px 12px;min-width:96px}
.kpi .l{font-size:10.5px;color:var(--tx2);text-transform:uppercase;letter-spacing:.6px}
.kpi .v{font-size:16px;font-weight:700}
.kpi .v small{font-size:11px;color:var(--tx2);font-weight:500}
.sec{margin-top:14px}
.sec>h3{font-size:13px;color:var(--tx2);text-transform:uppercase;letter-spacing:.7px;margin:0 0 6px}
pre.txt{white-space:pre-wrap;word-wrap:break-word;background:#fbfcff;border:1px solid var(--brd);
  border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.55;max-height:420px;overflow:auto;margin:0}
pre.reason{max-height:520px;font-family:var(--mono);font-size:12.3px}
.ans{white-space:pre-wrap;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;
  padding:12px 14px;font-size:13.5px}
.ans.ko{background:#fef2f2;border-color:#fecaca}
.ans.tr{background:#fffbeb;border-color:#fde68a}
.qtext{white-space:pre-wrap;font-size:14.5px;line-height:1.6;margin:0 0 6px}
.choices{margin:10px 0 0;padding:0;list-style:none}
.choices li{padding:7px 12px;border:1px solid var(--brd);border-radius:10px;margin:6px 0;background:#fff}
.choices li.gold{border-color:#34d399;background:#ecfdf5;font-weight:600}
.choices li .lt{font-weight:800;color:var(--acc);margin-right:8px}
.meta{color:var(--tx2);font-size:12.5px;margin-top:8px}
.pillrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.pill{border-radius:999px;background:#eef2fb;border:1px solid var(--brd);padding:3px 10px;font-size:12px;color:var(--tx2)}
.qnav{display:flex;gap:6px;align-items:center}
button.nav{border:1px solid var(--brd);background:#fff;border-radius:999px;padding:8px 16px;
  font-size:13.5px;cursor:pointer;box-shadow:0 2px 8px rgba(28,35,51,.05)}
button.nav:hover{background:#f0f4ff}
.gold{color:var(--ok);font-weight:700}
footer{color:var(--tx2);font-size:12px;margin-top:30px;text-align:center}
details summary{cursor:pointer;color:var(--acc);font-size:13px;margin-top:8px}
</style>
</head>
<body>
<div class="blob" id="b1"></div><div class="blob" id="b2"></div>
<div class="wrap">
<header>
  <h1>GPQA Diamond — confronto per domanda</h1>
  <div class="sub">Browser dei file per-domanda in <code>gpqa-diamond/</code>: reasoning, risposta,
  token e latenza fianco a fianco per le due configurazioni.</div>
</header>

<form class="toolbar panel" method="get">
  <label for="q">Domanda</label>
  <select id="q" name="q" onchange="this.form.submit()">
    <?php foreach ($map as $k => $v): $first = reset($v);
      preg_match('/^(xx|ww|tt)-([a-z]+)-(\d+)$/', $first, $m); ?>
      <option value="<?= h($k) ?>" <?= $k === $selKey ? 'selected' : '' ?>>
        <?= $m[2] ?> #<?= $m[3] ?> <?= count($v) === count($RUNS) ? '⟷ tutti' : '(' . count($v) . '/' . count($RUNS) . ' modelli)' ?>
      </option>
    <?php endforeach; ?>
  </select>
  <span class="sub"><?= count($map) ?> domande esportate · ✓ corretta · ✗ errata · ⏳ troncata</span>
</form>

<?php if ($selKey === null): ?>
  <div class="panel">Nessun file per-domanda trovato. Esegui <code>evalscope/export_gpqa_perdir.py</code>.</div>
<?php else: ?>
  <?php $q0 = null; foreach ($files as $d) { if ($d) { $q0 = $d; break; } } ?>
  <div class="panel" style="margin-bottom:14px">
    <?php if ($q0): ?>
    <div class="qtext"><?= h($q0['question']) ?></div>
    <ul class="choices">
      <?php foreach (($q0['choices'] ?? []) as $lt => $txt): ?>
        <li class="<?= $lt === ($q0['gold'] ?? '') ? 'gold' : '' ?>">
          <span class="lt"><?= h($lt) ?></span><?= h($txt) ?>
          <?= $lt === ($q0['gold'] ?? '') ? '<span class="gold">◆ gold</span>' : '' ?>
        </li>
      <?php endforeach; ?>
    </ul>
    <div class="meta">domanda #<?= h((string)$q0['question_id']) ?> · dominio <?= h($q0['domain']) ?> ·
      gold = <span class="gold"><?= h($q0['gold']) ?></span></div>
    <?php endif; ?>
  </div>

  <div class="grid2">
    <?php foreach ($RUNS as $run => $label): $d = $files[$run]; ?>
      <div class="panel">
        <?php if (!$d): ?>
          <div class="runname"><?= h($label) ?></div>
          <div class="meta">Nessun file per questa domanda (non ancora generata).</div>
          <?php continue; endif; ?>
        <div class="runhead">
          <span class="runname"><?= h($label) ?></span>
          <span class="badge <?= $resBadge[$d['result']] ?>"><?= $resWord[$d['result']] ?></span>
          <?php if (!empty($d['truncated'])): ?><span class="pill">budget esaurito</span><?php endif; ?>
        </div>
        <div class="kpis">
          <div class="kpi"><div class="l">pred</div><div class="v"><?= h($d['pred'] ?? '–') ?> <small>/ gold <?= h($d['gold']) ?></small></div></div>
          <div class="kpi"><div class="l">tokens</div><div class="v"><?= fmt($d['tokens']) ?></div></div>
          <div class="kpi"><div class="l">latenza</div><div class="v"><?= fmt($d['latency_s'], 1) ?> <small>s</small></div></div>
          <div class="kpi"><div class="l">stop</div><div class="v" style="font-size:13px"><?= h($d['stop_reason'] ?? '–') ?></div></div>
        </div>
        <div class="sec">
          <h3>Risposta finale</h3>
          <div class="ans <?= $resBadge[$d['result']] ?>"><?= h($d['answer_text'] !== '' ? $d['answer_text'] : '— (nessun testo finale)') ?></div>
        </div>
        <div class="sec">
          <h3>Reasoning (<?= fmt(mb_strlen($d['reasoning'])) ?> caratteri)</h3>
          <pre class="txt reason"><?= h($d['reasoning'] !== '' ? $d['reasoning'] : '—') ?></pre>
        </div>
        <details>
          <summary>Prompt completo inviato al modello</summary>
          <pre class="txt"><?= h($d['prompt']) ?></pre>
        </details>
      </div>
    <?php endforeach; ?>
  </div>

  <?php // generation_config in coda: parametri comuni una volta, extra per run come pill
    $gcShared = null; $gcExtras = [];
    foreach ($files as $run => $d) {
      $gc = $d['generation_config'] ?? null;
      if (!is_array($gc)) continue;
      if ($gcShared === null) $gcShared = $gc;
      $ex = [];
      foreach ($gc as $k => $v) {
        if (!in_array($k, $SHARED_GC, true) && $k !== 'note') $ex[$k] = $v;
      }
      if ($ex) $gcExtras[$run] = $ex;
    }
    $vstr = function($v): string {
      return is_scalar($v) ? (string)$v : (string)json_encode($v);
    };
  ?>
  <?php if ($gcShared !== null): ?>
  <div class="panel" style="margin-top:14px">
    <div class="sec" style="margin-top:0">
      <h3>Parametri di generazione</h3>
      <div class="pillrow">
        <?php foreach ($gcShared as $k => $v): if (!in_array($k, $SHARED_GC, true)) continue; ?>
          <span class="pill"><b><?= h((string)$k) ?></b> = <?= h($vstr($v)) ?></span>
        <?php endforeach; ?>
      </div>
    </div>
    <?php foreach ($gcExtras as $run => $ex): ?>
      <div class="sec">
        <h3>Specifici · <?= h($RUNS[$run]) ?></h3>
        <div class="pillrow">
          <?php foreach ($ex as $k => $v): ?>
            <span class="pill"><b><?= h((string)$k) ?></b> = <?= h($vstr($v)) ?></span>
          <?php endforeach; ?>
        </div>
      </div>
    <?php endforeach; ?>
    <?php if (!empty($gcShared['note'])): ?>
      <div class="meta" style="margin-top:10px"><?= h((string)$gcShared['note']) ?></div>
    <?php endif; ?>
  </div>
  <?php endif; ?>
<?php endif; ?>

<footer>File locali generati da <code>evalscope/export_gpqa_perdir.py</code> · pagina statica PHP, nessun dato inviato altrove.</footer>
</div>
</body>
</html>

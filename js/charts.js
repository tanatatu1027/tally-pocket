// ===== グラフ(ドーナツ円グラフ・折れ線グラフ)。Chart.js を使う =====
import { fmt, isMasked, monthShort, monthLabel } from './util.js';
import { byCategory, monthsOf, totalOf, valueOf, percents } from './calc.js';

let donut = null;
let line = null;

// 画面の文字色(CSSの変数から読む)
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// 縦軸の目盛りを短くする(1,200万 / 1.2億)
function short(v) {
  if (isMasked()) return '';
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '億';
  if (Math.abs(v) >= 1e4) return Math.round(v / 1e4).toLocaleString('ja-JP') + '万';
  return String(v);
}

// ドーナツ円グラフ。真ん中に総資産を表示する
export function drawDonut(canvas, state, month) {
  donut?.destroy();
  const rows = byCategory(state, month).filter((r) => r.amount > 0);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const pcts = percents(rows.map((r) => r.amount));

  // 真ん中に文字を描く小さな部品(プラグイン)
  const centerText = {
    id: 'centerText',
    afterDraw(chart) {
      const { ctx, chartArea: a } = chart;
      const cx = (a.left + a.right) / 2;
      const cy = (a.top + a.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = css('--muted');
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('総資産', cx, cy - 12);
      ctx.fillStyle = css('--text');
      ctx.font = '700 16px system-ui, sans-serif';
      ctx.fillText(fmt(total), cx, cy + 10);
      ctx.restore();
    },
  };

  donut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: rows.map((r) => r.category.name),
      datasets: [{
        data: rows.map((r) => r.amount),
        backgroundColor: rows.map((r) => r.category.color),
        borderColor: css('--card'),
        borderWidth: 2,
      }],
    },
    options: {
      cutout: '66%',
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: !isMasked(), // 隠している間は、触っても情報を出さない
          callbacks: {
            label: (c) => ` ${c.label}: ${fmt(c.parsed)}(${pcts[c.dataIndex].toFixed(1)}%)`,
          },
        },
      },
    },
    plugins: [centerText],
  });
}

// 折れ線グラフ。period は 6 / 12 / 'all'、stacked が true なら分類ごとの積み上げ
export function drawLine(canvas, state, period, stacked) {
  line?.destroy();
  let months = monthsOf(state);
  if (period !== 'all') months = months.slice(-period);
  const labels = months.map(monthShort);

  let datasets;
  if (stacked) {
    datasets = state.categories.map((c) => ({
      label: c.name,
      data: months.map((m) =>
        state.assets.filter((a) => a.categoryId === c.id).reduce((s, a) => s + valueOf(state, m, a.id), 0)),
      borderColor: c.color,
      backgroundColor: c.color + 'cc',
      fill: true,
      pointRadius: 0,
      borderWidth: 1,
      tension: 0.25,
    })).filter((d) => d.data.some((v) => v > 0));
  } else {
    datasets = [{
      label: '総資産',
      data: months.map((m) => totalOf(state, m)),
      borderColor: css('--accent'),
      backgroundColor: css('--accent') + '22',
      fill: true,
      pointRadius: months.length > 14 ? 0 : 3,
      pointHoverRadius: 6,
      borderWidth: 2.5,
      tension: 0.25,
    }];
  }

  line = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false }, // どこを触っても、その月の値が出る
      scales: {
        x: { grid: { display: false }, ticks: { color: css('--muted'), maxTicksLimit: 7 } },
        y: {
          stacked,
          beginAtZero: stacked,
          grid: { color: css('--line') },
          ticks: { color: css('--muted'), callback: short, maxTicksLimit: 5 },
        },
      },
      plugins: {
        legend: { display: stacked, labels: { boxWidth: 10, color: css('--muted') } },
        tooltip: {
          enabled: !isMasked(),
          callbacks: {
            title: (items) => (items[0] ? monthLabel(months[items[0].dataIndex]) : ''),
            label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}`,
          },
        },
      },
    },
  });
}

// 画面を切り替えるときにグラフを片づける
export function destroyCharts() {
  donut?.destroy(); donut = null;
  line?.destroy(); line = null;
}

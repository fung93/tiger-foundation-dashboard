function fmt(v, d) {
  d = (d === undefined) ? 2 : d;
  if (v === null || v === undefined) return '---';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  if (v < 0.01) return '$' + v.toFixed(6);
  if (v < 1) return '$' + v.toFixed(4);
  return '$' + v.toFixed(d);
}
function fmtN(v) { return Number(v).toLocaleString('en-US', {maximumFractionDigits: 4}); }

var TOKEN_COLORS = {ETH:'#627EEA',KAT:'#F59E0B',WETH:'#627EEA',USDC:'#2775CA',USDT:'#26A17B',WBTC:'#F7931A',MORPHO:'#A855F7',SUSHI:'#FA52A0'};

Promise.all([
  fetch('data.json?' + Date.now()).then(r => r.json()),
  fetch('history.json?' + Date.now()).then(r => r.json())
]).then(([d, h]) => {
  if (!d) return;

  var onchain = d.onchainTotalUSD || 0;
  var pending = (d.merklRewards && d.merklRewards.totalUnclaimedUSD) || 0;
  var lp = d.lpUSD || 0;
  var total = d.grandTotalUSD || (onchain + pending + lp);
  var target = 8000;
  var pct = Math.min(100, (total / target) * 100);

  document.getElementById('totalVal').textContent = fmt(total);
  document.getElementById('totalBreakdown').textContent = fmt(onchain) + ' on-chain + ' + fmt(lp) + ' LP + ' + fmt(pending) + ' pending';
  document.getElementById('progFill').style.width = pct.toFixed(1) + '%';
  document.getElementById('pctVal').textContent = pct.toFixed(1) + '%';
  document.getElementById('onchainVal').textContent = fmt(onchain);
  document.getElementById('rewardsVal').textContent = fmt(pending);
  document.getElementById('lpVal').textContent = fmt(lp);
  document.getElementById('lastUpdated').textContent = 'Updated: ' + (d.lastUpdated ? d.lastUpdated.replace('T',' ').slice(0,19) + ' UTC' : '---');

  var tl = '';
  var bal = d.balances || {};
  Object.keys(bal).forEach(function(sym) {
    var b = bal[sym];
    if (!b || b.balance === 0) return;
    var col = TOKEN_COLORS[sym] || '#5a6a8a';
    tl += '<div class="token-row">';
    tl += '<div class="token-info"><div class="token-icon" style="background:' + col + '22;color:' + col + '">' + sym.slice(0,3) + '</div><div><div class="token-name">' + sym + '</div><div class="token-usd">$' + b.priceUSD + '</div></div></div>';
    tl += '<div class="r"><div class="token-bal">' + fmtN(b.balance) + '</div><div class="token-usd">' + fmt(b.valueUSD) + '</div></div>';
    tl += '</div>';
  });
  document.getElementById('tokenList').innerHTML = tl || '<p style="color:var(--dim);font-size:12px">No token balances</p>';

  var dl = '';
  if (d.morphoPosition) {
    var mp = d.morphoPosition;
    dl += '<div class="pos-card"><div class="pos-head"><span class="pos-proto">Morpho Blue</span><span class="hf blue">Lending</span></div>';
    dl += '<div class="pos-row"><span class="pos-label">Collateral</span><span class="pos-val">' + fmtN(mp.collateralAmount) + ' ' + mp.collateralToken + '</span></div>';
    dl += '<div class="pos-row"><span class="pos-label">Debt</span><span class="pos-val" style="color:var(--red)">' + fmtN(mp.borrowAmount) + ' ' + mp.loanToken + '</span></div>';
    dl += '<div class="pos-row"><span class="pos-label">Net Position</span><span class="pos-val gold">' + fmtN(mp.netPositionKAT) + ' KAT = ' + fmt(mp.valueUSD) + '</span></div>';
    dl += '<div class="pos-row"><span class="pos-label">LLTV</span><span class="pos-val">' + mp.lltv + '</span></div></div>';
  }
  if (lp > 0) {
    dl += '<div class="pos-card"><div class="pos-head"><span class="pos-proto">SushiSwap V3</span><span class="hf gold">LP</span></div>';
    dl += '<div class="pos-row"><span class="pos-label">Pair</span><span class="pos-val">vbUSDC / KAT</span></div>';
    dl += '<div class="pos-row"><span class="pos-label">Value</span><span class="pos-val gold" style="font-size:14px">$' + lp.toFixed(2) + '</span></div>';
    dl += '<div class="pos-row"><span class="pos-label">Note</span><span class="pos-val" style="font-size:10px;color:var(--dim)">NFT - estimated</span></div></div>';
  }
  document.getElementById('defiList').innerHTML = dl;

  if (d.merklRewards && d.merklRewards.rewards && d.merklRewards.rewards.length) {
    d.merklRewards.rewards.forEach(function(r) {
      dl += '<div class="pos-card"><div class="pos-head"><span class="pos-proto">Merkl Rewards</span><span class="hf gold">REWARDS</span></div>';
      dl += '<div class="pos-row"><span class="pos-label">Token</span><span class="pos-val">' + r.symbol + '</span></div>';
      dl += '<div class="pos-row"><span class="pos-label">Unclaimed</span><span class="pos-val gold">' + fmtN(parseFloat(r.unclaimed)) + ' ' + r.symbol + ' = ' + fmt(r.unclaimedUSD) + '</span></div></div>';
    });
    document.getElementById('defiList').innerHTML = dl;
  }

  var pb = '';
  (d.perpsTickers || []).forEach(function(t) {
    var ch = t.percentChange >= 0;
    pb += '<tr><td><strong>' + t.market + '</strong></td><td>$' + Number(t.markPrice).toLocaleString() + '</td><td>$' + Number(t.indexPrice).toLocaleString() + '</td>';
    pb += '<td><span class="hf ' + (ch ? 'green' : 'red') + '">' + (ch ? '+' : '') + t.percentChange.toFixed(2) + '%</span></td>';
    pb += '<td>' + Number(t.openInterest).toLocaleString() + '</td><td class="r">$' + Number(t.baseVolume).toLocaleString() + '</td></tr>';
  });
  document.getElementById('perpsBody').innerHTML = pb;

  var data = (h && h.data) ? h.data : [];
  if (data.length === 0) {
    document.getElementById('historyChart').parentElement.innerHTML = '<p style="color:var(--dim);text-align:center;padding:40px">No historical data yet.</p>';
    return;
  }
  var labels = data.map(function(d) { return d.date ? d.date.slice(5) : ''; });
  var totals = data.map(function(d) { return d.total_usd || 0; });
  var ctx2 = document.getElementById('historyChart').getContext('2d');
  new Chart(ctx2, {
    type: 'line',
    data: { labels: labels, datasets: [{
      label: 'Total Value',
      data: totals,
      borderColor: '#f59e0b',
      backgroundColor: 'rgba(245,158,11,.08)',
      borderWidth: 2.5, fill: true, tension: 0.3,
      pointRadius: 3, pointBackgroundColor: '#f59e0b',
      pointBorderColor: '#080c14', pointBorderWidth: 2
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { color: '#5a6a8a', font: { size: 11 }, boxWidth: 12, padding: 16 } },
        tooltip: {
          backgroundColor: '#1a2540', titleColor: '#e8edf5', bodyColor: '#e8edf5',
          borderColor: '#f59e0b', borderWidth: 1,
          callbacks: { label: function(ctx) { return ctx.dataset.label + ': $' + Number(ctx.raw).toFixed(2); } }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.03)' }, ticks: { color: '#5a6a8a', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,.03)' }, ticks: { color: '#5a6a8a', font: { size: 10 }, callback: function(v) { return '$' + v.toFixed(0); } }
      }
    }
  });
}).catch(function(e) {
  console.error(e);
  document.getElementById('totalBreakdown').textContent = 'Error loading data: ' + e.message;
});

/* ============================================================================
   lpbook.js — what the LP Book's Live and All-Time pages share: number formats,
   the hand-drawn curve, the health line, and the fifteen-second refresh of
   /api/lpbook with the last answer shown at once on opening.
   ========================================================================== */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = LPCards.esc;
  var money = function (n, dp) { dp = dp === undefined ? 2 : dp;
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }); };
  var signed = function (n) { return (n >= 0 ? '+' : '-') + money(Math.abs(n)); };
  var cls = function (n) { return n > 0.004 ? 'up' : n < -0.004 ? 'down' : ''; };
  var amt = function (a) { return a >= 1000 ? Math.round(a).toLocaleString('en-US')
    : a >= 1 ? a.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : a >= 0.0001 ? a.toLocaleString('en-US', { maximumSignificantDigits: 3 }) : '<0.0001'; };
  var day = function (iso) { return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''; };
  var when = function (iso) { return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit' }) : ''; };
  var held = function (h) { return h == null ? '' : h < 48 ? h.toFixed(1) + 'h' : (h / 24).toFixed(1) + 'd'; };

  /* the curve, drawn by hand: fees in gold with the area under it, and — where asked — Net
     beside it against a range that takes in zero */
  function chart(box, axis, s, opts) {
    opts = opts || {};
    if (!s || s.length < 2) { box.innerHTML = '<div class="empty">' + esc(opts.empty || 'Nothing to draw yet.') + '</div>'; axis.innerHTML = ''; return; }
    var W = 600, H = 200, P = 4;
    var t0 = s[0].ts, t1 = s[s.length - 1].ts, span = Math.max(1, t1 - t0);
    var net = opts.net ? s.filter(function (p) { return p.net !== null && p.net !== undefined; }) : [];
    var vals = s.map(function (p) { return p.usd; }).concat(net.map(function (p) { return p.net; }));
    var hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals);
    var floor, top;
    if (net.length > 1) {
      var a = Math.min(lo, 0), b = Math.max(hi, 0), pad = (b - a) * 0.1 || 1;
      floor = a - (a < 0 ? pad : 0); top = b + pad;
    } else {
      floor = lo > 0 && (hi - lo) < hi * 0.5 ? lo - (hi - lo) * 0.6 - 0.01 : 0;
      top = hi + (hi - floor) * 0.12 || 1;
    }
    var x = function (t) { return P + (t - t0) / span * (W - 2 * P); };
    var y = function (u) { return H - P - (u - floor) / (top - floor) * (H - 2 * P); };
    var pts = s.map(function (p) { return x(p.ts).toFixed(1) + ',' + y(p.usd).toFixed(1); });
    var rules = '', marks = '';
    if (floor < 0) marks += '<div style="position:absolute;left:0;top:calc(' + (y(0) / H * 100).toFixed(2) + '% - 15px);font-size:10px;color:var(--faint);letter-spacing:.04em">$0</div>';
    for (var i = 1; i <= 3; i++) {
      var v = floor + (top - floor) * i / 4, yy = y(v).toFixed(1);
      if (floor < 0 && Math.abs(v) < (top - floor) * 0.1) continue;
      rules += '<line x1="0" x2="' + W + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--chart-grid)" vector-effect="non-scaling-stroke"/>';
      marks += '<div style="position:absolute;left:0;top:calc(' + (yy / H * 100).toFixed(2) + '% - 15px);font-size:10px;color:var(--faint);letter-spacing:.04em">' + esc(money(v)) + '</div>';
    }
    var lx = x(t1).toFixed(1), ly = y(s[s.length - 1].usd).toFixed(1);
    var netPts = net.map(function (p) { return x(p.ts).toFixed(1) + ',' + y(p.net).toFixed(1); });
    var last = s[s.length - 1], netLast = net.length > 1 && net[net.length - 1] === last ? last.net : null;
    var zero = floor < 0 ? '<line x1="0" x2="' + W + '" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '" stroke="var(--chart-zero)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>' : '';
    var netLine = net.length > 1 ? '<polyline points="' + netPts.join(' ') + '" fill="none" stroke="var(--text)" stroke-opacity=".8" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' : '';
    var netDot = netLast !== null
      ? '<div style="position:absolute;left:calc(' + (lx / W * 100).toFixed(2) + '% - 3.5px);top:calc(' + (y(netLast) / H * 100).toFixed(2) + '% - 3.5px);'
        + 'width:7px;height:7px;border-radius:50%;background:' + (netLast >= 0 ? 'var(--up)' : 'var(--down)') + '"></div>'
        + '<div class="now2 ' + cls(netLast) + '">Net ' + esc(signed(netLast)) + '</div>'
      : '';
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="Cumulative fees">'
      + '<defs><linearGradient id="fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--gold)" stop-opacity=".22"/>'
      + '<stop offset="1" stop-color="var(--gold)" stop-opacity="0"/></linearGradient></defs>'
      + rules
      + '<polygon points="' + P + ',' + (H - P) + ' ' + pts.join(' ') + ' ' + lx + ',' + (H - P) + '" fill="url(#fg)"/>'
      + zero
      + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--gold)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
      + netLine
      + '<line x1="0" x2="' + W + '" y1="' + (H - P) + '" y2="' + (H - P) + '" stroke="var(--chart-grid)" vector-effect="non-scaling-stroke"/>'
      + '</svg>' + marks
      + '<div style="position:absolute;left:calc(' + (lx / W * 100).toFixed(2) + '% - 4px);top:calc(' + (ly / H * 100).toFixed(2) + '% - 4px);'
      + 'width:8px;height:8px;border-radius:50%;background:var(--gold);box-shadow:0 0 0 4px var(--chart-accent-halo)"></div>'
      + netDot
      + '<div class="now">' + esc(money(s[s.length - 1].usd)) + '</div>';
    axis.innerHTML = '<span>' + esc(when(new Date(t0 * 1000).toISOString())) + '</span><span>' + (opts.endLabel || 'now') + '</span>';
  }

  /* what could not be read, said out loud rather than drawn as an empty portfolio */
  function health(hl, held) {
    var msgs = [];
    Object.keys(hl.errors || {}).forEach(function (k) { msgs.push('Could not read ' + k + ': ' + hl.errors[k]); });
    Object.keys(hl.behind || {}).forEach(function (k) {
      if (hl.behind[k] > 0) msgs.push(k + ' is ' + hl.behind[k].toLocaleString('en-US') + ' blocks behind — the six-hourly job may have stopped.');
    });
    if ((hl.unread || []).length) msgs.push('Open position(s) not valued this time: ' + hl.unread.join(', '));
    if ((hl.unpriced || []).length) msgs.push('No live price for ' + hl.unpriced.map(function (k) { return String(k).split('@')[0]; }).join(', ') + ' — left out of the fee total.');
    if (held) msgs.push('Showing the last full reading until it can be read again.');
    $('health').innerHTML = msgs.map(esc).join('<br>');
    $('health').className = 'health' + (msgs.length ? ' on' : '');
  }

  /* every fifteen seconds, with the last good answer (same key as the widget) shown at once */
  function poll(render, ready) {
    /* lastGood is eligible for a hold only while a full reading is displayed. */
    var KEY = 'tf_lpbook', HOLD = 5 * 60000, lastGood = 0, lastRead = 0, failed = false;
    var stamp = function (bad) { if (bad !== undefined) failed = bad; LPCards.stamp($('stamp'), lastRead, failed); };
    try {
      var seed = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (seed && seed.v && ready(seed.v)) {
        var seedPartial = Object.keys((seed.v.health && seed.v.health.errors) || {}).length > 0;
        render(seed.v); health(seed.v.health || {}); lastRead = seed.t;
        lastGood = seedPartial ? 0 : lastRead; stamp(seedPartial);
      }
    } catch (e) {}
    var inflight = false, lastTry = 0;
    function load() {
      var now = Date.now();
      if (inflight || now - lastTry < 3000) return;
      inflight = true; lastTry = now;
      fetch('/api/lpbook', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (v) {
          inflight = false;
          if (!v || v.error || !ready(v)) { stamp(true); return; }
          /* A chain that could not be read this time (a rate limit, most often) leaves its part
             of the book at the last save, hours old: claims vanish, PnL jumps. For a few minutes
             the last full reading stays on screen instead, under the warning; past that the
             partial answer is shown, and it is never saved as the last good one. */
          var partial = Object.keys((v.health && v.health.errors) || {}).length > 0;
          if (partial && lastGood && Date.now() - lastGood < HOLD) { health(v.health, true); stamp(true); return; }
          render(v); health(v.health || {}); lastRead = Date.now(); lastGood = partial ? 0 : lastRead; stamp(partial);
          if (!partial) try { localStorage.setItem(KEY, JSON.stringify({ t: lastGood, v: v })); } catch (e) {}
        })
        .catch(function () { inflight = false; stamp(true); });
    }
    load();
    setInterval(load, 15000);
    setInterval(function () { stamp(); }, 1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  /* a small dialog: the claim record */
  function modal(id) {
    var m = $(id);
    m.addEventListener('click', function (ev) { if (ev.target === m) m.classList.remove('open'); });
    m.querySelector('.modal-x').addEventListener('click', function () { m.classList.remove('open'); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') m.classList.remove('open'); });
    return { open: function () { m.classList.add('open'); }, body: m.querySelector('.modal-body') };
  }

  window.LPBook = { $: $, esc: esc, money: money, signed: signed, cls: cls, amt: amt, day: day, when: when, held: held,
    chart: chart, poll: poll, modal: modal };
})();

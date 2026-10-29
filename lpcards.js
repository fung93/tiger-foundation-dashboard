/* ============================================================================
   lpcards.js — the live LP position card and the LIVE stamp, shared.

   Used by the LP Book (/lp.html) and the phone widget (/widget.html), so the two
   draw exactly the same card from the same /api/lpbook view. Styles are in
   lpcards.css beside it.

     LPCards.card(W)            one position's card, as HTML
     LPCards.list(views)        every card, or a line saying nothing is open
     LPCards.comparison(c, options)
                                LP outcome against keeping the deposited tokens
     LPCards.stamp(el, last, failed)
                                LIVE with a running clock while figures are fresh;
                                STALE with their age after twenty minutes without one
   ========================================================================== */
(function () {
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  var finite = function (n) { return typeof n === 'number' && Number.isFinite(n); };
  var money = function (n, signed) {
    if (!finite(n)) return '—';
    if (Math.abs(n) < 0.005) n = 0;
    return (n < 0 ? '-' : signed && n > 0 ? '+' : '') + '$'
      + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var direction = function (n) { return finite(n) && n > 0.004 ? ' up' : finite(n) && n < -0.004 ? ' down' : ''; };
  var readingTime = function (ts) {
    if (!finite(ts) || ts <= 0 || !Number.isFinite(new Date(ts * 1000).getTime())) return '';
    return new Date(ts * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur',
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };
  function period(start, end) {
    var first = readingTime(start), last = readingTime(end);
    return first && last ? first + ' to ' + last + ' MYT' : '';
  }

  /* A poll rebuilds card HTML. Read the old disclosure state before replacing it. */
  function detailsOpen(key) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false;
    key = String(key == null ? '' : key);
    if (!key) return false;
    try {
      return Array.prototype.some.call(document.querySelectorAll('details[data-lp-detail]'), function (el) {
        return typeof el.getAttribute === 'function' && el.getAttribute('data-lp-detail') === key && el.open;
      });
    } catch (e) { return false; }
  }
  function detailAttributes(key) {
    return ' data-lp-detail="' + esc(key) + '"' + (detailsOpen(key) ? ' open' : '');
  }

  /* Comparisons use the deposit-aware backend reading, never the legacy row.il figure. */
  function comparison(c, options) {
    options = options || {};
    var title = options.title || 'LP vs holding';
    var prefix = '<details class="lp-comparison' + (options.summary ? ' lp-comparison-summary' : '') + '"'
      + detailAttributes(options.key || 'comparison') + '><summary class="comparison-title">' + esc(title) + '</summary>';
    var fields = ['hold_usd', 'market_usd', 'il_usd', 'earned_usd', 'lp_outcome_usd', 'difference_usd'];
    var available = c && c.available === true && c.complete === true
      && fields.every(function (key) { return finite(c[key]); });
    if (!available) {
      var reason = c && c.reason || (c ? 'Complete comparison figures are unavailable.' : 'Comparison unavailable for this saved reading.');
      return prefix + '<p class="comparison-unavailable">' + esc(reason) + '</p></details>';
    }
    var differenceLabel = c.difference_usd < -0.004 ? 'LP behind holding' : 'LP advantage';
    var values = '<div class="comparison-values">'
      + '<div><div class="comparison-label">LP + earnings</div><div class="comparison-value">' + esc(money(c.lp_outcome_usd)) + '</div></div>'
      + '<div><div class="comparison-label">Just holding</div><div class="comparison-value">' + esc(money(c.hold_usd)) + '</div></div>'
      + '<div class="comparison-advantage"><div class="comparison-label">' + differenceLabel + '</div><div class="comparison-value' + direction(c.difference_usd) + '">' + esc(money(c.difference_usd, true)) + '</div></div>'
      + '</div>';
    var note = options.closed
      ? 'LP principal is valued at close. Booked claim proceeds keep their recorded prices.'
      : 'Includes claimed and unclaimed earnings.';
    var window = options.summary && options.closed ? '' : period(c.start_ts, c.end_ts);
    var method = (c.basis ? '<p class="comparison-note">' + esc(c.basis) + '</p>' : '')
      + (window ? '<p class="comparison-note">' + esc(window) + '</p>' : '')
      + (!options.summary && finite(c.deposit_count) && c.deposit_count > 1
        ? '<p class="comparison-note">Includes all ' + esc(c.deposit_count) + ' recorded deposits.</p>' : '')
      + '<p class="comparison-note">Just holding values the deposited tokens at the same prices.</p>';
    return prefix + values
      + '<p class="comparison-note comparison-basis">' + esc(note) + '</p>'
      + method + '</details>';
  }

  function apr(W) {
    var detail = W.apr_detail;
    var cachedRate = W.apr && W.apr !== '–' && W.apr !== '—' ? W.apr : '—';
    if (!detail) return '<div class="apr">' + esc(cachedRate) + ' APR</div>'
      + '<div class="apr-note">Period unavailable for this saved reading.</div>';
    var window = period(detail.start_ts, detail.end_ts);
    var available = detail.available === true && detail.complete === true && finite(detail.pct)
      && finite(detail.earned_usd) && finite(detail.capital_usd) && detail.capital_usd > 0
      && finite(detail.elapsed_hours) && detail.elapsed_hours > 0 && window;
    if (!available) return '<div class="apr">— APR</div><div class="apr-note">'
      + esc(detail.reason || 'A complete earning period is unavailable.') + '</div>';
    var rate = cachedRate !== '—' ? cachedRate
      : (detail.pct >= 100 ? Math.round(detail.pct).toLocaleString('en-US') : detail.pct.toFixed(1)) + '%';
    return '<div class="apr">' + esc(rate) + ' APR'
      + (detail.period_label ? '<span class="apr-period"> · ' + esc(detail.period_label) + '</span>' : '') + '</div>';
  }

  function card(W) {
    var oor = !W.in_range, p = Math.max(3, Math.min(97, W.position_pct));
    var detailKey = String(W.chain == null ? '' : W.chain) + ':' + String(W.id == null ? '' : W.id);
    return '<div class="lpw"><div class="top"><div><div class="pair">' + esc(W.pair) + '</div>'
      + apr(W) + '</div>'
      + '<div class="badge ' + (oor ? 'out' : 'in') + '">' + esc(W.status) + '</div></div>'
      + '<div class="band"><div class="price" style="left:' + p + '%">' + esc(W.price) + '</div>'
      + '<div class="track"><div class="fill' + (oor ? ' oor' : '') + '"></div><div class="mark' + (oor ? ' oor' : '') + '" style="left:' + p + '%"></div></div>'
      + '<div class="ends"><span>' + esc(W.lower) + '</span><span class="mid' + (parseFloat(W.nearest_edge) < 0.25 ? ' near' : '') + '">'
      + esc(W.edges) + '</span><span>' + esc(W.upper) + '</span></div></div>'
      + '<div class="figs"><div><div class="k">' + esc(W.yield_label) + '</div><div class="v up">' + esc(W.yield_value) + '</div></div>'
      + '<div><div class="k">P&amp;L</div><div class="v ' + (W.pnl_up ? 'up' : 'down') + '">' + esc(W.pnl) + '</div></div>'
      + '<div><div class="k">Net</div><div class="v ' + (W.net_up ? 'up' : 'down') + '">' + esc(W.net) + '</div></div></div>'
      + comparison(W.comparison, { key: detailKey + ':comparison' })
      + '<div class="foot"><span>' + esc(W.since)
      + (W.in_range_pct != null ? ' · ' + W.in_range_pct + '% in range' : '') + '</span><span>cost ' + esc(W.cost)
      + (W.value_now ? ' · value ' + esc(W.value_now) : '') + '</span></div></div>';
  }

  function list(views) {
    return views && views.length ? views.map(card).join('') : '<div class="empty">Nothing open on any chain.</div>';
  }

  /* The markup is rebuilt only when the state changes — rebuilding it every second would
     restart the dot's pulse — and the clock alone ticks. */
  function stamp(el, last, failed) {
    if (!el) return;
    var age = last ? Math.round((Date.now() - last) / 60000) : null;
    var stale = failed || (age !== null && age > 20);
    var state = age === null ? (failed ? 'fail' : 'load') : stale ? 'stale' + age : 'live';
    if (el.getAttribute('data-state') !== state) {
      el.setAttribute('data-state', state);
      el.innerHTML = age === null
        ? (failed ? '<span class="st">COULD NOT LOAD</span><br>&nbsp;' : 'LOADING<br>&nbsp;')
        : stale ? '<span class="dot"></span><span class="st">STALE</span><br>' + (age < 1 ? 'just now' : age + 'm ago')
        : '<span class="dot"></span><span class="st">LIVE</span><br><span class="ck"></span>';
      el.className = 'stamp' + (stale ? ' stale' : '');
    }
    var ck = el.querySelector('.ck');
    if (ck) ck.textContent = new Date().toTimeString().slice(0, 8);
  }

  window.LPCards = { card: card, list: list, comparison: comparison, detailsOpen: detailsOpen, stamp: stamp, esc: esc };
})();

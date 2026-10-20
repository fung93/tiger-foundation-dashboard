/* ============================================================================
   lpcards.js — the live LP position card and the LIVE stamp, shared.

   Used by the LP Book (/lp.html) and the phone widget (/widget.html), so the two
   draw exactly the same card from the same /api/lpbook view. Styles are in
   lpcards.css beside it.

     LPCards.card(W)            one position's card, as HTML
     LPCards.list(views)        every card, or a line saying nothing is open
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

  function card(W) {
    var oor = !W.in_range, p = Math.max(3, Math.min(97, W.position_pct));
    return '<div class="lpw"><div class="top"><div><div class="pair">' + esc(W.pair) + '</div>'
      + (W.apr && W.apr !== '–' ? '<div class="apr">' + esc(W.apr) + ' APR</div>' : '') + '</div>'
      + '<div class="badge ' + (oor ? 'out' : 'in') + '">' + esc(W.status) + '</div></div>'
      + '<div class="band"><div class="price" style="left:' + p + '%">' + esc(W.price) + '</div>'
      + '<div class="track"><div class="fill' + (oor ? ' oor' : '') + '"></div><div class="mark' + (oor ? ' oor' : '') + '" style="left:' + p + '%"></div></div>'
      + '<div class="ends"><span>' + esc(W.lower) + '</span><span class="mid' + (parseFloat(W.nearest_edge) < 0.25 ? ' near' : '') + '">'
      + esc(W.edges) + '</span><span>' + esc(W.upper) + '</span></div></div>'
      + '<div class="figs"><div><div class="k">' + esc(W.yield_label) + '</div><div class="v up">' + esc(W.yield_value) + '</div></div>'
      + '<div><div class="k">P&amp;L</div><div class="v ' + (W.pnl_up ? 'up' : 'down') + '">' + esc(W.pnl) + '</div></div>'
      + '<div><div class="k">Net</div><div class="v ' + (W.net_up ? 'up' : 'down') + '">' + esc(W.net) + '</div></div></div>'
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

  window.LPCards = { card: card, list: list, stamp: stamp, esc: esc };
})();

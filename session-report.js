// Feelfy support's decision page for a "Something wrong with the session?"
// report (SportMatch PLAN.md B53 step 5b), with the texts Agis approved on
// 2026-10-26 (B53's step 5a and 5b records). It talks only to the
// decide-session-report edge function, which allows only the origin
// https://feelfy.app and answers { error, code } on failure.
//
// The secret token arrives in the address's fragment (#t=<token>; older alerts'
// buttons add &a=<action>, which pre-selects that choice) and is removed from
// the address bar and history before anything else runs.
// It is kept only in this script's memory: never stored, never logged. This
// script logs nothing at all, so neither the token nor the answer's data (names,
// the reports' descriptions) reaches the console. Every value from the answer
// is set with textContent.
//
// Loaded in <head> without defer, so the fragment is gone before the page is
// drawn; the rest waits for DOMContentLoaded.
(function () {
  'use strict';

  var ENDPOINT = 'https://kskjnigieybpzmvakblm.supabase.co/functions/v1/decide-session-report';
  // decide-session-report's tokens: 32 random bytes, base64url, 43 characters.
  var TOKEN = /^[A-Za-z0-9_-]{43}$/;
  var CHOICES = ['release', 'refund', 'split', 'extend'];
  var DAY_MS = 24 * 60 * 60 * 1000;
  // A report's first deadline is its created_at + 7 days, and Extend adds 7
  // (Agis, 2026-10-26: one option only; the database also accepts 10).
  var REPORT_DAYS = 7;
  var EXTEND_DAYS = 7;

  // Agis's approved texts (2026-10-26), keyed by the function's codes.
  var INVALID_LINK = "This link isn't valid.";
  var ALREADY_RESOLVED = 'This report has already been resolved.';
  var GENERIC = 'Something went wrong. Please try again.';
  var ERRORS = {
    invalid_link: INVALID_LINK,
    already_resolved: ALREADY_RESOLVED,
    ledger_not_held: "The trainer's earnings for this session aren't on hold, so nothing was changed. Check the booking by hand.",
    refund_in_progress_or_done: 'A refund for this booking is already in progress or done, so nothing was changed.',
    refund_failed: 'Stripe refused the refund, so nothing was changed. Try again, or check the payment in Stripe.',
    refund_outcome_unknown: "Stripe didn't answer, so the refund may or may not have gone through. Check the payment in Stripe before trying again.",
    refund_sent_not_recorded: "The refund was made in Stripe but couldn't be recorded. Record it by hand."
  };
  // After these, nothing on the page can be done any more.
  var FINAL = { invalid_link: true, already_resolved: true, refund_sent_not_recorded: true };

  // Read the fragment, then remove it at once.
  var params = new URLSearchParams(location.hash.replace(/^#/, ''));
  var token = params.get('t');
  var preselected = params.get('a');
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (typeof token !== 'string' || !TOKEN.test(token)) token = null;
  if (CHOICES.indexOf(preselected) === -1) preselected = null;

  var view = null;        // the 'view' answer
  var choice = null;      // the selected choice
  var busy = false;
  var finished = false;

  // ---- Formatting -------------------------------------------------------

  // Whole cents as "18.00", in integer arithmetic.
  function euros(cents) {
    var rest = cents % 100;
    return (cents - rest) / 100 + '.' + (rest < 10 ? '0' : '') + rest;
  }

  // "8", "8.5", "8.50" or "8,50" as whole cents; null for anything else.
  function parseEuros(text) {
    var value = String(text).trim().replace(',', '.');
    var match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value);
    if (!match) return null;
    var fraction = match[2] ? (match[2] + '0').slice(0, 2) : '00';
    return Number(match[1]) * 100 + Number(fraction);
  }

  var vilniusDate = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Vilnius', day: 'numeric', month: 'long', year: 'numeric'
  });
  var vilniusTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Vilnius', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });

  // An instant as "2 November 2026, 20:17", Vilnius time.
  function vilnius(iso) {
    var at = new Date(iso);
    if (isNaN(at.getTime())) return '—';
    return vilniusDate.format(at) + ', ' + vilniusTime.format(at);
  }

  // The booking's naive Vilnius date ("2026-10-25") as "Sunday 25 October 2026".
  function sessionDate(ymd) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
    if (!parts) return '—';
    var at = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }).format(at);
  }

  // "09:15" and 15 minutes as "09:15–09:30" (wall clock, as the emails show it).
  function timeRange(slot, minutes) {
    var parts = /^(\d{2}):(\d{2})$/.exec(String(slot));
    if (!parts) return '—';
    var start = Number(parts[1]) * 60 + Number(parts[2]);
    var end = (start + (Number(minutes) || 0)) % (24 * 60);
    function hhmm(m) {
      var h = Math.floor(m / 60);
      var mm = m % 60;
      return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
    }
    return hhmm(start) + '–' + hhmm(end);
  }

  function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : '—';
  }

  function cents(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.round(value) : 0;
  }

  // ---- The page ---------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function row(list, label, value, total) {
    var dt = document.createElement('dt');
    var dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    if (total) { dt.className = 'total'; dd.className = 'total'; }
    list.appendChild(dt);
    list.appendChild(dd);
  }

  function showMessage(message) {
    $('details').hidden = true;
    $('message').textContent = message;
    $('message').hidden = false;
  }

  function showResult(message, ok) {
    var result = $('result');
    result.textContent = message;
    result.className = 'result ' + (ok ? 'ok' : 'err');
    result.hidden = false;
  }

  function clearResult() {
    $('result').hidden = true;
    $('result').textContent = '';
  }

  function priceCents() { return cents(view.price_cents); }
  function feeCents() { return cents(view.fee_cents); }
  function releaseCents() {
    return view.ledger && typeof view.ledger.amount_cents === 'number'
      ? cents(view.ledger.amount_cents)
      : priceCents();
  }

  function reportList() {
    return Array.isArray(view.reports) ? view.reports : [];
  }

  // " · extended by 7 days", " · extended twice, by 14 days", " · extended 3
  // times, by 21 days", ..., from the earliest open report's deadline against
  // its created_at (whole days, so a DST change doesn't count); '' when it
  // isn't extended, or by something other than 7-day steps.
  function extensionNote() {
    var earliest = null;
    reportList().forEach(function (report) {
      if (report.resolved_at) return;
      var deadline = new Date(report.deadline_at).getTime();
      var created = new Date(report.created_at).getTime();
      if (isNaN(deadline) || isNaN(created)) return;
      if (earliest === null || deadline < earliest.deadline) {
        earliest = { deadline: deadline, created: created };
      }
    });
    if (earliest === null) return '';
    var extra = Math.round((earliest.deadline - earliest.created) / DAY_MS) - REPORT_DAYS;
    if (extra <= 0 || extra % EXTEND_DAYS !== 0) return '';
    var times = extra / EXTEND_DAYS;
    if (times === 1) return ' · extended by ' + extra + ' days';
    if (times === 2) return ' · extended twice, by ' + extra + ' days';
    return ' · extended ' + times + ' times, by ' + extra + ' days';
  }

  function showDeadline(iso) {
    $('deadline').textContent = iso ? vilnius(iso) : '—';
    $('extended').textContent = extensionNote();
  }

  function render() {
    var reports = $('reports');
    reportList().forEach(function (report) {
      var card = document.createElement('div');
      card.className = 'card';
      var rows = document.createElement('dl');
      rows.className = 'rows';
      row(rows, 'Reported by', report.role === 'trainer' ? 'Trainer' : 'Client');
      row(rows, 'Reported at', vilnius(report.created_at));
      row(rows, 'Reason', text(report.reason_label));
      row(rows, 'Status', report.resolved_at ? 'Resolved ' + vilnius(report.resolved_at) : 'Open');
      card.appendChild(rows);
      var description = document.createElement('p');
      description.className = 'description';
      var label = document.createElement('span');
      label.className = 'description-label';
      label.textContent = 'Description';
      description.appendChild(label);
      description.appendChild(document.createTextNode(text(report.details)));
      card.appendChild(description);
      reports.appendChild(card);
    });

    var session = view.session || {};
    var sessionRows = $('session');
    row(sessionRows, 'Date', sessionDate(session.date));
    row(sessionRows, 'Time', timeRange(session.time_slot, session.duration_minutes));
    row(sessionRows, 'Sport', text(session.sport));
    row(sessionRows, 'Location', text(session.location));
    row(sessionRows, 'Trainer', text(view.trainer_name));
    row(sessionRows, 'Client', text(view.client_name));

    var amounts = $('amounts');
    row(amounts, "Trainer's price", '€' + euros(priceCents()));
    row(amounts, "Feelfy's fee", '€' + euros(feeCents()));
    row(amounts, 'Total paid', '€' + euros(priceCents() + feeCents()), true);

    showDeadline(view.deadline_at);

    var from = new Date(view.deadline_at).getTime();
    if (view.deadline_at && !isNaN(from)) {
      $('extend-deadline').textContent = 'New deadline: ' + vilnius(new Date(from + EXTEND_DAYS * DAY_MS).toISOString());
      $('extend-deadline').hidden = false;
    }

    $('release-question').textContent = 'Release €' + euros(releaseCents()) + ' to the trainer?';
    $('refund-question').textContent = 'Refund €' + euros(priceCents()) + " to the client? Feelfy's fee (€" + euros(feeCents()) + ') is kept.';
    updateSplit();

    $('message').hidden = true;
    $('details').hidden = false;
    if (preselected) select(preselected);
    refreshControls();
  }

  function select(name) {
    choice = name;
    CHOICES.forEach(function (c) {
      $('panel-' + c).hidden = c !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-choice]'), function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-choice') === name ? 'true' : 'false');
    });
    clearResult();
    refreshControls();
  }

  // The split's two amounts, or null when either is malformed or they add up
  // to more than the price.
  function splitAmounts() {
    var client = parseEuros($('split-client').value);
    var trainer = parseEuros($('split-trainer').value);
    if (client === null || trainer === null || client + trainer > priceCents()) return null;
    return { client: client, trainer: trainer };
  }

  function updateSplit() {
    var clientInput = $('split-client');
    var trainerInput = $('split-trainer');
    var client = parseEuros(clientInput.value);
    var trainer = parseEuros(trainerInput.value);
    var over = client !== null && trainer !== null && client + trainer > priceCents();
    clientInput.setAttribute('aria-invalid', clientInput.value !== '' && (client === null || over) ? 'true' : 'false');
    trainerInput.setAttribute('aria-invalid', trainerInput.value !== '' && (trainer === null || over) ? 'true' : 'false');
    var amounts = splitAmounts();
    $('split-kept').textContent = 'Kept by Feelfy: ' +
      (amounts ? '€' + euros(priceCents() - amounts.client - amounts.trainer) : '—');
  }

  // Disables everything while a request runs and once the page is finished;
  // otherwise each Confirm only when its choice is complete.
  function refreshControls() {
    var locked = busy || finished;
    Array.prototype.forEach.call(document.querySelectorAll('button, input'), function (control) {
      control.disabled = locked;
    });
    if (locked) return;
    document.querySelector('[data-confirm="split"]').disabled = splitAmounts() === null;
  }

  // ---- The function -----------------------------------------------------

  // { ok: true, data } on a 2xx with a JSON object; otherwise { ok: false,
  // code, resolution }, code null when there was no answer or no code in it,
  // resolution already_resolved's decision, or null.
  function call(body) {
    body.token = token;
    return fetch(ENDPOINT, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (data) {
        return { response: response, data: data };
      }, function () {
        return { response: response, data: null };
      });
    }).then(function (answer) {
      var data = answer.data && typeof answer.data === 'object' ? answer.data : null;
      if (answer.response.ok && data) return { ok: true, data: data };
      return {
        ok: false,
        code: data && typeof data.code === 'string' ? data.code : null,
        resolution: data && data.resolution && typeof data.resolution === 'object' ? data.resolution : null
      };
    }, function () {
      return { ok: false, code: null, resolution: null };
    });
  }

  // The emails' sentences: who was emailed, then one line for each email that
  // couldn't be sent ('failed', or 'no_address'). 'not_needed' adds nothing.
  function emailLines(emailed) {
    var sent = [];
    var lines = [];
    ['trainer', 'client'].forEach(function (who) {
      var outcome = emailed && emailed[who];
      if (outcome === 'sent') sent.push(who);
      else if (outcome === 'failed' || outcome === 'no_address') {
        lines.push('The ' + who + "'s email couldn't be sent. Email them by hand.");
      }
    });
    if (sent.length === 2) lines.unshift('Both have been emailed.');
    else if (sent.length === 1) lines.unshift('The ' + sent[0] + ' has been emailed.');
    return lines;
  }

  // A decision's parts, "€8.00 refunded to the client", "€5.00 released to
  // the trainer", "€5.00 kept by Feelfy", only those that apply.
  function decisionParts(resolution, client, trainer, price) {
    var parts = [];
    if (client > 0) parts.push('€' + euros(client) + ' refunded to the client');
    if (trainer > 0) parts.push('€' + euros(trainer) + ' released to the trainer');
    if (resolution === 'split') {
      var kept = price - client - trainer;
      if (kept > 0) parts.push('€' + euros(kept) + ' kept by Feelfy');
    }
    return parts;
  }

  // "Done. €8.00 refunded to the client, €5.00 released to the trainer, €5.00
  // kept by Feelfy. Both have been emailed.", from only the parts that apply.
  function decisionDone(data) {
    var parts = decisionParts(data.resolution, cents(data.client_refund_cents), cents(data.trainer_cents), priceCents());
    var first = parts.length > 0 ? 'Done. ' + parts.join(', ') + '.' : 'Done.';
    return [first].concat(emailLines(data.emailed)).join(' ');
  }

  // "This report was resolved on 26 October 2026, 23:11: €8.00 refunded to
  // the client, €5.00 released to the trainer, €5.00 kept by Feelfy.", from
  // already_resolved's resolution; the plain sentence without one.
  function resolvedText(resolution) {
    var at = resolution ? vilnius(resolution.resolved_at) : '—';
    if (at === '—') return ALREADY_RESOLVED;
    var parts = decisionParts(resolution.resolution, cents(resolution.client_refund_cents),
      cents(resolution.trainer_cents), cents(resolution.price_cents));
    return 'This report was resolved on ' + at + (parts.length > 0 ? ': ' + parts.join(', ') : '') + '.';
  }

  function errorText(answer) {
    if (answer.code === 'already_resolved') return resolvedText(answer.resolution);
    return ERRORS[answer.code] || GENERIC;
  }

  function extensionDone(data) {
    return ['Done. The new deadline is ' + vilnius(data.deadline_at) + '.'].concat(emailLines(data.emailed)).join(' ');
  }

  function confirm(name) {
    if (busy || finished || name !== choice) return;
    var body = { action: name };
    if (name === 'split') {
      var amounts = splitAmounts();
      if (!amounts) return;
      body.client_amount = amounts.client;
      body.trainer_amount = amounts.trainer;
    }
    if (name === 'extend') body.days = EXTEND_DAYS;
    busy = true;
    clearResult();
    refreshControls();
    call(body).then(function (answer) {
      busy = false;
      if (answer.ok) {
        finished = true;
        if (name === 'extend') {
          if (answer.data.deadline_at) {
            // As extend_session_reports moved them: every open report's
            // deadline + 7 days, so the note counts this extension too.
            reportList().forEach(function (report) {
              var deadline = new Date(report.deadline_at).getTime();
              if (!report.resolved_at && !isNaN(deadline)) {
                report.deadline_at = new Date(deadline + EXTEND_DAYS * DAY_MS).toISOString();
              }
            });
            showDeadline(answer.data.deadline_at);
          }
          showResult(extensionDone(answer.data), true);
        } else {
          showResult(decisionDone(answer.data), true);
        }
      } else {
        if (FINAL[answer.code]) finished = true;
        showResult(errorText(answer), false);
      }
      refreshControls();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!token) {
      showMessage(INVALID_LINK);
      return;
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-choice]'), function (button) {
      button.addEventListener('click', function () { select(button.getAttribute('data-choice')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-confirm]'), function (button) {
      button.addEventListener('click', function () { confirm(button.getAttribute('data-confirm')); });
    });
    ['split-client', 'split-trainer'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        updateSplit();
        clearResult();
        refreshControls();
      });
    });

    call({ action: 'view' }).then(function (answer) {
      if (answer.ok) {
        view = answer.data;
        render();
      } else if (answer.code === 'invalid_link' || answer.code === 'already_resolved') {
        showMessage(errorText(answer));
      } else {
        showMessage(GENERIC);
      }
    });
  });
})();

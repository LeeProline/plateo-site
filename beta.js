const SIGNUP_ENDPOINT = 'https://beta.plateo.fit/signup';

// PlateO beta sign-up. Sends the form as JSON to the sign-up Worker.
// No cookies, no storage, no third parties. The form stays hidden without JavaScript
// (the page shows an email link instead).
(function () {
  'use strict';

  var FALLBACK_EMAIL = 'hello@plateo.fit';
  var NOTE_MAX = 500;
  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

  var form = document.getElementById('signup');
  if (!form || !window.fetch || !window.JSON) return;

  var fields = {
    name: document.getElementById('name'),
    email: document.getElementById('email'),
    iphone: document.getElementById('iphone'),
    training: document.getElementById('training'),
    note: document.getElementById('note'),
    consent: document.getElementById('consent'),
    website: document.getElementById('website')
  };
  var statusEl = document.getElementById('status');
  var submitBtn = document.getElementById('submit');
  var successEl = document.getElementById('success');
  var countEl = document.getElementById('note-count');

  form.hidden = false;

  function setError(key, message) {
    var input = fields[key];
    var out = document.getElementById(key + '-error');
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      out.textContent = message;
    } else {
      input.removeAttribute('aria-invalid');
      out.textContent = '';
    }
  }

  function validate() {
    var errors = {};
    var name = fields.name.value.trim();
    var email = fields.email.value.trim();
    var note = fields.note.value;

    if (!name) errors.name = 'Enter your name.';
    else if (name.length > 80) errors.name = 'Keep your name to 80 characters or fewer.';

    if (!email) errors.email = 'Enter your email address.';
    else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'Enter an email address like name@example.com.';

    if (note.length > NOTE_MAX) errors.note = 'Keep this to ' + NOTE_MAX + ' characters or fewer.';

    if (!fields.consent.checked) errors.consent = 'Tick the box so I can email you about the beta.';

    ['name', 'email', 'note', 'consent'].forEach(function (key) { setError(key, errors[key]); });
    return errors;
  }

  function showStatus(html, isError) {
    statusEl.className = 'status' + (isError ? ' is-error' : '');
    statusEl.innerHTML = html;
  }

  function failMessage(code) {
    var mail = '<a href="mailto:' + FALLBACK_EMAIL + '?subject=PlateO%20beta">' + FALLBACK_EMAIL + '</a>';
    if (code === 429) return 'Too many tries from this connection. Please try again in an hour, or email ' + mail + '.';
    if (code === 400) return 'Something in the form was not accepted. Please check it and try again, or email ' + mail + '.';
    return 'Sorry, that did not go through. Please try again in a moment, or email ' + mail + '.';
  }

  function updateCount() {
    countEl.textContent = fields.note.value.length + ' / ' + NOTE_MAX;
  }
  fields.note.addEventListener('input', updateCount);
  updateCount();

  // Clear a field's error as soon as it is fixed.
  ['name', 'email', 'consent'].forEach(function (key) {
    var evt = key === 'consent' ? 'change' : 'input';
    fields[key].addEventListener(evt, function () {
      if (fields[key].getAttribute('aria-invalid') === 'true') validate();
    });
  });

  var sending = false;

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sending) return;

    var errors = validate();
    var first = ['name', 'email', 'note', 'consent'].filter(function (k) { return errors[k]; })[0];
    if (first) {
      showStatus('Please fix the highlighted field' + (Object.keys(errors).length > 1 ? 's' : '') + '.', true);
      fields[first].focus();
      return;
    }

    var payload = {
      name: fields.name.value.trim(),
      email: fields.email.value.trim(),
      iphone: fields.iphone.value,
      training: fields.training.value,
      note: fields.note.value.trim(),
      consent: fields.consent.checked,
      website: fields.website.value
    };

    sending = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    showStatus('Sending…', false);

    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;

    fetch(SIGNUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'strict-origin',
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok && data && data.ok === true) return;
        var err = new Error('signup failed');
        err.status = res.status;
        throw err;
      });
    }).then(function () {
      form.hidden = true;
      successEl.hidden = false;
      document.getElementById('success-title').focus();
    }).catch(function (err) {
      showStatus(failMessage(err && err.status), true);
    }).then(function () {
      if (timer) clearTimeout(timer);
      sending = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Ask to join';
    });
  });
})();

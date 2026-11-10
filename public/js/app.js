/**
 * PonyPals - party request form
 */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('partyRequestForm');
  if (!form) return;

  const errorBox = document.getElementById('formError');
  const totalEl = document.getElementById('summaryPriceDisplay');
  const totalDetailEl = document.getElementById('summaryDetailsDisplay');
  const submitBtn = document.getElementById('submitBtn');
  const confirmation = document.getElementById('bookingSuccessCard');
  const anotherBtn = document.getElementById('submitAnotherBtn');

  const PACKAGES = {
    starter: { name: 'Little Buckaroo', price: 225 },
    carousel: { name: 'Classic Carousel', price: 385 },
    unicorn: { name: 'Unicorn Gala', price: 545 }
  };

  const ADDONS = {
    'unicorn-makeover': 45,
    'petting-pen': 85,
    'cowboy-hats': 50,
    'extra-half-hour': 75
  };

  // Earliest bookable date is tomorrow, in the visitor's local time zone
  const dateInput = form.eventDate;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  dateInput.min = toLocalISODate(tomorrow);

  function toLocalISODate(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
  }

  // ----- Running total -----
  function updateTotal() {
    const pkgInput = form.querySelector('input[name="packageId"]:checked');
    const pkg = PACKAGES[pkgInput?.value] || PACKAGES.carousel;
    const extras = [...form.querySelectorAll('input[name="addOns"]:checked')];
    const extrasTotal = extras.reduce((sum, cb) => sum + (ADDONS[cb.value] || 0), 0);

    totalEl.textContent = `$${pkg.price + extrasTotal}`;
    totalDetailEl.textContent = extras.length
      ? `${pkg.name} plus ${extras.length} extra${extras.length > 1 ? 's' : ''} ($${extrasTotal})`
      : pkg.name;
  }

  form.addEventListener('change', e => {
    if (e.target.name === 'packageId' || e.target.name === 'addOns') updateTotal();
    if (e.target.getAttribute('aria-invalid') === 'true') e.target.removeAttribute('aria-invalid');
  });
  form.addEventListener('input', e => {
    if (e.target.getAttribute('aria-invalid') === 'true') e.target.removeAttribute('aria-invalid');
  });

  updateTotal();

  // ----- Links elsewhere on the page that pre-fill the form -----
  document.querySelectorAll('.pick-pony').forEach(link => {
    link.addEventListener('click', () => {
      const cb = form.querySelector(`input[name="selectedPonies"][value="${link.dataset.pony}"]`);
      if (cb) cb.checked = true;
    });
  });

  document.querySelectorAll('.pick-pkg').forEach(link => {
    link.addEventListener('click', () => {
      const radio = form.querySelector(`input[name="packageId"][value="${link.dataset.pkg}"]`);
      if (radio) {
        radio.checked = true;
        updateTotal();
      }
    });
  });

  // ----- Validation -----
  function showErrors(messages, fields) {
    form.querySelectorAll('[aria-invalid="true"]').forEach(el => el.removeAttribute('aria-invalid'));
    fields.forEach(el => el.setAttribute('aria-invalid', 'true'));

    if (!messages.length) {
      errorBox.classList.remove('visible');
      errorBox.textContent = '';
      return;
    }

    errorBox.textContent = messages.length === 1
      ? messages[0]
      : `A few things need fixing: ${messages.join(' ')}`;
    errorBox.classList.add('visible');
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (fields[0]) fields[0].focus({ preventScroll: true });
  }

  function validate() {
    const messages = [];
    const fields = [];
    const need = (input, msg) => { messages.push(msg); fields.push(input); };

    if (!dateInput.value) need(dateInput, 'Pick a date for the party.');
    else if (dateInput.value < dateInput.min) need(dateInput, 'The party date needs to be tomorrow or later.');

    if (!form.locationAddress.value.trim()) need(form.locationAddress, 'Add the address or park name.');
    if (!form.parentName.value.trim()) need(form.parentName, 'Add your name.');

    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) need(form.email, 'Check your email address.');

    if (form.phone.value.replace(/\D/g, '').length < 7) need(form.phone, 'Add a phone number we can call or text.');

    return { messages, fields };
  }

  // ----- Submit -----
  form.addEventListener('submit', async e => {
    e.preventDefault();

    const { messages, fields } = validate();
    showErrors(messages, fields);
    if (messages.length) return;

    const checkedValues = name =>
      [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(cb => cb.value);

    const payload = {
      packageId: form.querySelector('input[name="packageId"]:checked').value,
      eventDate: dateInput.value,
      eventTime: form.eventTime.value,
      locationAddress: form.locationAddress.value.trim(),
      surfaceType: form.surfaceType.value,
      childName: form.childName.value.trim(),
      childAge: form.childAge.value ? parseInt(form.childAge.value, 10) : null,
      estimatedKids: form.estimatedKids.value ? parseInt(form.estimatedKids.value, 10) : null,
      selectedPonies: checkedValues('selectedPonies'),
      addOns: checkedValues('addOns'),
      specialRequests: form.specialRequests.value.trim(),
      parentName: form.parentName.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim()
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    try {
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json();

      if (res.ok && result.success) {
        showConfirmation(result.booking);
      } else {
        showErrors(result.errors || [result.message || 'Something went wrong. Please try again.'], []);
      }
    } catch (err) {
      console.error(err);
      showErrors(["We couldn't send your request. Please check your connection, or call us at (555) 766-9725."], []);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send request';
    }
  });

  function showConfirmation(b) {
    document.getElementById('successParentName').textContent = b.parentName.split(' ')[0];
    document.getElementById('successPhone').textContent = b.phone;
    document.getElementById('successRefCode').textContent = b.id;
    document.getElementById('recapPackage').textContent = b.packageName;
    document.getElementById('recapDateTime').textContent = `${formatDate(b.eventDate)}, ${b.eventTime.toLowerCase()}`;
    document.getElementById('recapLocation').textContent = b.locationAddress;
    document.getElementById('recapTotal').textContent = `$${b.estimatedTotal}`;

    const notes = document.getElementById('recapSpecialRequests');
    notes.textContent = b.specialRequests || '';
    document.querySelectorAll('.recap-notes-row').forEach(el => {
      el.style.display = b.specialRequests ? '' : 'none';
    });

    form.style.display = 'none';
    confirmation.classList.add('active');
    confirmation.scrollIntoView({ behavior: 'smooth', block: 'start' });
    confirmation.focus({ preventScroll: true });
  }

  anotherBtn.addEventListener('click', () => {
    form.reset();
    showErrors([], []);
    updateTotal();
    confirmation.classList.remove('active');
    form.style.display = '';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

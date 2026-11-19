/**
 * PonyPals owner portal - party request list
 */
document.addEventListener('DOMContentLoaded', () => {
  let allRequests = [];
  let currentFilter = 'all';

  const tbody = document.getElementById('requestsTbody');
  const $ = id => document.getElementById(id);

  async function fetchRequests() {
    try {
      const res = await fetch('/api/requests');
      if (res.status === 401) {
        window.location.href = '/admin';
        return;
      }
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      allRequests = data.requests;
      updateStats();
      renderTable();
    } catch (err) {
      console.error('Failed to load requests:', err);
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Couldn\'t load requests. Is the server running?</td></tr>';
    }
  }

  function updateStats() {
    const pending = allRequests.filter(r => r.status === 'Pending').length;
    const confirmed = allRequests.filter(r => r.status === 'Confirmed');
    const revenue = confirmed.reduce((sum, r) => sum + (Number(r.estimatedTotal) || 0), 0);

    $('statTotal').textContent = allRequests.length;
    $('statPending').textContent = pending;
    $('statConfirmed').textContent = confirmed.length;
    $('statRevenue').textContent = `$${revenue.toLocaleString()}`;
    $('countAll').textContent = allRequests.length;
    $('countPending').textContent = pending;
    $('countConfirmed').textContent = confirmed.length;
  }

  function formatEventDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderTable() {
    const rows = currentFilter === 'all'
      ? allRequests
      : allRequests.filter(r => r.status === currentFilter);

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nothing here yet. New requests from the website will show up in this list.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const received = new Date(r.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const ponies = r.selectedPonies?.length ? `<div class="muted">Ponies: ${esc(r.selectedPonies.join(', '))}</div>` : '';
      const extras = r.addOns?.length ? `<div class="muted">Extras: ${esc(r.addOns.join(', '))}</div>` : '';
      const child = r.childName && r.childName !== 'Birthday Star' ? esc(r.childName) : 'Rider';
      const status = String(r.status || 'Pending');

      return `
        <tr>
          <td>
            <div class="ref-id">${esc(r.id)}</div>
            <div class="muted">Received ${received}</div>
          </td>
          <td>
            <div class="strong">${esc(r.parentName)}</div>
            <div><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></div>
            <div><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></div>
          </td>
          <td>
            <div class="strong">${esc(r.packageName)}</div>
            ${ponies}
            ${extras}
          </td>
          <td>
            <div class="strong">${esc(formatEventDate(r.eventDate))}, ${esc(r.eventTime)}</div>
            <div>${esc(r.locationAddress)}</div>
            <div class="muted">${child}${r.childAge ? `, age ${Number(r.childAge)}` : ''} &middot; ${Number(r.estimatedKids) || '?'} rider(s)${r.surfaceType ? ` &middot; ${esc(r.surfaceType)}` : ''}</div>
            ${r.specialRequests ? `<div class="notes">${esc(r.specialRequests)}</div>` : ''}
          </td>
          <td class="strong">$${Number(r.estimatedTotal) || 0}</td>
          <td>
            <span class="status status-${status.toLowerCase()}">${esc(status)}</span>
            <select class="status-select" data-id="${esc(r.id)}" aria-label="Change status">
              ${['Pending', 'Confirmed', 'Completed', 'Cancelled'].map(s =>
                `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <button class="delete-btn" data-id="${esc(r.id)}">Delete</button>
          </td>
        </tr>`;
    }).join('');
  }

  // Event delegation so listeners survive re-renders
  tbody.addEventListener('change', async e => {
    if (!e.target.matches('.status-select')) return;
    const { id } = e.target.dataset;
    const status = e.target.value;
    try {
      const res = await fetch(`/api/requests/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.status === 401) {
        window.location.href = '/admin';
        return;
      }
      const result = await res.json();
      if (!result.success) throw new Error(result.message);
      const req = allRequests.find(r => r.id === id);
      if (req) req.status = status;
      updateStats();
      renderTable();
    } catch (err) {
      console.error(err);
      alert('Could not update the status. Please try again.');
      renderTable();
    }
  });

  tbody.addEventListener('click', async e => {
    if (!e.target.matches('.delete-btn')) return;
    const { id } = e.target.dataset;
    if (!confirm(`Delete request ${id}? This can't be undone.`)) return;
    try {
      const res = await fetch(`/api/requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 401) {
        window.location.href = '/admin';
        return;
      }
      const result = await res.json();
      if (!result.success) throw new Error(result.message);
      allRequests = allRequests.filter(r => r.id !== id);
      updateStats();
      renderTable();
    } catch (err) {
      console.error(err);
      alert('Could not delete the request. Please try again.');
    }
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderTable();
    });
  });

  $('refreshBtn').addEventListener('click', fetchRequests);

  $('logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
    } finally {
      window.location.href = '/admin';
    }
  });

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  fetchRequests();
});

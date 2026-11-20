/**
 * PonyPals757 - photo gallery page
 */
document.addEventListener('DOMContentLoaded', async () => {
  const gallery = document.getElementById('photoGallery');
  if (!gallery) return;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  try {
    const res = await fetch('/api/photos', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const photos = Array.isArray(data.photos) ? data.photos : [];

    if (!photos.length) {
      gallery.innerHTML = `
        <div class="gallery-empty">
          <h2>Photos coming soon</h2>
          <p>New photos are added here regularly, and special events are also posted on our <a href="/#events">social media accounts</a>.</p>
        </div>
      `;
      return;
    }

    gallery.innerHTML = photos.map(photo => `
      <figure class="gallery-item">
        <div class="photo">
          <img src="${esc(photo.url)}" alt="${esc(photo.label || 'PonyPals757 photo')}" loading="lazy">
        </div>
      </figure>
    `).join('');
  } catch (err) {
    console.error('Failed to load photos:', err);
    gallery.innerHTML = '<div class="gallery-empty"><p>Could not load photos right now. Please try again later.</p></div>';
  }
});

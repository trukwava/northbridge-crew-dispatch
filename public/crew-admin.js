/* Demo-only, dispatcher-scoped crew configuration overlay. The server validates all writes. */
(() => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const skills = ['Water mitigation', 'Fire restoration', 'Commercial cleaning', 'Mold remediation'];
  const areas = ['Manhattan', 'Brooklyn', 'Queens'];
  const checks = (name, options, selected) => '<div class="checkbox-row">' + options.map(value =>
    '<label class="checkpill"><input type="checkbox" name="' + name + '" value="' + escapeHtml(value) + '" ' + (selected.includes(value) ? 'checked' : '') + '>' + escapeHtml(value) + '</label>'
  ).join('') + '</div>';
  const input = (name, label, value, constraints) => '<label><span class="field-label">' + label + '</span><input name="' + name + '" ' + constraints + ' value="' + escapeHtml(value ?? '') + '"></label>';
  async function openCrewEditor(id, trigger) {
    const res = await fetch('/api/crews', { headers: {'X-Demo-Role':'dispatcher',...(window.nbCsrf?{'X-CSRF-Token':window.nbCsrf}:{})} });
    if (!res.ok) throw Error('Could not load crew settings');
    const crews = await res.json();
    const c = crews.find(crew => crew.id === id);
    if (!c) throw Error('Crew was not found');
    const dialog = document.createElement('dialog');
    dialog.className = 'modal crew-editor';
    dialog.setAttribute('aria-label', 'Edit crew ' + id);
    dialog.innerHTML = '<div class="modal-top"><span class="eyebrow">DEMO CREW / ' + escapeHtml(id) + '</span><button type="button" class="close" data-close aria-label="Close crew editor">×</button></div>' +
      '<h2>Configure ' + escapeHtml(c.name) + '</h2>' +
      '<p>Only synthetic operational details. Active assignments protect required skills, service areas and capacity.</p>' +
      '<form id="crew-admin-form" class="form-grid">' +
      '<div class="full">' + input('name','Crew name *', c.name, 'required maxlength="80"') + '</div>' +
      '<label><span class="field-label">Availability</span><select name="availability"><option value="available" ' + (c.availability === 'available' ? 'selected' : '') + '>Available</option><option value="unavailable" ' + (c.availability === 'unavailable' ? 'selected' : '') + '>Unavailable</option></select></label>' +
      '<label><span class="field-label">Simulated channel</span><select name="channel"><option value="in_app" ' + (c.channel === 'in_app' ? 'selected' : '') + '>In-app simulation</option><option value="unavailable" ' + (c.channel === 'unavailable' ? 'selected' : '') + '>Unavailable</option></select></label>' +
      input('max_capacity','Maximum capacity *',c.max_capacity,'required type="number" min="1" max="20" step="1"') +
      input('baseline_load','Current workload *',c.baseline_load,'required type="number" min="0" step="1"') +
      '<div class="full"><span class="field-label">Operational skills *</span>' + checks('skills',skills,c.skills) + '</div>' +
      '<div class="full"><span class="field-label">Authorized areas *</span>' + checks('areas',areas,c.areas) + '</div>' +
      input('base_lat','Base latitude',c.base_lat,'type="number" min="-90" max="90" step="any"') +
      input('base_lon','Base longitude',c.base_lon,'type="number" min="-180" max="180" step="any"') +
      '<p class="note full">' + escapeHtml(c.reserved) + ' active reservation(s). Coordinates only break ties by straight-line distance, never driving time.</p>' +
      '<p id="crew-admin-error" role="alert" class="note full" hidden></p>' +
      '<div class="form-actions full"><button class="button" type="button" data-close>Cancel</button><button class="button primary" type="submit">Save crew settings</button></div></form>';
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); trigger.focus(); });
    dialog.addEventListener('click', event => { if (event.target.closest('[data-close]')) dialog.close(); });
    dialog.showModal();
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const error = dialog.querySelector('#crew-admin-error');
      const submit = form.querySelector('[type=submit]');
      error.hidden = true;
      if (!data.getAll('skills').length || !data.getAll('areas').length) {
        error.textContent = 'Select at least one skill and one service area.'; error.hidden = false; return;
      }
      const body = {
        name:data.get('name'),availability:data.get('availability'),channel:data.get('channel'),
        max_capacity:Number(data.get('max_capacity')),baseline_load:Number(data.get('baseline_load')),
        base_lat:data.get('base_lat'),base_lon:data.get('base_lon'),
        skills:data.getAll('skills'),areas:data.getAll('areas')
      };
      submit.disabled = true;
      try {
        const response = await fetch('/api/crews/' + encodeURIComponent(id), {
          method:'POST',headers:{'Content-Type':'application/json','X-Demo-Role':'dispatcher',...(window.nbCsrf?{'X-CSRF-Token':window.nbCsrf}:{})},body:JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error || 'Crew update was rejected');
        dialog.close();
        window.location.reload();
      } catch (failure) {
        error.textContent = failure.message || String(failure); error.hidden = false;
        submit.disabled = false;
      }
    });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-crew-edit]');
    if (!button) return;
    button.disabled = true;
    openCrewEditor(button.dataset.crewEdit, button).catch(error => {
      button.disabled = false;
      const toast = document.getElementById('toast');
      if (toast) { toast.textContent = error.message || String(error); toast.className = 'show error'; }
    }).finally(() => { button.disabled = false; });
  });
})();

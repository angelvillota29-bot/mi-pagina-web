const SUPREME_ADMIN_EMAIL = "angelvillota4@gmail.com";
let currentUser = null;

let categoriesData = [];
let dishesData = [];
let scheduleData = []; 
let takeoutConfig = { enabled: false, fee: 0, soupSizeFees: { Normal: 0, Grande: 0 } };
let mealTimesConfig = { Desayuno: { start: "06:00", end: "11:00" }, Almuerzo: { start: "11:00", end: "16:00" }, Cena: { start: "16:00", end: "22:00" } };
let deliveryZoneConfig = { enabled: false, address: '', carreraFrom: '', carreraTo: '', calleFrom: '', calleTo: '' };
let brandingConfig = {};
let usersData = [];
let n8nConfig = { apiKey: "" };
let ordersData = [];
let notifyConfig = { resendApiKey: "", ownerEmail: "" };
let cartData = []; // { key, dishId, name, price(number), cantidad, tipo:'principal'|'acompanamiento', parentKey, day }
let cartExpanded = false;
// 'semanal' = horario por día (el de siempre) · 'unico' = un solo menú fijo,
// todos los días igual (independiente del horario semanal, no lo borra).
let menuMode = 'semanal';
// Igual que scheduleData pero SIN día -- vive aparte para que activar/desactivar
// "menú único" nunca toque ni borre el horario semanal ya armado.
let singleMenuSchedule = [];
function nombreDiaHoy() {
  const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  return dias[new Date().getDay()];
}
// Fecha de hoy en la zona horaria del restaurante (America/Bogota), como
// "YYYY-MM-DD" -- se usa para saber si el stock de un platillo ya cruzó la
// medianoche y toca reiniciarlo a su valor definido.
function fechaHoyBogota() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}
// El stock de un platillo (schedule o menú único) se define UNA vez
// (stockDefinido) y cada día se reinicia solo a ese valor -- así el dueño no
// tiene que acordarse de resetearlo a mano cada mañana. Devuelve true si
// cambió algo (para saber si hace falta guardar).
function reiniciarStockDiario(filas) {
  const hoy = fechaHoyBogota();
  let cambio = false;
  filas.forEach(f => {
    if (f.stockDefinido !== null && f.stockDefinido !== undefined && f.stockResetDate !== hoy) {
      f.stock = f.stockDefinido;
      f.stockResetDate = hoy;
      cambio = true;
    }
  });
  return cambio;
}

let isPublicTakeoutActive = false;
let pendingDeleteAction = null;

// PHP no distingue entre un objeto vacío {} y un arreglo vacío [], así
// que al guardar/leer un objeto de configuración vacío puede volver
// convertido en []. Esta función se asegura de que siempre trabajemos
// con un objeto real, nunca con un arreglo "disfrazado" de objeto.
function ensureObject(val, fallback) {
  if (val && typeof val === 'object' && !Array.isArray(val)) return val;
  return fallback;
}

async function loadAllData() {
  try {
    const response = await fetch('api/load-data.php?_=' + Date.now(), { cache: 'no-store' });
    const data = await response.json();
    categoriesData = data.categories || [];
    if (categoriesData.length === 0) {
      categoriesData = [{ id: 1, name: "Sopas / Sancocho / Caldo" }];
    }
    // Compatibilidad con categorías creadas antes de esta función. Los
    // acompañamientos por defecto (arroz, ensalada, principio a elegir) se
    // configuran UNA vez por categoría (típicamente "Proteína") y aplican a
    // TODOS sus platillos, toda la semana -- así no hay que repetirlo plato
    // por plato.
    categoriesData.forEach(c => {
      if (!c.mealTime) c.mealTime = 'Almuerzo';
      if (c.deliveryEnabled === undefined) c.deliveryEnabled = true;
      if (c.role === undefined) c.role = '';
      if (!Array.isArray(c.defaultAccompaniments)) c.defaultAccompaniments = [];
      if (c.incluyePrincipio === undefined) c.incluyePrincipio = false;
      if (c.principioOpcional === undefined) c.principioOpcional = true;
      if (c.principioDescuento === undefined) c.principioDescuento = 0;
    });
    dishesData = data.dishes || [];
    scheduleData = data.schedule || [];
    scheduleData.forEach(s => {
      if (s.stockDefinido === undefined) s.stockDefinido = s.stock ?? null;
      if (s.stockResetDate === undefined) s.stockResetDate = fechaHoyBogota();
    });
    menuMode = data.menuMode === 'unico' ? 'unico' : 'semanal';
    singleMenuSchedule = Array.isArray(data.singleMenuSchedule) ? data.singleMenuSchedule : [];
    singleMenuSchedule.forEach(s => {
      if (s.stockDefinido === undefined) s.stockDefinido = s.stock ?? null;
      if (s.stockResetDate === undefined) s.stockResetDate = fechaHoyBogota();
    });
    takeoutConfig = ensureObject(data.takeoutConfig, { enabled: false, fee: 0, soupSizeFees: { Normal: 0, Grande: 0 } });
    takeoutConfig.soupSizeFees = ensureObject(takeoutConfig.soupSizeFees, { Normal: 0, Grande: 0 });
    mealTimesConfig = ensureObject(data.mealTimesConfig, { Desayuno: { start: "06:00", end: "11:00" }, Almuerzo: { start: "11:00", end: "16:00" }, Cena: { start: "16:00", end: "22:00" } });
    deliveryZoneConfig = ensureObject(data.deliveryZoneConfig, { enabled: false, address: '', carreraFrom: '', carreraTo: '', calleFrom: '', calleTo: '' });
    brandingConfig = ensureObject(data.brandingConfig, {});
    usersData = data.usersData || [];
    n8nConfig = ensureObject(data.n8nConfig, { apiKey: "" });
    ordersData = data.ordersData || [];
    notifyConfig = ensureObject(data.notifyConfig, { resendApiKey: "", ownerEmail: "" });

    // Reinicio diario de stock -- si algún platillo (horario semanal o menú
    // único) cruzó la medianoche desde la última vez que se consultó, vuelve
    // solo a su "stock definido". Si algo cambió, se guarda de una vez para
    // que quede al día en el servidor (lo vería cualquiera que consulte
    // después: otro cliente, el bot, N8N).
    const cambioSemanal = reiniciarStockDiario(scheduleData);
    const cambioUnico = reiniciarStockDiario(singleMenuSchedule);
    if (cambioSemanal || cambioUnico) await saveAllData();
  } catch (error) { console.error('Error cargando:', error); }
}

async function saveAllData() {
  const payload = { categories: categoriesData, dishes: dishesData, schedule: scheduleData, menuMode, singleMenuSchedule, takeoutConfig, mealTimesConfig, deliveryZoneConfig, brandingConfig, usersData, n8nConfig, ordersData, notifyConfig };
  try {
    const response = await fetch('api/save-data.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!result.success) {
      console.error('Error guardando:', result.error);
      alert('⚠️ No se pudo guardar en el servidor: ' + (result.error || 'error desconocido') + '\nRevisa los permisos de la carpeta /data en tu servidor.');
    }
    return result.success;
  } catch (error) {
    console.error('Error al guardar:', error);
    alert('⚠️ No se pudo conectar con el servidor para guardar los cambios. Revisa tu conexión o la configuración del servidor.');
    return false;
  }
}

async function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);
  const response = await fetch('api/upload-image.php', { method: 'POST', body: formData });
  const result = await response.json();
  return result.success ? result.url : null;
}

function formatCurrency(input) {
  let digits = String(input).replace(/\D/g, "");
  return `$ ${parseInt(digits || 0, 10).toLocaleString('es-CO')}`;
}
function parseCurrencyNumber(formattedString) { return parseInt(String(formattedString).replace(/\D/g, ""), 10) || 0; }
function getCurrentDayName() { return ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"][new Date().getDay()]; }

function timeToMinutes(t) { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); }
function getAutoMealTime() {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  for (const key of ['Desayuno', 'Almuerzo', 'Cena']) {
    const range = mealTimesConfig[key];
    if (!range || !range.start || !range.end) continue;
    const start = timeToMinutes(range.start);
    const end = timeToMinutes(range.end);
    if (start <= end) {
      if (nowMin >= start && nowMin < end) return key;
    } else {
      // Franja que cruza la medianoche (ej. Cena 18:00 a 02:00)
      if (nowMin >= start || nowMin < end) return key;
    }
  }
  return 'Almuerzo';
}

function applyBrandingSettings() {
  const root = document.documentElement;
  root.style.setProperty('--accent', brandingConfig.accentColor || '#f59e0b');
  root.style.setProperty('--title-color', brandingConfig.titleColor || '#f59e0b');
  root.style.setProperty('--bg', brandingConfig.bgColor || '#0f172a');
  root.style.setProperty('--card-bg', brandingConfig.cardBgColor || '#1e293b');
  root.style.setProperty('--desc-color', brandingConfig.descColor || '#94a3b8');
  root.style.setProperty('--title-font', brandingConfig.titleFont || 'system-ui, sans-serif');
  root.style.setProperty('--body-font', brandingConfig.bodyFont || 'system-ui, sans-serif');

  if (brandingConfig.bgImageUrl) document.body.style.backgroundImage = `url('${brandingConfig.bgImageUrl}')`;
  else document.body.style.backgroundImage = 'none';

  document.getElementById('bg-overlay').classList.toggle('hidden', !(brandingConfig.bgOverlayEnabled !== false && brandingConfig.bgImageUrl));

  const brandTitle = document.getElementById('brand-title');
  const brandLogo = document.getElementById('brand-logo');
  if (brandingConfig.logoUrl) { brandLogo.src = brandingConfig.logoUrl; brandLogo.classList.remove('hidden'); brandTitle.classList.add('hidden'); }
  else { brandTitle.textContent = brandingConfig.name || "Restaurante"; brandTitle.classList.remove('hidden'); brandLogo.classList.add('hidden'); }

  const whatsappFloatBtn = document.getElementById('whatsapp-float-btn');
  if (brandingConfig.whatsappNumber) {
    whatsappFloatBtn.href = `https://wa.me/${brandingConfig.whatsappNumber.replace(/\D/g, '')}?text=${encodeURIComponent(brandingConfig.whatsappMessage || "")}`;
    whatsappFloatBtn.classList.remove('hidden');
  } else whatsappFloatBtn.classList.add('hidden');

  const telegramFloatBtn = document.getElementById('telegram-float-btn');
  if (brandingConfig.telegramUrl) { telegramFloatBtn.href = brandingConfig.telegramUrl; telegramFloatBtn.classList.remove('hidden'); }
  else telegramFloatBtn.classList.add('hidden');

  const xFloatBtn = document.getElementById('x-float-btn');
  if (brandingConfig.xUrl) { xFloatBtn.href = brandingConfig.xUrl; xFloatBtn.classList.remove('hidden'); }
  else xFloatBtn.classList.add('hidden');

  const instagramFloatBtn = document.getElementById('instagram-float-btn');
  if (brandingConfig.instagramUrl) { instagramFloatBtn.href = brandingConfig.instagramUrl; instagramFloatBtn.classList.remove('hidden'); }
  else instagramFloatBtn.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadAllData();
  applyBrandingSettings();

  // Detecta automáticamente Desayuno/Almuerzo/Cena según la hora del
  // cliente. El cliente puede cambiarlo manualmente después.
  document.getElementById('public-mealtime-select').value = getAutoMealTime();

  const loginModal = document.getElementById('login-modal');
  const loginForm = document.getElementById('login-form');
  const errorMsg = document.getElementById('error-msg');
  const logoutBtn = document.getElementById('logout-btn');
  const menuView = document.getElementById('menu-view');
  const dashboardView = document.getElementById('dashboard-view');
  const userDisplay = document.getElementById('user-display');
  const navUsersBtn = document.getElementById('nav-users-btn');
  const navN8nBtn = document.getElementById('nav-n8n-btn');
  const navOrdersBtn = document.getElementById('nav-orders-btn');
  const takeoutPublicContainer = document.getElementById('takeout-public-container');
  const publicTakeoutCheckbox = document.getElementById('public-takeout-checkbox');
  const soupSizeSelector = document.getElementById('soup-size-selector');

  document.getElementById('open-login-btn').addEventListener('click', () => loginModal.classList.remove('hidden'));
  document.getElementById('close-modal-btn').addEventListener('click', () => loginModal.classList.add('hidden'));

  document.getElementById('privacy-notice-btn').addEventListener('click', () => document.getElementById('privacy-modal').classList.remove('hidden'));
  document.getElementById('close-privacy-modal-btn').addEventListener('click', () => document.getElementById('privacy-modal').classList.add('hidden'));

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value.trim();
    const user = usersData.find(u => u.email === email && u.password === password);
    
    if (user || (email === SUPREME_ADMIN_EMAIL && password === "1234")) {
      currentUser = email;
      errorMsg.textContent = '';
      loginModal.classList.add('hidden');
      document.getElementById('guest-actions').classList.add('hidden');
      document.getElementById('user-actions').classList.remove('hidden');
      userDisplay.textContent = email;
      menuView.classList.add('hidden');
      dashboardView.classList.remove('hidden');
      
      if (currentUser === SUPREME_ADMIN_EMAIL) {
        navUsersBtn.classList.remove('hidden');
        navN8nBtn.classList.remove('hidden');
        navOrdersBtn.classList.remove('hidden');
      } else {
        navUsersBtn.classList.add('hidden');
        navN8nBtn.classList.add('hidden');
        navOrdersBtn.classList.add('hidden');
      }
      showWelcomeSection();
    } else {
      errorMsg.textContent = 'Credenciales inválidas.';
    }
  });

  logoutBtn.addEventListener('click', () => {
    currentUser = null;
    document.getElementById('guest-actions').classList.remove('hidden');
    document.getElementById('user-actions').classList.add('hidden');
    dashboardView.classList.add('hidden');
    menuView.classList.remove('hidden');
    renderPublicMenu();
  });

  function showWelcomeSection() { ['section-categories', 'section-mealtimes', 'section-customize', 'section-dishes', 'section-schedule', 'section-orders', 'section-n8n', 'section-users'].forEach(id => document.getElementById(id).classList.add('hidden')); document.getElementById('welcome-section').classList.remove('hidden'); }
  function showSection(id) { showWelcomeSection(); document.getElementById('welcome-section').classList.add('hidden'); document.getElementById(id).classList.remove('hidden'); }

  document.getElementById('nav-categories-btn').addEventListener('click', () => { showSection('section-categories'); renderCategoriesSection(); });
  document.getElementById('nav-mealtimes-btn').addEventListener('click', () => { showSection('section-mealtimes'); loadMealTimesFields(); loadDeliveryZoneFields(); });
  document.getElementById('nav-customize-btn').addEventListener('click', () => { showSection('section-customize'); loadCustomizeFields(); });
  document.getElementById('nav-new-dish-btn').addEventListener('click', () => { showSection('section-dishes'); renderDishesSection(); });
  document.getElementById('nav-schedule-btn').addEventListener('click', () => { showSection('section-schedule'); renderScheduleMatrixSection(); loadTakeoutFields(); });
  document.getElementById('nav-orders-btn').addEventListener('click', () => { showSection('section-orders'); renderOrdersSection(); loadNotifyConfigFields(); });
  document.getElementById('nav-n8n-btn').addEventListener('click', () => { showSection('section-n8n'); loadConfigStatus(); });
  document.getElementById('nav-users-btn').addEventListener('click', () => { showSection('section-users'); renderUsersSection(); });

  // El bloque de "con qué viene por defecto" solo tiene sentido para la
  // categoría de Proteína -- se oculta para cualquier otro rol.
  function toggleCategoryProteinaConfig() {
    const esProteina = document.getElementById('category-role-input').value === 'proteina';
    document.getElementById('category-proteina-config').classList.toggle('hidden', !esProteina);
  }
  document.getElementById('category-role-input').addEventListener('change', toggleCategoryProteinaConfig);
  document.getElementById('category-incluye-principio').addEventListener('change', (e) => {
    document.getElementById('category-principio-extra').classList.toggle('hidden', !e.target.checked);
  });

  document.getElementById('create-category-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('edit-category-id').value;
    const name = document.getElementById('category-name-input').value.trim();
    const mealTime = document.getElementById('category-mealtime-input').value;
    const role = document.getElementById('category-role-input').value;
    const deliveryEnabled = document.getElementById('category-delivery-input').checked;
    const exentoEmpaque = document.getElementById('category-exento-input').checked;
    const incluyePrincipio = document.getElementById('category-incluye-principio').checked;
    const principioOpcional = document.getElementById('category-principio-opcional').checked;
    const principioDescuento = Math.max(0, parseInt(document.getElementById('category-principio-descuento').value, 10) || 0);
    const defaultAccompaniments = Array.from(document.querySelectorAll('#category-accompaniments-list .accomp-check:checked')).map(el => {
      const dishId = Number(el.value);
      const opcionalEl = document.querySelector(`#category-accompaniments-list .accomp-opcional[data-for="${dishId}"]`);
      const descuentoEl = document.querySelector(`#category-accompaniments-list .accomp-descuento[data-for="${dishId}"]`);
      return { dishId, opcional: opcionalEl ? opcionalEl.checked : true, descuento: Math.max(0, parseInt(descuentoEl?.value, 10) || 0) };
    });
    if (!name) return;
    const campos = { name, mealTime, role, deliveryEnabled, exentoEmpaque, incluyePrincipio, principioOpcional, principioDescuento, defaultAccompaniments };
    if (editId) {
      const cat = categoriesData.find(c => c.id === Number(editId));
      if (cat) Object.assign(cat, campos);
      await saveAllData();
      renderCategoriesSection();
      renderDishesSection();
      renderPublicMenu();
      resetCategoryForm();
      alert("Categoría actualizada");
    } else {
      categoriesData.push({ id: Date.now(), ...campos });
      await saveAllData();
      renderCategoriesSection();
      renderDishesSection();
      resetCategoryForm();
      alert("Categoría agregada");
    }
  });
  function resetCategoryForm() {
    document.getElementById('create-category-form').reset();
    document.getElementById('edit-category-id').value = '';
    document.getElementById('category-form-title').textContent = 'Crear Nueva Categoría';
    document.getElementById('btn-save-category').textContent = 'Agregar';
    document.getElementById('btn-cancel-edit-category').classList.add('hidden');
    document.getElementById('category-delivery-input').checked = true;
    document.getElementById('category-principio-extra').classList.add('hidden');
    renderCategoryAccompanimentsPicker([]);
    toggleCategoryProteinaConfig();
  }
  window.editCategory = (id) => {
    const cat = categoriesData.find(c => c.id === id);
    if (!cat) return;
    document.getElementById('edit-category-id').value = cat.id;
    document.getElementById('category-name-input').value = cat.name;
    document.getElementById('category-mealtime-input').value = cat.mealTime || 'Almuerzo';
    document.getElementById('category-role-input').value = cat.role || '';
    document.getElementById('category-delivery-input').checked = cat.deliveryEnabled !== false;
    document.getElementById('category-exento-input').checked = !!cat.exentoEmpaque;
    document.getElementById('category-incluye-principio').checked = !!cat.incluyePrincipio;
    document.getElementById('category-principio-opcional').checked = cat.principioOpcional !== false;
    document.getElementById('category-principio-descuento').value = cat.principioDescuento || 0;
    document.getElementById('category-principio-extra').classList.toggle('hidden', !cat.incluyePrincipio);
    renderCategoryAccompanimentsPicker(cat.defaultAccompaniments || []);
    toggleCategoryProteinaConfig();
    document.getElementById('category-form-title').textContent = `Editando: ${cat.name}`;
    document.getElementById('btn-save-category').textContent = 'Actualizar';
    document.getElementById('btn-cancel-edit-category').classList.remove('hidden');
    document.getElementById('create-category-form').scrollIntoView({ behavior: 'smooth' });
  };
  document.getElementById('btn-cancel-edit-category').addEventListener('click', resetCategoryForm);
  window.deleteCategory = async (id) => {
    requestDelete('¿Eliminar categoría y sus platillos?', async () => {
      categoriesData = categoriesData.filter(c => c.id !== id);
      dishesData = dishesData.filter(d => d.categoryId !== id);
      scheduleData = scheduleData.filter(s => dishesData.some(d => d.id === s.dishId));
      await saveAllData();
      renderCategoriesSection();
      renderDishesSection();
      renderPublicMenu();
    });
  };
  window.toggleExentoEmpaque = async (id) => {
    const cat = categoriesData.find(c => c.id === id);
    if (!cat) return;
    cat.exentoEmpaque = !cat.exentoEmpaque;
    await saveAllData();
    renderCategoriesSection();
    renderPublicMenu();
  };
  window.toggleDeliveryEnabled = async (id) => {
    const cat = categoriesData.find(c => c.id === id);
    if (!cat) return;
    cat.deliveryEnabled = !cat.deliveryEnabled;
    await saveAllData();
    renderCategoriesSection();
    renderPublicMenu();
  };
  window.changeCategoryMealTime = async (id, value) => {
    const cat = categoriesData.find(c => c.id === id);
    if (!cat) return;
    cat.mealTime = value;
    await saveAllData();
    renderPublicMenu();
  };
  window.changeCategoryRole = async (id, value) => {
    const cat = categoriesData.find(c => c.id === id);
    if (!cat) return;
    cat.role = value;
    await saveAllData();
    renderDishesSection();
    renderPublicMenu();
  };
  const ROLE_LABELS = { sopa: 'Sopa', principio: 'Principio', proteina: 'Proteína', acompanamiento: 'Acompañamiento' };
  function renderCategoriesSection() {
    // Solo refresca las opciones del picker si el formulario está vacío
    // (creando una nueva categoría) -- si está editando una, no le pises la
    // selección que ya cargó editCategory().
    if (!document.getElementById('edit-category-id').value) {
      renderCategoryAccompanimentsPicker([]);
      toggleCategoryProteinaConfig();
    }
    const list = document.getElementById('categories-management-list');
    list.innerHTML = '';
    categoriesData.forEach(cat => list.innerHTML += `<div class="preview-category">
      <div class="preview-category-header"><h4>${cat.name} (${dishesData.filter(d => d.categoryId === cat.id).length} platillos)</h4><div class="action-btns"><button class="btn-edit-sm" onclick="editCategory(${cat.id})">Editar</button><button class="btn-danger-sm" onclick="deleteCategory(${cat.id})">Eliminar</button></div></div>
      <div class="category-options-row">
        <label class="checkbox-label small-select">Comida:
          <select onchange="changeCategoryMealTime(${cat.id}, this.value)">
            <option value="Desayuno" ${cat.mealTime === 'Desayuno' ? 'selected' : ''}>Desayuno</option>
            <option value="Almuerzo" ${cat.mealTime === 'Almuerzo' ? 'selected' : ''}>Almuerzo</option>
            <option value="Cena" ${cat.mealTime === 'Cena' ? 'selected' : ''}>Cena</option>
          </select>
        </label>
        <label class="checkbox-label small-select">Rol:
          <select onchange="changeCategoryRole(${cat.id}, this.value)">
            <option value="" ${!cat.role ? 'selected' : ''}>Ninguno</option>
            <option value="sopa" ${cat.role === 'sopa' ? 'selected' : ''}>Sopa</option>
            <option value="principio" ${cat.role === 'principio' ? 'selected' : ''}>Principio</option>
            <option value="proteina" ${cat.role === 'proteina' ? 'selected' : ''}>Proteína</option>
            <option value="acompanamiento" ${cat.role === 'acompanamiento' ? 'selected' : ''}>Acompañamiento</option>
          </select>
        </label>
        <label class="checkbox-label"><input type="checkbox" onchange="toggleDeliveryEnabled(${cat.id})" ${cat.deliveryEnabled !== false ? 'checked' : ''}> Disponible a domicilio</label>
        <label class="checkbox-label"><input type="checkbox" onchange="toggleExentoEmpaque(${cat.id})" ${cat.exentoEmpaque ? 'checked' : ''}> Exenta de cargo de empaque/domicilio</label>
      </div>
    </div>`);
  }

  function loadMealTimesFields() {
    document.getElementById('mealtime-desayuno-start').value = mealTimesConfig.Desayuno?.start || '06:00';
    document.getElementById('mealtime-desayuno-end').value = mealTimesConfig.Desayuno?.end || '11:00';
    document.getElementById('mealtime-almuerzo-start').value = mealTimesConfig.Almuerzo?.start || '11:00';
    document.getElementById('mealtime-almuerzo-end').value = mealTimesConfig.Almuerzo?.end || '16:00';
    document.getElementById('mealtime-cena-start').value = mealTimesConfig.Cena?.start || '16:00';
    document.getElementById('mealtime-cena-end').value = mealTimesConfig.Cena?.end || '22:00';
  }
  document.getElementById('mealtimes-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    mealTimesConfig = {
      Desayuno: { start: document.getElementById('mealtime-desayuno-start').value || '06:00', end: document.getElementById('mealtime-desayuno-end').value || '11:00' },
      Almuerzo: { start: document.getElementById('mealtime-almuerzo-start').value || '11:00', end: document.getElementById('mealtime-almuerzo-end').value || '16:00' },
      Cena: { start: document.getElementById('mealtime-cena-start').value || '16:00', end: document.getElementById('mealtime-cena-end').value || '22:00' }
    };
    await saveAllData();
    alert("Franjas horarias guardadas");
  });

  function loadDeliveryZoneFields() {
    document.getElementById('delivery-zone-enable-checkbox').checked = !!deliveryZoneConfig.enabled;
    document.getElementById('delivery-zone-address-input').value = deliveryZoneConfig.address || '';
    document.getElementById('delivery-zone-carrera-from-input').value = deliveryZoneConfig.carreraFrom ?? '';
    document.getElementById('delivery-zone-carrera-to-input').value = deliveryZoneConfig.carreraTo ?? '';
    document.getElementById('delivery-zone-calle-from-input').value = deliveryZoneConfig.calleFrom ?? '';
    document.getElementById('delivery-zone-calle-to-input').value = deliveryZoneConfig.calleTo ?? '';
  }
  document.getElementById('delivery-zone-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    deliveryZoneConfig = {
      enabled: document.getElementById('delivery-zone-enable-checkbox').checked,
      address: document.getElementById('delivery-zone-address-input').value.trim(),
      carreraFrom: document.getElementById('delivery-zone-carrera-from-input').value.trim(),
      carreraTo: document.getElementById('delivery-zone-carrera-to-input').value.trim(),
      calleFrom: document.getElementById('delivery-zone-calle-from-input').value.trim(),
      calleTo: document.getElementById('delivery-zone-calle-to-input').value.trim()
    };
    await saveAllData();
    alert("Zona de domicilio guardada (solo visible para la API)");
  });

  function loadCustomizeFields() {
    document.getElementById('restaurant-name-input').value = brandingConfig.name || "";
    document.getElementById('restaurant-logo-input').value = brandingConfig.logoUrl || "";
    document.getElementById('whatsapp-number-input').value = brandingConfig.whatsappNumber || "";
    document.getElementById('whatsapp-message-input').value = brandingConfig.whatsappMessage || "";
    document.getElementById('telegram-url-input').value = brandingConfig.telegramUrl || "";
    document.getElementById('x-url-input').value = brandingConfig.xUrl || "";
    document.getElementById('instagram-url-input').value = brandingConfig.instagramUrl || "";
    document.getElementById('bg-image-url-input').value = brandingConfig.bgImageUrl || "";
    document.getElementById('bg-overlay-checkbox').checked = brandingConfig.bgOverlayEnabled !== false;
    document.getElementById('title-font-select').value = brandingConfig.titleFont || "system-ui, sans-serif";
    document.getElementById('body-font-select').value = brandingConfig.bodyFont || "system-ui, sans-serif";
    document.getElementById('accent-color-input').value = brandingConfig.accentColor || "#f59e0b";
    document.getElementById('title-color-input').value = brandingConfig.titleColor || "#f59e0b";
    document.getElementById('bg-color-input').value = brandingConfig.bgColor || "#0f172a";
    document.getElementById('card-bg-color-input').value = brandingConfig.cardBgColor || "#1e293b";
    document.getElementById('desc-color-input').value = brandingConfig.descColor || "#94a3b8";
  }

  document.getElementById('customize-identity-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    brandingConfig.name = document.getElementById('restaurant-name-input').value;
    let url = document.getElementById('restaurant-logo-input').value;
    if (document.getElementById('restaurant-logo-file').files[0]) url = await uploadImage(document.getElementById('restaurant-logo-file').files[0]);
    if (url) brandingConfig.logoUrl = url;
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('customize-whatsapp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    brandingConfig.whatsappNumber = document.getElementById('whatsapp-number-input').value;
    brandingConfig.whatsappMessage = document.getElementById('whatsapp-message-input').value;
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('customize-social-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    brandingConfig.telegramUrl = document.getElementById('telegram-url-input').value.trim();
    brandingConfig.xUrl = document.getElementById('x-url-input').value.trim();
    brandingConfig.instagramUrl = document.getElementById('instagram-url-input').value.trim();
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('customize-bg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let url = document.getElementById('bg-image-url-input').value;
    if (document.getElementById('bg-image-file').files[0]) url = await uploadImage(document.getElementById('bg-image-file').files[0]);
    brandingConfig.bgImageUrl = url;
    brandingConfig.bgOverlayEnabled = document.getElementById('bg-overlay-checkbox').checked;
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('customize-fonts-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    brandingConfig.titleFont = document.getElementById('title-font-select').value;
    brandingConfig.bodyFont = document.getElementById('body-font-select').value;
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('customize-colors-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    brandingConfig.accentColor = document.getElementById('accent-color-input').value;
    brandingConfig.titleColor = document.getElementById('title-color-input').value;
    brandingConfig.bgColor = document.getElementById('bg-color-input').value;
    brandingConfig.cardBgColor = document.getElementById('card-bg-color-input').value;
    brandingConfig.descColor = document.getElementById('desc-color-input').value;
    await saveAllData(); applyBrandingSettings();
  });

  document.getElementById('remove-logo-btn').addEventListener('click', async () => {
    brandingConfig.logoUrl = '';
    document.getElementById('restaurant-logo-input').value = '';
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('remove-whatsapp-btn').addEventListener('click', async () => {
    brandingConfig.whatsappNumber = '';
    brandingConfig.whatsappMessage = '';
    document.getElementById('whatsapp-number-input').value = '';
    document.getElementById('whatsapp-message-input').value = '';
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('remove-social-btn').addEventListener('click', async () => {
    brandingConfig.telegramUrl = '';
    brandingConfig.xUrl = '';
    brandingConfig.instagramUrl = '';
    document.getElementById('telegram-url-input').value = '';
    document.getElementById('x-url-input').value = '';
    document.getElementById('instagram-url-input').value = '';
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('remove-bg-btn').addEventListener('click', async () => {
    brandingConfig.bgImageUrl = '';
    document.getElementById('bg-image-url-input').value = '';
    document.getElementById('bg-image-file').value = '';
    await saveAllData(); applyBrandingSettings();
  });
  document.getElementById('reset-colors-btn').addEventListener('click', async () => {
    brandingConfig.accentColor = '#f59e0b';
    brandingConfig.titleColor = '#f59e0b';
    brandingConfig.bgColor = '#0f172a';
    brandingConfig.cardBgColor = '#1e293b';
    brandingConfig.descColor = '#94a3b8';
    loadCustomizeFields();
    await saveAllData(); applyBrandingSettings();
  });

  document.getElementById('create-dish-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-dish-id').value;
    const dishData = {
      categoryId: Number(document.getElementById('select-category').value),
      name: document.getElementById('dish-name').value.trim(),
      desc: document.getElementById('dish-desc').value.trim(),
      price: formatCurrency(document.getElementById('dish-price').value),
    };

    const imageFile = document.getElementById('dish-image-file').files[0];
    const removeImage = document.getElementById('dish-image-remove-checkbox').checked;
    if (imageFile) {
      const url = await uploadImage(imageFile);
      if (url) dishData.imageUrl = url;
    } else if (removeImage) {
      dishData.imageUrl = '';
    }

    if (id) {
      const dish = dishesData.find(d => d.id === Number(id));
      Object.assign(dish, dishData);
    } else {
      dishesData.push({ id: Date.now(), ...dishData });
    }
    await saveAllData();
    document.getElementById('edit-dish-id').value = '';
    document.getElementById('btn-save-dish').textContent = 'Guardar';
    document.getElementById('dish-image-file').value = '';
    document.getElementById('dish-image-remove-checkbox').checked = false;
    document.getElementById('dish-image-preview-wrap').classList.add('hidden');
    renderDishesSection();
    renderPublicMenu();
  });
  window.editDish = (id) => {
    const dish = dishesData.find(d => d.id === id);
    document.getElementById('edit-dish-id').value = dish.id;
    document.getElementById('select-category').value = dish.categoryId;
    document.getElementById('dish-name').value = dish.name;
    document.getElementById('dish-desc').value = dish.desc || "";
    document.getElementById('dish-price').value = dish.price.replace(/\D/g, "");
    document.getElementById('dish-image-file').value = '';
    document.getElementById('dish-image-remove-checkbox').checked = false;
    const previewWrap = document.getElementById('dish-image-preview-wrap');
    if (dish.imageUrl) {
      document.getElementById('dish-image-preview').src = dish.imageUrl;
      previewWrap.classList.remove('hidden');
    } else {
      previewWrap.classList.add('hidden');
    }
    document.getElementById('btn-save-dish').textContent = 'Actualizar';
    document.getElementById('btn-cancel-edit-dish').classList.remove('hidden');
    showSection('section-dishes');
  };
  document.getElementById('btn-cancel-edit-dish').addEventListener('click', () => {
    document.getElementById('edit-dish-id').value = '';
    document.getElementById('btn-save-dish').textContent = 'Guardar';
    document.getElementById('btn-cancel-edit-dish').classList.add('hidden');
    document.getElementById('dish-image-file').value = '';
    document.getElementById('dish-image-remove-checkbox').checked = false;
    document.getElementById('dish-image-preview-wrap').classList.add('hidden');
  });
  window.deleteDish = (id) => {
    requestDelete('¿Eliminar platillo?', async () => {
      dishesData = dishesData.filter(d => d.id !== id);
      scheduleData = scheduleData.filter(s => s.dishId !== id);
      singleMenuSchedule = singleMenuSchedule.filter(s => s.dishId !== id);
      await saveAllData();
      renderDishesSection();
      renderPublicMenu();
    });
  };
  // selectedAccompaniments: [{ dishId, opcional, descuento }] -- se usa para
  // configurar, UNA sola vez por categoría (ej. "Proteína"), con qué viene
  // por defecto CUALQUIER platillo de esa categoría (ver renderMenuModeUI...
  // en realidad ver el bloque de categorías más abajo).
  function renderCategoryAccompanimentsPicker(selectedAccompaniments) {
    const wrap = document.getElementById('category-accompaniments-list');
    if (!wrap) return;
    const acompCatIds = categoriesData.filter(c => c.role === 'acompanamiento').map(c => c.id);
    const opciones = dishesData.filter(d => acompCatIds.includes(d.categoryId));
    if (opciones.length === 0) {
      wrap.innerHTML = '<p class="text-muted">Sin platillos en categorías con rol "Acompañamiento" todavía. Créalos primero.</p>';
      return;
    }
    wrap.innerHTML = opciones.map(d => {
      const actual = selectedAccompaniments.find(a => a.dishId === d.id);
      const marcado = !!actual;
      const opcional = actual ? actual.opcional !== false : true;
      const descuento = actual?.descuento || 0;
      return `<div class="accomp-picker-row">
        <label class="checkbox-label"><input type="checkbox" class="accomp-check" value="${d.id}" onchange="toggleAccompPickerRow(this)" ${marcado ? 'checked' : ''}> ${d.name}</label>
        <span class="accomp-picker-extra" style="${marcado ? '' : 'display:none;'}">
          <label class="text-muted">Opcional (el cliente lo puede quitar) <input type="checkbox" class="accomp-opcional" data-for="${d.id}" ${opcional ? 'checked' : ''}></label>
          <label class="text-muted">Descuento si lo quita <input type="number" class="accomp-descuento" data-for="${d.id}" min="0" value="${descuento}" style="width:90px"></label>
        </span>
      </div>`;
    }).join('');
  }
  window.toggleAccompPickerRow = (checkbox) => {
    const extra = checkbox.closest('.accomp-picker-row').querySelector('.accomp-picker-extra');
    extra.style.display = checkbox.checked ? '' : 'none';
  };
  function renderDishesSection() {
    const sel = document.getElementById('select-category');
    sel.innerHTML = '<option value="">-- Seleccionar --</option>';
    categoriesData.forEach(cat => sel.innerHTML += `<option value="${cat.id}">${cat.name}</option>`);

    const list = document.getElementById('dishes-management-list');
    list.innerHTML = '';
    if (dishesData.length === 0) { list.innerHTML = '<p class="text-muted">Sin platillos.</p>'; return; }
    dishesData.forEach(dish => {
      const catName = categoriesData.find(c => c.id === dish.categoryId)?.name || "Sin categoría";
      list.innerHTML += `<div class="preview-dish-item"><div>• <strong>${dish.name}</strong> (${catName}) - ${dish.price}</div><div class="action-btns"><button class="btn-edit-sm" onclick="editDish(${dish.id})">Editar</button><button class="btn-danger-sm" onclick="deleteDish(${dish.id})">X</button></div></div>`;
    });
  }

  document.getElementById('schedule-quick-assign-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dishId = Number(document.getElementById('assign-select-dish').value);
    const day = document.getElementById('assign-select-day').value;
    if (!scheduleData.some(s => s.day === day && s.dishId === dishId)) {
      scheduleData.push({ id: Date.now(), day, dishId, available: true, stock: null });
      await saveAllData();
      renderScheduleMatrixSection();
      renderPublicMenu();
    }
  });
  
  window.updateStock = async (scheduleId, value) => {
    const item = scheduleData.find(s => s.id === scheduleId);
    if (item) {
      // Este número es el "stock definido": el máximo del día. Se descuenta
      // con cada pedido y se reinicia solo a este mismo valor cada día nuevo.
      // Nunca se permite negativo.
      const n = value === "" ? null : Math.max(0, parseInt(value) || 0);
      item.stock = n;
      item.stockDefinido = n;
      item.stockResetDate = fechaHoyBogota();
      await saveAllData();
      renderPublicMenu();
    }
  };

  window.toggleAvailable = async (id) => { const item = scheduleData.find(s => s.id === id); item.available = !item.available; await saveAllData(); renderScheduleMatrixSection(); renderPublicMenu(); };
  window.removeSchedule = async (id) => { scheduleData = scheduleData.filter(s => s.id !== id); await saveAllData(); renderScheduleMatrixSection(); renderPublicMenu(); };
  
  function renderScheduleMatrixSection() {
    const sel = document.getElementById('assign-select-dish');
    // Se reconstruyen las opciones (puede haber platillos nuevos), pero se
    // conserva el platillo que estaba elegido -- así, después de darle
    // "Agregar al Horario", el día y el platillo NO se resetean y se pueden
    // encadenar varias asignaciones seguidas sin volver a elegir cada vez.
    const dishIdPrevio = sel.value;
    sel.innerHTML = '';
    dishesData.forEach(d => sel.innerHTML += `<option value="${d.id}">${d.name}</option>`);
    if (dishIdPrevio && dishesData.some(d => String(d.id) === dishIdPrevio)) sel.value = dishIdPrevio;
    const days = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"];
    const body = document.getElementById('matrix-body');
    body.innerHTML = '';
    categoriesData.forEach(cat => {
      let row = `<tr><td class="matrix-cat-title">${cat.name}</td>`;
      days.forEach(day => {
        let cell = '';
        scheduleData.filter(s => s.day === day && dishesData.find(d => d.id === s.dishId)?.categoryId === cat.id).forEach(sItem => {
          const d = dishesData.find(dish => dish.id === sItem.dishId);
          cell += `<div class="matrix-item-tag ${!sItem.available ? 'sold-out' : ''}">
            <span class="matrix-item-title">${d.name}</span>
            <div class="matrix-item-actions">
              <button class="${sItem.available ? 'btn-toggle-available' : 'btn-toggle-soldout'}" onclick="toggleAvailable(${sItem.id})">${sItem.available ? 'Disponible' : 'Agotado'}</button>
              <div class="stock-input-container"><span class="stock-label">Stock:</span><input type="number" class="stock-input" min="0" value="${sItem.stock ?? ''}" onchange="updateStock(${sItem.id}, this.value)"></div>
              <button class="btn-danger-sm" onclick="removeSchedule(${sItem.id})">X</button>
            </div></div>`;
        });
        row += `<td>${cell || '-'}</td>`;
      });
      body.innerHTML += row + '</tr>';
    });
    renderMenuModeUI();
  }

  // ── Modo de menú: Semanal (horario por día) vs. Único (mismo todos los
  // días) -- cambiar de modo solo cambia cuál de los dos guarda/lee, nunca
  // borra el otro. ──────────────────────────────────────────────────────
  function renderMenuModeUI() {
    document.getElementById('menu-mode-semanal').checked = menuMode === 'semanal';
    document.getElementById('menu-mode-unico').checked = menuMode === 'unico';
    document.getElementById('weekly-schedule-ui').classList.toggle('hidden', menuMode === 'unico');
    document.getElementById('single-menu-ui').classList.toggle('hidden', menuMode !== 'unico');
    if (menuMode === 'unico') renderSingleMenuList();
  }
  document.querySelectorAll('input[name="menu-mode"]').forEach(radio => {
    radio.addEventListener('change', async (e) => {
      menuMode = e.target.value === 'unico' ? 'unico' : 'semanal';
      await saveAllData();
      renderMenuModeUI();
      renderPublicMenu();
    });
  });

  document.getElementById('single-menu-assign-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sel = document.getElementById('single-assign-select-dish');
    const dishId = Number(sel.value);
    if (!singleMenuSchedule.some(s => s.dishId === dishId)) {
      singleMenuSchedule.push({ id: Date.now(), dishId, available: true, stock: null, stockDefinido: null, stockResetDate: fechaHoyBogota() });
      await saveAllData();
      renderSingleMenuList();
      renderPublicMenu();
    }
  });

  window.updateSingleStock = async (id, value) => {
    const item = singleMenuSchedule.find(s => s.id === id);
    if (item) {
      const n = value === "" ? null : Math.max(0, parseInt(value) || 0);
      item.stock = n;
      item.stockDefinido = n;
      item.stockResetDate = fechaHoyBogota();
      await saveAllData();
      renderPublicMenu();
    }
  };
  window.toggleSingleAvailable = async (id) => { const item = singleMenuSchedule.find(s => s.id === id); item.available = !item.available; await saveAllData(); renderSingleMenuList(); renderPublicMenu(); };
  window.removeSingleSchedule = async (id) => { singleMenuSchedule = singleMenuSchedule.filter(s => s.id !== id); await saveAllData(); renderSingleMenuList(); renderPublicMenu(); };

  function renderSingleMenuList() {
    const sel = document.getElementById('single-assign-select-dish');
    const dishIdPrevio = sel.value;
    sel.innerHTML = '';
    dishesData.forEach(d => sel.innerHTML += `<option value="${d.id}">${d.name}</option>`);
    if (dishIdPrevio && dishesData.some(d => String(d.id) === dishIdPrevio)) sel.value = dishIdPrevio;

    const list = document.getElementById('single-menu-list');
    if (singleMenuSchedule.length === 0) { list.innerHTML = '<p class="text-muted">Sin platillos en el menú único todavía.</p>'; return; }
    list.innerHTML = categoriesData.map(cat => {
      const items = singleMenuSchedule.filter(s => dishesData.find(d => d.id === s.dishId)?.categoryId === cat.id);
      if (items.length === 0) return '';
      const filas = items.map(sItem => {
        const d = dishesData.find(dish => dish.id === sItem.dishId);
        return `<div class="matrix-item-tag ${!sItem.available ? 'sold-out' : ''}">
          <span class="matrix-item-title">${d.name}</span>
          <div class="matrix-item-actions">
            <button class="${sItem.available ? 'btn-toggle-available' : 'btn-toggle-soldout'}" onclick="toggleSingleAvailable(${sItem.id})">${sItem.available ? 'Disponible' : 'Agotado'}</button>
            <div class="stock-input-container"><span class="stock-label">Stock:</span><input type="number" class="stock-input" min="0" value="${sItem.stock ?? ''}" onchange="updateSingleStock(${sItem.id}, this.value)"></div>
            <button class="btn-danger-sm" onclick="removeSingleSchedule(${sItem.id})">X</button>
          </div></div>`;
      }).join('');
      return `<div class="preview-category"><h4>${cat.name}</h4>${filas}</div>`;
    }).join('');
  }

  function loadTakeoutFields() {
    document.getElementById('takeout-enable-checkbox').checked = !!takeoutConfig.enabled;
    document.getElementById('takeout-fee-input').value = takeoutConfig.fee || '';
    document.getElementById('soup-fee-normal-input').value = takeoutConfig.soupSizeFees?.Normal || '';
    document.getElementById('soup-fee-grande-input').value = takeoutConfig.soupSizeFees?.Grande || '';
  }

  // Ya no genera/guarda la key en data.json (se leía sin protección desde
  // api/load-data.php) -- solo sugiere un valor al vuelo para que el dueño lo
  // copie y lo pegue ÉL MISMO como variable de entorno N8N_API_KEY en su
  // hosting. Nunca toca el servidor.
  document.getElementById('generate-n8n-key-btn').addEventListener('click', () => {
    const sugerida = 'n8n_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    document.getElementById('n8n-suggested-key').value = sugerida;
    document.getElementById('n8n-key-suggestion').classList.remove('hidden');
  });

  // Estado (configurada o no) de las llaves, sin exponer su valor real.
  async function loadConfigStatus() {
    try {
      const res = await fetch('api/config-status.php');
      const status = await res.json();
      const resendBadge = document.getElementById('resend-status-badge');
      const n8nBadge = document.getElementById('n8n-status-badge');
      if (resendBadge) {
        resendBadge.textContent = status.resendConfigured ? '✅ Configurada' : '⚠️ Falta configurar';
        resendBadge.className = status.resendConfigured ? 'badge-stock' : 'badge-soldout';
      }
      if (n8nBadge) {
        n8nBadge.textContent = status.n8nConfigured ? '✅ Configurada' : '⚠️ Falta configurar';
        n8nBadge.className = status.n8nConfigured ? 'badge-stock' : 'badge-soldout';
      }
      // Limpieza de una sola vez: si la variable de entorno YA está puesta y
      // todavía queda la llave vieja guardada en data.json (de antes de este
      // cambio), la borra -- así deja de viajar en la respuesta pública de
      // load-data.php.
      let necesitaLimpiar = false;
      if (status.resendConfigured && notifyConfig.resendApiKey) { notifyConfig.resendApiKey = ''; necesitaLimpiar = true; }
      if (status.n8nConfigured && n8nConfig.apiKey) { n8nConfig.apiKey = ''; necesitaLimpiar = true; }
      if (necesitaLimpiar) await saveAllData();
    } catch { /* si falla, el badge se queda en "Verificando…" */ }
  }

  document.getElementById('create-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('new-user-email').value.trim();
    const pass = document.getElementById('new-user-password').value.trim();
    if (email && pass) {
      usersData.push({ email, password: pass });
      await saveAllData();
      renderUsersSection();
      alert("Usuario creado");
    }
  });
  window.deleteUser = async (email) => {
    requestDelete(`¿Eliminar usuario ${email}?`, async () => {
      usersData = usersData.filter(u => u.email !== email);
      await saveAllData();
      renderUsersSection();
    });
  };
  function renderUsersSection() {
    const list = document.getElementById('users-management-list');
    list.innerHTML = '';
    usersData.forEach(u => list.innerHTML += `<div class="preview-dish-item"><div>• ${u.email}</div><button class="btn-danger-sm" onclick="deleteUser('${u.email}')">X</button></div>`);
  }

  document.getElementById('cancel-delete-btn').addEventListener('click', () => { document.getElementById('delete-modal').classList.add('hidden'); pendingDeleteAction = null; });
  document.getElementById('confirm-delete-btn').addEventListener('click', () => { if (pendingDeleteAction) pendingDeleteAction(); document.getElementById('delete-modal').classList.add('hidden'); pendingDeleteAction = null; });
  function requestDelete(msg, action) { document.getElementById('delete-modal-msg').textContent = msg; pendingDeleteAction = action; document.getElementById('delete-modal').classList.remove('hidden'); }

  document.getElementById('public-day-select').addEventListener('change', renderPublicMenu);
  document.getElementById('public-mealtime-select').addEventListener('change', renderPublicMenu);

  publicTakeoutCheckbox.addEventListener('change', (e) => { 
    isPublicTakeoutActive = e.target.checked; 
    if (isPublicTakeoutActive && takeoutConfig.enabled) {
      soupSizeSelector.classList.remove('hidden');
    } else {
      soupSizeSelector.classList.add('hidden');
      document.getElementById('soup-size-select').value = 'Normal';
    }
    renderPublicMenu(); 
  });

  document.getElementById('soup-size-select').addEventListener('change', renderPublicMenu);

  document.getElementById('takeout-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    takeoutConfig.enabled = document.getElementById('takeout-enable-checkbox').checked;
    takeoutConfig.fee = parseCurrencyNumber(document.getElementById('takeout-fee-input').value);
    takeoutConfig.soupSizeFees = {
      Normal: parseCurrencyNumber(document.getElementById('soup-fee-normal-input').value),
      Grande: parseCurrencyNumber(document.getElementById('soup-fee-grande-input').value)
    };
    await saveAllData();
    renderPublicMenu();
    alert("Configuración de para llevar guardada");
  });

  function renderPublicMenu() {
    const list = document.getElementById('public-menu-list');
    const esUnico = menuMode === 'unico';
    const dayFilterContainer = document.querySelector('.day-filter-container');
    if (dayFilterContainer) dayFilterContainer.classList.toggle('hidden', esUnico);
    // Se fuerza a leer el valor del selector, no el día actual
    const day = document.getElementById('public-day-select').value;
    const esHoy = esUnico || day === nombreDiaHoy();
    const selectedMealTime = document.getElementById('public-mealtime-select').value;
    // Menú único: un solo listado, sin filtrar por día. Menú semanal: solo
    // los platillos asignados exactamente al día elegido.
    const items = esUnico ? singleMenuSchedule : scheduleData.filter(s => s.day === day);
    list.innerHTML = esHoy ? '' : `<p class="day-notice">📅 Estás viendo el menú de <strong>${day}</strong> — solo puedes pedir del día de hoy (<strong>${nombreDiaHoy()}</strong>). Cambia el día arriba para poder agregar al pedido.</p>`;

    if (takeoutConfig.enabled) {
      document.getElementById('takeout-public-container').classList.remove('hidden');
      document.getElementById('takeout-fee-display').textContent = `+${formatCurrency(takeoutConfig.fee)}`;
    } else document.getElementById('takeout-public-container').classList.add('hidden');

    categoriesData.filter(cat => (cat.mealTime || 'Almuerzo') === selectedMealTime).forEach(cat => {
      let catDishes = items
        .filter(s => dishesData.find(d => d.id === s.dishId)?.categoryId === cat.id)
        .map(s => ({ ...dishesData.find(d => d.id === s.dishId), available: s.available, stock: s.stock }));

      if (catDishes.length > 0) {
        const isSoupCategory = cat.role === 'sopa' || (!cat.role && cat.name.toLowerCase().includes("sopa"));
        const deliveryBadge = cat.deliveryEnabled === false ? '<span class="delivery-badge no-delivery">🚫 No disponible a domicilio</span>' : '';
        let html = `<h2 class="category-title">${cat.name} ${deliveryBadge}</h2>`;
        catDishes.forEach(dish => {
          if (!dish) return;
          const isSoldOut = dish.available === false || dish.stock === 0;
          let stockBadge = '';
          if (dish.stock > 0) stockBadge = `<span class="badge-stock">Quedan ${dish.stock}</span>`;
          if (dish.stock === 0) stockBadge = '<span class="badge-soldout">AGOTADO</span>';

          let price = dish.price;
          let soupTag = '';
          if (isPublicTakeoutActive && !cat.exentoEmpaque) {
            const selectedSize = document.getElementById('soup-size-select').value;
            const extra = isSoupCategory ? (takeoutConfig.soupSizeFees?.[selectedSize] || 0) : takeoutConfig.fee;
            price = formatCurrency(parseCurrencyNumber(dish.price) + extra);
            if (isSoupCategory) soupTag = `<span class="takeout-badge">Tamaño: ${selectedSize}</span>`;
          }

          const imageHtml = dish.imageUrl ? `<img class="menu-item-image" src="${dish.imageUrl}" alt="${dish.name}">` : '';

          html += `<div class="menu-item ${isSoldOut ? 'sold-out' : ''}">
            <div class="item-info">${imageHtml}<div class="item-info-text"><h3>${dish.name} ${stockBadge}</h3>${dish.desc ? `<p>${dish.desc}</p>` : ''}${soupTag}</div></div>
            <div class="price-container"><span class="price">${price}</span>${(isPublicTakeoutActive && !cat.exentoEmpaque) ? '<span class="takeout-badge">Incluye empaque</span>' : ''}
              ${(!isSoldOut && esHoy) ? `<button type="button" class="btn-add-cart" onclick="addToCart(${dish.id})">+ Agregar</button>` : ''}
            </div>
          </div>`;
        });
        list.innerHTML += `<section class="menu-section">${html}</section>`;
      }
    });
    if (!list.innerHTML) list.innerHTML = '<p class="text-muted" style="text-align:center;">No hay platillos para esta comida en este día.</p>';
  }

  // ── Carrito / pedido directo en la página ──────────────────────────────
  // En modo "único" el día no importa -- se busca en singleMenuSchedule y
  // se ignora el parámetro day. En modo "semanal" funciona como siempre.
  function getMenuItemForDay(dishId, day) {
    const dish = dishesData.find(d => d.id === dishId);
    if (!dish) return null;
    const sched = menuMode === 'unico'
      ? singleMenuSchedule.find(s => s.dishId === dishId)
      : scheduleData.find(s => s.day === day && s.dishId === dishId);
    if (!sched) return null;
    return { id: dish.id, name: dish.name, price: dish.price, scheduleId: sched.id, available: sched.available, stock: sched.stock };
  }
  // role = 'acompanamiento' (Arroz/Ensalada, el "seco") o 'principio' -- cada
  // acompañamiento solo se puede cambiar por otro de SU MISMO tipo (un
  // principio se cambia por otro principio, nunca por arroz).
  function getAccompanimentOptions(day, role) {
    const catIds = categoriesData.filter(c => c.role === role).map(c => c.id);
    return dishesData.filter(d => catIds.includes(d.categoryId)).map(d => {
      const item = getMenuItemForDay(d.id, day);
      return (item && item.available !== false && item.stock !== 0) ? { id: d.id, name: d.name } : null;
    }).filter(Boolean);
  }
  function newCartKey() { return 'c' + Date.now() + Math.random().toString(36).slice(2, 7); }

  // Todo pedido de la página es para llevar/domicilio -- el cargo de
  // "para llevar" ya configurado (takeoutConfig) se suma solo, sin depender
  // del checkbox de vista previa del menú público.
  function esCategoriaSopa(cat) {
    return !!cat && (cat.role === 'sopa' || (!cat.role && (cat.name || '').toLowerCase().includes('sopa')));
  }
  function cargoParaLlevar(cat, tamano) {
    if (!takeoutConfig.enabled || !cat || cat.exentoEmpaque) return 0;
    if (esCategoriaSopa(cat)) return takeoutConfig.soupSizeFees?.[tamano] || 0;
    return takeoutConfig.fee || 0;
  }

  window.addToCart = (dishId) => {
    const day = document.getElementById('public-day-select').value;
    const mealTime = document.getElementById('public-mealtime-select').value;
    const item = getMenuItemForDay(dishId, day);
    if (!item || item.available === false || item.stock === 0) { alert('Ese platillo ya no está disponible.'); return; }
    const dish = dishesData.find(d => d.id === dishId);
    const cat = categoriesData.find(c => c.id === dish?.categoryId);
    // El tamaño (sopas) empieza en Normal y se puede cambiar después, ya en
    // el carrito -- no hace falta elegirlo antes de agregar.
    let tamano = (takeoutConfig.enabled && cat && !cat.exentoEmpaque && esCategoriaSopa(cat)) ? 'Normal' : null;
    const extra = cargoParaLlevar(cat, tamano);
    const key = newCartKey();
    cartData.push({ key, dishId: item.id, scheduleId: item.scheduleId, name: item.name, price: parseCurrencyNumber(item.price) + extra, cantidad: 1, tipo: 'principal', parentKey: null, day, mealTime, tamano, empaqueFee: extra });

    // Con qué viene por defecto: se configura UNA vez por categoría (ej.
    // "Proteína"), no plato por plato -- aplica a cualquier platillo de esa
    // categoría, todos los días. Los acompañamientos siempre son GRATIS, ya
    // están incluidos en el precio del principal.
    if (cat) {
      // Principio a elegir: se agrega solo el primero disponible ese día, y
      // el cliente lo puede cambiar por cualquier otro principio (dropdown
      // en el carrito). "PRINCIPIO" identifica ese puesto de forma fija,
      // aunque el platillo elegido cambie.
      if (cat.incluyePrincipio) {
        const principioCatIds = categoriesData.filter(c => c.role === 'principio').map(c => c.id);
        const principioDisponible = dishesData.find(d => {
          if (!principioCatIds.includes(d.categoryId)) return false;
          const it = getMenuItemForDay(d.id, day);
          return it && it.available !== false && it.stock !== 0;
        });
        if (principioDisponible) {
          const accItem = getMenuItemForDay(principioDisponible.id, day);
          cartData.push({
            key: newCartKey(), dishId: accItem.id, scheduleId: accItem.scheduleId, name: accItem.name,
            price: 0, cantidad: 1, tipo: 'acompanamiento', parentKey: key, day, mealTime, esDefault: true,
            sourceDefaultDishId: 'PRINCIPIO', opcional: cat.principioOpcional !== false, descuentoSiSeQuita: cat.principioDescuento || 0,
          });
        }
      }
      // Acompañamientos fijos (arroz, ensalada...) -- sourceDefaultDishId
      // identifica de forma permanente qué "puesto" ocupa, aunque el
      // cliente lo cambie por otro -- así el servidor sabe, al final, si ese
      // puesto quedó realmente vacío (quitado) o solo cambiado (sigue gratis).
      (cat.defaultAccompaniments || []).forEach(acc => {
        const accItem = getMenuItemForDay(acc.dishId, day);
        if (accItem && accItem.available !== false && accItem.stock !== 0) {
          cartData.push({
            key: newCartKey(), dishId: accItem.id, scheduleId: accItem.scheduleId, name: accItem.name,
            price: 0, cantidad: 1, tipo: 'acompanamiento', parentKey: key, day, mealTime, esDefault: true,
            sourceDefaultDishId: acc.dishId, opcional: !!acc.opcional, descuentoSiSeQuita: acc.descuento || 0,
          });
        }
      });
    }
    renderCart();
  };
  // Cambia el tamaño (Normal/Grande) de una sopa YA agregada al carrito --
  // recalcula el cargo de empaque en el momento, sin tener que quitarla y
  // volver a agregarla.
  window.changeCartTamano = (key, nuevoTamano) => {
    const item = cartData.find(i => i.key === key);
    if (!item) return;
    const dish = dishesData.find(d => d.id === item.dishId);
    const cat = categoriesData.find(c => c.id === dish?.categoryId);
    const nuevoExtra = cargoParaLlevar(cat, nuevoTamano);
    item.price = item.price - (item.empaqueFee || 0) + nuevoExtra;
    item.empaqueFee = nuevoExtra;
    item.tamano = nuevoTamano;
    renderCart();
  };
  window.changeCartQty = (key, delta) => {
    const item = cartData.find(i => i.key === key);
    if (!item) return;
    item.cantidad = Math.max(1, item.cantidad + delta);
    if (item.tipo === 'principal') cartData.filter(i => i.parentKey === key).forEach(a => { a.cantidad = item.cantidad; });
    renderCart();
  };
  window.removeFromCart = (key) => {
    const item = cartData.find(i => i.key === key);
    if (!item) return;
    if (item.tipo === 'principal') {
      cartData = cartData.filter(i => i.key !== key && i.parentKey !== key);
    } else {
      // Si el restaurante configuró un descuento para cuando el cliente
      // quita este acompañamiento, se resta del plato principal al que
      // pertenece (nunca queda en negativo).
      if (item.descuentoSiSeQuita) {
        const padre = cartData.find(i => i.key === item.parentKey);
        if (padre) padre.price = Math.max(0, padre.price - item.descuentoSiSeQuita);
      }
      cartData = cartData.filter(i => i.key !== key);
    }
    renderCart();
  };
  window.swapAccompaniment = (key, newDishIdStr) => {
    if (!newDishIdStr) return;
    const item = cartData.find(i => i.key === key);
    if (!item) return;
    const newItem = getMenuItemForDay(Number(newDishIdStr), item.day);
    if (!newItem) return;
    item.dishId = newItem.id;
    item.scheduleId = newItem.scheduleId;
    item.name = newItem.name;
    item.price = 0; // cambiar un acompañamiento por otro NUNCA cambia el precio -- siempre incluido/gratis
    item.esDefault = false; // ya no es el que venía por defecto, pero sigue gratis igual
    renderCart();
  };
  function renderCart() {
    const panel = document.getElementById('cart-panel');
    const badge = document.getElementById('cart-mini-badge');
    const itemsWrap = document.getElementById('cart-items');
    const total = cartData.reduce((sum, i) => sum + i.price * i.cantidad, 0);

    if (cartData.length === 0) {
      panel.classList.add('hidden');
      badge.classList.add('hidden');
      document.body.classList.remove('cart-expanded');
      itemsWrap.innerHTML = '';
      document.getElementById('cart-total-amount').textContent = formatCurrency(0);
      return;
    }

    if (!cartExpanded) {
      // En reposo: solo la pastillita chiquita, no tapa nada del menú.
      panel.classList.add('hidden');
      badge.classList.remove('hidden');
      document.body.classList.remove('cart-expanded');
      const platos = cartData.filter(i => i.tipo === 'principal').reduce((sum, i) => sum + i.cantidad, 0);
      document.getElementById('cart-mini-count').textContent = platos;
      document.getElementById('cart-mini-total').textContent = formatCurrency(total);
      return;
    }

    // Expandido: se ve el detalle completo.
    badge.classList.add('hidden');
    panel.classList.remove('hidden');
    document.body.classList.add('cart-expanded');
    const principales = cartData.filter(i => i.tipo === 'principal');
    let html = '';
    principales.forEach(p => {
      const acomps = cartData.filter(i => i.parentKey === p.key);
      html += `<div class="cart-item-group">
        <div class="cart-item-row">
          <span class="cart-item-name">${p.cantidad} x ${p.name}</span>
          <span class="cart-item-price">${formatCurrency(p.price * p.cantidad)}</span>
          <div class="cart-item-qty">
            <button type="button" class="btn-secondary-sm" onclick="changeCartQty('${p.key}', -1)">-</button>
            <button type="button" class="btn-secondary-sm" onclick="changeCartQty('${p.key}', 1)">+</button>
            <button type="button" class="btn-danger-sm" onclick="removeFromCart('${p.key}')">X</button>
          </div>
        </div>
        ${p.tamano ? `<div class="cart-accomp-row">
          <label class="text-muted">Tamaño:
            <select onchange="changeCartTamano('${p.key}', this.value)">
              <option value="Normal" ${p.tamano === 'Normal' ? 'selected' : ''}>Normal</option>
              <option value="Grande" ${p.tamano === 'Grande' ? 'selected' : ''}>Grande</option>
            </select>
          </label>
          <span class="takeout-badge">Empaque +${formatCurrency(p.empaqueFee)}</span>
        </div>` : (p.empaqueFee ? `<div class="cart-accomp-row"><span class="takeout-badge">Incluye empaque +${formatCurrency(p.empaqueFee)}</span></div>` : '')}
        ${acomps.map(a => {
          const rol = categoriesData.find(c => c.id === dishesData.find(d => d.id === a.dishId)?.categoryId)?.role || 'acompanamiento';
          const opciones = getAccompanimentOptions(a.day, rol).filter(o => o.id !== a.dishId);
          return `<div class="cart-accomp-row">
          <span>+ ${a.name} <em>(incluido)</em></span>
          <span>Incluido</span>
          <div class="cart-item-qty">
            ${opciones.length ? `<select onchange="swapAccompaniment('${a.key}', this.value)">
              <option value="">Cambiar por...</option>
              ${opciones.map(o => `<option value="${o.id}">${o.name}</option>`).join('')}
            </select>` : ''}
            ${a.opcional ? `<button type="button" class="btn-danger-sm" onclick="removeFromCart('${a.key}')">Quitar</button>` : ''}
          </div>
        </div>`;
        }).join('')}
      </div>`;
    });
    itemsWrap.innerHTML = html;
    document.getElementById('cart-total-amount').textContent = formatCurrency(total);
  }

  document.getElementById('cart-mini-badge').addEventListener('click', () => { cartExpanded = true; renderCart(); });
  document.getElementById('cart-toggle-btn').addEventListener('click', () => { cartExpanded = false; renderCart(); });
  document.getElementById('cart-checkout-btn').addEventListener('click', () => {
    if (cartData.length === 0) return;
    document.getElementById('checkout-error-msg').textContent = '';
    document.getElementById('checkout-modal').classList.remove('hidden');
  });
  document.getElementById('close-checkout-modal-btn').addEventListener('click', () => document.getElementById('checkout-modal').classList.add('hidden'));
  document.getElementById('order-confirmed-close-btn').addEventListener('click', () => document.getElementById('order-confirmed-modal').classList.add('hidden'));

  document.getElementById('checkout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const day = document.getElementById('public-day-select').value;
    const mealTime = document.getElementById('public-mealtime-select').value;
    const payload = {
      day, mealTime,
      cliente: {
        nombre: document.getElementById('checkout-nombre').value.trim(),
        direccion: document.getElementById('checkout-direccion').value.trim(),
        telefono: document.getElementById('checkout-telefono').value.trim(),
        nota: document.getElementById('checkout-nota').value.trim()
      },
      menuMode,
      items: cartData.map(i => ({ dishId: i.dishId, cantidad: i.cantidad, tipo: i.tipo, parentKey: i.parentKey, key: i.key, esDefault: !!i.esDefault, tamano: i.tamano || null, sourceDefaultDishId: i.sourceDefaultDishId || null }))
    };
    try {
      const res = await fetch('api/place-order.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await res.json();
      if (!result.success) {
        document.getElementById('checkout-error-msg').textContent = result.error || 'No se pudo procesar el pedido.';
        await loadAllData();
        renderPublicMenu();
        return;
      }
      document.getElementById('checkout-modal').classList.add('hidden');
      document.getElementById('checkout-form').reset();
      cartData = [];
      renderCart();
      document.getElementById('order-confirmed-msg').textContent = `Tu pedido #${result.orderId} por ${formatCurrency(result.total)} fue recibido. Te lo llevamos pronto.`;
      document.getElementById('order-confirmed-modal').classList.remove('hidden');
      await loadAllData();
      renderPublicMenu();
    } catch (err) {
      document.getElementById('checkout-error-msg').textContent = 'No se pudo conectar con el servidor.';
    }
  });

  // ── Panel admin: Pedidos ────────────────────────────────────────────────
  function loadNotifyConfigFields() {
    document.getElementById('notify-owner-email-input').value = notifyConfig.ownerEmail || '';
    loadConfigStatus();
  }
  document.getElementById('notify-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    // La API Key de Resend ya NO se maneja aquí -- vive como variable de
    // entorno RESEND_API_KEY en el hosting. Solo se guarda el correo.
    notifyConfig.ownerEmail = document.getElementById('notify-owner-email-input').value.trim();
    await saveAllData();
    alert('Correo guardado');
  });
  window.toggleOrderEstado = async (id) => {
    const o = ordersData.find(x => x.id === id);
    if (!o) return;
    o.estado = o.estado === 'entregado' ? 'pendiente' : 'entregado';
    await saveAllData();
    renderOrdersSection();
  };
  window.deleteOrder = async (id) => {
    const o = ordersData.find(x => x.id === id);
    if (!o) return;
    if (!confirm(`¿Borrar el pedido #${id} de ${o.cliente.nombre}? Esto no se puede deshacer.`)) return;
    ordersData = ordersData.filter(x => x.id !== id);
    await saveAllData();
    renderOrdersSection();
  };
  function renderOrdersSection() {
    const list = document.getElementById('orders-management-list');
    if (ordersData.length === 0) { list.innerHTML = '<p class="text-muted">Sin pedidos todavía.</p>'; return; }
    const ordenados = [...ordersData].sort((a, b) => b.createdAt - a.createdAt);
    list.innerHTML = ordenados.map(o => `<div class="preview-category">
      <div class="preview-category-header">
        <h4>#${o.id} — ${o.cliente.nombre} — ${formatCurrency(o.total)} <span class="${o.estado === 'entregado' ? 'badge-stock' : 'badge-soldout'}">${o.estado}</span></h4>
        <div style="display:flex;gap:0.4rem;">
          <button class="btn-primary-sm" onclick="toggleOrderEstado(${o.id})">${o.estado === 'entregado' ? 'Marcar pendiente' : 'Marcar entregado'}</button>
          <button class="btn-danger-sm" onclick="deleteOrder(${o.id})">Borrar</button>
        </div>
      </div>
      <p class="text-muted">${o.day} · ${o.mealTime} · Tel: ${o.cliente.telefono} · Dir: ${o.cliente.direccion}${o.cliente.nota ? ' · Nota: ' + o.cliente.nota : ''}</p>
      <div>${o.items.map(it => `<div class="preview-dish-item"><div>${it.tipo === 'acompanamiento' ? '+ ' : '• '}${it.cantidad} x ${it.name} — ${formatCurrency(it.precioUnitario * it.cantidad)}</div></div>`).join('')}</div>
    </div>`).join('');
  }

  // La página carga mostrando directamente el menú de HOY -- el selector de
  // día sigue abierto y funcional para que el cliente consulte cualquier
  // otro día cuando quiera (cambiarlo dispara renderPublicMenu normal).
  document.getElementById('public-day-select').value = nombreDiaHoy();
  renderPublicMenu();

  // La página se actualiza sola cada 20s (sin recargar) -- así nadie termina
  // pidiendo algo que otro cliente ya agotó mientras la tenía abierta. Solo
  // refresca la vista pública (el carrito y el panel del dueño no se tocan).
  setInterval(async () => {
    if (!document.getElementById('menu-view').classList.contains('hidden')) {
      await loadAllData();
      renderPublicMenu();
    }
  }, 20000);
});
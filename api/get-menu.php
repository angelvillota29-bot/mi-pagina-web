<?php
// Menú completo (o filtrado por día/comida) para integraciones externas: el
// bot de IA (Cloudflare Worker, member/tools.local.ts) y N8N. Requiere
// Authorization: Bearer <API Key> que coincida con la API Key configurada
// (variable de entorno N8N_API_KEY, o data.n8nConfig.apiKey como respaldo).
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
date_default_timezone_set('America/Bogota');

$file = dirname(__DIR__) . '/data/data.json';
if (!file_exists($file)) {
    http_response_code(404);
    echo json_encode(['success' => false, 'error' => 'No hay datos']);
    exit;
}

$data = json_decode(file_get_contents($file), true);

$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? (function_exists('apache_request_headers') ? (apache_request_headers()['Authorization'] ?? '') : '');
$providedKey = '';
if (preg_match('/Bearer\s+(.+)/i', $authHeader, $m)) $providedKey = trim($m[1]);
// La API Key vive de preferencia en la variable de entorno N8N_API_KEY (no en
// el archivo de datos, que se sirve tal cual por load-data.php); si todavía
// no la configuraste ahí, cae al valor guardado en data.json como respaldo.
$validKey = getenv('N8N_API_KEY') ?: ($data['n8nConfig']['apiKey'] ?? '');

if (!$validKey || $providedKey !== $validKey) {
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'API Key inválida']);
    exit;
}

$dishes = $data['dishes'] ?? [];
$categories = $data['categories'] ?? [];
$takeoutConfig = $data['takeoutConfig'] ?? ['enabled' => false, 'fee' => 0, 'soupSizeFees' => ['Normal' => 0, 'Grande' => 0]];
$mealTimesConfig = $data['mealTimesConfig'] ?? [];
$deliveryZoneConfig = $data['deliveryZoneConfig'] ?? ['enabled' => false, 'address' => '', 'carreraFrom' => '', 'carreraTo' => '', 'calleFrom' => '', 'calleTo' => ''];
// 'semanal' (horario por día, el de siempre) o 'unico' (mismo menú todos los
// días -- vive en singleMenuSchedule, aparte, sin borrar el horario semanal).
$menuMode = ($data['menuMode'] ?? 'semanal') === 'unico' ? 'unico' : 'semanal';

$dishesById = [];
foreach ($dishes as $d) { $dishesById[$d['id']] = $d; }
$categoriesById = [];
foreach ($categories as $c) { $categoriesById[$c['id']] = $c; }

// ── Reinicio diario de stock: cada fila con "stockDefinido" definido vuelve
// sola a ese número la primera vez que se consulta en un día nuevo. Se
// guarda de una vez en disco para que quede al día para cualquiera que
// consulte después (otro cliente, N8N, un pedido). ──────────────────────
function reiniciarStockDiario(array &$filas, string $hoyFecha): bool {
    $cambio = false;
    foreach ($filas as &$f) {
        if (array_key_exists('stockDefinido', $f) && $f['stockDefinido'] !== null && ($f['stockResetDate'] ?? null) !== $hoyFecha) {
            $f['stock'] = $f['stockDefinido'];
            $f['stockResetDate'] = $hoyFecha;
            $cambio = true;
        }
    }
    unset($f);
    return $cambio;
}
$hoyFecha = date('Y-m-d');
$schedule = $menuMode === 'unico' ? ($data['singleMenuSchedule'] ?? []) : ($data['schedule'] ?? []);
if (reiniciarStockDiario($schedule, $hoyFecha)) {
    if ($menuMode === 'unico') $data['singleMenuSchedule'] = $schedule;
    else $data['schedule'] = $schedule;
    @file_put_contents($file, json_encode($data));
}

// ── Resolver ?day= ("today" = el día de hoy según el reloj del servidor, o
// un nombre de día literal) -- en modo único no aplica, es el mismo menú
// todos los días, pero se sigue devolviendo bajo la llave del día actual
// para que el resto del contrato (menuByDay[dia]) no cambie. ────────────
$diasSemanaPhp = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
$dayParam = $_GET['day'] ?? null;
$resolvedDay = null;
if ($menuMode === 'unico') {
    $resolvedDay = $diasSemanaPhp[(int) date('w')];
} elseif ($dayParam === 'today') {
    $resolvedDay = $diasSemanaPhp[(int) date('w')];
} elseif ($dayParam) {
    $resolvedDay = $dayParam;
}

// ── Resolver ?mealTime= ("now" = detecta Desayuno/Almuerzo/Cena según la
// hora actual y mealTimesConfig, o un valor literal) ────────────────────
$mealTimeParam = $_GET['mealTime'] ?? null;
$resolvedMealTime = null;
if ($mealTimeParam === 'now') {
    $nowHm = date('H:i');
    foreach ($mealTimesConfig as $nombreComida => $rango) {
        $start = $rango['start'] ?? null;
        $end = $rango['end'] ?? null;
        if ($start && $end && $nowHm >= $start && $nowHm < $end) { $resolvedMealTime = $nombreComida; break; }
    }
    // Si ninguna franja calza con la hora actual, no se filtra por comida
    // (mejor mostrar todo el día que devolver un menú vacío).
} elseif ($mealTimeParam) {
    $resolvedMealTime = $mealTimeParam;
}

function esCategoriaSopa($cat) {
    if (!$cat) return false;
    $role = $cat['role'] ?? '';
    if ($role === 'sopa') return true;
    if ($role === '' && stripos($cat['name'] ?? '', 'sopa') !== false) return true;
    return false;
}

function cargoParaLlevarMenu($cat, $takeoutConfig, $isSoup) {
    if (empty($takeoutConfig['enabled']) || !$cat || !empty($cat['exentoEmpaque'])) return null;
    if ($isSoup) {
        return [
            'Normal' => (int) ($takeoutConfig['soupSizeFees']['Normal'] ?? 0),
            'Grande' => (int) ($takeoutConfig['soupSizeFees']['Grande'] ?? 0),
        ];
    }
    return (int) ($takeoutConfig['fee'] ?? 0);
}

// Con qué viene el plato -- se configura UNA vez por categoría (típicamente
// "Proteína"), no plato por plato: el "seco" fijo (arroz, ensalada) más,
// opcionalmente, un principio a elegir entre los disponibles ese día/modo.
function incluyeDelPlato($cat, $dishesById, $principiosDisponibles) {
    $incluye = [];
    if (!empty($cat['incluyePrincipio']) && $principiosDisponibles) {
        $incluye[] = [
            'nombre' => 'Principio a elegir: ' . implode(', ', $principiosDisponibles),
            'tipo' => 'principio',
            'opcional' => !empty($cat['principioOpcional']),
            'descuentoSiSeQuita' => (int) ($cat['principioDescuento'] ?? 0),
        ];
    }
    foreach (($cat['defaultAccompaniments'] ?? []) as $def) {
        $accDish = $dishesById[$def['dishId']] ?? null;
        if (!$accDish) continue;
        $incluye[] = [
            'nombre' => $accDish['name'],
            'tipo' => 'acompanamiento',
            'opcional' => !empty($def['opcional']),
            'descuentoSiSeQuita' => (int) ($def['descuento'] ?? 0),
        ];
    }
    return $incluye;
}

// ── Días a incluir: solo el resuelto, o los 7 si no se pidió filtro (en
// modo único siempre es solo el día actual, ya resuelto arriba). ────────
$diasAIncluir = $resolvedDay ? [$resolvedDay] : $diasSemanaPhp;

$menuByDay = [];
foreach ($diasAIncluir as $dia) {
    // Principios disponibles ESE día/modo (para describir el "a elegir" con
    // nombres reales, y para que incluyeDelPlato() sepa si de verdad hay
    // alguno disponible).
    $principiosDisponibles = [];
    foreach ($schedule as $s) {
        if ($menuMode === 'semanal' && $s['day'] !== $dia) continue;
        $d = $dishesById[$s['dishId']] ?? null;
        if (!$d) continue;
        $c = $categoriesById[$d['categoryId']] ?? null;
        if (($c['role'] ?? '') !== 'principio') continue;
        $available = $s['available'] ?? true;
        $stock = array_key_exists('stock', $s) ? $s['stock'] : null;
        if ($available === false || $stock === 0) continue;
        $principiosDisponibles[] = $d['name'];
    }

    $items = [];
    foreach ($schedule as $s) {
        // Modo único: una sola lista de platillos, sin día -- se repite
        // igual para cualquier día que se pida. Modo semanal: solo la fila
        // de ESE día.
        if ($menuMode === 'semanal' && $s['day'] !== $dia) continue;
        $dish = $dishesById[$s['dishId']] ?? null;
        if (!$dish) continue;
        $cat = $categoriesById[$dish['categoryId']] ?? null;
        $catMealTime = $cat['mealTime'] ?? 'Almuerzo';
        if ($resolvedMealTime && $catMealTime !== $resolvedMealTime) continue;

        $isSoup = esCategoriaSopa($cat);
        $available = $s['available'] ?? true;
        $stock = array_key_exists('stock', $s) ? $s['stock'] : null;
        $items[] = [
            'scheduleId' => $s['id'],
            'dishId' => $dish['id'],
            'name' => $dish['name'],
            'description' => $dish['desc'] ?? '',
            'category' => $cat['name'] ?? '',
            'mealTime' => $catMealTime,
            'deliveryEnabled' => $cat['deliveryEnabled'] ?? true,
            'price' => $dish['price'] ?? '$ 0',
            'available' => $available,
            'stock' => $stock,
            'isSoldOut' => ($available === false) || ($stock === 0),
            'isSoupCategory' => $isSoup,
            'takeoutExtraCost' => cargoParaLlevarMenu($cat, $takeoutConfig, $isSoup),
            'incluye' => incluyeDelPlato($cat, $dishesById, $principiosDisponibles),
        ];
    }
    $menuByDay[$dia] = $items;
}

echo json_encode([
    'success' => true,
    'appliedFilters' => ['mealTime' => $resolvedMealTime, 'day' => $resolvedDay],
    'menuMode' => $menuMode,
    'takeoutConfig' => $takeoutConfig,
    'deliveryZoneConfig' => $deliveryZoneConfig,
    'menuByDay' => $menuByDay,
]);

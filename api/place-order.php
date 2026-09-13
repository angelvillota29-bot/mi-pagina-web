<?php
// Recibe un pedido armado en la propia página (carrito + checkout), valida
// disponibilidad/stock de CADA platillo (principal y acompañamientos) contra
// el horario (semanal o menú único), descuenta el stock, guarda el pedido en
// ordersData, y si hay notifyConfig configurado, avisa al dueño por correo
// (Resend). No requiere API Key: lo llama el navegador del cliente, igual
// que save-data.php.
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
date_default_timezone_set('America/Bogota');

$file = dirname(__DIR__) . '/data/data.json';
if (!file_exists($file)) {
    http_response_code(404);
    echo json_encode(['success' => false, 'error' => 'No hay datos']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);
if (!$input) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Datos inválidos']);
    exit;
}

$menuMode = ($input['menuMode'] ?? 'semanal') === 'unico' ? 'unico' : 'semanal';
$day = $input['day'] ?? null;
$mealTime = $input['mealTime'] ?? null;
$cliente = $input['cliente'] ?? [];
$items = $input['items'] ?? [];

$nombre = trim($cliente['nombre'] ?? '');
$direccion = trim($cliente['direccion'] ?? '');
$telefono = trim($cliente['telefono'] ?? '');
$nota = trim($cliente['nota'] ?? '');

if (($menuMode === 'semanal' && !$day) || $nombre === '' || $direccion === '' || $telefono === '' || empty($items)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Faltan datos del pedido (nombre, dirección, teléfono o platillos)']);
    exit;
}

// Solo se aceptan pedidos del día de HOY (el reloj del servidor manda, no lo
// que mande el navegador) -- evita pedidos "atrasados" de otro día del menú.
// En modo "menú único" no aplica: es el mismo menú todos los días.
$diasSemanaPhp = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
$hoy = $diasSemanaPhp[(int) date('w')];
if ($menuMode === 'semanal' && $day !== $hoy) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => "Solo se pueden hacer pedidos del día de hoy ($hoy). Cambia el día en la página e intenta de nuevo."]);
    exit;
}

$data = json_decode(file_get_contents($file), true);
$dishes = $data['dishes'] ?? [];
$categories = $data['categories'] ?? [];
$takeoutConfig = $data['takeoutConfig'] ?? ['enabled' => false, 'fee' => 0, 'soupSizeFees' => []];

$dishesById = [];
foreach ($dishes as $d) { $dishesById[$d['id']] = $d; }

$categoriesById = [];
foreach ($categories as $c) { $categoriesById[$c['id']] = $c; }

// ── Reinicio diario de stock (igual que en el navegador): cada fila con un
// "stockDefinido" definido vuelve sola a ese número la primera vez que se
// consulta en un día nuevo -- así el dueño no tiene que resetear a mano. ──
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
reiniciarStockDiario($schedule, $hoyFecha);

// Recalcula el mismo cargo de "para llevar" (empaque del plato + tamaño para
// sopas) que se muestra en la página -- nunca se confía en el precio que
// mande el navegador, todo pedido de la página es para llevar/domicilio.
function cargoParaLlevar($dish, $categoriesById, $takeoutConfig, $tamano) {
    if (empty($takeoutConfig['enabled'])) return 0;
    $cat = $categoriesById[$dish['categoryId']] ?? null;
    if (!$cat || !empty($cat['exentoEmpaque'])) return 0;
    $isSoup = ($cat['role'] ?? null) === 'sopa' || (empty($cat['role']) && stripos($cat['name'] ?? '', 'sopa') !== false);
    if ($isSoup) {
        $t = in_array($tamano, ['Normal', 'Grande'], true) ? $tamano : 'Normal';
        return (int) ($takeoutConfig['soupSizeFees'][$t] ?? 0);
    }
    return (int) ($takeoutConfig['fee'] ?? 0);
}

// Fila de horario por platillo -- en modo semanal, solo la del día pedido;
// en modo único, una sola fila por platillo (no hay día).
$scheduleIdxByDishId = [];
foreach ($schedule as $i => $s) {
    if ($menuMode === 'unico' || $s['day'] === $day) $scheduleIdxByDishId[$s['dishId']] = $i;
}

$resueltos = [];
$total = 0;

foreach ($items as $item) {
    $dishId = $item['dishId'] ?? null;
    $cantidad = max(1, (int)($item['cantidad'] ?? 1));
    if ($dishId === null || !isset($dishesById[$dishId])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Uno de los platillos de tu pedido ya no existe']);
        exit;
    }
    $dish = $dishesById[$dishId];
    if (!isset($scheduleIdxByDishId[$dishId])) {
        http_response_code(409);
        echo json_encode(['success' => false, 'error' => '"' . $dish['name'] . '" ya no está disponible']);
        exit;
    }
    $schedIdx = $scheduleIdxByDishId[$dishId];
    $schedRow = $schedule[$schedIdx];
    if (($schedRow['available'] ?? true) === false) {
        http_response_code(409);
        echo json_encode(['success' => false, 'error' => '"' . $dish['name'] . '" ya no está disponible']);
        exit;
    }
    if ($schedRow['stock'] !== null && $schedRow['stock'] < $cantidad) {
        http_response_code(409);
        echo json_encode(['success' => false, 'error' => 'Ya no queda suficiente "' . $dish['name'] . '" (quedan ' . $schedRow['stock'] . ')']);
        exit;
    }
    $tipo = $item['tipo'] ?? 'principal';
    if ($tipo === 'acompanamiento') {
        // Todo acompañamiento (venga por defecto o el cliente lo haya
        // cambiado por otro) es GRATIS -- ya está incluido en el precio del
        // plato principal, cambiarlo nunca afecta el total.
        $precioUnitario = 0;
    } else {
        $tamano = $item['tamano'] ?? null;
        $precioUnitario = (int) preg_replace('/\D/', '', (string) $dish['price']) + cargoParaLlevar($dish, $categoriesById, $takeoutConfig, $tamano);

        // Si el cliente quitó del todo un acompañamiento opcional (no lo
        // cambió por otro, lo quitó), y ese acompañamiento tiene configurado
        // un descuento, se resta aquí -- calculado por el SERVIDOR contra su
        // propia copia de la config de la CATEGORÍA (se configura una vez por
        // categoría, ej. "Proteína", no plato por plato), nunca confiando en
        // lo que mande el navegador. "sourceDefaultDishId" identifica el
        // puesto (principio/arroz/ensalada) aunque el cliente lo haya
        // cambiado por otro platillo del mismo tipo -- eso NO cuenta como
        // "quitado".
        $itemKey = $item['key'] ?? null;
        $catDelPlato = $categoriesById[$dish['categoryId']] ?? [];
        $puestosOpcionales = [];
        if (!empty($catDelPlato['incluyePrincipio']) && !empty($catDelPlato['principioOpcional']) && !empty($catDelPlato['principioDescuento'])) {
            $puestosOpcionales[] = ['dishId' => 'PRINCIPIO', 'descuento' => (int) $catDelPlato['principioDescuento']];
        }
        foreach (($catDelPlato['defaultAccompaniments'] ?? []) as $def) {
            if (empty($def['opcional']) || empty($def['descuento'])) continue;
            $puestosOpcionales[] = ['dishId' => $def['dishId'], 'descuento' => (int) $def['descuento']];
        }
        foreach ($puestosOpcionales as $puesto) {
            $puestoOcupado = false;
            foreach ($items as $hijo) {
                if (($hijo['tipo'] ?? null) === 'acompanamiento' && ($hijo['parentKey'] ?? null) === $itemKey && ($hijo['sourceDefaultDishId'] ?? null) === $puesto['dishId']) {
                    $puestoOcupado = true;
                    break;
                }
            }
            if (!$puestoOcupado) $precioUnitario = max(0, $precioUnitario - $puesto['descuento']);
        }
    }
    $total += $precioUnitario * $cantidad;
    $resueltos[] = [
        'dishId' => $dishId,
        'scheduleIdx' => $schedIdx,
        'name' => $dish['name'],
        'cantidad' => $cantidad,
        'precioUnitario' => $precioUnitario,
        'tipo' => $tipo,
    ];
}

// Todo válido -- descuenta stock (solo donde el stock se controla; null =
// ilimitado). Nunca queda en negativo.
foreach ($resueltos as $r) {
    if ($schedule[$r['scheduleIdx']]['stock'] !== null) {
        $schedule[$r['scheduleIdx']]['stock'] = max(0, $schedule[$r['scheduleIdx']]['stock'] - $r['cantidad']);
    }
}
if ($menuMode === 'unico') $data['singleMenuSchedule'] = $schedule;
else $data['schedule'] = $schedule;

if (!isset($data['ordersData']) || !is_array($data['ordersData'])) $data['ordersData'] = [];
$orderId = (int) round(microtime(true) * 1000);
$order = [
    'id' => $orderId,
    'createdAt' => $orderId,
    'day' => $menuMode === 'unico' ? 'Menú único' : $day,
    'mealTime' => $mealTime,
    'cliente' => ['nombre' => $nombre, 'direccion' => $direccion, 'telefono' => $telefono, 'nota' => $nota],
    'items' => array_map(function ($r) {
        return ['dishId' => $r['dishId'], 'name' => $r['name'], 'cantidad' => $r['cantidad'], 'precioUnitario' => $r['precioUnitario'], 'tipo' => $r['tipo']];
    }, $resueltos),
    'total' => $total,
    'estado' => 'pendiente',
];
$data['ordersData'][] = $order;

if (file_put_contents($file, json_encode($data)) === false) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'No se pudo guardar el pedido, intenta de nuevo']);
    exit;
}

// Aviso por correo (opcional; si falla, NO se revierte el pedido, ya quedó guardado).
// La API Key de Resend vive de preferencia en la variable de entorno
// RESEND_API_KEY (nunca en data.json, que se sirve tal cual por load-data.php);
// si todavía no la configuraste ahí, cae al valor guardado como respaldo.
$notify = $data['notifyConfig'] ?? [];
$resendKey = getenv('RESEND_API_KEY') ?: ($notify['resendApiKey'] ?? '');
$ownerEmail = $notify['ownerEmail'] ?? '';
if ($resendKey && $ownerEmail) {
    $itemsHtml = '';
    foreach ($order['items'] as $it) {
        $prefix = $it['tipo'] === 'acompanamiento' ? '+ ' : '';
        $itemsHtml .= $prefix . $it['cantidad'] . ' x ' . $it['name'] . ' - $' . number_format($it['precioUnitario'] * $it['cantidad'], 0, ',', '.') . '<br>';
    }
    $html = "<h2>Nuevo pedido #{$orderId}</h2>" .
        "<p><b>Cliente:</b> {$nombre}<br><b>Teléfono:</b> {$telefono}<br><b>Dirección:</b> {$direccion}" .
        ($nota !== '' ? "<br><b>Nota:</b> {$nota}" : '') . '</p>' .
        "<p><b>Día/comida:</b> {$order['day']} / {$mealTime}</p>" .
        "<p><b>Pedido:</b><br>{$itemsHtml}</p>" .
        '<p><b>Total: $' . number_format($total, 0, ',', '.') . '</b></p>';
    $ch = curl_init('https://api.resend.com/emails');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Authorization: Bearer ' . $resendKey, 'Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'from' => 'Pedidos <onboarding@resend.dev>',
        'to' => [$ownerEmail],
        'subject' => "Nuevo pedido #{$orderId} - {$nombre}",
        'html' => $html,
    ]));
    curl_setopt($ch, CURLOPT_TIMEOUT, 8);
    curl_exec($ch);
    curl_close($ch);
}

echo json_encode(['success' => true, 'orderId' => $orderId, 'total' => $total]);

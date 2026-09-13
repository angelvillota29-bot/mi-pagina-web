<?php
// Recibe un pedido armado en la propia página (carrito + checkout), valida
// disponibilidad/stock de CADA platillo (principal y acompañamientos) contra
// el horario del día, descuenta el stock, guarda el pedido en ordersData, y
// si hay notifyConfig configurado, avisa al dueño por correo (Resend).
// No requiere API Key: lo llama el navegador del cliente, igual que save-data.php.
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

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

$day = $input['day'] ?? null;
$mealTime = $input['mealTime'] ?? null;
$cliente = $input['cliente'] ?? [];
$items = $input['items'] ?? [];

$nombre = trim($cliente['nombre'] ?? '');
$direccion = trim($cliente['direccion'] ?? '');
$telefono = trim($cliente['telefono'] ?? '');
$nota = trim($cliente['nota'] ?? '');

if (!$day || $nombre === '' || $direccion === '' || $telefono === '' || empty($items)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Faltan datos del pedido (nombre, dirección, teléfono o platillos)']);
    exit;
}

$data = json_decode(file_get_contents($file), true);
$dishes = $data['dishes'] ?? [];
$schedule = $data['schedule'] ?? [];

$dishesById = [];
foreach ($dishes as $d) { $dishesById[$d['id']] = $d; }

// Una sola fila de horario por (día, platillo) -- así se encuentra rápido.
$scheduleIdxByDishId = [];
foreach ($schedule as $i => $s) {
    if ($s['day'] === $day) $scheduleIdxByDishId[$s['dishId']] = $i;
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
        echo json_encode(['success' => false, 'error' => '"' . $dish['name'] . '" ya no está disponible ese día']);
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
    $precioUnitario = (int)preg_replace('/\D/', '', (string)$dish['price']);
    $total += $precioUnitario * $cantidad;
    $resueltos[] = [
        'dishId' => $dishId,
        'scheduleIdx' => $schedIdx,
        'name' => $dish['name'],
        'cantidad' => $cantidad,
        'precioUnitario' => $precioUnitario,
        'tipo' => $item['tipo'] ?? 'principal',
    ];
}

// Todo válido -- descuenta stock (solo donde el stock se controla; null = ilimitado).
foreach ($resueltos as $r) {
    if ($schedule[$r['scheduleIdx']]['stock'] !== null) {
        $schedule[$r['scheduleIdx']]['stock'] -= $r['cantidad'];
    }
}
$data['schedule'] = $schedule;

if (!isset($data['ordersData']) || !is_array($data['ordersData'])) $data['ordersData'] = [];
$orderId = (int) round(microtime(true) * 1000);
$order = [
    'id' => $orderId,
    'createdAt' => $orderId,
    'day' => $day,
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
$notify = $data['notifyConfig'] ?? [];
$resendKey = $notify['resendApiKey'] ?? '';
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
        "<p><b>Día/comida:</b> {$day} / {$mealTime}</p>" .
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

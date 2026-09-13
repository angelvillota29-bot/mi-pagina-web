<?php
header('Content-Type: application/json');
$headers = getallheaders();
$authHeader = $headers['Authorization'] ?? '';
$apiKey = str_replace('Bearer ', '', $authHeader);

$file = dirname(__DIR__) . '/data/data.json';
if (!file_exists($file)) { echo json_encode(['success' => false, 'error' => 'No hay datos']); exit; }

$data = json_decode(file_get_contents($file), true);
if (!isset($data['n8nConfig']['apiKey']) || $apiKey !== $data['n8nConfig']['apiKey']) {
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'API Key inválida']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);
// "id" = el id del horario (schedule), NO el id del platillo. Un mismo platillo
// aparece varios dias con SU PROPIO stock (ver schedule[].id en script.js), asi
// que hay que tocar la fila de schedule, igual que hace el panel (window.updateStock).
$scheduleId = $input['id'] ?? null;
$newStock = $input['stock'] ?? null;

if ($scheduleId === null || $newStock === null) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Faltan datos']);
    exit;
}

$found = false;
foreach ($data['schedule'] as &$s) {
    if ($s['id'] == $scheduleId) {
        $s['stock'] = (int)$newStock;
        $found = true;
        break;
    }
}
if ($found) {
    file_put_contents($file, json_encode($data));
    echo json_encode(['success' => true]);
} else {
    http_response_code(404);
    echo json_encode(['success' => false, 'error' => 'Horario no encontrado']);
}
?>
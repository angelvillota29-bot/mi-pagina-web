<?php
header('Content-Type: application/json');
$input = json_decode(file_get_contents('php://input'), true);
$dataDir = dirname(__DIR__) . '/data';
$file = $dataDir . '/data.json';

// Si la carpeta de datos no existe (primer arranque), la creamos
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0775, true);
}

if (!is_dir($dataDir)) {
    echo json_encode(['success' => false, 'error' => "No existe ni se pudo crear la carpeta $dataDir"]);
    exit;
}
if (!is_writable($dataDir)) {
    echo json_encode(['success' => false, 'error' => "Sin permiso de escritura en $dataDir (dueño actual: " . (function_exists('posix_getpwuid') ? posix_getpwuid(fileowner($dataDir))['name'] : fileowner($dataDir)) . ", proceso PHP corre como: " . (function_exists('posix_getpwuid') ? posix_getpwuid(posix_geteuid())['name'] : posix_geteuid()) . ")"]);
    exit;
}

// Forzamos a que las configuraciones (aunque estén vacías) se guarden
// como objeto JSON {} y no como arreglo [], para que nunca se repita
// el problema de "brandingConfig se convierte en un arreglo vacío".
if (isset($input['brandingConfig'])) $input['brandingConfig'] = (object) $input['brandingConfig'];
if (isset($input['takeoutConfig'])) $input['takeoutConfig'] = (object) $input['takeoutConfig'];
if (isset($input['n8nConfig'])) $input['n8nConfig'] = (object) $input['n8nConfig'];

if (file_put_contents($file, json_encode($input)) !== false) {
    echo json_encode(['success' => true]);
} else {
    $err = error_get_last();
    echo json_encode(['success' => false, 'error' => 'No se pudo escribir el archivo: ' . ($err['message'] ?? 'error desconocido')]);
}
?>